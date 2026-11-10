// Hearthside engine — shared contract. Everything theme-specific comes from a Pack; the engine never names
// theme nouns. Render, UI and net code import only from this file (and engine/index.ts for functions).

// ---------------------------------------------------------------- basics
export type Trait = 'brave' | 'clever' | 'kind';
export const TRAITS: Trait[] = ['brave', 'clever', 'kind'];
export interface Vec { x: number; y: number }               // grid cell: x = column, y = row (row 0 = far edge)
export type Dir = 'n' | 'e' | 's' | 'w';

// ---------------------------------------------------------------- pack (theme manifest, JSON)
/** Effects DSL — a small set of verbs. Knacks, items and events are lists of these. */
export type Effect =
  | { do: 'move'; n: number; over?: boolean; carryAlly?: boolean; line?: boolean } // extra/special movement for the actor (over = fly to a cell; line = straight dash to a cell)
  | { do: 'teleportVisited' }                                           // jump to any square visited this scene
  | { do: 'heal'; n: number; who: 'self' | 'ally' | 'allies' | 'alliesInRange'; range?: number }
  | { do: 'addSpark'; n: number }
  | { do: 'addGoal'; n: number }
  | { do: 'advanceClock'; n: number }
  | { do: 'removeGrump'; n: number; who: 'target' | 'foesInRange' | 'allFoes'; range?: number; on?: number } // on = min 2d6 roll needed
  | { do: 'pull'; n: number; range: number }                           // pull target (hero/foe/token) toward actor
  | { do: 'push'; n: number; who: 'target' | 'heroesInRange'; range?: number }
  | { do: 'slideAll'; n: number }                                      // everyone slides n in the event's wind dir
  | { do: 'reveal'; range: number }                                    // reveal hidden tokens in range
  | { do: 'spawn'; foe: string; n: number; at: 'edge' | 'near' | 'spawnPoints' }
  | { do: 'placeItem'; item: string; at: 'random' | 'near' }
  | { do: 'giveItem'; item: string; n: number; who: 'self' | 'allyChoice' | 'adjacentAllies' }
  | { do: 'drawItems'; n: number; keep: number }
  | { do: 'bonus'; trait: Trait | 'any'; n: number; rounds?: number }
  | { do: 'moveBonusAll'; n: number }                                  // all allies move +n this round
  | { do: 'freeze'; what: 'water' | 'foe'; range?: number; rounds?: number }
  | { do: 'guard'; rounds: number }                                    // allies adjacent can't lose hearts
  | { do: 'freeRevive' }                                               // next tuckered hero revives free
  | { do: 'nothing' };

