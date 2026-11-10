// Sleighbound v2 — shared contract (see docs/rewrite-plan.md).
// No turns, no grid. Positions are metres on the table plane {x, z}. A Guide is always present.
// Everything theme-specific comes from the pack; rules/ never names theme nouns.

export type Trait = 'brave' | 'clever' | 'kind';
export const TRAITS: Trait[] = ['brave', 'clever', 'kind'];
export interface P { x: number; z: number }                         // table position, metres; +z = towards default camera

// ---------------------------------------------------------------- pack (JSON)
/** Effects DSL. Ranges/distances are metres. */
export type Effect =
  | { do: 'move'; n: number; over?: boolean; carryAlly?: boolean; line?: boolean }   // n metres of extra/special move
  | { do: 'teleportVisited' }
  | { do: 'heal'; n: number; who: 'self' | 'ally' | 'allies' | 'alliesInRange'; range?: number }
  | { do: 'addSpark'; n: number }
  | { do: 'addGoal'; n: number }
  | { do: 'advanceClock'; n: number }                                // n Midnight steps (1 step = 1/12 of the night)
  | { do: 'hitFoes'; n: number; who: 'target' | 'foesInRange' | 'allFoes'; range?: number; on?: number }
  | { do: 'pull'; n: number; range: number }
  | { do: 'push'; n: number; who: 'target' | 'heroesInRange'; range?: number }
  | { do: 'slideAll'; n: number }
  | { do: 'reveal'; range: number }
  | { do: 'spawn'; foe: string; n: number; at: 'edge' | 'near' | 'spawnPoints' }
  | { do: 'placeItem'; item: string; at: 'random' | 'near' }
  | { do: 'giveItem'; item: string; n: number; who: 'self' | 'allyChoice' | 'adjacentAllies' }
  | { do: 'drawItems'; n: number; keep: number }
  | { do: 'bonus'; trait: Trait | 'any'; n: number; rolls?: number } // next n rolls
  | { do: 'moveBonusAll'; n: number }
  | { do: 'freeze'; what: 'water' | 'foe'; range?: number; seconds?: number }
  | { do: 'guard'; seconds: number }
  | { do: 'freeRevive' }
  | { do: 'nothing' };
