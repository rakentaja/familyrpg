// v2 module boundaries. main.ts wires them together. See docs/rewrite-plan.md.
import type { Action, Envelope, FxEvent, GameState, Hit, Option, P, Pack, TargetRef } from './rules/types';
import type { RollStakes } from './rules/rolls';

// ---------------------------------------------------------------- rules (src/rules/index.ts) — pure, no DOM
export interface RulesApi {
  createGame(pack: Pack, opts: { hostId: string; hostName: string; hostColor: string; at: number; seed?: number; adventureId?: string; adventure?: import('./rules/types').Adventure }): GameState;
  /** Apply one intent. Never throws; {ok:false,error} leaves state untouched. Validates WHO (owner / Guide / host), not WHEN. */
  reduce(state: GameState, env: Envelope, pack: Pack): { ok: boolean; error?: string; state: GameState };
  /** Path from a point to a point on the current scene's nav grid (around obstacles); last point may be the nearest reachable. */
  path(state: GameState, from: P, to: P, pack: Pack, opts?: { fly?: boolean }): P[];
  /** What tapping (primary) / holding (all) on something offers to this player, given their selected hero. */
  options(state: GameState, me: string, heroId: string | null, hit: Hit, pack: Pack): Option[];
  buildAction(state: GameState, me: string, heroId: string, option: Option, target: TargetRef, pack: Pack): Action | null;
  controlled(state: GameState, playerId: string): string[];      // hero ids this player may move
  isGuide(state: GameState, playerId: string): boolean;
  midnight(state: GameState, now: number): number;               // 0..12 (fractional)
  describe(state: GameState, hit: Hit, pack: Pack, asGuide: boolean): string; // inspect text
  /** Nav/ground helpers for the scene (same data the reducer uses). */
  groundAt(state: GameState, p: P, pack: Pack): string;          // AreaKind (or 'solid:<kind>')
  /** What each outcome of the pending roll would do, in plain words (for the roll card). */
  stakes(state: GameState, pack: Pack): RollStakes | null;
}

// ---------------------------------------------------------------- scene (src/scene/scene.ts) — three.js, the main screen
export interface SceneCallbacks {
  onTap(hit: Hit): void;
  onHold(hit: Hit, screen: { x: number; y: number }): void;      // long-press ≥450 ms or right-click
  /** Guide drag of a hero/foe/token: start → moves (preview) → end. Scene only starts a drag if canDrag(hit) is true. */
  canDrag(hit: Hit): boolean;
  onDrag(hit: Hit, at: P, phase: 'start' | 'move' | 'end'): void;
  onDiceThrown(t: DiceThrow): void;                               // local flick finished (values decided by physics)
}
export interface DiceThrow { rollId: string; values: [number, number]; land: P; frames: number[] /* packed keyframes for replay */ }
export interface LocalView {
  me: string; isGuide: boolean;
  selectedHeroId: string | null;                                  // shows the 4 m ring + path preview
  myHeroIds: string[];
  preview?: { kind: 'hero' | 'foe' | 'token'; id: string; at: P } | null; // remote drag preview
}
export interface SceneView {
  load(pack: Pack, baseUrl: string, onProgress?: (p: number) => void): Promise<void>;
  update(state: GameState, prev: GameState | null, fx: FxEvent[]): void;  // idempotent; plays fx
  setLocal(v: LocalView): void;
  /** Dice: show two dice at the bottom edge ready to flick for this roll; the scene handles the flick + physics. */
  armDice(rollId: string, trait: string, bonus: number): void;
  disarmDice(): void;
  replayDice(t: DiceThrow): Promise<void>;                        // other devices replay a throw
  focus(target: P | { heroId: string }): void;
  worldToScreen(p: P, y?: number): { x: number; y: number; visible: boolean };
  setInsets(top: number, bottom: number): void;
  /** Armed dice centre in px above the canvas bottom; null = default. */
  setDiceY(px: number | null): void;
  /** Picture of a model for the library (data URL), or null. */
  thumbnail(model: string): Promise<string | null>;
  /** Live preview of a turn / size / height change (null = back to the state). */
  previewPiece(what: 'prop' | 'foe' | 'token', id: string, v: { rot?: number; scale?: number; y?: number } | null): void;
  setQuality(q: 'low' | 'high'): void;
  resize(): void; dispose(): void;
}
export type CreateScene = (canvas: HTMLCanvasElement, cb: SceneCallbacks) => SceneView;

// ---------------------------------------------------------------- network (src/net/*) — kept from v1
export interface Peer { id: string; name?: string; lastSeen: number }
export interface RoomInfo { roomId: string; secret: string; link: string; isHost: boolean; myId: string }
export interface NetApi {
  readonly myId: string; readonly info: RoomInfo | null; readonly status: 'offline' | 'connecting' | 'online';
  host(): Promise<RoomInfo>; join(code: string): Promise<RoomInfo>; claimHost(): Promise<void>;
  sendIntent(env: Envelope): void; publishState(state: GameState): void;
  sendEphemeral(channel: string, data: unknown): void;             // channels: 'drag', 'dice', 'draw', 'err', 'ping'
  onIntent(cb: (env: Envelope) => void): () => void;
  onState(cb: (state: GameState) => void): () => void;
  onEphemeral(cb: (channel: string, data: unknown, from: string) => void): () => void;
  onPeers(cb: (peers: Peer[]) => void): () => void;
  onStatus(cb: (s: NetApi['status']) => void): () => void;
  leave(): void;
}

// ---------------------------------------------------------------- store (src/store.ts)
export interface Store {
  readonly pack: Pack; readonly me: string;
  state: GameState | null;
  dispatch(a: Action): void;                                       // stamps by + at; host/local reduce+publish, client sends intent
  subscribe(cb: (s: GameState, prev: GameState | null) => void): () => void;
  isHost(): boolean;
}
