#!/usr/bin/env python3
"""Download Mixamo animation clips (armature only, FBX) listed in animations.json.

Flow per clip: search -> pick product -> product details (gms_hash) -> export ->
poll the character monitor -> download the presigned FBX -> assets/mixamo/<name>.fbx.
Results are recorded in assets/mixamo/index.json.

Token: env MIXAMO_TOKEN, or a MIXAMO_TOKEN=... line in the repo's .env.
Get it from a signed-in mixamo.com tab: DevTools console -> localStorage.access_token

Usage:
  python3 tools/mixamo/download.py                      # everything in the manifest
  python3 tools/mixamo/download.py --only cheer,wave    # a subset
  python3 tools/mixamo/download.py --list "sleeping"    # print search results only
  python3 tools/mixamo/download.py --dry-run            # plan only; read-only API calls if a token exists
  python3 tools/mixamo/download.py --force              # re-download existing files

Python 3 stdlib only.
"""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.mixamo.com/api/v1"
HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEFAULT_MANIFEST = HERE / "animations.json"
DEFAULT_OUT = REPO / "assets" / "mixamo"
ENV_FILE = REPO / ".env"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
EXPORT_PREFS = {"format": "fbx7_2019", "skin": "false", "fps": "30", "reducekf": "0"}
FPS = 30


class MixamoError(RuntimeError):
    pass


class TokenError(MixamoError):
    pass


def log(msg=""):
    print(msg, flush=True)


# --------------------------------------------------------------------------- token

def load_token(env_file=ENV_FILE):
    tok = os.environ.get("MIXAMO_TOKEN", "").strip()
    if tok:
        return tok
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            if key.strip() == "MIXAMO_TOKEN":
                val = val.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "'\"":
                    val = val[1:-1]
                if val.lower().startswith("bearer "):
                    val = val[7:].strip()
                return val or None
    return None


# --------------------------------------------------------------------------- manifest

def load_manifest(path):
    try:
        data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise MixamoError(f"manifest not found: {path}")
    except json.JSONDecodeError as e:
        raise MixamoError(f"manifest is not valid JSON ({path}): {e}")
    if isinstance(data, dict) and isinstance(data.get("animations"), list):
        data = data["animations"]
    if not isinstance(data, list):
        raise MixamoError("manifest must be a JSON list of {name, query, ...} objects")
    seen, out = set(), []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            raise MixamoError(f"manifest entry #{i} is not an object")
        name, query = item.get("name"), item.get("query")
        if not isinstance(name, str) or not name.strip():
            raise MixamoError(f"manifest entry #{i}: missing 'name'")
        name = name.strip()
        if any(c in name for c in "/\\") or name.startswith("."):
            raise MixamoError(f"manifest entry '{name}': name must be a plain file stem")
        if name in seen:
            raise MixamoError(f"manifest: duplicate name '{name}'")
        seen.add(name)
        if not isinstance(query, str) or not query.strip():
            raise MixamoError(f"manifest entry '{name}': missing 'query'")
        pick = item.get("pick")
        if isinstance(pick, bool) or (pick is not None and not isinstance(pick, (str, int))):
            raise MixamoError(f"manifest entry '{name}': 'pick' must be a product name or an index")
        for flag in ("inplace", "mirror"):
            if flag in item and item[flag] is not None and not isinstance(item[flag], bool):
                raise MixamoError(f"manifest entry '{name}': '{flag}' must be true/false")
        out.append({"name": name, "query": query.strip(), "pick": pick,
                    "inplace": item.get("inplace"), "mirror": item.get("mirror")})
    return out


def select_entries(entries, only):
    if not only:
        return entries
    wanted = [n.strip() for n in only.split(",") if n.strip()]
    known = {e["name"] for e in entries}
    missing = [n for n in wanted if n not in known]
    if missing:
        raise MixamoError(f"--only: unknown name(s) {', '.join(missing)}; "
                          f"manifest has: {', '.join(sorted(known))}")
    return [e for e in entries if e["name"] in wanted]


# --------------------------------------------------------------------------- HTTP

