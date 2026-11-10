# Family RPG — Hearthside / Sleighbound

A light, co-op tabletop RPG for 2–8 players (ages 6+), built for a browser 3D virtual tabletop.

- **Hearthside** — the theme-agnostic core rules engine.
- **Sleighbound** — the first theme pack (Christmas): recover the stolen Star and six lost presents before Midnight.

**Play:** https://rakentaja.github.io/familyrpg/ — the 3D table is the game. No turns: tap your hero, tap the table to
walk, tap a foe to get a roll ready and flick the dice; hold (or right-click) anything for more options. A Guide (usually
a parent) moves the foes and tells the story. Installable on phones, works offline after the first load. Play together on
your own phones with a table code/QR (encrypted, over public Nostr relays) or pass-and-play on one device.
Design: `docs/rewrite-plan.md`.

## What's here

```
game/                       The game (TypeScript, three.js, Bun)
  src/rules/                Rules helper: pure reducer (no turns, soft rules), nav/pathing, rolls, effects DSL, tests
  src/scene/                three.js table: dioramas, minis, bubbles, in-scene meters, tap/hold/drag input,
                            camera, flick-to-throw physics dice (cannon-es) with replay
  src/ui/                   Thin layer: home, lobby, hero creator, ring menu, roll card, corner strip, table moments
  src/net/                  Multiplayer over public Nostr relays (encrypted), plus local pass-and-play
  packs/sleighbound.json    The Sleighbound pack (hearthside@2): roles, foes, items, events, 4 free-form scenes, endings
  public/                   PWA manifest, service worker template, icons
docs/                       Game design, player's handbook, asset pipeline notes
assets/
  characters/               13 game-ready character GLBs (1K WebP, meshopt); rigged bipeds embed `idle`
  animations/               walk/run + retargeted Mixamo clips per character (`sb_<char>_mx_<clip>.glb`)
  props/                    48 low-poly props built in Blender
tools/
  blender/                  Prop builder, reindeer rig builder
  mixamo/                   Mixamo downloader + retargeter (Mixamo FBX → our rigs)
  palette/                  Palette-snap for character textures
  meshy/                    Meshy API pipeline (credit-capped)
  web/                      Review-page builders
```

## Develop

```bash
cd game
bun install
bun test src            # rules + network unit tests (~1 s)
bun build.ts --serve    # build to game/dist and serve on http://localhost:5173 (and your LAN IP for phones)
```

Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`.

## Tools

```bash
# Props (Blender 5.2)
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_props.py -- --list

# Mixamo clips: download (MIXAMO_TOKEN in .env), then retarget onto a character
python3 tools/mixamo/download.py
/Applications/Blender.app/Contents/MacOS/Blender -b -P tools/mixamo/retarget.py -- \
    --target assets/characters/sb_polar-bear-baker.glb --src assets/mixamo/wave.fbx

# Meshy models (credit-capped)
cp .env.example .env   # add MESHY_API_KEY
python3 tools/meshy/pipeline.py --cap 200 --only <name> [--dry]
```

Animations from Mixamo are used under Adobe's Mixamo terms (baked into the game; raw FBX files are not
redistributed).
