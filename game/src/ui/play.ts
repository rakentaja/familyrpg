// Play HUD: top bar (meters + hero chips), bottom sheet for the active hero, board interactions,
// plus the phase overlays (intro, roll, event, choice, scene end, table moment, ending) and the Guide panel.
import type { ActionOption, GameState, Hero, TargetRef, Vec, Action, Trait } from '../engine/types';
import type { Ctx } from './ctx';
import * as engine from '../engine';
import { h, btn, onSwipe, reducedMotion, replaceKids } from './dom';
import { icon } from './icons';
import {
  avatar, hearts, hero, heroColor, isGuide, role, safe, sameCell, targetCell, targetLabel, traitName, TRAITS,
  foeDef, itemDef, sceneDef, traitBadge, tokenName,
} from './common';
import { sfx, buzz, toast, readAloud, prefs, setMuted, speak } from './feedback';
import { rollModal } from './roll';
import { introCard, sceneEndCard, eventCard, choiceCard, endingCard } from './cards';
import { guidePanel } from './guide';
import { momentView } from './moments';
import { cacheAllForOffline, offlineStatus } from './pwa';

type Mode =
  | { k: 'none' }
  | { k: 'move'; heroId: string; reach: { cell: Vec; path: Vec[] }[] }
  | { k: 'target'; heroId: string; opt: ActionOption }
  | { k: 'gFoe'; uid: string }
  | { k: 'gSpawn'; foe: string };