export interface PackRole {
  id: string; name: string; blurb: string; model: string;              // model = key into pack.models
  knack: { id: string; name: string; text: string; target?: TargetKind; effects: Effect[] };
  start: string;                                                       // item id
  suggested: Record<Trait, number>;
}
export type TargetKind = 'none' | 'cell' | 'foe' | 'hero' | 'token' | 'any';
export interface PackItem { id: string; name: string; text: string; count: number; target?: TargetKind; effects: Effect[]; icon?: string; model?: string }
export interface PackFoe {
  id: string; name: string; blurb: string; grump: number; move: number; weak: Trait;
  behaviour: 'grabAndRun' | 'throwRange' | 'swarm' | 'pushHeroes' | 'blocker' | 'boss';
  range?: number; model: string; scale?: number; boss?: { phases: { name: string; text: string; atGrump: number; behaviour: PackFoe['behaviour']; summon?: string }[]; kindFinish: boolean };
}
export interface PackTile {
  id: string; char: string; name: string;                              // char = map legend character
  walk: boolean; flyOnly?: boolean; slippery?: boolean; water?: boolean; blocks?: boolean; // blocks = blocks line/flying? (walls)
  hazard?: 'crack';                                                    // stepping on needs a roll in challenge scenes
  model?: string; color?: string;                                      // floor model and/or fallback colour
}
export interface PackEvent { id: string; name: string; text: string; count: number; effects: Effect[] }
export interface ScenePlacement { model: string; x: number; y: number; rot?: number; scale?: number }
export interface SceneToken { kind: 'goal' | 'item' | 'star' | 'clue' | 'npc' | 'exit'; x: number; y: number; item?: string; hidden?: boolean; guardedBy?: string; label?: string; text?: string }
export interface SceneFoe { foe: string; x: number; y: number; carrying?: number /* index into tokens */ }
export interface PackScene {
  id: string; name: string; type: 'explore' | 'challenge' | 'showdown' | 'boss';
  intro: string;                                                       // read-aloud text
  map: string[];                                                       // rows of legend chars (row 0 = far)
  props: ScenePlacement[];
  start: Vec[];                                                        // hero start squares
  foes: SceneFoe[];
  tokens: SceneToken[];
  spawnPoints?: Vec[];
  goal: {
    text: string;
    /** scene ends (success) when all listed conditions hold */
    collectGoal?: number;                                              // goal tokens to pick up in this scene
    reachExit?: boolean;                                               // all non-tuckered heroes on 'exit' tokens/tiles
    calmAll?: boolean;                                                 // all foes calmed
    challenge?: { need: number; maxTrouble: number; trait?: Trait; text: string }; // mini meter
    bossKindFinish?: boolean;
  };
  win: string; lose?: string;                                          // read-aloud outcome text
  twists?: string[];                                                   // scene-specific twist lines
  tableMomentAfter?: string;                                           // tableMoment id offered after this scene
  troubleClock?: number;                                               // extra clock steps on a Trouble roll in this scene (default 0)
}
export interface PackTableMoment {
  id: string; name: string; kind: 'charades' | 'draw' | 'hum';
  text: string;                                                        // how to play (read aloud)
  prompts: string[];                                                   // secret prompts (one is dealt to the performer)
  seconds: number; reward: number;                                     // sparks for the winner
}
export interface Pack {
  meta: { id: string; name: string; version: string; engine: 'hearthside@1'; ageRating?: string; author?: string };
  labels: { hearts: string; sparks: string; goal: string; clock: string; traits: Record<Trait, string>; heroes: string; foes: string; tuckered: string; calmed: string };
  theme: { title: string; subtitle: string; premise: string; palette: Record<string, string>; font?: string };
  models: Record<string, { url: string; scale?: number; rot?: number; anim?: Record<string, string> }>;
  // anim: clip name -> url of an animation GLB, or '@model' for clips embedded in the model GLB
  roles: PackRole[];
  items: PackItem[];
  foes: PackFoe[];
  tiles: PackTile[];
  events: PackEvent[];
  twists: string[];                                                    // generic twist lines (Guide-less)
  adventures: { id: string; name: string; blurb: string; goalMax: number; clockMax: number; clockEvery?: number /* rounds per clock step, default 1 */; scenes: PackScene[]; endings: { id: string; when: string; text: string }[] }[];
  tableMoments: PackTableMoment[];
}

// ---------------------------------------------------------------- live game state (host-authoritative, synced)
export type Mode = 'guide' | 'guideless';
export type Phase = 'lobby' | 'intro' | 'play' | 'sceneEnd' | 'tableMoment' | 'ending';

