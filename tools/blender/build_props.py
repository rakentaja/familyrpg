"""Build Sleighbound low-poly props in Blender (bpy) and export one GLB each.
Scale: 1 grid square = 1 m. Origin at base centre. Flat palette materials. Front = -Y (glTF +Z).

Usage (Blender 5.2):
  Blender -b -P tools/blender/build_props.py                 # every prop (original 18 keep their exact geometry)
  Blender -b -P tools/blender/build_props.py -- --new        # only the props added after the first 18
  Blender -b -P tools/blender/build_props.py -- sleigh 'present_*'   # by name / glob
  Blender -b -P tools/blender/build_props.py -- --list
The original 18 share one random stream, so rebuild them only with a full run; newer props reseed per name."""
import bpy, bmesh, math, random, pathlib, sys, fnmatch
from mathutils import Vector, Matrix

OUT = pathlib.Path(__file__).resolve().parents[2] / "assets/props"; OUT.mkdir(parents=True, exist_ok=True)
random.seed(7)

PAL = {
    "rose": "#D8A7A7", "rose_dk": "#B97F82", "sage": "#A9BFA0", "sage_dk": "#7F9A78",
    "cream": "#F2EADB", "snow": "#F7F3EC", "lav": "#B4ABC6", "lav_dk": "#8C84A3",
    "ink": "#2A2328", "wood": "#B08A72", "wood_dk": "#8A6A58", "gold": "#E3C98A",
    "ice": "#CFE0E6", "cookie": "#D9A56E", "glow": "#FFF1C9", "white": "#FFFFFF",
    # added with the second prop batch
    "ice_dk": "#9DBDC9", "ice_clear": "#DDEDF2", "coal": "#4A4249", "water": "#3A4A5E",
    "syrup": "#C4874F", "syrup_hi": "#F1CD94", "gold_dk": "#C2A061", "cookie_dk": "#A9764A",
}
ALPHA = {"ice_clear": 0.6}
ROUGH = {"ice_clear": 0.15, "water": 0.12, "syrup": 0.18, "syrup_hi": 0.18}
def hex2lin(h):
    h = h.lstrip("#"); c = [int(h[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return [((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c] + [1]
MATS = {}
def mat(name):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new("sb_" + name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = hex2lin(PAL[name])
    b.inputs["Roughness"].default_value = ROUGH.get(name, 0.9)
    if name in ALPHA:
        b.inputs["Alpha"].default_value = ALPHA[name]
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try: setattr(m, attr, val)
            except (AttributeError, TypeError): pass
    if name == "glow":
        b.inputs["Emission Color"].default_value = hex2lin(PAL[name]); b.inputs["Emission Strength"].default_value = 2.0
    MATS[name] = m; return m

def clear():
    bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
    for c in (bpy.data.meshes, bpy.data.curves):
        for x in list(c): c.remove(x)

def setmat(o, m):
    o.data.materials.clear(); o.data.materials.append(mat(m)); return o

def jitter(o, amt):
    for v in o.data.vertices: v.co += Vector([random.uniform(-amt, amt) for _ in range(3)])
    return o

def cube(size, loc, m, name="c", bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc); o = bpy.context.object
    o.scale = size; bpy.ops.object.transform_apply(scale=True); o.name = name
    if bevel:
        bv = o.modifiers.new("b", "BEVEL"); bv.width = bevel; bv.segments = 1
        bpy.ops.object.modifier_apply(modifier="b")
    return setmat(o, m)
def cyl(r, d, loc, m, v=8, r2=None, rot=(0,0,0)):
    if r2 is None: bpy.ops.mesh.primitive_cylinder_add(vertices=v, radius=r, depth=d, location=loc, rotation=rot)
    else: bpy.ops.mesh.primitive_cone_add(vertices=v, radius1=r, radius2=r2, depth=d, location=loc, rotation=rot)
    return setmat(bpy.context.object, m)
def cone(r, d, loc, m, v=8): return cyl(r, d, loc, m, v, r2=0)
def ico(r, loc, m, sub=1):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc); return setmat(bpy.context.object, m)
def torus(R, r, loc, m, rot=(0,0,0), maj=12, mn=6):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc, rotation=rot, major_segments=maj, minor_segments=mn)
    return setmat(bpy.context.object, m)

def export(name, keep=(), apply=False):
    """Join every mesh into one object called `name`. Objects named in `keep` stay separate
    (own origin, parented to the joined body) so game code can animate them."""
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name not in keep]
    for o in objs:
        o.select_set(True)
        for p in o.data.polygons: p.use_smooth = False
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.object; o.name = name
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    if apply: bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    for k in keep:
        e = bpy.data.objects[k]; e.parent = o; e.select_set(True)
        for p in e.data.polygons: p.use_smooth = False
        tris += sum(len(p.vertices) - 2 for p in e.data.polygons)
    bpy.ops.export_scene.gltf(filepath=str(OUT / f"sb_{name}.glb"), export_format="GLB", use_selection=True, export_apply=True)
    print(f"EXPORT {name} tris={tris}")

def prism(w, d, h, z0, m, name="roof", overhang=0.0):
    """Gabled prism along X: width w (x), depth d (y), height h, base at z0."""
    bm = bmesh.new(); W = w/2 + overhang; D = d/2 + overhang
    vs = [bm.verts.new(v) for v in [(-W,-D,z0),(W,-D,z0),(W,D,z0),(-W,D,z0),(-W,0,z0+h),(W,0,z0+h)]]
    for f in [(0,1,5,4),(2,3,4,5),(0,4,3),(1,2,5),(0,3,2,1)]: bm.faces.new([vs[i] for i in f])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o); return setmat(o, m)

PROPS = {}
def prop(fn): PROPS[fn.__name__] = fn; return fn

@prop
def tile_snow():
    o = cube((1, 1, 0.12), (0, 0, -0.06), "snow", bevel=0.03); jitter(o, 0.008)
@prop
def tile_ice():
    cube((1, 1, 0.1), (0, 0, -0.05), "ice", bevel=0.02)
    for i in range(3):
        cube((random.uniform(.25,.5), .02, .005), (random.uniform(-.25,.25), random.uniform(-.3,.3), .001), "white").rotation_euler[2] = random.uniform(0, 3)
@prop
def pine_tree():
    cyl(0.09, 0.35, (0, 0, 0.175), "wood_dk", 6)
    for i, (r, h, z) in enumerate([(0.5, 0.7, 0.6), (0.4, 0.6, 1.0), (0.28, 0.55, 1.38)]):
        jitter(cone(r, h, (0, 0, z), "sage_dk" if i % 2 else "sage", 7), 0.02)
        cyl(r * 0.85, 0.06, (0, 0, z - h / 2 + 0.05), "snow", 7, r2=r * 0.55)
@prop
def candy_cane_tree():
    # striped trunk of stacked segments, hooked top
    for i in range(8):
        cyl(0.1, 0.25, (0, 0, 0.125 + i * 0.25), "rose_dk" if i % 2 else "cream", 8)
    for i in range(7):
        a = math.pi * i / 6
        cyl(0.1, 0.13, (0.3 - 0.3 * math.cos(a), 0, 2.0 + 0.3 * math.sin(a)), "rose_dk" if i % 2 else "cream", 8, rot=(0, math.pi/2 - a, 0))
@prop
def present():
    cube((0.5, 0.5, 0.42), (0, 0, 0.21), "rose", bevel=0.02)
    cube((0.52, 0.1, 0.44), (0, 0, 0.21), "cream"); cube((0.1, 0.52, 0.44), (0, 0, 0.21), "cream")
    torus(0.08, 0.03, (-0.07, 0, 0.47), "cream", rot=(math.pi/2, 0, 0.4)); torus(0.08, 0.03, (0.07, 0, 0.47), "cream", rot=(math.pi/2, 0, -0.4))
@prop
def star():
    bm = bmesh.new(); pts = []
    for i in range(10):
        r = 0.4 if i % 2 == 0 else 0.17; a = math.pi / 2 + i * math.pi / 5
        pts.append(bm.verts.new((r * math.cos(a), 0, r * math.sin(a) + 0.45)))
    f = bm.faces.new(pts); ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    for v in [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]: v.co.y += 0.12
    for v in bm.verts: v.co.y -= 0.06
    me = bpy.data.meshes.new("star"); bm.to_mesh(me); o = bpy.data.objects.new("star", me)
    bpy.context.collection.objects.link(o); setmat(o, "glow")
    cyl(0.04, 0.12, (0, 0, 0.03), "gold", 6)
@prop
def dice():
    cube((0.3, 0.3, 0.3), (0, 0, 0.15), "cream", bevel=0.04)
    for (x, y, z) in [(0, -0.151, 0.15), (0.151, 0.07, 0.22), (0.151, -0.07, 0.08), (-0.07, 0.07, 0.301), (0.07, -0.07, 0.301), (0, 0, 0.301)]:
        ico(0.028, (x, y, z), "rose_dk", 0)
@prop
def rock():
    o = ico(0.35, (0, 0, 0.2), "lav", 1); o.scale = (1.2, 0.9, 0.7); jitter(o, 0.07)
    s = ico(0.25, (0.05, 0, 0.42), "snow", 1); s.scale = (1.1, 0.8, 0.3); jitter(s, 0.04)
@prop
def crate():
    cube((0.7, 0.7, 0.7), (0, 0, 0.35), "wood", bevel=0.02)
    for z in (0.08, 0.62): cube((0.74, 0.74, 0.08), (0, 0, z), "wood_dk")
    cube((0.6, 0.6, 0.06), (0, 0, 0.73), "snow", bevel=0.02)
@prop
def lamp_post():
    cyl(0.18, 0.12, (0, 0, 0.06), "ink", 8); cyl(0.05, 1.9, (0, 0, 1.0), "ink", 8)
    cube((0.3, 0.3, 0.35), (0, 0, 2.1), "glow"); cone(0.26, 0.2, (0, 0, 2.37), "ink", 4).rotation_euler[2] = math.pi / 4
    torus(0.12, 0.03, (0.06, 0, 1.6), "sage", rot=(math.pi / 2, 0, 0))
@prop
def fence():
    for x in (-0.45, 0, 0.45):
        cube((0.1, 0.1, 0.7), (x, 0, 0.35), "wood"); cone(0.08, 0.12, (x, 0, 0.76), "wood", 4)
    for z in (0.25, 0.5): cube((1.0, 0.05, 0.08), (0, 0.06, z), "wood_dk")
    cube((1.0, 0.12, 0.05), (0, 0.04, 0.54), "snow")
@prop
def gingerbread_house():
    cube((1.4, 1.2, 1.0), (0, 0, 0.5), "cookie", bevel=0.03)
    prism(1.4, 1.2, 0.75, 1.0, "rose", overhang=0.12)
    prism(1.4, 1.2, 0.75, 1.06, "snow", overhang=0.13).scale = (1.0, 0.92, 0.94)
    cube((0.35, 0.05, 0.55), (0, -0.61, 0.28), "lav_dk", bevel=0.02)
    for x in (-0.45, 0.45): cube((0.28, 0.05, 0.28), (x, -0.61, 0.6), "glow")
    for i in range(6): ico(0.07, (-0.6 + i * 0.24, -0.62, 0.95), ["sage", "rose_dk", "cream"][i % 3], 0)
    cube((0.2, 0.2, 0.5), (0.4, 0.2, 1.55), "rose_dk"); cube((0.24, 0.24, 0.06), (0.4, 0.2, 1.81), "snow")
@prop
def roof_segment():
    cube((2.0, 2.0, 0.7), (0, 0, 0.35), "lav_dk")
    prism(2.0, 2.0, 0.9, 0.7, "rose_dk", overhang=0.1)
    prism(2.0, 2.0, 0.9, 0.76, "snow", overhang=0.11).scale = (1.0, 0.9, 0.93)
    for i in range(3): cube((0.04, 0.04, 0.25), (-0.7 + i * 0.7, -1.06, 0.62), "ice")
@prop
def chimney():
    cube((0.6, 0.6, 1.2), (0, 0, 0.6), "rose_dk", bevel=0.02)
    cube((0.72, 0.72, 0.15), (0, 0, 1.22), "lav_dk"); cube((0.66, 0.66, 0.08), (0, 0, 1.33), "snow")
    for i in range(4): cube((0.62, 0.02, 0.03), (0, -0.301, 0.2 + i * 0.25), "lav_dk")
@prop
def great_tree():
    cyl(0.3, 0.8, (0, 0, 0.4), "wood_dk", 8)
    for i, (r, h, z) in enumerate([(2.0, 2.0, 1.6), (1.6, 1.8, 2.8), (1.2, 1.6, 3.9), (0.8, 1.4, 4.9), (0.45, 1.1, 5.8)]):
        jitter(cone(r, h, (0, 0, z), "sage" if i % 2 else "sage_dk", 9), 0.05)
        cyl(r * 0.85, 0.12, (0, 0, z - h / 2 + 0.1), "snow", 9, r2=r * 0.6)
        for k in range(6):
            a = k * math.pi / 3 + i; rr = r * 0.62
            ico(0.12, (rr * math.cos(a), rr * math.sin(a), z - h * 0.25), ["rose", "cream", "lav", "gold"][(k + i) % 4], 1)
    cyl(0.08, 0.3, (0, 0, 6.45), "gold", 6)  # empty star socket
@prop
def workbench():
    cube((1.6, 0.8, 0.1), (0, 0, 0.85), "wood", bevel=0.02)
    for x in (-0.7, 0.7):
        for y in (-0.32, 0.32): cube((0.1, 0.1, 0.8), (x, y, 0.4), "wood_dk")
    cube((1.4, 0.05, 0.5), (0, 0.3, 0.3), "wood_dk")
    cube((0.3, 0.25, 0.25), (-0.4, 0, 1.02), "rose"); ico(0.1, (0.3, 0.1, 1.0), "sage", 1); cyl(0.05, 0.4, (0.55, -0.15, 0.95), "lav", 6, rot=(0, math.pi / 2, 0.5))
@prop
def cocoa_mug():
    cyl(0.12, 0.22, (0, 0, 0.11), "rose", 10); cyl(0.105, 0.02, (0, 0, 0.215), "wood_dk", 10)
    torus(0.06, 0.02, (0.13, 0, 0.11), "rose", rot=(math.pi / 2, 0, 0))
    for i in range(3): ico(0.03, (random.uniform(-.05,.05), random.uniform(-.05,.05), 0.23), "cream", 0)
@prop
def snowball():
    o = ico(0.12, (0, 0, 0.12), "snow", 1); jitter(o, 0.01)

ORIGINAL = list(PROPS)  # the first 18 props; everything registered below is the second batch
# ---------------------------------------------------------------- second batch: helpers
KEEP = {}  # prop name -> object names exported as separate (animatable) nodes

def box(size, loc, m, name="c", bevel=0.0):
    """`cube` with its origin kept at its own centre (cube's transform_apply bakes location too),
    so rotations set afterwards turn it in place."""
    o = cube(size, loc, m, name, bevel); o.data.transform(Matrix.Translation(-Vector(loc))); o.location = loc; return o

def mkobj(bm, name, m):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.collection.objects.link(o); return setmat(o, m)

def slab(pts, a, b, m, axis="z", name="slab"):
    """Extrude a 2D outline between a and b along `axis`.
    axis z: pts are (x, y) · axis y: pts are (x, z) · axis x: pts are (y, z)."""
    P = {"z": lambda u, v, w: (u, v, w), "y": lambda u, v, w: (u, w, v), "x": lambda u, v, w: (w, u, v)}[axis]
    bm = bmesh.new()
    lo = [bm.verts.new(P(u, v, a)) for u, v in pts]; hi = [bm.verts.new(P(u, v, b)) for u, v in pts]
    bm.faces.new(lo); bm.faces.new(hi[::-1])
    for i in range(len(pts)):
        j = (i + 1) % len(pts); bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    return mkobj(bm, name, m)

def ngon(n, r, j=0.0, sx=1.0, sy=1.0, a0=0.0):
    return [(sx * r * (1 + random.uniform(-j, j)) * math.cos(a0 + 2 * math.pi * i / n),
             sy * r * (1 + random.uniform(-j, j)) * math.sin(a0 + 2 * math.pi * i / n)) for i in range(n)]

def star_pts(n, ro, ri, a0=math.pi / 2):
    return [((ro if i % 2 == 0 else ri) * math.cos(a0 + i * math.pi / n), (ro if i % 2 == 0 else ri) * math.sin(a0 + i * math.pi / n))
            for i in range(2 * n)]

def rot(o, r):
    o.rotation_euler = r; return o

def chunk(size, loc, m, j=0.03, tilt=0.15, bevel=0.0):
    """Irregular rock/ice block: jittered box with a small random tilt."""
    o = box(size, loc, m, bevel=bevel); jitter(o, j)
    return rot(o, (random.uniform(-tilt, tilt), random.uniform(-tilt, tilt), random.uniform(-tilt * 2, tilt * 2)))

def seg(p, q, w, h, z, m):
    """Flat bar from 2D point p to q (crack lines, ribbons)."""
    dx, dy = q[0] - p[0], q[1] - p[1]; L = math.hypot(dx, dy)
    o = box((L + w * 0.6, w, h), ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, z), m)
    o.rotation_euler[2] = math.atan2(dy, dx); return o

def arc(R, centre, a0, a1, n, size, m, axis="x", mats=None):
    """Chain of boxes along a circular arc (runner curls, hooks, rockers).
    axis x: arc in the YZ plane, centre=(y, z); point = (y - R sin a, z - R cos a)."""
    out = []
    for i in range(n):
        a = a0 + (a1 - a0) * i / max(n - 1, 1)
        y, z = centre[0] - R * math.sin(a), centre[1] - R * math.cos(a)
        o = box(size, (0, y, z), (mats[i % len(mats)] if mats else m)); o.rotation_euler[0] = -a; out.append(o)
    return out

def meshes():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]