export function playScreen(ctx: Ctx) {
  const store = ctx.store!;
  const { pack, board } = ctx;
  const me = () => store.me;

  let s: GameState = store.state!;
  let selected: string | undefined;
  let mode: Mode = { k: 'none' };
  let expanded = false;
  let hlKey = '';
  let lastEventKey = s.event ? `${s.event.id}:${s.event.round}` : '';
  let overlayKey = '';
  let eventOpen = false;

  // ---------------------------------------------------------------- top bar
  const goalBox = h('div', { class: 'meter goal', role: 'group' });
  const clockBox = h('div', { class: 'meter clock', role: 'group' });
  const sparkBox = h('div', { class: 'meter sparks', role: 'group' });
  const chips = h('div', { class: 'chips-row', role: 'list' });
  const statusPill = h('span', { class: 'net-pill', hidden: true });
  const menuBtn = btn(icon('menu'), () => toggleMenu(), 'icon', { 'aria-label': 'Menu' });
  const guideBtn = btn([icon('guide'), h('span', null, 'Guide')], () => guide.open(), 'guide-fab', { hidden: true });
  const top = h('header', { class: 'topbar' },
    h('div', { class: 'meters' }, menuBtn, goalBox, clockBox, sparkBox, statusPill),
    chips);

  // ---------------------------------------------------------------- bottom sheet
  const sheetHead = h('div', { class: 'sheet-head' });
  const hint = h('div', { class: 'hint-line', 'aria-live': 'polite' });
  const actions = h('div', { class: 'actions' });
  const more = h('div', { class: 'more' });
  const grip = h('button', { type: 'button', class: 'grip', 'aria-label': 'Show more', onclick: () => setExpanded(!expanded) });
  const sheet = h('section', { class: 'sheet', 'aria-label': 'Your hero' }, grip, sheetHead, hint, actions, more);
  onSwipe(sheet, (dir) => {
    if (dir === 'up') setExpanded(true);
    else if (dir === 'down') setExpanded(false);
    else if (dir === 'left') cycleHero(1);
    else if (dir === 'right') cycleHero(-1);
  });
  function setExpanded(v: boolean) { expanded = v; sheet.classList.toggle('expanded', v); grip.setAttribute('aria-label', v ? 'Show less' : 'Show more'); renderSheet(); }

  // ---------------------------------------------------------------- overlays
  const overlay = h('div', { class: 'overlay-layer' });
  const roll = rollModal(ctx);
  const moment = momentView(ctx);
  const guide = guidePanel(ctx, {
    pickFoeMove(uid) { mode = { k: 'gFoe', uid }; toast('Tap a square to move it there'); refresh(); },
    pickSpawn(foe) { mode = { k: 'gSpawn', foe }; toast('Tap a square to place it'); refresh(); },
  });
  const menu = h('div', { class: 'drawer menu', hidden: true });
  const el = h('div', { class: 'play' }, top, guideBtn, sheet, overlay, roll.el, guide.el, menu);

  // frame the board in the strip between the top bar and the (collapsed) sheet
  const syncInsets = () => {
    if (expanded) return;
    const t = top.getBoundingClientRect(), b = sheet.getBoundingClientRect();
    if (!t.height && !b.height) return;
    safe(() => board.setInsets?.(t.bottom, Math.max(0, innerHeight - b.top)), undefined);
  };
  const insetRO = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => syncInsets()) : null;
  insetRO?.observe(top); insetRO?.observe(sheet);
  requestAnimationFrame(syncInsets);

  const offStatus = store.net.onStatus((st) => {
    statusPill.hidden = store.role === 'local' || st === 'online';
    statusPill.textContent = st === 'connecting' ? 'Reconnecting…' : 'Offline';
  });

  // ---------------------------------------------------------------- helpers
  const controlled = () => safe(() => engine.controlled(s, me()), [] as string[]);
  const guideMe = () => isGuide(s, me());
  const selHero = () => hero(s, selected);

  function pickDefault() {
    const mine = controlled();
    if (selected && mine.includes(selected)) return;
    const active = s.turn.active;
    selected = (active && mine.includes(active) ? active : undefined)
      ?? mine.find((id) => { const x = hero(s, id); return x && !x.done && !x.tuckered; })
      ?? mine[0];
  }

  function cycleHero(d: number) {
    const mine = controlled();
    if (mine.length < 2) return;
    const i = Math.max(0, mine.indexOf(selected ?? ''));
    selectHero(mine[(i + d + mine.length) % mine.length], true);
  }

  function selectHero(id: string, focus: boolean) {
    if (selected !== id) sfx.tap();
    selected = id;
    mode = { k: 'none' };
    const x = hero(s, id);
    if (focus && x) board.focus({ heroId: id });
    // make it the acting hero when it's free to act and nobody else is mid-turn
    if (x && s.phase === 'play' && s.turn.stage === 'heroes' && !x.done && !x.tuckered && s.turn.active !== id && !s.pending && !s.choice) {
      const act = hero(s, s.turn.active);
      if (!act || act.done || controlled().includes(act.id)) store.dispatch({ t: 'select', heroId: id });
    }
    refresh();
  }

  function canAct(x: Hero | undefined) {
    return !!x && s.phase === 'play' && s.turn.stage === 'heroes' && !x.done && !x.tuckered && !s.pending && !s.choice && controlled().includes(x.id);
  }

  function hintText(): string {
    const x = selHero();
    if (s.phase !== 'play') return '';
    if (mode.k === 'target') return `Tap a glowing ${needsWord(mode.opt)} for “${mode.opt.label}”`;
    if (mode.k === 'gFoe') return 'Guide: tap a square to move the foe';
    if (mode.k === 'gSpawn') return 'Guide: tap a square to add the foe';
    if (s.pending) return 'Dice time!';
    if (s.turn.stage === 'foes') return `The ${pack.labels.foes?.toLowerCase() || 'foes'} are taking their turn…`;
    if (s.turn.stage === 'event') return 'Flipping an event card…';
    if (!x) return guideMe() ? 'You are the Guide. Tell the story and open the Guide panel to run the foes.' : 'Watch the board — your friends are playing!';
    if (x.tuckered) return `Zzz… ${x.name} is ${pack.labels.tuckered?.toLowerCase() || 'tuckered out'}. A friend next to you can wake you up.`;
    if (x.done) return `${x.name} is done this round. ✓`;
    if (s.turn.active && s.turn.active !== x.id && !controlled().includes(s.turn.active)) {
      const a = hero(s, s.turn.active);
      if (a && !a.done) return `${a.name} is taking a turn…`;
    }
    if (mode.k === 'move' && mode.reach.length && !x.acted) return 'Tap a glowing square to walk, or pick something to do.';
    if (mode.k === 'move' && mode.reach.length) return 'You can still walk. Then tap End turn.';
    if (!x.acted) return 'Pick something to do!';
    return 'All done? Tap End turn.';
  }
  const needsWord = (o: ActionOption) => o.needs === 'foe' ? 'foe' : o.needs === 'hero' ? 'friend' : o.needs === 'token' ? 'thing' : 'square';

  const OPT_ICONS: Record<string, string> = {
    calm: 'kind', challenge: 'brave', jump: 'boot', revive: 'heart', goal: 'gift', item: 'pocket', star: 'star', clue: 'log', npc: 'kind',
    knack: 'sparkle', search: 'clever', free: 'dice', give: 'gift', end: 'check', help: 'kind', exit: 'walk',
  };
  const optIcon = (name?: string) => (name && OPT_ICONS[name]) || name || 'sparkle';

  // ---------------------------------------------------------------- highlights
  function refreshHighlights() {
    let cells: Vec[] = [];
    let kind: 'move' | 'target' | 'danger' | 'path' = 'move';
    if (mode.k === 'target') {
      cells = (mode.opt.targets ?? []).map((t) => targetCell(s, t)).filter(Boolean) as Vec[]; kind = 'target';
    } else if (mode.k === 'gFoe') {
      const uid = mode.uid; const f = s.foes.find((x) => x.uid === uid); cells = f ? [f.pos] : []; kind = 'danger';
    } else if (mode.k === 'move') {
      cells = mode.reach.map((r) => r.cell); kind = 'move';
    }
    const key = kind + ':' + cells.map((c) => c.x + ',' + c.y).join(';');
    if (key === hlKey) return;
    hlKey = key;
    safe(() => board.highlight(cells, kind), undefined);
  }

  function computeMode() {
    if (mode.k === 'target' || mode.k === 'gFoe' || mode.k === 'gSpawn') {
      if (s.phase !== 'play') mode = { k: 'none' };
      if (mode.k === 'target' && !canAct(hero(s, mode.heroId))) mode = { k: 'none' };
      if (mode.k !== 'none') return;
    }
    const x = selHero();
    if (canAct(x) && x!.moveLeft > 0) {
      const reach = safe(() => engine.reachable(s, x!.id, pack), [] as { cell: Vec; path: Vec[] }[]).filter((r) => !sameCell(r.cell, x!.pos));
      mode = { k: 'move', heroId: x!.id, reach };
    } else mode = { k: 'none' };
  }

  // ---------------------------------------------------------------- dispatching actions
  function runOption(heroId: string, o: ActionOption) {
    sfx.tap();
    if (o.needs && o.needs !== 'none' && !o.action) {
      const targets = o.targets ?? [];
      if (!targets.length && o.needs !== 'cell') { toast('Nothing in reach for that right now'); return; }
      mode = { k: 'target', heroId, opt: o };
      refresh();
      return;
    }
    if (o.kind === 'end' || o.action?.t === 'endTurn') { endTurn(heroId); return; }
    if (o.action) send(heroId, o.action);
  }

  function chooseTarget(t: TargetRef) {
    if (mode.k !== 'target') return;
    const { heroId, opt } = mode;
    const a = safe(() => engine.buildAction(s, heroId, opt, t, pack), null);
    mode = { k: 'none' };
    if (!a) { toast('That won’t work there', 'error'); refresh(); return; }
    send(heroId, a);
  }

  function send(heroId: string, a: Action) {
    if (a.t === 'startRoll') { pickTrait(heroId, a); return; }
    store.dispatch(a);
  }

  /** Before a roll: let the player confirm or change the trait (the suggested one glows). */
  function pickTrait(heroId: string, a: Extract<Action, { t: 'startRoll' }>) {
    const x = hero(s, heroId);
    const close = () => wrap.remove();
    const go = (t: Trait) => { close(); sfx.tap(); store.dispatch({ ...a, trait: t }); };
    const wrap = h('div', { class: 'modal trait-pick', role: 'dialog', 'aria-label': 'How do you do it?' },
      h('div', { class: 'card' },
        h('header', { class: 'card-head' }, h('h2', null, 'How do you do it?'), btn(icon('close'), close, 'icon', { 'aria-label': 'Cancel' })),
        h('p', { class: 'hint' }, 'Tell everyone how you try — then pick the one that fits best.'),
        h('div', { class: 'trait-choices' }, TRAITS.map((t) => btn(
          [icon(t, 'ic huge'), h('b', null, traitName(pack, t)), x && !s.kidMode ? h('small', null, `+${x.traits[t]}`) : x ? traitBadge(pack, t, x.traits[t], true) : null],
          () => go(t), 'trait-btn t-' + t + (t === a.trait ? ' suggested' : ''))))));
    overlay.appendChild(wrap);
  }

  function endTurn(heroId: string) {
    sfx.tap(); buzz(15);
    store.dispatch({ t: 'endTurn', heroId });
    mode = { k: 'none' };
  }

  // ---------------------------------------------------------------- board callbacks
  function onCellTap(cell: Vec) {
    if (s.phase !== 'play') return;
    if (mode.k === 'gFoe') { store.dispatch({ t: 'guide', op: { k: 'moveFoe', uid: mode.uid, to: cell } }); mode = { k: 'none' }; refresh(); return; }
    if (mode.k === 'gSpawn') { store.dispatch({ t: 'guide', op: { k: 'spawn', foe: mode.foe, at: cell } }); mode = { k: 'none' }; refresh(); return; }
    if (mode.k === 'target') {
      const t = (mode.opt.targets ?? []).find((t) => sameCell(targetCell(s, t), cell)) ?? (mode.opt.needs === 'cell' || mode.opt.needs === 'any' ? { cell } : undefined);
      if (t) chooseTarget(t); else toast('Tap one of the glowing squares');
      return;
    }
    if (mode.k === 'move') {
      const r = mode.reach.find((x) => sameCell(x.cell, cell));
      if (r) {
        sfx.step(); buzz(10);
        store.dispatch({ t: 'move', heroId: mode.heroId, to: cell });
        return;
      }
    }
    // anything else: tell them what's there
    const occupant = s.heroes.find((x) => sameCell(x.pos, cell));
    if (occupant) { onHeroTap(occupant.id); return; }
    const foe = s.foes.find((f) => sameCell(f.pos, cell));
    if (foe) { onFoeTap(foe.uid); return; }
    const txt = safe(() => engine.describeTile(s, cell, pack), '');
    if (txt) toast(txt, 'info', 2200);
  }
  function onHeroTap(id: string) {
    if (mode.k === 'target') {
      const t = (mode.opt.targets ?? []).find((t) => t.heroId === id) ?? (mode.opt.targets ?? []).find((t) => sameCell(targetCell(s, t), hero(s, id)?.pos));
      if (t) { chooseTarget(t); return; }
    }
    if (controlled().includes(id)) { selectHero(id, false); return; }
    const x = hero(s, id);
    if (x) toast(`${x.name} the ${role(pack, x.roleId)?.name ?? 'hero'} · ${pack.labels.hearts} ${x.hearts}/${x.maxHearts}${x.tuckered ? ' · zzz' : ''}`, 'info', 2400);
  }
  function onFoeTap(uid: string) {
    if (mode.k === 'target') {
      const f = s.foes.find((x) => x.uid === uid);
      const t = (mode.opt.targets ?? []).find((t) => t.foeUid === uid) ?? (f ? (mode.opt.targets ?? []).find((t) => sameCell(targetCell(s, t), f.pos)) : undefined);
      if (t) { chooseTarget(t); return; }
    }
    const f = s.foes.find((x) => x.uid === uid);
    if (!f) return;
    const d = foeDef(pack, f.foe);
    if (guideMe() && s.phase === 'play') { mode = { k: 'gFoe', uid }; refresh(); }
    showFoeCard(uid, d?.name ?? 'Foe', d?.blurb ?? '', f.grump, f.maxGrump, d?.weak);
  }
  function onTokenTap(uid: string) {
    if (mode.k === 'target') {
      const t = (mode.opt.targets ?? []).find((t) => t.tokenUid === uid);
      if (t) { chooseTarget(t); return; }
    }
    const k = s.tokens.find((x) => x.uid === uid);
    if (!k) return;
    const label = k.label || (k.item ? itemDef(pack, k.item)?.name : '') || tokenName(pack, k.kind);
    toast(k.text ? `${label}: ${k.text}` : label, 'info', 2600);
  }

  let foeCard: HTMLElement | null = null;
  function showFoeCard(uid: string, name: string, blurb: string, grump: number, max: number, weak?: Trait) {
    foeCard?.remove();
    const g = h('span', { class: 'grump' });
    for (let i = 0; i < max; i++) g.appendChild(h('i', { class: i < grump ? 'on' : '' }));
    foeCard = h('div', { class: 'foe-card paper', role: 'status' },
      h('div', { class: 'row' }, icon('foe', 'ic big'), h('div', null, h('b', null, name), h('div', { class: 'grump-row' }, h('small', null, 'Grump '), g)),
        btn(icon('close'), () => { foeCard?.remove(); foeCard = null; if (mode.k === 'gFoe') { mode = { k: 'none' }; refresh(); } }, 'icon small', { 'aria-label': 'Close' })),
      blurb ? h('p', null, blurb) : null,
      weak ? h('p', { class: 'weak' }, 'Try being ', icon(weak), h('b', null, traitName(pack, weak)), '!') : null,
      guideMe() ? h('div', { class: 'row wrap' },
        btn('− Grump', () => store.dispatch({ t: 'guide', op: { k: 'grump', uid, delta: -1 } }), 'small'),
        btn('+ Grump', () => store.dispatch({ t: 'guide', op: { k: 'grump', uid, delta: 1 } }), 'small'),
        h('span', { class: 'hint' }, 'or tap a square to move it')) : null);
    el.appendChild(foeCard);
    const mine = foeCard;
    setTimeout(() => { if (foeCard === mine && !guideMe()) { mine.remove(); foeCard = null; } }, 5000);
  }

  // ---------------------------------------------------------------- rendering
  function renderTop() {
    const m = s.meters;
    const kid = s.kidMode;
    // presents
    const gifts = h('span', { class: 'gifts' });
    for (let i = 0; i < m.goalMax; i++) gifts.appendChild(icon(i < m.goal ? 'gift' : 'giftEmpty'));
    goalBox.replaceChildren(gifts);
    goalBox.setAttribute('aria-label', `${pack.labels.goal}: ${m.goal} of ${m.goalMax}`);
    // midnight ring
    clockBox.replaceChildren(clockRing(m.clock, m.clockMax));
    clockBox.setAttribute('aria-label', `${pack.labels.clock}: ${m.clock} of ${m.clockMax}`);
    // twinkles
    sparkBox.replaceChildren(icon('twinkle'), h('b', null, kid && m.sparks <= 0 ? '' : String(m.sparks)));
    sparkBox.setAttribute('aria-label', `${pack.labels.sparks}: ${m.sparks}`);
    // hero chips
    const mine = controlled();
    chips.replaceChildren(...s.heroes.map((x) => {
      const c = h('button', {
        type: 'button', role: 'listitem',
        class: 'hchip' + (x.id === s.turn.active ? ' active' : '') + (x.id === selected ? ' sel' : '') + (x.tuckered ? ' tuckered' : '') + (x.done ? ' done' : '') + (mine.includes(x.id) ? ' mine' : ''),
        'aria-label': `${x.name}, ${x.hearts} ${pack.labels.hearts}${x.tuckered ? ', ' + pack.labels.tuckered : ''}${x.done ? ', done' : ''}`,
        onclick: () => { if (mine.includes(x.id)) selectHero(x.id, true); else { board.focus({ heroId: x.id }); onHeroTap(x.id); } },
      },
      avatar(pack, x.roleId, heroColor(s, x), 'avatar small'),
      h('span', { class: 'hchip-hearts' }, Array.from({ length: x.maxHearts }, (_, i) => h('i', { class: i < x.hearts ? 'on' : '' }))),
      x.tuckered ? icon('sleep', 'ic badge-ic') : x.done ? icon('check', 'ic badge-ic') : null);
      return c;
    }));
    guideBtn.hidden = !(guideMe() && s.phase === 'play');
  }

  function clockRing(n: number, max: number) {
    const R = 17, C = 22;
    let segs = '';
    for (let i = 0; i < max; i++) {
      const a0 = (i / max) * Math.PI * 2 - Math.PI / 2 + 0.06, a1 = ((i + 1) / max) * Math.PI * 2 - Math.PI / 2 - 0.06;
      const p = (a: number, r: number) => `${(C + Math.cos(a) * r).toFixed(2)} ${(C + Math.sin(a) * r).toFixed(2)}`;
      segs += `<path d="M${p(a0, R)} A${R} ${R} 0 0 1 ${p(a1, R)}" stroke="${i < n ? (n >= max - 2 ? '#a0494f' : '#2a2328') : '#cfc6b6'}" stroke-width="${i < n ? 6 : 4}" fill="none" stroke-linecap="butt"/>`;
    }
    const sp = h('span', { class: 'ring' });
    sp.innerHTML = `<svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">${segs}<circle cx="22" cy="22" r="10.5" fill="#f2eadb" stroke="#2a2328" stroke-width="1.6"/><path d="M22 22V15M22 22l4 2.5" stroke="#2a2328" stroke-width="1.8" stroke-linecap="round"/></svg>`;
    return sp;
  }

  function renderSheet() {
    const x = selHero();
    const mine = controlled();
    // header
    if (x) {
      const r = role(pack, x.roleId);
      sheetHead.replaceChildren(
        mine.length > 1 ? btn(icon('left'), () => cycleHero(-1), 'icon small hnav', { 'aria-label': 'Previous hero' }) : h('span', { class: 'nav-gap' }),
        h('div', { class: 'who', onclick: () => board.focus({ heroId: x.id }) },
          avatar(pack, x.roleId, heroColor(s, x)),
          h('div', { class: 'who-text' }, h('b', null, x.name), h('small', null, r?.name ?? ''), hearts(x.hearts, x.maxHearts))),
        h('div', { class: 'turn-info' },
          s.phase === 'play' && s.turn.stage === 'heroes' && !x.done && !x.tuckered
            ? h('span', { class: 'steps', title: 'Steps left' }, icon('boot'), s.kidMode ? null : h('b', null, String(x.moveLeft)))
            : null,
          x.acted ? h('span', { class: 'acted', title: 'Action used' }, icon('check')) : null),
        mine.length > 1 ? btn(icon('right'), () => cycleHero(1), 'icon small hnav', { 'aria-label': 'Next hero' }) : h('span', { class: 'nav-gap' }));
    } else {
      sheetHead.replaceChildren(h('div', { class: 'who' }, icon(guideMe() ? 'guide' : 'star', 'ic big'),
        h('div', { class: 'who-text' }, h('b', null, guideMe() ? 'You are the Guide' : 'Cheering on'), h('small', null, sceneDef(pack, s)?.name ?? ''))));
    }
    const ht = hintText();
    replaceKids(hint, h('span', null, ht), ht ? readAloud(() => ht) : null);

    // actions
    const acts: HTMLElement[] = [];
    if (mode.k === 'target') {
      const { opt } = mode;
      acts.push(...(opt.targets ?? []).map((t) => btn(targetLabel(pack, s, t), () => chooseTarget(t), 'target-btn')));
      acts.push(btn('Cancel', () => { mode = { k: 'none' }; refresh(); }, 'ghost'));
    } else if (mode.k === 'gFoe' || mode.k === 'gSpawn') {
      acts.push(btn('Cancel', () => { mode = { k: 'none' }; refresh(); }, 'ghost'));
    } else if (x && canAct(x)) {
      const opts = safe(() => engine.options(s, x.id, pack), [] as ActionOption[]);
      const ends = opts.filter((o) => o.kind === 'end');
      for (const o of opts.filter((o) => o.kind !== 'end')) {
        acts.push(btn([icon(o.kind === 'roll' && o.trait ? o.trait : optIcon(o.icon)), h('span', { class: 'act-label' }, o.label)],
          () => runOption(x.id, o), 'act k-' + o.kind + (o.trait ? ' t-' + o.trait : ''), { title: o.hint ?? o.label }));
      }
      const end = ends[0];
      acts.push(btn([icon('check'), ' End turn'], () => end ? runOption(x.id, end) : endTurn(x.id), 'end-turn'));
    }
    actions.replaceChildren(...acts);
    actions.classList.toggle('targeting', mode.k === 'target');

    // expanded: pocket, knack, log
    if (expanded) {
      const parts: HTMLElement[] = [];
      if (x) {
        const opts = canAct(x) ? safe(() => engine.options(s, x.id, pack), [] as ActionOption[]) : [];
        const r = role(pack, x.roleId);
        parts.push(h('div', { class: 'traits-line' }, TRAITS.map((t) => traitBadge(pack, t, x.traits[t], s.kidMode))));
        if (r) {
          const kOpt = opts.find((o) => o.kind === 'knack');
          parts.push(h('div', { class: 'knack-card' + (x.knackUsed ? ' used' : '') },
            icon('sparkle', 'ic big'),
            h('div', null, h('b', null, r.knack.name), h('p', null, r.knack.text), x.knackUsed ? h('small', null, 'Used this scene') : null),
            kOpt ? btn('Use', () => runOption(x.id, kOpt), 'small primary') : null));
        }
        const pocket = x.pocket.map((id) => {
          const it = itemDef(pack, id);
          const use = opts.find((o) => o.kind === 'item' && it && o.label.includes(it.name));
          const give = opts.find((o) => o.kind === 'give' && it && o.label.includes(it.name));
          return h('div', { class: 'item' },
            icon(it?.icon || 'pocket', 'ic big'),
            h('div', null, h('b', null, it?.name ?? id), h('p', null, it?.text ?? '')),
            h('div', { class: 'item-btns' }, use ? btn('Use', () => runOption(x.id, use), 'small primary') : null, give ? btn('Give', () => runOption(x.id, give), 'small') : null));
        });
        parts.push(h('h3', null, icon('pocket'), ' Pocket'), pocket.length ? h('div', { class: 'pocket' }, pocket) : h('p', { class: 'hint' }, 'Empty pockets.'));
      }
      parts.push(h('h3', null, icon('log'), ' What happened'), logList(14));
      more.replaceChildren(...parts);
    } else more.replaceChildren();
  }

  function logList(n: number) {
    return h('ol', { class: 'log', reversed: true }, s.log.slice(-n).reverse().map((l) => h('li', { class: 'lk-' + (l.kind ?? 'info') }, l.text)));
  }

  // ---------------------------------------------------------------- menu
  let menuOpen = false;
  function toggleMenu() {
    if (menuOpen) { menuOpen = false; menu.classList.remove('open'); setTimeout(() => { if (!menuOpen) menu.hidden = true; }, 200); return; }
    menuOpen = true; sfx.tap(); renderMenu();
    menu.hidden = false;
    requestAnimationFrame(() => menu.classList.add('open'));
  }
  function renderMenu() {
    const offline = h('span', { class: 'hint' });
    offlineStatus((d, t) => { offline.textContent = t ? (d >= t ? 'All saved for offline ✓' : `${d}/${t} saved`) : ''; });
    const sc = sceneDef(pack, s);
    let armed = 0;
    menu.replaceChildren(
      h('header', { class: 'card-head' }, h('h2', null, pack.theme.title), btn(icon('close'), toggleMenu, 'icon', { 'aria-label': 'Close menu' })),
      h('div', { class: 'drawer-body' },
        h('p', { class: 'hint' }, sc ? `${sc.name} · round ${s.round}` : ''),
        store.role !== 'local' && store.net.info ? h('p', null, 'Table code: ', h('code', { class: 'code small' }, store.net.info.roomId)) : null,
        btn([icon(prefs.muted ? 'mute' : 'sound'), prefs.muted ? ' Sound is off' : ' Sound is on'], () => { setMuted(!prefs.muted); renderMenu(); }, 'wide'),
        btn([icon('install'), ' Save the game for offline'], () => {
          const ok = cacheAllForOffline((d, t) => { offline.textContent = d >= t ? 'All saved for offline ✓' : `Saving… ${d}/${t}`; });
          if (!ok) toast('Offline saving needs the installed app (https).');
        }, 'wide'), offline,
        guideMe() ? btn([icon('guide'), ' Guide panel'], () => { toggleMenu(); guide.open(); }, 'wide') : null,
        h('h3', null, icon('log'), ' What happened'), logList(40),
        btn('Leave the table', () => {
          if (Date.now() - armed < 3000) { ctx.leave(); return; }
          armed = Date.now(); toast('Tap again to leave');
        }, 'wide ghost danger')));
  }

  // ---------------------------------------------------------------- phase overlays
  function renderOverlay(prev: GameState | null) {
    const key = s.phase === 'play' ? (s.choice ? 'choice:' + s.choice.id : 'play')
      : s.phase === 'tableMoment' ? 'moment' : `${s.phase}:${s.scene.index}:${s.phase === 'intro' ? '' : s.scene.result ?? ''}`;
    if (key !== overlayKey) {
      overlayKey = key;
      for (const c of [...overlay.children]) if (!c.classList.contains('event') && !c.classList.contains('trait-pick')) c.remove();
      if (s.phase === 'intro') overlay.appendChild(introCard(ctx, s));
      else if (s.phase === 'sceneEnd') overlay.appendChild(sceneEndCard(ctx, s));
      else if (s.phase === 'ending') overlay.appendChild(endingCard(ctx, s));
      else if (s.phase === 'tableMoment') overlay.appendChild(moment.el);
      else if (s.choice) overlay.appendChild(choiceCard(ctx, s));
    } else if (s.phase === 'play' && s.choice && prev?.choice !== s.choice) {
      overlay.querySelector('.choice')?.replaceWith(choiceCard(ctx, s));
    }
    if (s.phase === 'tableMoment') moment.update(s);
    if (s.phase !== 'play') overlay.querySelector('.trait-pick')?.remove();

    // event card flips when a new one is drawn
    const ek = s.event ? `${s.event.id}:${s.event.round}` : '';
    if (ek && ek !== lastEventKey && s.phase === 'play') {
      lastEventKey = ek;
      if (!eventOpen) { eventOpen = true; overlay.appendChild(eventCard(s, () => { eventOpen = false; })); }
    } else lastEventKey = ek || lastEventKey;
  }

  function feedbackFx(prev: GameState | null) {
    if (!prev || s.fx.seq === prev.fx.seq) return;
    for (const f of s.fx.list) {
      switch (f.k) {
        case 'goal': sfx.chime(); toast(`+${f.n ?? 1} ${pack.labels.goal}!`, 'good', 2200); break;
        case 'spark': if (!s.pending) sfx.twinkle(); break;
        case 'hurt': buzz(60); break;
        case 'tuck': sfx.oops(); buzz([100, 50, 100]); break;
        case 'revive': case 'heal': sfx.twinkle(); break;
        case 'calm': sfx.chime(); break;
        case 'say': if (f.text) { toast(`“${f.text}”`, 'info', 6000); if (s.kidMode && prefs.voice) speak(f.text); } break;
        case 'clock': if (s.meters.clock >= s.meters.clockMax - 2) buzz(30); break;
      }
    }
  }

  function refresh() {
    pickDefault();
    computeMode();
    refreshHighlights();
    renderTop();
    renderSheet();
    if (guide.isOpen()) guide.update(s);
  }

  function update(next: GameState, prev: GameState | null) {
    s = next;
    // follow the turn: when one of my heroes becomes active, show it
    if (next.turn.active && next.turn.active !== prev?.turn.active && controlled().includes(next.turn.active)) selected = next.turn.active;
    // pass-and-play: when the hero I'm looking at finishes, hop to the next one who can still act
    const cur = hero(next, selected), was = prev ? hero(prev, selected) : undefined;
    if (cur && was && (cur.done || cur.tuckered) && !(was.done || was.tuckered)) {
      const nxt = controlled().find((id) => { const x = hero(next, id); return x && !x.done && !x.tuckered; });
      if (nxt) { selected = nxt; board.focus({ heroId: nxt }); }
    }
    if (mode.k === 'move' && prev && (next.v !== prev.v)) mode = { k: 'none' };
    feedbackFx(prev);
    refresh();
    roll.update(next, prev);
    guide.update(next);
    renderOverlay(prev);
    el.classList.toggle('in-play', next.phase === 'play');
    if (!reducedMotion() && prev && prev.phase !== next.phase) el.classList.add('phase-change');
  }

  update(s, null);

  return {
    el, update,
    onCellTap, onHeroTap, onFoeTap, onTokenTap,
    destroy() { insetRO?.disconnect(); safe(() => board.setInsets?.(0, 0), undefined); offStatus(); moment.destroy(); safe(() => board.highlight([], 'move'), undefined); foeCard?.remove(); },
  };
}
