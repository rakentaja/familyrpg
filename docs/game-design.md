# Hearthside — Family VTT RPG

A light, co-op tabletop RPG for 2–8 players (ages 6+), built for a browser VTT: grid, minis, one dice type, 30–45 minute sessions. **Hearthside** is the theme-agnostic core; **Sleighbound** is the first theme pack (Christmas).

## 1. Design pillars

- **Co-op, never PvP.** The table wins or loses together.
- **No one dies.** Heroes get *Tuckered Out* and a friend revives them.
- **Readable by a 6-year-old.** One die type (d6), three traits, small numbers.
- **Short.** 3–4 scenes, ~10 min each. A clock keeps tension.
- **Modular.** Every theme-specific noun lives in a pack file; the core never names them.

## 2. Core rules (Hearthside engine)

### Players

- 1 **Guide** (GM) + 1–7 **Heroes**. An older kid can co-Guide.
- **Guide-less mode:** the Event deck and scene cards run the game; players take turns reading.

### Heroes

- **Traits:** Brave, Clever, Kind. Split 6 points, each 1–3.
- **Hearts:** 3. At 0 → Tuckered Out (lie the mini down). An adjacent hero spends their action to revive with 1 Heart.
- **Role:** from the theme pack. Gives one **Knack** (special ability, once per scene) and a starting item.
- **Pocket:** carry 3 item cards.

### Rolling

Roll **2d6 + trait**. The trait is fixed by what you do — no choosing:

| Action | Trait |
| --- | --- |
| Attack a foe, leap a gap, cross cracked ice | Brave |
| Search, use a rolled item | Clever |
| Heal a hurt friend (or yourself) | Kind |
| Free roll (anything else the Guide allows) | pick one |

| Result | Outcome |
| --- | --- |
| 10+ | Strong hit — 2 damage / 2 Hearts healed |
| 7–9 | Hit — 1 damage / 1 Heart healed / it works |
| 6 or less | Miss — an attacked foe hits back (−1 Heart), a missed leap hurts (−1 Heart); a missed search or heal costs nothing. Team gains 1 **Spark** |

- **Help:** the Guide can add +1 per helping hero. Max 2.
- **Sparks:** shared team pool. Spend 1 to reroll or add +2. Missing *feeds* the pool, so bad rolls still feel useful.

### Turns on the grid

- Each round: every hero takes a turn (any order the table agrees on), then the Guide's foes act, then flip 1 **Event card**.
- Turn = **Move 4 squares + 1 Action** (roll, use item, help, revive, interact).
- Foes have **Hearts**, like heroes. A hit takes 1, a strong hit 2. At 0 the foe is **knocked out**: it falls over and vanishes, dropping anything it carried.

### Meters (shown on the VTT HUD)

- **Goal meter** — what the team is filling (e.g. presents recovered).
- **Clock** — 12 segments. Advances 1 per round and on some Trouble results. Hitting 12 ends the adventure.
- Partial wins: the ending scales with how full the Goal meter is. Every ending is happy; some are just happier.

### Scaling for 2–8 players

| Heroes | Spark pool start | Foe Hearts | Clock advance |
| --- | --- | --- | --- |
| 1–2 | +2 bonus | ×1 | 1 per round |
| 3–5 | standard | ×1.5 (round up) | 1 per round |
| 6–7 | standard | ×2 | 1 per round; scene may split into 2 squads on the map |

### Scene types

- **Explore** — move around a map, find things, talk to characters.
- **Challenge** — a puzzle or hazard with a mini-meter (e.g. 4 successes to cross the ice).
- **Showdown** — foes to knock out. Boss showdowns have phases.
- **Table moment** (optional, between scenes) — a real-world mini-game: charades, draw-it, hum-a-tune. Winning grants Sparks.

## 3. Theme pack architecture

A pack is a versioned JSON manifest + assets. The engine reads only the manifest; nothing theme-specific is hardcoded.

| Slot | What the pack supplies |
| --- | --- |
| `meta` | id, name, version, age rating, author |
| `labels` | Optional renames for traits, Hearts, Sparks, Goal, Clock |
| `roles[]` | Name, description, Knack, starting item, mini model |
| `items[]` | Item deck: name, effect, count |
| `foes[]` | Name, Hearts, move, behaviour, model |
| `tiles[]` | Map tiles / locations, terrain rules, models |
| `events[]` | Event deck cards |
| `adventures[]` | Ordered scenes, each with map, setup, goal, win/lose text |
| `tableMoments[]` | Mini-game prompts |
| `assets` | 3D models, textures, music, SFX (hash-addressed) |

```json
{
  "meta": { "id": "sleighbound", "version": "0.1.0", "engine": "hearthside@1" },
  "labels": { "hearts": "Hearts", "sparks": "Twinkles", "goal": "Presents", "clock": "Midnight" },
  "roles": [{ "id": "reindeer-flyer", "knack": "fly", "start": "harness-bell", "model": "sha256:…" }],
  "foes": [{ "id": "grumpling", "hearts": 1, "move": 4 }]
}
```

**Effects DSL:** Knacks, items and events use a small set of verbs — `move`, `heal`, `addSpark`, `addGoal`, `advanceClock`, `hitFoes`, `pull`, `push`, `reveal`, `spawn`, `bonus(trait,n)`. A new theme should need zero engine code; only new verbs need an engine release.

**VTT fit:** pack manifest published as a Nostr event, assets on Blossom by hash; table state (positions, meters, decks) syncs over relays. Load a pack by pasting its event id.

## 4. Christmas pack: *Sleighbound*

