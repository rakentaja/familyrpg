// Roll flow: gather helpers → ROLL (3D dice on the board) → result, Twinkles, twist → Done.
import type { GameState, PendingRoll, Trait } from '../engine/types';
import type { Ctx } from './ctx';
import * as engine from '../engine';
import { h, btn, reducedMotion } from './dom';
import { icon } from './icons';
import { avatar, hero, heroColor, isGuide, traitName, foeDef, itemDef, sceneDef, safe, canRunTable } from './common';
import { sfx, buzz, readAloud, speak, prefs } from './feedback';

const HELP_IDEAS = [
  'I hold the ladder steady!', 'I cheer really loudly!', 'I point and say “look over there!”', 'I give them a big hug for luck!',
  'I light the way with my lantern!', 'I hum a brave little song!', 'I share my last cookie!', 'I make a funny face to distract it!',
];

export function rollModal(ctx: Ctx) {
  const store = ctx.store!;
  const { pack } = ctx;
  const el = h('div', { class: 'modal roll', role: 'dialog', 'aria-label': 'Roll the dice', hidden: true });
  const card = h('div', { class: 'card roll-card' });
  el.appendChild(card);

  let shownKey = '';          // which dice result we've already animated
  let rolling = false;
  let helpFor: string | null = null;  // hero id currently showing the "how do you help?" prompt
  let lastState: GameState | null = null;
  let twistDraft = '';

  const diceKey = (p: PendingRoll) => `${p.id}:${p.dice?.join(',')}:${(p.sparkUsed ?? []).length}`;

  function purposeText(s: GameState, p: PendingRoll): string {
    const pu = p.purpose;
    switch (pu.kind) {
      case 'calm': { const f = s.foes.find((x) => x.uid === pu.foeUid); return `calm the ${f ? foeDef(pack, f.foe)?.name ?? 'foe' : 'foe'}`; }
      case 'challenge': return sceneDef(pack, s)?.goal.challenge?.text || 'beat the challenge';
      case 'search': return 'search for hidden things';
      case 'free': return pu.text ? pu.text[0].toLowerCase() + pu.text.slice(1) : 'try something tricky';
      case 'item': return `use the ${itemDef(pack, pu.item)?.name ?? 'item'}`;
    }
  }

  function dieFace(n: number | undefined, cls = '') {
    const d = h('span', { class: 'die ' + cls, 'aria-label': n ? String(n) : 'die' });
    const pips: Record<number, number[]> = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
    for (let i = 1; i <= 9; i++) d.appendChild(h('i', { class: n && pips[n]?.includes(i) ? 'on' : '' }));
    return d;
  }

  async function animate(p: PendingRoll) {
    if (!p.dice) return;
    rolling = true; render();
    sfx.dice(); buzz([30, 40, 30, 40, 60]);
    const timeout = new Promise<void>((r) => setTimeout(r, 4500));
    await Promise.race([safe(() => ctx.board.rollDice(p.dice!), Promise.resolve()).catch(() => {}), timeout]);
    rolling = false;
    const cur = lastState?.pending;
    if (cur && cur.id === p.id) {
      const o = cur.outcome;
      if (o === 'success') { sfx.chime(); buzz(80); }
      else if (o === 'twist') { sfx.twist(); buzz([40, 30, 40]); }
      else if (o === 'trouble') { sfx.oops(); buzz([120, 60, 120]); }
      if (lastState?.kidMode && prefs.voice && o) speak(outcomeTitle(o));
    }
    render();
  }

  function outcomeTitle(o: NonNullable<PendingRoll['outcome']>) {
    return o === 'success' ? 'You did it!' : o === 'twist' ? 'You did it… but!' : `Uh-oh! Trouble. The team gets a ${singularSpark()}.`;
  }
  const singularSpark = () => (pack.labels.sparks || 'Twinkles').replace(/s$/, '');

  function render() {
    const s = lastState;
    const p = s?.pending;
    if (!s || !p || p.stage === 'resolved') { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle('is-rolling', rolling);
    const me = store.me;
    const mine = safe(() => engine.controlled(s, me), [] as string[]);
    const guide = isGuide(s, me);
    const roller = hero(s, p.heroId);
    const iRoll = mine.includes(p.heroId) || (store.role === 'local');
    const canDecide = iRoll || guide || canRunTable(s, me, store.isHost());
    const kid = s.kidMode;
    const t: Trait = p.trait;

    // helpers
    const helperChips = p.helpers.map((id) => { const x = hero(s, id); return x ? h('span', { class: 'helper' }, avatar(pack, x.roleId, heroColor(s, x), 'avatar tiny'), x.name, ' +1') : null; });
    const canHelp = p.stage === 'gather' && p.helpers.length < 2
      ? mine.filter((id) => id !== p.heroId && !p.helpers.includes(id) && !hero(s, id)?.tuckered) : [];
    const myHelping = p.stage === 'gather' ? mine.filter((id) => p.helpers.includes(id)) : [];

    const parts: (HTMLElement | null)[] = [];
    parts.push(h('header', { class: 'roll-head' },
      roller ? avatar(pack, roller.roleId, heroColor(s, roller)) : null,
      h('div', null, h('h2', null, roller?.name ?? 'Hero'), h('p', null, 'tries to ', h('b', null, purposeText(s, p)))),
      readAloud(() => `${roller?.name ?? 'Our hero'} tries to ${purposeText(s, p)}, being ${traitName(pack, t)}.`)));

    parts.push(h('div', { class: 'roll-trait t-' + t },
      icon(t, 'ic big'), h('span', null, h('b', null, traitName(pack, t))),
      kid ? null : h('span', { class: 'bonus' }, `+${p.stage === 'gather' ? (roller?.traits[t] ?? 0) + p.helpers.length : p.bonus}`),
      helperChips.length ? h('span', { class: 'helpers' }, helperChips) : null));

    if (p.stage === 'gather') {
      if (helpFor) {
        const x = hero(s, helpFor);
        const idea = HELP_IDEAS[Math.floor(Math.random() * HELP_IDEAS.length)];
        parts.push(h('div', { class: 'help-prompt' },
          h('p', { class: 'big-q' }, `How does ${x?.name ?? 'your hero'} help?`),
          h('p', null, 'Say it out loud to everyone! For example: ', h('i', null, `“${idea}”`)),
          h('div', { class: 'row' },
            btn('I said it! +1', () => { store.dispatch({ t: 'help', rollId: p.id, heroId: helpFor! }); helpFor = null; sfx.twinkle(); render(); }, 'primary'),
            btn('Never mind', () => { helpFor = null; render(); }, 'ghost'))));
      } else if (canHelp.length && !iRoll) {
        parts.push(h('div', { class: 'help-row' }, canHelp.map((id) => btn([icon('kind'), ` Help! (${hero(s, id)?.name})`], () => { helpFor = id; sfx.tap(); render(); }, 'help-btn'))));
      } else if (canHelp.length && iRoll) {
        parts.push(h('div', { class: 'help-row' }, h('p', { class: 'hint' }, 'Friends can help for +1 (up to 2):'), canHelp.map((id) => btn(`${hero(s, id)?.name} helps`, () => { helpFor = id; render(); }, 'ghost small'))));
      }
      if (myHelping.length) parts.push(h('div', { class: 'row' }, myHelping.map((id) => btn(`${hero(s, id)?.name} stops helping`, () => store.dispatch({ t: 'unhelp', rollId: p.id, heroId: id }), 'ghost small'))));
      if (iRoll) {
        parts.push(h('div', { class: 'roll-go' },
          btn([icon('dice', 'ic big'), ' ROLL!'], () => { sfx.tap(); buzz(20); store.dispatch({ t: 'roll', rollId: p.id }); }, 'primary huge roll-btn'),
          btn('Not now', () => store.dispatch({ t: 'cancelRoll', rollId: p.id }), 'ghost small')));
      } else {
        parts.push(h('p', { class: 'waiting' }, `Waiting for ${roller?.name ?? 'the hero'} to roll…`));
      }
    } else if (rolling) {
      parts.push(h('div', { class: 'dice-row rolling' + (reducedMotion() ? '' : ' shake') }, dieFace(undefined), dieFace(undefined)),
        h('p', { class: 'waiting' }, 'Rolling…'));
    } else {
      // rolled
      const o = p.outcome ?? 'twist';
      const used = new Set(p.sparkUsed ?? []);
      const sparks = s.meters.sparks;
      parts.push(h('div', { class: 'dice-row' }, dieFace(p.dice?.[0]), dieFace(p.dice?.[1]),
        kid ? null : h('span', { class: 'sum' }, `+ ${p.bonus} = `, h('b', null, String(p.total ?? ((p.dice?.[0] ?? 0) + (p.dice?.[1] ?? 0) + p.bonus))))));
      parts.push(h('div', { class: 'outcome o-' + o }, h('b', null, outcomeTitle(o)), readAloud(() => outcomeTitle(o) + (p.twist ? ' ' + p.twist : ''))));
      if (o === 'twist' && p.twist && !used.has('ignoreTwist')) parts.push(h('p', { class: 'twist' }, icon('sparkle'), p.twist));

      if (iRoll && sparks > 0) {
        const opts: HTMLElement[] = [];
        const label = pack.labels.sparks || 'Twinkles';
        if (o !== 'success' && !used.has('reroll')) opts.push(btn([icon('twinkle'), ' Roll again'], () => { sfx.twinkle(); store.dispatch({ t: 'spark', rollId: p.id, use: 'reroll' }); }, 'spark'));
        if (o !== 'success' && !used.has('plus2')) opts.push(btn([icon('twinkle'), ' Add +2'], () => { sfx.twinkle(); store.dispatch({ t: 'spark', rollId: p.id, use: 'plus2' }); }, 'spark'));
        if (o === 'twist' && !used.has('ignoreTwist')) opts.push(btn([icon('twinkle'), ' No twist!'], () => { sfx.twinkle(); store.dispatch({ t: 'spark', rollId: p.id, use: 'ignoreTwist' }); }, 'spark'));
        if (opts.length) parts.push(h('div', { class: 'spark-row' }, h('p', { class: 'hint' }, `Spend 1 of your ${sparks} ${label}?`), h('div', { class: 'row wrap' }, opts)));
      }

      if (guide) {
        const twists = [...(sceneDef(pack, s)?.twists ?? []), ...pack.twists].slice(0, 12);
        const tin = h('input', { class: 'twist-in', placeholder: 'Write the twist…', value: twistDraft || p.twist || '' });
        tin.addEventListener('input', () => { twistDraft = tin.value; });
        const pick = h('select', { class: 'small', 'aria-label': 'Pick a twist', onchange: () => { tin.value = pick.value; twistDraft = pick.value; } },
          h('option', { value: '' }, 'Pick a twist…'), twists.map((x) => h('option', { value: x }, x.slice(0, 60))));
        parts.push(h('details', { class: 'guide-box', open: o === 'twist' && !p.twist },
          h('summary', null, icon('guide'), ' Guide'),
          h('div', { class: 'row wrap' }, ...(['success', 'twist', 'trouble'] as const).map((oc) =>
            btn(oc === 'success' ? 'Make it a success' : oc === 'twist' ? 'Make it a twist' : 'Make it trouble',
              () => store.dispatch({ t: 'guide', op: { k: 'outcome', rollId: p.id, outcome: oc } }), 'small' + (oc === o ? ' on' : '')))),
          h('div', { class: 'row' }, tin), h('div', { class: 'row' }, pick, btn('Set twist', () => { store.dispatch({ t: 'setTwist', rollId: p.id, text: tin.value.trim() }); twistDraft = ''; }, 'small'))));
      }

      parts.push(canDecide
        ? btn('Done', () => { sfx.tap(); store.dispatch({ t: 'resolve', rollId: p.id }); }, 'primary big')
        : h('p', { class: 'waiting' }, 'Waiting…'));
    }
    card.replaceChildren(...parts.filter(Boolean) as HTMLElement[]);
  }

  function update(s: GameState, prev: GameState | null) {
    lastState = s;
    const p = s.pending;
    if (!p) { helpFor = null; twistDraft = ''; shownKey = ''; render(); return; }
    if (p.stage === 'rolled' && p.dice) {
      const key = diceKey(p);
      const fxDice = s.fx.seq !== prev?.fx.seq && s.fx.list.some((f) => f.k === 'dice');
      if (key !== shownKey) {
        shownKey = key;
        // animate fresh rolls; states loaded on resume just show the result
        if (fxDice || prev?.pending?.id === p.id) { animate(p); return; }
      }
    }
    if (!rolling) render();
  }

  return { el, update };
}
