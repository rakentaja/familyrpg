// Story cards: scene intro, event flip, pending choice, scene end, ending.
import type { GameState } from '../engine/types';
import type { Ctx } from './ctx';
import * as engine from '../engine';
import { h, btn } from './dom';
import { icon } from './icons';
import { sceneDef, adventure, canRunTable, hero, recap, safe, avatar, heroColor } from './common';
import { readAloud, sfx, speak, toast, prefs } from './feedback';

const SCENE_TYPE: Record<string, string> = { explore: 'Explore', challenge: 'Challenge', showdown: 'Showdown', boss: 'Big showdown' };

function waitingFor(s: GameState) {
  const g = s.players.find((p) => p.guide && s.mode === 'guide');
  const host = s.players.find((p) => p.host);
  return `Waiting for ${(g ?? host)?.name ?? 'the host'}…`;
}

/** Scene intro card (phase 'intro'). */
export function introCard(ctx: Ctx, s: GameState): HTMLElement {
  const store = ctx.store!;
  const sc = sceneDef(ctx.pack, s);
  const adv = adventure(ctx.pack, s);
  const text = sc?.intro ?? '';
  const can = canRunTable(s, store.me, store.isHost());
  if (s.kidMode && prefs.voice && !prefs.muted) setTimeout(() => speak(`${sc?.name}. ${text} ${sc?.goal.text ?? ''}`), 400);
  return h('div', { class: 'modal story', role: 'dialog', 'aria-label': sc?.name ?? 'Scene' },
    h('div', { class: 'card story-card' },
      h('p', { class: 'kicker' }, `${adv?.name ?? ''} · Scene ${s.scene.index + 1}${adv ? ' of ' + adv.scenes.length : ''} · ${SCENE_TYPE[sc?.type ?? ''] ?? ''}`),
      h('h2', { class: 'title' }, sc?.name ?? 'A new scene', ' ', readAloud(() => `${sc?.name}. ${text} ${sc?.goal.text ?? ''}`)),
      h('p', { class: 'prose' }, text),
      sc?.goal.text ? h('div', { class: 'goal' }, icon('star'), h('div', null, h('b', null, 'Your goal'), h('p', null, sc.goal.text))) : null,
      can ? btn('Let’s go!', () => { sfx.chime(); store.dispatch({ t: 'beginScene' }); }, 'primary big')
        : h('p', { class: 'waiting' }, waitingFor(s))));
}

/** Scene end card (phase 'sceneEnd'). */
export function sceneEndCard(ctx: Ctx, s: GameState): HTMLElement {
  const store = ctx.store!;
  const sc = sceneDef(ctx.pack, s);
  const won = s.scene.result !== 'lost';
  const text = (won ? sc?.win : sc?.lose) || (won ? 'Well done, heroes!' : 'Not this time — but the night goes on!');
  const can = canRunTable(s, store.me, store.isHost());
  won ? sfx.fanfare() : sfx.oops();
  return h('div', { class: 'modal story', role: 'dialog' },
    h('div', { class: 'card story-card ' + (won ? 'won' : 'lost') },
      h('p', { class: 'kicker' }, won ? 'Scene complete!' : 'Phew…'),
      h('h2', { class: 'title' }, sc?.name ?? '', ' ', readAloud(() => text)),
      h('p', { class: 'prose' }, text),
      meterLine(ctx, s),
      can ? btn('Next', () => { sfx.tap(); store.dispatch({ t: 'next' }); }, 'primary big') : h('p', { class: 'waiting' }, waitingFor(s))));
}

function meterLine(ctx: Ctx, s: GameState) {
  const gifts = h('span', { class: 'gifts' });
  for (let i = 0; i < s.meters.goalMax; i++) gifts.appendChild(icon(i < s.meters.goal ? 'gift' : 'giftEmpty'));
  return h('div', { class: 'meter-line' }, h('span', { class: 'lbl' }, ctx.pack.labels.goal), gifts);
}

