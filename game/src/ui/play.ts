// The thin layer over the 3D table: local selection, tap / hold (ring menu) / drag, dice arming + the roll card,
// the corner strip (the only HUD), the ≡ menu (incl. the Guide's tools), intro / scene-end / choice notes,
// read-aloud, and the full-screen table moments and ending.
import type { DiceThrow, LocalView } from '../contracts';
import type { GameState, Hit, Option, P, Roll, TargetKind, TargetRef, Trait } from '../rules/types';
import { rules } from '../rules';
import { HIT, STRONG } from '../rules/rolls';
import type { Ctx } from './ctx';
import { h, btn, replaceKids } from './dom';
import { icon } from './icons';
import { hero, sceneDef, thingName, traitName, TRAITS, TRAIT_HELP, safe, twoTap, avatar, heroColor, traitBadge, itemDef, role as roleOf, singular } from './common';
import { sfx, buzz, toast, prefs, setMuted, speakQueued, stopSpeaking } from './feedback';
import { momentView } from './moments';
import { endingScreen } from './ending';
import { buildTools } from './build';
import { saveAdventure } from './adventures';

type DragKind = 'hero' | 'foe' | 'token';
interface DragMsg { kind: DragKind; id: string; at: P; end?: boolean }

const HIT_WORD: Record<string, string> = { strong: 'Strong hit!', success: 'Hit!', trouble: 'Miss!' };
const PLAIN_WORD: Record<string, string> = { strong: 'Great!', success: 'It works!', trouble: 'No luck!' };

