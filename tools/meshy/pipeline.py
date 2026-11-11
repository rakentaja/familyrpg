#!/usr/bin/env python3
"""Sleighbound Meshy pipeline: multi-view refs -> textured mesh -> rig -> idle clip.

Hard credit cap enforced from the account balance (balance_start - balance_now).
Usage: (export MESHY_API_KEY from .env) python3 pipeline.py [--cap 700] [--only name,name] [--dry]
"""
import os, sys, json, time, base64, argparse, threading, pathlib, urllib.request
import requests
from concurrent.futures import ThreadPoolExecutor

API = "https://api.meshy.ai/openapi"
ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parents[1]
VIEWS, OUT = REPO / "art/reference-sheets/views", REPO / "assets/characters-source"
OUT.mkdir(exist_ok=True)
STATE_F = ROOT / "state.json"

# Priority order. kind: biped (rig + idle), quad (rig quadruped), static (mesh only)
ASSETS = [
    # name,               kind,    height_m, polycount, prompt hint
    ("star-keeper",       "biped", 1.25, 12000),
    ("polar-bear-baker",  "biped", 1.45, 12000),
    ("gingerbread-scout", "biped", 0.95, 10000),
    ("toy-soldier",       "biped", 1.20, 10000),
    ("carol-singer",      "biped", 1.20, 12000),
    ("snow-sprite",       "biped", 1.05, 12000),
    ("reindeer-flyer",    "quad",  1.40, 12000),
    ("grumbleweed",       "biped", 2.30, 16000),
    ("grumpling",         "biped", 0.80, 8000),
    ("wind-up-rat",       "static",0.45, 6000),
    ("coal-imp",          "biped", 0.75, 8000),
    ("snow-golem",        "biped", 1.80, 10000),
    ("blizzard-wisp",     "static",1.10, 8000),
    ("santa",            "biped", 1.45, 14000),
]
COST = {"mesh": 30, "rig": 5, "anim": 3}

lock = threading.Lock()
state = json.loads(STATE_F.read_text()) if STATE_F.exists() else {}

def save():
    with lock:
        STATE_F.write_text(json.dumps(state, indent=2))

def log(*a):
    with lock:
        print(time.strftime("%H:%M:%S"), *a, flush=True)

class Meshy:
    def __init__(self, key, cap):
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {key}"
        self.cap = cap
        self.start = self.balance()
        self.reserved = 0
        log(f"balance {self.start} credits, cap {cap}")

    def balance(self):
        r = self.s.get(f"{API}/v1/balance", timeout=30); r.raise_for_status()
        return r.json()["balance"]

    def spent(self):
        return self.start - self.balance()

    def reserve(self, n, what):
        """Refuse any call that could push total spend past the cap."""
        with lock:
            spent = self.start - self.balance()
            if spent + self.reserved + n > self.cap:
                raise RuntimeError(f"cap: {what} needs {n}, spent {spent} + reserved {self.reserved} / {self.cap}")
            self.reserved += n
    def release(self, n):
        with lock: self.reserved -= n

    def post(self, path, body):
        r = self.s.post(f"{API}{path}", json=body, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"{path} {r.status_code}: {r.text[:300]}")
        return r.json()["result"]

    def wait(self, path, tid, label):
        t0 = time.time(); last = -1
        while True:
            r = self.s.get(f"{API}{path}/{tid}", timeout=60); r.raise_for_status(); j = r.json()
            if j.get("progress") != last and j.get("progress", 0) % 25 == 0:
                last = j.get("progress"); log(f"{label} {j['status']} {last}%")
            if j["status"] == "SUCCEEDED": return j
            if j["status"] in ("FAILED", "CANCELED"):
                raise RuntimeError(f"{label} {j['status']}: {j.get('task_error')}")
            if time.time() - t0 > 1800: raise RuntimeError(f"{label} timeout")
            time.sleep(10)

def data_uri(p):
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()

