#!/usr/bin/env python3
"""Build the single-file animation viewer: idle model + walk/run clips embedded as data URIs."""
import json, base64, pathlib, subprocess

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parents[1]
OPT, ANIM = REPO / "assets/characters", REPO / "assets/animations"
RAW = REPO / "assets/characters-source"
CHARS = [
    ("star-keeper", "Star Keeper", "Hero", 1.25), ("polar-bear-baker", "Polar Bear Baker", "Hero", 1.45),
    ("gingerbread-scout", "Gingerbread Scout", "Hero", 0.95), ("toy-soldier", "Toy Soldier", "Hero", 1.2),
    ("carol-singer", "Carol Singer", "Hero", 1.2), ("snow-sprite", "Snow Sprite", "Hero", 1.05),
    ("reindeer-flyer", "Reindeer Flyer", "Hero", 1.4), ("grumbleweed", "Grumbleweed", "Boss", 2.3),
    ("grumpling", "Grumpling", "Foe", 0.8), ("coal-imp", "Coal Imp", "Foe", 0.75),
    ("snow-golem", "Snow Golem", "Foe", 1.8), ("wind-up-rat", "Wind-up Rat", "Foe", 0.6),
    ("blizzard-wisp", "Blizzard Wisp", "Foe", 1.1),
]
uri = lambda p: "data:model/gltf-binary;base64," + base64.b64encode(p.read_bytes()).decode()

def main():
    out = []
    for n, label, grp, h in CHARS:
        idle = RAW / f"sb_{n}_idle.glb"
        c = dict(name=n, label=label, group=grp, height=h, clips={})
        if idle.exists() or n == "reindeer-flyer":  # reindeer: Blender-built rig, idle embedded in the model
            c["model"] = uri(OPT / f"sb_{n}.glb"); c["clips"]["idle"] = "@model"
            for k in ("walk", "run"):
                p = ANIM / f"sb_{n}_{k}.glb"
                if p.exists(): c["clips"][k] = uri(p)
        else:
            c["model"] = uri(OPT / f"sb_{n}.glb"); c["motion"] = "spin" if n == "blizzard-wisp" else "bob"
        out.append(c)
    subprocess.run(["npx", "esbuild", "src/viewer.js", "--bundle", "--minify", "--format=esm", "--outfile=public/viewer.js"],
                   cwd=ROOT, check=True)
    app = (ROOT / "public/viewer.js").read_text().replace("</script", "<\\/script")
    html = (ROOT / "viewer.tpl.html").read_text().replace("/*ANIM*/", json.dumps(out)).replace("/*APP*/", app)
    (REPO / "review/animation-viewer.html").write_text(html); (ROOT / "public/viewer.html").write_text(html)
    print(f"{len(html)/1e6:.2f} MB")

if __name__ == "__main__":
    main()
