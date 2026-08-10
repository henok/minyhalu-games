# Scout character builder — M2 "walking skeleton" (concept sheet CH-01).
#
# Reuses the Mixamo skeleton + mocap clips already shipped in Xbot.glb
# (67 joints incl. full finger chains and eye bones), builds the stylized-
# realistic Scout body around it with a Skin-modifier cage, auto-skins it,
# and exports one self-contained scout.glb.
#
# Run headless:
#   blender -b -P tools/scout/build_scout.py -- --previews /tmp/out   # renders only
#   blender -b -P tools/scout/build_scout.py -- --export              # writes scout.glb
#
# Everything is parametric: tweak PROPORTIONS / PALETTE and re-run.

import bpy
import math
import os
import sys
from mathutils import Vector

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(ROOT, "..", ".."))
XBOT = os.path.join(REPO, "hide-and-seek", "public", "models", "Xbot.glb")
OUT_GLB = os.path.join(REPO, "hide-and-seek", "public", "models", "scout.glb")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
DO_EXPORT = "--export" in argv
PREVIEW_DIR = None
if "--previews" in argv:
    PREVIEW_DIR = argv[argv.index("--previews") + 1]

# ---- tunables ----------------------------------------------------------
# skin-cage radii in meters: (rx, ry) per joint
PROPORTIONS = {
    "Hips":        (0.115, 0.095),
    "Spine1":      (0.110, 0.085),
    "Spine2":      (0.130, 0.092),
    "Neck":        (0.042, 0.042),
    "Head":        (0.092, 0.098),
    "HeadCap":     (0.066, 0.066),
    "Shoulder":    (0.054, 0.054),
    "Arm":         (0.052, 0.052),
    "ForeArm":     (0.046, 0.046),
    "Hand":        (0.036, 0.026),
    "FingerBase":  (0.0105, 0.0105),
    "FingerMid":   (0.0095, 0.0095),
    "FingerTip":   (0.0080, 0.0080),
    "ThumbBase":   (0.0130, 0.0130),
    "UpLeg":       (0.076, 0.076),
    "Leg":         (0.058, 0.058),
    "Foot":        (0.038, 0.033),
    "ToeBase":     (0.040, 0.022),
    "ToeEnd":      (0.032, 0.016),
}
SLEEVE_END = 0.38      # fraction of upper-arm covered by the tee sleeve
SHORTS_END = 0.52      # fraction of thigh covered by shorts

PALETTE = {
    "skin":   (0.788, 0.560, 0.396, 1.0),   # #c98f65
    "shirt":  (0.271, 0.446, 0.680, 1.0),   # scout blue
    "shorts": (0.196, 0.216, 0.271, 1.0),   # slate navy
    "shoe":   (0.882, 0.867, 0.827, 1.0),   # canvas white
    "hair":   (0.239, 0.169, 0.122, 1.0),   # chestnut
    "eye":    (0.092, 0.075, 0.062, 1.0),   # dark iris
    "brow":   (0.239, 0.169, 0.122, 1.0),   # hair color, own slot so morphs
    "mouth":  (0.35, 0.16, 0.14, 1.0),      # can find the verts by material
}

MX = "mixamorig:"

# ---- scene setup -------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=XBOT)

arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
arm.name = "Scout"
for o in [o for o in bpy.data.objects if o.type == "MESH"]:
    bpy.data.objects.remove(o, do_unlink=True)

# the importer stashes every clip as an NLA track; a fresh (render) depsgraph
# re-evaluates that stack and stomps any manually held pose — drop the tracks,
# keep the actions
if arm.animation_data:
    for _t in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(_t)
for _a in bpy.data.actions:
    _a.use_fake_user = True

arm.data.pose_position = "REST"
bpy.context.view_layer.update()


def joint(name, end=False):
    """World-space head (or tail) of a mixamorig bone, in meters."""
    b = arm.data.bones[MX + name]
    return arm.matrix_world @ (b.tail_local if end else b.head_local)