export type TargetKind = 'none' | 'point' | 'foe' | 'hero' | 'token' | 'any';
export interface PackRole {
  id: string; name: string; blurb: string; model: string; portrait?: string;
  knack: { id: string; name: string; text: string; target?: TargetKind; effects: Effect[] };
  start: string; suggested: Record<Trait, number>;
  flies?: boolean;                                                   // walks over gaps (paths ignore 'gap' areas)
}
export interface PackItem { id: string; name: string; text: string; count: number; target?: TargetKind; effects: Effect[]; icon?: string; model?: string }
export interface PackFoe {
  id: string; name: string; blurb: string; hearts: number; model: string; scale?: number;
  hint: string;                                                      // what it would do — shown to the Guide on hold
  speed?: number;                                                    // walk speed m/s when the Guide moves it
  flies?: boolean;                                                   // paths ignore 'gap' areas
  boss?: { phases: { name: string; text: string; atHearts: number; hint: string }[] };
}
export type AreaKind = 'floor' | 'snow' | 'ice' | 'crack' | 'water' | 'gap' | 'roof' | 'wall';
export interface Area {                                              // ground regions; later areas win where they overlap
  id: string; kind: AreaKind;
  shape: 'rect' | 'circle'; x: number; z: number; w?: number; d?: number; r?: number; rot?: number; // rect = w×d centred at x,z
}
export interface Placement { uid?: string; hidden?: boolean /* only the Guide sees it */; model: string; x: number; z: number; y?: number /* lifted off the floor, m */; rot?: number /* degrees */; scale?: number; block?: number /* blocking radius m, 0 = walk-through; default from footprint */; story?: string /* tap text */; search?: string /* token uid revealed by searching here */ }
export type TokenKind = 'goal' | 'item' | 'star' | 'clue' | 'npc' | 'exit' | 'start';   // start = hero start spot (editor only)
export interface SceneToken { uid: string; kind: TokenKind; x: number; z: number; item?: string; hidden?: boolean; label?: string; text?: string; model?: string }
export interface SceneFoe { uid: string; foe: string; x: number; z: number; rot?: number; hidden?: boolean; carrying?: string /* token uid */ }
export interface PackScene {
  id: string; name: string; type: 'explore' | 'challenge' | 'showdown' | 'boss';
  intro: string;
  size: { w: number; d: number };                                    // table extent in metres, centred on 0,0
  ground: AreaKind;                                                  // default ground
  areas: Area[];
  props: Placement[];
  start: P[];
  foes: SceneFoe[];
  tokens: SceneToken[];
  edges?: P[];                                                       // spawn spots for events
  meters?: { clock?: P; presents?: P; jar?: P };                      // where the in-scene meters stand (defaults: back edge)
  goal: { text: string; collectGoal?: number; reachExit?: boolean; beatAll?: boolean; challenge?: { need: number; maxTrouble: number; text: string }; beatBoss?: boolean };
  win: string; lose?: string; tableMomentAfter?: string;
  troubleClock?: number;                                             // extra Midnight steps on a miss here
}
export interface Adventure { id: string; name: string; blurb: string; goalMax: number; minutes: number; scenes: PackScene[]; endings: { id: string; when: string; text: string }[] }
export interface PackTableMoment { id: string; name: string; kind: 'charades' | 'draw' | 'hum'; text: string; prompts: string[]; seconds: number; reward: number }
export interface PackEvent { id: string; name: string; text: string; count: number; effects: Effect[] }
export interface Pack {
  meta: { id: string; name: string; version: string; engine: 'hearthside@2' };
  labels: { hearts: string; sparks: string; goal: string; clock: string; traits: Record<Trait, string>; heroes: string; foes: string; tuckered: string; down: string; guide: string };
  theme: { title: string; subtitle: string; premise: string; palette: Record<string, string> };
  models: Record<string, { url: string; scale?: number; rot?: number; anim?: Record<string, string>; block?: number /* default blocking radius m for props */ }>;
  roles: PackRole[]; items: PackItem[]; foes: PackFoe[]; events: PackEvent[];
  adventures: Adventure[];
  tableMoments: PackTableMoment[];
  ranges: { move: number; reach: number; help: number };             // metres: move ring (4), interact/attack reach (~1.5), etc.
}

// ---------------------------------------------------------------- live state (host-authoritative, synced)
export type Phase = 'lobby' | 'intro' | 'play' | 'sceneEnd' | 'tableMoment' | 'ending';
export type DiceMode = 'target' | 'throwAt' | 'free';               // pick target → flick · throw at the target · free rolls
export interface Settings { diceMode: DiceMode; kidMode: boolean; readAloud: boolean; minutes: number }
export interface Player { id: string; name: string; color: string; guide?: boolean; host?: boolean }
export interface Hero {
  id: string; roleId: string; name: string; owner: string;
  traits: Record<Trait, number>; hearts: number; maxHearts: number; tuckered: boolean;
  pos: P; facing: number /* radians, 0 = +z */; pocket: string[]; knackUsed: boolean; visited: P[];
  status: { guardUntil?: number; bonus?: { trait: Trait | 'any'; n: number; rolls: number }; moveBonus?: number };
}
export interface Foe { uid: string; foe: string; pos: P; facing: number; hidden?: boolean; hearts: number; maxHearts: number; down: boolean; frozenUntil?: number; carrying?: string; phase?: number }
export interface Token { uid: string; kind: SceneToken['kind']; pos: P | null; item?: string; hidden?: boolean; label?: string; text?: string; model?: string; carriedBy?: string }
export type RollPurpose =
  | { kind: 'attack'; foeUid: string }
  | { kind: 'heal'; heroId: string }
  | { kind: 'challenge'; areaId?: string }
  | { kind: 'search'; at: P; propIndex?: number }
  | { kind: 'item'; item: string; target?: TargetRef }
  | { kind: 'free'; text?: string };