def dl(url, dest):
    for i in range(6):
        try:
            with requests.get(url, stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(dest, "wb") as f:
                    for ch in r.iter_content(1 << 20): f.write(ch)
            return dest
        except Exception as e:
            log(f"download retry {i+1} {pathlib.Path(dest).name}: {e}"); time.sleep(5 * (i + 1))
    raise RuntimeError(f"download failed {dest}")

def build(m, name, kind, height, poly, idle_id, dry):
    st = state.setdefault(name, {})
    try:
        # 1. mesh
        if "mesh_task" not in st:
            imgs = [data_uri(VIEWS / f"{name}_{v}.png") for v in ("front", "side", "back")]
            body = dict(image_urls=imgs, ai_model="meshy-7.1", should_texture=True,
                        texture_resolution="2k", should_remesh=True, topology="triangle",
                        target_polycount=poly, origin_at="bottom", remove_lighting=True,
                        image_enhancement=False, name=f"sb_{name}")
            if kind != "static" and kind != "quad": body["pose_mode"] = "a-pose"
            if dry: log(f"[dry] {name} mesh {COST['mesh']}cr"); return
            m.reserve(COST["mesh"], f"{name} mesh")
            try:
                st["mesh_task"] = m.post("/v1/multi-image-to-3d", body); save()
            finally: m.release(COST["mesh"])
            log(f"{name} mesh task {st['mesh_task']}")
        j = m.wait("/v1/multi-image-to-3d", st["mesh_task"], f"{name}/mesh")
        if "mesh_glb" not in st:
            st["mesh_glb"] = str(dl(j["model_urls"]["glb"], OUT / f"sb_{name}_mesh.glb"))
            if j.get("thumbnail_url"): dl(j["thumbnail_url"], OUT / f"sb_{name}_thumb.png")
            save()
        if kind == "static":
            st["final"] = st["mesh_glb"]; save(); log(f"{name} DONE (static)"); return
        # 2. rig (walk + run included)
        if "rig_task" not in st:
            m.reserve(COST["rig"], f"{name} rig")
            try:
                st["rig_task"] = m.post("/v1/rigging", dict(input_task_id=st["mesh_task"],
                    animation_type="quadruped" if kind == "quad" else "biped", height_meters=height)); save()
            finally: m.release(COST["rig"])
        j = m.wait("/v1/rigging", st["rig_task"], f"{name}/rig")
        res = j["result"]
        if "rig_glb" not in st:
            st["rig_glb"] = str(dl(res["rigged_character_glb_url"], OUT / f"sb_{name}_rig.glb"))
            ba = res.get("basic_animations") or {}
            if ba.get("walking_glb_url"): st["walk_glb"] = str(dl(ba["walking_glb_url"], OUT / f"sb_{name}_walk.glb"))
            save()
        # 3. idle clip (bipeds only)
        if kind == "biped" and idle_id is not None:
            if "anim_task" not in st:
                m.reserve(COST["anim"], f"{name} idle")
                try:
                    st["anim_task"] = m.post("/v1/animations", dict(rig_task_id=st["rig_task"], action_id=idle_id)); save()
                finally: m.release(COST["anim"])
            j = m.wait("/v1/animations", st["anim_task"], f"{name}/idle")
            if "idle_glb" not in st:
                st["idle_glb"] = str(dl(j["result"]["animation_glb_url"], OUT / f"sb_{name}_idle.glb")); save()
        st["final"] = st.get("idle_glb") or st.get("walk_glb") or st["rig_glb"]; save()
        log(f"{name} DONE")
    except Exception as e:
        st["error"] = str(e); save(); log(f"{name} ERROR {e}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cap", type=int, default=700)
    ap.add_argument("--only", default="")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--workers", type=int, default=5)
    a = ap.parse_args()
    planned = sum(COST["mesh"] + (COST["rig"] if k != "static" else 0) + (COST["anim"] if k == "biped" else 0)
                  for _, k, *_ in ASSETS)
    log(f"planned {planned} credits for {len(ASSETS)} assets, cap {a.cap}")
    if a.dry:
        for n, k, h, p in ASSETS: build(None, n, k, h, p, None, True)
        return
    m = Meshy(os.environ["MESHY_API_KEY"], a.cap)
    r = m.s.get(f"{API}/v1/animations/library", params={"search": "idle"}, timeout=30); r.raise_for_status()
    lib = r.json(); lib = lib.get("result", lib) if isinstance(lib, dict) else lib
    idle = next((x for x in lib if "idle" in x["name"].lower()), None)
    idle_id = idle["action_id"] if idle else None
    log(f"idle clip: {idle and idle['name']} ({idle_id})")
    todo = [x for x in ASSETS if not a.only or x[0] in a.only.split(",")]
    with ThreadPoolExecutor(a.workers) as ex:
        for n, k, h, p in todo: ex.submit(build, m, n, k, h, p, idle_id, False)
    log(f"spent {m.spent()} credits of cap {a.cap}")

if __name__ == "__main__":
    main()