# world orientation, derived instead of assumed: forward = face direction
_head = joint("Head")
_eye_mid = (joint("LeftEye") + joint("RightEye")) / 2
FWD = (_eye_mid - _head)
FWD.z = 0.0
FWD.normalize()
UP = Vector((0, 0, 1))
RIGHT = FWD.cross(UP)

# ---- build the skin cage ----------------------------------------------
verts, edges, radii = [], [], []
index_of = {}


def add_joint(key, pos, rad_key):
    index_of[key] = len(verts)
    verts.append(pos)
    radii.append(PROPORTIONS[rad_key])
    return index_of[key]


def link(a, b):
    edges.append((index_of[a], index_of[b]))


# torso + head
add_joint("Hips", joint("Hips"), "Hips")
add_joint("Spine1", joint("Spine1"), "Spine1")
add_joint("Spine2", joint("Spine2"), "Spine2")
add_joint("Neck", joint("Neck"), "Neck")
add_joint("Head", joint("Head"), "Head")
head_cap = joint("Head") + (joint("HeadTop_End") - joint("Head")) * 0.80
add_joint("HeadCap", head_cap, "HeadCap")
for a, b in [("Hips", "Spine1"), ("Spine1", "Spine2"), ("Spine2", "Neck"),
             ("Neck", "Head"), ("Head", "HeadCap")]:
    link(a, b)

FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"]
for S in ("Left", "Right"):
    # arm chain
    add_joint(S + "Shoulder", joint(S + "Shoulder"), "Shoulder")
    add_joint(S + "Arm", joint(S + "Arm"), "Arm")
    add_joint(S + "ForeArm", joint(S + "ForeArm"), "ForeArm")
    add_joint(S + "Hand", joint(S + "Hand"), "Hand")
    link("Spine2", S + "Shoulder")
    link(S + "Shoulder", S + "Arm")
    link(S + "Arm", S + "ForeArm")
    link(S + "ForeArm", S + "Hand")
    # fingers branch off the hand
    for F in FINGERS:
        rad = ["ThumbBase" if F == "Thumb" else "FingerBase", "FingerMid", "FingerTip"]
        prev = S + "Hand"
        for i, rk in zip((1, 2, 3), rad):
            key = f"{S}Hand{F}{i}"
            add_joint(key, joint(f"{S}Hand{F}{i}"), rk)
            link(prev, key)
            prev = key
        tip = f"{S}Hand{F}4"
        add_joint(tip, joint(f"{S}Hand{F}4"), "FingerTip")
        link(prev, tip)
    # leg chain
    add_joint(S + "UpLeg", joint(S + "UpLeg"), "UpLeg")
    add_joint(S + "Leg", joint(S + "Leg"), "Leg")
    add_joint(S + "Foot", joint(S + "Foot"), "Foot")
    add_joint(S + "ToeBase", joint(S + "ToeBase"), "ToeBase")
    add_joint(S + "ToeEnd", joint(S + "Toe_End"), "ToeEnd")
    link("Hips", S + "UpLeg")
    link(S + "UpLeg", S + "Leg")
    link(S + "Leg", S + "Foot")
    link(S + "Foot", S + "ToeBase")
    link(S + "ToeBase", S + "ToeEnd")

body_mesh = bpy.data.meshes.new("ScoutBody")
body_mesh.from_pydata([v for v in verts], edges, [])
body = bpy.data.objects.new("ScoutBody", body_mesh)
bpy.context.scene.collection.objects.link(body)

skin_mod = body.modifiers.new("Skin", "SKIN")
sub_mod = body.modifiers.new("Subsurf", "SUBSURF")
sub_mod.levels = 2
sub_mod.render_levels = 2

skin_layer = body_mesh.skin_vertices[0].data
for i, (rx, ry) in enumerate(radii):
    skin_layer[i].radius = (rx, ry)
    skin_layer[i].use_root = False
skin_layer[index_of["Hips"]].use_root = True

# apply modifiers -> real mesh
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.convert(target="MESH")
body = bpy.context.view_layer.objects.active