def ground():
    """Drop the whole prop so its lowest vertex sits on z = 0 (jitter can push things below)."""
    bpy.context.view_layer.update()
    zmin = min((o.matrix_world @ v.co).z for o in meshes() for v in o.data.vertices)
    for o in meshes(): o.location.z -= zmin

def move(objs, dx=0, dy=0, dz=0):
    for o in objs: o.location += Vector((dx, dy, dz))
    return objs

def new_objs(fn):
    before = set(meshes()); fn(); return [o for o in meshes() if o not in before]

def ice_tile():
    box((1, 1, 0.1), (0, 0, -0.05), "ice", bevel=0.02)

def snow_tile():
    o = box((1, 1, 0.12), (0, 0, -0.06), "snow", bevel=0.03); jitter(o, 0.008)

def present_box(col, ribbon, s=1.0, at=(0, 0, 0)):
    """Same geometry as the original `present`, recoloured / scaled / moved."""
    def build():
        box((0.5, 0.5, 0.42), (0, 0, 0.21), col, bevel=0.02)
        box((0.52, 0.1, 0.44), (0, 0, 0.21), ribbon); box((0.1, 0.52, 0.44), (0, 0, 0.21), ribbon)
        torus(0.08, 0.03, (-0.07, 0, 0.47), ribbon, rot=(math.pi/2, 0, 0.4)); torus(0.08, 0.03, (0.07, 0, 0.47), ribbon, rot=(math.pi/2, 0, -0.4))
    objs = new_objs(build)
    for o in objs:
        o.location = Vector(o.location) * s + Vector(at); o.scale = (s, s, s)
    return objs