class Mixamo:
    def __init__(self, token, base=API, retries=4, timeout=60):
        self.token, self.base, self.retries, self.timeout = token, base, retries, timeout

    def _headers(self):
        return {
            "Authorization": f"Bearer {self.token}",
            "X-Api-Key": "mixamo2",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": UA,
            "Origin": "https://www.mixamo.com",
            "Referer": "https://www.mixamo.com/",
        }

    def request(self, method, path, body=None):
        url = path if path.startswith("http") else self.base + path
        data = json.dumps(body).encode() if body is not None else None
        delay = 2.0
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(url, data=data, method=method, headers=self._headers())
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    raw = r.read()
                break
            except urllib.error.HTTPError as e:
                detail = _err_body(e)
                if e.code == 401:
                    raise TokenError("401 Unauthorized: token expired: sign in at mixamo.com and "
                                     "refresh MIXAMO_TOKEN (DevTools: localStorage.access_token)")
                if e.code == 403:
                    raise TokenError(f"403 Forbidden on {method} {path}: token rejected or "
                                     f"request blocked. {detail}")
                if e.code in (429, 500, 502, 503, 504) and attempt < self.retries:
                    wait = _retry_after(e) or delay
                    log(f"    HTTP {e.code} on {method} {path}; retrying in {wait:.0f}s")
                    time.sleep(wait)
                    delay = min(delay * 2, 60)
                    continue
                raise MixamoError(f"HTTP {e.code} on {method} {path}: {detail}")
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < self.retries:
                    log(f"    network error on {method} {path} ({e}); retrying in {delay:.0f}s")
                    time.sleep(delay)
                    delay = min(delay * 2, 60)
                    continue
                raise MixamoError(f"network error on {method} {path}: {e}")
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise MixamoError(f"{method} {path}: response is not JSON: {raw[:200]!r}")

    # -- endpoints

    def search(self, query, limit=48):
        q = urllib.parse.urlencode({"page": 1, "limit": limit, "order": "",
                                    "type": "Motion,MotionPack", "query": query})
        res = self.request("GET", f"/products?{q}")
        results = res.get("results") if isinstance(res, dict) else res
        if not isinstance(results, list):
            raise MixamoError(f"search '{query}': unexpected response shape "
                              f"(keys: {list(res)[:10] if isinstance(res, dict) else type(res).__name__})")
        return results

    def primary_character(self):
        res = self.request("GET", "/characters/primary")
        if isinstance(res, dict):
            for key in ("primary_character_id", "id", "character_id"):
                if res.get(key):
                    return str(res[key]), res.get("primary_character_name") or res.get("name")
        raise MixamoError("could not read a character id from /characters/primary; "
                          "pass --character-id (any character UUID from your Mixamo account)")

    def product(self, anim_id, character_id):
        q = urllib.parse.urlencode({"similar": 0, "character_id": character_id})
        return self.request("GET", f"/products/{anim_id}?{q}")

    def export(self, payload):
        return self.request("POST", "/animations/export", payload)

    def monitor(self, character_id):
        return self.request("GET", f"/characters/{character_id}/monitor")


def _err_body(e):
    try:
        txt = e.read().decode("utf-8", "replace")
    except Exception:
        return e.reason or ""
    try:
        j = json.loads(txt)
        if isinstance(j, dict):
            return str(j.get("message") or j.get("error") or j)[:300]
    except json.JSONDecodeError:
        pass
    return txt[:300]


def _retry_after(e):
    try:
        return max(1.0, float(e.headers.get("Retry-After")))
    except (TypeError, ValueError, AttributeError):
        return None


# --------------------------------------------------------------------------- logic

def pick_product(results, entry):
    """Return (product, how). Packs are skipped unless picked explicitly by name/index."""
    if not results:
        raise MixamoError(f"'{entry['name']}': no search results for '{entry['query']}'")
    pick, motions = entry.get("pick"), [r for r in results if r.get("type", "Motion") == "Motion"]
    if isinstance(pick, int):
        if not 0 <= pick < len(results):
            raise MixamoError(f"'{entry['name']}': pick index {pick} out of range "
                              f"(0..{len(results) - 1})")
        return results[pick], f"index {pick}"
    if isinstance(pick, str):
        for r in results:
            if (r.get("name") or "").strip().lower() == pick.strip().lower():
                return r, "pick name"
        names = ", ".join(f"'{r.get('name')}'" for r in results[:15])
        raise MixamoError(f"'{entry['name']}': no result named '{pick}' for query "
                          f"'{entry['query']}'. First results: {names}")
    for r in motions:
        if (r.get("name") or "").strip().lower() == entry["query"].lower():
            return r, "exact query match"
    if motions:
        return motions[0], "first Motion result"
    raise MixamoError(f"'{entry['name']}': only motion packs found for '{entry['query']}'; "
                      f"set 'pick' explicitly")


def params_string(params):
    """gms_hash params: list of [name, value] pairs -> '0.5,0' (values only, comma-joined)."""
    if params is None:
        return ""
    if isinstance(params, str):
        return params
    if isinstance(params, dict):
        return ",".join(_num(v) for v in params.values())
    vals = []
    for p in params:
        if isinstance(p, (list, tuple)):
            vals.append(_num(p[-1]))
        elif isinstance(p, dict):
            vals.append(_num(p.get("value", p.get("default", 0))))
        else:
            vals.append(_num(p))
    return ",".join(vals)


