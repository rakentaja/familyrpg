// Little floating things: rising text ("-1", "+1 Cheer") and puffs of snow / sparkle (3D sprites).
import * as THREE from 'three';

const FONT = '"Kalam", "Comic Sans MS", "Chalkboard SE", "Marker Felt", cursive';
export type TextStyle = 'good' | 'bad' | 'info' | 'gold';
const STYLE: Record<TextStyle, { fill: string; stroke: string }> = {
  good: { fill: '#5f7d55', stroke: '#f7f3ec' },
  bad: { fill: '#8a4a4e', stroke: '#f7f3ec' },
  info: { fill: '#2a2328', stroke: '#f7f3ec' },
  gold: { fill: '#9a7420', stroke: '#fff8e6' },
};

/** Writes the world position to follow into `out`; return false when the anchor is gone. */
export type Anchor = (out: THREE.Vector3) => boolean;

interface Item {
  obj: THREE.Sprite; mat: THREE.SpriteMaterial; tex: THREE.Texture | null;
  t: number; life: number; kind: 'float' | 'bubble' | 'puff';
  base: THREE.Vector3; vel: THREE.Vector3; anchor?: Anchor; size: number; aspect: number; offY: number;
}

function canvasTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}

function textCanvas(text: string, style: TextStyle): HTMLCanvasElement {
  const c = document.createElement('canvas'), g = c.getContext('2d')!;
  const px = 72; g.font = `700 ${px}px ${FONT}`;
  const w = Math.ceil(g.measureText(text).width) + 40;
  c.width = Math.min(1024, w); c.height = 110;
  g.font = `700 ${px}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const s = STYLE[style];
  g.lineJoin = 'round'; g.lineWidth = 14; g.strokeStyle = s.stroke; g.strokeText(text, c.width / 2, 58, c.width - 20);
  g.lineWidth = 3; g.strokeStyle = '#2a2328'; g.strokeText(text, c.width / 2, 58, c.width - 20);
  g.fillStyle = s.fill; g.fillText(text, c.width / 2, 58, c.width - 20);
  return c;
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/); const lines: string[] = []; let line = '';
  for (const w of words) {
    const tryLine = line ? line + ' ' + w : w;
    if (g.measureText(tryLine).width > max && line) { lines.push(line); line = w; } else line = tryLine;
  }
  if (line) lines.push(line);
  if (lines.length > 4) { lines.length = 4; lines[3] = lines[3]!.replace(/\s*\S*$/, '…'); }
  return lines;
}

function bubbleCanvas(text: string): HTMLCanvasElement {
  const c = document.createElement('canvas'), g = c.getContext('2d')!;
  const px = 44; g.font = `400 ${px}px ${FONT}`;
  const lines = wrap(g, text, 520);
  const tw = Math.max(...lines.map((l) => g.measureText(l).width));
  const W = Math.ceil(tw) + 64, H = lines.length * 54 + 56, tail = 30;
  c.width = W + 8; c.height = H + tail + 8;
  g.translate(4, 4);
  g.fillStyle = '#f7f3ec'; g.strokeStyle = '#2a2328'; g.lineWidth = 5; g.lineJoin = 'round';
  const r = 26;
  g.beginPath();
  g.moveTo(r, 0); g.lineTo(W - r, 0); g.quadraticCurveTo(W, 0, W, r); g.lineTo(W, H - r); g.quadraticCurveTo(W, H, W - r, H);
  g.lineTo(W / 2 + 18, H); g.lineTo(W / 2 - 4, H + tail); g.lineTo(W / 2 - 16, H);
  g.lineTo(r, H); g.quadraticCurveTo(0, H, 0, H - r); g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0); g.closePath();
  g.fill(); g.stroke();
  g.fillStyle = '#2a2328'; g.font = `400 ${px}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((l, i) => g.fillText(l, W / 2, 30 + 27 + i * 54));
  return c;
}

let dotTex: THREE.Texture | null = null;
function softDot(): THREE.Texture {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.strokeStyle = '#2a2328'; g.lineWidth = 4;
  g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.fill(); g.stroke();
  dotTex = canvasTexture(c);
  return dotTex;
}

const tmp = new THREE.Vector3();

export class FxLayer {
  readonly group = new THREE.Group();
  private items: Item[] = [];