# ---------------------------------------------------------------- set pieces
@prop
def sleigh():
    """2 x 1 squares: long axis along Y, curled runner tips at the front (-Y)."""
    for x in (-0.42, 0.42):
        o = box((0.07, 1.62, 0.06), (0, 0.06, 0.03), "gold"); o.location.x = x
        for c in arc(0.22, (-0.75, 0.25), 0, 1.25 * math.pi, 10, (0.07, 0.11, 0.06), "gold"): c.location.x = x
        for y in (-0.45, 0.15, 0.65): box((0.06, 0.07, 0.36), (x, y, 0.2), "gold_dk")
    prof = [(-0.98, 0.78), (-0.72, 0.36), (0.82, 0.36), (0.94, 1.08), (0.66, 1.1), (0.55, 0.7), (-0.42, 0.64), (-0.74, 0.94)]
    slab(prof, -0.45, 0.45, "rose_dk", axis="x", name="body")
    for x in (-0.462, 0.462): slab([(-0.72, 0.36), (0.82, 0.36), (0.84, 0.46), (-0.78, 0.46)], x - 0.012, x + 0.012, "gold", axis="x")
    for x in (-0.46, 0.46):  # gold rails along the prow edge, curled scrolls at the tip
        slab([(-0.98, 0.78), (-0.74, 0.94), (-0.76, 0.99), (-1.01, 0.83)], x - 0.025, x + 0.025, "gold", axis="x")
        for c in arc(0.075, (-0.94, 0.86), math.pi * 0.9, 2.4 * math.pi, 7, (0.05, 0.06, 0.05), "gold"): c.location.x = x
    box((0.96, 0.05, 0.05), (0, -0.99, 0.79), "gold").rotation_euler[0] = -0.6
    box((0.84, 0.32, 0.12), (0, 0.38, 0.72), "lav", bevel=0.03)        # seat cushion
    box((0.84, 0.1, 0.34), (0, 0.6, 0.9), "lav_dk", bevel=0.02)       # back rest
    o = ico(0.26, (0.05, -0.12, 0.8), "sage", 1); o.scale = (1.0, 0.9, 0.75); jitter(o, 0.03)   # sack of presents
    cyl(0.07, 0.12, (0.05, -0.12, 1.0), "sage_dk", 6, r2=0.03)
    present_box("rose", "cream", 0.42, (-0.22, -0.42, 0.64)); present_box("gold", "rose_dk", 0.34, (0.25, -0.38, 0.64))
    ground()

@prop
def cocoa_stand():
    """Market stall ~1.5 x 1 m, counter facing -Y, striped awning, pot and mugs."""
    box((1.4, 0.7, 0.9), (0, 0.05, 0.45), "wood", bevel=0.02)
    box((1.5, 0.8, 0.07), (0, 0.05, 0.935), "wood_dk")
    box((1.3, 0.04, 0.62), (0, -0.31, 0.47), "rose")
    box((0.74, 0.03, 0.22), (0, -0.34, 0.58), "cream", bevel=0.01)
    for i, c in enumerate(("rose_dk", "wood_dk", "rose_dk")): ico(0.035, (-0.2 + i * 0.2, -0.36, 0.58), c, 0)  # sign dots
    for x in (-0.69, 0.69):
        for y, top in ((-0.3, 2.1), (0.4, 2.28)): box((0.07, 0.07, top - 0.97), (x, y, (top + 0.97) / 2), "wood_dk")
    n = 6; w = 1.56 / n; ang = math.atan2(0.28, 1.05)
    for i in range(n):
        x = -0.78 + w * (i + 0.5); c = "rose" if i % 2 == 0 else "cream"
        box((w, 1.1, 0.04), (x, 0.03, 2.2), c).rotation_euler[0] = ang
        slab([(x - w / 2, 0), (x + w / 2, 0), (x, -0.17)], -0.535, -0.505, c, axis="y").location.z = 2.06
    cyl(0.17, 0.24, (-0.38, 0.12, 1.09), "sage_dk", 8); cyl(0.18, 0.04, (-0.38, 0.12, 1.22), "lav_dk", 8)
    cone(0.15, 0.08, (-0.38, 0.12, 1.28), "lav_dk", 8); box((0.05, 0.05, 0.05), (-0.38, 0.12, 1.34), "ink")
    for x in (-0.6, -0.16): box((0.06, 0.04, 0.04), (x, 0.12, 1.17), "ink")
    for i, c in enumerate(("rose", "cream", "lav")):
        x = 0.12 + i * 0.2
        cyl(0.065, 0.12, (x, -0.12, 1.03), c, 8); cyl(0.055, 0.015, (x, -0.12, 1.087), "wood_dk", 8)
        box((0.03, 0.025, 0.07), (x + 0.075, -0.12, 1.03), c)
    box((0.36, 0.22, 0.03), (0.5, 0.2, 0.985), "cream")  # tray of biscuits
    for k in range(3): cyl(0.045, 0.025, (0.4 + k * 0.1, 0.2, 1.01), "cookie", 6)

@prop
def cave_entrance():
    """Rocky arch, 2 squares wide along X, dark opening facing -Y."""
    r = 0.55; zc = 0.78
    hole = [(-r, 0), (r, 0)] + [(r * math.cos(math.pi * k / 8), zc + r * math.sin(math.pi * k / 8)) for k in range(9)]
    slab(hole, -0.1, 0.3, "ink", axis="y", name="dark")
    o = box((1.8, 0.55, 1.55), (0, 0.42, 0.76), "lav_dk"); jitter(o, 0.04)   # rock mass behind
    for z in (0.18, 0.5):
        for x in (-0.72, 0.72): chunk((0.44, 0.5, 0.36), (x * (1 + random.uniform(-0.03, 0.03)), -0.05, z), "lav", 0.04, 0.12, 0.02)
    for k in range(7):
        a = math.pi * k / 6; R = 0.74
        o = chunk((0.36, 0.52, 0.38), (R * math.cos(a), -0.08, zc + R * math.sin(a) * 0.95), "lav" if k % 2 else "lav_dk", 0.035, 0.1, 0.02)
        o.rotation_euler[1] = -a + math.pi / 2
    for x in (-0.8, 0.8): chunk((0.32, 0.5, 0.7), (x, 0.05, 1.2), "lav_dk", 0.05, 0.1)
    chunk((0.5, 0.45, 0.32), (-0.45, 0.15, 1.72), "lav", 0.04); chunk((0.45, 0.45, 0.3), (0.5, 0.18, 1.68), "lav_dk", 0.04)
    o = ico(0.5, (0, 0.15, 1.82), "snow", 1); o.scale = (1.8, 0.75, 0.32); jitter(o, 0.04)
    for i in range(5):
        x = -0.36 + i * 0.18; cone(0.035, 0.16 + 0.08 * (i % 2), (x, -0.36, zc + 0.62 - 0.08 * (i % 2)), "ice", 5).rotation_euler[0] = math.pi
    for x in (-0.82, 0.8): o = ico(0.16, (x, -0.38, 0.1), "snow", 1); o.scale = (1.3, 0.9, 0.5); jitter(o, 0.03)
    ground()

@prop
def toy_pile():
    """Heap of toys on one square: blocks, drum, ball, little rocking horse."""
    blocks = [((-0.1, 0.22, 0.09), "rose", 0.3), ((0.1, 0.24, 0.09), "sage", -0.2), ((0.0, 0.05, 0.09), "lav", 0.6),
              ((0.0, 0.2, 0.27), "gold", 0.1), ((0.3, 0.3, 0.09), "cream", 0.4), ((-0.3, 0.28, 0.09), "lav", -0.5),
              ((-0.18, 0.26, 0.27), "cream", 0.7), ((-0.08, 0.22, 0.45), "rose_dk", 0.35)]
    for loc, c, rz in blocks:
        box((0.18, 0.18, 0.18), loc, c, bevel=0.015).rotation_euler[2] = rz
    dx_, dy_ = 0.24, -0.22
    cyl(0.17, 0.2, (dx_, dy_, 0.1), "rose_dk", 10); cyl(0.18, 0.035, (dx_, dy_, 0.02), "cream", 10); cyl(0.18, 0.035, (dx_, dy_, 0.18), "cream", 10)
    for i in range(5):
        a = i * 2 * math.pi / 5; box((0.02, 0.012, 0.15), (dx_ + 0.172 * math.cos(a), dy_ + 0.172 * math.sin(a), 0.1), "gold").rotation_euler = (0.5, 0, a + math.pi / 2)
    for s in (-1, 1): cyl(0.012, 0.26, (dx_ + s * 0.05, dy_, 0.25), "wood", 5, rot=(0, s * 1.1, 0.3))
    o = ico(0.12, (0.34, 0.08, 0.12), "sage", 1); jitter(o, 0.006)
    cyl(0.122, 0.03, (0.34, 0.08, 0.12), "gold", 10)
    # rocking horse, nose toward -Y
    hx, hy = -0.26, -0.12
    def horse():
        box((0.12, 0.3, 0.12), (hx, hy, 0.22), "wood", bevel=0.01)
        box((0.08, 0.08, 0.17), (hx, hy - 0.15, 0.32), "wood").rotation_euler[0] = -0.35
        box((0.09, 0.15, 0.08), (hx, hy - 0.22, 0.4), "wood", bevel=0.01)
        box((0.025, 0.12, 0.08), (hx, hy - 0.11, 0.36), "rose_dk").rotation_euler[0] = -0.4   # mane
        box((0.03, 0.03, 0.1), (hx, hy + 0.17, 0.25), "rose_dk").rotation_euler[0] = 0.6     # tail
        for dx in (-0.045, 0.045):
            for dy in (-0.11, 0.11): box((0.035, 0.035, 0.12), (hx + dx, hy + dy, 0.12), "wood_dk")
            for c in arc(0.42, (hy, 0.47), -0.38, 0.38, 6, (0.03, 0.06, 0.025), "rose"): c.location.x = hx + dx
    for o in new_objs(horse):  # 1.3x around the horse's footprint
        o.location = Vector((hx, hy, 0)) + (o.location - Vector((hx, hy, 0))) * 1.3; o.scale = o.scale * 1.3
    ground()

