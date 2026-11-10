// Shared lookups and small view helpers used by several screens.
import type { GameState, Hero, Pack, PackRole, Player, Trait } from '../rules/types';
import { TRAITS } from '../rules/types';
import { h } from './dom';
import { icon } from './icons';

export const PLAYER_COLORS = ['#D8A7A7', '#A9BFA0', '#B4ABC6', '#E9D49A', '#A7C4D8', '#E8B996', '#B9DCCB', '#C59BB8'];

const PORTRAITS = ['reindeer-flyer', 'snow-sprite', 'gingerbread-scout', 'toy-soldier', 'carol-singer', 'polar-bear-baker', 'star-keeper'];

export function role(pack: Pack, id: string): PackRole | undefined { return pack.roles.find((r) => r.id === id); }

/** Portrait image for a role (matched by portrait, role id or model key), or '' if we have none. */
export function portraitUrl(pack: Pack, roleId: string): string {
  const r = role(pack, roleId);
  if (r?.portrait) return r.portrait;
  const keys = [roleId, r?.model ?? '', r?.name ?? ''].map((k) => k.toLowerCase().replace(/\s+/g, '-'));
  const hit = PORTRAITS.find((p) => keys.some((k) => k.includes(p) || (k.length > 3 && p.includes(k))));
  return hit ? `img/roles/${hit}.webp` : '';
}

/** Round portrait chip for a hero/role, tinted by the owner's colour. */
export function avatar(pack: Pack, roleId: string, color = '#B4ABC6', cls = 'avatar'): HTMLElement {
  const url = portraitUrl(pack, roleId);
  const r = role(pack, roleId);
  const el = h('span', { class: cls, style: `--pc:${color}` });
  if (url) el.appendChild(h('img', { src: url, alt: '', loading: 'lazy', draggable: 'false' }));
  else el.appendChild(h('b', null, (r?.name ?? '?').slice(0, 1)));
  return el;
}

export function player(s: GameState, id: string | undefined): Player | undefined { return id ? s.players.find((p) => p.id === id) : undefined; }
export function playerColor(s: GameState, id: string) { return player(s, id)?.color ?? '#B4ABC6'; }
export function heroColor(s: GameState, x: Hero) { return playerColor(s, x.owner); }
export function hero(s: GameState, id: string | undefined) { return id ? s.heroes.find((x) => x.id === id) : undefined; }
export function guidePlayer(s: GameState) { return s.players.find((p) => p.guide) ?? s.players.find((p) => p.host); }

export function traitName(pack: Pack, t: Trait) { return pack.labels.traits?.[t] ?? t[0].toUpperCase() + t.slice(1); }
export { TRAITS };

export function adventure(pack: Pack, s: GameState) {
  return pack.adventures.find((a) => a.id === s.adventureId) ?? pack.adventures[0];
}
export function sceneDef(pack: Pack, s: GameState) {
  const adv = adventure(pack, s);
  return adv?.scenes.find((x) => x.id === s.scene.id) ?? adv?.scenes[s.scene.index];
}
export function foeDef(pack: Pack, id: string) { return pack.foes.find((f) => f.id === id); }
export function itemDef(pack: Pack, id: string) { return pack.items.find((i) => i.id === id); }

/** Short name of anything with an id on the table (hero id / foe uid / token uid). */
export function thingName(pack: Pack, s: GameState, id: string | undefined): string {
  if (!id) return '';
  const x = hero(s, id); if (x) return x.name;
  const f = s.foes.find((o) => o.uid === id); if (f) return foeDef(pack, f.foe)?.name ?? 'Foe';
  const k = s.tokens.find((o) => o.uid === id); if (k) return k.label || (k.item && itemDef(pack, k.item)?.name) || k.kind;
  return '';
}

export function singular(w: string) { return w.endsWith('s') ? w.slice(0, -1) : w; }

/** Trait pips: icon + dots (kid mode hides the digits). */
export function traitBadge(pack: Pack, t: Trait, n: number, kid: boolean): HTMLElement {
  const dots = h('span', { class: 'pips' });
  for (let i = 0; i < 3; i++) dots.appendChild(h('i', { class: i < n ? 'on' : '' }));
  return h('span', { class: 'trait t-' + t, title: traitName(pack, t) }, icon(t), kid ? null : h('b', null, String(n)), dots);
}

export function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (err) { console.warn(err); return fallback; }
}

/** Recap lines for the ending screen. */
export function recap(s: GameState, n = 8): string[] {
  const pick = s.log.filter((l) => l.kind === 'scene' || l.kind === 'good' || l.kind === 'event');
  return (pick.length ? pick : s.log).slice(-n).map((l) => l.text);
}

/** Leave buttons arm on the first tap and act on the second (no confirm() dialogs). */
export function twoTap(fn: () => void, msg: string, toastFn: (m: string) => void) {
  let armed = 0;
  return () => {
    if (Date.now() - armed < 3000) { armed = 0; fn(); return; }
    armed = Date.now();
    toastFn(msg);
  };
}
/** What each trait is for (shown when making a hero, on the hero card and on the roll card). */
export const TRAIT_HELP: Record<Trait, string> = {
  brave: 'jumping, climbing, standing up to scary things',
  clever: 'puzzles, tricks, spotting things',
  kind: 'calming, helping, making friends',
};
