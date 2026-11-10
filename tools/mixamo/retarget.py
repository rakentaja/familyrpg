"""Retarget Mixamo clips (FBX, "without skin") onto a Sleighbound rigged character GLB.

Run with Blender (used only to read and sample the source FBX):

  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/mixamo/retarget.py -- \
      --target assets/characters/sb_polar-bear-baker.glb \
      --src assets/mixamo/wave.fbx [--src assets/mixamo/cheer.fbx ...] \
      [--out-dir assets/animations] [--inplace] [--yaw 0]

Writes one armature-only GLB per clip: <out-dir>/<target-stem>_mx_<clip>.glb. Node names, hierarchy and rest
TRS are copied from the target, so three.js binds the clip to the model by bone name.

Method (world-space rotation transfer with rest-pose compensation):
  * The Mixamo rest pose is a T-pose, ours an A-pose. Each source bone gets an "aligned" rest A_b: its rest
    orientation swung so the bone points the same way as the matching target bone (head -> child head).
  * Per frame, the source bone's world rotation relative to A_b is applied on top of the target's rest:
        T_b(t) = S_b(t) * A_b^-1 * T_b(rest)        (all world space)
    then converted to parent-local node rotations.
  * Hips translation is the source hips offset from rest, scaled by the hip-height ratio.
"""
import json, math, pathlib, struct, sys, argparse

import bpy
from mathutils import Matrix, Quaternion, Vector

# Mixamo bone (prefix stripped) -> Sleighbound/Meshy bone
BONE_MAP = {
    "Hips": "Hips", "Spine": "Spine02", "Spine1": "Spine01", "Spine2": "Spine", "Neck": "neck", "Head": "Head",
    **{f"{s}{p}": f"{s}{p}" for s in ("Left", "Right")
       for p in ("Shoulder", "Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase")},
}
# bone -> child whose head defines the bone direction (source names, prefix stripped)
SRC_AIM = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head",
           "Head": "HeadTop_End"}
TGT_AIM = {"Hips": "Spine02", "Spine02": "Spine01", "Spine01": "Spine", "Spine": "neck", "neck": "Head",
           "Head": "head_end"}
for s in ("Left", "Right"):
    for a, b in (("Shoulder", "Arm"), ("Arm", "ForeArm"), ("ForeArm", "Hand"), ("UpLeg", "Leg"), ("Leg", "Foot"),
                 ("Foot", "ToeBase")):
        SRC_AIM[s + a] = s + b; TGT_AIM[s + a] = s + b
    SRC_AIM[s + "Hand"] = s + "HandMiddle1"; SRC_AIM[s + "ToeBase"] = s + "Toe_End"

# Blender world (Z up, -Y forward) -> glTF world (Y up, +Z forward)
B2G = Matrix(((1, 0, 0, 0), (0, 0, 1, 0), (0, -1, 0, 0), (0, 0, 0, 1)))


def strip(name):
    return name.split(":")[-1]


# ---------------------------------------------------------------- target (glTF JSON, no Blender import needed)
def read_glb(path):
    b = pathlib.Path(path).read_bytes()
    n = struct.unpack("<I", b[12:16])[0]
    return json.loads(b[20:20 + n])


def node_local(nd):
    t = Vector(nd.get("translation", (0, 0, 0)))
    x, y, z, w = nd.get("rotation", (0, 0, 0, 1))
    s = nd.get("scale", (1, 1, 1))
    return Matrix.Translation(t) @ Quaternion((w, x, y, z)).to_matrix().to_4x4() @ Matrix.Diagonal((*s, 1))


class Target:
    def __init__(self, path):
        self.gltf = read_glb(path)
        nodes = self.gltf["nodes"]
        skin = self.gltf["skins"][0]
        self.joints = set(skin["joints"])
        self.parent = {}
        for i, nd in enumerate(nodes):
            for c in nd.get("children", []):
                self.parent[c] = i
        # the skeleton subtree = joints plus their ancestors (e.g. the "Armature" node)
        keep = set(self.joints)
        for j in self.joints:
            p = self.parent.get(j)
            while p is not None:
                keep.add(p); p = self.parent.get(p)
        self.keep = sorted(keep)
        self.world = {}
        for i in self.keep:
            self.world[i] = self._world(i)
        self.by_name = {nodes[i]["name"]: i for i in self.keep}

    def _world(self, i):
        m = node_local(self.gltf["nodes"][i])
        p = self.parent.get(i)
        return (self._world(p) @ m) if p is not None else m

    def pos(self, name):
        return self.world[self.by_name[name]].to_translation()

    def rot(self, name):
        return self.world[self.by_name[name]].to_quaternion()


