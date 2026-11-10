// The Guide's build tools (the host only): a library drawer of creatures, props and tokens to place on the table,
// a small card to show / hide, turn, resize, rename or remove the piece you tapped, and — in the scene editor —
// a bar to switch, add and set up scenes. New pieces are hidden until the Guide shows them (unless switched off).
import type { Adventure, AreaKind, GameState, GuideOp, Hit, P, Pack, TokenKind } from '../rules/types';
import { GROUNDS, SIZE_MAX, SIZE_MIN, MAX_SCENES, MAX_Y } from '../rules/layout';
import type { Ctx } from './ctx';
import { h, btn, replaceKids } from './dom';
import { icon } from './icons';
import { sceneDef, thingName, twoTap } from './common';
import { sfx, toast } from './feedback';
import { saveAdventure } from './adventures';

type Tab = 'creatures' | 'props' | 'tokens';
type AddOp = Extract<GuideOp, { k: 'add' }>;
interface Card { key: string; tab: Tab; name: string; model?: string; icon?: string; op: Omit<AddOp, 'k' | 'at' | 'hidden'>; editOnly?: boolean }
type Piece = { what: 'prop' | 'foe' | 'token'; id: string };

/** Props that are engine parts, not set dressing. */
const NOT_IN_LIBRARY = new Set(['prop:freeze_overlay', 'prop:dice', 'prop:midnight_clock', 'prop:twinkle_token', 'prop:boss_ice_wall']);
const GROUND_NAME: Record<string, string> = { floor: 'Wooden floor', snow: 'Snow', ice: 'Ice', roof: 'Rooftop' };

export const propName = (model: string) => {
  const n = model.replace(/^prop:/, '').replace(/_/g, ' ').replace(/\b(\d)\b/, '($1)');
  return n.charAt(0).toUpperCase() + n.slice(1);
};

function catalog(pack: Pack): Card[] {
  const out: Card[] = [];
  for (const f of pack.foes) out.push({ key: 'foe:' + f.id, tab: 'creatures', name: f.name, model: f.model, op: { what: 'foe', foe: f.id } });
  for (const r of pack.roles) out.push({ key: 'npc:' + r.id, tab: 'creatures', name: `${r.name} (friend)`, model: r.model, op: { what: 'token', kind: 'npc', model: r.model, label: r.name } });
  for (const m of Object.keys(pack.models).filter((k) => k.startsWith('prop:') && !NOT_IN_LIBRARY.has(k)).sort()) {
    out.push({ key: m, tab: 'props', name: propName(m), model: m, op: { what: 'prop', model: m } });
  }
  const L = pack.labels;
  const goalName = L.goal.replace(/s$/, '');
  out.push({ key: 'tok:goal', tab: 'tokens', name: goalName, model: pack.models['token:goal'] ? 'token:goal' : 'prop:present', op: { what: 'token', kind: 'goal' } });
  out.push({ key: 'tok:star', tab: 'tokens', name: 'Star', model: pack.models['token:star'] ? 'token:star' : 'prop:star', op: { what: 'token', kind: 'star' } });
  out.push({ key: 'tok:clue', tab: 'tokens', name: 'Clue / note', icon: 'search', op: { what: 'token', kind: 'clue', label: 'A note' } });
  out.push({ key: 'tok:exit', tab: 'tokens', name: 'Exit', icon: 'next', op: { what: 'token', kind: 'exit' } });
  out.push({ key: 'tok:start', tab: 'tokens', name: 'Hero start', icon: 'boot', op: { what: 'token', kind: 'start' }, editOnly: true });
  for (const it of pack.items) {
    out.push({ key: 'item:' + it.id, tab: 'tokens', name: it.name, model: it.model, icon: 'pocket', op: { what: 'token', kind: 'item', item: it.id } });
  }
  return out;
}

export interface BuildDeps {
  ctx: Ctx;
  host: HTMLElement;                   // the play layer to append to
  state(): GameState;
  me: string;
  closeOthers(): void;
  leave(): void;                        // editor "Done"
  onLayoutChange(): void;               // drawer / bar size changed (camera insets)
}

