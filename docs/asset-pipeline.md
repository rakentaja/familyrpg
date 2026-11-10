# Sleighbound Asset Pipeline & Budget

## What was actually produced (2026-11-10)

| Item | Result | Cost |
| --- | --- | --- |
| 13 clean reference sheets (front/side/back) | `art/reference-sheets/` | ~$0.71 OpenRouter |
| 13 Meshy models (meshy-7.1 multi-image, 2K tex) | `assets/characters-source/*_mesh.glb` | 390 credits |
| 11 rigs (10 biped + 1 quadruped), free walk/run clips | `*_rig.glb`, `*_walk.glb`, `*_run.glb` | 55 credits |
| 10 idle clips (action_id 0) | `*_idle.glb` | 30 credits |
| **Meshy total** | 475 of a 700 cap; ~13 min wall clock, 5 in parallel | **475 credits** |
| 18 Blender props | `assets/props/` | $0 |
| Session image total (styles, sheets, book art, refs) | | ~$2.8 OpenRouter |

| 10 Mixamo clips × 10 bipeds (idle, wave, cheer, clap, jump, victory, hit, throw, pick up, sleep) | `assets/animations/sb_<char>_mx_<clip>.glb` via `tools/mixamo/` | $0 |
| Reindeer re-rig (Blender skeleton, procedural idle/walk/run) | `tools/blender/build_reindeer_rig.py` | $0 |
| 30 more Blender props (set pieces, tokens, tiles) | `assets/props/`, review: `review/props-review.html` | $0 |

Resolved: reindeer rig (Meshy quadruped skeleton was collapsed → rebuilt in Blender); "facing" was the Meshy idle swivelling
the whole body — every biped's default `idle` is now the Mixamo happy idle (old one kept as `idle_look`,
`tools/web/swap_idle.mjs`). Palette snap tool exists (`tools/palette/`), strength not yet chosen (`review/palette-review.html`).

## Original plan

**Budget ceiling: about $50** — Meshy Premium for one month ($40, or $20 with the first-month offer) plus $10 of OpenRouter credit, covering 23 AI-generated models with a 30% retry buffer on Meshy and 50% on images, plus ~40 simple props and tiles built in Blender for $0. The run above was later re-scoped by the user to **≤700 Meshy credits**, characters only.

### Cost recipe per asset (API route, as planned)

| Step | Tool | Credits |
| --- | --- | --- |
| Clean multi-view reference sheet | OpenRouter, Nano Banana 2.1 | ~$0.04–0.055 × up to 3 |
| Mesh + 2K texture | Meshy Multi-Image to 3D | 30 |
| Auto-rig (walk + run included) | Meshy Rigging | 5 |
| Extra animation clip | Meshy Animation | 3 per action |

Meshy pricing references: [plans](https://www.meshy.ai/pricing) · [API pricing](https://docs.meshy.ai/api/pricing) · [web app credits](https://docs.meshy.ai/en/webapp/pricing). In the web app, rigging/animation/remesh are 0 credits.

### Still planned (not yet built)

- **Meshy:** gingerbread villager NPC (character — needs a reference sheet + ~38 credits); gingerbread house variants.
- Everything else on the old list (sleigh, cocoa stand, cave entrance, toy pile, Midnight clock, tokens, tiles, walls) was built in Blender.

## Style rules

- **Palette:** Rose `#D8A7A7` · Sage `#A9BFA0` · Cream `#F2EADB` · Lavender `#B4ABC6` · Ink `#2A2328`.
- **The look lives in the engine:** inverted-hull ink outline, 3-step toon lighting, screen-space cross-hatching in shadows, paper-grain overlay. Meshy textures to be palette-snapped by script so AI and Blender assets match.
- **Scale:** 1 grid square = 1 m; origin at the centre of the feet; front faces +Z (glTF convention).
- **Mobile budget:** ≤150k triangles per scene; textures 1K (WebP now, KTX2 later); meshes meshopt-compressed.
- **Naming:** `sb_<name>.glb` (characters), `sb_<name>_{mesh,rig,idle,walk,run}.glb` (sources).

## Pipeline

1. **Lock the style** — palette, outline width, hatch texture. ✅
2. **Clean reference sheets (OpenRouter)** — white background, flat colour, A-pose, orthographic front/side/back; script crops each view (`art/reference-sheets/views/`). ✅
3. **Generate the mesh (Meshy API)** — multi-image to 3D, meshy-7.1, 2K textures, target polycount, origin at bottom. ✅
4. **Auto-check** — triangle count, proportions vs sheet, turntable render; user picks the keeper. (manual this round)
5. **Clean up (Blender, scripted)** — scale/origin, decimate, palette snap, LOD. ⏳
6. **Rig and animate** — Meshy rig + presets for bipeds; code motion for rat and wisp; reindeer rig fix. ◐
7. **Optimise and export** — gltf-transform (meshopt, WebP/KTX2), glTF validator. ✅ (WebP)
8. **Pack** — sha256 each file, upload to Blossom, add to the pack manifest. ⏳

**Retry rule:** at most 3 generations per asset; after that simplify the design or rebuild in Blender on the Meshy blockout.

## Risks

- **Thin parts** (antlers, ice wings, scarf tails, fur) can come out melted — fallback: generate without them, add as Blender cards. (Came out fine this round.)
- **Quadruped rigs** — reindeer rig scale bug; fix in Blender.
- **Style drift** between AI textures and Blender pieces — shared shader + palette snap; fallback to flat palette materials.
