// Ending screen (phase 'ending'): how the night ended, presents, the Star, the heroes, a short recap, share / play again.
import type { GameState } from '../rules/types';
import type { Ctx } from './ctx';
import { h, btn } from './dom';
import { icon } from './icons';
import { recap, avatar, heroColor } from './common';
import { readAloud, sfx, toast } from './feedback';

function endingTitle(id?: string) {
  if (!id) return 'The end';
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function endingScreen(ctx: Ctx) {
  const el = h('section', { class: 'screen ending' });
  let key = '';

  function update(s: GameState) {
    const store = ctx.store!;
    const { pack } = ctx;
    const e = s.ending;
    const k = `${e?.id}:${s.v}:${store.isHost()}`;
    if (k === key) return;
    const first = !key;
    key = k;
    const boss = pack.foes.find((f) => f.boss)?.name ?? 'the boss';
    const text = e?.text ?? 'The night is over.';
    const lines = recap(s);
    const goal = e?.goal ?? s.meters.goal;
    const gifts = h('span', { class: 'gifts big' });
    for (let i = 0; i < s.meters.goalMax; i++) gifts.appendChild(icon(i < goal ? 'gift' : 'giftEmpty'));
    const share = async () => {
      const msg = `We played ${pack.theme.title}! ${goal}/${s.meters.goalMax} ${pack.labels.goal.toLowerCase()} delivered` +
        (e?.star ? ', the Star is back on the tree' : '') + (e?.invited ? ` — and ${boss} got invited to Christmas!` : '.') +
        `\nHeroes: ${s.heroes.map((x) => x.name).join(', ')}`;
      if (navigator.share) { try { await navigator.share({ title: pack.theme.title, text: msg }); } catch { /* cancelled */ } return; }
      try { await navigator.clipboard.writeText(msg); toast('Copied the story — paste it anywhere!', 'good'); } catch { toast(msg, 'info', 6000); }
    };
    el.replaceChildren(h('div', { class: 'paper story-card end-card' },
      h('p', { class: 'kicker' }, 'The end'),
      h('h2', { class: 'title' }, endingTitle(e?.id), ' ', readAloud(() => text)),
      h('p', { class: 'prose' }, text),
      h('div', { class: 'end-stats' },
        h('div', null, h('span', { class: 'lbl' }, pack.labels.goal), gifts),
        h('div', { class: 'stat' + (e?.star ? ' yes' : '') }, icon('star', 'ic big'), e?.star ? 'The Star is home!' : 'The Star is still lost'),
        e?.invited ? h('div', { class: 'stat yes' }, icon('kind', 'ic big'), `${boss} was invited to Christmas!`) : null),
      h('div', { class: 'end-heroes' }, s.heroes.map((x) => h('span', { class: 'end-hero' }, avatar(pack, x.roleId, heroColor(s, x)), x.name))),
      lines.length ? h('div', { class: 'recap' }, h('h3', null, 'Tonight’s story'), h('ol', null, lines.map((l) => h('li', null, l)))) : null,
      h('div', { class: 'row end-btns' },
        btn([icon('share'), ' Share'], share, 'ghost grow'),
        store.isHost() ? btn('Play again', () => ctx.playAgain(), 'primary grow') : btn('Leave', () => ctx.leave(), 'ghost grow'))));
    if (first) sfx.fanfare();
  }

  return { el, update };
}