# ---- materials by nearest bone segment --------------------------------
def make_mat(name, rgba):
    m = bpy.data.materials.new("Scout_" + name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Roughness"].default_value = 0.9
    m.diffuse_color = rgba
    return m


mats = {k: make_mat(k, v) for k, v in PALETTE.items()}
ORDER = ["skin", "shirt", "shorts", "shoe"]
for k in ORDER:
    body.data.materials.append(mats[k])
MI = {k: i for i, k in enumerate(ORDER)}

# cage segments used to locate a face on the body ("which limb is this")
name_of = {idx: key for key, idx in index_of.items()}
SEGS = [(name_of[a], name_of[b], Vector(verts[a]), Vector(verts[b])) for a, b in edges]

# clothing boundaries as world-space cuts — clean straight hems, no per-face noise.
# The rig stands in a T-pose, so sleeve length is a cut along |x| (the arm axis).
WAIST_Z = joint("Hips").z + 0.055
COLLAR_Z = joint("Neck").z + 0.015
HEM_Z = joint("LeftUpLeg").z + (joint("LeftLeg").z - joint("LeftUpLeg").z) * SHORTS_END
_sh_x = abs(joint("LeftArm").x)
_arm_len = abs(joint("LeftForeArm").x) - _sh_x
SLEEVE_X = _sh_x + _arm_len * SLEEVE_END


def classify(na, nb, p):
    limb = na + ">" + nb
    if "Toe" in limb or na.endswith("Foot"):        # foot + toes (not the shin)
        return MI["shoe"]
    if "Head" in limb or "Hand" in limb or na.endswith("ForeArm"):
        return MI["skin"]                           # head, hands, true forearm
    if "UpLeg" in limb:                             # pelvis + thigh
        return MI["shorts"] if p.z > HEM_Z else MI["skin"]
    if na.endswith("Leg"):                          # shin: knee → ankle
        return MI["skin"]
    if nb.endswith("Arm"):                          # shoulder→arm + upper arm: sleeve cut
        return MI["shirt"] if abs(p.x) < SLEEVE_X else MI["skin"]
    # torso column
    if p.z > COLLAR_Z:
        return MI["skin"]
    if p.z < WAIST_Z:
        return MI["shorts"]
    return MI["shirt"]


def nearest_seg(p):
    best = (1e9, None, None)
    for na, nb, a, b in SEGS:
        ab = b - a
        L2 = ab.length_squared
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, (p - a).dot(ab) / L2))
        d = (p - (a + ab * t)).length_squared
        if d < best[0]:
            best = (d, na, nb)
    return best[1], best[2]


for poly in body.data.polygons:
    center = Vector(poly.center)
    na, nb = nearest_seg(center)
    poly.material_index = classify(na, nb, center)
    poly.use_smooth = True

# ---- skinning: deterministic distance weights, no bone-heat solver ----
# Segments come from bone HEADS via an explicit chain map. glTF has no bone
# tails, and Blender's synthesized tails are garbage on multi-child bones
# (Hips, Spine2, Hand) — trusting them is what shredded the torso, for
# bone-heat and naive distance weights alike.
CHAIN = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2",
         "Spine2": "Neck", "Neck": "Head", "Head": "HeadTop_End"}
for S in ("Left", "Right"):
    CHAIN[S + "Shoulder"] = S + "Arm"
    CHAIN[S + "Arm"] = S + "ForeArm"
    CHAIN[S + "ForeArm"] = S + "Hand"
    CHAIN[S + "Hand"] = S + "HandMiddle1"
    for F in FINGERS:
        for i in (1, 2, 3):
            CHAIN[f"{S}Hand{F}{i}"] = f"{S}Hand{F}{i + 1}"
    CHAIN[S + "UpLeg"] = S + "Leg"
    CHAIN[S + "Leg"] = S + "Foot"
    CHAIN[S + "Foot"] = S + "ToeBase"
    CHAIN[S + "ToeBase"] = S + "Toe_End"

