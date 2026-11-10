#!/usr/bin/env python3
"""Assemble the review scene: manifest from Blender props + Meshy outputs (or reference standees)."""
import json, pathlib, shutil, subprocess

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parents[1]
PUB = ROOT / "public"
MESHY_STATE = REPO / "tools/meshy/state.json"
state = json.loads(MESHY_STATE.read_text()) if MESHY_STATE.exists() else {}

CHARS = [  # name, label, group, height (m), x, z, facing
    ("star-keeper", "Star Keeper", "Hero", 1.25, -2.4, 1.0, 0.5),
    ("polar-bear-baker", "Polar Bear Baker", "Hero", 1.45, -3.4, 2.2, 0.7),
    ("gingerbread-scout", "Gingerbread Scout", "Hero", 0.95, -1.2, 1.8, 0.3),
    ("toy-soldier", "Toy Soldier", "Hero", 1.2, -0.3, 2.9, 0.2),
    ("carol-singer", "Carol Singer", "Hero", 1.2, -2.0, 3.2, 0.5),
    ("snow-sprite", "Snow Sprite", "Hero", 1.05, -3.4, 3.8, 0.6),
    ("reindeer-flyer", "Reindeer Flyer", "Hero", 1.4, -1.0, 4.4, 1.2),
    ("grumbleweed", "Grumbleweed", "Boss", 2.3, 1.2, -1.7, -0.6),
    ("grumpling", "Grumpling", "Foe", 0.8, 2.4, 0.2, -0.9),
    ("wind-up-rat", "Wind-up Rat", "Foe", 0.6, 1.4, 1.4, -1.6),
    ("coal-imp", "Coal Imp", "Foe", 0.75, 4.2, -1.0, -0.8),
    ("snow-golem", "Snow Golem", "Foe", 1.8, 4.0, 3.2, -1.2),
    ("blizzard-wisp", "Blizzard Wisp", "Foe", 1.1, 2.6, 3.9, -1.0),
]

def main():
    (PUB / "models").mkdir(parents=True, exist_ok=True)
    props = {p.stem.removeprefix("sb_"): f"models/{p.name}" for p in sorted((PUB / "models").glob("sb_*.glb"))
             }
    chars = []
    for n, label, grp, h, x, z, r in CHARS:
        st = state.get(n, {}); model = None
        opt = REPO / f"assets/characters/sb_{n}.glb"
        if opt.exists():
            src = opt; dst = PUB / "models" / f"char_{n}.glb"
            shutil.copy(src, dst); model = f"models/{dst.name}"
        import math
        r = math.atan2(12.5 - x, 16 - z)
        chars.append(dict(name=n, label=label, group=grp, height=h, pos=[x, z], rot=r, model=model, ref=f"refs/{n}.png"))
    manifest = dict(props=props, chars=chars)
    html = (ROOT / "index.tpl.html").read_text().replace("/*MANIFEST*/", json.dumps(manifest))
    (PUB / "index.html").write_text(html)
    subprocess.run(["npx", "esbuild", "src/main.js", "--bundle", "--minify", "--format=esm",
                    "--outfile=public/app.js"], cwd=ROOT, check=True)
    print(f"props {len(props)}, chars modelled {sum(1 for c in chars if c['model'])}/{len(chars)}")

if __name__ == "__main__":
    main()
