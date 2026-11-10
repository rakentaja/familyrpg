// Tiny DOM helpers. No framework: screens build elements with h() and patch what changes.
type Child = Node | string | number | false | null | undefined | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

export function append(el: Node, kids: Child[]) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
  }
}

export function svg(markup: string, cls = 'ic'): HTMLElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = markup;
  s.setAttribute('aria-hidden', 'true');
  return s;
}

export function clear(el: Element) { while (el.firstChild) el.removeChild(el.firstChild); }

export function replaceKids(el: Element, ...kids: Child[]) { clear(el); append(el, kids); }

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** A big button. Every tappable thing in the app goes through this so touch targets stay ≥ 48 px. */
export function btn(label: Child, onClick: (e: MouseEvent) => void, cls = '', extra: Props = {}): HTMLButtonElement {
  return h('button', { type: 'button', class: 'btn ' + cls, onclick: onClick, ...extra }, label);
}

/** Simple swipe detector (pointer events). Calls back with the dominant direction. */
export function onSwipe(el: HTMLElement, cb: (dir: 'left' | 'right' | 'up' | 'down') => void, min = 40) {
  let x0 = 0, y0 = 0, id = -1, t0 = 0;
  el.addEventListener('pointerdown', (e) => { id = e.pointerId; x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = -1;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (performance.now() - t0 > 900) return;
    if (Math.abs(dx) < min && Math.abs(dy) < min) return;
    if (Math.abs(dx) > Math.abs(dy) * 1.2) cb(dx < 0 ? 'left' : 'right');
    else if (Math.abs(dy) > Math.abs(dx) * 1.2) cb(dy < 0 ? 'up' : 'down');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { id = -1; });
}

export function uid() { return Math.random().toString(36).slice(2, 10); }
