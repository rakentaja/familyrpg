"""Rebuild the Reindeer Flyer as a rigged, animated character (quadruped).

The Meshy quadruped rig (assets/characters-source/sb_reindeer-flyer_rig.glb) is unusable: every joint sits
within ~1 mm of the same point (both node translations and inverse bind matrices are collapsed), so no
rescale can fix it. This script builds a fresh skeleton for the raw Meshy mesh instead:

  * mesh grounded (feet at z=0), centred on the hooves, scaled to HEIGHT metres, facing -Y in Blender
    (= +Z in glTF)
  * 22-bone quadruped skeleton, automatic (heat) weights + cleanup masks
  * same unit layout as the biped GLBs: Armature node scale 0.01, bones and mesh in centimetres
  * procedural clips: Idle (3 s breathing loop), Walk (lateral-sequence walk), Run (trot), all in place;
    hooves are placed with a small analytic leg IK and baked to plain FK rotations

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_reindeer_rig.py -- <out_dir>
Writes <out_dir>/reindeer_{idle,walk,run}.glb (unoptimised) and <out_dir>/reindeer_rig.blend.
"""
import bpy, sys, math, os
from mathutils import Vector, Matrix, Quaternion

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(REPO, "assets/characters-source/sb_reindeer-flyer_mesh.glb")
OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(REPO, "tmp_reindeer")
HEIGHT = 1.40          # metres, same as tools/meshy/pipeline.py height_meters for the reindeer
FPS = 30
Y_CENTRE = 0.15        # source-space y of the hoof centre (front hooves y≈-0.20, hind y≈0.50)

# ---------------------------------------------------------------- scene / mesh
bpy.ops.wm.read_factory_settings(use_empty=True)
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)
scn = bpy.context.scene
scn.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=SRC)
mesh = [o for o in bpy.context.scene.objects if o.type == "MESH"][0]
for o in list(bpy.context.scene.objects):
    if o is not mesh and o.type != "MESH":
        bpy.data.objects.remove(o)
mesh.name = "char1"
mesh.data.name = "char1"
bpy.context.view_layer.update()
ws = [mesh.matrix_world @ v.co for v in mesh.data.vertices]
ZMIN = min(v.z for v in ws)
ZMAX = max(v.z for v in ws)
S = HEIGHT / (ZMAX - ZMIN)        # source -> metres
K = S * 100.0                     # source -> centimetres (armature units)


def P(x, y, z):
    """Source-space landmark -> armature space (cm, feet at 0, hoof centre at origin)."""
    return Vector((x * K, (y - Y_CENTRE) * K, (z - ZMIN) * K))


# bake the source transform into the vertices: cm units
mesh.matrix_world = (Matrix.Translation(Vector((0, -Y_CENTRE * K, -ZMIN * K))) @ Matrix.Scale(K, 4)) @ mesh.matrix_world
bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh.select_set(False)

