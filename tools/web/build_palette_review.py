#!/usr/bin/env python3
"""Build review/palette-review.html: every character at Original / 50% / 80% palette snap.

Usage:
  node tools/palette/apply.mjs --strength 0.5,0.8 --out-dir review/palette --all   # variants first
  python3 tools/web/build_palette_review.py [--rows 50,80] [--chars a,b,...]

Each character's live GLB is embedded once; the snapped rows only embed their WebP base-colour texture
(review/palette/tex/sb_<char>_s<NN>.webp), which the page swaps in. Byte-identical to the variant GLBs' textures.
"""
import argparse, base64, json, pathlib, re, struct, subprocess

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parents[1]
LABELS = {
    "reindeer-flyer": "Reindeer Flyer", "snow-sprite": "Snow Sprite", "gingerbread-scout": "Gingerbread Scout",
    "toy-soldier": "Toy Soldier", "carol-singer": "Carol Singer", "polar-bear-baker": "Polar Bear Baker",
    "star-keeper": "Star Keeper", "grumpling": "Grumpling", "coal-imp": "Coal Imp", "wind-up-rat": "Wind-up Rat",
    "blizzard-wisp": "Blizzard Wisp", "snow-golem": "Snow Golem", "grumbleweed": "Grumbleweed",
}
ORDER = list(LABELS)


def b64(p: pathlib.Path, mt: str) -> str:
    return f"data:{mt};base64," + base64.b64encode(p.read_bytes()).decode()


def glb_texture(path: pathlib.Path) -> str:
    data = path.read_bytes(); off = 12; js = binc = None
    while off < len(data):
        ln, typ = struct.unpack_from("<I4s", data, off); chunk = data[off + 8: off + 8 + ln]
        if typ == b"JSON": js = json.loads(chunk)
        elif typ == b"BIN\0": binc = chunk
        off += 8 + ln
    m = next(m for m in js["materials"] if "baseColorTexture" in m.get("pbrMetallicRoughness", {}))
    t = js["textures"][m["pbrMetallicRoughness"]["baseColorTexture"]["index"]]
    img = js["images"][t.get("extensions", {}).get("EXT_texture_webp", {}).get("source", t.get("source"))]
    bv = js["bufferViews"][img["bufferView"]]; o = bv.get("byteOffset", 0)
    return f"data:{img['mimeType']};base64," + base64.b64encode(binc[o:o + bv["byteLength"]]).decode()


def palette():
    txt = (REPO / "tools/blender/build_props.py").read_text()
    body = re.search(r"PAL\s*=\s*\{(.*?)\}", txt, re.S).group(1)
    pal = re.findall(r'"(\w+)"\s*:\s*"(#[0-9A-Fa-f]{6})"', body)
    return [dict(name=n, hex=h.upper()) for n, h in pal if n not in ("glow", "white")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", default="50,80")
    ap.add_argument("--chars", default=None)
    ap.add_argument("--variants", default="review/palette")
    ap.add_argument("--note", default="")
    ap.add_argument("--out", default="review/palette-review.html")
    a = ap.parse_args()

    have = {p.stem[3:] for p in (REPO / "assets/characters").glob("sb_*.glb")}
    chars = a.chars.split(",") if a.chars else [c for c in ORDER if c in have] + sorted(have - set(ORDER))
    rows = [dict(key="orig", label="Original")] + [dict(key=f"s{r}", label=f"{r}%") for r in a.rows.split(",")]
    vdir = REPO / a.variants / "tex"
    out_chars = []
    for c in chars:
        glb = REPO / f"assets/characters/sb_{c}.glb"
        pre = REPO / f"assets/characters-source/sb_{c}_pre-palette.glb"
        tex = {}
        for r in rows[1:]:
            f = vdir / f"sb_{c}_{r['key']}.webp"
            if f.exists(): tex[r["key"]] = b64(f, "image/webp")
            else: print(f"  ! {c}: no {f.relative_to(REPO)}")
        if pre.exists(): tex["orig"] = glb_texture(pre)  # live model is already snapped: show the real original
        out_chars.append(dict(key=c, label=LABELS.get(c, c), glb=b64(glb, "model/gltf-binary"),
                              orig_tex=glb_texture(pre if pre.exists() else glb), tex=tex))
        print(f"  {c:<20} {glb.stat().st_size/1024:6.0f} KB glb, {len(tex)} variant tex")
    data = dict(pal=palette(), rows=rows, chars=out_chars)

    subprocess.run(["npx", "esbuild", "src/palette_review.js", "--bundle", "--minify", "--format=esm",
                    "--outfile=public/palette_review.js"], cwd=ROOT, check=True)
    app = (ROOT / "public/palette_review.js").read_text().replace("</script", "<\\/script")
    tpl = (ROOT / "palette_review.tpl.html").read_text()
    note = a.note or f"rows: original, then snap strength {', '.join(r['label'] for r in rows[1:])} (tools/palette/snap.py)"
    html = (tpl.replace("/*TITLE*/", "SLEIGHBOUND CHARACTERS").replace("/*NOTE*/", note)
               .replace("/*DATA*/", json.dumps(data).replace("</", "<\\/")).replace("/*APP*/", app))
    out = REPO / a.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f"{out}  {len(html)/1e6:.2f} MB")


if __name__ == "__main__":
    main()
