#!/usr/bin/env python3
"""Build review/props-review.html: every assets/props/sb_*.glb on a labelled grid (toon + ink look).

Usage:  python3 tools/web/build_props_review.py [--out review/props-review.html]
Props are embedded as base64 data URIs, so the page is a single file.
"""
import argparse, base64, json, pathlib, subprocess

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parents[1]
PROPS = REPO / "assets/props"

ORIGINAL = {"tile_snow", "tile_ice", "pine_tree", "candy_cane_tree", "present", "star", "dice", "rock", "crate", "lamp_post",
            "fence", "gingerbread_house", "roof_segment", "chimney", "great_tree", "workbench", "cocoa_mug", "snowball"}
# kind: prop = sits on a snow-tile plinth · tile = is a floor tile · edge = hangs below its origin (lifted onto the plinth) · island = sits in water
GROUPS = [
    ("Buildings & trees", ["great_tree", "gingerbread_house", "roof_segment", "chimney", "pine_tree", "candy_cane_tree", "lamp_post"]),
    ("Set pieces", ["sleigh", "cave_entrance", "cocoa_stand", "midnight_clock", "workshop_door", "shelves", "workbench",
                    "toy_pile", "gumdrop_bush", "fence", "crate", "rock"]),
    ("Walls & edges", ["cave_wall", "boss_ice_wall", "icicles", "roof_gap_edge"]),
    ("Tokens & markers", ["twinkle_token", "star", "present", "present_rose", "present_sage", "present_cream", "present_lavender",
                          "present_gold", "present_ice", "coal_lump", "candy_cane_hook", "jingle_bell", "sled", "dice",
                          "cocoa_mug", "snowball", "crumb_trail", "freeze_overlay"]),
    ("Floor tiles", ["tile_snow", "tile_ice", "cracked_ice_1", "cracked_ice_2", "water_hole", "sticky_path", "island"]),
]
TILES = {"tile_snow", "tile_ice", "cracked_ice_1", "cracked_ice_2", "water_hole", "sticky_path"}
KIND = {**{n: "tile" for n in TILES}, "icicles": "edge", "roof_gap_edge": "edge", "island": "island"}
LABEL = {"cracked_ice_1": "Cracked ice 1", "cracked_ice_2": "Cracked ice 2", "midnight_clock": "Midnight clock",
         "present": "Present (orig.)", "roof_gap_edge": "Roof gap edge"}


def uri(p: pathlib.Path) -> str:
    return "data:model/gltf-binary;base64," + base64.b64encode(p.read_bytes()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "review/props-review.html"))
    a = ap.parse_args()
    files = {p.stem.removeprefix("sb_"): p for p in sorted(PROPS.glob("sb_*.glb"))}
    placed = {n for _, names in GROUPS for n in names}
    groups = [(g, [n for n in names if n in files]) for g, names in GROUPS]
    extra = sorted(set(files) - placed)
    if extra: groups.append(("Other", extra))
    data = dict(groups=[dict(name=g, props=[dict(name=n, label=LABEL.get(n, n.replace("_", " ").capitalize()), kind=KIND.get(n, "prop"),
                                                 isNew=n not in ORIGINAL, url=uri(files[n])) for n in names]) for g, names in groups if names])
    subprocess.run(["npx", "esbuild", "src/props_review.js", "--bundle", "--minify", "--format=esm",
                    "--outfile=public/props_review.js"], cwd=ROOT, check=True)
    app = (ROOT / "public/props_review.js").read_text().replace("</script", "<\\/script")
    html = (ROOT / "props_review.tpl.html").read_text().replace("/*DATA*/", json.dumps(data).replace("</", "<\\/")).replace("/*APP*/", app)
    out = pathlib.Path(a.out); out.parent.mkdir(parents=True, exist_ok=True); out.write_text(html)
    n = sum(len(g["props"]) for g in data["groups"])
    print(f"{out}  {n} props ({sum(p['isNew'] for g in data['groups'] for p in g['props'])} new)  {len(html)/1e6:.2f} MB")


if __name__ == "__main__":
    main()