### Premise

It's Christmas Eve. **Grumbleweed, the Winter Troll**, snatched the Star from the top of the North Pole tree, and without it the sleigh can't find its way. His Grumplings scattered the night's presents across the snow. The heroes must recover the presents and return the Star before Midnight.

### Labels

Hearts → **Hearts** · Sparks → **Twinkles** · Goal → **Presents** (0–6) · Clock → **Midnight**

### Roles (7)

| Role | Knack (once per scene) | Starts with |
| --- | --- | --- |
| Reindeer Flyer | **Fly:** move 8, over anything, carrying one ally | Harness bell |
| Snow Sprite | **Freeze:** turn water to ice or stop a foe for a round | Snowflake charm |
| Gingerbread Scout | **Crumb trail:** teleport back to any square you've visited this scene | Gumdrop |
| Toy Soldier | **Stand guard:** allies next to you can't lose Hearts this round | Drum |
| Carol Singer | **Sing:** every ally in 3 squares regains 1 Heart | Songbook |
| Polar Bear Baker | **Cookie break:** hand out 2 Cookie items | Rolling pin |
| Star Keeper | **Shine:** reveal hidden things in 4 squares; foes lose 1 Heart | Lantern |

### Foes

| Foe | Hearts | Behaviour |
| --- | --- | --- |
| Grumpling | 1 | Grabs presents, runs away |
| Coal Imp | 2 | Throws coal: −1 Heart at range 3 |
| Wind-up Rat | 1 | Moves 6, always in packs of 3 |
| Blizzard Wisp | 2 | Pushes heroes 2 squares |
| Snow Golem | 4 | Slow (move 2), blocks paths |
| **Grumbleweed** (boss) | 8 | 3 phases: throws snowballs → summons Grumplings → hides behind an ice wall |

Knock out Grumbleweed to take back the Star.

### Items (sample deck)

- **Hot Cocoa** ×4 — regain 2 Hearts.
- **Cookie** ×4 — regain 1 Heart, give it to an adjacent ally if you like.
- **Snowball** ×5 — tag a foe at range 4: 1 damage on a 6+.
- **Candy Cane Hook** ×2 — pull a hero, foe or present 3 squares toward you.
- **Jingle Bell** ×2 — all allies move +2 this round.
- **Mystery Present** ×3 — draw 2 items, keep one.
- **Sled** ×1 — move 10 in a straight line, downhill only.

### Event deck: *Blizzard* (sample)

- **Gust** — everyone slides 1 square in the wind's direction.
- **Grumpling ambush** — spawn 2 Grumplings at the map edge.
- **Northern lights** — +1 Twinkle.
- **Cocoa stand** — place a Hot Cocoa on a random square.
- **Bells in the distance** — Midnight advances 1 extra.
- **Snow angel** — the next Tuckered Out hero revives for free.
- **Quiet night** — nothing happens. Phew.

### Tiles & locations

Toy Workshop · Candy Cane Forest · Frozen Lake (slippery: slide until you hit something) · Gingerbread Village · Chimney Rooftops (gaps need Fly or a clever plan) · Troll's Ice Cave

### Adventure 1 — *The Night Before* (~40 min)

1. **Workshop Chaos** (Explore) — Wind-up Rats loose in the workshop. Find 2 presents, learn where the Troll went. *Tutorial scene: teaches moving, rolling and helping.*
2. **Frozen Lake** (Challenge) — cross the cracking ice: 4 successes before 3 Troubles. 1 present on an island.
3. **Rooftop Run** (Explore + Showdown) — Coal Imps on the chimneys guard 2 presents.
4. **The Ice Cave** (Boss Showdown) — Grumbleweed and the Star. 1 present is the Troll's own.

**Endings:** Star returned before Midnight = sleigh flies. Presents recovered set how many deliveries succeed (0–6). Inviting Grumbleweed = he pulls the sleigh next year.

### Table moments

- **Wrap it!** — charades of a gift; whoever guesses gains a Twinkle.
- **Draw the ornament** — 30-second drawing on the VTT canvas; the table votes.
- **Hum-a-tune** — hum a well-known Christmas tune; first to name it wins.

## 5. Future theme ideas

- **Sinterklaas** — recover the Pakjesboot's cargo, rooftop horses, pepernoten items.
- **Spooky Halloween** — friendly ghosts, a haunted candy factory.
- **Space Scouts** — stranded crew, asteroid tiles, robot foes.
- **Pirate Cove** — treasure as Goal, tide as Clock.
- **Dragon Valley** — hatch an egg before the volcano wakes.

Each pack only needs: 6–8 roles, 4–6 foes + a boss, ~20 items, ~15 events, 4–6 tiles, one adventure.

## 6. VTT build notes

- **Mobile-first HUD:** Goal meter, Clock, Twinkle pool, and each hero's Hearts always visible; dice button big enough for kids.
- **Grid:** square grid, 1 square ≈ 1 mini base. Tap-to-move with move range highlighted.
- **Auto-rules:** engine applies item/event effects from the DSL; Guide can override anything.
- **Kid mode:** read-aloud card text, icon-only traits, no negative numbers shown.
- **Session flow:** lobby → pick roles → adventure → ending screen with a shareable recap.

## 7. Next steps

1. Playtest the core on paper with the family (one scene, 3 heroes) to tune the 2d6 thresholds.
2. Lock the pack JSON schema and effects DSL v1.
3. Build *Sleighbound* minis and tiles (low-poly, cosy look).
4. Ship Scene 1 as a playable VTT vertical slice before mid-December.