export interface Player {
  id: string;            // device id (nostr pubkey hex, or 'local')
  name: string; color: string;
  guide?: boolean;       // this player is the Guide (guide mode)
  host?: boolean;        // authoritative device
  online?: boolean;
}
export interface Hero {
  id: string; roleId: string; name: string; owner: string;            // owner = Player.id controlling it
  traits: Record<Trait, number>;
  hearts: number; maxHearts: number; tuckered: boolean;
  pos: Vec; pocket: string[];                                          // item ids, max 3
  knackUsed: boolean;
  moveLeft: number; acted: boolean; done: boolean;                     // per turn
  visited: Vec[];                                                      // this scene (for teleportVisited)
  status: { guardRounds?: number; moveBonus?: number; bonus?: { trait: Trait | 'any'; n: number; rounds: number } };
}
export interface Foe {
  uid: string; foe: string;                                            // foe = PackFoe.id
  pos: Vec; grump: number; maxGrump: number; calmed: boolean;
  frozen?: number;                                                     // rounds left
  carrying?: string;                                                   // token uid
  phase?: number;                                                      // boss phase index
}
export interface Token {
  uid: string; kind: SceneToken['kind']; pos: Vec | null;              // null = carried
  item?: string; hidden?: boolean; label?: string; text?: string; carriedBy?: string;
  guardedBy?: string;                                                  // PackFoe id: can't be picked up while one is within 3 squares
}
export type RollPurpose =
  | { kind: 'calm'; foeUid: string }                                   // reduce Grump (2 on 9+ with weak trait)
  | { kind: 'challenge'; cell?: Vec }                                  // challenge scene mini-meter / cross crack; cell = landing square when leaping a gap
  | { kind: 'search'; cell: Vec }                                      // look for hidden things
  | { kind: 'free'; text: string }                                     // anything else (Guide adjudicates)
  | { kind: 'item'; item: string; target?: TargetRef };                // item effect with 'on'
export type TargetRef = { foeUid?: string; heroId?: string; tokenUid?: string; cell?: Vec };
export interface PendingRoll {
  id: string; heroId: string; trait: Trait; purpose: RollPurpose;
  helpers: string[];                                                   // hero ids, max 2
  dice?: [number, number]; bonus: number;                              // trait + helpers + sparks + status
  total?: number; outcome?: 'success' | 'twist' | 'trouble';
  sparkUsed?: ('reroll' | 'plus2' | 'ignoreTwist')[];
  twist?: string;                                                      // text, chosen by Guide or drawn
  stage: 'gather' | 'rolled' | 'resolved';                             // gather helpers → rolled → resolved
}
export interface PendingChoice {                                        // engine needs a decision (e.g. drawItems keep 1)
  id: string; heroId: string; prompt: string; options: { label: string; value: string }[];
}
export interface TableMomentState {
  id: string; performer: string /* player id */; prompt?: string /* only meaningful to performer UI; kept in state */;
  endsAt?: number; votes: Record<string, string>; winner?: string; stage: 'ready' | 'performing' | 'voting' | 'done';
}
export interface LogEntry { n: number; text: string; kind?: 'roll' | 'event' | 'scene' | 'info' | 'twist' | 'good' | 'bad' }
export interface FxEvent {                                              // transient: what just happened, for animation
  k: 'move' | 'dice' | 'anim' | 'say' | 'grump' | 'calm' | 'pickup' | 'spawn' | 'event' | 'scene' | 'heal' | 'hurt' | 'tuck' | 'revive' | 'spark' | 'clock' | 'goal' | 'push';
  id?: string;                                                          // hero id / foe uid / token uid
  path?: Vec[]; dice?: [number, number]; clip?: string; text?: string; n?: number;
}
export interface GameState {
  v: number;                                                            // increments on every applied action
  seed: number;                                                         // rng state (mulberry32)
  packId: string; adventureId: string; mode: Mode; kidMode: boolean;
  phase: Phase;
  players: Player[];
  heroes: Hero[];
  foes: Foe[];
  tokens: Token[];
  scene: {
    index: number; id: string;
    w: number; h: number; tiles: string[];                              // tile ids, row-major, length w*h
    challenge?: { success: number; trouble: number; need: number; maxTrouble: number };
    frozenWater: string[];                                              // "x,y" cells turned to ice
    flags: Record<string, number | boolean | string>;
    result?: 'won' | 'lost';
  };
  round: number;
  turn: { stage: 'heroes' | 'foes' | 'event'; active?: string /* hero id currently acting */ };
  meters: { sparks: number; goal: number; goalMax: number; clock: number; clockMax: number };
  deck: { items: string[]; events: string[] };                          // remaining draw piles (ids)
  pending?: PendingRoll;
  choice?: PendingChoice;
  event?: { id: string; name: string; text: string; round: number };    // last flipped event card
  tableMoment?: TableMomentState;
  freeRevive?: boolean; moveBonusAll?: number;
  ending?: { id: string; text: string; goal: number; star: boolean; invited: boolean };
  log: LogEntry[];                                                      // last ~60 entries
  fx: { seq: number; list: FxEvent[] };                                 // fx produced by the last action
}