SEGB = [(MX + base, joint(base), joint(nxt)) for base, nxt in CHAIN.items()]
vgroups = {n: body.vertex_groups.new(name=n) for n, _, _ in SEGB}
for v in body.data.vertices:
    p = v.co  # mesh was built in world space; object transform is identity
    ds = []
    for n, a, b in SEGB:
        ab = b - a
        L2 = ab.length_squared
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, (p - a).dot(ab) / L2))
        ds.append(((p - (a + ab * t)).length, n))
    ds.sort(key=lambda x: x[0])
    raw = [(1.0 / (d + 0.003) ** 4, n) for d, n in ds[:3]]
    total = sum(w for w, _ in raw)
    kept = [(w / total, n) for w, n in raw if w / total > 0.04]
    total = sum(w for w, _ in kept)
    for w, n in kept:
        vgroups[n].add([v.index], w / total, "REPLACE")

body.parent = arm
body.matrix_parent_inverse = arm.matrix_world.inverted()
arm_mod = body.modifiers.new("Armature", "ARMATURE")
arm_mod.object = arm

# ---- head details: eyes, nose, hair -----------------------------------
# placed by ray-casting onto the actual face surface so nothing floats
def face_surface(origin_height, lateral):
    """Hit point on the head surface, probing along -FWD from outside."""
    start = Vector((joint("Head").x, joint("Head").y, joint("Head").z)) + lateral \
        + UP * origin_height + FWD * 0.5
    hit, loc, normal, _ = body.ray_cast(start, -FWD, distance=1.0)
    return loc if hit else start - FWD * 0.42


extras = []


