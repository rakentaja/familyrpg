// Hearthside rules (v2) — pure, deterministic helpers over (GameState, Pack). No DOM; randomness lives in state.seed;
// time comes only from the action envelope (`at`).
import type { RulesApi } from '../contracts';
import type { Adventure, GameState, P, Pack } from './types';
import { withUids } from './layout';
import { findPath, groundOf, navFor, sceneOf } from './geom';
import { controlledIds, isGuide as isGuideP, midnight as midnightAt, heroById, heroFlies } from './core';
import { reduce } from './reduce';
import { buildAction, describe, options } from './options';
import { rollStakes as stakes } from './rolls';

export function createGame(pack: Pack, opts: { hostId: string; hostName: string; hostColor: string; at: number; seed?: number; adventureId?: string; adventure?: Adventure }): GameState {
  const adv = opts.adventure ?? pack.adventures.find((a) => a.id === opts.adventureId) ?? pack.adventures[0];
  const seed = (opts.seed ?? Math.floor(Math.random() * 0xffffffff)) | 0;
  const minutes = adv?.minutes ?? 40;
  const at = Number.isFinite(opts.at) ? opts.at : 0;
  return {
    v: 0, seed, now: at, packId: pack.meta.id, adventureId: adv?.id ?? '',
    ...(adv ? { adv: withUids(adv) } : {}),
    settings: { diceMode: 'target', kidMode: false, readAloud: false, minutes },
    phase: 'lobby',
    players: [{ id: opts.hostId, name: opts.hostName || 'Host', color: opts.hostColor || '#D8A7A7', host: true, guide: true }],
    heroes: [], foes: [], tokens: [],
    scene: { index: 0, id: '', solid: [], flags: {} },
    meters: { sparks: 0, goal: 0, goalMax: adv?.goalMax ?? 6 },
    clock: { totalMs: minutes * 60000, elapsedMs: 0, runningSince: null, steps: 0 },
    deck: { items: [], events: [] },
    bubbles: [],
    log: [], fx: { seq: 0, list: [] },
  };
}

export function path(state: GameState, from: P, to: P, pack: Pack, opts?: { fly?: boolean }): P[] {
  const n = navFor(state, pack);
  if (!n) return [from];
  return findPath(n, from, to, !!opts?.fly);
}
/** Path a hero would walk (uses the hero's own flying ability). */
export function heroPath(state: GameState, heroId: string, to: P, pack: Pack): P[] {
  const h = heroById(state, heroId);
  if (!h) return [];
  return path(state, h.pos, to, pack, { fly: heroFlies(pack, h) });
}
export const controlled = (state: GameState, playerId: string): string[] => controlledIds(state, playerId);
export const isGuide = (state: GameState, playerId: string): boolean => isGuideP(state, playerId);
export const midnight = (state: GameState, now: number): number => midnightAt(state, now);
export function groundAt(state: GameState, p: P, pack: Pack): string {
  const sc = sceneOf(state, pack);
  if (!sc) return 'floor';
  const g = groundOf(sc, state.scene.solid ?? [], p);
  return g.solid ? `solid:${g.kind}` : g.kind;
}

export { reduce, options, buildAction, describe, stakes };
export const rules: RulesApi = { createGame, reduce, path, options, buildAction, controlled, isGuide, midnight, describe, groundAt, stakes };
export default rules;