// ---------------------------------------------------------------- actions (intents). Envelope adds `by` (player id).
export type Action =
  | { t: 'join'; name: string; color: string }
  | { t: 'leave' }
  | { t: 'setMode'; mode: Mode }
  | { t: 'setGuide'; playerId: string; on: boolean }
  | { t: 'setKidMode'; on: boolean }
  | { t: 'addHero'; roleId: string; name: string; traits: Record<Trait, number>; owner?: string }
  | { t: 'removeHero'; heroId: string }
  | { t: 'assignHero'; heroId: string; owner: string }
  | { t: 'start' }                                                      // lobby → intro of scene 0
  | { t: 'beginScene' }                                                 // intro → play
  | { t: 'select'; heroId: string }                                     // make hero the active one
  | { t: 'move'; heroId: string; to: Vec }
  | { t: 'startRoll'; heroId: string; trait: Trait; purpose: RollPurpose }
  | { t: 'help'; rollId: string; heroId: string }
  | { t: 'unhelp'; rollId: string; heroId: string }
  | { t: 'roll'; rollId: string }
  | { t: 'spark'; rollId: string; use: 'reroll' | 'plus2' | 'ignoreTwist' }
  | { t: 'setTwist'; rollId: string; text: string }                    // Guide writes/picks the twist
  | { t: 'resolve'; rollId: string }                                    // apply outcome, close the roll
  | { t: 'cancelRoll'; rollId: string }                                 // only in 'gather'
  | { t: 'useItem'; heroId: string; index: number; target?: TargetRef }
  | { t: 'giveItem'; heroId: string; index: number; toHeroId: string }
  | { t: 'useKnack'; heroId: string; target?: TargetRef }
  | { t: 'revive'; heroId: string; targetId: string }
  | { t: 'interact'; heroId: string; tokenUid: string }                 // pick up / talk / open
  | { t: 'choose'; choiceId: string; value: string }
  | { t: 'endTurn'; heroId: string }
  | { t: 'next' }                                                       // advance sceneEnd → tableMoment/intro, ending
  | { t: 'tm'; op: 'start' | 'begin' | 'vote' | 'finish' | 'skip'; performer?: string; vote?: string; winner?: string; at?: number } // at = ms timestamp (begin)
  | { t: 'guide'; op: GuideOp };
export type GuideOp =
  | { k: 'moveFoe'; uid: string; to: Vec }
  | { k: 'grump'; uid: string; delta: number }
  | { k: 'hearts'; heroId: string; delta: number }
  | { k: 'meter'; meter: 'sparks' | 'goal' | 'clock'; delta: number }
  | { k: 'flipEvent' }
  | { k: 'spawn'; foe: string; at: Vec }
  | { k: 'outcome'; rollId: string; outcome: 'success' | 'twist' | 'trouble' }
  | { k: 'endScene'; result: 'won' | 'lost' }
  | { k: 'foesTurn' }                                                   // run foe AI now (or skip it)
  | { k: 'say'; text: string };
export type Envelope = Action & { by: string };

/** A menu entry the UI can show for the active hero. */
export interface ActionOption {
  id: string; label: string; icon: string; hint?: string;
  kind: 'roll' | 'item' | 'knack' | 'revive' | 'interact' | 'help' | 'end' | 'give';
  trait?: Trait;                                                        // suggested trait for rolls
  action?: Action;                                                      // ready-to-dispatch (no target needed)
  needs?: TargetKind;                                                   // UI must ask for a target first
  targets?: TargetRef[];                                                // legal targets (to highlight)
  build?: string;                                                       // opaque key the UI passes back to engine.buildAction
}