/** Event card that flips over (state.event changed). */
export function eventCard(s: GameState, onClose: () => void): HTMLElement {
  const ev = s.event!;
  sfx.flip();
  const close = () => { clearTimeout(t); wrap.classList.add('out'); setTimeout(() => { wrap.remove(); onClose(); }, 250); };
  const wrap = h('div', { class: 'modal event', role: 'dialog', 'aria-label': ev.name, onclick: close },
    h('div', { class: 'flip' },
      h('div', { class: 'flip-inner' },
        h('div', { class: 'face back' }, icon('sparkle', 'ic huge')),
        h('div', { class: 'face front' },
          h('p', { class: 'kicker' }, 'Event card'),
          h('h2', null, ev.name),
          h('p', { class: 'prose' }, ev.text),
          h('div', { class: 'row center' }, readAloud(() => `${ev.name}. ${ev.text}`), h('span', { class: 'hint' }, 'Tap to close'))))));
  const t = setTimeout(close, 9000);
  if (s.kidMode && prefs.voice && !prefs.muted) setTimeout(() => speak(`${ev.name}. ${ev.text}`), 700);
  return wrap;
}

/** Pending choice (e.g. "keep one of these items"). */
export function choiceCard(ctx: Ctx, s: GameState): HTMLElement {
  const store = ctx.store!;
  const c = s.choice!;
  const mine = safe(() => engine.controlled(s, store.me), [] as string[]).includes(c.heroId);
  const x = hero(s, c.heroId);
  return h('div', { class: 'modal choice', role: 'dialog' },
    h('div', { class: 'card' },
      h('header', { class: 'roll-head' }, x ? avatar(ctx.pack, x.roleId, heroColor(s, x)) : null, h('h2', null, c.prompt), readAloud(() => c.prompt)),
      mine ? h('div', { class: 'choice-list' }, c.options.map((o) => btn(o.label, () => { sfx.tap(); store.dispatch({ t: 'choose', choiceId: c.id, value: o.value }); }, 'big')))
        : h('p', { class: 'waiting' }, `${x?.name ?? 'A hero'} is choosing…`)));
}

/** Ending screen (phase 'ending'). */
export function endingCard(ctx: Ctx, s: GameState): HTMLElement {
  const store = ctx.store!;
  const { pack } = ctx;
  const e = s.ending;
  const text = e?.text ?? 'The night is over.';
  const lines = recap(s);
  const gifts = h('span', { class: 'gifts big' });
  for (let i = 0; i < s.meters.goalMax; i++) gifts.appendChild(icon(i < (e?.goal ?? s.meters.goal) ? 'gift' : 'giftEmpty'));
  const heroes = s.heroes.map((x) => h('span', { class: 'end-hero' }, avatar(pack, x.roleId, heroColor(s, x)), x.name));
  const share = async () => {
    const msg = `We played ${pack.theme.title}! ${e?.goal ?? s.meters.goal}/${s.meters.goalMax} ${pack.labels.goal.toLowerCase()} delivered` +
      (e?.star ? ', the Star is back on the tree' : '') + (e?.invited ? ' — and Grumbleweed got invited to Christmas!' : '.') +
      `\nHeroes: ${s.heroes.map((x) => x.name).join(', ')}`;
    if (navigator.share) { try { await navigator.share({ title: pack.theme.title, text: msg }); } catch { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(msg); toast('Copied the story — paste it anywhere!', 'good'); } catch { toast(msg, 'info', 6000); }
  };
  sfx.fanfare();
  return h('div', { class: 'modal story ending', role: 'dialog' },
    h('div', { class: 'card story-card tall' },
      h('div', { class: 'scroll' },
        h('p', { class: 'kicker' }, 'The end'),
        h('h2', { class: 'title' }, endingTitle(e?.id), ' ', readAloud(() => text)),
        h('p', { class: 'prose' }, text),
        h('div', { class: 'end-stats' },
          h('div', null, h('span', { class: 'lbl' }, pack.labels.goal), gifts),
          h('div', { class: 'stat' + (e?.star ? ' yes' : '') }, icon('star', 'ic big'), e?.star ? 'The Star is home!' : 'The Star is still lost'),
          e?.invited ? h('div', { class: 'stat yes' }, icon('kind', 'ic big'), 'Grumbleweed was invited to Christmas!') : null),
        h('div', { class: 'end-heroes' }, heroes),
        lines.length ? h('div', { class: 'recap' }, h('h3', null, 'Tonight’s story'), h('ol', null, lines.map((l) => h('li', null, l)))) : null),
      h('footer', { class: 'card-foot row' },
        btn([icon('share'), ' Share'], share, 'ghost'),
        store.isHost() ? btn('Play again', () => ctx.playAgain(), 'primary') : btn('Leave', () => ctx.leave(), 'ghost'))));
}

function endingTitle(id?: string) {
  if (!id) return 'The end';
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
