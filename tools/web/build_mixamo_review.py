#!/usr/bin/env python3
"""Build a single-file review page for retargeted (Mixamo -> Meshy rig) clips on one character.

Usage:
  python3 tools/web/build_mixamo_review.py
  python3 tools/web/build_mixamo_review.py --clips 'assets/animations/sb_polar-bear-baker_*.glb'

Embeds the rigged model (with its idle clip) and every matching clip GLB as base64 data URIs,
plus labels from assets/mixamo/review_index.json when present.
"""
import argparse, base64, glob, json, pathlib, subprocess

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parents[1]


def uri(p: pathlib.Path) -> str:
    return "data:model/gltf-binary;base64," + base64.b64encode(p.read_bytes()).decode()


def clip_key(stem: str, char: str) -> str:
    if "_mx_" in stem:
        return stem.split("_mx_", 1)[1]
    pre = f"sb_{char}_"
    return stem[len(pre):] if stem.startswith(pre) else stem


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", default="polar-bear-baker")
    ap.add_argument("--label", default="Polar Bear Baker")
    ap.add_argument("--clips", default=None, help="glob relative to repo root (default: assets/animations/sb_<char>_mx_*.glb)")
    ap.add_argument("--index", default="assets/mixamo/review_index.json")
    ap.add_argument("--out", default=None, help="default: review/mixamo-<char-short>.html")
    a = ap.parse_args()

    model = REPO / f"assets/characters/sb_{a.char}.glb"
    pattern = a.clips or f"assets/animations/sb_{a.char}_mx_*.glb"
    files = sorted(pathlib.Path(p) for p in glob.glob(str(REPO / pattern)))
    idx_path = REPO / a.index
    index = {}
    if idx_path.exists():
        for c in json.loads(idx_path.read_text()).get("clips", []):
            index[pathlib.Path(c.get("file", "")).name] = c
            if c.get("name"): index.setdefault(c["name"], c)   # lets one index serve every character

    clips = []
    for f in files:
        key = clip_key(f.stem, a.char)
        meta = index.get(f.name) or index.get(key, {})
        clips.append(dict(key=key, file=f.name, label=meta.get("label") or meta.get("name") or key.replace("_", " ").replace("-", " "),
                          source=meta.get("source", ""), frames=meta.get("frames"), notes=meta.get("notes", ""), url=uri(f)))
    data = dict(char=a.char, label=a.label, model=uri(model), clips=clips)
    print(f"model {model.relative_to(REPO)}; {len(clips)} clip(s) from '{pattern}'"
          + (f"; index {idx_path.relative_to(REPO)}" if idx_path.exists() else "; no review_index.json"))
    for c in clips:
        print(f"  - {c['key']:<20} {c['file']}")

    subprocess.run(["npx", "esbuild", "src/mixamo_review.js", "--bundle", "--minify", "--format=esm",
                    "--outfile=public/mixamo_review.js"], cwd=ROOT, check=True)
    app = (ROOT / "public/mixamo_review.js").read_text().replace("</script", "<\\/script")
    tpl = (ROOT / "mixamo_review.tpl.html").read_text()
    html = (tpl.replace("/*TITLE*/", a.label)
               .replace("/*DATA*/", json.dumps(data).replace("</", "<\\/"))
               .replace("/*APP*/", app))
    short = a.char.split("-baker")[0] if a.char == "polar-bear-baker" else a.char
    out = pathlib.Path(a.out) if a.out else REPO / f"review/mixamo-{short}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f"{out}  {len(html)/1e6:.2f} MB")


if __name__ == "__main__":
    main()
