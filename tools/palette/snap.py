"""Palette-snap a character's base-colour texture toward the Sleighbound palette.

Runs inside Blender (for numpy + image I/O):

  Blender -b -P tools/palette/snap.py -- --in assets/characters/sb_coal-imp.glb --out /tmp/coal-imp_s60.png --strength 0.6
  Blender -b -P tools/palette/snap.py -- --in a.glb b.glb --out-dir review/palette/tex --strengths 0.5,0.8

--in takes GLB files (the base-colour image of the first textured material is read straight from the binary chunk)
or plain images (png/webp/jpg). Output is PNG (lossless); tools/palette/apply.mjs re-encodes it to WebP inside the GLB.
With --out-dir, files are named <stem>_s<NN>.png (e.g. sb_coal-imp_s50.png).

Method (OKLab, per texel, alpha untouched):
  1. sRGB -> linear -> OKLab (L, a, b).
  2. Soft nearest palette colour: d_i = wL*dL^2 + wC*dC^2 + dH^2 (OKLab lightness, chroma, hue difference),
     weights exp(-d_i / T), so hue decides the match and chroma/lightness only break ties (dark red -> rose_dk, pale red -> rose). The soft weights avoid
     posterised seams where a gradient crosses two palette colours.
  3. a,b move toward the target by s; L moves by l_mix*s (default 0.25*s) so painted shading and detail survive.
     Chroma (texel offset from the target's a,b) is kept by `keep` so neighbouring shades don't flatten to one tone.
  4. Outliers: chroma above 1.25x the matched colour's chroma (capped at the palette maximum) is pulled down by
     `desat`*s, which is what turns lime/violet/hot-pink paint into sage/lavender/rose.
The palette is parsed from PAL in tools/blender/build_props.py, so it stays in sync with the props.
"""
import argparse, json, os, re, struct, sys, tempfile

import bpy
import numpy as np

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PAL_SRC = os.path.join(REPO, "tools", "blender", "build_props.py")
SKIP = {"glow", "white"}  # emissive / pure white are prop helpers, not surface colours


def load_palette(skip=SKIP):
    txt = open(PAL_SRC).read()
    body = re.search(r"PAL\s*=\s*\{(.*?)\}", txt, re.S).group(1)
    pal = dict(re.findall(r'"(\w+)"\s*:\s*"(#[0-9A-Fa-f]{6})"', body))
    return {k: v for k, v in pal.items() if k not in skip}


# ---------- colour math ----------
def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


M1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
               [0.2119034982, 0.6806995451, 0.1073969566],
               [0.0883024619, 0.2817188376, 0.6299787005]])
M2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
               [1.9779984951, -2.4285922050, 0.4505937099],
               [0.0259040371, 0.7827717662, -0.8086757660]])
M1i, M2i = np.linalg.inv(M1), np.linalg.inv(M2)


def rgb_to_oklab(rgb):  # rgb: (...,3) sRGB 0..1
    lms = srgb_to_lin(rgb) @ M1.T
    return np.cbrt(lms) @ M2.T


def oklab_to_rgb(lab):
    lms = (lab @ M2i.T) ** 3
    return lin_to_srgb(lms @ M1i.T)


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


# ---------- the snap ----------
def snap(rgb, pal_lab, s, wL=0.15, wC=0.3, temp=0.0012, l_mix=0.25, keep=0.15, desat=0.6, chunk=1 << 18):
    """rgb: (N,3) sRGB floats. Returns snapped (N,3) sRGB and the index of the dominant palette colour."""
    out = np.empty_like(rgb); dom = np.empty(len(rgb), np.int32)
    pa = pal_lab[None, :, :]
    pc = np.hypot(pal_lab[:, 1], pal_lab[:, 2])
    cmax = pc.max()
    for i in range(0, len(rgb), chunk):
        lab = rgb_to_oklab(rgb[i:i + chunk])
        # hue decides, chroma and lightness only break ties: dE^2 = wL*dL^2 + wC*dC^2 + dH^2,
        # with dH^2 = da^2 + db^2 - dC^2 (so vivid lime -> sage, not the more chromatic gold)
        dab2 = (lab[:, None, 1] - pa[..., 1]) ** 2 + (lab[:, None, 2] - pa[..., 2]) ** 2
        dC2 = (np.hypot(lab[:, 1], lab[:, 2])[:, None] - pc[None, :]) ** 2
        d = wL * (lab[:, None, 0] - pa[..., 0]) ** 2 + wC * dC2 + np.maximum(dab2 - dC2, 0)
        dmin = d.min(1, keepdims=True)
        w = np.exp(-(d - dmin) / temp); w /= w.sum(1, keepdims=True)
        tgt = w @ pal_lab  # (n,3)
        dom[i:i + chunk] = d.argmin(1)
        new = lab.copy()
        # a,b: replace with target + a kept fraction of the texel's own deviation from it
        dev = lab[:, 1:] - tgt[:, 1:]
        ab_target = tgt[:, 1:] + keep * dev
        new[:, 1:] = lab[:, 1:] + s * (ab_target - lab[:, 1:])
        new[:, 0] = lab[:, 0] + l_mix * s * (tgt[:, 0] - lab[:, 0])
        # desaturate outliers: chroma well above the matched palette colour's (or above the palette's maximum)
        c = np.hypot(new[:, 1], new[:, 2])
        cap = np.minimum(np.hypot(tgt[:, 1], tgt[:, 2]) * 1.25 + 0.01, cmax)
        over = c > cap
        if over.any():
            f = 1 - desat * s * (1 - cap[over] / c[over])
            new[over, 1:] *= f[:, None]
        out[i:i + chunk] = oklab_to_rgb(new)
    return out, dom