# ---------------------------------------------------------------- source (Blender import of FBX / GLB)
def load_source(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = pathlib.Path(path).suffix.lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path), automatic_bone_orientation=False, ignore_leaf_bones=False)
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    act = arm.animation_data.action if arm.animation_data else None
    if act is None:
        raise SystemExit(f"{path}: no animation on armature")
    f0, f1 = act.frame_range
    fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
    return arm, f0, f1, fps


def src_world(arm, pb_or_bone, rest):
    m = pb_or_bone.matrix_local if rest else pb_or_bone.matrix
    return B2G @ arm.matrix_world @ m


def swing(a, b):
    """Shortest rotation taking direction a onto direction b."""
    return a.normalized().rotation_difference(b.normalized())


# ---------------------------------------------------------------- retarget
def retarget(target, src_path, inplace=False, yaw=0.0, same_rig=False):
    arm, f0, f1, fps = load_source(src_path)
    bones = {strip(b.name): b for b in arm.data.bones}
    bmap = {k: k for k in TGT_AIM} if same_rig else BONE_MAP
    src_aim = TGT_AIM if same_rig else SRC_AIM
    yawq = Quaternion((0, 1, 0), math.radians(yaw))

    pairs = [(s, t) for s, t in bmap.items() if s in bones and t in target.by_name]
    missing = [s for s in bmap if s not in bones]
    if missing:
        print("  warning: source bones missing:", missing)

    # aligned source rest A_b (world, glTF axes)
    # End bones with no target child to aim at (Hand, ToeBase) inherit their parent's swing; otherwise they keep
    # the T-pose orientation while the forearm is swung ~60 deg down, which bends every wrist/toe by that much.
    A, SW = {}, {}
    for s, t in pairs:                               # pairs are in parent-before-child order (BONE_MAP order)
        r0 = src_world(arm, bones[s], True)
        q0 = (yawq @ r0.to_quaternion().normalized())
        child = src_aim.get(s)
        tchild = TGT_AIM.get(t)
        if child in bones and tchild in target.by_name:
            ds = yawq @ (src_world(arm, bones[child], True).to_translation() - r0.to_translation())
            dt = target.pos(tchild) - target.pos(t)
            sw = swing(ds, dt)
        else:
            p = bones[s].parent
            while p is not None and strip(p.name) not in SW:
                p = p.parent
            sw = SW[strip(p.name)] if p is not None else Quaternion()
        SW[s] = sw
        A[s] = sw @ q0

    src_hip = yawq @ src_world(arm, bones["Hips"], True).to_translation()
    tgt_hip = target.pos("Hips")
    ratio = tgt_hip.y / src_hip.y if abs(src_hip.y) > 1e-6 else 1.0

    nodes = target.gltf["nodes"]
    rest_local_q = {i: node_local(nodes[i]).to_quaternion() for i in target.keep}
    frames = [f0 + k for k in range(int(math.floor(f1 - f0 + 1e-4)) + 1)]
    if f1 - frames[-1] > 1e-3:
        frames.append(f1)
    tracks = {i: [] for i in target.keep}          # node -> [quaternion per frame]
    hips_t = []
    scene = bpy.context.scene
    for f in frames:
        scene.frame_set(int(math.floor(f)), subframe=f - math.floor(f))
        world_q = {}                                 # target node -> world rotation
        for s, t in pairs:
            St = yawq @ src_world(arm, arm.pose.bones[bones[s].name], False).to_quaternion().normalized()
            world_q[target.by_name[t]] = St @ A[s].inverted() @ target.rot(t)
        # resolve parent-local rotations top-down (unmapped nodes keep their rest local rotation)
        solved = {}
        def wq(i):
            if i in solved: return solved[i]
            p = target.parent.get(i)
            pw = wq(p) if p is not None and p in target.world else Quaternion()
            solved[i] = world_q.get(i, pw @ rest_local_q[i])
            return solved[i]
        for i in target.keep:
            w = wq(i)
            p = target.parent.get(i)
            pw = wq(p) if p is not None and p in target.world else Quaternion()
            q = (pw.inverted() @ w).normalized()
            prev = tracks[i][-1] if tracks[i] else None
            if prev is not None and prev.dot(q) < 0:
                q = -q
            tracks[i].append(q)
        # hips translation
        hp = yawq @ src_world(arm, arm.pose.bones[bones["Hips"].name], False).to_translation()
        off = (hp - src_hip) * ratio
        if inplace:
            off.x = 0; off.z = 0
        P = tgt_hip + off
        hi = target.by_name["Hips"]
        pm = target.world[target.parent[hi]] if hi in target.parent else Matrix()
        hips_t.append(pm.inverted() @ P)

    # drop tracks that never move from rest
    animated = {}
    for i, qs in tracks.items():
        r = rest_local_q[i]
        if any(abs(abs(q.dot(r)) - 1) > 1e-6 for q in qs):
            animated[i] = qs
    # FBX clips start at frame 1 -> shift to t=0; the glTF importer maps time t -> frame t*fps (keep absolute)
    base = f0 if pathlib.Path(src_path).suffix.lower() == ".fbx" else 0.0
    times = [(f - base) / fps for f in frames]
    return times, animated, target.by_name["Hips"], hips_t