# ---------------------------------------------------------------- skeleton
# (name, head, tail, parent, connected) — landmarks measured on the raw mesh (source space, metres)
B = [
    ("Hips", (0, 0.42, 0.03), (0, 0.18, 0.04), None, False),
    ("Spine", None, (0, -0.08, 0.05), "Hips", True),
    ("Chest", None, (0, -0.26, 0.10), "Spine", True),
    ("Neck", (0, -0.27, 0.13), (0, -0.30, 0.32), "Chest", False),
    ("Neck1", None, (0, -0.34, 0.48), "Neck", True),
    ("Head", None, (0, -0.68, 0.42), "Neck1", True),
    ("LeftEar", (0.09, -0.34, 0.58), (0.25, -0.37, 0.63), "Head", False),
    ("RightEar", (-0.09, -0.34, 0.58), (-0.25, -0.37, 0.63), "Head", False),
    ("Tail", (0, 0.56, 0.10), (0, 0.63, 0.15), "Hips", False),
    ("Tail1", None, (0, 0.71, 0.20), "Tail", True),
]
for side, sx in (("Left", 1), ("Right", -1)):
    B += [
        (f"{side}FrontUpLeg", (0.09 * sx, -0.25, 0.02), (0.09 * sx, -0.21, -0.27), "Chest", False),
        (f"{side}FrontLeg", None, (0.085 * sx, -0.19, -0.60), f"{side}FrontUpLeg", True),
        (f"{side}FrontFoot", None, (0.085 * sx, -0.18, -0.86), f"{side}FrontLeg", True),
        (f"{side}FrontToe", None, (0.10 * sx, -0.25, -0.935), f"{side}FrontFoot", True),
        (f"{side}BackUpLeg", (0.12 * sx, 0.40, 0.0), (0.12 * sx, 0.32, -0.20), "Hips", False),
        (f"{side}BackLeg", None, (0.12 * sx, 0.58, -0.44), f"{side}BackUpLeg", True),
        (f"{side}BackFoot", None, (0.14 * sx, 0.54, -0.86), f"{side}BackLeg", True),
        (f"{side}BackToe", None, (0.15 * sx, 0.47, -0.935), f"{side}BackFoot", True),
    ]

arm_data = bpy.data.armatures.new("Armature")
arm = bpy.data.objects.new("Armature", arm_data)
scn.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
eb = arm_data.edit_bones
for name, h, t, parent, conn in B:
    b = eb.new(name)
    b.head = eb[parent].tail.copy() if h is None else P(*h)
    b.tail = P(*t)
    b.roll = 0.0
    if parent:
        b.parent = eb[parent]
        b.use_connect = conn
bpy.ops.object.mode_set(mode="OBJECT")

# ---------------------------------------------------------------- weights
# The Meshy mesh is a soup of open shells, so bone-heat fails on it directly. Heat-weight a closed
# voxel-remeshed proxy instead and transfer the weights onto the real mesh by nearest surface.
proxy = mesh.copy()
proxy.data = mesh.data.copy()
proxy.name = "weight_proxy"
scn.collection.objects.link(proxy)
rm = proxy.modifiers.new("remesh", "REMESH")
rm.mode = "VOXEL"
rm.voxel_size = 0.8  # cm
bpy.context.view_layer.objects.active = proxy
proxy.select_set(True)
bpy.ops.object.modifier_apply(modifier=rm.name)
proxy.select_set(False)
print("proxy verts", len(proxy.data.vertices))

proxy.select_set(True)
arm.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
proxy.select_set(False)
arm.select_set(False)

names = [b[0] for b in B]
vg = {n: mesh.vertex_groups.get(n) or mesh.vertex_groups.new(name=n) for n in names}
dt = mesh.modifiers.new("wt", "DATA_TRANSFER")
dt.object = proxy
dt.use_vert_data = True
dt.data_types_verts = {"VGROUP_WEIGHTS"}
dt.vert_mapping = "POLYINTERP_NEAREST"
dt.layers_vgroup_select_src = "ALL"
dt.layers_vgroup_select_dst = "NAME"
bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.modifier_apply(modifier=dt.name)
mesh.select_set(False)
bpy.data.objects.remove(proxy)

am = mesh.modifiers.new("Armature", "ARMATURE")
am.object = arm
mesh.parent = arm
gi = {g.index: g.name for g in mesh.vertex_groups}
bones_rest = {b.name: (b.head_local.copy(), b.tail_local.copy()) for b in arm_data.bones}


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length


def src(v):  # armature cm -> source metres (for masks)
    return Vector((v.x / K, v.y / K + Y_CENTRE, v.z / K + ZMIN))


