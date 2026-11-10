// Crisp DOM layer over the canvas: heart pips over minis, comic speech bubbles anchored to minis,
// paper notes at the top for narrator lines and event cards, and the charging ring under a held finger.
// Everything is positioned in client (viewport) pixels; pointer-events are off so the canvas gets every touch.

const CSS = `
.sb-ov{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:1;font-family:Kalam,"Comic Sans MS","Chalkboard SE","Marker Felt",cursive;color:#2a2328;-webkit-user-select:none;user-select:none;contain:strict}
.sb-ov *{box-sizing:border-box}
.sb-a{position:absolute;left:0;top:0;will-change:transform}
.sb-chip{display:flex;gap:1px;align-items:center;padding:2px 4px 1px;border-radius:9px 7px 10px 8px;background:rgba(247,243,236,.86);border:1.5px solid #2a2328;box-shadow:0 1px 0 rgba(42,35,40,.25);transform-origin:50% 100%;transition:opacity .25s}
.sb-chip.sel{background:#fff8e6;border-color:#8a4a4e}
.sb-chip svg{display:block}
.sb-chip .z{font-size:12px;line-height:12px;font-weight:700;color:#6b6077;padding:0 2px}
.sb-chip.foe{background:rgba(58,49,64,.86);border-color:#2a2328;padding:2px 4px 1px}
.sb-chip .n{font-size:12px;line-height:12px;font-weight:700;color:#f2eadb;padding:0 2px}
.sb-chip.dim{opacity:.35}
.sb-pip{width:8px;height:8px;border-radius:50%;border:1.5px solid #2a2328;background:#f7f3ec;margin:0 1px}
.sb-pip.on{background:#d8a7a7;box-shadow:inset -1px -1px 0 rgba(138,74,78,.7)}
.sb-bub{max-width:min(230px,62vw);padding:7px 12px 8px;background:#fbf8f2;border:2.5px solid #2a2328;border-radius:16px 13px 17px 12px;font-size:15.5px;line-height:1.22;
  box-shadow:2px 3px 0 rgba(42,35,40,.18);text-align:center;transform-origin:var(--tx,50%) 100%;animation:sb-pop .32s cubic-bezier(.2,1.6,.4,1) both;position:relative}
.sb-bub::after{content:"";position:absolute;bottom:-11px;left:calc(var(--tx,50%) - 8px);width:14px;height:14px;background:inherit;border-right:2.5px solid #2a2328;border-bottom:2.5px solid #2a2328;
  transform:skewX(18deg) rotate(45deg) scaleY(.8);border-radius:0 0 4px 0}
.sb-bub.hint{background:#ebe6f2;border-style:dashed;font-size:14.5px}
.sb-bub.result{background:#fff4d6;font-weight:700}
.sb-bub b{font-weight:700}
.sb-out{animation:sb-fade .4s ease-in forwards!important}
.sb-notes{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 14px}
.sb-note{max-width:min(440px,94vw);padding:9px 16px 10px;background:#f6efe1;border:2px solid #2a2328;border-radius:3px 5px 4px 6px;font-size:16.5px;line-height:1.28;text-align:center;
  box-shadow:3px 4px 0 rgba(42,35,40,.16);transform:rotate(var(--r,-.6deg));animation:sb-drop .45s cubic-bezier(.2,1.4,.4,1) both;position:relative;
  background-image:radial-gradient(rgba(138,110,90,.08) 1px,transparent 1.2px);background-size:7px 7px}
.sb-note::before{content:"";position:absolute;top:-7px;left:50%;width:46px;height:14px;margin-left:-23px;background:rgba(216,167,167,.65);transform:rotate(-2deg);border-radius:2px}
.sb-note.event{background-color:#fbf3dc;border-width:2.5px}
.sb-note .t{display:block;font-family:Cinzel,"Trajan Pro",Georgia,serif;font-weight:700;font-size:14px;letter-spacing:.06em;color:#8a4a4e;margin-bottom:2px;text-transform:uppercase}
.sb-hold{width:64px;height:64px;margin:-32px 0 0 -32px;opacity:0;transition:opacity .12s}
.sb-hold.on{opacity:1}
.sb-hold circle.p{stroke-dasharray:170;stroke-dashoffset:170}
.sb-hold.on circle.p{animation:sb-charge var(--d,330ms) linear forwards}
.sb-hold.fire{animation:sb-burst .3s ease-out forwards}
@keyframes sb-pop{0%{opacity:0;transform:scale(.4) translateY(8px)}100%{opacity:1;transform:none}}
@keyframes sb-drop{0%{opacity:0;transform:translateY(-24px) rotate(-4deg)}100%{opacity:1;transform:rotate(var(--r,-.6deg))}}
@keyframes sb-fade{to{opacity:0;transform:translateY(-6px) scale(.96)}}
@keyframes sb-charge{to{stroke-dashoffset:0}}
@keyframes sb-burst{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.5)}}
`;