# ---------- I/O ----------
def glb_base_color_bytes(path):
    """Return (bytes, ext) of the base-colour image of the first textured material in a GLB."""
    data = open(path, "rb").read()
    magic, _, _ = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF", path
    off, js, binc = 12, None, None
    while off < len(data):
        ln, typ = struct.unpack_from("<I4s", data, off)
        chunk = data[off + 8: off + 8 + ln]
        if typ == b"JSON": js = json.loads(chunk)
        elif typ == b"BIN\0": binc = chunk
        off += 8 + ln
    tex_i = next(m["pbrMetallicRoughness"]["baseColorTexture"]["index"] for m in js["materials"]
                 if "baseColorTexture" in m.get("pbrMetallicRoughness", {}))
    tex = js["textures"][tex_i]
    src = tex.get("extensions", {}).get("EXT_texture_webp", {}).get("source", tex.get("source"))
    img = js["images"][src]
    bv = js["bufferViews"][img["bufferView"]]
    raw = binc[bv.get("byteOffset", 0): bv.get("byteOffset", 0) + bv["byteLength"]]
    ext = {"image/webp": ".webp", "image/png": ".png", "image/jpeg": ".jpg"}[img["mimeType"]]
    return raw, ext


def load_pixels(path):
    if path.lower().endswith(".glb"):
        raw, ext = glb_base_color_bytes(path)
        fd, tmp = tempfile.mkstemp(suffix=ext); os.write(fd, raw); os.close(fd)
    else:
        tmp = path
    img = bpy.data.images.load(tmp, check_existing=False)
    img.colorspace_settings.name = "Non-Color"  # we want the stored (sRGB-encoded) values untouched
    w, h = img.size
    px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    if tmp != path: os.remove(tmp)
    return px.reshape(-1, 4), w, h


def save_png(px, w, h, out):
    img = bpy.data.images.new("snap_out", w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(px.ravel().astype(np.float32))
    img.filepath_raw = out; img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="snap.py")
    ap.add_argument("--in", dest="inp", nargs="+", required=True)
    ap.add_argument("--out", help="output PNG (single input, single strength)")
    ap.add_argument("--out-dir", help="write <stem>_s<NN>.png per input and strength")
    ap.add_argument("--strength", type=float, default=0.6)
    ap.add_argument("--strengths", help="comma list, e.g. 0.5,0.8 (with --out-dir)")
    ap.add_argument("--wL", type=float, default=0.15, help="lightness weight in the palette match")
    ap.add_argument("--wC", type=float, default=0.3, help="chroma weight in the palette match")
    ap.add_argument("--temp", type=float, default=0.0012, help="soft-match temperature (smaller = harder)")
    ap.add_argument("--l-mix", type=float, default=0.25, help="L moves by l_mix*strength")
    ap.add_argument("--keep", type=float, default=0.15, help="fraction of a texel's own a,b offset kept")
    ap.add_argument("--desat", type=float, default=0.6, help="pull of over-chroma outliers")
    ap.add_argument("--stats", action="store_true", help="print palette usage per input")
    a = ap.parse_args(argv)

    pal = load_palette()
    names = list(pal)
    pal_lab = rgb_to_oklab(np.array([hex_rgb(pal[n]) for n in names]))
    strengths = [float(x) for x in a.strengths.split(",")] if a.strengths else [a.strength]
    if a.out and (len(a.inp) > 1 or len(strengths) > 1):
        sys.exit("--out needs one input and one strength; use --out-dir")
    if a.out_dir: os.makedirs(a.out_dir, exist_ok=True)

    for path in a.inp:
        px, w, h = load_pixels(path)
        stem = os.path.splitext(os.path.basename(path))[0]
        for s in strengths:
            rgb = px[:, :3].astype(np.float64)
            new, dom = snap(rgb, pal_lab, s, wL=a.wL, wC=a.wC, temp=a.temp, l_mix=a.l_mix, keep=a.keep, desat=a.desat)
            outpx = np.concatenate([new, px[:, 3:4]], 1)
            out = a.out or os.path.join(a.out_dir, f"{stem}_s{round(s * 100):02d}.png")
            save_png(outpx, w, h, out)
            msg = f"{stem}: s={s:.2f} -> {out}"
            if a.stats:
                vis = px[:, 3] > 0.5
                cnt = np.bincount(dom[vis], minlength=len(names)) / max(1, vis.sum())
                msg += "  " + " ".join(f"{names[i]}:{cnt[i]:.0%}" for i in np.argsort(-cnt)[:6] if cnt[i] > 0.01)
            print(msg, flush=True)


main()