@prop
def midnight_clock():
    """Tall standing clock (~2.3 m), face toward -Y with 12 marks. The hand is a separate
    object called `hand`, pivot at the face centre, pointing at 12 (rotate about glTF Z; negative = clockwise)."""
    zc = 1.67
    for x in (-0.25, 0.25):
        for y in (-0.15, 0.15): box((0.08, 0.08, 0.06), (x, y, 0.03), "wood_dk")
    box((0.64, 0.44, 0.26), (0, 0, 0.19), "wood_dk", bevel=0.02)
    box((0.48, 0.34, 1.08), (0, 0, 0.86), "wood", bevel=0.02)
    slab([(-0.13, 0.42), (0.13, 0.42), (0.13, 1.18), (0, 1.28), (-0.13, 1.18)], -0.185, -0.165, "glow", axis="y")
    cyl(0.008, 0.5, (0, -0.19, 0.97), "gold_dk", 4); cyl(0.08, 0.02, (0, -0.195, 0.67), "gold", 8, rot=(math.pi / 2, 0, 0))
    box((0.68, 0.46, 0.06), (0, 0, 1.35), "wood_dk")
    box((0.66, 0.42, 0.66), (0, 0, 1.68), "wood", bevel=0.02)
    cyl(0.29, 0.02, (0, -0.215, zc), "gold", 12, rot=(math.pi / 2, 0, 0))
    cyl(0.26, 0.03, (0, -0.235, zc), "cream", 12, rot=(math.pi / 2, 0, 0))
    for k in range(12):
        a = k * math.pi / 6; big = k % 3 == 0; r = 0.2
        o = box((0.03 if big else 0.02, 0.014, 0.075 if big else 0.045), (r * math.sin(a), -0.252, zc + r * math.cos(a)),
                 "rose_dk" if k == 0 else "ink")
        o.rotation_euler[1] = a
    box((0.05, 0.014, 0.05), (0, -0.252, zc + 0.255), "rose_dk").rotation_euler[1] = math.pi / 4   # midnight diamond
    cyl(0.03, 0.02, (0, -0.28, zc), "gold", 8, rot=(math.pi / 2, 0, 0))                              # pivot cap
    p = prism(0.42, 0.72, 0.26, 2.01, "rose_dk", name="pediment"); p.rotation_euler[2] = math.pi / 2
    p = prism(0.44, 0.74, 0.26, 2.04, "snow", name="pedsnow"); p.rotation_euler[2] = math.pi / 2; p.scale = (0.8, 1.0, 0.92)
    slab(star_pts(5, 0.1, 0.045), -0.02, 0.02, "glow", axis="y").location.z = 2.4
    cyl(0.015, 0.1, (0, 0, 2.29), "gold", 4)
    # the hand: built around its own origin, then moved to the face centre
    pts = [(-0.022, -0.06), (0.022, -0.06), (0.016, 0.13), (0.045, 0.13), (0, 0.19), (-0.045, 0.13), (-0.016, 0.13)]
    h = slab(pts, -0.008, 0.008, "ink", axis="y", name="hand"); h.location = (0, -0.262, zc)
    h.data.name = "hand"

KEEP["midnight_clock"] = ("hand",)

@prop
def shelves():
    """Toy shelf, 1 square wide, 0.4 deep, open front (-Y)."""
    for x in (-0.47, 0.47): box((0.06, 0.4, 1.8), (x, 0, 0.9), "wood_dk", bevel=0.01)
    box((0.94, 0.03, 1.76), (0, 0.185, 0.9), "lav_dk")
    for z in (0.05, 0.5, 0.95, 1.4): box((0.9, 0.38, 0.04), (0, 0, z), "wood")
    box((1.06, 0.46, 0.07), (0, 0, 1.83), "wood_dk"); box((1.0, 0.4, 0.05), (0, 0, 1.885), "snow")
    for i, c in enumerate(("rose", "sage", "lav", "gold", "rose_dk", "cream")):       # books
        h = 0.26 + 0.05 * (i % 3); box((0.07, 0.24, h), (-0.36 + i * 0.075, 0.02, 0.07 + h / 2), c).rotation_euler[1] = (0.18 if i == 5 else 0)
    present_box("sage", "rose", 0.42, (0.22, 0.0, 0.07))
    for k, c in enumerate(("rose", "sage", "gold")): box((0.13, 0.13, 0.13), (-0.3 + k * 0.15, -0.02, 0.585), c, bevel=0.01).rotation_euler[2] = 0.2 * k
    o = ico(0.1, (0.28, 0, 0.62), "lav", 1)
    for k, c in enumerate(("cream", "glow", "cream")):
        cyl(0.06, 0.16, (-0.25 + k * 0.17, 0, 1.05), c, 7); cyl(0.065, 0.03, (-0.25 + k * 0.17, 0, 1.145), "wood_dk", 7)
    box((0.12, 0.18, 0.22), (0.3, 0, 1.08), "rose_dk", bevel=0.01)
    cyl(0.1, 0.14, (-0.2, 0, 1.49), "rose", 8); cyl(0.105, 0.025, (-0.2, 0, 1.43), "cream", 8); cyl(0.105, 0.025, (-0.2, 0, 1.55), "cream", 8)
    box((0.2, 0.14, 0.12), (0.2, 0, 1.48), "sage", bevel=0.01); cyl(0.03, 0.08, (0.2, 0, 1.58), "gold", 5)

@prop
def workshop_door():
    """Freestanding plank door in a frame, 1 square wide, gabled top, wreath, faces -Y."""
    box((1.0, 0.42, 0.08), (0, -0.04, 0.04), "lav")
    for x in (-0.45, 0.45): box((0.1, 0.26, 2.06), (x, 0, 1.11), "wood_dk", bevel=0.015)
    slab([(-0.55, 2.1), (0.55, 2.1), (0.55, 2.2), (0, 2.56), (-0.55, 2.2)], -0.14, 0.14, "wood_dk", axis="y")
    slab([(-0.49, 2.2), (0.49, 2.2), (0, 2.52)], -0.15, -0.13, "rose_dk", axis="y")
    slab([(-0.6, 2.15), (0, 2.6), (0.6, 2.15), (0.6, 2.23), (0, 2.66), (-0.6, 2.23)], -0.16, 0.16, "snow", axis="y")
    slab([(-0.4, 0.08), (0.4, 0.08), (0.4, 1.9), (0, 2.08), (-0.4, 1.9)], -0.05, 0.05, "sage_dk", axis="y", name="door")
    for i in range(4): box((0.018, 0.01, 1.72), (-0.3 + i * 0.2, -0.055, 0.98), "ink")
    for z in (0.45, 1.5): box((0.74, 0.025, 0.09), (0, -0.06, z), "wood")
    box((math.hypot(0.62, 0.98), 0.025, 0.08), (0, -0.06, 0.975), "wood").rotation_euler[1] = math.atan2(0.98, 0.62)
    box((0.05, 0.05, 0.05), (0.29, -0.09, 1.0), "gold", bevel=0.01); box((0.12, 0.02, 0.03), (0.29, -0.075, 1.0), "gold")
    torus(0.17, 0.055, (0, -0.1, 1.5), "sage", rot=(math.pi / 2, 0, 0), maj=10, mn=4)
    for s in (-1, 1): box((0.09, 0.03, 0.05), (s * 0.05, -0.16, 1.36), "rose_dk").rotation_euler[1] = s * 0.5
    for k in range(5):
        a = 2 * math.pi * k / 5 + 0.3; ico(0.025, (0.17 * math.cos(a), -0.16, 1.5 + 0.17 * math.sin(a)), "rose", 0)

@prop
def gumdrop_bush():
    """Angular shrub studded with faceted gumdrops."""
    for loc, r, c in [((0, 0, 0.26), 0.36, "sage_dk"), ((-0.25, 0.05, 0.18), 0.26, "sage"), ((0.24, -0.04, 0.2), 0.27, "sage")]:
        o = ico(r, loc, c, 1); o.scale = (1.05, 0.9, 0.85); jitter(o, 0.035)
    drops = [((0, -0.18, 0.5), "rose"), ((-0.28, -0.14, 0.33), "lav"), ((0.26, -0.2, 0.37), "gold"), ((0.08, 0.1, 0.58), "rose_dk"),
             ((-0.15, 0.12, 0.47), "cream"), ((0.4, 0.08, 0.27), "lav"), ((-0.42, 0.0, 0.18), "rose"), ((0.13, -0.3, 0.15), "sage_dk")]
    for loc, c in drops:
        o = cyl(0.075, 0.1, loc, c, 6, r2=0.04); jitter(o, 0.006)
        o.rotation_euler = (random.uniform(-0.3, 0.3), random.uniform(-0.3, 0.3), random.uniform(0, 1))
    ground()