const HEART = (on: boolean) => `<svg width="13" height="12" viewBox="0 0 26 24"><path d="M13 22C5 16 1.5 12 1.8 7.4 2.1 3.8 5 1.6 8 1.8c2.2.1 3.9 1.4 5 3.2 1.1-1.8 2.8-3.1 5-3.2 3-.2 5.9 2 6.2 5.6.3 4.6-3.2 8.6-11.2 14.6z"
  fill="${on ? '#d8a7a7' : '#f7f3ec'}" stroke="#2a2328" stroke-width="2.6" stroke-linejoin="round"/>${on ? '<path d="M6.5 6.5c.8-1.2 2-1.6 3-1.4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" opacity=".7"/>' : ''}</svg>`;

export interface ChipSpec { kind: 'hero' | 'foe'; filled: number; max: number; tuckered?: boolean; selected?: boolean; dim?: boolean }

interface Placed { el: HTMLElement; x: number; y: number; vis: boolean; w: number; h: number }
interface Bub extends Placed { id: string; who?: string; until: number; out: boolean; tx: string }
interface Note { el: HTMLElement; until: number; out: boolean; key: string }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Overlay {
  readonly root = document.createElement('div');
  private chips = new Map<string, Placed & { sig: string }>();
  private bubs = new Map<string, Bub>();
  private notes: Note[] = [];
  private notesEl = document.createElement('div');
  private hold: HTMLElement;
  private style: HTMLStyleElement;
  private top = 0;
  private notesBottom = 0; private notesDirty = false;
  W = 1; H = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.style = document.createElement('style'); this.style.textContent = CSS; document.head.appendChild(this.style);
    this.root.className = 'sb-ov';
    this.notesEl.className = 'sb-notes';
    this.root.appendChild(this.notesEl);
    this.hold = document.createElement('div'); this.hold.className = 'sb-a sb-hold';
    this.hold.innerHTML = '<svg width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="27" fill="rgba(247,243,236,.35)" stroke="rgba(42,35,40,.35)" stroke-width="3"/><circle class="p" cx="32" cy="32" r="27" fill="none" stroke="#8a4a4e" stroke-width="5" stroke-linecap="round" transform="rotate(-90 32 32)"/></svg>';
    this.root.appendChild(this.hold);
    canvas.insertAdjacentElement('afterend', this.root);
    this.setTop(0);
  }

  setTop(px: number): void { this.top = px; this.notesEl.style.top = `${Math.max(10, px + 10)}px`; }

  // ---------------------------------------------------------------- chips (hearts / pips)
  chip(key: string, spec: ChipSpec): void {
    const sig = JSON.stringify(spec);
    let c = this.chips.get(key);
    if (!c) {
      const el = document.createElement('div'); el.className = 'sb-a';
      const inner = document.createElement('div'); el.appendChild(inner);
      this.root.insertBefore(el, this.notesEl);
      c = { el, x: -1e4, y: -1e4, vis: true, w: 0, h: 0, sig: '' };
      this.chips.set(key, c);
    }
    if (c.sig === sig) return;
    c.sig = sig;
    const inner = c.el.firstElementChild as HTMLElement;
    inner.className = `sb-chip ${spec.kind === 'foe' ? 'foe' : ''} ${spec.selected ? 'sel' : ''} ${spec.dim ? 'dim' : ''}`;
    let h = '';
    if (spec.kind === 'hero') {
      for (let i = 0; i < spec.max; i++) h += HEART(i < spec.filled);
      if (spec.tuckered) h += '<span class="z">z<small>z</small></span>';
    } else if (spec.max <= 6) for (let i = 0; i < spec.max; i++) h += HEART(i < spec.filled);
    else h += HEART(true) + `<b class="n">${spec.filled}</b>`;
    inner.innerHTML = h;
    c.w = 0;
  }
  dropChip(key: string): void { const c = this.chips.get(key); if (c) { c.el.remove(); this.chips.delete(key); } }
  chipKeys(): string[] { return [...this.chips.keys()]; }
  placeChip(key: string, x: number, y: number, vis: boolean): void {
    const c = this.chips.get(key); if (!c) return;
    this.place(c, x, y, vis, 'translate(-50%,-100%)');
  }

  private place(p: Placed, x: number, y: number, vis: boolean, extra: string): void {
    if (vis !== p.vis) { p.el.style.display = vis ? '' : 'none'; p.vis = vis; }
    if (!vis) return;
    if (Math.abs(x - p.x) < 0.3 && Math.abs(y - p.y) < 0.3) return;
    p.x = x; p.y = y;
    p.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) ${extra}`;
  }

  // ---------------------------------------------------------------- bubbles over minis
  bubble(id: string, who: string | undefined, text: string, kind: string, ms: number, now: number): void {
    if (this.bubs.has(id)) return;
    // one bubble per speaker: the older one fades
    if (who) for (const b of this.bubs.values()) if (b.who === who && !b.out) b.until = Math.min(b.until, now);
    const el = document.createElement('div'); el.className = 'sb-a';
    el.innerHTML = `<div class="sb-bub ${kind === 'hint' ? 'hint' : kind === 'result' ? 'result' : ''}">${esc(text)}</div>`;
    this.root.insertBefore(el, this.notesEl);
    this.bubs.set(id, { id, who, el, x: -1e4, y: -1e4, vis: true, w: 0, h: 0, until: now + ms, out: false, tx: '50%' });
  }
  hasBubble(id: string): boolean { return this.bubs.has(id); }
  bubbleIds(): string[] { return [...this.bubs.keys()]; }
  endBubble(id: string, now: number): void { const b = this.bubs.get(id); if (b) b.until = Math.min(b.until, now); }
  /** Anchor point (head of the speaker) in client px; returns the ids that need an anchor. */
  bubblesNeeding(): { id: string; who: string }[] { const out: { id: string; who: string }[] = []; for (const b of this.bubs.values()) if (b.who) out.push({ id: b.id, who: b.who }); return out; }
  placeBubble(id: string, x: number, y: number, vis: boolean): void {
    const b = this.bubs.get(id); if (!b) return;
    if (!b.w) { b.w = b.el.offsetWidth; b.h = b.el.offsetHeight; }
    const half = b.w / 2, m = 8;
    const cx = Math.min(Math.max(x, half + m), this.W - half - m);
    if (this.notesDirty) { this.notesDirty = false; this.notesBottom = this.notes.some((n) => !n.out) ? this.notesEl.getBoundingClientRect().bottom : 0; }
    const cy = Math.min(Math.max(y - 14, b.h + Math.max(this.top, this.notesBottom) + m), this.H - m);
    const tx = `${Math.round(Math.min(Math.max(x - (cx - half), 18), b.w - 18))}px`;
    if (tx !== b.tx) { b.tx = tx; (b.el.firstElementChild as HTMLElement).style.setProperty('--tx', tx); }
    this.place(b, cx, cy, vis, 'translate(-50%,-100%)');
  }

  // ---------------------------------------------------------------- notes (narrator, events)
  note(key: string, text: string, ms: number, now: number, title?: string, kind = 'story'): void {
    if (this.notes.some((n) => n.key === key)) return;
    const el = document.createElement('div');
    el.className = `sb-note ${kind === 'event' ? 'event' : ''}`;
    el.style.setProperty('--r', `${((key.length * 7) % 9 - 4) * 0.25}deg`);
    el.innerHTML = (title ? `<span class="t">${esc(title)}</span>` : '') + esc(text);
    this.notesEl.appendChild(el);
    this.notes.push({ el, until: now + ms, out: false, key });
    this.notesDirty = true;
    while (this.notes.filter((n) => !n.out).length > 2) { const n = this.notes.find((x) => !x.out)!; n.until = now; this.tick(now); }
  }
  endNote(key: string, now: number): void { for (const n of this.notes) if (n.key === key) n.until = Math.min(n.until, now); }
  noteKeys(): string[] { return this.notes.map((n) => n.key); }

  // ---------------------------------------------------------------- hold ring
  holdStart(x: number, y: number, ms: number): void {
    const h = this.hold;
    h.classList.remove('on', 'fire'); void h.offsetWidth;
    h.style.transform = `translate3d(${x}px,${y}px,0)`;
    h.style.setProperty('--d', `${ms}ms`);
    h.classList.add('on');
  }
  holdFire(): void { this.hold.classList.remove('on'); void this.hold.offsetWidth; this.hold.classList.add('fire'); }
  holdCancel(): void { this.hold.classList.remove('on', 'fire'); }

  /** Expire bubbles and notes; returns true while something is animating out. */
  tick(now: number): boolean {
    let busy = false;
    for (const b of [...this.bubs.values()]) {
      if (!b.out && now >= b.until) { b.out = true; b.el.firstElementChild?.classList.add('sb-out'); b.until = now + 420; }
      else if (b.out && now >= b.until) { b.el.remove(); this.bubs.delete(b.id); }
      if (b.out) busy = true;
    }
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i]!;
      if (!n.out && now >= n.until) { n.out = true; n.el.classList.add('sb-out'); n.until = now + 420; this.notesDirty = true; }
      else if (n.out && now >= n.until) { n.el.remove(); this.notes.splice(i, 1); this.notesDirty = true; }
      if (n.out) busy = true;
    }
    return busy;
  }

  clear(): void {
    for (const c of this.chips.values()) c.el.remove();
    for (const b of this.bubs.values()) b.el.remove();
    for (const n of this.notes) n.el.remove();
    this.chips.clear(); this.bubs.clear(); this.notes.length = 0;
  }
  dispose(): void { this.clear(); this.root.remove(); this.style.remove(); }
}
