// Model cache: loads every pack model once, applies the toon/ink look to the template, prepares animation clips
// (root drift stripped so clips play in place), and hands out per-instance clones.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Pack } from '../rules/types';
import { stylize, type OutlineWidth } from './style';

const ROOT_BONE = 'Hips';
const ESSENTIAL = new Set(['idle', 'walk', 'sleep']);
const UNRIGGED_HEIGHT = 0.8;

async function pool<T>(items: T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { for (let x = q.shift(); x !== undefined; x = q.shift()) await f(x); }));
}

export interface Clip { clip: THREE.AnimationClip; speed: number /* m/s of root travel at timeScale 1, 0 = in place */ }
export interface ModelTemplate {
  key: string;
  scene: THREE.Object3D;          // stylized template (never added to the scene)
  character: boolean;             // feet lifted to y=0
  rigged: boolean;
  clips: Map<string, Clip>;       // lower-case clip name → clip
  height: number;                 // metres, after pack scale
  radius: number;                 // half of the larger horizontal extent
  lift: number;                   // y offset applied so feet rest on y=0
  scale: number;                  // pack scale
  rot: number;                    // radians (pack rot)
}

/** Pack rot: degrees when |rot| > 2π, radians otherwise. */
export const packRot = (r: number | undefined): number => (!r ? 0 : Math.abs(r) > Math.PI * 2 + 0.01 ? (r * Math.PI) / 180 : r);

function findBone(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let b: THREE.Object3D | null = null;
  root.traverse((o) => { if (!b && (o as THREE.Bone).isBone && o.name === name) b = o; });
  return b;
}

/** Strip horizontal drift of the root bone so the clip loops on the spot; returns the travel speed it had. */
function prepareClip(raw: THREE.AnimationClip, name: string, probe: THREE.Object3D): Clip {
  const clip = raw.clone(); clip.name = name;
  // drop tracks that would move the armature/mesh nodes themselves (scale/translation of non-bones)
  let speed = 0;
  const tr = clip.tracks.find((t) => t.name === `${ROOT_BONE}.position`);
  const hips = findBone(probe, ROOT_BONE);
  if (tr && hips?.parent && tr.times.length > 1) {
    probe.updateMatrixWorld(true);
    const M = new THREE.Matrix4().copy(probe.matrixWorld).invert().multiply(hips.parent.matrixWorld);
    const Mi = M.clone().invert();
    const v = tr.values, n = tr.times.length, p = new THREE.Vector3(), q = new THREE.Vector3();
    p.fromArray(v, 0).applyMatrix4(M); q.fromArray(v, (n - 1) * 3).applyMatrix4(M);
    const D = q.sub(p).setY(0);
    const t0 = tr.times[0]!, t1 = tr.times[n - 1]!;
    if (D.length() > 0.02 && t1 > t0) {
      speed = D.length() / (t1 - t0);
      const nv = new Float32Array(v.length);
      for (let i = 0; i < n; i++) {
        p.fromArray(v, i * 3).applyMatrix4(M).addScaledVector(D, -(tr.times[i]! - t0) / (t1 - t0)).applyMatrix4(Mi);
        p.toArray(nv, i * 3);
      }
      clip.tracks[clip.tracks.indexOf(tr)] = new THREE.VectorKeyframeTrack(tr.name, tr.times as unknown as number[], nv as unknown as number[], tr.getInterpolation());
    }
  }
  return { clip, speed };
}

function freeGltf(g: GLTF): void {
  g.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      for (const val of Object.values(mat)) {
        const t = val as THREE.Texture;
        if (t && t.isTexture) { const img = t.image as { close?: () => void } | undefined; img?.close?.(); t.dispose(); }
      }
      mat.dispose();
    }
  });
}

export class Assets {
  readonly models = new Map<string, ModelTemplate>();
  private loader = new GLTFLoader();
  private pending = new Map<string, Promise<GLTF | null>>();
  private textures = new Set<THREE.Texture>();
  private disposed = false;

  constructor() { this.loader.setMeshoptDecoder(MeshoptDecoder); }

  private fetch(url: string): Promise<GLTF | null> {
    let p = this.pending.get(url);
    if (!p) {
      p = this.loader.loadAsync(url).catch((e) => { console.warn('[scene] failed to load', url, e); return null; });
      this.pending.set(url, p);
    }
    return p;
  }