fixed_zero = fixed_rigid = 0
new_w = []
for v in mesh.data.vertices:
    s = src(v.co)
    w = {gi[g.group]: g.weight for g in v.groups if g.weight > 1e-4}
    rigid = None
    # antlers (and anything above the ears) ride on the head rigidly
    if s.z > 0.66 or (s.z > 0.6 and abs(s.x) < 0.13):
        rigid = "Head"
    if rigid is None and s.z < -0.25:
        # lower legs: only the leg this vertex belongs to
        side = "Left" if s.x > 0 else "Right"
        end = "Front" if s.y < Y_CENTRE else "Back"
        keep = f"{side}{end}"
        w = {n: x for n, x in w.items() if n.startswith(keep)}
    if rigid is None and not w:
        # loose islands the transfer missed: fall back to the two nearest bones
        d = sorted((seg_dist(v.co, *bones_rest[n]), n) for n in names)
        w = {d[0][1]: 1.0 / (d[0][0] + 1e-3), d[1][1]: 0.25 / (d[1][0] + 1e-3)}
        fixed_zero += 1
    if rigid:
        w = {rigid: 1.0}
        fixed_rigid += 1
    top = sorted(w.items(), key=lambda kv: -kv[1])[:4]
    tot = sum(x for _, x in top)
    new_w.append([(n, x / tot) for n, x in top])
all_idx = list(range(len(mesh.data.vertices)))
vg = {n: mesh.vertex_groups[n] for n in names}  # re-fetch: modifier_apply invalidates old references
for g in mesh.vertex_groups:
    g.remove(all_idx)
for i, top in enumerate(new_w):
    for n, x in top:
        vg[n].add([i], x, "REPLACE")
assert all(len(v.groups) > 0 for v in mesh.data.vertices), "unweighted vertices left"
print(f"weights: {fixed_zero} unweighted verts fixed, {fixed_rigid} rigid head verts")

# ---------------------------------------------------------------- units like the biped GLBs
# Armature + mesh objects carry scale 0.01; bones/vertices stay in centimetres.
arm.matrix_world = Matrix.Scale(0.01, 4)
mesh.parent = arm
mesh.matrix_parent_inverse = Matrix()
mesh.matrix_basis = Matrix()
bpy.context.view_layer.update()

# ---------------------------------------------------------------- posing helpers
pbs = arm.pose.bones
vl = bpy.context.view_layer
for pb in pbs:
    pb.rotation_mode = "QUATERNION"


def reset():
    for pb in pbs:
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
        pb.scale = Vector((1, 1, 1))
    vl.update()


def rot_world(name, axis, deg):
    """Rotate a bone (with its children) about an armature-space axis through its head."""
    pb = pbs[name]
    vl.update()
    h = pb.head.copy()
    R = Quaternion(Vector(axis), math.radians(deg)).to_matrix().to_4x4()
    pb.matrix = Matrix.Translation(h) @ R @ Matrix.Translation(-h) @ pb.matrix
    vl.update()


def move_world(name, off):
    pb = pbs[name]
    vl.update()
    M = pb.matrix.copy()
    M.translation += Vector(off)
    pb.matrix = M
    vl.update()


def aim(name, target):
    pb = pbs[name]
    vl.update()
    h = pb.head.copy()
    M = pb.matrix.copy()
    cur = M.col[1].to_3d().normalized()
    want = (Vector(target) - h).normalized()
    q = cur.rotation_difference(want)
    R = (q.to_matrix() @ M.to_3x3()).to_4x4()
    R.translation = h
    pb.matrix = R
    vl.update()


def rest_head(n):
    return bones_rest[n][0].copy()


def rest_tail(n):
    return bones_rest[n][1].copy()


def blen(n):
    return (bones_rest[n][1] - bones_rest[n][0]).length


X = Vector((1, 0, 0))


