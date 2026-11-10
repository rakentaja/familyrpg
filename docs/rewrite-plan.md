# Sleighbound v2 — rewrite plan

The 3D table is the game. No turns: the family keeps track of whose go it is, like at a real table. The app
draws the scene, rolls and tracks things, and gets out of the way. A **Guide** (usually a parent) is always present.

## 1. Decisions (from the interview, 2026-11-10)

| Topic | Decision |
| --- | --- |
| Rules | **Soft assist.** The game shows ranges, rolls dice, tracks Cheer / Grump / Presents / Midnight / Twinkles and applies results, but **never blocks** anyone. |
| Turns | None. No rounds, no "end turn", no active hero. |
| Guide | **Required**, one per table. Moves foes, sees hidden things, narrates, adjusts anything. Does not also play a hero. |
| Foes | Move **only when the Guide moves them**. |
| Movement | **Free movement, no grid.** Tap to walk (path around obstacles). A faint **4 m ring** around the selected hero is a guide only; walking past it is allowed. |
| Input | **Tap does the obvious, hold (or right-click) opens a ring menu** with every option. Drag on empty space pans. |
| Camera | Pan, rotate, zoom freely; **gentle follow** of your walking hero unless you've moved the camera; double-tap re-centres. |
| Dice | Physical 3D dice you **flick**. Guide setting picks the mode: **pick target → flick** (result applies) · **throw at the target** (nearest thing to where the dice land) · **always free rolls** (Guide applies by hand). |
| Helping | Players say how they help; **the Guide adds +1** (max 2) on the pending roll. |
| Midnight | **Real time + Trouble.** Timer for the whole adventure (~40 min, Guide can pause / adjust), plus jumps on Trouble rolls and some events. |
| HUD | Almost nothing: **meters live in the 3D scene** (clock prop, presents by the tree, Twinkle jar), **hearts / Grump pips float over minis**, **story text as speech bubbles / paper notes in the scene**, one **tiny translucent corner strip** (meters at a glance + menu). |
| Screen | **Phone portrait first**; tablet/desktop scale up. |
| Keep | Adventure 1 content, table moments, online (Nostr) + pass-and-play, rules maths as a helper library. |
| Rollout | Rewrite `game/` on a branch; the live site switches when you're happy. |

## 2. Interaction map

Players (on their own phone, or pass-and-play on one device):

