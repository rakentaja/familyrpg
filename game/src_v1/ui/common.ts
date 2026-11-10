// Shared lookups and small view helpers used by several screens.
import type { GameState, Hero, Pack, PackRole, TargetRef, Trait, Vec, Player } from '../engine/types';
import { TRAITS } from '../engine/types';
import { h } from './dom';
import { icon } from './icons';

export const PLAYER_COLORS = ['#D8A7A7', '#A9BFA0', '#B4ABC6', '#E9D49A', '#A7C4D8', '#E8B996', '#B9DCCB', '#C59BB8'];

const PORTRAITS = ['reindeer-flyer', 'snow-sprite', 'gingerbread-scout', 'toy-soldier', 'carol-singer', 'polar-bear-baker', 'star-keeper'];

export function role(pack: Pack, id: string): PackRole | undefined { return pack.roles.find((r) => r.id === id); }

/** Portrait image for a role (matched by role id or model key), or '' if we have none. */
export function portraitUrl(pack: Pack, roleId: string): string {
  const r = role(pack, roleId);
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

export function player(s: GameState, id: string): Player | undefined { return s.players.find((p) => p.id === id); }
export function playerColor(s: GameState, id: string) { return player(s, id)?.color ?? '#B4ABC6'; }
export function heroColor(s: GameState, hero: Hero) { return playerColor(s, hero.owner); }
export function hero(s: GameState, id: string | undefined) { return id ? s.heroes.find((x) => x.id === id) : undefined; }

export function isGuide(s: GameState, me: string) { return s.mode === 'guide' && !!player(s, me)?.guide; }
export function isHostPlayer(s: GameState, me: string) { return !!player(s, me)?.host; }
/** Who may press the "table" buttons (begin scene, next, start moment): host or the Guide. */
export function canRunTable(s: GameState, me: string, authoritative: boolean) { return authoritative || isHostPlayer(s, me) || isGuide(s, me); }

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

/** Where on the board a target lives (for highlighting). */
export function targetCell(s: GameState, t: TargetRef): Vec | null {
  if (t.cell) return t.cell;
  if (t.foeUid) return s.foes.find((f) => f.uid === t.foeUid)?.pos ?? null;
  if (t.heroId) return hero(s, t.heroId)?.pos ?? null;
  if (t.tokenUid) return s.tokens.find((k) => k.uid === t.tokenUid)?.pos ?? null;
  return null;
}
export function targetLabel(pack: Pack, s: GameState, t: TargetRef): string {
  if (t.foeUid) { const f = s.foes.find((x) => x.uid === t.foeUid); return f ? foeDef(pack, f.foe)?.name ?? 'Foe' : 'Foe'; }
  if (t.heroId) return hero(s, t.heroId)?.name ?? 'Friend';
  if (t.tokenUid) { const k = s.tokens.find((x) => x.uid === t.tokenUid); return k?.label || (k?.item && itemDef(pack, k.item)?.name) || tokenName(pack, k?.kind); }
  if (t.cell) return `Square ${String.fromCharCode(65 + t.cell.x)}${t.cell.y + 1}`;
  return '?';
}
export function tokenName(pack: Pack, kind?: string) {
  switch (kind) {
    case 'goal': return singular(pack.labels.goal);
    case 'star': return 'The Star';
    case 'exit': return 'Way out';
    case 'clue': return 'Clue';
    case 'npc': return 'Someone';
    default: return 'Something';
  }
}
export function singular(w: string) { return w.endsWith('s') ? w.slice(0, -1) : w; }
export const sameCell = (a: Vec | null | undefined, b: Vec | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y;

/** Hearts row ("Cheer"). */
export function hearts(n: number, max: number, cls = 'hearts'): HTMLElement {
  const el = h('span', { class: cls, 'aria-label': `${n} of ${max}` });
  for (let i = 0; i < max; i++) el.appendChild(icon(i < n ? 'heart' : 'heartEmpty'));
  return el;
}

/** Trait pips: icon + dots (kid mode hides the digits). */
export function traitBadge(pack: Pack, t: Trait, n: number, kid: boolean): HTMLElement {
  const dots = h('span', { class: 'pips' });
  for (let i = 0; i < 3; i++) dots.appendChild(h('i', { class: i < n ? 'on' : '' }));
  return h('span', { class: 'trait t-' + t, title: traitName(pack, t) }, icon(t), kid ? null : h('b', null, String(n)), dots);
}

export function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (err) { console.warn(err); return fallback; }
}

export function heroesByOwner(s: GameState, owner: string) { return s.heroes.filter((x) => x.owner === owner); }

/** Recap lines for the ending screen. */
export function recap(s: GameState, n = 8): string[] {
  const pick = s.log.filter((l) => l.kind === 'scene' || l.kind === 'good' || l.kind === 'event');
  return (pick.length ? pick : s.log).slice(-n).map((l) => l.text);
}