def solve_leg(prefix, F, cannon_deg, toe_deg, bend_sign):
    """Place one leg: fetlock at F, cannon tilted cannon_deg about +X from rest, toe curled toe_deg.
    bend_sign: +1 -> middle joint behind the root->carpus line (front elbow), -1 -> in front (hind stifle)."""
    up, mid, foot, toe = (prefix + s for s in ("UpLeg", "Leg", "Foot", "Toe"))
    rest_cannon = rest_tail(foot) - rest_head(foot)
    dirc = Quaternion(X, math.radians(cannon_deg)) @ rest_cannon.normalized()
    C = F - dirc * blen(foot)
    vl.update()
    A = pbs[up].head.copy()
    l1, l2 = blen(up), blen(mid)
    AC = C - A
    d = max(abs(l1 - l2) + 1e-3, min(l1 + l2 - 1e-3, AC.length))
    u = AC.normalized()
    w = X.cross(u).normalized()           # in the sagittal plane, perpendicular to u
    if w.y * bend_sign < 0:
        w = -w
    ca = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
    a = math.acos(ca)
    Bk = A + (u * math.cos(a) + w * math.sin(a)) * l1
    aim(up, Bk)
    aim(mid, A + u * d)
    aim(foot, F)
    rest_toe = rest_tail(toe) - rest_head(toe)
    vl.update()
    toe_tip = pbs[toe].head + Quaternion(X, math.radians(toe_deg)) @ rest_toe
    aim(toe, toe_tip)


LEGS = {  # prefix: bend sign
    "LeftFront": 1, "RightFront": 1, "LeftBack": -1, "RightBack": -1,
}
F0 = {p: rest_tail(p + "Foot") for p in LEGS}


def smooth(x):
    return x * x * (3 - 2 * x)


def foot_path(u, duty, L, h):
    """Phase u in [0,1): stance from front to back, then an arched swing forward. Returns (dy, dz, s_swing)."""
    if u < duty:
        s = u / duty
        return L * (s - 0.5), 0.0, None
    s = (u - duty) / (1 - duty)
    e = smooth(s)
    return L * (0.5 - e), h * math.sin(math.pi * s) * (1 - 0.25 * s), s


# ---------------------------------------------------------------- clips
def key_frame(f, prev):
    for pb in pbs:
        q = pb.rotation_quaternion.copy()
        if pb.name in prev:
            q.make_compatible(prev[pb.name])
        pb.rotation_quaternion = q
        prev[pb.name] = q.copy()
        pb.keyframe_insert("rotation_quaternion", frame=f, group=pb.name)
        if pb.name == "Hips":
            pb.keyframe_insert("location", frame=f, group=pb.name)


def make_action(name, frames, pose_fn):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = act
    prev = {}
    for f in range(frames + 1):
        t = f / frames
        reset()
        pose_fn(t)
        key_frame(f, prev)
    for fc in getattr(act, "fcurves", []) or []:
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"
    return act


def legs_planted():
    for p, sgn in LEGS.items():
        solve_leg(p, F0[p].copy(), 0.0, 0.0, sgn)


def idle(t):
    ph = 2 * math.pi * t
    br = math.sin(ph)                                  # one slow breath per loop
    move_world("Hips", (0, 0, 0.25 * br))
    rot_world("Spine", X, -0.8 * br)
    rot_world("Chest", X, -1.0 * math.sin(ph + 0.4))
    rot_world("Neck", X, 1.5 * math.sin(ph + 0.8))
    rot_world("Neck1", X, 1.5 * math.sin(ph + 1.1))
    rot_world("Head", X, 2.5 * math.sin(ph + 1.4))
    rot_world("Neck1", (0, 0, 1), 4.0 * math.sin(ph))  # slow look left/right
    rot_world("Head", (0, 0, 1), 3.0 * math.sin(ph - 0.3))

    def flick(c):                                     # quick ear twitch around time c
        x = (t - c) / 0.07
        return math.exp(-x * x)
    rot_world("LeftEar", (0, 1, 0), -(4 * math.sin(2 * ph) + 22 * flick(0.38)))
    rot_world("RightEar", (0, 1, 0), 4 * math.sin(2 * ph + 1.0) + 22 * flick(0.74))
    rot_world("Tail", (0, 0, 1), 8 * math.sin(3 * ph))
    rot_world("Tail1", (0, 0, 1), 14 * math.sin(3 * ph - 0.7))
    rot_world("Tail", X, -6 * max(0.0, math.sin(3 * ph)) )
    legs_planted()