  /** Rising, fading text at a world point or following an anchor. */
  text(text: string, at: THREE.Vector3 | Anchor, style: TextStyle = 'info', delay = 0): void {
    const c = textCanvas(text, style); const tex = canvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
    const obj = new THREE.Sprite(mat); obj.renderOrder = 20; obj.visible = false;
    const it: Item = { obj, mat, tex, t: -delay, life: 1.8, kind: 'float', base: new THREE.Vector3(), vel: new THREE.Vector3(),
      size: 0.026, aspect: c.width / c.height, offY: 0, anchor: typeof at === 'function' ? at : undefined };
    if (typeof at !== 'function') it.base.copy(at);
    this.add(it);
  }

  /** Speech bubble above an anchor (or at a point). */
  bubble(text: string, at: THREE.Vector3 | Anchor, seconds?: number): void {
    const c = bubbleCanvas(text); const tex = canvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false });
    const obj = new THREE.Sprite(mat); obj.renderOrder = 21; obj.visible = false;
    obj.center.set(0.5, 0);
    const lines = Math.round((c.height - 94) / 54);
    const it: Item = { obj, mat, tex, t: 0, life: seconds ?? Math.min(7, 2.4 + text.length * 0.05), kind: 'bubble',
      base: new THREE.Vector3(), vel: new THREE.Vector3(), size: 0.034 + lines * 0.019, aspect: c.width / c.height, offY: 0,
      anchor: typeof at === 'function' ? at : undefined };
    if (typeof at !== 'function') it.base.copy(at);
    this.add(it);
  }

  /** Burst of little round puffs (snow poof, sparkle). */
  puff(at: THREE.Vector3, color: number, n = 10, spread = 0.6): void {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({ map: softDot(), color, transparent: true, depthWrite: false });
      const obj = new THREE.Sprite(mat); obj.renderOrder = 15;
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const it: Item = { obj, mat, tex: null, t: 0, life: 0.7 + Math.random() * 0.4, kind: 'puff',
        base: at.clone().add(tmp.set(0, 0.2 + Math.random() * 0.4, 0)),
        vel: new THREE.Vector3(Math.cos(a) * spread * (0.7 + Math.random() * 0.6), 0.6 + Math.random() * 0.8, Math.sin(a) * spread * (0.7 + Math.random() * 0.6)),
        size: 0.12 + Math.random() * 0.1, aspect: 1, offY: 0 };
      this.add(it);
    }
  }

  private add(it: Item): void { this.items.push(it); this.group.add(it.obj); }

  get busy(): boolean { return this.items.length > 0; }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      it.t += dt;
      if (it.t < 0) continue;
      const u = it.t / it.life;
      if (u >= 1 || (it.anchor && !it.anchor(tmp))) { this.kill(i); continue; }
      it.obj.visible = true;
      if (it.kind === 'puff') {
        it.base.addScaledVector(it.vel, dt); it.vel.multiplyScalar(Math.exp(-dt * 3)); it.vel.y -= dt * 0.4;
        it.obj.position.copy(it.base);
        const s = it.size * (0.6 + u * 0.9); it.obj.scale.set(s, s, 1);
        it.mat.opacity = 1 - u * u;
        continue;
      }
      if (it.anchor) it.anchor(it.base);
      it.obj.position.copy(it.base);
      if (it.kind === 'float') {
        it.obj.position.y += 0.25 + u * 0.7;
        const pop = Math.min(1, it.t / 0.18);
        const s = it.size * (0.6 + 0.4 * pop + (pop < 1 ? 0 : 0));
        it.obj.scale.set(s * it.aspect, s, 1);
        it.mat.opacity = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
      } else {
        it.obj.position.y += 0.15;
        const pop = Math.min(1, it.t / 0.2), k = 0.8 + 0.2 * pop;
        it.obj.scale.set(it.size * it.aspect * k, it.size * k, 1);
        it.mat.opacity = u > 0.9 ? 1 - (u - 0.9) / 0.1 : 1;
      }
    }
  }

  private kill(i: number): void {
    const it = this.items[i]!;
    this.group.remove(it.obj); it.mat.dispose(); it.tex?.dispose();
    this.items.splice(i, 1);
  }

  clear(): void { for (let i = this.items.length - 1; i >= 0; i--) this.kill(i); }
  dispose(): void { this.clear(); dotTex?.dispose(); dotTex = null; }
}
