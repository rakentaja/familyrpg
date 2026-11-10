# Family RPG — Hearthside / Sleighbound

A light, co-op tabletop RPG for 2–8 players (ages 6+), built for a browser 3D virtual tabletop.

- **Hearthside** — the theme-agnostic core rules engine.
- **Sleighbound** — the first theme pack (Christmas): recover the stolen Star and six lost presents before Midnight.

**Play:** https://rakentaja.github.io/familyrpg/ — installable on phones (Add to Home Screen), works offline after the
first load. Host a table and everyone joins on their own phone with a code/QR (multiplayer runs over public Nostr
relays, end-to-end encrypted with the table code), or play pass-and-play on one device.


## What's here

```
game/                       The game (TypeScript, three.js, Bun)
  src/engine/               Hearthside rules engine: pure reducer, seeded RNG, effects DSL, foe AI, tests
  src/render/               three.js board: toon/ink/hatch look, touch camera, minis + animations, dice
  src/ui/                   Mobile-first screens: lobby, hero creator, play HUD, rolls, Guide panel, table moments
  src/net/                  Multiplayer over public Nostr relays (encrypted), plus local pass-and-play
  packs/sleighbound.json    The Sleighbound theme pack: roles, foes, items, events, 4 scenes, endings
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