  /** Resolves once every model plus the essential clips (idle / walk / sleep) are in; the remaining clips keep
   *  streaming in the background and become playable as they arrive. */
  async load(pack: Pack, baseUrl: string, onProgress?: (p: number) => void): Promise<void> {
    const join = (u: string) => (/^(https?:|data:|blob:|\/)/.test(u) ? u : baseUrl.replace(/\/?$/, '/') + u.replace(/^\.\//, ''));
    const charKeys = new Set<string>();
    for (const r of pack.roles) charKeys.add(r.model || 'char:' + r.id);
    for (const f of pack.foes) charKeys.add(f.model || 'char:' + f.id);
    for (const k of Object.keys(pack.models)) if (k.startsWith('char:')) charKeys.add(k);

    const jobs: { key: string; url: string; anim?: Record<string, string> }[] = [];
    for (const [key, m] of Object.entries(pack.models)) if (!this.models.has(key)) jobs.push({ key, url: join(m.url), anim: m.anim });
    const essential = new Set<string>(), deferred: { key: string; name: string; url: string }[] = [];
    for (const j of jobs) {
      essential.add(j.url);
      for (const [name, u] of Object.entries(j.anim ?? {})) {
        if (u === '@model') continue;
        if (ESSENTIAL.has(name.toLowerCase())) essential.add(join(u)); else deferred.push({ key: j.key, name, url: join(u) });
      }
    }
    const total = Math.max(1, essential.size); let done = 0;
    onProgress?.(0);
    const results = new Map<string, GLTF | null>();
    await pool([...essential], 6, async (u) => { results.set(u, await this.fetch(u)); onProgress?.(Math.min(0.99, ++done / total)); });
    if (this.disposed) return;

    const modelUrls = new Set(jobs.map((j) => j.url));
    for (const j of jobs) {
      const g = results.get(j.url);
      if (!g) continue;
      const m = pack.models[j.key]!;
      const t = this.makeTemplate(j.key, g, m.scale, packRot(m.rot), charKeys.has(j.key));
      for (const [name, u] of Object.entries(j.anim ?? {})) {
        if (u === '@model') this.addClip(t, name, g.animations.filter((a) => a.name !== 'idle_look'), true);
        else if (ESSENTIAL.has(name.toLowerCase())) this.addClip(t, name, results.get(join(u))?.animations ?? [], false);
      }
      const embedded = g.animations.filter((a) => a.name !== 'idle_look');
      if (!t.clips.has('idle') && embedded[0] && t.rigged) this.addClip(t, 'idle', [embedded.find((a) => /idle/i.test(a.name)) ?? embedded[0]], false);
      if (!t.clips.size) t.rigged = false;
      this.models.set(j.key, t);
    }
    // animation-only GLBs carry a full mesh + texture we never draw: free them
    for (const u of essential) { const g = results.get(u); if (g && !modelUrls.has(u)) freeGltf(g); }
    onProgress?.(1);

    // the rest in the background
    const byUrl = new Map<string, { key: string; name: string }[]>();
    for (const d of deferred) { const l = byUrl.get(d.url) ?? []; l.push(d); byUrl.set(d.url, l); }
    void pool([...byUrl.keys()], 3, async (u) => {
      const g = await this.fetch(u);
      if (!g || this.disposed) return;
      for (const d of byUrl.get(u)!) { const t = this.models.get(d.key); if (t) this.addClip(t, d.name, g.animations, false); }
      if (!modelUrls.has(u)) freeGltf(g);
    });
  }

  private addClip(t: ModelTemplate, name: string, anims: THREE.AnimationClip[], byName: boolean): void {
    const n = name.toLowerCase();
    const raw = anims.find((a) => a.name.toLowerCase() === n) ?? (byName && n !== 'idle' ? undefined : anims[0]);
    if (raw) t.clips.set(n, prepareClip(raw, n, t.scene));
  }

  private makeTemplate(key: string, g: GLTF, packScale: number | undefined, rot: number, character: boolean): ModelTemplate {
    const scene = SkeletonUtils.clone(g.scene); // keep g.scene pristine for other keys sharing the url
    let rigged = false;
    scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) rigged = true; });
    scene.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(scene, true);
    const size = bb.getSize(new THREE.Vector3());
    // rigged characters come in real metres; unrigged character meshes are unit-normalised, so without a pack
    // scale they get a default mini height
    let scale = packScale ?? 1;
    if (packScale === undefined && character && !rigged && size.y > 0) {
      scale = UNRIGGED_HEIGHT / size.y;
      console.warn(`[scene] ${key}: unrigged model without pack scale, fitted to ${UNRIGGED_HEIGHT} m (scale ${scale.toFixed(3)})`);
    }
    stylize(scene, (size.y * scale > 3 ? 'med' : 'thin') as OutlineWidth, true);
    for (const o of collectTextures(scene)) this.textures.add(o);
    return {
      key, scene, character, rigged, clips: new Map(), scale, rot, lift: character ? -bb.min.y : 0,
      height: Math.max(0.1, size.y * scale), radius: Math.max(0.2, Math.max(size.x, size.z) * 0.5 * scale),
    };
  }

  has(key: string | undefined): key is string { return !!key && this.models.has(key); }

  /** First key from the list that is loaded. */
  pick(...keys: (string | undefined)[]): string | undefined { return keys.find((k) => this.has(k)); }

  /** Per-instance clone. Characters come back wrapped so feet are on y=0 and facing/scale corrections applied. */
  instance(key: string): THREE.Object3D | null {
    const t = this.models.get(key);
    if (!t) return null;
    const inner = t.rigged || t.character ? SkeletonUtils.clone(t.scene) : t.scene.clone(true);
    const wrap = new THREE.Group(); wrap.name = key;
    inner.position.y = t.lift;
    wrap.add(inner);
    wrap.scale.setScalar(t.scale);
    wrap.rotation.y = t.rot;
    return wrap;
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.models.values()) {
      t.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
        for (const mat of mats) mat.dispose();
      });
    }
    for (const tex of this.textures) tex.dispose();
    this.models.clear(); this.pending.clear(); this.textures.clear();
  }
}

function collectTextures(root: THREE.Object3D): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) out.push(v as THREE.Texture);
  });
  return out;
}