@prop
def icicles():
    """1 m edge strip along X. Origin = top centre of the snow ledge (snap to a roof/ledge edge);
    icicles hang below it on the front (-Y) side."""
    o = box((1.0, 0.2, 0.09), (0, 0, -0.045), "snow", bevel=0.02); jitter(o, 0.006)
    for i in range(4): o = ico(0.07, (-0.38 + i * 0.25, 0, 0.0), "snow", 0); o.scale = (1.6, 1.0, 0.45)
    xs = [-0.45 + i * 0.1 for i in range(10)]
    for i, x in enumerate(xs):
        L = random.uniform(0.14, 0.42) if i % 3 else random.uniform(0.35, 0.5)
        o = cone(random.uniform(0.032, 0.05), L, (x + random.uniform(-0.02, 0.02), -0.06, -0.08 - L / 2), "ice" if i % 2 else "ice_dk", 5)
        o.rotation_euler = (math.pi + random.uniform(-0.06, 0.06), random.uniform(-0.06, 0.06), random.uniform(0, 1))

@prop
def cave_wall():
    """1-square cave wall segment: chunky stacked stones, snow on top."""
    o = box((0.9, 0.4, 1.3), (0, 0, 0.65), "lav_dk"); jitter(o, 0.03)
    rows = [(0.2, [(-0.25, 0.5), (0.24, 0.48)]), (0.58, [(-0.32, 0.36), (0.08, 0.44), (0.4, 0.22)]), (0.98, [(-0.2, 0.56), (0.3, 0.38)])]
    for z, row in rows:
        for x, w in row:
            for y, c in ((-0.13, "lav"), (0.13, "lav_dk")):
                chunk((w, 0.22, 0.38), (x, y, z), c, 0.03, 0.08, 0.02)
    o = box((0.98, 0.5, 0.12), (0, 0, 1.32), "snow", bevel=0.03); jitter(o, 0.025)
    o = ico(0.16, (0.18, 0, 1.4), "snow", 1); o.scale = (1.8, 1.3, 0.5); jitter(o, 0.02)
    ground()

@prop
def boss_ice_wall():
    """1-square ice barrier, ~2.4 m: faceted shards over an ice core."""
    o = box((0.92, 0.42, 1.7), (0, 0.02, 0.85), "ice_dk"); jitter(o, 0.03)
    shards = [(-0.36, 1.9, 0.17), (-0.13, 2.4, 0.2), (0.12, 2.15, 0.19), (0.36, 1.75, 0.16), (-0.25, 1.4, 0.15), (0.26, 1.3, 0.15)]
    for i, (x, h, r) in enumerate(shards):
        y = -0.08 if i < 4 else -0.2
        o = cyl(r, h, (x, y, h / 2), "ice" if i % 2 == 0 else "white", 5, r2=0.015); jitter(o, 0.01)
        o.rotation_euler = (random.uniform(-0.05, 0.05), random.uniform(-0.12, 0.12), random.uniform(0, 1))
    for x in (-0.4, 0, 0.38):
        o = cyl(0.11, 0.42, (x, -0.3, 0.18), "ice", 5, r2=0.01); o.rotation_euler = (-0.35, random.uniform(-0.3, 0.3), random.uniform(0, 1))
    for x in (-0.28, 0.2): cyl(0.13, 1.1, (x, 0.2, 0.55), "ice_dk", 5, r2=0.02)
    o = ico(0.2, (0.05, -0.32, 0.03), "snow", 1); o.scale = (2.4, 0.8, 0.35)
    ground()

# ---------------------------------------------------------------- tokens / markers
@prop
def twinkle_token():
    """Gold coin lying flat with a raised star (Twinkle)."""
    cyl(0.24, 0.06, (0, 0, 0.03), "gold_dk", 10)
    cyl(0.215, 0.012, (0, 0, 0.066), "gold", 10)
    slab(star_pts(5, 0.18, 0.075), 0.06, 0.1, "glow")
    for k in range(10):
        a = k * math.pi / 5 + math.pi / 10; box((0.03, 0.03, 0.02), (0.235 * math.cos(a), 0.235 * math.sin(a), 0.07), "gold").rotation_euler[2] = a

PRESENTS = {"rose": "cream", "sage": "rose", "cream": "rose_dk", "lav": "cream", "gold": "rose_dk", "ice": "lav_dk"}
PRESENT_NAMES = {"rose": "rose", "sage": "sage", "cream": "cream", "lav": "lavender", "gold": "gold", "ice": "ice"}
for _c, _r in PRESENTS.items():
    PROPS[f"present_{PRESENT_NAMES[_c]}"] = (lambda c=_c, r=_r: present_box(c, r))

@prop
def coal_lump():
    o = ico(0.15, (0, 0, 0.12), "coal", 1); o.scale = (1.2, 0.95, 0.8); jitter(o, 0.035)
    o = ico(0.08, (0.18, -0.08, 0.06), "coal", 0); jitter(o, 0.015)
    o = ico(0.05, (-0.15, -0.12, 0.04), "coal", 0); jitter(o, 0.01)
    ground()

@prop
def candy_cane_hook():
    """Small candy cane planted in a snow mound; hook curls toward +X."""
    o = cyl(0.2, 0.08, (0, 0, 0.04), "snow", 7, r2=0.14); jitter(o, 0.01)
    for i in range(6): cyl(0.045, 0.1, (0, 0, 0.1 + i * 0.1), "rose_dk" if i % 2 else "cream", 8)
    R = 0.11
    for i in range(7):
        a = math.pi * i / 6
        cyl(0.045, 0.07, (R - R * math.cos(a), 0, 0.65 + R * math.sin(a)), "rose_dk" if i % 2 == 0 else "cream", 8, rot=(0, math.pi / 2 - a, 0))
    cyl(0.04, 0.04, (2 * R, 0, 0.62), "cream", 8)

@prop
def jingle_bell():
    o = ico(0.15, (0, 0, 0.15), "gold", 1); o.scale = (1, 1, 0.95)
    cyl(0.152, 0.025, (0, 0, 0.17), "gold_dk", 10)
    box((0.15, 0.03, 0.025), (0, -0.14, 0.08), "ink").rotation_euler[0] = -0.5
    cyl(0.02, 0.03, (0, -0.135, 0.105), "ink", 6, rot=(math.pi / 2 - 0.5, 0, 0))
    torus(0.04, 0.014, (0, 0, 0.32), "gold_dk", rot=(math.pi / 2, 0, 0), maj=8, mn=4)
    for s in (-1, 1):
        box((0.1, 0.03, 0.06), (s * 0.055, 0, 0.29), "rose_dk").rotation_euler[1] = s * 0.45
        box((0.03, 0.02, 0.12), (s * 0.04, -0.01, 0.23), "rose_dk").rotation_euler[1] = s * 0.3
    for o in meshes(): o.location *= 1.35; o.scale = o.scale * 1.35   # token size, in line with the presents
    ground()

@prop
def sled():
    """Small wooden sled, ~0.85 m along Y, curled runners at the front (-Y)."""
    for x in (-0.18, 0.18):
        o = box((0.04, 0.68, 0.035), (0, 0.06, 0.018), "rose_dk"); o.location.x = x
        for c in arc(0.08, (-0.28, 0.098), 0, 1.15 * math.pi, 6, (0.04, 0.05, 0.035), "rose_dk"): c.location.x = x
        for y in (-0.2, 0.08, 0.34): box((0.03, 0.03, 0.13), (x, y, 0.09), "wood_dk")
    for i in range(5): box((0.46, 0.11, 0.03), (0, -0.2 + i * 0.13, 0.17), "wood", bevel=0.005)
    box((0.46, 0.05, 0.05), (0, -0.33, 0.2), "wood_dk")
    for p, q in [((-0.15, -0.36), (-0.06, -0.52)), ((0.15, -0.36), (0.06, -0.52)), ((-0.06, -0.52), (0.06, -0.52))]:
        seg(p, q, 0.022, 0.022, 0.2, "sage_dk")
    ground()

@prop
def freeze_overlay():
    """Flat, see-through ice disc that covers a frozen square (alpha 0.6), with frost cross."""
    slab(ngon(12, 0.45, 0.05), 0, 0.03, "ice_clear", name="frost")
    for k in range(3):
        a = k * math.pi / 3; L = 0.33
        seg((-L * math.cos(a), -L * math.sin(a)), (L * math.cos(a), L * math.sin(a)), 0.025, 0.008, 0.034, "white")
        for s in (-1, 1):
            for t in (0.6, 1.0):
                cx, cy = s * L * 0.7 * t * math.cos(a), s * L * 0.7 * t * math.sin(a)
                for d in (-1, 1):
                    b = a + d * 0.7; seg((cx, cy), (cx + s * 0.07 * math.cos(b), cy + s * 0.07 * math.sin(b)), 0.018, 0.008, 0.034, "white")
    for k in range(6):
        a = k * math.pi / 3 + 0.4; r = 0.4
        o = cone(0.035, 0.12, (r * math.cos(a), r * math.sin(a), 0.07), "ice", 4)
        o.rotation_euler = (random.uniform(-0.3, 0.3), random.uniform(-0.3, 0.3), a)

@prop
def crumb_trail():
    """A few biscuit crumbs in a winding line across one square."""
    pts = [(-0.34, -0.3), (-0.12, -0.18), (0.02, 0.02), (0.18, 0.14), (0.32, 0.34), (-0.25, -0.05)]
    for i, (x, y) in enumerate(pts):
        r = random.uniform(0.045, 0.075)
        o = ico(r, (x, y, r * 0.5), "cookie" if i % 3 else "cookie_dk", 0); o.scale = (1.1, 1, 0.6); jitter(o, r * 0.18)
        if i % 2 == 0: ico(0.02, (x + 0.06, y - 0.04, 0.012), "cookie_dk", 0)
    ground()

