#!/usr/bin/env python3
"""Single-file review page for the rebuilt Reindeer Flyer rig: model (idle) + walk/run clip GLBs.

  python3 tools/web/build_reindeer_review.py   ->  review/reindeer-review.html
"""
import base64, json, pathlib, subprocess

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parents[1]
uri = lambda p: "data:model/gltf-binary;base64," + base64.b64encode(p.read_bytes()).decode()


def main():
    data = dict(model=uri(REPO / "assets/characters/sb_reindeer-flyer.glb"), clips={})
    for k in ("walk", "run"):
        p = REPO / f"assets/animations/sb_reindeer-flyer_{k}.glb"
        if p.exists():
            data["clips"][k] = uri(p)
    subprocess.run(["npx", "esbuild", "src/reindeer_review.js", "--bundle", "--minify", "--format=esm",
                    "--outfile=public/reindeer_review.js"], cwd=ROOT, check=True)
    app = (ROOT / "public/reindeer_review.js").read_text().replace("</script", "<\\/script")
    html = ((ROOT / "reindeer_review.tpl.html").read_text()
            .replace("/*DATA*/", json.dumps(data)).replace("/*APP*/", app))
    out = REPO / "review/reindeer-review.html"
    out.write_text(html)
    print(f"{out}  {len(html) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