export function playScreen(ctx: Ctx) {
  const store = ctx.store!;
  const { pack, scene } = ctx;
  const net = store.net;
  const me = store.me;
  const local = store.role === 'local';
  let s: GameState = store.state!;

  // ---------------------------------------------------------------- local (not synced) state
  let selected: string | null = null;
  let pick: { opt: Option; heroId: string } | null = null;
  let preview: LocalView['preview'] = null;
  let previewTimer = 0;
  let armedKey: string | null = null;       // which roll the dice are armed for
  let reroll: string | null = null;         // roll id waiting for a reroll flick
  let lastThing: string | undefined;        // last tapped/held mini (Guide "Say…" default)
  let lastCameraSeq = s.cameraCall?.seq ?? 0;
  let lastPhase: string | null = null;
  let lastRollStage = '';
  const spoken = new Set<string>();
  let primed = false;                       // first render: don't read out old bubbles

  const guide = () => safe(() => rules.isGuide(s, me), false);
  const mine = () => safe(() => rules.controlled(s, me), [] as string[]);

  // ---------------------------------------------------------------- DOM
  const el = h('div', { class: 'play' });
  const meterBtn = h('button', { type: 'button', class: 'strip-meters', 'aria-label': 'Meters' });
  const menuBtn = h('button', { type: 'button', class: 'strip-menu', 'aria-label': 'Menu' }, icon('menu'));
  const strip = h('div', { class: 'strip' }, meterBtn, menuBtn);
  const netPill = h('div', { class: 'net-pill', hidden: true });
  const pickPill = h('div', { class: 'pick-pill', hidden: true });
  const noteBox = h('div', { class: 'note-layer' });
  const rollBox = h('div', { class: 'roll-layer' });
  const overlay = h('div', { class: 'full-layer' });
  const heroChip = h('div', { class: 'hero-chip', hidden: true });
  el.append(strip, netPill, pickPill, heroChip, noteBox, rollBox, overlay);

  // keep the scene's camera clear of the strip (or the editor bar) and the build drawer
  const fitCamera = () => {
    const tops = [strip, build.bar].filter((x) => !x.hidden).map((x) => x.getBoundingClientRect().bottom);
    const bottom = build.drawer.hidden ? 0 : Math.max(0, innerHeight - build.drawer.getBoundingClientRect().top);
    el.style.setProperty('--drawer-h', bottom + 'px');
    safe(() => scene.setInsets(Math.round(Math.max(0, ...tops) + 4), Math.round(bottom)), undefined);
    placeDice();
  };
  const ro = new ResizeObserver(fitCamera);
  ro.observe(strip);

  // the armed dice sit in the clear band under the roll card, so the card never covers them or eats the flick
  const placeDice = () => {
    const card = rollBox.querySelector('.roll-card.ready');
    const cv = el.getBoundingClientRect();
    if (!card || !cv.height) { safe(() => scene.setDiceY(null), undefined); return; }
    const band = cv.bottom - card.getBoundingClientRect().bottom;   // px between the card and the screen bottom
    safe(() => scene.setDiceY(Math.max(60, band * 0.52)), undefined);
  };
  const build = buildTools({
    ctx, host: el, me, state: () => s,
    closeOthers: () => { closeRing(); closeInspect(); closeSheet(); closeMenus(); leavePick(); select(null); },
    leave: () => ctx.openAdventures(),
    onLayoutChange: () => fitCamera(),
  });
  const dro = new ResizeObserver(placeDice);
  dro.observe(rollBox); dro.observe(el);
  new MutationObserver(placeDice).observe(rollBox, { childList: true });

  // ---------------------------------------------------------------- helpers
  const dispatch = (a: Parameters<typeof store.dispatch>[0]) => store.dispatch(a);
  const pushLocal = () => safe(() => scene.setLocal({ me, isGuide: guide(), selectedHeroId: selected, myHeroIds: mine(), preview }), undefined);

  function select(id: string | null) {
    if (selected === id) return;
    selected = id;
    if (id) sfx.tap();
    pushLocal();
    paintHeroChip();
  }

  function hitThingId(hit: Hit): string | undefined {
    return hit.kind === 'hero' || hit.kind === 'foe' || hit.kind === 'token' ? hit.id : undefined;
  }

  // ---------------------------------------------------------------- inspect bubble (local only, anchored to the thing)
  let inspectEl: HTMLElement | null = null;
  let inspectRaf = 0;
  let inspectTimer = 0;
  function closeInspect() {
    cancelAnimationFrame(inspectRaf); clearTimeout(inspectTimer);
    inspectEl?.remove(); inspectEl = null;
  }
  function inspect(hit: Hit, given?: string) {
    closeInspect();
    const text = given || safe(() => rules.describe(s, hit, pack, guide()), '');
    if (!text) return;
    const box = h('div', { class: 'inspect paper', role: 'status', onclick: closeInspect }, text);
    el.appendChild(box);
    inspectEl = box;
    const place = () => {
      const p = safe(() => scene.worldToScreen(hit.at, 1.4), { x: innerWidth / 2, y: innerHeight / 2, visible: true });
      const w = box.offsetWidth, hh = box.offsetHeight;
      const x = Math.min(innerWidth - w / 2 - 10, Math.max(w / 2 + 10, p.x));
      const y = Math.max(60 + hh, p.y - 12);
      box.style.transform = `translate(${Math.round(x - w / 2)}px, ${Math.round(y - hh)}px)`;
      box.style.opacity = p.visible ? '' : '0';
      inspectRaf = requestAnimationFrame(place);
    };
    place();
    inspectTimer = setTimeout(closeInspect, Math.min(9000, 2500 + text.length * 45)) as unknown as number;
  }

  // ---------------------------------------------------------------- running an option
  function run(opt: Option, hit: Hit) {
    closeInspect();
    const a = opt.action;
    // "Say…" comes from the rules with an empty line: ask the Guide for the words first
    if (a && a.t === 'guide' && a.op.k === 'say' && !a.op.text) { sayPrompt(a.op.who); return; }
    if (a) { sfx.tap(); dispatch(a); afterAction(opt); return; }
    if (opt.needs && opt.needs !== 'none') { enterPick(opt, selected ?? (hit.kind === 'hero' ? hit.id : '')); return; }
    if (opt.id === 'select' && hit.kind === 'hero') { select(hit.id); return; }
    if (opt.id === 'deselect') { select(null); return; }
    if (opt.hint && !/^inspect|look/i.test(opt.id)) { inspect(hit, opt.hint); return; }
    inspect(hit);
  }

  // a small floating card for the Guide's "Say…" on a mini (or the narrator)
  let sayEl: HTMLElement | null = null;
  function sayPrompt(who?: string) {
    sayEl?.remove();
    const name = who ? thingName(pack, s, who) : 'Narrator';
    const txt = h('input', { class: 'say-in', placeholder: who ? `What does ${name} say?` : 'What happens?', maxlength: '160', enterkeyhint: 'send', 'aria-label': 'Line to say' });
    const close = () => { sayEl?.remove(); sayEl = null; };
    const go = () => {
      const text = txt.value.trim();
      if (!text) { txt.focus(); return; }
      dispatch({ t: 'guide', op: { k: 'say', text, who } });
      close();
    };
    txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); });
    sayEl = h('div', { class: 'say-card paper' },
      h('div', { class: 'rc-head' }, icon('say'), h('b', { class: 'grow' }, name),
        h('button', { type: 'button', class: 'rc-x', 'aria-label': 'Close', onclick: close }, icon('close'))),
      h('div', { class: 'rc-twist-form' }, txt, btn('Say', go, 'primary small')));
    el.appendChild(sayEl);
    setTimeout(() => txt.focus(), 30);
  }
  function afterAction(opt: Option) {
    const a = opt.action;
    if (a && a.t === 'walk') sfx.step();
  }

  const NEEDS_TEXT: Record<TargetKind, string> = {
    none: '', point: 'Tap a spot', hero: 'Tap a friend', foe: `Tap one of the ${pack.labels.foes?.toLowerCase() || 'foes'}`, token: 'Tap something on the table', any: 'Tap something or a spot',
  };
  function enterPick(opt: Option, heroId: string) {
    pick = { opt, heroId };
    replaceKids(pickPill, icon('target'), h('span', null, NEEDS_TEXT[opt.needs ?? 'any'] || 'Tap a target'),
      h('button', { type: 'button', class: 'pill-x', 'aria-label': 'Cancel', onclick: () => leavePick() }, icon('close')));
    pickPill.hidden = false;
    paintHeroChip();
    toast(NEEDS_TEXT[opt.needs ?? 'any'] || 'Tap a target');
  }
  function leavePick() { pick = null; pickPill.hidden = true; paintHeroChip(); }

  function targetFrom(hit: Hit, needs: TargetKind): TargetRef | null {
    switch (needs) {
      case 'hero': return hit.kind === 'hero' ? { heroId: hit.id } : null;
      case 'foe': return hit.kind === 'foe' ? { foeUid: hit.id } : null;
      case 'token': return hit.kind === 'token' ? { tokenUid: hit.id } : null;
      case 'point': return { at: hit.at };
      default:
        if (hit.kind === 'hero') return { heroId: hit.id };
        if (hit.kind === 'foe') return { foeUid: hit.id };
        if (hit.kind === 'token') return { tokenUid: hit.id };
        return { at: hit.at };
    }
  }

  // ---------------------------------------------------------------- hero chip + hero card (what my hero is good at)
  let chipKey = '';
  function knackOf(id: string): { opt: Option; hit: Hit } | null {
    const x = hero(s, id);
    if (!x) return null;
    const hit: Hit = { kind: 'hero', id, at: x.pos };
    const opt = safe(() => rules.options(s, me, id, hit, pack), [] as Option[]).find((o) => o.id === 'knack');
    return opt ? { opt, hit } : null;
  }
  function useKnack(id: string) {
    const k = knackOf(id);
    if (!k) { toast('Special moves work once per scene'); return; }
    closeSheet();
    if (selected !== id) select(id);
    run(k.opt, k.hit);
  }
  function paintHeroChip() {
    const x = hero(s, selected ?? undefined);
    const busy = !!s.roll && s.roll.stage !== 'done';
    const show = s.phase === 'play' && !!x && !busy && !pick;
    const ro = x ? roleOf(pack, x.roleId) : undefined;
    const key = show && x ? JSON.stringify([x.id, x.name, x.knackUsed, x.tuckered, x.hearts]) : '';
    heroChip.hidden = !show;
    if (key === chipKey) return;
    chipKey = key;
    if (!show || !x) return;
    const L = pack.labels;
    replaceKids(heroChip,
      h('button', { type: 'button', class: 'hc-me', 'aria-label': `About ${x.name}`, onclick: () => openSheet(x.id) },
        avatar(pack, x.roleId, heroColor(s, x), 'avatar tiny'), h('span', { class: 'hc-name' }, x.name),
        h('span', { class: 'hc-hearts', 'aria-label': `${x.hearts} ${L.hearts}` }, icon('heart'), String(x.hearts)), icon('help', 'ic hc-q')),
      ro ? (x.knackUsed || x.tuckered
        ? h('span', { class: 'hc-knack used', title: 'Back next scene' }, icon('sparkle'), ro.knack.name, ' ✓')
        : h('button', { type: 'button', class: 'hc-knack', title: ro.knack.text, onclick: () => useKnack(x.id) }, icon('sparkle'), ro.knack.name)) : null);
  }

  let sheetEl: HTMLElement | null = null;
  let sheetFor: string | null = null;
  function closeSheet() { sheetEl?.remove(); sheetEl = null; sheetFor = null; }
  function openSheet(id: string) {
    closeSheet(); closeInspect();
    const x = hero(s, id);
    if (!x) return;
    const L = pack.labels;
    const ro = roleOf(pack, x.roleId);
    const kid = s.settings.kidMode;
    const isMine = mine().includes(x.id);
    const hearts = h('span', { class: 'hs-hearts' });
    for (let i = 0; i < x.maxHearts; i++) hearts.appendChild(icon('heart', 'ic' + (i < x.hearts ? '' : ' off')));
    const k = ro?.knack;
    const kn = knackOf(x.id);
    sheetFor = id;
    sheetEl = h('div', { class: 'hero-sheet paper', role: 'dialog', 'aria-label': `${x.name}'s card` },
      h('header', { class: 'hs-head' }, avatar(pack, x.roleId, heroColor(s, x), 'avatar small'),
        h('span', { class: 'grow' }, h('b', null, x.name), h('small', null, ro?.name ?? '')),
        btn(icon('close'), closeSheet, 'icon small round', { 'aria-label': 'Close' })),
      h('section', null, h('h4', null, L.hearts, ' ', hearts),
        h('p', null, x.tuckered ? `${L.tuckered} — a friend next to ${x.name} can wake them.` : `A miss on an attack or a leap costs 1 ${L.hearts}. At 0 you're ${L.tuckered} until a friend wakes you.`)),
      h('section', null, h('h4', null, 'Good at'),
        h('p', { class: 'hs-note' }, 'Each action rolls 2 dice + one of these. Bigger number = better chance.'),
        h('ul', { class: 'hs-traits' }, TRAITS.map((t: Trait) => h('li', null, traitBadge(pack, t, x.traits[t], kid),
          h('span', null, h('b', null, traitName(pack, t)), ' ', TRAIT_HELP[t]))))),
      k ? h('section', null, h('h4', null, icon('sparkle'), ' Special move: ', k.name),
        h('p', null, k.text),
        h('p', { class: 'hs-note' }, x.knackUsed ? 'Used — it comes back next scene.' : 'Works once per scene, no dice needed.'),
        isMine && kn && !x.tuckered ? btn([icon('sparkle'), `Use ${k.name}`], () => useKnack(x.id), 'primary small') : null) : null,
      x.pocket.length ? h('section', null, h('h4', null, icon('pocket'), ' Pocket'),
        h('ul', { class: 'hs-pocket' }, x.pocket.map((id) => { const it = itemDef(pack, id); return h('li', null, h('b', null, it?.name ?? id), it ? ` — ${it.text}` : ''); })),
        isMine ? h('p', { class: 'hs-note' }, 'Hold your hero to use or give things.') : null) : null);
    el.appendChild(sheetEl);
  }

  // ---------------------------------------------------------------- scene callbacks
  function onTap(hit: Hit) {
    if (closeRing()) return;
    closeMenus();
    if (build.tap(hit)) return;
    const id = hitThingId(hit);
    if (id) lastThing = id;
    if (pick) {
      const target = targetFrom(hit, pick.opt.needs ?? 'any');
      if (!target) { toast(NEEDS_TEXT[pick.opt.needs ?? 'any'] || 'Tap a target'); return; }
      const a = safe(() => rules.buildAction(s, me, pick!.heroId, pick!.opt, target, pack), null);
      leavePick();
      if (a) { sfx.tap(); dispatch(a); } else toast('That won’t work there', 'error');
      return;
    }
    if (s.phase !== 'play') return;
    // own hero → select / switch
    if (hit.kind === 'hero' && mine().includes(hit.id) && selected !== hit.id) { closeInspect(); closeSheet(); select(hit.id); return; }
    if (hit.kind === 'hero' && mine().includes(hit.id)) { if (sheetFor === hit.id) closeSheet(); else openSheet(hit.id); return; }
    closeSheet();
    const opts = safe(() => rules.options(s, me, selected, hit, pack), [] as Option[]);
    const primary = opts.find((o) => o.primary && (!o.guideOnly || guide()));
    if (primary) { run(primary, hit); return; }
    if (hit.kind === 'ground') { closeInspect(); return; }
    inspect(hit);
  }

  function onHold(hit: Hit, screen: { x: number; y: number }) {
    closeMenus();
    if (s.phase !== 'play' && !guide()) return;
    const id = hitThingId(hit);
    if (id) lastThing = id;
    if (pick) leavePick();
    openRing(hit, screen);
  }

  function canDrag(hit: Hit): boolean {
    if (s.phase !== 'play' && s.phase !== 'intro') return false;
    const b = build.canDrag(hit);
    if (b !== null) return b;
    if (guide()) return hit.kind === 'hero' || hit.kind === 'foe' || hit.kind === 'token';
    return s.phase === 'play' && hit.kind === 'hero' && mine().includes(hit.id);
  }

  let dragSent = 0;
  let dragTimer = 0;
  let dragLatest: DragMsg | null = null;
  const flushDrag = () => {
    dragTimer = 0;
    if (!dragLatest) return;
    dragSent = Date.now();
    net.sendEphemeral('drag', dragLatest);
    dragLatest = null;
  };
  function onDrag(hit: Hit, at: P, phase: 'start' | 'move' | 'end') {
    if (hit.kind === 'prop') { closeRing(); closeInspect(); if (phase === 'end') build.dragEnd(hit, at); return; }
    if (hit.kind !== 'hero' && hit.kind !== 'foe' && hit.kind !== 'token') return;
    const msg: DragMsg = { kind: hit.kind, id: hit.id, at: { x: +at.x.toFixed(2), z: +at.z.toFixed(2) } };
    closeRing(); closeInspect();
    if (phase !== 'end') {
      if (!local) {
        dragLatest = msg;
        const wait = 100 - (Date.now() - dragSent);
        if (wait <= 0) flushDrag();
        else if (!dragTimer) dragTimer = setTimeout(flushDrag, wait) as unknown as number;
      }
      return;
    }
    clearTimeout(dragTimer); dragTimer = 0; dragLatest = null;
    if (!local) net.sendEphemeral('drag', { ...msg, end: true });
    // Pass-and-play: the device is the Guide *and* every player — heroes still walk when dragged.
    const teleport = guide() && !(local && hit.kind === 'hero');
    if (teleport) dispatch({ t: 'guide', op: { k: 'place', what: hit.kind, id: hit.id, to: msg.at } });
    else if (hit.kind === 'hero') { dispatch({ t: 'walk', heroId: hit.id, to: msg.at }); sfx.step(); }
    if (hit.kind === 'hero' && mine().includes(hit.id)) select(hit.id);
  }

  function nearestTarget(land: P, within = 1.5): TargetRef | undefined {
    let best: TargetRef | undefined, bd = within;
    for (const f of s.foes) {
      if (f.down) continue;
      const d = Math.hypot(f.pos.x - land.x, f.pos.z - land.z);
      if (d <= bd) { bd = d; best = { foeUid: f.uid }; }
    }
    for (const k of s.tokens) {
      if (!k.pos || (k.hidden && !guide())) continue;
      const d = Math.hypot(k.pos.x - land.x, k.pos.z - land.z);
      if (d <= bd) { bd = d; best = { tokenUid: k.uid }; }
    }
    return best;
  }

  function onDiceThrown(t: DiceThrow) {
    if (!local) net.sendEphemeral('dice', t);
    const r = s.roll;
    armedKey = `${t.rollId}:thrown`;
    if (!r || r.id !== t.rollId) return;
    sfx.dice();
    if (reroll === t.rollId) {
      reroll = null;
      dispatch({ t: 'spark', rollId: r.id, use: 'reroll', dice: t.values });
      return;
    }
    const target = s.settings.diceMode === 'throwAt' ? nearestTarget(t.land) : undefined;
    dispatch({ t: 'throw', rollId: r.id, dice: t.values, land: t.land, target });
  }

  // remote drags and dice
  const offEph = net.onEphemeral((ch, data, from) => {
    if (from === me) return;
    if (ch === 'drag') {
      const d = data as DragMsg;
      if (!d || !d.id || !d.at) return;
      preview = d.end ? null : { kind: d.kind, id: d.id, at: d.at };
      clearTimeout(previewTimer);
      if (preview) previewTimer = setTimeout(() => { preview = null; pushLocal(); }, 1500) as unknown as number;
      pushLocal();
    } else if (ch === 'dice') {
      const t = data as DiceThrow;
      if (t && Array.isArray(t.values)) { sfx.dice(); safe(() => scene.replayDice(t), undefined)?.catch?.(() => {}); }
    }
  });

  // ---------------------------------------------------------------- ring menu
  let ringEl: HTMLElement | null = null;
  function closeRing(): boolean {
    if (!ringEl) return false;
    ringEl.remove(); ringEl = null;
    return true;
  }
  function openRing(hit: Hit, finger: { x: number; y: number }, page: 'play' | 'guide' = 'play') {
    closeRing();
    const g = guide();
    const all = safe(() => rules.options(s, me, selected, hit, pack), [] as Option[]);
    const seen = new Set<string>();   // the primary option often repeats one of the alternatives
    const playOpts = all.filter((o) => !o.guideOnly).sort((a, b) => Number(!!b.primary) - Number(!!a.primary)).filter((o) => {
      const k = o.action ? JSON.stringify(o.action) : '';
      if (k && seen.has(k)) return false; if (k) seen.add(k); return true;
    });
    const guideOpts = g ? all.filter((o) => o.guideOnly) : [];
    if (hit.kind !== 'ground' && !all.some((o) => /^inspect|look/i.test(o.id))) playOpts.push({ id: 'inspect', label: 'Look', icon: 'eye' });
    // Two pages keep the ring readable: what anyone can do, then the Guide's tools behind one button.
    let opts: Option[];
    if (page === 'guide' || (g && playOpts.length <= 1 && guideOpts.length)) {
      opts = [...guideOpts];
      if (playOpts.length) opts.push({ id: '__back', label: 'Back', icon: 'back' });
      page = 'guide';
    } else {
      opts = [...playOpts];
      if (guideOpts.length) opts.push({ id: '__guide', label: pack.labels.guide ?? 'Guide', icon: 'guide', guideOnly: true });
    }
    if (!opts.length) return;
    if (page === 'play') { buzz(15); sfx.tap(); }

    let at = finger;
    if (hit.kind !== 'ground') {
      const p = safe(() => scene.worldToScreen(hit.at, 0.8), { x: finger.x, y: finger.y, visible: false });
      if (p.visible) at = p;
    }
    const n = opts.length;
    const R = n <= 4 ? 78 : n <= 6 ? 92 : n <= 9 ? 112 : 128;
    const pad = R + 46;
    const top = strip.getBoundingClientRect().bottom + 8;
    const cx = Math.min(innerWidth - pad, Math.max(pad, at.x));
    const cy = Math.min(innerHeight - pad, Math.max(top + pad, at.y));

    const name = hit.kind === 'ground' ? 'Here' : hit.kind === 'prop' ? 'This' : hit.kind === 'meter' ? 'Meter' : thingName(pack, s, hitThingId(hit)) || 'This';
    const ring = h('div', { class: 'ring-layer', role: 'menu', 'aria-label': `Choices for ${name}` });
    ring.addEventListener('pointerdown', (e) => { if (e.target === ring) { e.preventDefault(); closeRing(); } });
    ring.addEventListener('contextmenu', (e) => { e.preventDefault(); closeRing(); });
    const centre = h('button', { type: 'button', class: 'ring-centre', style: `left:${cx}px;top:${cy}px`, 'aria-label': 'Close', onclick: () => closeRing() },
      h('span', null, name));
    ring.appendChild(centre);
    opts.forEach((o, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
      const b = h('button', {
        type: 'button', role: 'menuitem', class: 'ring-item' + (o.guideOnly ? ' guide' : '') + (o.primary ? ' primary' : ''),
        style: `left:${x}px;top:${y}px;animation-delay:${i * 18}ms`, title: o.hint ?? o.label,
        onclick: (e: Event) => {
          e.stopPropagation();
          if (o.id === '__guide' || o.id === '__back') { openRing(hit, finger, o.id === '__guide' ? 'guide' : 'play'); return; }
          closeRing(); run(o, hit);
        },
      }, h('span', { class: 'ring-ic' }, icon(o.icon || 'sparkle')), h('span', { class: 'ring-lbl' }, o.label));
      ring.appendChild(b);
    });
    el.appendChild(ring);
    ringEl = ring;
  }

  // ---------------------------------------------------------------- corner strip
  let meterOpen = false;
  let menuOpen = false;
  const dropEl = h('div', { class: 'drop paper', hidden: true });
  const dropBack = h('div', { class: 'drop-back', hidden: true, onpointerdown: (e: Event) => { e.preventDefault(); closeMenus(); } });
  el.append(dropBack, dropEl);
  function closeMenus() {
    if (!meterOpen && !menuOpen) return;
    meterOpen = menuOpen = false;
    dropEl.hidden = true; dropBack.hidden = true;
  }
  function openDrop(kind: 'meters' | 'menu') {
    const was = kind === 'meters' ? meterOpen : menuOpen;
    closeMenus(); closeRing();
    if (was) return;
    if (kind === 'meters') meterOpen = true; else menuOpen = true;
    dropBack.hidden = false; dropEl.hidden = false;
    sfx.tap();
    paintDrop(true);
  }
  meterBtn.addEventListener('click', () => openDrop('meters'));
  menuBtn.addEventListener('click', () => openDrop('menu'));

  const clockSvg = (m: number) => {
    const a = (m / 12) * Math.PI * 2;
    const x = 12 + Math.sin(a) * 6.5, y = 12 - Math.cos(a) * 6.5;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="#2a2328" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5" fill="#f2eadb"/>` +
      `<path d="M12 12 L${x.toFixed(2)} ${y.toFixed(2)}" stroke-width="2.4"/><circle cx="12" cy="3.6" r="1.3" fill="#8a4a4e" stroke="none"/></svg>`;
  };
  function midnightInfo() {
    const now = Date.now();
    const m = Math.max(0, Math.min(12, safe(() => rules.midnight(s, now), 0)));
    const leftMs = Math.max(0, ((12 - m) / 12) * s.clock.totalMs);
    const paused = s.clock.runningSince === null;
    const mins = Math.ceil(leftMs / 60000);
    const label = leftMs <= 0 ? '0:00' : leftMs < 60000 ? `${Math.ceil(leftMs / 1000)}s` : `${mins}m`;
    return { m, leftMs, paused, label };
  }
  function paintStrip() {
    const kid = s.settings.kidMode;
    const mi = midnightInfo();
    const gifts = `${s.meters.goal}/${s.meters.goalMax}`;
    meterBtn.replaceChildren(
      h('span', { class: 'sm' }, icon('gift'), kid ? null : h('b', null, gifts)),
      h('span', { class: 'sm' + (mi.m >= 10 ? ' late' : '') }, h('span', { class: 'ic', html: clockSvg(mi.m) }), kid ? null : h('b', null, mi.label), mi.paused && s.phase === 'play' ? h('i', { class: 'paused' }, '‖') : null),
      h('span', { class: 'sm' }, icon('twinkle'), h('b', null, String(s.meters.sparks))));
    meterBtn.setAttribute('aria-label', `${pack.labels.goal} ${gifts}, ${pack.labels.clock} in ${Math.ceil(mi.leftMs / 60000)} minutes, ${pack.labels.sparks} ${s.meters.sparks}`);
    menuBtn.classList.toggle('guide', guide());
    strip.hidden = s.phase === 'tableMoment' || s.phase === 'ending' || s.mode === 'edit';
  }

  function paintNet(status = net.status) {
    const off = !local && (status !== 'online' || !navigator.onLine);
    netPill.hidden = !off;
    if (off) netPill.textContent = !navigator.onLine ? 'Offline' : 'Reconnecting…';
  }
  const offStatus = net.onStatus((st) => paintNet(st));
  const onLineChange = () => paintNet();
  addEventListener('online', onLineChange); addEventListener('offline', onLineChange);

  // ---- drop-downs
  let sayOpen = false;
  let settingsOpen = false;
  let helpOpen = false;
  let dropKey = '';
  function paintDrop(force = false) {
    if (dropEl.hidden) return;
    if (meterOpen) {
      const k = `m:${s.meters.goal}:${s.meters.sparks}:${Math.round(midnightInfo().leftMs / 1000)}:${s.clock.runningSince}:${guide()}`;
      if (!force && k === dropKey) return;
      dropKey = k;
      const mi = midnightInfo();
      const g = guide();
      const pm = (on: (d: number) => void) => [btn('−', () => on(-1), 'icon small round', { 'aria-label': 'Less' }), btn('+', () => on(1), 'icon small round', { 'aria-label': 'More' })];
      replaceKids(dropEl,
        h('div', { class: 'm-row' }, icon('gift', 'ic big'), h('span', { class: 'grow' }, h('b', null, pack.labels.goal), h('small', null, `${s.meters.goal} of ${s.meters.goalMax}`)),
          g ? pm((d) => dispatch({ t: 'guide', op: { k: 'meter', meter: 'goal', delta: d } })) : null),
        h('div', { class: 'm-row' }, h('span', { class: 'ic big', html: clockSvg(mi.m) }),
          h('span', { class: 'grow' }, h('b', null, pack.labels.clock), h('small', null, mi.leftMs <= 0 ? 'It’s midnight!' : `${Math.floor(mi.m)} of 12 · ${mi.label} left${mi.paused ? ' · paused' : ''}`)),
          g ? pm((d) => dispatch({ t: 'guide', op: { k: 'clock', op: 'step', delta: d } })) : null),
        h('div', { class: 'm-row' }, icon('twinkle', 'ic big'), h('span', { class: 'grow' }, h('b', null, pack.labels.sparks), h('small', null, String(s.meters.sparks))),
          g ? pm((d) => dispatch({ t: 'guide', op: { k: 'meter', meter: 'sparks', delta: d } })) : null));
      return;
    }
    if (!menuOpen) return;
    const k = `menu:${guide()}:${sayOpen}:${settingsOpen}:${helpOpen}:${JSON.stringify(s.settings)}:${s.clock.runningSince === null}:${prefs.muted}:${s.phase}:${build.on}`;
    if (!force && k === dropKey) return;
    dropKey = k;
    const g = guide();
    const item = (ic: string, label: string, fn: () => void, cls = '') => btn([icon(ic), h('span', null, label)], fn, 'menu-item ' + cls);
    const parts: (HTMLElement | null)[] = [];
    if (g) {
      const paused = s.clock.runningSince === null;
      parts.push(h('p', { class: 'menu-h' }, icon('guide'), pack.labels.guide || 'Guide'));
      parts.push(h('div', { class: 'menu-grid' },
        item('say', 'Say…', () => { sayOpen = !sayOpen; settingsOpen = false; paintDrop(true); }, sayOpen ? 'on' : ''),
        item('card', 'Flip event', () => { closeMenus(); sfx.flip(); dispatch({ t: 'guide', op: { k: 'flipEvent' } }); }),
        item(paused ? 'play' : 'pause', paused ? `Resume ${pack.labels.clock}` : `Pause ${pack.labels.clock}`, () => { dispatch({ t: 'guide', op: { k: 'clock', op: paused ? 'resume' : 'pause' } }); }),
        item('camera', 'Call cameras here', () => { closeMenus(); dispatch({ t: 'guide', op: { k: 'camera', at: viewCentre() } }); toast('Everyone’s looking here now', 'good'); }),
        item('next', s.phase === 'sceneEnd' ? 'Next scene' : 'Next', () => { closeMenus(); dispatch({ t: 'next' }); }),
        item('gear', 'Settings', () => { settingsOpen = !settingsOpen; sayOpen = false; paintDrop(true); }, settingsOpen ? 'on' : ''),
        item('flag', 'Scene won', () => { closeMenus(); dispatch({ t: 'guide', op: { k: 'endScene', result: 'won' } }); }, 'good'),
        item('flag', 'Scene lost', () => { closeMenus(); dispatch({ t: 'guide', op: { k: 'endScene', result: 'lost' } }); }, 'bad')));
      if (store.isHost() || s.players.find((p) => p.id === me)?.host) parts.push(h('div', { class: 'menu-grid' },
        item('build', build.on ? 'Stop building' : 'Build the scene', () => { closeMenus(); build.toggle(); }, build.on ? 'on' : ''),
        item('book', 'Save to my adventures', () => {
          closeMenus();
          if (s.adv && saveAdventure(s.adv)) toast(`Saved “${s.adv.name}” on this device`, 'good'); else toast('Could not save', 'error');
        })));
      if (sayOpen) parts.push(sayForm());
      if (settingsOpen) parts.push(settingsForm());
      parts.push(h('hr'));
    }
    parts.push(
      item('help', 'How to play', () => { helpOpen = !helpOpen; paintDrop(true); }, helpOpen ? 'on' : ''),
      helpOpen ? howTo() : null,
      item(prefs.muted ? 'mute' : 'sound', prefs.muted ? 'Sound is off' : 'Sound is on', () => { setMuted(!prefs.muted); paintDrop(true); }),
      item('leave', 'Leave the table', twoTap(() => { closeMenus(); ctx.leave(); }, 'Tap “Leave” again to leave', (m) => toast(m)), 'danger'));
    replaceKids(dropEl, ...parts);
  }

  function sayForm(): HTMLElement {
    const sel = h('select', { class: 'small', 'aria-label': 'Who says it' },
      h('option', { value: '' }, 'Narrator (paper note)'),
      s.heroes.map((x) => h('option', { value: x.id, selected: x.id === lastThing }, x.name)),
      s.foes.filter((f) => !f.down).map((f) => h('option', { value: f.uid, selected: f.uid === lastThing }, thingName(pack, s, f.uid))));
    const txt = h('input', { class: 'say-in', placeholder: 'What do they say?', maxlength: '160', enterkeyhint: 'send', 'aria-label': 'Line to say' });
    const go = () => {
      const text = txt.value.trim();
      if (!text) { txt.focus(); return; }
      dispatch({ t: 'guide', op: { k: 'say', text, who: sel.value || undefined } });
      txt.value = ''; sayOpen = false; closeMenus();
    };
    txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => txt.focus(), 50);
    return h('div', { class: 'menu-form' }, sel, txt, btn('Say it', go, 'primary small'));
  }

  function settingsForm(): HTMLElement {
    const st = s.settings;
    const patch = (p: Partial<typeof st>) => dispatch({ t: 'settings', patch: p });
    const seg = (label: string, sub: string, on: boolean, fn: () => void) =>
      h('button', { type: 'button', class: 'seg-btn' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: fn }, h('b', null, label), h('small', null, sub));
    const toggle = (label: string, sub: string, on: boolean, fn: (v: boolean) => void) => h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => fn((e.target as HTMLInputElement).checked) }),
      h('span', { class: 'switch' }), h('span', null, h('b', null, label), h('small', null, sub)));
    return h('div', { class: 'menu-form' },
      h('span', { class: 'lbl' }, 'Dice'),
      h('div', { class: 'seg seg3' },
        seg('Target', 'pick, then flick', st.diceMode === 'target', () => patch({ diceMode: 'target' })),
        seg('Throw at', 'it hits what it lands by', st.diceMode === 'throwAt', () => patch({ diceMode: 'throwAt' })),
        seg('Free', 'you apply results', st.diceMode === 'free', () => patch({ diceMode: 'free' }))),
      toggle('Kid mode', 'pictures instead of numbers', st.kidMode, (v) => patch({ kidMode: v })),
      toggle('Read aloud', 'story lines are spoken on this device', st.readAloud, (v) => { patch({ readAloud: v }); if (!v) stopSpeaking(); }),
      h('div', { class: 'm-row' }, icon('clock', 'ic big'), h('span', { class: 'grow' }, h('b', null, 'Adventure length'), h('small', null, `${st.minutes} minutes`)),
        btn('−', () => patch({ minutes: Math.max(10, st.minutes - 5) }), 'icon small round', { 'aria-label': 'Shorter' }),
        btn('+', () => patch({ minutes: Math.min(120, st.minutes + 5) }), 'icon small round', { 'aria-label': 'Longer' })));
  }

  function howTo(): HTMLElement {
    const L = pack.labels, T = L.traits;
    return h('div', { class: 'howto' },
      h('p', null, h('b', null, 'Move:'), ' tap your hero, then tap the ground.'),
      h('p', null, h('b', null, 'Attack:'), ` tap a foe, then flick the dice up. Uses ${T.brave}.`),
      h('p', null, h('b', null, 'Heal:'), ` tap a hurt friend (or hold your hero). Uses ${T.kind}.`),
      h('p', null, h('b', null, 'Search / use items:'), ` uses ${T.clever}.`),
      h('p', null, h('b', null, 'Rolls:'), ` 2 dice + the trait. ${STRONG}+ strong hit (2 damage) · ${HIT}–${STRONG - 1} hit (1 damage) · ${HIT - 1} or less miss — the foe hits back (−1 ${L.hearts}) and the team gets +1 ${L.sparks}.`),
      h('p', null, h('b', null, L.hearts + ':'), ` everyone has them. A foe at 0 is ${L.down}. A hero at 0 is ${L.tuckered} until a friend taps them to wake them.`),
      h('p', null, h('b', null, 'Special move'), ' (✦ button by your hero): once per scene, no dice.'),
      h('p', null, h('b', null, L.sparks + ':'), ' spend one to reroll or add +2.'),
      h('p', null, h('b', null, 'Hold'), ' anything for more choices. Tap your own hero again to see their card.'),
      h('p', null, 'Find the ', L.goal.toLowerCase(), ' before ', L.clock, '!'));
  }

  /** The table point under the middle of the visible screen (Newton steps on worldToScreen). */
  function viewCentre(): P {
    const top = strip.getBoundingClientRect().bottom;
    const W = innerWidth / 2, H = (innerHeight + top) / 2;
    const sel = hero(s, selected ?? undefined);
    let p: P = sel ? { ...sel.pos } : { x: 0, z: 0 };
    try {
      for (let i = 0; i < 10; i++) {
        const a = scene.worldToScreen(p, 0);
        const ex = a.x - W, ey = a.y - H;
        if (!isFinite(ex) || !isFinite(ey)) break;
        if (Math.hypot(ex, ey) < 2) break;
        const d = 0.05;
        const bx = scene.worldToScreen({ x: p.x + d, z: p.z }, 0), bz = scene.worldToScreen({ x: p.x, z: p.z + d }, 0);
        const j11 = (bx.x - a.x) / d, j12 = (bz.x - a.x) / d, j21 = (bx.y - a.y) / d, j22 = (bz.y - a.y) / d;
        const det = j11 * j22 - j12 * j21;
        if (!det || !isFinite(det)) break;
        let dx = -(j22 * ex - j12 * ey) / det, dz = -(-j21 * ex + j11 * ey) / det;
        const len = Math.hypot(dx, dz);
        if (len > 8) { dx *= 8 / len; dz *= 8 / len; }
        p = { x: p.x + dx, z: p.z + dz };
      }
    } catch { /* keep the best guess */ }
    const sc = sceneDef(pack, s);
    const hw = (sc?.size?.w ?? 20) / 2, hd = (sc?.size?.d ?? 20) / 2;
    return { x: +Math.max(-hw, Math.min(hw, p.x)).toFixed(2), z: +Math.max(-hd, Math.min(hd, p.z)).toFixed(2) };
  }

  // ---------------------------------------------------------------- dice + roll card
  function rollBonus(r: Roll) {
    const x = hero(s, r.heroId);
    return (x?.traits[r.trait] ?? 0) + (r.help ?? 0);
  }
  function purposeLabel(r: Roll): string {
    const p = r.purpose;
    switch (p.kind) {
      case 'attack': return `Attack ${thingName(pack, s, p.foeUid) || 'it'}`;
      case 'heal': return `Heal ${hero(s, p.heroId)?.name ?? 'a friend'}`;
      case 'search': return 'Search';
      case 'challenge': return 'Challenge';
      case 'item': return pack.items.find((i) => i.id === p.item)?.name ?? 'Use';
      default: return p.text || 'Free roll';
    }
  }
  function syncDice() {
    const r = s.roll;
    let want: string | null = null;
    if (s.phase === 'play' && r) {
      if (r.stage === 'ready' && r.thrower === me) want = `${r.id}:${r.trait}:${r.help}`;
      else if (r.stage === 'thrown' && reroll === r.id) want = `${r.id}:reroll:${r.sparkUsed.length}`;
    }
    if (r?.id !== reroll && r?.stage !== 'thrown') reroll = null;
    // thrown dice stay on the table until the roll is resolved
    if (!want && r && r.stage === 'thrown' && armedKey?.startsWith(r.id + ':')) return;
    if (want === armedKey) return;
    if (want && r) {
      armedKey = want;
      safe(() => scene.armDice(r.id, reroll === r.id ? `${traitName(pack, r.trait)} · again` : traitName(pack, r.trait), rollBonus(r)), undefined);
    } else if (armedKey) {
      armedKey = null;
      safe(() => scene.disarmDice(), undefined);
    }
  }

  let rollKey = '';
    function paintRoll() {
    const r = s.roll;
    const g = guide();
    if (!r || s.phase !== 'play' || r.stage === 'done') { if (rollKey) { rollKey = ''; rollBox.replaceChildren(); } return; }
    const key = JSON.stringify([r, s.meters.sparks, reroll, g, s.settings.kidMode, safe(() => rules.stakes(s, pack), null)]);
    if (key === rollKey) return;
    rollKey = key;
    const x = hero(s, r.heroId);
    const kid = s.settings.kidMode;
    const canAct = g || r.thrower === me || mine().includes(r.heroId);
    const throwerName = s.players.find((p) => p.id === r.thrower)?.name ?? x?.name ?? 'someone';
    const st = safe(() => rules.stakes(s, pack), null);
    const MARK: Record<string, string> = { strong: '✓✓', success: '✓', trouble: '✗' };
    const stakesList = (only?: string) => st ? h('ul', { class: 'rc-stakes' + (only ? ' one' : '') },
      st.bands.filter((b) => !only || b.k === only).map((b) => h('li', { class: 'o-' + b.k },
        h('span', { class: 'rc-band' }, only ? '→' : `${MARK[b.k]} ${b.range}`), h('span', null, b.text)))) : null;
    const head = h('div', { class: 'rc-head' },
      x ? avatar(pack, x.roleId, heroColor(s, x), 'avatar tiny') : icon('dice'),
      h('span', { class: 'grow' }, h('b', null, x?.name ?? 'Roll'), h('small', null, ' · ', purposeLabel(r))),
      (canAct && r.stage === 'ready') ? h('button', { type: 'button', class: 'rc-x', 'aria-label': 'Cancel the roll', onclick: () => dispatch({ t: 'cancelRoll', rollId: r.id }) }, icon('close')) : null);
    const helpCtl = g ? h('span', { class: 'rc-help' },
      btn('−', () => dispatch({ t: 'guide', op: { k: 'help', rollId: r.id, delta: -1 } }), 'icon small round', { disabled: r.help <= 0, 'aria-label': 'Less help' }),
      h('span', null, icon('hand'), `+${r.help}`),
      btn('+', () => dispatch({ t: 'guide', op: { k: 'help', rollId: r.id, delta: 1 } }), 'icon small round', { disabled: r.help >= 2, 'aria-label': 'More help' }))
      : r.help ? h('span', { class: 'rc-help' }, icon('hand'), `+${r.help} help`) : null;

    if (r.stage === 'ready') {
      // only a free roll lets you pick the trait; everything else always uses the same one
      const traits = r.purpose.kind === 'free'
        ? h('div', { class: 'rc-traits' }, TRAITS.map((t: Trait) => h('button', {
          type: 'button', class: 'chip t-' + t + (r.trait === t ? ' on' : ''), disabled: !canAct, 'aria-pressed': String(r.trait === t),
          title: `${traitName(pack, t)}: ${TRAIT_HELP[t]}`,
          onclick: () => { if (r.trait !== t) { sfx.tap(); dispatch({ t: 'setRollTrait', rollId: r.id, trait: t }); } },
        }, icon(t), h('span', { class: 'rc-tn' }, traitName(pack, t)), kid ? null : h('b', null, '+' + String(x?.traits[t] ?? 0)))))
        : h('span', { class: 'rc-trait t-' + r.trait }, icon(r.trait), h('b', null, traitName(pack, r.trait)), kid ? null : ` +${x?.traits[r.trait] ?? 0}`);
      const how = h('p', { class: 'rc-how' }, `Roll 2 dice + ${traitName(pack, r.trait)}`, r.help ? ` + ${r.help} help` : '');
      rollBox.replaceChildren(h('div', { class: 'roll-card paper ready' }, head, h('div', { class: 'rc-row' }, traits, helpCtl), how, stakesList(),
        h('p', { class: 'rc-hint' }, r.thrower === me ? h('b', null, 'Flick the dice up to throw!') : `Waiting for ${throwerName} to throw…`)));
      return;
    }

    // thrown
    if (reroll === r.id) {
      rollBox.replaceChildren(h('div', { class: 'roll-card paper ready' }, head, h('p', { class: 'rc-hint' }, h('b', null, 'Flick the dice again!')),
        btn('Never mind', () => { reroll = null; syncDice(); paintRoll(); }, 'ghost small')));
      return;
    }
    const o = r.outcome ?? 'success';
    const WORD = r.purpose.kind === 'attack' || r.purpose.kind === 'item' ? HIT_WORD : PLAIN_WORD;
    const d = r.dice ?? [0, 0];
    const bonus = (r.total ?? d[0] + d[1]) - d[0] - d[1];
    const sum = kid ? h('span', { class: 'rc-dice' }, pips(d[0]), pips(d[1]))
      : h('span', { class: 'rc-sum' }, `${d[0]} + ${d[1]}${bonus ? ` + ${bonus}` : ''} = `, h('b', null, String(r.total ?? d[0] + d[1])));
    const used = new Set(r.sparkUsed ?? []);
    const sparks = s.meters.sparks;
    const tw: HTMLElement[] = [];
    if (canAct && sparks > 0) {
      if (!used.has('reroll')) tw.push(btn([icon('dice'), 'Reroll'], () => { sfx.twinkle(); reroll = r.id; syncDice(); paintRoll(); }, 'spark small'));
      if (!used.has('plus2') && o !== 'strong') tw.push(btn([icon('twinkle'), '+2'], () => { sfx.twinkle(); dispatch({ t: 'spark', rollId: r.id, use: 'plus2' }); }, 'spark small'));
    }
    const guideRow = g ? h('div', { class: 'rc-guide' },
      h('div', { class: 'rc-out' }, (['strong', 'success', 'trouble'] as const).map((k) => h('button', {
        type: 'button', class: 'chip o-' + k + (o === k ? ' on' : ''), 'aria-pressed': String(o === k), title: WORD[k],
        onclick: () => { if (o !== k) dispatch({ t: 'guide', op: { k: 'outcome', rollId: r.id, outcome: k } }); },
      }, MARK[k]))),
      helpCtl) : null;
    rollBox.replaceChildren(h('div', { class: 'roll-card paper thrown o-' + o },
      head,
      h('div', { class: 'rc-result' }, h('b', { class: 'rc-word' }, WORD[o] ?? o), sum),
      stakesList(o),
      tw.length ? h('div', { class: 'rc-sparks' }, h('span', { class: 'rc-jar' }, icon('twinkle'), String(sparks)), ...tw) : null,
      guideRow,
      canAct ? btn('OK', () => { sfx.tap(); dispatch({ t: 'resolve', rollId: r.id }); }, 'primary rc-ok') : h('p', { class: 'rc-hint' }, `${throwerName} is deciding…`)));
  }
  function pips(n: number): HTMLElement {
    const on: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    const d = h('span', { class: 'die', 'aria-label': String(n) });
    for (let i = 0; i < 9; i++) d.appendChild(h('i', { class: on[n]?.includes(i) ? 'on' : '' }));
    return d;
  }

  // ---------------------------------------------------------------- notes: intro Begin, scene end, choices
  let noteKey = '';
  function paintNotes() {
    const g = guide();
    const c = s.choice;
    const key = `${s.phase}:${s.scene.index}:${s.scene.result}:${g}:${c?.id ?? ''}:${mine().join()}`;
    if (key === noteKey) return;
    noteKey = key;
    const sc = sceneDef(pack, s);
    const parts: HTMLElement[] = [];
    if (s.phase === 'intro' && g) {
      parts.push(h('div', { class: 'begin-box' },
        h('small', null, sc?.name ?? ''),
        btn('Begin', () => { sfx.chime(); dispatch({ t: 'beginScene' }); }, 'primary big begin')));
    }
    if (s.phase === 'sceneEnd') {
      const won = s.scene.result !== 'lost';
      const text = (won ? sc?.win : sc?.lose) || (won ? 'Well done, heroes!' : 'Not this time — but the night goes on!');
      parts.push(h('div', { class: 'note-card paper ' + (won ? 'won' : 'lost') },
        h('p', { class: 'kicker' }, won ? 'Scene complete!' : 'Phew…'),
        h('p', { class: 'prose' }, text),
        g ? btn('Next', () => { sfx.tap(); dispatch({ t: 'next' }); }, 'primary') : null));
    }
    if (c && s.phase === 'play') {
      const can = g || mine().includes(c.heroId);
      parts.push(h('div', { class: 'note-card paper' },
        h('p', { class: 'prose' }, c.prompt),
        can ? h('div', { class: 'choice-list' }, c.options.map((o) => btn(o.label, () => { sfx.tap(); dispatch({ t: 'choose', choiceId: c.id, value: o.value }); }, '')))
          : h('p', { class: 'waiting' }, `${hero(s, c.heroId)?.name ?? 'A hero'} is choosing…`)));
    }
    noteBox.replaceChildren(...parts);
  }

  // ---------------------------------------------------------------- table moments + ending (full screen)
  let moment: ReturnType<typeof momentView> | null = null;
  let ending: ReturnType<typeof endingScreen> | null = null;
  function paintOverlay(prev: GameState | null) {
    if (s.phase === 'tableMoment') {
      if (!moment) { moment = momentView(ctx); overlay.replaceChildren(moment.el); }
      moment.update(s, prev);
    } else if (moment) { moment.destroy(); moment = null; overlay.replaceChildren(); }
    if (s.phase === 'ending') {
      if (!ending) { ending = endingScreen(ctx); overlay.replaceChildren(ending.el); }
      ending.update(s);
    } else if (ending) { ending = null; if (!moment) overlay.replaceChildren(); }
  }

  // ---------------------------------------------------------------- read-aloud (Guide's device only)
  function readAloud(prev: GameState | null) {
    const on = s.settings.readAloud && guide();
    const lines: string[] = [];
    const seen = (id: string) => { if (spoken.has(id)) return true; spoken.add(id); return false; };
    if (s.phase === 'intro' && lastPhase !== 'intro') {
      const sc = sceneDef(pack, s);
      if (sc && !seen('intro:' + s.scene.index)) { lines.push(sc.intro); if (sc.goal?.text) lines.push(sc.goal.text); }
    }
    if (s.event && !seen('event:' + s.event.id + ':' + s.event.at)) lines.push(`${s.event.name}. ${s.event.text}`);
    for (const b of s.bubbles ?? []) {
      if ((b.kind === 'story' || b.kind === 'event') && !seen('b:' + b.id)) lines.push(b.text);
    }
    if (on && primed && prev !== s) for (const l of lines) if (!spoken.has('t:' + l)) { spoken.add('t:' + l); speakQueued(l); }
    primed = true;
  }

  // ---------------------------------------------------------------- update
  function update(next: GameState, prev: GameState | null) {
    s = next;
    const tick = prev === next;
    if (!tick) {
      // selection must stay one of mine
      const ctl = mine();
      if (selected && !ctl.includes(selected)) selected = null;
      if (!selected && s.phase === 'play' && lastPhase !== 'play' && ctl.length === 1 && !guide()) selected = ctl[0];
      if (s.phase !== 'play') { leavePick(); closeRing(); }
      pushLocal();
      // camera calls: glide there (the scene may do this too; focusing twice is harmless)
      if (s.cameraCall && s.cameraCall.seq !== lastCameraSeq) {
        lastCameraSeq = s.cameraCall.seq;
        if (!guide()) safe(() => scene.focus(s.cameraCall!.at), undefined);
      }
      // outcome sounds
      const st = s.roll ? `${s.roll.id}:${s.roll.stage}:${s.roll.outcome}` : '';
      if (st !== lastRollStage && s.roll?.stage === 'thrown') {
        if (s.roll.outcome === 'trouble') sfx.oops(); else sfx.chime();
      }
      lastRollStage = st;
      readAloud(prev);
      syncDice();
      paintNotes();
      paintOverlay(prev);
    }
    build.update(s);
    paintStrip();
    paintRoll();
    paintHeroChip();
    if (!tick && sheetFor) { if (s.phase === 'play' && hero(s, sheetFor)) openSheet(sheetFor); else closeSheet(); }
    paintDrop();
    lastPhase = s.phase;
  }

  paintNet();
  update(s, null);

  return {
    el,
    update,
    callbacks: { onTap, onHold, canDrag, onDrag, onDiceThrown },
    destroy() {
      offEph(); offStatus(); ro.disconnect(); dro.disconnect(); build.destroy();
      removeEventListener('online', onLineChange); removeEventListener('offline', onLineChange);
      clearTimeout(previewTimer); clearTimeout(dragTimer);
      closeInspect(); closeRing(); closeSheet(); sayEl?.remove();
      moment?.destroy();
      if (armedKey) safe(() => scene.disarmDice(), undefined);
    },
  };
}

export type PlayScreen = ReturnType<typeof playScreen>;