def add_sphere(name, center, r, scale, mat, segments=16):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=center,
                                         segments=segments, ring_count=max(8, segments // 2))
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.scale = scale
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = True
    extras.append(ob)
    return ob


head_c = joint("Head") + (joint("HeadTop_End") - joint("Head")) * 0.45
face_r = PROPORTIONS["Head"][0]
eye_h = joint("LeftEye").z - joint("Head").z          # eye height above head joint

for S in ("Left", "Right"):
    lateral = Vector((joint(S + "Eye").x - joint("Head").x,
                      joint(S + "Eye").y - joint("Head").y, 0))
    lateral -= FWD * lateral.dot(FWD)                  # keep only sideways part
    surf = face_surface(eye_h, lateral)
    add_sphere(S + "Eye", surf - FWD * 0.003, 0.012, (1, 1, 1), mats["eye"], segments=12)

nose_surf = face_surface(eye_h - 0.03, Vector((0, 0, 0)))
add_sphere("Nose", nose_surf + FWD * 0.004, 0.014, (0.8, 0.9, 0.85), mats["skin"], segments=12)

# brows: flat wide spheres riding the surface just above each eye
for S in ("Left", "Right"):
    lateral = Vector((joint(S + "Eye").x - joint("Head").x,
                      joint(S + "Eye").y - joint("Head").y, 0))
    lateral -= FWD * lateral.dot(FWD)
    surf = face_surface(eye_h + 0.021, lateral)
    add_sphere(S + "Brow", surf + FWD * 0.007, 0.015, (1.15, 0.35, 0.40), mats["brow"], segments=10)

# mouth: thin dark ellipsoid line under the nose — shape keys open it
mouth_surf = face_surface(eye_h - 0.062, Vector((0, 0, 0)))
add_sphere("Mouth", mouth_surf + FWD * 0.002, 0.016, (1.35, 0.55, 0.30), mats["mouth"], segments=12)

hair_c = head_c - FWD * 0.030 + UP * 0.034
add_sphere("Hair", hair_c, face_r + 0.010, (1.03, 1.03, 1.02), mats["hair"])

# join extras, then hard-bind every joined vertex 100% to the Head bone —
# bone-heat on intersecting shells is exactly what shredded the first build
n_body_verts = len(body.data.vertices)
bpy.ops.object.select_all(action="DESELECT")
for ob in extras:
    ob.select_set(True)
body.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()

head_group = body.vertex_groups.get(MX + "Head") or body.vertex_groups.new(name=MX + "Head")
extra_ids = list(range(n_body_verts, len(body.data.vertices)))
for g in body.vertex_groups:
    if g != head_group:
        g.remove(extra_ids)
head_group.add(extra_ids, 1.0, "REPLACE")

# ---- face shape keys — the morph targets setExpression will drive ------
mesh = body.data
_mat_index = {m.name: i for i, m in enumerate(mesh.materials)}


def verts_of(mat_name):
    mi = _mat_index.get("Scout_" + mat_name)
    out = set()
    for p in mesh.polygons:
        if p.material_index == mi:
            out.update(p.vertices)
    return sorted(out)


def center_of(ids):
    c = Vector((0, 0, 0))
    for i in ids:
        c += mesh.vertices[i].co
    return c / max(1, len(ids))


def split_lr(ids):
    cx = center_of(ids).x
    return [i for i in ids if mesh.vertices[i].co.x >= cx], \
           [i for i in ids if mesh.vertices[i].co.x < cx]


eye_verts, brow_verts, mouth_verts = verts_of("eye"), verts_of("brow"), verts_of("mouth")
eyeL, eyeR = split_lr(eye_verts)
mouth_c = center_of(mouth_verts)

body.shape_key_add(name="Basis")


def make_key(name, build):
    sk = body.shape_key_add(name=name, from_mix=False)
    for i, v in enumerate(mesh.vertices):
        sk.data[i].co = v.co
    build(sk)


def scale_about(sk, ids, center, s, push_fwd=0.0):
    for i in ids:
        d = mesh.vertices[i].co - center
        sk.data[i].co = center + Vector((d.x * s[0], d.y * s[1], d.z * s[2])) + FWD * push_fwd


def lift(sk, ids, dz, push_fwd=0.0):
    for i in ids:
        sk.data[i].co = mesh.vertices[i].co + Vector((0, 0, dz)) + FWD * push_fwd


make_key("blink", lambda sk: [scale_about(sk, ids, center_of(ids), (1.05, 1.0, 0.10))
                              for ids in (eyeL, eyeR)])
make_key("wide", lambda sk: [scale_about(sk, ids, center_of(ids), (1.40, 1.25, 1.55), 0.002)
                             for ids in (eyeL, eyeR)])
make_key("browsUp", lambda sk: lift(sk, brow_verts, 0.014, 0.002))
make_key("mouthO", lambda sk: scale_about(sk, mouth_verts, mouth_c, (0.55, 1.6, 3.6), 0.004))
print(f"[scout] shape keys: blink/wide/browsUp/mouthO on "
      f"{len(eye_verts)}+{len(brow_verts)}+{len(mouth_verts)} verts")

print(f"[scout] tris: {sum(len(p.vertices) - 2 for p in body.data.polygons)}")

# ---- authored clips: dance, crouch-walk, crouch-idle -------------------
# Offsets are expressed as rotations about WORLD axes converted per-frame
# into bone-local space — never trust imported bone-local axes (see the
# bone-tail lesson above).
from mathutils import Quaternion, Matrix

FPS = 24  # match the imported Mixamo clips — a different fps re-times them on export
scene = bpy.context.scene
scene.render.fps = FPS

# lateral axis for sagittal-plane rotations, derived so the signs are
# anatomical: +θ about LAT sends a hanging limb's tip BACKWARD (heel to butt),
# -θ sends it forward. (FWD×UP has the opposite handedness — knees bent
# backward in the first attempt.)
LAT = UP.cross(FWD).normalized()


def pb(name):
    return arm.pose.bones[MX + name]


def rot_world(pose_bone, axis_world, ang):
    """Post-rotate a pose bone by `ang` radians about a world-space axis."""
    bpy.context.view_layer.update()  # pose matrices go stale after prior offsets
    M = (arm.matrix_world @ pose_bone.matrix).to_3x3()
    axis_local = (M.inverted() @ axis_world).normalized()
    pose_bone.rotation_quaternion = pose_bone.rotation_quaternion @ Quaternion(axis_local, ang)


def move_world(pose_bone, delta_world):
    """Translate a pose bone by a world-space delta (meters)."""
    bpy.context.view_layer.update()
    M = (arm.matrix_world @ pose_bone.matrix).to_3x3()
    pose_bone.location = pose_bone.location + M.inverted() @ delta_world


ALL_DEFORM = [b.name for b in arm.pose.bones if b.name.startswith(MX)]


def snapshot_pose():
    return {n: (arm.pose.bones[n].rotation_quaternion.copy(),
                arm.pose.bones[n].location.copy()) for n in ALL_DEFORM}


def assign_action(act):
    if not arm.animation_data:
        arm.animation_data_create()
    arm.animation_data.action = act
    slots = getattr(act, "slots", None)  # Blender 4.4+ slotted actions
    if act and slots and len(slots) and hasattr(arm.animation_data, "action_slot"):
        arm.animation_data.action_slot = slots[0]


def write_action(name, samples):
    """Build an action from [(frame, pose-snapshot)] via raw fcurves —
    keyframe_insert needs an assigned action, and an assigned action stomps
    manual pose edits on every depsgraph update. Raw writes dodge all that."""
    out = bpy.data.actions.new(name)
    # Blender 5.x slotted-action API: slot -> layer -> keyframe strip -> channelbag
    slot = out.slots.new(id_type="OBJECT", name=arm.name)
    layer = out.layers.new("Base")
    strip = layer.strips.new(type="KEYFRAME")
    bag = strip.channelbag(slot, ensure=True)
    curves = {}

    def curve(bone, path, count):
        for i in range(count):
            curves[(bone, path, i)] = bag.fcurves.new(
                f'pose.bones["{bone}"].{path}', index=i)

    first = samples[0][1]
    for n in first:
        curve(n, "rotation_quaternion", 4)
        if n == MX + "Hips":
            curve(n, "location", 3)
    for f, snap in samples:
        for n, (q, loc) in snap.items():
            for i in range(4):
                curves[(n, "rotation_quaternion", i)].keyframe_points.insert(f, q[i])
            if n == MX + "Hips":
                for i in range(3):
                    curves[(n, "location", i)].keyframe_points.insert(f, loc[i])
    for c in curves.values():
        c.update()
    print(f"[scout] wrote action {name}: {len(curves)} curves, "
          f"{len(samples)} keys/curve")
    return out


def reset_pose():
    for b in arm.pose.bones:
        b.rotation_quaternion = Quaternion((1, 0, 0, 0))
        b.location = (0, 0, 0)
    bpy.context.view_layer.update()


def apply_crouch_offsets(depth=1.0):
    """Sneaky crouch layered on whatever pose is currently applied."""
    move_world(pb("Hips"), UP * (-0.17 * depth))
    rot_world(pb("Spine"), LAT, 0.28 * depth)      # lean forward
    rot_world(pb("Spine2"), LAT, 0.22 * depth)
    rot_world(pb("Neck"), LAT, -0.30 * depth)      # keep eyes level
    for S in ("Left", "Right"):
        rot_world(pb(S + "UpLeg"), LAT, -0.55 * depth)   # knee forward
        rot_world(pb(S + "Leg"), LAT, 0.95 * depth)      # heel back
        rot_world(pb(S + "Foot"), LAT, -0.40 * depth)    # sole level again
        rot_world(pb(S + "Arm"), LAT, -0.25 * depth)     # arms slightly forward
        rot_world(pb(S + "ForeArm"), LAT, -0.45 * depth)


def bake_layered(src_name, out_name, offset_fn, stride=2):
    """Sample src action, layer offset_fn on top, bake into a new action."""
    arm.data.pose_position = "POSE"
    src = bpy.data.actions[src_name]
    f0, f1 = int(src.frame_range[0]), int(src.frame_range[1])
    samples = []
    for f in range(f0, f1 + 1, stride):
        assign_action(src)
        scene.frame_set(f)              # evaluate the source clip at f...
        assign_action(None)             # ...then detach so edits stick
        offset_fn()
        samples.append((f - f0, snapshot_pose()))
    reset_pose()
    return write_action(out_name, samples)


def author_dance():
    """Keyframed 2s dance loop: hip bounce + twist, arm pumps, head bob."""
    arm.data.pose_position = "POSE"
    assign_action(None)
    samples = []
    STEPS = 8               # poses per loop, mirrored halves
    FRAMES = 60             # 2s @ 30fps
    for i in range(STEPS + 1):
        t = i / STEPS
        frame = int(t * FRAMES)
        side = 1 if (i % 2 == 0) else -1
        beat = math.sin(t * math.tau * 2)       # double-time bounce
        reset_pose()
        # hips: bounce down on the beat, twist side to side
        move_world(pb("Hips"), UP * (-0.06 - 0.05 * abs(beat)))
        rot_world(pb("Hips"), UP, 0.35 * side)
        rot_world(pb("Spine2"), UP, -0.45 * side)      # counter-twist chest
        rot_world(pb("Neck"), UP, 0.25 * side)
        rot_world(pb("Head"), LAT, 0.10 * beat)        # head bob
        # legs: small squat, alternating heel pop
        for S, sgn in (("Left", 1), ("Right", -1)):
            rot_world(pb(S + "UpLeg"), LAT, -0.25 - 0.1 * abs(beat))
            rot_world(pb(S + "Leg"), LAT, 0.5 + 0.2 * abs(beat))
            rot_world(pb(S + "Foot"), LAT, -0.25)
        # arms: disco diagonal — the rest pose is a T, and arms lie ALONG the
        # lateral axis there, so swings happen about FWD (abduction plane)
        # with the sign taken from each arm's own direction
        up_arm = "Left" if side > 0 else "Right"
        for S in ("Left", "Right"):
            d = (joint(S + "Hand") - joint(S + "Arm")).normalized()
            s = 1.0 if d.dot(LAT) > 0 else -1.0
            if S == up_arm:                                 # punched up high
                rot_world(pb(S + "Arm"), FWD, s * 0.9)
                rot_world(pb(S + "ForeArm"), FWD, s * 0.5)
            else:                                           # dropped to the hip
                rot_world(pb(S + "Arm"), FWD, -s * 1.2)
                rot_world(pb(S + "ForeArm"), LAT, -0.9)
        samples.append((frame, snapshot_pose()))
    reset_pose()
    return write_action("dance", samples)


author_dance()
bake_layered("walk", "crouchwalk", lambda: apply_crouch_offsets(1.0))
bake_layered("idle", "crouchidle", lambda: apply_crouch_offsets(1.0), stride=4)
arm.data.pose_position = "REST"
print("[scout] authored clips: dance, crouchwalk, crouchidle")

# ---- previews ----------------------------------------------------------
def render_view(path, cam_offset, target, ortho=False):
    cam_data = bpy.data.cameras.new("Cam")
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = target + cam_offset
    cam_data.lens = 60
    direction = target - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.light = "STUDIO"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 900
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.cameras.remove(cam_data)


if "--debug" in argv:
    # dump weights of a mid-chest vertex and render a manually posed frame
    hips = joint("Hips")
    probe = min(body.data.vertices,
                key=lambda v: (v.co - Vector((hips.x, hips.y, 1.30))).length_squared)
    names = {g.index: g.name for g in body.vertex_groups}
    print("[scout] chest vert", probe.index, probe.co,
          [(names[g.group], round(g.weight, 3)) for g in probe.groups])
    arm.data.pose_position = "POSE"
    import mathutils
    arm.pose.bones[MX + "Spine2"].rotation_mode = "XYZ"
    arm.pose.bones[MX + "Spine2"].rotation_euler = (0.35, 0, 0)
    arm.pose.bones[MX + "LeftArm"].rotation_mode = "XYZ"
    arm.pose.bones[MX + "LeftArm"].rotation_euler = (0, 0, 0.8)
    bpy.context.view_layer.update()
    d = PREVIEW_DIR or os.path.join(ROOT, "previews")
    os.makedirs(d, exist_ok=True)
    chest_t = Vector((joint("Hips").x, joint("Hips").y, 0.95))
    render_view(os.path.join(d, "posetest.png"),
                (FWD + RIGHT * 0.9).normalized() * 3.0 + UP * 0.15, chest_t)
    arm.data.pose_position = "REST"

if PREVIEW_DIR:
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    chest = Vector((0, 0, 0)) + UP * 0.95
    chest.x = joint("Hips").x
    chest.y = joint("Hips").y
    # face close-ups: calm (all keys 0) vs scared (all keys up)
    face_c = joint("Head") + (joint("HeadTop_End") - joint("Head")) * 0.4
    keys = body.data.shape_keys.key_blocks

    def set_keys(**vals):
        for kb in keys:
            if kb.name != "Basis":
                kb.value = vals.get(kb.name, 0.0)
        body.update_tag()                     # make the value change reach the
        bpy.context.view_layer.update()       # next render's depsgraph

    set_keys()
    render_view(os.path.join(PREVIEW_DIR, "face_calm.png"), FWD * 0.55, face_c)
    set_keys(wide=1.0, browsUp=1.0, mouthO=1.0)
    render_view(os.path.join(PREVIEW_DIR, "face_scared.png"), FWD * 0.55, face_c)
    set_keys(blink=1.0)
    render_view(os.path.join(PREVIEW_DIR, "face_blink.png"), FWD * 0.55, face_c)
    set_keys()
    render_view(os.path.join(PREVIEW_DIR, "front.png"), FWD * 3.0 + UP * 0.15, chest)
    render_view(os.path.join(PREVIEW_DIR, "side.png"), RIGHT * 3.0 + UP * 0.15, chest)
    # posed checks: walk mid-stride + the authored clips
    arm.data.pose_position = "POSE"
    if not arm.animation_data:
        arm.animation_data_create()
    for clip, frac in (("walk", 0.5), ("dance", 0.25), ("dance2", 0.37),
                       ("crouchwalk", 0.5), ("crouchidle", 0.5)):
        act = bpy.data.actions.get(clip.rstrip("2"))
        if not act:
            continue
        assign_action(act)
        f0, f1 = act.frame_range
        bpy.context.scene.frame_set(int(f0 + (f1 - f0) * frac))
        snap = snapshot_pose()
        assign_action(None)             # render on held pose values — the render
        for n, (q, loc) in snap.items():    # depsgraph won't resolve py-made slots
            arm.pose.bones[n].rotation_quaternion = q
            arm.pose.bones[n].location = loc
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        ae = arm.evaluated_get(dg)
        print(f"[scout] {clip}: nla={len(arm.animation_data.nla_tracks) if arm.animation_data else 0} "
              f"orig LLeg={tuple(round(v, 2) for v in arm.pose.bones[MX + 'LeftLeg'].rotation_quaternion)} "
              f"eval LLeg={tuple(round(v, 2) for v in ae.pose.bones[MX + 'LeftLeg'].rotation_quaternion)}")
        render_view(os.path.join(PREVIEW_DIR, f"{clip}.png"),
                    (FWD + RIGHT * 0.9).normalized() * 3.0 + UP * 0.15, chest)
    assign_action(None)
    reset_pose()
    arm.data.pose_position = "REST"

# ---- export ------------------------------------------------------------
if DO_EXPORT:
    arm.data.pose_position = "POSE"
    if not arm.animation_data:
        arm.animation_data_create()
    arm.animation_data.action = None
    # stash every clip in the NLA so the exporter writes them all
    for track in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(track)
    for act in bpy.data.actions:
        track = arm.animation_data.nla_tracks.new()
        track.name = act.name
        track.strips.new(act.name, max(0, int(act.frame_range[0])), act)
        track.mute = True

    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_morph_normal=False,
        export_def_bones=False,
    )
    print(f"[scout] exported {OUT_GLB}")

print("[scout] done")