export function buildTools(d: BuildDeps) {
  const { ctx } = d;
  const { pack, scene } = ctx;
  const store = ctx.store!;
  const dispatch = (op: GuideOp) => store.dispatch({ t: 'guide', op });
  const cards = catalog(pack);

  let on = false;
  let tab: Tab = 'props';
  let armed: Card | null = null;
  let sel: Piece | null = null;
  let placeHidden = true;
  let rot = 0;                          // rotation for the next placed piece
  let textOpen = false;

  const editMode = () => d.state().mode === 'edit';
  const isHost = () => { const p = d.state().players.find((x) => x.id === d.me); return !!p?.host || !!p?.guide; };

  // ---------------------------------------------------------------- DOM
  const tabsEl = h('div', { class: 'lib-tabs', role: 'tablist' });
  const strip = h('div', { class: 'lib-strip' });
  const hideToggle = h('label', { class: 'lib-hide' },
    h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => { placeHidden = (e.target as HTMLInputElement).checked; paintTabs(); } }),
    h('span', null, 'Place hidden'));
  const doneBtn = btn([icon('check'), ' Done'], () => setOn(false), 'small ghost lib-done');
  const drawer = h('div', { class: 'lib-drawer paper', hidden: true }, h('div', { class: 'lib-top' }, tabsEl, hideToggle, doneBtn), strip);
  const panel = h('div', { class: 'piece-card paper', hidden: true });
  const bar = h('div', { class: 'ed-bar', hidden: true });
  const sheet = h('div', { class: 'ed-sheet paper', hidden: true });
  d.host.append(bar, sheet, panel, drawer);

  const ro = new ResizeObserver(() => d.onLayoutChange());
  ro.observe(drawer); ro.observe(bar);

  // ---------------------------------------------------------------- library drawer
  function paintTabs() {
    const t = (id: Tab, label: string) => h('button', {
      type: 'button', role: 'tab', class: 'lib-tab' + (tab === id ? ' on' : ''), 'aria-selected': String(tab === id),
      onclick: () => { tab = id; armed = null; paintTabs(); paintStrip(); },
    }, label);
    replaceKids(tabsEl, t('creatures', 'Creatures'), t('props', 'Props'), t('tokens', 'Tokens'));
  }
  function paintStrip() {
    const list = cards.filter((c) => c.tab === tab && (!c.editOnly || editMode()));
    replaceKids(strip, list.map((c) => {
      const pic = h('span', { class: 'lib-pic' }, c.icon && !c.model ? icon(c.icon) : h('span', { class: 'lib-wait' }));
      if (c.model) void scene.thumbnail(c.model).then((url) => { if (url) pic.replaceChildren(h('img', { src: url, alt: '', draggable: 'false' })); else if (c.icon) pic.replaceChildren(icon(c.icon)); });
      return h('button', {
        type: 'button', class: 'lib-card' + (armed?.key === c.key ? ' armed' : ''), 'aria-pressed': String(armed?.key === c.key), title: c.name,
        onclick: () => { armed = armed?.key === c.key ? null : c; rot = 0; sel = null; paintPanel(); paintStrip(); if (armed) { sfx.tap(); toast(`Tap the table to place: ${c.name}`); } },
      }, pic, h('span', { class: 'lib-name' }, c.name));
    }));
  }

  // ---------------------------------------------------------------- the tapped piece
  function pieceOf(p: Piece | null): { name: string; hidden: boolean; rot?: number; scale?: number; y?: number; text?: string; label?: string; kind?: TokenKind } | null {
    if (!p) return null;
    const s = d.state(), sc = sceneDef(pack, s);
    if (p.what === 'prop') {
      const pl = sc?.props.find((x) => x.uid === p.id);
      return pl ? { name: propName(pl.model), hidden: !!pl.hidden, rot: pl.rot ?? 0, scale: pl.scale ?? 1, y: pl.y ?? 0, text: pl.story ?? '' } : null;
    }
    if (p.what === 'foe') {
      const f = s.foes.find((x) => x.uid === p.id);
      return f && !f.down ? { name: thingName(pack, s, f.uid), hidden: !!f.hidden, rot: Math.round((f.facing * 180) / Math.PI) } : null;
    }
    const t = s.tokens.find((x) => x.uid === p.id);
    return t && t.pos ? { name: t.kind === 'start' ? (t.label ?? 'Hero start') : thingName(pack, s, t.uid), hidden: !!t.hidden, text: t.text ?? '', label: t.label ?? '', kind: t.kind } : null;
  }
  let panelKey = '';
  let dialActive = false;
  function paintPanel(force = false) {
    if (dialActive) return;                 // never rebuild under a finger
    const x = on ? pieceOf(sel) : null;
    panel.hidden = !x;
    const key = x ? JSON.stringify([sel, x, textOpen]) : '';
    if (!x || (!force && key === panelKey)) { panelKey = key; if (!x) textBox = null; return; }
    panelKey = key;
    const p = sel!;
    const edit = (patch: Omit<Extract<GuideOp, { k: 'edit' }>, 'k' | 'what' | 'id'>) => dispatch({ k: 'edit', what: p.what, id: p.id, ...patch });
    const start = x.kind === 'start';
    const textual = (p.what === 'prop' || (p.what === 'token' && !start));
    const dials: HTMLElement[] = [];
    if (p.what !== 'token') {
      const what = p.what as 'prop' | 'foe';
      dials.push(dial({
        label: 'Turn', ic: 'rotr', value: (((x.rot ?? 0) % 360) + 360) % 360, wrap: 360, step: 15, perPx: -1.2,
        fmt: (v) => `${Math.round(v)}°`,
        preview: (v) => scene.previewPiece(what, p.id, v === null ? null : { rot: v }),
        commit: (v) => edit({ rot: v }),
      }));
    }
    if (p.what === 'prop') {
      dials.push(dial({
        label: 'Size', ic: 'grow', value: x.scale ?? 1, min: 0.25, max: 4, step: 0.05, perPx: 0.01,
        fmt: (v) => `${v.toFixed(2).replace(/0$/, '')}×`,
        preview: (v) => scene.previewPiece('prop', p.id, v === null ? null : { scale: v }),
        commit: (v) => edit({ scale: v }),
      }));
      dials.push(dial({
        label: 'Height', ic: 'up', value: x.y ?? 0, min: 0, max: MAX_Y, step: 0.05, perPx: 0.008,
        fmt: (v) => v < 0.025 ? 'floor' : `${v.toFixed(2).replace(/0$/, '')} m`,
        preview: (v) => scene.previewPiece('prop', p.id, v === null ? null : { y: v }),
        commit: (v) => edit({ y: v }),
      }));
    }
    replaceKids(panel,
      h('div', { class: 'pc-head' },
        h('b', { class: 'grow' }, x.name),
        start ? null : h('span', { class: 'pc-state' + (x.hidden ? ' hid' : '') }, x.hidden ? 'Hidden · only you see it' : 'Everyone sees it'),
        btn(icon('close'), () => { sel = null; paintPanel(); }, 'icon small round', { 'aria-label': 'Close' })),
      h('div', { class: 'pc-row' },
        start ? null : btn([icon(x.hidden ? 'eye' : 'hide'), x.hidden ? ' Show' : ' Hide'], () => { sfx.tap(); edit({ hidden: !x.hidden }); }, x.hidden ? 'primary small' : 'small'),
        ...dials,
        textual ? btn(icon('edit'), () => { textOpen = !textOpen; paintPanel(true); }, 'icon small' + (textOpen ? ' on' : ''), { 'aria-label': 'Text', title: 'Text' }) : null,
        removeBtn(() => { dispatch({ k: 'remove', what: p.what, id: p.id }); sel = null; paintPanel(); })),
      dials.length && dialUses() < 3 ? h('p', { class: 'pc-hint' }, '↔ Hold a dial and slide to change it') : null,
      textual && textOpen ? textBlock(p, x) : null);
  }

  // ---------------------------------------------------------------- dials: hold and slide (left/down less, right/up more)
  const DIAL_KEY = 'sb.dial.uses';
  const dialUses = () => { try { return Number(localStorage.getItem(DIAL_KEY) || 0); } catch { return 3; } };
  const dialUsed = () => { try { localStorage.setItem(DIAL_KEY, String(dialUses() + 1)); } catch { /* private mode */ } };
  interface DialSpec {
    label: string; ic: string; value: number; step: number; perPx: number; min?: number; max?: number; wrap?: number;
    fmt(v: number): string; preview(v: number | null): void; commit(v: number): void;
  }
  function dial(d0: DialSpec): HTMLElement {
    const val = h('b', null, d0.fmt(d0.value));
    const el = h('button', { type: 'button', class: 'dial', title: `${d0.label}: hold and slide`, 'aria-label': `${d0.label} ${d0.fmt(d0.value)}. Hold and slide to change.` },
      icon(d0.ic), h('span', { class: 'dial-txt' }, h('small', null, d0.label), val));
    let id = -1, x0 = 0, y0 = 0, moved = false, cur = d0.value;
    const norm = (v: number) => {
      if (d0.wrap) v = ((v % d0.wrap) + d0.wrap) % d0.wrap;
      else v = Math.min(d0.max ?? Infinity, Math.max(d0.min ?? -Infinity, v));
      v = Math.round(v / d0.step) * d0.step;
      if (d0.wrap && v >= d0.wrap) v -= d0.wrap;
      return +v.toFixed(3);
    };
    el.addEventListener('pointerdown', (e) => {
      if (id !== -1) return;
      e.preventDefault();
      id = e.pointerId; x0 = e.clientX; y0 = e.clientY; moved = false; cur = d0.value;
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      el.classList.add('active'); dialActive = true;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - x0, dy = y0 - e.clientY;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      moved = true;
      const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy;           // right or up = more
      const v = norm(d0.value + d * d0.perPx);
      if (v === cur) return;
      cur = v; val.textContent = d0.fmt(v);
      d0.preview(v);
    });
    const end = (e: PointerEvent, cancel: boolean) => {
      if (e.pointerId !== id) return;
      id = -1; el.classList.remove('active'); dialActive = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (!moved) { toast(`Hold ${d0.label.toLowerCase()} and slide your finger ← →`); return; }
      if (cancel || cur === d0.value) { d0.preview(null); return; }
      sfx.tap(); dialUsed();
      d0.commit(cur);
      setTimeout(() => d0.preview(null), 1500);                     // settle on the state (or back, if refused)
    };
    el.addEventListener('pointerup', (e) => end(e, false));
    el.addEventListener('pointercancel', (e) => end(e, true));
    el.addEventListener('click', (e) => e.preventDefault());
    return el;
  }

  // ---------------------------------------------------------------- text (kept while the piece changes; saves as you type)
  let textBox: { id: string; el: HTMLElement; txt: HTMLTextAreaElement; name: HTMLInputElement | null; note: HTMLElement } | null = null;
  let textTimer = 0;
  function textBlock(p: Piece, x: NonNullable<ReturnType<typeof pieceOf>>): HTMLElement {
    const id = `${p.what}:${p.id}`;
    if (textBox?.id === id) {
      // someone else changed it and I'm not typing: show theirs
      const typing = textBox.el.contains(document.activeElement);
      if (!typing && !textTimer) { textBox.txt.value = x.text ?? ''; if (textBox.name) textBox.name.value = x.label ?? ''; }
      return textBox.el;
    }
    const txt = h('textarea', { class: 'pc-text', rows: '2', maxlength: '300', placeholder: p.what === 'prop' ? 'What heroes find when they look (optional)' : 'What it says when a hero reads it (optional)' }) as HTMLTextAreaElement;
    txt.value = x.text ?? '';
    const name = p.what === 'token' ? h('input', { class: 'pc-name', maxlength: '40', placeholder: 'Name', value: x.label ?? '' }) as HTMLInputElement : null;
    const note = h('small', { class: 'pc-saved' });
    const save = () => {
      clearTimeout(textTimer); textTimer = 0;
      const now = pieceOf(p);
      if (!now) return;
      const patch: { text?: string; label?: string } = {};
      if (txt.value.trim() !== (now.text ?? '')) patch.text = txt.value;
      if (name && name.value.trim() !== (now.label ?? '')) patch.label = name.value;
      if (!Object.keys(patch).length) return;
      dispatch({ k: 'edit', what: p.what, id: p.id, ...patch });
      note.textContent = 'Saved ✓';
    };
    const later = () => { note.textContent = ''; clearTimeout(textTimer); textTimer = setTimeout(save, 700) as unknown as number; };
    for (const f of [txt, name]) if (f) { f.addEventListener('input', later); f.addEventListener('blur', save); }
    const el = h('div', { class: 'pc-texts' }, name, txt, note);
    textBox = { id, el, txt, name, note };
    return el;
  }

  /** Bin button: the first tap turns it into “Remove?”, the second removes (no hidden toast to miss). */
  function removeBtn(go: () => void): HTMLButtonElement {
    let armedAt = 0, timer = 0;
    const b = btn(icon('trash'), () => {
      if (Date.now() - armedAt < 4000) { clearTimeout(timer); sfx.tap(); go(); return; }
      armedAt = Date.now();
      b.replaceChildren(icon('trash'), ' Remove?');
      b.classList.add('confirm');
      timer = setTimeout(() => { armedAt = 0; b.replaceChildren(icon('trash')); b.classList.remove('confirm'); }, 4000) as unknown as number;
    }, 'icon small danger', { 'aria-label': 'Remove' });
    return b;
  }

  // ---------------------------------------------------------------- scene editor bar + sheet
  let sheetOpen = false;
  let barKey = '';
  function paintBar(force = false) {
    const s = d.state();
    const show = editMode();
    bar.hidden = !show;
    sheet.hidden = !show || !sheetOpen;
    if (!show) return;
    const adv = s.adv;
    const sc = sceneDef(pack, s);
    const n = adv?.scenes.length ?? 1, i = s.scene.index;
    const key = JSON.stringify([i, n, sc?.name, sc?.size, sc?.ground, sc?.intro, adv?.name, adv?.blurb, sheetOpen]);
    if (!force && key === barKey) return;
    barKey = key;
    const go = (j: number) => { if (j >= 0 && j < n) { sel = null; dispatch({ k: 'scene', op: 'goto', index: j }); } };
    replaceKids(bar,
      btn([icon('check'), ' Done'], () => d.leave(), 'small primary'),
      btn(icon('left'), () => go(i - 1), 'icon small', { disabled: i <= 0, 'aria-label': 'Previous scene' }),
      h('button', { type: 'button', class: 'ed-title', onclick: () => { sheetOpen = !sheetOpen; paintBar(true); } },
        h('small', null, `${adv?.name ?? ''} · scene ${i + 1} of ${n}`), h('b', null, sc?.name ?? ''), icon(sheetOpen ? 'up' : 'gear')),
      btn(icon('right'), () => go(i + 1), 'icon small', { disabled: i >= n - 1, 'aria-label': 'Next scene' }));
    if (!sheetOpen || !sc) return;
    const set = (patch: Extract<GuideOp, { k: 'scene' }>['patch']) => dispatch({ k: 'scene', op: 'set', patch });
    const field = (label: string, el: HTMLElement) => h('label', { class: 'ed-field' }, h('span', null, label), el);
    const input = (val: string, max: number, on: (v: string) => void, area = false) => {
      const el = (area ? h('textarea', { rows: '3', maxlength: String(max) }) : h('input', { maxlength: String(max) })) as HTMLInputElement;
      el.value = val;
      el.addEventListener('change', () => on(el.value));
      return el;
    };
    const stepper = (label: string, v: number, on: (v: number) => void) => h('div', { class: 'ed-step' }, h('span', null, label),
      btn('−', () => on(v - 1), 'icon small round', { disabled: v <= SIZE_MIN, 'aria-label': `${label} smaller` }), h('b', null, `${v} m`),
      btn('+', () => on(v + 1), 'icon small round', { disabled: v >= SIZE_MAX, 'aria-label': `${label} bigger` }));
    const ground = h('select', { onchange: (e: Event) => set({ ground: (e.target as HTMLSelectElement).value as AreaKind }) },
      GROUNDS.map((g) => h('option', { value: g, selected: g === sc.ground }, GROUND_NAME[g] ?? g)));
    replaceKids(sheet,
      h('h4', null, 'This scene'),
      field('Name', input(sc.name, 60, (v) => set({ name: v }))),
      field('Read out at the start', input(sc.intro, 600, (v) => set({ intro: v }), true)),
      h('div', { class: 'ed-row' }, stepper('Width', sc.size.w, (w) => set({ w })), stepper('Depth', sc.size.d, (dd) => set({ d: dd }))),
      field('Ground', ground),
      h('div', { class: 'ed-row wrap' },
        btn([icon('plus'), ' New scene'], () => { sel = null; dispatch({ k: 'scene', op: 'add' }); }, 'small', { disabled: n >= MAX_SCENES }),
        btn([icon('copy'), ' Copy scene'], () => { sel = null; dispatch({ k: 'scene', op: 'copy' }); }, 'small', { disabled: n >= MAX_SCENES }),
        btn([icon('up'), ' Earlier'], () => dispatch({ k: 'scene', op: 'up' }), 'small', { disabled: i <= 0 }),
        btn([icon('down'), ' Later'], () => dispatch({ k: 'scene', op: 'down' }), 'small', { disabled: i >= n - 1 }),
        btn([icon('trash'), ' Delete scene'], twoTap(() => { sel = null; dispatch({ k: 'scene', op: 'delete' }); }, 'Tap again to delete this scene', (m) => toast(m)), 'small danger', { disabled: n <= 1 })),
      h('div', { class: 'ed-row wrap' },
        btn([icon('eye'), ' Show everything'], () => dispatch({ k: 'hideAll', hidden: false }), 'small'),
        btn([icon('hide'), ' Hide everything'], () => dispatch({ k: 'hideAll', hidden: true }), 'small')),
      h('h4', null, 'The adventure'),
      field('Name', input(adv?.name ?? '', 60, (v) => set({ advName: v }))),
      field('About it', input(adv?.blurb ?? '', 300, (v) => set({ advBlurb: v }), true)),
      h('p', { class: 'ed-note' }, 'Changes are saved on this device as you go.'));
  }

  // ---------------------------------------------------------------- autosave (editor)
  let baseline = '';
  let saveTimer = 0;
  function autosave(s: GameState) {
    if (s.mode !== 'edit' || !s.adv) return;
    const json = JSON.stringify(s.adv);
    if (!baseline) { baseline = json; return; }
    if (json === baseline) return;
    clearTimeout(saveTimer);
    const adv: Adventure = s.adv;
    saveTimer = setTimeout(() => { if (saveAdventure(adv)) baseline = JSON.stringify(adv); else toast('Could not save on this device', 'error'); }, 400) as unknown as number;
  }

  // ---------------------------------------------------------------- api
  function setOn(v: boolean) {
    if (v && !isHost()) return;
    if (v === on) return;
    on = v;
    if (!on) { armed = null; sel = null; }
    drawer.hidden = !on;
    doneBtn.hidden = editMode();          // the editor has its own Done
    if (on) { d.closeOthers(); paintTabs(); paintStrip(); }
    paintPanel(true);
    d.onLayoutChange();
  }

  /** Open the build tools with this piece picked (the Guide's "Edit" in the hold menu). */
  function editHit(hit: Hit) {
    setOn(true);
    if (!on) return;
    armed = null; paintStrip();
    tap(hit);
  }

  /** A tap on the table while building. Returns true if it was used. */
  function tap(hit: Hit): boolean {
    if (!on) return false;
    if (armed) {
      const at: P = hit.at;
      const op: AddOp = { k: 'add', ...armed.op, at, hidden: armed.op.kind === 'start' ? false : placeHidden } as AddOp;
      if (rot) op.rot = rot;
      sfx.tap();
      dispatch(op);
      return true;
    }
    const s = d.state(), sc = sceneDef(pack, s);
    if (hit.kind === 'prop') { const uid = sc?.props[hit.index]?.uid; sel = uid ? { what: 'prop', id: uid } : null; }
    else if (hit.kind === 'foe') sel = { what: 'foe', id: hit.id };
    else if (hit.kind === 'token') sel = { what: 'token', id: hit.id };
    else if (hit.kind === 'ground') sel = null;
    else return false;
    if (sel) sfx.tap();
    textOpen = false;
    paintPanel(true);
    return true;
  }
  /** While building, every piece can be dragged (props too). null = not my business. */
  function canDrag(hit: Hit): boolean | null {
    if (!on) return null;
    return hit.kind === 'prop' || hit.kind === 'foe' || hit.kind === 'token';
  }
  function dragEnd(hit: Hit, at: P): boolean {
    if (hit.kind !== 'prop') return false;
    const uid = sceneDef(pack, d.state())?.props[hit.index]?.uid;
    if (uid) { dispatch({ k: 'place', what: 'prop', id: uid, to: at }); sel = { what: 'prop', id: uid }; paintPanel(true); }
    return true;
  }

  function update(s: GameState) {
    if (s.mode === 'edit' && !on && isHost()) setOn(true);
    if (on && !isHost()) setOn(false);
    if (sel && !pieceOf(sel)) sel = null;
    paintPanel();
    paintBar();
    autosave(s);
  }

  return {
    get on() { return on; },
    bar, drawer,
    setOn, toggle: () => setOn(!on), tap, editHit, canDrag, dragEnd, update,
    destroy() { ro.disconnect(); clearTimeout(saveTimer); const s = d.state(); if (s.mode === 'edit' && s.adv && JSON.stringify(s.adv) !== baseline && baseline) saveAdventure(s.adv); },
  };
}
export type BuildTools = ReturnType<typeof buildTools>;
