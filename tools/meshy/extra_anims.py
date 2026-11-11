#!/usr/bin/env python3
"""Extra gameplay clips for one rigged character from the Meshy animation library (3 credits each).
Usage: (export MESHY_API_KEY from .env) python3 extra_anims.py santa [--cap 40]
Clips land in assets/animations/sb_<name>_<clip>.glb (same skeleton as the model)."""
import os, sys, json, time, pathlib, argparse, requests
API = "https://api.meshy.ai/openapi"
ROOT = pathlib.Path(__file__).parent; REPO = ROOT.parents[1]
CLIPS = {"wave": 290, "cheer": 298, "jump": 61, "victory": 412, "hit": 178, "throw": 421, "pick_up": 276, "sleep": 269}
ap = argparse.ArgumentParser(); ap.add_argument("name"); ap.add_argument("--cap", type=int, default=40); a = ap.parse_args()
st = json.loads((ROOT / "state.json").read_text()); rig = st[a.name]["rig_task"]
s = requests.Session(); s.headers["Authorization"] = f"Bearer {os.environ['MESHY_API_KEY']}"
bal = lambda: s.get(f"{API}/v1/balance").json()["balance"]
start = bal(); tasks = {}
for clip, aid in CLIPS.items():
    dest = REPO / f"assets/animations/sb_{a.name}_{clip}.glb"
    if dest.exists(): continue
    if start - bal() + 3 > a.cap: sys.exit("cap reached")
    r = s.post(f"{API}/v1/animations", json=dict(rig_task_id=rig, action_id=aid)); r.raise_for_status()
    tasks[clip] = r.json()["result"]; print(clip, tasks[clip], flush=True)
for clip, tid in tasks.items():
    while True:
        j = s.get(f"{API}/v1/animations/{tid}").json()
        if j["status"] == "SUCCEEDED": break
        if j["status"] in ("FAILED", "CANCELED"): print(clip, j["status"], j.get("task_error")); break
        time.sleep(8)
    if j["status"] == "SUCCEEDED":
        (REPO / f"assets/animations/sb_{a.name}_{clip}.glb").write_bytes(requests.get(j["result"]["animation_glb_url"]).content)
        print(clip, "saved", flush=True)
print("spent", start - bal())
