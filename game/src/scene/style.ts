// The approved look: toon shading (3-step gradient), inverted-hull ink outline, screen-space cross-hatching in
// shadowed areas, and a paper-grain overlay. The look comes from shading, not textures.
import * as THREE from 'three';

export const INK = 0x2a2328;
export const PALETTE = {
  rose: 0xd8a7a7, sage: 0xa9bfa0, cream: 0xf2eadb, lavender: 0xb4abc6, ink: INK,
  table: 0xe9e1d3, roseInk: 0x8a4a4e, danger: 0xc8696a, gold: 0xe8c77a,
};

// ---------------------------------------------------------------- toon + hatch
export const gradient = new THREE.DataTexture(
  new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]), 3, 1);
gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
gradient.needsUpdate = true;

/** Shared uniforms: uHatch toggles hatching, uPx = device pixel ratio (keeps the hatch spacing in CSS px). */
export const hatchUniforms = { uHatch: { value: 1 }, uPx: { value: 1 } };

/** Every toon material created here, so a quality change (shadows on/off) can recompile them. */
export const toonMaterials = new Set<THREE.Material>();

const HATCH_GLSL = `#include <dithering_fragment>
  float lum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
  vec2 hp = gl_FragCoord.xy / uPx;
  float h1 = step(0.82, fract((hp.x + hp.y) * 0.16));
  float h2 = step(0.82, fract((hp.x - hp.y) * 0.16));
  float shade = smoothstep(0.62, 0.32, lum);
  float dark = smoothstep(0.40, 0.18, lum);
  float hatch = max(h1 * shade, h2 * dark) * uHatch;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.165, 0.137, 0.157), hatch * 0.55);`;

function addHatch(m: THREE.Material): void {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHatch = hatchUniforms.uHatch;
    sh.uniforms.uPx = hatchUniforms.uPx;
    sh.fragmentShader = 'uniform float uHatch;\nuniform float uPx;\n' +
      sh.fragmentShader.replace('#include <dithering_fragment>', HATCH_GLSL);
  };
  m.customProgramCacheKey = () => 'sb-hatch';
}

type SrcMat = Partial<Pick<THREE.MeshStandardMaterial, 'color' | 'map' | 'emissive' | 'emissiveMap' | 'transparent' | 'alphaTest' | 'side' | 'opacity' | 'vertexColors'>>;

/** New toon material with hatching. */
export function toonMaterial(src: SrcMat = {}): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
    map: src.map ?? null, gradientMap: gradient,
    emissive: src.emissive ? src.emissive.clone() : new THREE.Color(0), emissiveMap: src.emissiveMap ?? null,
    transparent: !!src.transparent, opacity: src.opacity ?? 1, alphaTest: src.alphaTest ?? 0,
    side: src.side ?? THREE.FrontSide, vertexColors: !!src.vertexColors,
  });
  addHatch(m);
  toonMaterials.add(m);
  return m;
}

const toonCache = new WeakMap<THREE.Material, THREE.MeshToonMaterial>();
/** Toon version of a loaded material, shared between all users of the same source material. */
export function toonify(src: THREE.Material): THREE.MeshToonMaterial {
  let m = toonCache.get(src);
  if (!m) { m = toonMaterial(src as unknown as SrcMat); m.name = src.name; toonCache.set(src, m); }
  return m;
}