def _num(v):
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def build_export(product_detail, product, entry, character_id):
    details = product_detail.get("details") if isinstance(product_detail, dict) else None
    details = details or {}
    gms = details.get("gms_hash")
    if isinstance(gms, list):  # some packs return a list; take the first motion
        gms = gms[0] if gms else None
    if not isinstance(gms, dict) or "model-id" not in gms:
        raise MixamoError(f"'{entry['name']}': product {product.get('id')} has no usable "
                          f"details.gms_hash (is it a MotionPack?)")
    inplace = entry.get("inplace")
    notes = []
    if inplace is None:
        inplace = bool(gms.get("inplace", False))
    elif inplace and details.get("supports_inplace") is False:
        notes.append("in-place requested but not offered for this clip; exporting with root motion")
        inplace = False
    mirror = entry.get("mirror")
    if mirror is None:
        mirror = bool(gms.get("mirror", False))
    item = {
        "model-id": gms["model-id"],
        "mirror": bool(mirror),
        "trim": gms.get("trim", [0, 100]),
        "overdrive": gms.get("overdrive", 0),
        "params": params_string(gms.get("params")),
        "arm-space": gms.get("arm-space", 0),
        "inplace": bool(inplace),
    }
    name = product_detail.get("name") or product.get("name") or entry["name"]
    payload = {"character_id": character_id, "gms_hash": [item],
               "preferences": dict(EXPORT_PREFS), "product_name": name, "type": "Motion"}
    return payload, notes


def clip_timing(product_detail, product):
    """Best-effort duration/frames from whatever fields the API returns."""
    details = (product_detail or {}).get("details") or {}
    duration = frames = None
    for src in (details, product_detail or {}, product or {}):
        for k in ("duration", "length", "animation_length"):
            v = src.get(k)
            if isinstance(v, (int, float)) and v > 0 and duration is None:
                duration = float(v)
        for k in ("frames", "num_frames", "frame_count"):
            v = src.get(k)
            if isinstance(v, (int, float)) and v > 0 and frames is None:
                frames = int(v)
    if frames is None and duration is not None:
        frames = int(round(duration * FPS))
    return duration, frames


def wait_for_export(api, character_id, export_res, timeout, poll=3.0):
    job_id = None
    if isinstance(export_res, dict):
        job_id = export_res.get("uuid") or export_res.get("job_uuid") or export_res.get("id")
    t0, delay = time.time(), poll
    time.sleep(min(2.0, poll))
    while True:
        st = api.monitor(character_id)
        if not isinstance(st, dict):
            raise MixamoError(f"monitor: unexpected response {st!r:.200}")
        status = str(st.get("status", "")).lower()
        seen_id = st.get("uuid") or st.get("job_uuid")
        stale = job_id and seen_id and str(seen_id) != str(job_id)
        if status == "completed" and not stale:
            url = st.get("job_result")
            if not isinstance(url, str) or not url.startswith("http"):
                raise MixamoError(f"export completed but job_result is not a URL: {url!r:.200}")
            return url
        if status == "failed" and not stale:
            raise MixamoError(f"export failed: {st.get('message') or st.get('job_result') or st}")
        if time.time() - t0 > timeout:
            raise MixamoError(f"export did not finish within {timeout}s (last status: "
                              f"{status or 'unknown'})")
        time.sleep(delay)
        delay = min(delay * 1.5, 15)


