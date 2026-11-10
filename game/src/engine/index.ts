// Hearthside engine entry point. Pure functions over (GameState, Pack); no DOM, seeded randomness in state.seed.
import type { EngineApi } from '../contracts';
import type { ActionOption, GameState, Mode, Pack, TargetRef, Vec } from './types';
import { reachable as reach } from './grid';
import { controlledIds, describe, heroById } from './rules';
import { reduce } from './reduce';
import { buildAction, options } from './options';

export function createGame(pack: Pack, opts: { hostId: string; hostName: string; hostColor: string; mode: Mode; seed?: number; adventureId?: string }): GameState {
  const adv = pack.adventures.find((a) => a.id === opts.adventureId) ?? pack.adventures[0];
  const seed = (opts.seed ?? Math.floor(Math.random() * 0xffffffff)) | 0;
  return {
    v: 0, seed, packId: pack.meta.id, adventureId: adv?.id ?? '', mode: opts.mode === 'guide' ? 'guide' : 'guideless', kidMode: false,
    phase: 'lobby',
    players: [{ id: opts.hostId, name: opts.hostName || 'Host', color: opts.hostColor || '#D8A7A7', host: true, online: true }],
    heroes: [], foes: [], tokens: [],
    scene: { index: 0, id: '', w: 0, h: 0, tiles: [], frozenWater: [], flags: {} },
    round: 0, turn: { stage: 'heroes' },
    meters: { sparks: 0, goal: 0, goalMax: adv?.goalMax ?? 6, clock: 0, clockMax: adv?.clockMax ?? 12 },
    deck: { items: [], events: [] },
    log: [], fx: { seq: 0, list: [] },
  };
}

export function reachable(state: GameState, heroId: string, pack: Pack): { cell: Vec; path: Vec[] }[] {
  const h = heroById(state, heroId);
  if (!h || state.phase !== 'play' || state.turn.stage !== 'heroes' || h.done || h.tuckered || state.pending || state.choice) return [];
  return reach(state, pack, h).map(({ cell, path }) => ({ cell, path }));
}

export function controlled(state: GameState, playerId: string): string[] {
  return controlledIds(state, playerId);
}

export function describeTile(state: GameState, cell: Vec, pack: Pack): string {
  return describe(state, pack, cell);
}

export { reduce, options, buildAction };
export type { ActionOption, TargetRef };

export const engine: EngineApi = { createGame, reduce, reachable, options, buildAction, controlled, describeTile };
export default engine;
