// Hero creator: swipeable role carousel, name, trait splitter (6 points, each 1–3), owner.
import type { GameState, Pack, Trait } from '../rules/types';
import { h, btn } from './dom';
import { icon } from './icons';
import { portraitUrl, traitName, TRAITS, itemDef, TRAIT_HELP } from './common';
import { sfx, readAloud, toast } from './feedback';

const HERO_NAMES = ['Pip', 'Comet', 'Holly', 'Juniper', 'Sprinkle', 'Bramble', 'Clove', 'Nutmeg', 'Tinsel', 'Maple', 'Frost', 'Ginger', 'Twig', 'Pebble', 'Sorrel', 'Wren'];

export function openCreator(opts: {
  pack: Pack; state: GameState; me: string; canAssign: boolean;
  onDone(hero: { roleId: string; name: string; traits: Record<Trait, number>; owner: string }): void;
}) {
  const { pack, state, me } = opts;
  const taken = new Set(state.heroes.map((x) => x.roleId));
  let idx = Math.max(0, pack.roles.findIndex((r) => !taken.has(r.id)));
  let traits: Record<Trait, number> = { ...pack.roles[idx].suggested };
  let touchedTraits = false;
  const kid = state.settings.kidMode;
  const meGuide = !!state.players.find((p) => p.id === me)?.guide;
  const defaultOwner = (opts.canAssign && meGuide ? state.players.find((p) => !p.guide)?.id : undefined) ?? me;

  // ---- carousel
  const track = h('div', { class: 'carousel', role: 'listbox', 'aria-label': 'Hero roles' });
  pack.roles.forEach((r, i) => {
    const item = itemDef(pack, r.start);
    const url = portraitUrl(pack, r.id);
    track.appendChild(h('article', { class: 'role-card' + (taken.has(r.id) ? ' taken' : ''), role: 'option', 'data-i': String(i) },
      h('div', { class: 'role-pic' }, url ? h('img', { src: url, alt: r.name, draggable: 'false' }) : h('b', null, r.name[0])),
      h('div', { class: 'role-text' },
        h('h3', null, r.name, ' ', readAloud(() => `${r.name}. ${r.blurb}. Special trick: ${r.knack.name}. ${r.knack.text}. Starts with ${item?.name ?? r.start}.`)),
        taken.has(r.id) ? h('p', { class: 'tag' }, 'Already on the team — you can still pick it') : null,
        h('p', { class: 'blurb' }, r.blurb),
        h('p', { class: 'knack' }, icon('sparkle'), h('b', null, r.knack.name), ' — ', r.knack.text),
        h('p', { class: 'start' }, icon('pocket'), 'Starts with ', h('b', null, item?.name ?? r.start)))));
  });
  const dots = h('div', { class: 'dots' }, pack.roles.map((_, i) => h('i', { 'data-i': String(i) })));
  const go = (i: number, smooth = true) => {
    i = (i + pack.roles.length) % pack.roles.length;
    const card = track.children[i] as HTMLElement;
    track.scrollTo({ left: card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
  };
  const setIdx = (i: number) => {
    if (i === idx) return;
    idx = i;
    if (!touchedTraits) traits = { ...pack.roles[idx].suggested };
    paint();
  };
  let scrollT = 0;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollT);
    scrollT = setTimeout(() => {
      const mid = track.scrollLeft + track.clientWidth / 2;
      let best = 0, bd = Infinity;
      [...track.children].forEach((c, i) => { const el = c as HTMLElement; const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid); if (d < bd) { bd = d; best = i; } });
      setIdx(best);
    }, 60) as unknown as number;
  }, { passive: true });

  // ---- name
  const nameIn = h('input', { class: 'name-in', maxlength: '18', placeholder: 'Hero name', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Hero name' });
  nameIn.value = HERO_NAMES[Math.floor(Math.random() * HERO_NAMES.length)];
  const dice = btn(icon('dice'), () => { nameIn.value = HERO_NAMES[Math.floor(Math.random() * HERO_NAMES.length)]; sfx.dice(); }, 'icon', { 'aria-label': 'Another name' });

  // ---- traits
  const traitBox = h('div', { class: 'splitter' });
  const left = h('div', { class: 'points-left' });
  const total = () => TRAITS.reduce((a, t) => a + traits[t], 0);
  const bump = (t: Trait, d: number) => {
    const v = traits[t] + d;
    if (v < 1 || v > 3) return;
    if (d > 0 && total() >= 6) {
      // take a point from the biggest other trait so kids never get stuck
      const other = TRAITS.filter((o) => o !== t && traits[o] > 1).sort((a, b) => traits[b] - traits[a])[0];
      if (!other) return;
      traits[other]--;
    }
    traits[t] = v; touchedTraits = true; sfx.tap(); paint();
  };

  // ---- owner
  const ownerSel = h('select', { class: 'owner-sel', 'aria-label': 'Who plays this hero?' },
    state.players.map((p) => h('option', { value: p.id, selected: p.id === defaultOwner }, p.name + (p.id === me ? ' (you)' : '') + (p.guide ? ' · Guide' : ''))));
  const ownerRow = opts.canAssign && state.players.length > 1 ? h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Who plays this hero?'), ownerSel) : null;

  const addBtn = btn('Add this hero!', () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('Give your hero a name'); return; }
    if (total() !== 6) { toast('Share out all 6 points first'); return; }
    sfx.chime();
    opts.onDone({ roleId: pack.roles[idx].id, name, traits: { ...traits }, owner: ownerRow ? ownerSel.value : defaultOwner });
    close();
  }, 'primary big');

  function paint() {
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx));
    [...track.children].forEach((c, i) => { c.classList.toggle('sel', i === idx); c.setAttribute('aria-selected', String(i === idx)); });
    traitBox.replaceChildren(...TRAITS.map((t) => {
      const pips = h('span', { class: 'pips big' });
      for (let i = 0; i < 3; i++) pips.appendChild(h('i', { class: i < traits[t] ? 'on' : '' }));
      return h('div', { class: 'split-row t-' + t },
        h('span', { class: 'split-name' }, icon(t, 'ic big'), h('span', null, h('b', null, traitName(pack, t)), kid ? null : h('small', null, TRAIT_HELP[t]))),
        btn('−', () => bump(t, -1), 'icon round', { 'aria-label': 'Less ' + traitName(pack, t), disabled: traits[t] <= 1 }),
        pips,
        btn('+', () => bump(t, +1), 'icon round', { 'aria-label': 'More ' + traitName(pack, t), disabled: traits[t] >= 3 }));
    }));
    const rest = 6 - total();
    left.textContent = rest === 0 ? 'All points shared out ✓' : `${rest} point${rest === 1 ? '' : 's'} left to share`;
    left.classList.toggle('ok', rest === 0);
    addBtn.disabled = rest !== 0;
  }

  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') go(idx + 1); if (e.key === 'ArrowLeft') go(idx - 1); };
  document.addEventListener('keydown', onKey);

  const wrap = h('div', { class: 'modal creator', role: 'dialog', 'aria-label': 'Make a hero' },
    h('div', { class: 'card tall' },
      h('header', { class: 'card-head' }, h('h2', null, 'Make a hero'), btn(icon('close'), close, 'icon', { 'aria-label': 'Close' })),
      h('div', { class: 'scroll' },
        h('p', { class: 'step' }, h('b', null, '1'), ' Pick who you want to be — swipe!'),
        h('div', { class: 'carousel-wrap' },
          btn(icon('left'), () => go(idx - 1), 'icon nav prev', { 'aria-label': 'Previous role' }),
          track,
          btn(icon('right'), () => go(idx + 1), 'icon nav next', { 'aria-label': 'Next role' })),
        dots,
        h('p', { class: 'step' }, h('b', null, '2'), ' Give your hero a name'),
        h('div', { class: 'row' }, nameIn, dice),
        h('p', { class: 'step' }, h('b', null, '3'), ' What are you best at?'),
        traitBox, left,
        ownerRow),
      h('footer', { class: 'card-foot' }, addBtn)));
  document.getElementById('ui')!.appendChild(wrap);
  paint();
  requestAnimationFrame(() => go(idx, false));
}