def download_file(url, dest, timeout=120):
    """Presigned URL: fetched without any auth headers."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
    except urllib.error.HTTPError as e:
        tmp.unlink(missing_ok=True)
        raise MixamoError(f"download failed: HTTP {e.code} (presigned URL may have expired)")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        tmp.unlink(missing_ok=True)
        raise MixamoError(f"download failed: {e}")
    with open(tmp, "rb") as f:
        head = f.read(32)
    size = tmp.stat().st_size
    if not (head.startswith(b"Kaydara FBX Binary") or b"FBX" in head[:32] or head.startswith(b"; FBX")):
        if head[:1] in (b"<", b"{"):
            tmp.unlink(missing_ok=True)
            raise MixamoError(f"download is not an FBX (starts with {head[:20]!r})")
        log(f"    warning: file does not start with an FBX header ({head[:20]!r})")
    os.replace(tmp, dest)
    return size


# --------------------------------------------------------------------------- index

def load_index(out_dir):
    p = out_dir / "index.json"
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("animations"), dict):
                return data
        except json.JSONDecodeError:
            log(f"warning: {p} is not valid JSON; rebuilding it")
    return {"source": "mixamo.com", "format": EXPORT_PREFS["format"], "fps": FPS,
            "skin": False, "rig": "mixamorig:* armature, T-pose rest", "animations": {}}


def save_index(out_dir, index):
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / "index.json"
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    os.replace(tmp, p)


# --------------------------------------------------------------------------- commands

def cmd_list(api, query):
    results = api.search(query)
    if not results:
        log(f"no results for '{query}'")
        return
    log(f"{len(results)} result(s) for '{query}':")
    for i, r in enumerate(results):
        desc = (r.get("description") or "").replace("\n", " ").strip()
        log(f"  [{i:2d}] {r.get('name', '?'):<32} {r.get('type', ''):<10} {r.get('id', '')}"
            + (f"  - {desc[:60]}" if desc else ""))


def run(args):
    entries = select_entries(load_manifest(args.manifest), args.only)
    out_dir = pathlib.Path(args.out)
    token = load_token()

    if args.list:
        if not token:
            raise TokenError("MIXAMO_TOKEN not set (env or .env); see tools/mixamo/README.md")
        cmd_list(Mixamo(token), args.list)
        return 0

    todo, skipped = [], []
    for e in entries:
        dest = out_dir / f"{e['name']}.fbx"
        (skipped if dest.exists() and not args.force else todo).append((e, dest))
    for e, dest in skipped:
        log(f"skip  {e['name']:<12} {dest.relative_to(REPO) if dest.is_relative_to(REPO) else dest} "
            f"exists (use --force)")

    if args.dry_run and not token:
        log("\ndry run (no MIXAMO_TOKEN, no API calls):")
        for e, dest in todo:
            flags = [k for k in ("inplace", "mirror") if e.get(k)]
            log(f"  would fetch {e['name']:<12} query='{e['query']}'"
                + (f" pick={e['pick']!r}" if e["pick"] is not None else "")
                + (f" [{', '.join(flags)}]" if flags else "") + f" -> {dest}")
        return 0
    if not todo:
        log("nothing to do")
        return 0
    if not token:
        raise TokenError("MIXAMO_TOKEN not set (env or .env); see tools/mixamo/README.md")

    api = Mixamo(token)
    if args.character_id:
        char_id, char_name = args.character_id, None
    else:
        char_id, char_name = api.primary_character()
    log(f"character: {char_name or '?'} ({char_id})")

    index = load_index(out_dir)
    failures = 0
    for i, (e, dest) in enumerate(todo):
        if i and not args.dry_run:
            time.sleep(args.delay)
        log(f"\n[{i + 1}/{len(todo)}] {e['name']}  (query '{e['query']}')")
        try:
            results = api.search(e["query"])
            product, how = pick_product(results, e)
            pid, pname = product.get("id"), product.get("name")
            log(f"    picked '{pname}' ({pid}) by {how}")
            detail = api.product(pid, char_id)
            payload, notes = build_export(detail, product, e, char_id)
            for n in notes:
                log(f"    note: {n}")
            duration, frames = clip_timing(detail, product)
            if args.dry_run:
                log("    export payload: " + json.dumps(payload))
                continue
            res = api.export(payload)
            log("    exporting ...")
            url = wait_for_export(api, char_id, res, timeout=args.timeout)
            size = download_file(url, dest)
            log(f"    saved {dest} ({size / 1024:.0f} KB)")
            index["animations"][e["name"]] = {
                "name": e["name"],
                "file": dest.name,
                "query": e["query"],
                "mixamo_product_id": pid,
                "mixamo_product_name": pname,
                "mixamo_description": product.get("description"),
                "character_id": char_id,
                "inplace": payload["gms_hash"][0]["inplace"],
                "mirror": payload["gms_hash"][0]["mirror"],
                "params": payload["gms_hash"][0]["params"],
                "trim": payload["gms_hash"][0]["trim"],
                "fps": FPS,
                "duration_s": duration,
                "frames": frames,
                "bytes": size,
                "downloaded": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            save_index(out_dir, index)
        except TokenError:
            raise
        except MixamoError as err:
            failures += 1
            log(f"    ERROR: {err}")
    log(f"\ndone: {len(todo) - failures} ok, {failures} failed, {len(skipped)} skipped")
    return 1 if failures else 0


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="Download Mixamo clips (armature-only FBX) "
                                             "listed in tools/mixamo/animations.json")
    ap.add_argument("--only", help="comma-separated manifest names, e.g. cheer,wave")
    ap.add_argument("--list", metavar="QUERY", help="print search results for QUERY and exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="no exports/downloads; with a token, runs read-only search/details calls")
    ap.add_argument("--force", action="store_true", help="re-download files that already exist")
    ap.add_argument("--character-id", help="character UUID to bake onto (default: /characters/primary)")
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="manifest JSON path")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output directory")
    ap.add_argument("--delay", type=float, default=6.0, help="seconds between clips (default 6)")
    ap.add_argument("--timeout", type=float, default=300.0, help="export timeout per clip (s)")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        return run(args)
    except TokenError as e:
        log(f"error: {e}")
        return 2
    except MixamoError as e:
        log(f"error: {e}")
        return 1
    except KeyboardInterrupt:
        log("\ninterrupted")
        return 130


if __name__ == "__main__":
    sys.exit(main())