# ---------------------------------------------------------------- GLB writer (armature-only)
def write_glb(path, target, clip_name, times, rot_tracks, hips_node, hips_t):
    nodes = target.gltf["nodes"]
    remap = {old: new for new, old in enumerate(target.keep)}
    out_nodes = []
    for old in target.keep:
        nd = {k: v for k, v in nodes[old].items() if k in ("name", "translation", "rotation", "scale")}
        ch = [remap[c] for c in nodes[old].get("children", []) if c in remap]
        if ch: nd["children"] = ch
        out_nodes.append(nd)
    roots = [remap[i] for i in target.keep if target.parent.get(i) not in remap]

    blob = bytearray(); views = []; accs = []
    def add(data_floats, comps, kind, minmax=False):
        off = len(blob)
        blob.extend(struct.pack(f"<{len(data_floats)}f", *data_floats))
        while len(blob) % 4: blob.append(0)
        views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data_floats) * 4})
        acc = {"bufferView": len(views) - 1, "componentType": 5126, "count": len(data_floats) // comps, "type": kind}
        if minmax:
            acc["min"] = [min(data_floats)]; acc["max"] = [max(data_floats)]
        accs.append(acc)
        return len(accs) - 1

    t_acc = add(times, 1, "SCALAR", True)
    samplers, channels = [], []
    for i, qs in rot_tracks.items():
        a = add([c for q in qs for c in (q.x, q.y, q.z, q.w)], 4, "VEC4")
        samplers.append({"input": t_acc, "output": a, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": remap[i], "path": "rotation"}})
    a = add([c for v in hips_t for c in v], 3, "VEC3")
    samplers.append({"input": t_acc, "output": a, "interpolation": "LINEAR"})
    channels.append({"sampler": len(samplers) - 1, "target": {"node": remap[hips_node], "path": "translation"}})

    gltf = {"asset": {"version": "2.0", "generator": "sleighbound mixamo retarget"},
            "scene": 0, "scenes": [{"nodes": roots}], "nodes": out_nodes,
            "animations": [{"name": clip_name, "samplers": samplers, "channels": channels}],
            "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accs}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A)); fh.write(js)
        fh.write(struct.pack("<II", len(blob), 0x004E4942)); fh.write(bytes(blob))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="retarget.py")
    ap.add_argument("--target", required=True)
    ap.add_argument("--src", action="append", required=True, help="Mixamo FBX (repeatable)")
    ap.add_argument("--out-dir", default="assets/animations")
    ap.add_argument("--name", help="clip name override (single --src only)")
    ap.add_argument("--inplace", action="store_true", help="remove horizontal hips travel")
    ap.add_argument("--yaw", type=float, default=0.0, help="extra source yaw in degrees if facings differ")
    ap.add_argument("--same-rig", action="store_true", help="source uses the target's own bone names (self-test)")
    a = ap.parse_args(argv)

    target = Target(a.target)
    stem = pathlib.Path(a.target).stem
    out = pathlib.Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
    for src in a.src:
        clip = a.name if (a.name and len(a.src) == 1) else pathlib.Path(src).stem
        times, rots, hips_node, hips_t = retarget(target, src, a.inplace, a.yaw, a.same_rig)
        dst = out / f"{stem}_mx_{clip}.glb"
        write_glb(dst, target, clip, times, rots, hips_node, hips_t)
        print(f"retargeted {src} -> {dst}  ({len(times)} frames, {times[-1]:.2f}s, {len(rots)} rotation tracks)")


if __name__ == "__main__":
    main()