// ---------------------------------------------------------------- ink outline (inverted hull)
export function outlineMaterial(w: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>\n transformed += normalize(normal) * ${w.toFixed(4)};`);
  };
  m.customProgramCacheKey = () => 'sb-outline-' + w;
  return m;
}
export const OUTLINE = { thin: outlineMaterial(0.012), med: outlineMaterial(0.02), thick: outlineMaterial(0.03) };
export type OutlineWidth = keyof typeof OUTLINE;

const noRaycast = () => {};

/** Convert every mesh under root to toon + hatch and give it an ink hull. Call once on a template, then clone. */
export function stylize(root: THREE.Object3D, width: OutlineWidth = 'thin', shadows = true): void {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.sbOutline) meshes.push(o as THREE.Mesh); });
  for (const o of meshes) {
    o.castShadow = shadows; o.receiveShadow = true;
    o.material = Array.isArray(o.material) ? o.material.map(toonify) : toonify(o.material);
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const sk = o as THREE.SkinnedMesh;
    const line = sk.isSkinnedMesh ? new THREE.SkinnedMesh(o.geometry, OUTLINE[width]) : new THREE.Mesh(o.geometry, OUTLINE[width]);
    if (sk.isSkinnedMesh) (line as unknown as THREE.SkinnedMesh).bind(sk.skeleton, sk.bindMatrix);
    line.castShadow = false; line.receiveShadow = false; line.raycast = noRaycast;
    line.userData.sbOutline = true; line.name = o.name + '_ink';
    o.add(line);
  }
}

/** Hull for a procedural mesh (shares the geometry). */
export function addOutline(mesh: THREE.Mesh, width: OutlineWidth = 'thin'): THREE.Mesh {
  const line = new THREE.Mesh(mesh.geometry, OUTLINE[width]);
  line.raycast = noRaycast; line.userData.sbOutline = true;
  mesh.add(line);
  return line;
}

// ---------------------------------------------------------------- paper grain overlay (full-screen multiply pass)
function grainTexture(size = 256): THREE.Texture {
  // tileable fractal value noise, warm brown, baked once
  const data = new Uint8Array(size * size * 4);
  const lattice = (n: number, seed: number) => {
    const g = new Float32Array(n * n);
    let s = seed >>> 0;
    for (let i = 0; i < g.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; g[i] = s / 4294967296; }
    return g;
  };
  const octaves = [[8, 0.35], [32, 0.3], [64, 0.2], [128, 0.15]] as const;
  const grids = octaves.map(([n], i) => lattice(n, 1234 + i * 77));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    octaves.forEach(([n, amp], i) => {
      const g = grids[i]!, fx = (x / size) * n, fy = (y / size) * n;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (a: number, b: number) => g[((b % n) * n) + (a % n)]!;
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      v += (a + (b - a) * sy) * amp;
    });
    const k = (y * size + x) * 4, t = Math.max(0, Math.min(1, v));
    // white = no change in multiply; darker warm speckle
    data[k] = 255 - (1 - t) * 60; data[k + 1] = 255 - (1 - t) * 72; data[k + 2] = 255 - (1 - t) * 88; data[k + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class PaperOverlay {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private tex: THREE.Texture;
  private geo = new THREE.PlaneGeometry(2, 2);
  constructor(strength = 0.55) {
    this.tex = grainTexture();
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: this.tex }, uRes: { value: new THREE.Vector2(1, 1) }, uPx: hatchUniforms.uPx, uK: { value: strength } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D uTex; uniform vec2 uRes; uniform float uPx; uniform float uK; varying vec2 vUv;
        void main(){
          vec3 g = texture2D(uTex, gl_FragCoord.xy / (uPx * 260.0)).rgb;
          vec2 c = vUv - 0.5; c.x *= uRes.x / uRes.y;
          float vig = 1.0 - smoothstep(0.35, 1.05, length(c)) * 0.28;
          vec3 col = mix(vec3(1.0), g, uK) * mix(vec3(1.0), vec3(0.93, 0.89, 0.84), 1.0 - vig) * mix(1.0, vig, 0.5);
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    });
    const q = new THREE.Mesh(this.geo, this.mat); q.frustumCulled = false;
    this.scene.add(q);
  }
  setSize(w: number, h: number): void { (this.mat.uniforms.uRes!.value as THREE.Vector2).set(w, h); }
  render(r: THREE.WebGLRenderer): void {
    const ac = r.autoClear; r.autoClear = false; r.render(this.scene, this.camera); r.autoClear = ac;
  }
  dispose(): void { this.mat.dispose(); this.tex.dispose(); this.geo.dispose(); }
}

// ---------------------------------------------------------------- misc helpers
export function disposeObject(root: THREE.Object3D, keep?: Set<unknown>): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !keep?.has(m.geometry)) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      if (keep?.has(mat)) continue;
      for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture && !keep?.has(v)) (v as THREE.Texture).dispose();
      mat.dispose();
    }
  });
}
