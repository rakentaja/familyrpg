# Mixamo clips

Gameplay animations (wave, cheer, jump, hit, sleep…) from Mixamo, exported **without skin**
(armature only, `mixamorig:*` bones, T-pose rest, FBX 2019, 30 fps) and then retargeted onto the
Meshy rigs (A-pose, same bone names minus the prefix).

The clip list lives in `animations.json`:

```json
{ "name": "cheer", "query": "cheering", "pick": "Cheering", "inplace": true, "mirror": false }
```

`pick` (optional) is an exact Mixamo product name or a result index. Without it the first `Motion`
whose name equals the query wins, else the first `Motion` result. `inplace` is ignored for clips
where Mixamo does not offer it.

## 1. Token

Sign in at https://www.mixamo.com, open DevTools → Console and run `localStorage.access_token`.
Put the value in the repo's `.env` (gitignored), never in a committed file:

```
MIXAMO_TOKEN=eyJ...
```

or `export MIXAMO_TOKEN=...` for the shell. Tokens expire after a while; a 401 means: sign in again
and refresh it.

## 2a. Download with Python (stdlib only)

```sh
python3 tools/mixamo/download.py --list "sleeping"     # inspect search results / names
python3 tools/mixamo/download.py --dry-run             # plan; with a token also shows picks + payloads
python3 tools/mixamo/download.py                       # everything → assets/mixamo/<name>.fbx
python3 tools/mixamo/download.py --only cheer,wave --force
```

Other flags: `--character-id UUID` (default: your primary character), `--delay 6` (seconds
between clips; exports run one at a time per character), `--timeout 300`, `--manifest`, `--out`.
Existing files are skipped unless `--force`. `assets/mixamo/index.json` records the Mixamo product
id/name, export settings and duration/frames when the API reports them.

## 2b. Download from the browser

If the API refuses non-browser requests, paste `browser_export.js` into the console of the
signed-in mixamo.com tab, then:

```js
await sbMixamoExport()                         // default list (same as animations.json)
await sbMixamoExport([{ name: "wave", query: "waving" }])
await sbMixamoExport(null, { dryRun: true })
```

Files land in the browser's download folder as `<name>.fbx`; move them to `assets/mixamo/`.
Allow "multiple downloads" if Chrome asks.

## 3. Retarget

`tools/mixamo/retarget.py` (separate script) maps the T-pose `mixamorig:*` clips onto the A-pose
Meshy rigs: strip the `mixamorig:` prefix, Spine→Spine02, Spine1→Spine01, Spine2→Spine, with
rest-pose compensation. See that script for usage and output paths.
