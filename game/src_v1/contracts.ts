// Module boundaries. Each module implements one interface below; main.ts wires them together.
import type { Action, ActionOption, Envelope, FxEvent, GameState, Mode, Pack, TargetRef, Vec } from './engine/types';

// ---------------------------------------------------------------- engine (src/engine/index.ts) — pure, no DOM
export interface EngineApi {
  /** New table in the lobby. hostId becomes a Player with host=true. */
  createGame(pack: Pack, opts: { hostId: string; hostName: string; hostColor: string; mode: Mode; seed?: number; adventureId?: string }): GameState;
  /** Apply one intent. Never throws for bad input: returns { ok:false, error } and the unchanged state.
   *  Validates that env.by may perform it (owner of the hero, Guide, or host). Bumps state.v, sets state.fx. */
  reduce(state: GameState, env: Envelope, pack: Pack): { ok: boolean; error?: string; state: GameState };
  /** Squares the hero can reach this turn, with the path to each (for highlighting + move animation). */
  reachable(state: GameState, heroId: string, pack: Pack): { cell: Vec; path: Vec[] }[];
  /** What the hero can do right now (empty if not their turn / already acted). */
  options(state: GameState, heroId: string, pack: Pack): ActionOption[];
  /** Turn an option that needed a target into an Action. */
  buildAction(state: GameState, heroId: string, option: ActionOption, target: TargetRef | undefined, pack: Pack): Action | null;
  /** Who may act: hero ids controlled by this player (all heroes for host in local/pass-and-play mode). */
  controlled(state: GameState, playerId: string): string[];
  /** Human text for UI. */
  describeTile(state: GameState, cell: Vec, pack: Pack): string;
}

// ---------------------------------------------------------------- renderer (src/render/board.ts) — three.js
export interface BoardCallbacks {
  onCellTap(cell: Vec): void;                 // tap on an empty/any cell
  onHeroTap(heroId: string): void;
  onFoeTap(uid: string): void;
  onTokenTap(uid: string): void;
}
export interface BoardView {
  /** Load models for the pack (shows nothing until a scene is set). baseUrl prefixes pack model urls. */
  load(pack: Pack, baseUrl: string, onProgress?: (p: number) => void): Promise<void>;
  /** Render the current state. prev = previous state (for diffing); fx = animations to play. Idempotent. */
  update(state: GameState, prev: GameState | null, fx: FxEvent[]): void;
  /** Highlight squares (move range, targets). kind changes the colour. Empty array clears. */
  highlight(cells: Vec[], kind: 'move' | 'target' | 'danger' | 'path'): void;
  /** Focus camera on a cell or a hero (smooth). */
  focus(target: Vec | { heroId: string }): void;
  /** Big 3D dice roll animation; resolves when dice settle. */
  rollDice(values: [number, number]): Promise<void>;
  setQuality(q: 'low' | 'high'): void;
  /** Screen space covered by UI (CSS px from the top / bottom of the canvas); the board frames itself in between. */
  setInsets?(top: number, bottom: number): void;
  resize(): void;
  dispose(): void;
}
export type CreateBoard = (canvas: HTMLCanvasElement, cb: BoardCallbacks) => BoardView;

// ---------------------------------------------------------------- network (src/net/*.ts)
export interface Peer { id: string; name?: string; lastSeen: number }
export interface RoomInfo {
  roomId: string; secret: string;             // secret never leaves the URL fragment / local storage
  link: string;                               // full join link: <origin><path>#join=<roomId>.<secret>
  isHost: boolean; myId: string;
}
export interface NetApi {
  readonly myId: string;
  readonly info: RoomInfo | null;
  readonly status: 'offline' | 'connecting' | 'online';
  /** Host a new table. */
  host(): Promise<RoomInfo>;
  /** Join from a link/fragment or a short room code. */
  join(code: string): Promise<RoomInfo>;
  /** Host takes over an existing room (e.g. host device rejoins after reload, or someone claims host). */
  claimHost(): Promise<void>;
  /** client → host */
  sendIntent(env: Envelope): void;
  /** host → everyone. Latest state is also stored on relays so late joiners/rejoiners get it. */
  publishState(state: GameState): void;
  /** Throw-away realtime messages (drawing strokes, pings, emoji). Not stored. */
  sendEphemeral(channel: string, data: unknown): void;
  onIntent(cb: (env: Envelope) => void): () => void;
  onState(cb: (state: GameState) => void): () => void;
  onEphemeral(cb: (channel: string, data: unknown, from: string) => void): () => void;
  onPeers(cb: (peers: Peer[]) => void): () => void;
  onStatus(cb: (s: NetApi['status']) => void): () => void;
  leave(): void;
}

// ---------------------------------------------------------------- store (src/store.ts) — glue, owned by main
export interface Store {
  readonly pack: Pack;
  readonly me: string;                          // my player id
  state: GameState | null;
  dispatch(a: Action): void;                    // host/local: reduce + publish; client: send intent (optimistic UI not needed)
  subscribe(cb: (s: GameState, prev: GameState | null) => void): () => void;
  isHost(): boolean;
}