export interface TargetRef { foeUid?: string; heroId?: string; tokenUid?: string; at?: P }
export interface Roll {
  id: string; heroId: string; thrower: string /* player id */; trait: Trait; purpose: RollPurpose;
  help: number;                                                      // 0..2, added by the Guide
  stage: 'ready' | 'thrown' | 'done';
  dice?: [number, number]; total?: number; outcome?: Outcome;
  sparkUsed: ('reroll' | 'plus2')[]; land?: P;
}
/** 10+ strong (attacks: 2 Hearts) · 7–9 success · 6 or less trouble (a miss). */
export type Outcome = 'strong' | 'success' | 'trouble';
export interface Bubble { id: string; who?: string /* hero id / foe uid / token uid, or undefined = narrator note */; text: string; at: number; kind: 'say' | 'story' | 'event' | 'result' | 'hint'; ttl: number /* ms */ }
export interface Clock { totalMs: number; elapsedMs: number; runningSince: number | null; steps: number /* extra Midnight steps from Trouble/events */ }
export interface TableMomentState { id: string; performer: string; prompt?: string; endsAt?: number; votes: Record<string, string>; winner?: string; stage: 'ready' | 'performing' | 'voting' | 'done' }
export interface FxEvent {
  k: 'move' | 'place' | 'dice' | 'anim' | 'say' | 'foeHearts' | 'ko' | 'pickup' | 'reveal' | 'spawn' | 'event' | 'scene' | 'heal' | 'hurt' | 'tuck' | 'revive' | 'spark' | 'clock' | 'goal' | 'push' | 'outcome' | 'camera';
  id?: string; path?: P[]; at?: P; dice?: [number, number]; clip?: string; text?: string; n?: number;
}
export interface GameState {
  v: number; seed: number; now: number;                              // now = timestamp of the last applied action
  packId: string; adventureId: string; settings: Settings;
  adv?: Adventure;                                                   // the adventure being played (a copy the host can edit live)
  mode?: 'edit';                                                     // scene editor: no heroes, no clock, nothing ends the scene
  seq?: number;                                                      // uid counter for pieces the Guide adds
  phase: Phase;
  players: Player[]; heroes: Hero[]; foes: Foe[]; tokens: Token[];
  scene: {
    index: number; id: string;
    solid: string[];                                                 // crack/water area ids made walkable (frozen / mended)
    challenge?: { success: number; trouble: number; need: number; maxTrouble: number };
    flags: Record<string, number | boolean | string>;                // star, bossWall, read:<uid>, …
    result?: 'won' | 'lost';
  };
  meters: { sparks: number; goal: number; goalMax: number };
  clock: Clock;
  deck: { items: string[]; events: string[] };
  roll?: Roll;
  choice?: { id: string; heroId: string; prompt: string; options: { label: string; value: string }[] };
  event?: { id: string; name: string; text: string; at: number };
  bubbles: Bubble[];                                                 // short-lived lines (pruned by time)
  cameraCall?: { at: P; seq: number };
  tableMoment?: TableMomentState;
  freeRevive?: boolean;
  ending?: { id: string; text: string; goal: number; star: boolean };
  log: { n: number; text: string; kind?: string }[];
  fx: { seq: number; list: FxEvent[] };
}

