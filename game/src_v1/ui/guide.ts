// Guide panel (guide mode, Guide's device only): foes, Cheer, meters, events, foes' turn, end scene, Say.
import type { GameState, GuideOp } from '../engine/types';
import type { Ctx } from './ctx';
import { h, btn } from './dom';
import { icon } from './icons';
import { foeDef, avatar, heroColor } from './common';
import { sfx, toast } from './feedback';

export function guidePanel(ctx: Ctx, hooks: { pickFoeMove(uid: string): void; pickSpawn(foe: string): void }) {
  const store = ctx.store!;
  const { pack } = ctx;
  const op = (o: GuideOp) => { sfx.tap(); store.dispatch({ t: 'guide', op: o }); };
  const body = h('div', { class: 'drawer-body' });
  const el = h('aside', { class: 'drawer guide-panel', 'aria-label': 'Guide panel', hidden: true },
    h('header', { class: 'card-head' }, h('h2', null, icon('guide'), ' Guide'), btn(icon('close'), () => close(), 'icon', { 'aria-label': 'Close' })),
    body);
  let sayDraft = '';
  let spawnFoe = pack.foes.find((f) => !f.boss)?.id ?? pack.foes[0]?.id ?? '';
  const open = () => { el.hidden = false; requestAnimationFrame(() => el.classList.add('open')); if (last) render(last); };
  const close = () => { el.classList.remove('open'); setTimeout(() => { el.hidden = true; }, 220); };
  let last: GameState | null = null;

  const pm = (label: string, minus: () => void, plus: () => void, value: string) =>
    h('div', { class: 'pm' }, h('span', { class: 'pm-label' }, label), btn('−', minus, 'icon round small', { 'aria-label': label + ' down' }), h('b', { class: 'pm-val' }, value), btn('+', plus, 'icon round small', { 'aria-label': label + ' up' }));

  function render(s: GameState) {
    last = s;
    if (el.hidden) return;
    // don't wipe what the Guide is typing; the next update after they finish will refresh
    const a = document.activeElement;
    if (a && body.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) { a.addEventListener('blur', () => last && render(last), { once: true }); return; }
    const sayIn = h('input', { class: 'say-in', placeholder: 'Say something to the table…', value: sayDraft, enterkeyhint: 'send' });
    const say = () => { const t = sayIn.value.trim(); if (!t) return; op({ k: 'say', text: t }); sayDraft = ''; sayIn.value = ''; toast('Said!', 'good', 1200); };
    sayIn.addEventListener('input', () => { sayDraft = sayIn.value; });
    sayIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') say(); });

    const foes = s.foes.filter((f) => !f.calmed).map((f) => {
      const d = foeDef(pack, f.foe);
      return h('div', { class: 'g-row' + (f.calmed ? ' calmed' : '') },
        h('div', { class: 'g-name' }, h('b', null, d?.name ?? f.foe), h('small', null, f.calmed ? pack.labels.calmed || 'calmed' : `Grump ${f.grump}/${f.maxGrump}`)),
        btn('−', () => op({ k: 'grump', uid: f.uid, delta: -1 }), 'icon round small', { 'aria-label': 'Less grump' }),
        btn('+', () => op({ k: 'grump', uid: f.uid, delta: +1 }), 'icon round small', { 'aria-label': 'More grump' }),
        f.calmed ? null : btn('Move', () => { hooks.pickFoeMove(f.uid); close(); }, 'small'));
    });
    const heroes = s.heroes.map((x) => h('div', { class: 'g-row' },
      avatar(pack, x.roleId, heroColor(s, x), 'avatar tiny'),
      h('div', { class: 'g-name' }, h('b', null, x.name), h('small', null, x.tuckered ? pack.labels.tuckered || 'Tuckered out' : `${pack.labels.hearts} ${x.hearts}/${x.maxHearts}`)),
      btn('−', () => op({ k: 'hearts', heroId: x.id, delta: -1 }), 'icon round small', { 'aria-label': 'Less ' + pack.labels.hearts }),
      btn('+', () => op({ k: 'hearts', heroId: x.id, delta: +1 }), 'icon round small', { 'aria-label': 'More ' + pack.labels.hearts })));
    const m = s.meters;
    const spawnSel = h('select', { class: 'small', 'aria-label': 'Foe to add', onchange: (e: Event) => { spawnFoe = (e.target as HTMLSelectElement).value; } },
      pack.foes.map((f) => h('option', { value: f.id, selected: f.id === spawnFoe }, f.name)));

    body.replaceChildren(
      h('section', null, h('h3', null, 'Say'), h('div', { class: 'row' }, sayIn, btn('Say', say, 'primary small'))),
      h('section', null, h('h3', null, 'Turn'),
        h('div', { class: 'row wrap' },
          btn('Run foes’ turn', () => op({ k: 'foesTurn' }), 'small'),
          btn('Flip event card', () => op({ k: 'flipEvent' }), 'small'))),
      h('section', null, h('h3', null, 'Meters'),
        pm(pack.labels.sparks, () => op({ k: 'meter', meter: 'sparks', delta: -1 }), () => op({ k: 'meter', meter: 'sparks', delta: 1 }), String(m.sparks)),
        pm(pack.labels.goal, () => op({ k: 'meter', meter: 'goal', delta: -1 }), () => op({ k: 'meter', meter: 'goal', delta: 1 }), `${m.goal}/${m.goalMax}`),
        pm(pack.labels.clock, () => op({ k: 'meter', meter: 'clock', delta: -1 }), () => op({ k: 'meter', meter: 'clock', delta: 1 }), `${m.clock}/${m.clockMax}`)),
      h('section', null, h('h3', null, pack.labels.foes || 'Foes'), foes.length ? foes : h('p', { class: 'hint' }, 'No foes here.'),
        h('div', { class: 'row' }, spawnSel, btn('Add on a square', () => { hooks.pickSpawn(spawnFoe); close(); }, 'small'))),
      h('section', null, h('h3', null, pack.labels.heroes || 'Heroes'), heroes),
      h('section', null, h('h3', null, 'Scene'),
        h('div', { class: 'row wrap' },
          btn('End scene: won', () => op({ k: 'endScene', result: 'won' }), 'small good'),
          btn('End scene: lost', () => op({ k: 'endScene', result: 'lost' }), 'small bad'))));
  }

  return { el, open, close, update: render, isOpen: () => !el.hidden };
}