def crack_tile(paths, w, plates=()):
    ice_tile()
    for path in paths:
        for p, q in zip(path, path[1:]): seg(p, q, w, 0.006, 0.002, "ink")
    for pts, z, tilt in plates:
        o = slab(pts, -0.03, 0.025, "ice"); o.location.z = z; o.rotation_euler = tilt
        for p, q in zip(pts, pts[1:] + pts[:1]): seg(p, q, w * 0.8, 0.006, 0.0, "ink").location.z += z + 0.026

@prop
def cracked_ice_1():
    """Ice floor tile, first crack stage: one crack with two branches."""
    crack_tile([[(-0.48, -0.12), (-0.22, 0.0), (0.04, -0.08), (0.2, 0.06), (0.48, 0.02)],
                [(0.04, -0.08), (0.1, -0.28), (0.06, -0.42)], [(-0.22, 0.0), (-0.28, 0.2)]], 0.016)

@prop
def cracked_ice_2():
    """Ice floor tile, second (worse) stage: star of cracks, ring, two loose tilted plates."""
    c = (0.04, -0.02); rays = []
    for k in range(7):
        a = k * 2 * math.pi / 7 + 0.2; r1, r2 = 0.2, 0.47
        m1 = (c[0] + r1 * math.cos(a + 0.12), c[1] + r1 * math.sin(a + 0.12))
        end = (max(-0.48, min(0.48, c[0] + r2 * math.cos(a))), max(-0.48, min(0.48, c[1] + r2 * math.sin(a))))
        rays.append([c, m1, end])
    ring = [(c[0] + 0.2 * math.cos(k * 2 * math.pi / 7 + 0.32), c[1] + 0.2 * math.sin(k * 2 * math.pi / 7 + 0.32)) for k in range(8)]
    crack_tile(rays + [ring], 0.024, plates=[
        ([(0.08, 0.06), (0.22, 0.1), (0.16, 0.22)], 0.012, (0.12, -0.08, 0)),
        ([(-0.12, -0.06), (-0.04, -0.18), (-0.2, -0.16)], 0.01, (-0.1, 0.1, 0))])

@prop
def water_hole():
    """Ice tile with a jagged hole of dark water."""
    ice_tile(); t = meshes()[0]
    cut = slab(ngon(9, 0.3, 0.12), -0.3, 0.3, "ink", name="cutter")
    b = t.modifiers.new("hole", "BOOLEAN"); b.object = cut; b.operation = "DIFFERENCE"
    bpy.context.view_layer.objects.active = t; bpy.ops.object.modifier_apply(modifier="hole")
    bpy.data.objects.remove(cut)
    slab(ngon(9, 0.33, 0.02), -0.09, -0.06, "water", name="water")
    for k in range(7):
        a = k * 2 * math.pi / 7 + 0.3; r = 0.33
        chunk((0.1, 0.07, 0.04), (r * math.cos(a), r * math.sin(a), 0.01), "white" if k % 2 else "ice", 0.01, 0.15).rotation_euler[2] = a
    o = slab(ngon(5, 0.06, 0.2), -0.075, -0.045, "ice"); o.location.x = 0.08; o.location.y = -0.05
    seg((-0.14, 0.06), (-0.02, 0.1), 0.012, 0.003, -0.058, "ice_dk")

@prop
def sticky_path():
    """Snow tile with a glossy syrup puddle."""
    snow_tile()
    slab(ngon(12, 0.38, 0.14, sx=1.15, sy=0.9), 0.0, 0.022, "syrup", name="syrup")
    for (x, y, l, a) in ((-0.1, 0.08, 0.22, 0.3), (0.14, -0.08, 0.12, 0.2)):
        seg((x - l / 2 * math.cos(a), y - l / 2 * math.sin(a)), (x + l / 2 * math.cos(a), y + l / 2 * math.sin(a)), 0.035, 0.006, 0.024, "syrup_hi")
    for (x, y, r) in ((0.42, 0.22, 0.05), (-0.4, -0.3, 0.04), (0.3, -0.36, 0.035)):
        o = ico(r, (x, y, 0.008), "syrup", 0); o.scale = (1.2, 1, 0.35)

@prop
def island():
    """Small snowy island for a water square. Origin at the water line: rock below z=0, snow above."""
    o = cyl(0.33, 0.32, (0, 0, -0.13), "lav_dk", 8, r2=0.45); jitter(o, 0.025)
    o = cyl(0.46, 0.1, (0, 0, 0.06), "snow", 8, r2=0.36); jitter(o, 0.02)
    o = ico(0.12, (0.22, 0.12, 0.12), "lav", 1); o.scale = (1.1, 0.9, 0.7); jitter(o, 0.02)
    cyl(0.03, 0.1, (-0.12, 0.05, 0.15), "wood_dk", 5)
    for r, h, z in ((0.17, 0.26, 0.3), (0.12, 0.22, 0.44)):
        jitter(cone(r, h, (-0.12, 0.05, z), "sage", 6), 0.01)
    for k in range(5):
        a = k * 2 * math.pi / 5 + 0.5; r = 0.46
        o = chunk((0.12, 0.09, 0.06), (r * math.cos(a), r * math.sin(a), -0.01), "ice", 0.01, 0.2)

@prop
def roof_gap_edge():
    """Roof-top tile whose front (-Y) edge is broken off: jagged shingles, snapped beam, icicles."""
    edge = [(0.5, -0.28), (0.32, -0.16), (0.17, -0.37), (-0.04, -0.2), (-0.2, -0.4), (-0.36, -0.18), (-0.5, -0.32)]
    slab([(-0.5, 0.5), (0.5, 0.5)] + edge, -0.14, 0.0, "rose_dk", name="roof")
    for i, y in enumerate((0.38, 0.16, -0.06)):
        o = box((1.0, 0.2, 0.03), (0, y, 0.012), "rose" if i % 2 else "lav_dk"); o.rotation_euler[0] = -0.06
    o = slab([(-0.5, 0.5), (0.5, 0.5), (0.5, 0.1), (0.2, 0.02), (-0.15, 0.12), (-0.5, 0.05)], 0.03, 0.08, "snow"); jitter(o, 0.006)
    box((0.08, 0.34, 0.08), (0.08, -0.2, -0.1), "wood_dk").rotation_euler = (0.2, 0, 0.1)
    box((0.08, 0.3, 0.08), (-0.3, -0.12, -0.1), "wood_dk").rotation_euler = (-0.15, 0, -0.08)
    for (x, y, rz) in ((0.3, -0.12, 0.5), (-0.15, -0.14, -0.4), (0.0, 0.0, 0.2)):
        box((0.16, 0.12, 0.025), (x, y, 0.04), "rose").rotation_euler = (0.3, -0.2, rz)
    for x, y in edge[1:-1]:
        L = random.uniform(0.12, 0.24); cone(0.03, L, (x, y + 0.02, -0.14 - L / 2), "ice", 5).rotation_euler[0] = math.pi

# ---------------------------------------------------------------- third batch: GM set dressing
@prop
def snowman():
    """~1.3 m snowman: three faceted snowballs, top hat, scarf, carrot nose toward -Y, stick arms."""
    for r, z in ((0.33, 0.3), (0.24, 0.76), (0.165, 1.06)):
        o = ico(r, (0, 0, z), "snow", 1); o.scale = (1, 0.95, 0.92); jitter(o, r * 0.06)
    cyl(0.17, 0.025, (0, 0, 1.2), "ink", 8); cyl(0.11, 0.15, (0, 0, 1.285), "ink", 8, r2=0.105)
    cyl(0.112, 0.035, (0, 0, 1.23), "rose_dk", 8)
    torus(0.15, 0.045, (0, 0, 0.94), "rose", maj=10, mn=4)
    box((0.08, 0.035, 0.24), (0.07, -0.17, 0.83), "rose").rotation_euler[1] = -0.15
    for z in (0.74, 0.81, 0.88): box((0.082, 0.04, 0.025), (0.072 - (z - 0.83) * 0.15, -0.19, z), "rose_dk").rotation_euler[1] = -0.15
    cone(0.03, 0.15, (0, -0.22, 1.06), "cookie", 5).rotation_euler[0] = math.pi / 2
    for x in (-0.06, 0.06): ico(0.022, (x, -0.145, 1.11), "coal", 0)
    for k in range(4): ico(0.018, (-0.075 + k * 0.05, -0.14, 1.0 - 0.012 * (1 if k in (0, 3) else 0)), "coal", 0)
    for z in (0.68, 0.8): ico(0.026, (0, -0.225, z), "coal", 0)
    ico(0.03, (0, -0.315, 0.32), "coal", 0)
    for s in (-1, 1):
        cyl(0.016, 0.42, (s * 0.38, 0, 0.86), "wood_dk", 5, rot=(0, s * 1.05, 0))
        cyl(0.011, 0.12, (s * 0.53, -0.01, 1.0), "wood_dk", 5, rot=(0, s * 0.35, 0))
    o = ico(0.4, (0, 0, 0.02), "snow", 1); o.scale = (1.15, 1.05, 0.16); jitter(o, 0.02)
    ground()