| Gesture on… | Tap / click | Hold / right-click → ring menu |
| --- | --- | --- |
| **Your hero** | Select it (shows 4 m ring, hearts). Several heroes on one device: tap to switch. | Use item · Knack · Give item · Revive friend · Inspect · Free roll |
| **Ground** | Selected hero walks there (path around props). Nothing selected → nothing. | Inspect spot · "Search here" roll |
| **Foe** | Hero walks next to it and **readies a Calm roll** (trait suggested = foe's weakness, swipe the dice to change trait) | Calm with Brave / Clever / Kind · Inspect (blurb, Grump, weakness) |
| **Present / item / clue / exit** | Walk there and pick up / read / use | Inspect · Leave it |
| **Another hero** | Focus / show their hearts | Give item · Revive (if Tuckered Out) · Cookie/heal items |
| **Prop with a story** (cocoa stand, clock, toy pile…) | Walk there and interact (search, use) | Inspect |
| **Empty space** | Deselect | — |
| **Drag** on empty space | Pan · two fingers: pinch-zoom + twist-rotate · mouse wheel zoom, right-drag rotate | |

Dice: when a roll is readied, two dice sit at the bottom edge of the screen. **Flick up** to throw; they tumble across
the 3D table and settle. Result: 9+ success · 6–8 twist · ≤5 Trouble (+1 Twinkle). Then a small bubble offers **Twinkle
options** (reroll / +2 / no twist) if the jar isn't empty — the only button that appears unasked.

Guide (same 3D scene, extra powers — everything by tap/hold/drag):

- **Drag anything**: foes, heroes, tokens. Hold a foe → Grump ± · Calm · Remove · Make it say something.
- **Hidden things** shown ghosted only on the Guide's screen; tap → reveal for everyone.
- **Pending roll** bubble: +1 Help (×2), set/override outcome, write or pick a twist.
- **Meters**: tap the clock prop / presents pile / Twinkle jar to adjust; pause/resume Midnight; set the adventure length.
- **Story**: flip an Event card (shown as a paper card that lands on the table), say a line (speech bubble over any mini),
  **call cameras** (everyone's view glides to a spot), next scene / table moment / ending.
- **Settings**: dice mode, kid mode, read-aloud.

## 3. Screen layout (portrait phone)

```
┌───────────────────────────┐
│ ▢ 🎁3/6  🕰 9:40  ✨4    ≡ │  ← tiny translucent strip (tap = expand meters; ≡ = menu)
│                           │
│        3D TABLE           │  ← everything else: minis, props, speech bubbles,
│   (hearts over minis,     │     clock prop, presents pile, Twinkle jar
│    bubbles, 4 m ring)     │
│                           │
│                ⚀⚁         │  ← dice appear only when a roll is readied (flick up)
└───────────────────────────┘
```

Modal screens remain only where they can't live in 3D: Home / join / lobby (one simple screen), hero creation
(swipe through 3D minis on a turntable), table moments (full-screen, they're real-world games), ending.

## 4. State model (host-authoritative, synced)

Changes from v1 (`game/src/engine/types.ts`):

- Positions become **continuous** `{x, z}` in metres (plus `facing`), no cells. Scene layout = walkable area +
  obstacle shapes (circles/boxes from props) + spawn points. Pathfinding on a hidden fine nav grid (0.25 m).
- Remove `round`, `turn`, `moveLeft`, `acted`, `done`, `active`. Add per-device `selected` (local only, not synced).
- `clock`: `{ startedAt, pausedAt?, elapsedMs, totalMs, troubleSteps }` → displayed Midnight = time + Trouble steps.
- `roll`: `{ id, heroId, trait, target?, mode, help, stage: 'ready'|'thrown'|'settled'|'done', dice?, outcome, twist? }`.
- Guide state: `guideId`, `diceMode`, `hiddenRevealed[]`, `cameraCall?: {at, seq}`, `bubbles[]` (short-lived lines).
- Everything still flows through **intents → reducer** so online and pass-and-play share one path; the reducer
  validates *who* (Guide powers vs player), not *when*.

## 5. Architecture

| Module | Fate |
| --- | --- |
| `engine/` | Becomes **`rules/`**: pure helpers — roll outcome, Grump/weakness maths, effects DSL (items/knacks/events), endings, pack loading. Turn logic, foe AI and enforcement removed. New: continuous ranges, nav grid + A*. |
| `render/` | Becomes **`scene/`** and grows: reuse style (toon/ink/hatch), asset loader, actors, camera (add gentle follow + call-camera). New: picking with hold detection, ring menu (3D-anchored DOM), floating hearts/pips, speech bubbles & paper notes, in-scene meters (clock hand, presents pile, Twinkle jar), 4 m ring, ghosted hidden tokens, **dice physics** (lightweight rigid-body for two cubes; flick → impulse). |
| `ui/` | Shrinks to: home/lobby, hero creator, corner strip, table moments, ending, toasts. Play HUD, sheets, modals deleted. |
| `net/` | Kept. Add a live "drag preview" ephemeral channel (Guide dragging a foe shows on all screens) and dice-throw broadcast. |
| Dice sync | The **thrower's device simulates**, then broadcasts `{rollId, values, path keyframes}`; other devices replay the path. The reducer gets the values (no seed disputes). |

## 6. Content

- Re-lay the **4 scenes** as free-form dioramas (same props, no tiles): Workshop, Frozen Lake (slippery ice areas and
  cracked-ice zones instead of tiles), Rooftops (gaps between roof meshes — fly/leap), Ice Cave (boss + wall).
- Foe behaviours become **Guide hints**: holding a foe shows what it would do ("throws coal at someone within 3 m").
- Events: Guide flips them; effects auto-apply where they're clear (Twinkle +1, spawn Grumplings at the edge…).
- Table moments, endings, items, knacks: reuse pack text; knacks/items with ranges switch to metres.
- Midnight: default 40 min real time for the adventure; Trouble on the lake/boss adds 2 min-equivalents.

## 7. Milestones

1. **Scene & input core** — free movement, tap-to-walk with pathing, hold ring, camera with follow, hearts over minis,
   pass-and-play with a Guide on the same device. *(the feel — review on your phone first)*
2. **Dice** — flick-to-throw physics, the three dice modes, outcomes, Twinkle options, Guide help/override.
3. **Guide tools** — drag anything, hidden things, bubbles, event cards on the table, call camera, meter props,
   real-time Midnight with pause.
4. **Online** — Nostr sync of the new state, drag previews, dice replays, join flow & lobby (one screen).
5. **Content** — 4 scenes re-laid, events, items/knacks in metres, table moments, ending.
6. **Polish** — sounds, read-aloud, kid mode, performance on mid-range phones, PWA update flow, deploy.

Each milestone ends with a build you test by hand on your phone (no long automated runs).

## 8. Open questions for later

- Hero creation: keep trait points (Brave/Clever/Kind 1–3) or simplify further for 6-year-olds?
- Should a Tuckered Out hero be playable at all (e.g. can still cheer others on)?
- Sound/music direction.