def gait(t, phases, duty, L, lift, drop, bob, cannon_swing, toe_swing, nod, lean):
    ph = 2 * math.pi * t
    move_world("Hips", (0, 0, -drop + bob * math.cos(2 * ph)))
    rot_world("Hips", X, lean)
    rot_world("Hips", (0, 1, 0), 1.2 * math.sin(ph))
    rot_world("Spine", (0, 0, 1), 1.5 * math.sin(ph))
    rot_world("Chest", (0, 1, 0), -1.0 * math.sin(ph))
    rot_world("Neck", X, -lean * 0.6 + nod * math.cos(2 * ph + 0.6))
    rot_world("Head", X, -lean * 0.4 + 0.5 * nod * math.cos(2 * ph + 1.0))
    rot_world("LeftEar", (0, 1, 0), -3 * math.sin(2 * ph))
    rot_world("RightEar", (0, 1, 0), 3 * math.sin(2 * ph))
    rot_world("Tail", X, -4 * math.cos(2 * ph))
    rot_world("Tail1", (0, 0, 1), 10 * math.sin(ph))
    for p, sgn in LEGS.items():
        u = (t + phases[p]) % 1.0
        front = "Front" in p
        dy, dz, s = foot_path(u, duty, L * K, lift[front] * K)
        F = F0[p] + Vector((0, dy, dz))
        if s is None:   # stance: cannon follows the leg a little, hoof flat
            cd = 14.0 * dy / (0.5 * L * K) if front else 8.0 * dy / (0.5 * L * K)
            td = 0.0
        else:
            k = math.sin(math.pi * s)
            cd = cannon_swing[front] * k
            td = toe_swing * k
        solve_leg(p, F, cd, td, sgn)


WALK_PH = {"LeftBack": 0.0, "LeftFront": 0.25, "RightBack": 0.5, "RightFront": 0.75}
TROT_PH = {"LeftFront": 0.0, "RightBack": 0.0, "RightFront": 0.5, "LeftBack": 0.5}


def walk(t):
    gait(t, WALK_PH, duty=0.64, L=0.46, lift={True: 0.11, False: 0.09}, drop=1.2, bob=0.6,
         cannon_swing={True: 70.0, False: 35.0}, toe_swing=35.0, nod=2.5, lean=0.0)


def run(t):
    gait(t, TROT_PH, duty=0.42, L=0.66, lift={True: 0.19, False: 0.15}, drop=3.0, bob=2.2,
         cannon_swing={True: 95.0, False: 50.0}, toe_swing=50.0, nod=4.0, lean=2.0)


clips = [("Idle", 90, idle), ("Walk", 30, walk), ("Run", 18, run)]
acts = {}
for name, n, fn in clips:
    acts[name] = (make_action(name, n, fn), n)
    print(f"clip {name}: {n} frames @ {FPS} fps")
reset()

# stats for the report: travel speed implied by the stance phase
for name, duty, L, n in (("Walk", 0.64, 0.46, 30), ("Run", 0.42, 0.66, 18)):
    per_cycle = L * S / duty
    print(f"{name}: ground speed {per_cycle / (n / FPS):.2f} m/s ({per_cycle:.2f} m per {n / FPS:.2f} s cycle)")

# ---------------------------------------------------------------- export
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "reindeer_rig.blend"))
for name, (act, n) in acts.items():
    ad = arm.animation_data
    ad.action = act
    if hasattr(ad, "action_slot") and len(getattr(act, "slots", [])):
        ad.action_slot = act.slots[0]
    scn.frame_start, scn.frame_end = 0, n
    for o in scn.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(OUT, f"reindeer_{name.lower()}.glb"), export_format="GLB",
        export_yup=True, export_skins=True, export_animations=True, export_animation_mode="ACTIVE_ACTIONS",
        export_force_sampling=True, export_frame_range=True, export_optimize_animation_size=False,
        export_def_bones=False, export_leaf_bone=False, export_rest_position_armature=True,
        export_nla_strips_merged_animation_name=name)
    print("exported", name)