@prop
def wreath_stand():
    """Wreath hung on a small post (~1.2 m), wreath facing -Y, cross feet on the ground."""
    for a in (0, math.pi / 2): box((0.5, 0.08, 0.06), (0, 0, 0.03), "wood_dk").rotation_euler[2] = a
    box((0.08, 0.08, 1.12), (0, 0.04, 0.6), "wood", bevel=0.01)
    cone(0.075, 0.08, (0, 0.04, 1.2), "wood", 4).rotation_euler[2] = math.pi / 4
    o = box((0.13, 0.13, 0.04), (0, 0.04, 1.17), "snow", bevel=0.01); jitter(o, 0.006)
    box((0.03, 0.06, 0.03), (0, -0.01, 1.05), "ink")                                  # hook
    torus(0.22, 0.07, (0, -0.06, 0.82), "sage", rot=(math.pi / 2, 0, 0), maj=10, mn=4)
    torus(0.22, 0.04, (0, -0.1, 0.82), "sage_dk", rot=(math.pi / 2, 0.3, 0), maj=10, mn=4)
    for s in (-1, 1):                                                                 # bow at the bottom
        box((0.13, 0.04, 0.08), (s * 0.07, -0.15, 0.6), "rose_dk").rotation_euler[1] = s * 0.45
        box((0.04, 0.03, 0.16), (s * 0.04, -0.15, 0.5), "rose_dk").rotation_euler[1] = s * 0.3
    box((0.055, 0.05, 0.055), (0, -0.16, 0.6), "rose")
    for k in range(7):
        a = 2 * math.pi * k / 7 - 0.9
        ico(0.03, (0.23 * math.cos(a), -0.14, 0.82 + 0.23 * math.sin(a)), "rose" if k % 2 else "gold", 0)
    ground()

@prop
def gift_sack():
    """Bulging sack of presents (~0.85 m), tied at the neck, a gift peeking beside it."""
    o = ico(0.32, (0, 0, 0.3), "sage", 1); o.scale = (1.05, 0.95, 1.0); jitter(o, 0.035)
    o = cyl(0.17, 0.16, (0, 0, 0.62), "sage", 7, r2=0.08); jitter(o, 0.01)
    torus(0.085, 0.025, (0, 0, 0.66), "gold", maj=8, mn=4)
    o = cyl(0.07, 0.14, (0, 0, 0.75), "sage_dk", 6, r2=0.13); jitter(o, 0.012)
    for s in (-1, 1): box((0.03, 0.02, 0.16), (s * 0.05, -0.08, 0.6), "gold").rotation_euler[1] = s * 0.35
    present_box("rose", "cream", 0.55, (0.3, -0.24, 0.0))
    for o in present_box("lav", "cream", 0.42, (-0.32, -0.15, 0.0)): o.rotation_euler[2] = 0.5
    ground()

@prop
def rocking_horse():
    """Full-size wooden rocking horse (~0.9 m tall, ~1 m along Y), nose toward -Y."""
    S = 2.1
    def horse():
        box((0.12, 0.3, 0.12), (0, 0, 0.22), "wood", bevel=0.01)
        box((0.08, 0.08, 0.17), (0, -0.15, 0.32), "wood").rotation_euler[0] = -0.35
        box((0.09, 0.15, 0.08), (0, -0.22, 0.4), "wood", bevel=0.01)
        box((0.07, 0.04, 0.05), (0, -0.29, 0.385), "wood_dk")                                  # muzzle
        for dx in (-0.025, 0.025): box((0.02, 0.025, 0.045), (dx, -0.17, 0.455), "wood_dk")    # ears
        for dx in (-0.047, 0.047): box((0.006, 0.018, 0.018), (dx, -0.24, 0.415), "ink")       # eyes
        box((0.025, 0.12, 0.08), (0, -0.11, 0.36), "rose_dk").rotation_euler[0] = -0.4         # mane
        box((0.03, 0.03, 0.1), (0, 0.17, 0.25), "rose_dk").rotation_euler[0] = 0.6              # tail
        box((0.13, 0.11, 0.025), (0, 0.0, 0.29), "rose", bevel=0.004)                           # saddle
        box((0.135, 0.06, 0.012), (0, 0.0, 0.305), "gold")
        box((0.16, 0.012, 0.012), (0, -0.2, 0.43), "gold")                                      # handle
        for dx in (-0.045, 0.045):
            for dy in (-0.11, 0.11): box((0.035, 0.035, 0.12), (dx, dy, 0.12), "wood_dk")
            for c in arc(0.42, (0, 0.47), -0.42, 0.42, 7, (0.03, 0.07, 0.025), "rose"): c.location.x = dx
        box((0.12, 0.025, 0.025), (0, 0.0, 0.055), "rose_dk")                                   # rocker stretcher
    for o in new_objs(horse): o.location = o.location * S + Vector((0, 0.1, 0)); o.scale = o.scale * S
    ground()

@prop
def toy_train():
    """Big toy train ~1.2 m along X: engine (front +X) and one wagon of presents. Side faces -Y."""
    def wheels(xs, r=0.07):
        for x in xs:
            for y in (-0.15, 0.15):
                cyl(r, 0.03, (x, y, r), "ink", 8, rot=(math.pi / 2, 0, 0))
                cyl(r * 0.45, 0.034, (x, y, r), "gold", 6, rot=(math.pi / 2, 0, 0))
    ex = 0.28   # engine centre x
    box((0.6, 0.28, 0.06), (ex, 0, 0.12), "ink")
    wheels((ex - 0.18, ex, ex + 0.18))
    cyl(0.11, 0.36, (ex + 0.1, 0, 0.26), "rose_dk", 8, rot=(0, math.pi / 2, 0))
    for x in (ex - 0.05, ex + 0.12): cyl(0.116, 0.025, (x, 0, 0.26), "gold", 8, rot=(0, math.pi / 2, 0))
    cyl(0.09, 0.02, (ex + 0.285, 0, 0.26), "ink", 8, rot=(0, math.pi / 2, 0))
    ico(0.03, (ex + 0.3, 0, 0.29), "glow", 0)                                                   # headlamp
    cyl(0.04, 0.14, (ex + 0.18, 0, 0.42), "ink", 6, r2=0.065)                                   # funnel
    cyl(0.05, 0.05, (ex + 0.02, 0, 0.39), "gold", 6)                                            # steam dome
    box((0.22, 0.28, 0.3), (ex - 0.19, 0, 0.3), "sage", bevel=0.01)                            # cab
    for y in (-0.142, 0.142): box((0.12, 0.01, 0.1), (ex - 0.19, y, 0.37), "cream")
    box((0.28, 0.34, 0.035), (ex - 0.19, 0, 0.47), "rose", bevel=0.005)                         # cab roof
    slab([(ex + 0.3, 0.16), (ex + 0.3, 0.09), (ex + 0.4, 0.02)], -0.13, 0.13, "gold_dk", axis="y")   # cowcatcher
    wx = -0.38  # wagon centre x
    box((0.44, 0.28, 0.06), (wx, 0, 0.12), "ink")
    wheels((wx - 0.13, wx + 0.13))
    box((0.44, 0.28, 0.025), (wx, 0, 0.165), "wood_dk")
    for y in (-0.13, 0.13): box((0.44, 0.025, 0.14), (wx, y, 0.24), "lav")
    for x in (wx - 0.21, wx + 0.21): box((0.025, 0.28, 0.14), (x, 0, 0.24), "lav")
    for y in (-0.145, 0.145): box((0.44, 0.012, 0.025), (wx, y, 0.3), "cream")
    present_box("gold", "rose_dk", 0.38, (wx - 0.08, 0.0, 0.18))
    for o in present_box("rose", "cream", 0.3, (wx + 0.1, 0.03, 0.18)): o.rotation_euler[2] = 0.4
    box((0.12, 0.03, 0.03), (-0.09, 0, 0.12), "ink")                                            # coupling
    ground()

@prop
def snow_drift():
    """Low snow mound (~0.2 m), walk-over decor for any square."""
    o = slab(ngon(10, 0.46, 0.12, 1.0, 0.8), 0.0, 0.05, "snow", name="drift"); jitter(o, 0.01)
    for loc, sc in (((-0.05, 0.02, 0.05), (0.42, 0.3, 0.12)), ((0.18, -0.06, 0.08), (0.22, 0.18, 0.1)), ((-0.24, 0.08, 0.04), (0.18, 0.15, 0.07))):
        o = ico(1, loc, "snow", 1); o.scale = sc; jitter(o, 0.08)
    o = ico(1, (0.1, 0.1, 0.07), "white", 1); o.scale = (0.12, 0.1, 0.05)
    ground()

@prop
def bench():
    """Park bench, 1.4 m along X, seat 0.48 m, back toward +Y, iron side frames, snow on the seat."""
    for x in (-0.6, 0.6):
        box((0.05, 0.05, 0.47), (x, -0.17, 0.235), "ink"); box((0.05, 0.05, 0.92), (x, 0.18, 0.46), "ink").rotation_euler[0] = -0.12
        box((0.05, 0.42, 0.05), (x, 0.0, 0.45), "ink"); box((0.05, 0.4, 0.04), (x, 0.0, 0.1), "ink")
        box((0.05, 0.32, 0.04), (x, -0.06, 0.66), "ink"); box((0.05, 0.05, 0.2), (x, -0.2, 0.56), "ink")
        for y in (-0.17, 0.15): box((0.1, 0.1, 0.02), (x, y, 0.01), "ink")
    for i in range(4): box((1.4, 0.085, 0.035), (0, -0.18 + i * 0.1, 0.49), "wood", bevel=0.006)
    for i, z in enumerate((0.64, 0.76, 0.88)): box((1.4, 0.03, 0.09), (0, 0.205 + i * 0.015, z), "wood", bevel=0.006).rotation_euler[0] = -0.12
    o = slab(ngon(8, 0.2, 0.15, 1.6, 0.6), 0.505, 0.54, "snow"); o.location.x = -0.3; jitter(o, 0.006)
    o = box((1.3, 0.05, 0.03), (0, 0.24, 0.935), "snow", bevel=0.01); jitter(o, 0.006)
    ground()

def arrow_board(L, h, t, m):
    """Arrow-shaped board pointing +X, built around its own origin (rotate it about Z after)."""
    pts = [(-L / 2, -h / 2), (L / 2 - 0.1, -h / 2), (L / 2, 0), (L / 2 - 0.1, h / 2), (-L / 2, h / 2), (-L / 2 + 0.05, 0)]
    return slab(pts, -t / 2, t / 2, m, axis="y", name="board")