// ---------------------------------------------------------------- intents. Envelope adds `by` (player id) and `at` (ms).
export type Action =
  // lobby
  | { t: 'join'; name: string; color: string }
  | { t: 'leave' }
  | { t: 'setGuide'; playerId: string }
  | { t: 'settings'; patch: Partial<Settings> }
  | { t: 'addHero'; roleId: string; name: string; traits: Record<Trait, number>; owner?: string }
  | { t: 'removeHero'; heroId: string }
  | { t: 'assignHero'; heroId: string; owner: string }
  | { t: 'start' }
  | { t: 'setAdventure'; adv: Adventure }
  | { t: 'edit' }                                                   // host, lobby: open the scene editor on this adventure                            // host, lobby: play a custom / edited adventure
  | { t: 'beginScene' }
  // players (owner of the hero, or the Guide)
  | { t: 'walk'; heroId: string; to: P }                             // reducer paths around obstacles; soft rules, never blocked by range
  | { t: 'interact'; heroId: string; tokenUid?: string; propIndex?: number }
  | { t: 'useItem'; heroId: string; index: number; target?: TargetRef }
  | { t: 'giveItem'; heroId: string; index: number; toHeroId: string }
  | { t: 'useKnack'; heroId: string; target?: TargetRef }
  | { t: 'revive'; heroId: string; targetId: string }
  | { t: 'readyRoll'; heroId: string; trait: Trait; purpose: RollPurpose }
  | { t: 'setRollTrait'; rollId: string; trait: Trait }
  | { t: 'cancelRoll'; rollId: string }
  | { t: 'throw'; rollId: string; dice: [number, number]; land?: P; target?: TargetRef } // values from the thrower's physics
  | { t: 'spark'; rollId: string; use: 'reroll' | 'plus2'; dice?: [number, number] }
  | { t: 'resolve'; rollId: string }
  | { t: 'choose'; choiceId: string; value: string }
  | { t: 'next' }
  | { t: 'tm'; op: 'start' | 'begin' | 'vote' | 'finish' | 'skip'; performer?: string; vote?: string; winner?: string }
  // Guide only
  | { t: 'guide'; op: GuideOp };
export type GuideOp =
  | { k: 'place'; what: 'hero' | 'foe' | 'token' | 'prop'; id: string; to: P; facing?: number }   // drag anything (teleport)
  | { k: 'walkFoe'; uid: string; to: P }                                                  // foe walks (pathing, animated)
  | { k: 'foeHearts'; uid: string; delta: number }
  | { k: 'ko'; uid: string }
  | { k: 'remove'; what: 'foe' | 'token' | 'prop'; id: string }
  | { k: 'spawn'; foe: string; at: P }
  | { k: 'hearts'; heroId: string; delta: number }
  | { k: 'meter'; meter: 'sparks' | 'goal'; delta: number }
  | { k: 'clock'; op: 'pause' | 'resume' | 'step'; delta?: number }                        // step: ± Midnight steps
  | { k: 'reveal'; tokenUid: string }
  | { k: 'help'; rollId: string; delta: number }
  | { k: 'outcome'; rollId: string; outcome: Outcome }
  | { k: 'flipEvent' }
  | { k: 'say'; text: string; who?: string }
  | { k: 'camera'; at: P }
  | { k: 'endScene'; result: 'won' | 'lost' }
  // layout (the host only): new pieces go into the scene's layout too, hidden unless hidden: false
  | { k: 'add'; what: 'prop' | 'foe' | 'token'; at: P; model?: string; foe?: string; kind?: TokenKind; item?: string; label?: string; text?: string; rot?: number; hidden?: boolean }
  | { k: 'edit'; what: 'prop' | 'foe' | 'token'; id: string; rot?: number; scale?: number; y?: number; hidden?: boolean; label?: string; text?: string }
  | { k: 'hideAll'; hidden: boolean }                                                     // show / hide every piece in the scene
  | { k: 'scene'; op: 'goto' | 'add' | 'copy' | 'delete' | 'up' | 'down' | 'set'; index?: number;
      patch?: { name?: string; intro?: string; w?: number; d?: number; ground?: AreaKind; advName?: string; advBlurb?: string } };
export type Envelope = Action & { by: string; at: number };

/** What a hold (ring menu) / tap can do on something, computed by rules for the UI. */
export interface Option {
  id: string; label: string; icon: string; hint?: string;
  action?: Action;                                                   // ready to dispatch
  needs?: TargetKind;                                                // ask for a target first (UI then calls buildAction)
  guideOnly?: boolean; primary?: boolean;                            // primary = what a plain tap does
}
export type Hit =
  | { kind: 'hero'; id: string; at: P }
  | { kind: 'foe'; id: string; at: P }
  | { kind: 'token'; id: string; at: P }
  | { kind: 'prop'; index: number; at: P }
  | { kind: 'meter'; meter: 'clock' | 'goal' | 'sparks'; at: P }
  | { kind: 'ground'; at: P };