@prop
def signpost():
    """Crossroads sign (~1.8 m): post with two arrow boards pointing different ways."""
    o = ico(0.25, (0, 0, 0.02), "snow", 1); o.scale = (1.2, 1.0, 0.25); jitter(o, 0.02)
    box((0.09, 0.09, 1.7), (0, 0, 0.85), "wood_dk", bevel=0.01)
    cone(0.085, 0.1, (0, 0, 1.75), "wood_dk", 4).rotation_euler[2] = math.pi / 4
    o = box((0.13, 0.13, 0.04), (0, 0, 1.72), "snow", bevel=0.01); jitter(o, 0.006)
    for (z, rz, flip, col) in ((1.5, 0.25, 1, "rose"), (1.22, -0.35, -1, "sage")):
        def build():
            b = arrow_board(0.72, 0.18, 0.035, col); b.location.x = 0.3
            for k, w in enumerate((0.36, 0.26)):
                for y in (-0.022, 0.022): box((w, 0.01, 0.022), (0.24 - (0.36 - w) / 2, y, 0.03 - k * 0.055), "ink")
            o = box((0.62, 0.05, 0.03), (0.28, 0.0, 0.1), "snow"); jitter(o, 0.004)
        for o in new_objs(build):
            p = o.location.copy(); p.x *= flip
            o.location = Matrix.Rotation(rz, 3, "Z") @ p + Vector((0, 0, z))
            o.rotation_euler[2] += rz + (math.pi if flip < 0 else 0)
    ground()

@prop
def mailbox():
    """Letters-to-the-North-Pole pillar box (~1.25 m): slot facing -Y, a letter going in, star on top."""
    cyl(0.25, 0.08, (0, 0, 0.04), "lav_dk", 8)
    cyl(0.2, 0.92, (0, 0, 0.54), "rose_dk", 8)
    cyl(0.215, 0.04, (0, 0, 0.98), "gold", 8); cyl(0.205, 0.035, (0, 0, 0.14), "gold", 8)
    cyl(0.22, 0.08, (0, 0, 1.04), "rose_dk", 8, r2=0.17)
    o = cyl(0.17, 0.1, (0, 0, 1.13), "snow", 8, r2=0.06); jitter(o, 0.008)
    box((0.22, 0.04, 0.035), (0, -0.19, 0.86), "ink")
    box((0.26, 0.03, 0.025), (0, -0.2, 0.895), "rose")                                       # slot lip
    o = box((0.16, 0.008, 0.11), (0, -0.215, 0.89), "cream"); o.rotation_euler[0] = 0.5     # letter
    ico(0.016, (0, -0.25, 0.885), "rose", 0)
    box((0.2, 0.03, 0.14), (0, -0.19, 0.62), "cream", bevel=0.01)                            # label plate
    slab(star_pts(5, 0.04, 0.017), -0.205, -0.205 - 0.012, "gold", axis="y").location.z = 0.62
    box((0.1, 0.03, 0.02), (0, -0.2, 0.33), "ink")                                           # door handle
    slab(star_pts(5, 0.1, 0.045), -0.02, 0.02, "glow", axis="y").location.z = 1.3
    cyl(0.015, 0.08, (0, 0, 1.2), "gold", 4)
    ground()

@prop
def fireplace():
    """Hearth 1.4 m wide (X), opening facing -Y, glowing embers and logs, stocking bar under the mantel."""
    box((1.6, 0.72, 0.07), (0, -0.1, 0.035), "lav")                                          # hearth stone
    for x in (-0.55, 0.55): box((0.3, 0.5, 0.83), (x, 0.0, 0.485), "rose_dk", bevel=0.01)
    box((1.4, 0.5, 0.28), (0, 0.0, 1.04), "rose_dk", bevel=0.01)                              # lintel
    box((0.82, 0.06, 0.84), (0, 0.22, 0.49), "coal")                                          # back wall
    box((0.82, 0.46, 0.02), (0, 0.0, 0.08), "coal")
    for z in (0.3, 0.6):
        for x in (-0.55, 0.55): box((0.31, 0.012, 0.02), (x, -0.255, z), "lav_dk")
    box((1.41, 0.012, 0.02), (0, -0.255, 1.0), "lav_dk")
    box((1.62, 0.62, 0.07), (0, -0.04, 1.215), "wood", bevel=0.01)                            # mantel shelf
    box((1.5, 0.04, 0.05), (0, -0.33, 1.16), "wood_dk")
    # embers and logs
    for k in range(7):
        o = ico(0.05, (-0.26 + k * 0.085, 0.02 + 0.06 * ((k * 3) % 4 - 1.5) / 1.5, 0.11), "glow" if k % 2 else "gold", 0); jitter(o, 0.01)
    for (x, rz) in ((-0.1, 0.3), (0.12, -0.25)):
        cyl(0.055, 0.5, (x, 0.02, 0.16), "wood_dk", 6, rot=(0, math.pi / 2, rz))
    cyl(0.05, 0.46, (0, 0.06, 0.25), "wood_dk", 6, rot=(0, math.pi / 2, 0.05))
    for (x, h, r) in ((-0.1, 0.3, 0.07), (0.05, 0.38, 0.08), (0.17, 0.24, 0.06)):
        o = cone(r, h, (x, 0.0, 0.2 + h / 2), "glow", 5); jitter(o, 0.008)
        cone(r * 0.55, h * 0.6, (x, -0.02, 0.2 + h * 0.3), "gold", 5)
    # stockings on hooks
    cyl(0.012, 1.2, (0, -0.34, 1.13), "gold", 6, rot=(0, math.pi / 2, 0))
    for x, c in ((-0.42, "rose"), (0.0, "sage"), (0.42, "lav")):
        box((0.015, 0.03, 0.06), (x, -0.355, 1.12), "ink")
        sock = [(-0.07, 1.08), (0.07, 1.08), (0.07, 0.8), (0.15, 0.74), (0.15, 0.68), (0.04, 0.66), (-0.07, 0.74)]
        o = slab(sock, -0.35, -0.39, c, axis="y"); o.location.x = x
        box((0.17, 0.05, 0.07), (x, -0.37, 1.07), "cream", bevel=0.008)
    # candles on the mantel
    for x in (-0.6, 0.6):
        cyl(0.045, 0.02, (x, -0.05, 1.26), "gold", 6); cyl(0.03, 0.14, (x, -0.05, 1.34), "cream", 6)
        cone(0.018, 0.05, (x, -0.05, 1.435), "glow", 4)
    ground()

@prop
def log_pile():
    """Stacked firewood (3-2-1 logs) with cut ends facing +-X, snow on top. ~0.9 m long, 0.5 m tall."""
    r = 0.095; L = 0.9
    for row, n in enumerate((3, 2, 1)):
        for i in range(n):
            y = (i - (n - 1) / 2) * 2 * r * 1.02; z = r + row * r * 1.72
            o = cyl(r * random.uniform(0.92, 1.05), L * random.uniform(0.94, 1.0), (random.uniform(-0.03, 0.03), y, z), "wood_dk", 7, rot=(0, math.pi / 2, random.uniform(-0.04, 0.04)))
            for s in (-1, 1): cyl(r * 0.8, 0.012, (o.location.x + s * o.dimensions.z / 2, y, z), "cookie", 7, rot=(0, math.pi / 2, 0))
    for dx in (-0.3, 0.3):
        for dy in (-0.33, 0.33): box((0.06, 0.06, 0.42), (dx, dy, 0.21), "wood")             # stakes
    o = ico(1, (0, 0, r + 3.44 * r + 0.8 * r), "snow", 1); o.scale = (0.4, 0.09, 0.04); jitter(o, 0.05)
    o = ico(1, (0.1, -0.1, r + 1.72 * r + 0.85 * r), "snow", 1); o.scale = (0.25, 0.07, 0.03)
    ground()

@prop
def lantern():
    """Small standing floor lantern (~0.55 m): ink frame, glowing glass, pyramid roof, ring handle."""
    box((0.26, 0.26, 0.04), (0, 0, 0.02), "ink", bevel=0.005)
    box((0.22, 0.22, 0.04), (0, 0, 0.06), "ink")
    box((0.17, 0.17, 0.26), (0, 0, 0.21), "glow")
    for x in (-0.095, 0.095):
        for y in (-0.095, 0.095): box((0.025, 0.025, 0.28), (x, y, 0.21), "ink")
    for y in (-0.096, 0.096): box((0.012, 0.012, 0.26), (0, y, 0.21), "ink")
    for x in (-0.096, 0.096): box((0.012, 0.012, 0.26), (x, 0, 0.21), "ink")
    box((0.24, 0.24, 0.035), (0, 0, 0.36), "ink")
    cone(0.18, 0.12, (0, 0, 0.437), "ink", 4).rotation_euler[2] = math.pi / 4
    o = cone(0.125, 0.1, (0, 0, 0.465), "snow", 4); o.rotation_euler[2] = math.pi / 4 + 0.05
    cyl(0.02, 0.03, (0, 0, 0.5), "ink", 6)
    torus(0.04, 0.009, (0, 0, 0.55), "ink", rot=(math.pi / 2, 0, 0), maj=8, mn=4)
    ground()


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--list" in argv:
        print("\n".join(PROPS)); raise SystemExit
    if "--new" in argv: names = [n for n in PROPS if n not in ORIGINAL]
    elif argv: names = [n for n in PROPS if any(fnmatch.fnmatch(n, a) for a in argv)]
    else: names = list(PROPS)
    for name in names:
        clear(); bpy.context.scene.cursor.location = (0, 0, 0)
        if name in ORIGINAL: PROPS[name](); export(name)
        else:
            random.seed(name); PROPS[name](); export(name, keep=KEEP.get(name, ()), apply=True)
