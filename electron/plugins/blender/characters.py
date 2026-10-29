"""ComposeVC Blender character toolkit.

The plan/primitive driver could only assemble boxes and spheres. This module adds
the missing artist layer and is driven by new top-level plan blocks:

  human     real anatomical base mesh (MPFB2 / MakeHuman) with proportions,
            face targets, extracted eyes / teeth / tongue / lashes, scalp cap
  sculpt    subdivision + a deterministic brush driver (strokes as data,
            symmetry, falloffs, masks) for draw/clay/crease/flatten/pinch/
            grab/smooth/scrape - works headless, no view3d needed
  hair      tapered strand curves generated from the real scalp cap, or card
            strips with a generated alpha strand texture
  drape     parametric garments with fold fields (skirt/ruffle/sleeve/cape/
            veil) finished with solidify + subsurf
  ornament  motif library (scroll, leaf, braid, rope, diamond, fluted band,
            petal) as bevel/taper curves with mirror/array
  retopo    QuadriFlow / voxel remesh, weighted normals, angle seams, sharp
            edges, bevel weights, quad-friendly shading
  weights   weight transfer to garments, cloth-safe smoothing, limit/normalize,
            automatic armature weights
  view      clay / matcap-like / wireframe / freestyle form-check overrides

Every builder is data driven and returns a report dict so the agent can iterate
from numbers instead of re-rendering blindly.
"""

import json
import math
import os
import random
import traceback

import bpy
import numpy as np
from mathutils import Matrix, Vector

# Helpers injected by driver.py so both modules share one implementation.
H = {}


def init(ctx):
    H.update(ctx or {})


def _warn(message):
    fn = H.get("warn")
    if fn:
        fn(message)
    else:
        print("[cv:warn] %s" % message, flush=True)


def _log(message):
    fn = H.get("log")
    if fn:
        fn(message)


def _progress(stage, percent, **extra):
    fn = H.get("progress")
    if fn:
        fn(stage, percent, **extra)


def _scene():
    fn = H.get("scene_fn")
    return fn() if fn else bpy.context.scene


def _view_layer():
    return bpy.context.view_layer


def _as_float(value, fallback=0.0):
    fn = H.get("as_float")
    if fn:
        return fn(value, fallback)
    try:
        return float(value)
    except Exception:
        return fallback


def _as_int(value, fallback=0):
    fn = H.get("as_int")
    if fn:
        return fn(value, fallback)
    try:
        return int(value)
    except Exception:
        return fallback


def _as_vec3(value, fallback=(0.0, 0.0, 0.0)):
    fn = H.get("as_vec3")
    if fn:
        return fn(value, fallback)
    try:
        return tuple(float(v) for v in value)[:3]
    except Exception:
        return fallback


def _select_only(obj):
    fn = H.get("select_only")
    if fn:
        fn(obj)
        return
    for other in bpy.context.selected_objects:
        other.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def _collection(name):
    fn = H.get("ensure_collection")
    if fn:
        return fn(name)
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        _scene().collection.children.link(coll)
    return coll


def _material(spec, cache, hint=""):
    if isinstance(spec, dict):
        fn = H.get("build_material")
        if fn:
            name = str(spec.get("name") or spec.get("id") or (hint + " Material"))
            if name in (cache or {}):
                return cache[name]
            mat = fn({**spec, "name": name})
            if mat is not None and cache is not None:
                cache[name] = mat
            return mat
    fn = H.get("material_for")
    if fn:
        return fn(spec, cache or {}, hint)
    return None


def _objects(spec, default="all"):
    """Resolve an object selector: name / list of names / '*' / 'all'."""
    value = None
    if isinstance(spec, dict):
        value = spec.get("object") or spec.get("objects") or spec.get("target") or default
    else:
        value = spec if spec is not None else default
    if isinstance(value, str):
        names = [value] if value not in ("*", "all", "ALL") else []
        if not names:
            return [obj for obj in _scene().objects if obj.type == "MESH"]
        obj = bpy.data.objects.get(value)
        return [obj] if obj is not None else []
    if isinstance(value, (list, tuple)):
        found = []
        for name in value:
            if str(name) in ("*", "all", "ALL"):
                return [obj for obj in _scene().objects if obj.type == "MESH"]
            obj = bpy.data.objects.get(str(name))
            if obj is not None:
                found.append(obj)
        return found
    return [obj for obj in _scene().objects if obj.type == "MESH"]


def _active(obj):
    _select_only(obj)
    return obj


def _apply_modifier(obj, mod):
    try:
        _active(obj)
        bpy.ops.object.modifier_apply(modifier=mod.name)
        return True
    except Exception as exc:
        _warn("apply modifier %s on %s failed: %s" % (mod.type, obj.name, exc))
        return False


def _mesh_arrays(obj):
    me = obj.data
    count = len(me.vertices)
    co = np.empty(count * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(count, 3).astype(np.float64)
    nrm = np.empty(count * 3, dtype=np.float32)
    me.vertices.foreach_get("normal", nrm)
    nrm = nrm.reshape(count, 3).astype(np.float64)
    return me, co, nrm


def _write_co(me, co):
    me.vertices.foreach_set("co", co.astype(np.float32).ravel())
    me.update()


def _norm(vec):
    length = float(np.linalg.norm(vec))
    if length < 1e-9:
        return np.array([0.0, 0.0, 1.0])
    return vec / length


def _group_indices(obj, names):
    """Return {group name: np.int array of vertex indices} for the given groups."""
    groups = {}
    index_to_name = {}
    for name in names:
        vg = obj.vertex_groups.get(name)
        if vg is not None:
            index_to_name[vg.index] = name
            groups[name] = []
    if not index_to_name:
        return {}
    for vert in obj.data.vertices:
        for element in vert.groups:
            name = index_to_name.get(element.group)
            if name is not None and element.weight > 1e-4:
                groups[name].append(vert.index)
    return {name: np.array(sorted(set(indices)), dtype=np.int64) for name, indices in groups.items() if indices}


def _group_center(obj, name, indices=None):
    if indices is None:
        found = _group_indices(obj, [name])
        indices = found.get(name)
    if indices is None or not len(indices):
        return None
    co, _, _ = _mesh_arrays(obj)
    return co[indices].mean(axis=0)


# ---------------------------------------------------------------------------
# measurements / landmarks
# ---------------------------------------------------------------------------


def measure(obj):
    """Geometry + anatomy report. Used for cheap numeric iteration loops."""
    if obj is None or obj.type != "MESH":
        return {}
    co, _, _ = _mesh_arrays(obj)
    lo = co.min(axis=0)
    hi = co.max(axis=0)
    me = obj.data
    tris = sum(max(0, len(poly.vertices) - 2) for poly in me.polygons)
    report = {
        "object": obj.name,
        "vertices": int(len(co)),
        "polygons": int(len(me.polygons)),
        "triangles": int(tris),
        "dimensions": [round(float(v), 4) for v in (hi - lo)],
        "height": round(float(hi[2] - lo[2]), 4),
        "center": [round(float(v), 4) for v in (hi + lo) * 0.5],
        "shape_keys": len(me.shape_keys.key_blocks) if me.shape_keys else 0,
        "vertex_groups": len(obj.vertex_groups),
        "modifiers": [mod.type for mod in obj.modifiers],
        "uv_layers": len(me.uv_layers),
        "materials": [slot.material.name for slot in obj.material_slots if slot.material],
    }
    marks = {}
    for name in ("joint-l-eye", "joint-r-eye", "joint-mouth", "joint-jaw",
                 "joint-l-hand", "joint-r-hand", "joint-head"):
        center = _group_center(obj, name)
        if center is not None:
            marks[name] = [round(float(v), 4) for v in center]
    if marks:
        report["landmarks"] = marks
    return report


def _landmarks(obj):
    """Eye / head / hand anchors used by eyes, hair and garments."""
    co, nrm, _ = _mesh_arrays(obj)
    data = {}
    eye_l = _group_center(obj, "joint-l-eye")
    eye_r = _group_center(obj, "joint-r-eye")
    if eye_l is not None and eye_r is not None:
        eye_mid = (eye_l + eye_r) * 0.5
        eye_span = float(np.linalg.norm(eye_l - eye_r))
    else:
        hi = co.max(axis=0)
        lo = co.min(axis=0)
        height = hi[2] - lo[2]
        eye_mid = np.array([0.0, lo[1] + (hi[1] - lo[1]) * 0.12, lo[2] + height * 0.935])
        eye_span = height * 0.045
        eye_l = eye_mid + np.array([eye_span * 0.5, 0.0, 0.0])
        eye_r = eye_mid - np.array([eye_span * 0.5, 0.0, 0.0])
    head_top = float(co[:, 2].max())
    head_band = co[co[:, 2] > head_top - max(0.02, (eye_mid[2] - co[:, 2].min()) * 0.02)]
    if len(head_band) > 8:
        head_radius = float((head_band[:, 0].max() - head_band[:, 0].min()) * 0.5)
    else:
        head_radius = max(0.08, eye_span * 2.4)
    data.update(
        {
            "eye_left": [float(v) for v in eye_l],
            "eye_right": [float(v) for v in eye_r],
            "eye_mid": [float(v) for v in eye_mid],
            "eye_span": eye_span,
            "head_top": head_top,
            "head_radius": head_radius,
            "head_center": [
                float(eye_mid[0]),
                float(eye_mid[1] + head_radius * 0.35),
                float(eye_mid[2] + head_radius * 0.62),
            ],
            "nose_z": float(eye_mid[2] - head_radius * 0.28),
            "mouth_z": float(eye_mid[2] - head_radius * 0.52),
            "chin_z": float(eye_mid[2] - head_radius * 0.85),
        }
    )
    obj["cv_landmarks"] = json.dumps(data)
    return data


def _read_landmarks(obj):
    try:
        raw = obj.get("cv_landmarks")
        if raw:
            return json.loads(str(raw))
    except Exception:
        pass
    return _landmarks(obj)


def _scalp(obj):
    """Scalp cap vertices/normals from the extracted MPFB helper geometry."""
    for candidate in _scene().objects:
        if candidate.type == "MESH" and str(candidate.get("cv_part", "")) == "scalp":
            co, nrm, _ = _mesh_arrays(candidate)
            if len(co) > 32:
                return co, nrm, "scalp-object"
    found = _group_indices(obj, ["helper-hair"])
    co, nrm, _ = _mesh_arrays(obj)
    indices = found.get("helper-hair")
    if indices is not None and len(indices) > 32:
        return co[indices], nrm[indices], "helper-hair"
    marks = _read_landmarks(obj)
    radius = marks["head_radius"]
    # Synthesize a cap above the eye line.
    mask = (co[:, 2] > marks["eye_mid"][2] + radius * 0.05) & (np.abs(co[:, 0]) < radius * 1.2)
    subset = np.where(mask)[0]
    if len(subset) < 32:
        subset = np.argsort(co[:, 2])[-max(64, len(co) // 40):]
    return co[subset], nrm[subset], "procedural-cap"


# ---------------------------------------------------------------------------
# human base mesh (MPFB2 / MakeHuman)
# ---------------------------------------------------------------------------


def _mpfb_services():
    last = None
    for module_name in ("bl_ext.user_default.mpfb", "mpfb"):
        try:
            import importlib

            importlib.import_module(module_name)
            base = importlib.import_module(module_name + ".services.humanservice")
            targets = importlib.import_module(module_name + ".services.targetservice")
            rigs = importlib.import_module(module_name + ".services.rigservice")
            prop = importlib.import_module(module_name + ".entities.objectproperties")
            return {
                "HumanService": base.HumanService,
                "TargetService": targets.TargetService,
                "RigService": rigs.RigService,
                "HumanObjectProperties": getattr(prop, "HumanObjectProperties", None),
            }
        except Exception as exc:  # pragma: no cover - depends on the install
            last = exc
    raise RuntimeError(
        "MPFB2 add-on not available (%s). Enable it with addon_install pkg_id=mpfb "
        "or blender action=addon_enable module=bl_ext.user_default.mpfb" % last
    )


def _macro_dict(spec):
    defaults = {
        "gender": 0.5,
        "age": 0.5,
        "muscle": 0.5,
        "weight": 0.5,
        "proportions": 0.5,
        "height": 0.5,
        "cupsize": 0.5,
        "firmness": 0.5,
    }
    for key in list(defaults.keys()):
        if spec.get(key) is not None:
            defaults[key] = max(0.0, min(1.0, _as_float(spec.get(key), defaults[key])))
    race = spec.get("race")
    if isinstance(race, dict):
        total = sum(max(0.0, _as_float(v, 0.0)) for v in race.values()) or 1.0
        defaults["race"] = {
            str(k): max(0.0, _as_float(v, 0.0)) / total for k, v in race.items()
        }
    elif isinstance(race, str):
        key = race.lower()
        defaults["race"] = {"asian": 0.0, "caucasian": 0.0, "african": 0.0}
        if key in defaults["race"]:
            defaults["race"][key] = 1.0
        else:
            defaults["race"] = {"asian": 0.33, "caucasian": 0.34, "african": 0.33}
    else:
        defaults["race"] = {"asian": 0.33, "caucasian": 0.34, "african": 0.33}
    return defaults


def _shape_key_weights(obj, scale=1.0):
    if not obj.data.shape_keys:
        return 0
    touched = 0
    for key in obj.data.shape_keys.key_blocks:
        if key.value > 0.0:
            key.value = min(1.0, key.value * scale)
            touched += 1
    return touched


def _bake_shape_keys(obj):
    if not obj.data.shape_keys:
        return False
    _active(obj)
    try:
        bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
        return True
    except TypeError:
        try:
            bpy.ops.object.shape_key_remove(all=True)
            return True
        except Exception as exc:
            _warn("shape key bake failed on %s: %s" % (obj.name, exc))
    except Exception as exc:
        _warn("shape key bake failed on %s: %s" % (obj.name, exc))
    return False


def _separate_indices(obj, indices, name, coll=None):
    if indices is None or not len(indices):
        return None
    mask = np.zeros(len(obj.data.vertices), dtype=bool)
    mask[indices] = True
    _active(obj)
    try:
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        pass
    obj.data.vertices.foreach_set("select", mask)
    before = {item.name for item in _scene().objects}
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.separate(type="SELECTED")
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception as exc:
        _warn("separate %s failed: %s" % (name, exc))
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass
        return None
    created = [item for item in _scene().objects if item.name not in before]
    if not created:
        return None
    part = created[0]
    part.name = name
    if coll is not None:
        try:
            for owner in list(part.users_collection):
                owner.objects.unlink(part)
            coll.objects.link(part)
        except Exception:
            pass
    return part


def build_human(spec, out_dir="", materials=None):
    """Create a real human base mesh with proportions, targets and body parts."""
    if not isinstance(spec, dict):
        spec = {}
    services = _mpfb_services()
    HumanService = services["HumanService"]
    TargetService = services["TargetService"]
    _progress("human", 6)

    macro = _macro_dict(spec)
    try:
        body = HumanService.create_human(
            scale=_as_float(spec.get("scale", 0.1), 0.1),
            macro_detail_dict=macro,
            extra_vertex_groups=spec.get("extra_vertex_groups", True) is not False,
            feet_on_ground=spec.get("feet_on_ground", True) is not False,
        )
    except Exception as exc:
        raise RuntimeError("MPFB create_human failed: %s" % exc)
    body.name = str(spec.get("name") or "Body")
    coll = _collection(str(spec.get("collection") or "Character"))
    try:
        for owner in list(body.users_collection):
            owner.objects.unlink(body)
        coll.objects.link(body)
    except Exception:
        pass

    report = {"object": body.name, "targets": [], "parts": {}, "rig": "", "baked_shape_keys": False}

    # ---- face / body shape targets (real anatomy, not blind sculpting) ----
    target_specs = spec.get("targets") or []
    if isinstance(target_specs, dict):
        target_specs = [{"name": k, "value": v} for k, v in target_specs.items()]
    for entry in target_specs:
        if isinstance(entry, str):
            entry = {"name": entry, "value": 1.0}
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or entry.get("target") or "")
        if not name:
            continue
        weight = _as_float(entry.get("value", entry.get("weight", 1.0)), 1.0)
        if weight <= 0:
            continue
        try:
            path = TargetService.target_full_path(name)
            if not path:
                _warn("target '%s' not found in MPFB data" % name)
                continue
            TargetService.load_target(body, path, weight=weight)
            report["targets"].append({"name": name, "value": weight})
        except Exception as exc:
            _warn("target '%s' failed: %s" % (name, exc))

    presets = spec.get("face") or spec.get("preset_targets")
    if isinstance(presets, str) and presets.lower() in FACE_PRESETS:
        for entry in FACE_PRESETS[presets.lower()]:
            name, weight = entry
            try:
                path = TargetService.target_full_path(name)
                if path:
                    TargetService.load_target(body, path, weight=weight)
                    report["targets"].append({"name": name, "value": weight})
            except Exception as exc:
                _warn("face preset target '%s' failed: %s" % (name, exc))

    if spec.get("keep_shape_keys"):
        pass
    else:
        report["baked_shape_keys"] = _bake_shape_keys(body)

    try:
        _active(body)
        bpy.ops.object.shade_smooth()
    except Exception:
        pass

    # ---- extract anatomically separate parts before helpers are masked away ----
    landmarks = _landmarks(body)
    report["landmarks"] = {k: v for k, v in landmarks.items() if k in ("eye_mid", "head_top", "head_radius")}
    want = spec.get("parts") or ["eyes", "teeth", "tongue", "lashes", "scalp"]
    if isinstance(want, dict):
        want = [k for k, v in want.items() if v]
    part_groups = {
        "eyes": (["helper-l-eye", "helper-r-eye"], "Eyes"),
        "teeth": (["helper-upper-teeth", "helper-lower-teeth"], "Teeth"),
        "tongue": (["helper-tongue"], "Tongue"),
        "lashes": (["helper-l-eyelashes-1", "helper-l-eyelashes-2", "helper-r-eyelashes-1", "helper-r-eyelashes-2"], "Lashes"),
        "scalp": (["helper-hair"], "Scalp"),
    }
    extracted = {}
    for key in want:
        mapping = part_groups.get(str(key).lower())
        if mapping is None:
            continue
        names, label = mapping
        found = _group_indices(body, names)
        indices = np.concatenate([v for v in found.values()]) if found else None
        part = _separate_indices(body, indices, label, coll)
        if part is not None:
            extracted[str(key).lower()] = part.name
            part["cv_part"] = str(key).lower()
    report["parts"] = extracted

    # ---- drop the remaining hidden helper geometry ----
    if spec.get("hide_helpers", True) is not False:
        for mod in list(body.modifiers):
            if mod.type == "MASK":
                _apply_modifier(body, mod)

    # ---- materials ----
    skin_spec = spec.get("material") or {"preset": "skin_sss"}
    if isinstance(skin_spec, str):
        skin_spec = {"preset": skin_spec}
    skin = _material({**skin_spec, "name": skin_spec.get("name") or "Skin"}, materials, "Skin")
    if skin is not None:
        body.data.materials.clear()
        body.data.materials.append(skin)
    eye_spec = spec.get("eye_material")
    eye_mat = build_eye_material("Eye")
    if isinstance(eye_spec, dict):
        eye_mat = _material(eye_spec, materials, "Eye") or eye_mat
    teeth_mat = _material({"preset": "ceramic", "name": "Teeth", "base_color": "#e8e2d8", "roughness": 0.32}, materials, "Teeth")
    tongue_mat = _material(
        {"preset": "skin", "name": "Tongue", "base_color": "#8e3f45", "roughness": 0.32, "subsurface": 0.5},
        materials,
        "Tongue",
    )
    for key, obj_name in extracted.items():
        part = bpy.data.objects.get(obj_name)
        if part is None:
            continue
        material = {"eyes": eye_mat, "teeth": teeth_mat, "tongue": tongue_mat}.get(key)
        if material is not None:
            part.data.materials.clear()
            part.data.materials.append(material)
        if key == "scalp":
            part.hide_render = True
            try:
                part.hide_viewport = True
            except Exception:
                pass
    if spec.get("lashes_material"):
        lashes = bpy.data.objects.get(extracted.get("lashes", ""))
        if lashes is not None:
            mat = _material(spec["lashes_material"], materials, "Lashes")
            if mat is not None:
                lashes.data.materials.clear()
                lashes.data.materials.append(mat)

    # ---- rig with real weights ----
    rig_name = spec.get("rig")
    if rig_name:
        try:
            rig_name = "default" if rig_name is True else str(rig_name)
            armature = HumanService.add_builtin_rig(body, rig_name, import_weights=True)
            if armature is not None:
                report["rig"] = armature.name
                for key, obj_name in extracted.items():
                    part = bpy.data.objects.get(obj_name)
                    if part is None:
                        continue
                    if not any(mod.type == "ARMATURE" for mod in part.modifiers):
                        mod = part.modifiers.new("Armature", "ARMATURE")
                        mod.object = armature
        except Exception as exc:
            _warn("rig '%s' failed: %s" % (rig_name, exc))

    report["measure"] = measure(body)
    return report


# Face target packs: name, weight. Coordinates come from the MPFB target library.
FACE_PRESETS = {
    # sculpted-from-reference feel: sharper cheekbones, defined jaw, full lips
    "portrait": [
        ("head-oval", 0.35),
        ("cheekbone-high", 0.4),
        ("cheek-volume-incr", 0.15),
        ("jaw-triangular", 0.3),
        ("chin-prominent", 0.25),
        ("nose-nose-curve-convex", 0.12),
        ("nose-nose-flaring-incr", 0.2),
        ("mouth-lowerlip-volume-incr", 0.25),
        ("mouth-upperlip-volume-incr", 0.2),
        ("mouth-cupidsbow-incr", 0.25),
        ("eyes-eyebag-incr", 0.1),
        ("forehead-round", 0.2),
    ],
    "heroic": [
        ("head-rectangular", 0.4),
        ("jaw-square", 0.5),
        ("chin-prominent", 0.4),
        ("cheekbone-high", 0.5),
        ("brow-ridge-incr", 0.4),
        ("neck-thick-incr", 0.3),
    ],
    "soft": [
        ("head-oval", 0.5),
        ("jaw-round", 0.4),
        ("cheek-volume-incr", 0.35),
        ("chin-round", 0.3),
        ("mouth-lips-volume-incr", 0.3),
    ],
}


def build_eye_material(name="Eye"):
    """Iris + sclera from generated coordinates (no UVs needed)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (760, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (460, 0)
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = nodes.new("ShaderNodeTexCoord")
    tex.location = (-820, 0)
    sub = nodes.new("ShaderNodeVectorMath")
    sub.operation = "SUBTRACT"
    sub.location = (-640, 0)
    sub.inputs[1].default_value = (0.5, 0.5, 0.5)
    links.new(tex.outputs["Generated"], sub.inputs[0])
    length = nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    length.location = (-460, 0)
    links.new(sub.outputs["Vector"], length.inputs[0])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.location = (-260, 0)
    ramp.color_ramp.interpolation = "EASE"
    elements = ramp.color_ramp.elements
    elements[0].position = 0.0
    elements[0].color = (0.06, 0.035, 0.02, 1.0)
    elements[1].position = 0.24
    elements[1].color = (0.9, 0.88, 0.86, 1.0)
    mid = elements.new(0.13)
    mid.color = (0.28, 0.16, 0.07, 1.0)
    pupil = elements.new(0.055)
    pupil.color = (0.01, 0.01, 0.01, 1.0)
    links.new(length.outputs["Value"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    for socket, value in (("Roughness", 0.15), ("Coat Weight", 1.0), ("Coat Roughness", 0.02)):
        try:
            bsdf.inputs[socket].default_value = value
        except Exception:
            pass
    return mat


# ---------------------------------------------------------------------------
# sculpt driver
# ---------------------------------------------------------------------------

BRUSHES = ("draw", "clay", "crease", "flatten", "pinch", "grab", "smooth", "scrape", "inflate")


def _falloff(dist, radius, hardness=0.55):
    t = np.clip(dist / max(radius, 1e-6), 0.0, 1.0)
    # hardness 0 -> soft linear, 1 -> tight smoothstep
    shape = np.power(1.0 - np.power(t, 2.0), 2.0)
    if hardness > 0.0:
        tight = np.clip(1.0 - t, 0.0, 1.0) ** (1.0 + 4.0 * hardness)
        shape = shape * (1.0 - hardness) + tight * hardness
    return shape


def _subdivide_for_sculpt(obj, levels):
    levels = max(0, min(4, _as_int(levels, 0)))
    if not levels:
        return len(obj.data.vertices)
    if obj.data.shape_keys:
        _bake_shape_keys(obj)
    mod = obj.modifiers.new("CV_SculptSubdiv", "SUBSURF")
    try:
        mod.levels = levels
        mod.render_levels = levels
        mod.use_limit_surface = False
    except Exception:
        pass
    if _apply_modifier(obj, mod):
        try:
            _active(obj)
            bpy.ops.object.shade_smooth()
        except Exception:
            pass
    return len(obj.data.vertices)


def _neighbour_average(co, edges, idx):
    if edges is None or not len(edges):
        return co
    i = edges[:, 0]
    j = edges[:, 1]
    sums = np.zeros_like(co)
    counts = np.zeros(co.shape[0], dtype=np.float64)
    np.add.at(sums, i, co[j])
    np.add.at(sums, j, co[i])
    np.add.at(counts, i, 1.0)
    np.add.at(counts, j, 1.0)
    counts = counts[idx]
    avg = sums[idx] / np.maximum(counts, 1.0)[:, None]
    return avg


def _stroke_points(entry, rng):
    points = entry.get("points") or entry.get("path")
    if points:
        return [np.array(_as_vec3(p)) for p in points]
    center = entry.get("center")
    if center is not None:
        return [np.array(_as_vec3(center))]
    return []


def _stroke_samples(points, radius, spacing, pressures, default_pressure):
    """Interpolate a guide path into dab centres while keeping per-dab pressure."""
    if len(points) == 1:
        return [(points[0], pressures[0] if pressures else default_pressure)]
    samples = []
    step_length = max(radius * spacing, 1e-6)
    for index in range(len(points) - 1):
        a = points[index]
        b = points[index + 1]
        steps = max(1, int(float(np.linalg.norm(b - a)) / step_length))
        for step in range(steps):
            t = step / float(steps)
            press = default_pressure
            if pressures:
                count = len(pressures)
                press = pressures[min(count - 1, int(t * (count - 1) + 0.5))] if count > 1 else pressures[0]
            samples.append((a + (b - a) * t, press))
    samples.append((points[-1], pressures[-1] if pressures else default_pressure))
    return samples


def _apply_stroke(obj, entry, symmetry, guard):
    brush = str(entry.get("brush", "draw")).lower()
    if brush not in BRUSHES:
        _warn("unknown brush '%s'" % brush)
        return 0
    radius = max(1e-4, _as_float(entry.get("radius", 0.02), 0.02))
    strength = max(0.0, _as_float(entry.get("strength", 0.5), 0.5))
    pressure = entry.get("pressure", 1.0)
    if isinstance(pressure, (list, tuple)):
        pressures = [max(0.0, _as_float(p, 1.0)) for p in pressure]
    else:
        pressures = None
    amplitude = _as_float(entry.get("height", radius * 0.35 * strength), radius * 0.35 * strength)
    hardness = _as_float(entry.get("hardness", 0.55), 0.55)
    spacing = max(0.02, min(1.0, _as_float(entry.get("spacing", 0.28), 0.28)))
    normal_override = entry.get("normal")
    only_visible = bool(entry.get("front_only", False))
    z_range = entry.get("z_range")
    region = entry.get("region")

    me, co, nrm = _mesh_arrays(obj)
    if len(co) == 0:
        return 0
    edges = None
    if brush == "smooth":
        edge_array = np.empty(len(me.edges) * 2, dtype=np.int32)
        me.edges.foreach_get("vertices", edge_array)
        edges = edge_array.reshape(-1, 2).astype(np.int64)

    base_idx = np.arange(len(co))
    allow = np.ones(len(co), dtype=bool)
    if z_range:
        lo = _as_float(z_range[0], -1e9)
        hi = _as_float(z_range[1], 1e9)
        allow &= (co[:, 2] >= lo) & (co[:, 2] <= hi)
    if isinstance(region, dict):
        center = np.array(_as_vec3(region.get("center")))
        r = max(1e-4, _as_float(region.get("radius", radius * 4), radius * 4))
        inner = region.get("inner", True) is not False
        inside = np.linalg.norm(co - center, axis=1) <= r
        allow &= inside if inner else ~inside
    if only_visible:
        view_dir = np.array(_as_vec3(entry.get("view", (0.0, -1.0, 0.0)), (0.0, -1.0, 0.0)))
        allow &= nrm @ _norm(view_dir) < -0.05
    side = str(entry.get("x_side") or "").upper()
    if side in ("L", "LEFT"):
        allow &= co[:, 0] >= 0.0
    elif side in ("R", "RIGHT"):
        allow &= co[:, 0] <= 0.0

    points = _stroke_points(entry, None)
    if not points:
        return 0
    mirror_axes = [axis for axis in str(symmetry or "").upper() if axis in ("X", "Y", "Z")]
    variants = [np.ones(3)]
    for axis in mirror_axes:
        scale = np.array([1.0, 1.0, 1.0])
        scale["XYZ".index(axis)] = -1.0
        variants = variants + [scale]
    if entry.get("mirror") is False:
        variants = [np.ones(3)]

    origin = co.copy()
    grab_delta = None
    if brush == "grab":
        grab_delta = np.array(_as_vec3(entry.get("offset", entry.get("delta", (0, 0, 0)))), dtype=np.float64)
        if not grab_delta.any() and len(points) > 1:
            grab_delta = points[-1] - points[0]
    pinch = abs(_as_float(entry.get("pinch", 0.45 if brush == "crease" else 0.2), 0.2))
    override = None
    if normal_override is not None:
        override = _norm(np.array(_as_vec3(normal_override), dtype=np.float64))
    default_pressure = _as_float(pressure, 1.0)
    dabs = 0
    for scale in variants:
        mirrored = [np.array([p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]]) for p in points]
        for center, press in _stroke_samples(mirrored, radius, spacing, pressures, default_pressure):
            dist = np.linalg.norm(co - center, axis=1)
            mask = _falloff(dist, radius, hardness) * press * allow
            idx = np.where(mask > 1e-5)[0]
            if not len(idx):
                continue
            weight = mask[idx]
            amplitude_now = amplitude * press
            if brush == "smooth":
                average = _neighbour_average(co, edges, idx)
                blend = np.clip(weight * max(strength, 0.05), 0.0, 1.0)[:, None]
                co[idx] = co[idx] * (1.0 - blend) + average * blend
            elif brush == "grab":
                co[idx] += grab_delta[None, :] * weight[:, None]
            elif brush == "flatten":
                nearest = idx[int(np.argmin(dist[idx]))]
                plane_normal = _norm(nrm[nearest]) if override is None else override
                offset = np.sum((co[idx] - center) * plane_normal, axis=1)
                co[idx] -= plane_normal[None, :] * (offset * weight * strength)[:, None]
            elif brush == "pinch":
                normals = nrm[idx]
                to_center = center[None, :] - co[idx]
                tangential = to_center - np.sum(to_center * normals, axis=1)[:, None] * normals
                co[idx] += tangential * (weight * strength * 0.45)[:, None]
            else:
                if override is None:
                    direction = nrm[idx]
                else:
                    direction = np.repeat(override[None, :], len(idx), axis=0)
                amount = amplitude_now
                if brush == "scrape":
                    amount = -abs(amount) * 0.7
                elif brush == "crease":
                    amount *= 1.15
                elif brush == "clay":
                    amount *= 0.85
                co[idx] += direction * (weight * amount)[:, None]
                if brush in ("crease", "clay"):
                    normals = nrm[idx]
                    to_center = center[None, :] - co[idx]
                    tangential = to_center - np.sum(to_center * normals, axis=1)[:, None] * normals
                    co[idx] += tangential * (weight * pinch * 0.3)[:, None]
            dabs += 1

    if guard:
        delta = co - origin
        lengths = np.linalg.norm(delta, axis=1)
        overshoot = lengths > guard
        if overshoot.any():
            factor = np.ones_like(lengths)
            factor[overshoot] = guard / lengths[overshoot]
            co = origin + delta * factor[:, None]

    _write_co(me, co)
    return dabs


def build_sculpt(spec, out_dir="", materials=None):
    """Run brush strokes as data on the selected meshes."""
    entries = spec
    if isinstance(entries, dict):
        entries = [entries]
    reports = []
    for spec_item in entries or []:
        if not isinstance(spec_item, dict):
            continue
        targets = _objects(spec_item)
        strokes = spec_item.get("strokes") or []
        if isinstance(strokes, dict):
            strokes = [strokes]
        symmetry = spec_item.get("symmetry", "X")
        for obj in targets:
            if obj.type != "MESH":
                continue
            before = len(obj.data.vertices)
            if spec_item.get("subdivide"):
                _subdivide_for_sculpt(obj, spec_item.get("subdivide"))
            guard = _as_float(spec_item.get("max_displace", 0.05), 0.05)
            steps = 0
            for stroke in strokes:
                if not isinstance(stroke, dict):
                    continue
                try:
                    steps += _apply_stroke(obj, stroke, symmetry, guard)
                except Exception as exc:
                    _warn("stroke %s failed on %s: %s" % (stroke.get("brush"), obj.name, exc))
                    traceback.print_exc()
            smooth_passes = _as_int(spec_item.get("smooth_after", 0), 0)
            for _ in range(smooth_passes):
                _apply_stroke(
                    obj,
                    {"brush": "smooth", "center": [0, 0, 0], "radius": 100.0, "strength": 0.25, "factor": 0.35},
                    "",
                    0.0,
                )
            if spec_item.get("final_subdiv"):
                mod = obj.modifiers.new("CV_FinalSubdiv", "SUBSURF")
                mod.levels = _as_int(spec_item.get("final_subdiv"), 1)
                mod.render_levels = mod.levels
            try:
                _active(obj)
                bpy.ops.object.shade_smooth()
            except Exception:
                pass
            reports.append(
                {
                    "object": obj.name,
                    "vertices_before": before,
                    "vertices_after": len(obj.data.vertices),
                    "dabs": steps,
                    "strokes": len(strokes),
                }
            )
    return reports


# ---------------------------------------------------------------------------
# hair
# ---------------------------------------------------------------------------


def _hair_alpha_image(path, width=256, height=512, strands=48, seed=7):
    rng = np.random.default_rng(seed)
    alpha = np.zeros((height, width), dtype=np.float32)
    xs = np.linspace(0.0, 1.0, height)
    for _ in range(strands):
        x0 = rng.uniform(0.02, 0.98)
        drift = rng.uniform(-0.10, 0.10)
        thickness = rng.uniform(0.004, 0.014)
        wobble = rng.uniform(0.004, 0.02)
        phase = rng.uniform(0.0, 6.28)
        taper = rng.uniform(0.55, 1.0)
        center = x0 + drift * xs + wobble * np.sin(xs * rng.uniform(3.0, 9.0) + phase)
        half = thickness * (1.0 - xs * taper * 0.85)
        left = center - half
        right = center + half
        cols = np.arange(width)[None, :] / float(width)
        band = (cols >= left[:, None]) & (cols <= right[:, None])
        alpha += band.astype(np.float32) * (0.75 + 0.25 * np.sin(xs * 20.0 + phase))[:, None]
    alpha = np.clip(alpha, 0.0, 1.0)
    rgba = np.zeros((height, width, 4), dtype=np.float32)
    rgba[..., 0] = 0.09
    rgba[..., 1] = 0.07
    rgba[..., 2] = 0.06
    rgba[..., 3] = alpha
    img = bpy.data.images.get("CV_HairAlpha") or bpy.data.images.new(
        "CV_HairAlpha", width=width, height=height, alpha=True
    )
    img.pixels.foreach_set(rgba.ravel())
    try:
        img.file_format = "PNG"
        img.filepath_raw = path
        img.save()
    except Exception as exc:
        _warn("hair alpha texture save failed: %s" % exc)
    try:
        img.colorspace_settings.name = "Non-Color"
    except Exception:
        pass
    return path


def _strand_paths(spec, scalp_co, scalp_nrm, rng):
    count = max(1, _as_int(spec.get("count", 700), 700))
    segments = max(2, _as_int(spec.get("segments", 7), 7))
    length = max(0.01, _as_float(spec.get("length", 0.16), 0.16))
    length_var = max(0.0, _as_float(spec.get("length_variation", 0.22), 0.22))
    part = _as_float(spec.get("part", 0.0), 0.0)
    gravity = max(0.0, _as_float(spec.get("gravity", 0.75), 0.75))
    bend = max(0.0, min(1.0, _as_float(spec.get("bend", 0.35), 0.35)))
    curl = max(0.0, _as_float(spec.get("curl", 0.25), 0.25))
    lift = _as_float(spec.get("lift", 0.25), 0.25)
    outward = _as_float(spec.get("outward", 0.45), 0.45)
    face_skip = spec.get("face_skip", True) is not False
    flow = np.array(_as_vec3(spec.get("flow", (0.0, 0.0, -1.0)), (0.0, 0.0, -1.0)), dtype=float)
    facing = _norm(np.array(_as_vec3(spec.get("facing", (0.0, -1.0, 0.0)), (0.0, -1.0, 0.0)), dtype=float))

    roots = rng.integers(0, len(scalp_co), size=count * 2)
    paths = []
    for root_index in roots:
        if len(paths) >= count:
            break
        root = scalp_co[root_index]
        normal = _norm(scalp_nrm[root_index])
        if face_skip and float(normal @ -facing) > 0.55 and root[2] < scalp_co[:, 2].max() - length * 0.5:
            continue
        side = 1.0 if root[0] >= part else -1.0
        lateral = np.array([side * outward, 0.0, 0.0])
        direction = _norm(normal * lift + flow * gravity + lateral)
        strand_length = length * (1.0 + rng.uniform(-length_var, length_var))
        step = strand_length / segments
        points = [root.copy()]
        cursor = root.copy()
        current = direction.copy()
        for seg in range(segments):
            wobble = np.array(
                [
                    math.sin(seg * 0.9 + root_index * 0.31) * curl * 0.5,
                    math.cos(seg * 1.1 + root_index * 0.17) * curl * 0.5,
                    math.sin(seg * 0.7 + root_index * 0.53) * curl * 0.25,
                ]
            )
            current = _norm(current * (1.0 - bend) + _norm(flow + lateral * 0.6) * bend + wobble * 0.2)
            cursor = cursor + current * step
            points.append(cursor.copy())
        radii = []
        base_radius = _as_float(spec.get("strand_radius", 0.0016), 0.0016)
        tip = max(0.01, _as_float(spec.get("tip", 0.12), 0.12))
        for seg in range(segments + 1):
            t = seg / float(segments)
            radii.append(base_radius * (1.0 - t * (1.0 - tip)))
        paths.append((points, radii))
    return paths


def _hair_curves_object(name, paths, coll, thickness=None, resolution=2):
    curve = bpy.data.curves.new(name + "_curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 2
    curve.bevel_depth = thickness if thickness is not None else 0.0012
    curve.bevel_resolution = max(0, min(4, resolution))
    curve.use_fill_caps = True
    try:
        curve.bevel_factor_mapping_end = "RESOLUTION"
    except Exception:
        pass
    for points, radii in paths:
        spline = curve.splines.new("POLY")
        spline.points.add(len(points) - 1)
        for index, (point, radius) in enumerate(zip(points, radii)):
            spline.points[index].co = (float(point[0]), float(point[1]), float(point[2]), 1.0)
            spline.points[index].radius = float(max(0.01, radius / max(radii[0], 1e-6)))
    obj = bpy.data.objects.new(name, curve)
    coll.objects.link(obj)
    return obj


def _hair_cards_object(name, paths, coll, width=0.012, segments=6):
    verts = []
    faces = []
    uvs = []
    for points, _radii in paths:
        count = min(len(points), segments + 1)
        start = len(verts)
        for index in range(count):
            point = points[index]
            nxt = points[min(index + 1, len(points) - 1)]
            tangent = _norm(nxt - point)
            side = _norm(np.cross(tangent, np.array([0.0, 0.0, 1.0])))
            if not np.isfinite(side).all():
                side = np.array([1.0, 0.0, 0.0])
            half = width * 0.5 * (1.0 - (index / float(count)) * 0.8)
            verts.append(tuple(point - side * half))
            verts.append(tuple(point + side * half))
        for index in range(count - 1):
            a = start + index * 2
            faces.append((a, a + 1, a + 3, a + 2))
            v0 = index / float(max(1, count - 1))
            v1 = (index + 1) / float(max(1, count - 1))
            uvs.append(((0.0, v0), (1.0, v0), (1.0, v1), (0.0, v1)))
    mesh = bpy.data.meshes.new(name + "_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for poly_index, poly in enumerate(mesh.polygons):
        if poly_index >= len(uvs):
            break
        for loop_index, uv in zip(poly.loop_indices, uvs[poly_index]):
            uv_layer.data[loop_index].uv = uv
    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    return obj


def build_hair(spec, out_dir="", materials=None):
    entries = spec if isinstance(spec, list) else [spec]
    reports = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        body = None
        targets = _objects(entry.get("head") or entry.get("scalp_object") or entry.get("object"), default="all")
        body = targets[0] if targets else None
        if body is None:
            _warn("hair: no scalp object")
            continue
        scalp_co, scalp_nrm, source = _scalp(body)
        rng = np.random.default_rng(_as_int(entry.get("seed", 3), 3))
        paths = _strand_paths(entry, scalp_co, scalp_nrm, rng)
        coll = _collection(str(entry.get("collection") or "Hair"))
        name = str(entry.get("name") or "Hair")
        mode = str(entry.get("mode", "strands")).lower()
        created = []
        if mode in ("strands", "curve", "curves", "both"):
            obj = _hair_curves_object(name, paths, coll, _as_float(entry.get("strand_radius", 0.0016), 0.0016))
            mat_spec = entry.get("material") or {
                "preset": "hair",
                "name": "Hair",
                "base_color": str(entry.get("color", "#3a2418")),
            }
            mat = _material(mat_spec, materials, "Hair")
            if mat is not None:
                obj.data.materials.append(mat)
            created.append(obj.name)
        if mode in ("cards", "card", "both"):
            cards = _hair_cards_object(
                name + "_Cards", paths, coll, _as_float(entry.get("card_width", 0.012), 0.012)
            )
            tex_dir = os.path.join(out_dir or ".", "textures")
            try:
                os.makedirs(tex_dir, exist_ok=True)
            except Exception:
                tex_dir = out_dir or "."
            tex_path = _hair_alpha_image(os.path.join(tex_dir, "hair_%s_alpha.png" % name.replace(" ", "_").lower()))
            mat_spec = entry.get("card_material") or {
                "name": name + " Card",
                "base_color": str(entry.get("color", "#3a2418")),
                "alpha": 0.99,
                "blend": True,
                "backface_culling": False,
                "roughness": 0.34,
                "sheen": 0.45,
                "texture": {"type": "image", "path": tex_path, "alpha_to_alpha": True},
            }
            mat = _material(mat_spec, materials, name + " Card")
            if mat is not None:
                cards.data.materials.append(mat)
            created.append(cards.name)
        reports.append(
            {
                "mode": mode,
                "objects": created,
                "strands": len(paths),
                "scalp_source": source,
                "roots": int(len(scalp_co)),
            }
        )
    return reports


# ---------------------------------------------------------------------------
# drape / garment folds
# ---------------------------------------------------------------------------


def _noise2(u, v, seed=0.0):
    value = 0.0
    value += math.sin(u * 6.283 + seed) * math.sin(v * 5.117 + seed * 0.7)
    value += 0.5 * math.sin(u * 17.113 + v * 9.31 + seed * 1.3)
    value += 0.35 * math.sin(v * 21.7 - u * 5.9 + seed * 2.1)
    return value / 1.85


def _garment_mesh(kind, spec):
    segments = max(6, _as_int(spec.get("segments", 64), 64))
    rings = max(2, _as_int(spec.get("rings", 24), 24))
    folds_spec = spec.get("folds")
    if isinstance(folds_spec, dict):
        fold_count = _as_int(folds_spec.get("count", 9), 9)
        fold_amp = _as_float(folds_spec.get("amplitude", 0.03), 0.03)
        twist = _as_float(folds_spec.get("twist", 0.35), 0.35)
    else:
        fold_count = _as_int(folds_spec if folds_spec is not None else spec.get("fold_count", 9), 9)
        fold_amp = _as_float(spec.get("fold_amplitude", 0.03), 0.03)
        twist = _as_float(spec.get("twist", 0.35), 0.35)
    folds = max(0, fold_count)
    wrinkle = _as_float(spec.get("wrinkle", 0.35), 0.35)
    seed = _as_float(spec.get("seed", 1.0), 1.0)
    height = max(0.02, _as_float(spec.get("height", 0.55), 0.55))
    radius_top = max(0.01, _as_float(spec.get("radius_top", 0.14), 0.14))
    radius_bottom = max(0.01, _as_float(spec.get("radius_bottom", 0.32), 0.32))
    squash = _as_float(spec.get("squash", 0.82), 0.82)
    span = _as_float(spec.get("span", 360.0), 360.0)
    closed = abs(span - 360.0) < 0.5
    columns = segments if closed else segments + 1
    verts = []
    faces = []
    for ring in range(rings + 1):
        v = ring / float(rings)
        z = -v * height
        base_radius = radius_top + (radius_bottom - radius_top) * v
        for column in range(columns):
            u = column / float(segments)
            theta = math.radians(-span * 0.5 + span * u)
            fold_phase = theta * folds + v * twist * 6.283
            fold_wave = math.sin(fold_phase)
            amplitude = fold_amp * (0.25 + 0.75 * v)
            r = base_radius * (1.0 + amplitude * fold_wave * 6.0)
            r += base_radius * wrinkle * 0.12 * _noise2(u * 1.6, v * 2.4, seed)
            if kind == "cape":
                r *= 1.0 + 0.06 * math.sin(theta * 2.0)
            zz = z + amplitude * 0.35 * math.cos(fold_phase) * (0.3 + v)
            x = math.cos(theta) * r
            y = math.sin(theta) * r * squash
            verts.append((x, y, zz))
    for ring in range(rings):
        for column in range(segments):
            a = ring * columns + column
            b = ring * columns + (column + 1) % columns
            c = (ring + 1) * columns + (column + 1) % columns
            d = (ring + 1) * columns + column
            if not closed and column == segments - 1:
                faces.append((a, b, d))
            else:
                faces.append((a, b, c, d))
    return verts, faces


def _sleeve_mesh(spec):
    segments = max(8, _as_int(spec.get("segments", 40), 40))
    rings = max(3, _as_int(spec.get("rings", 18), 18))
    length = max(0.02, _as_float(spec.get("height", 0.32), 0.32))
    r_start = max(0.01, _as_float(spec.get("radius_top", 0.055), 0.055))
    r_end = max(0.01, _as_float(spec.get("radius_bottom", 0.045), 0.045))
    puff = _as_float(spec.get("puff", 0.35), 0.35)
    folds = max(0, _as_int(spec.get("folds", 7), 7))
    fold_amp = _as_float(spec.get("fold_amplitude", 0.02), 0.02)
    verts = []
    faces = []
    for ring in range(rings + 1):
        v = ring / float(rings)
        z = -v * length
        base = r_start + (r_end - r_start) * v + math.sin(v * math.pi) * puff * r_start
        for column in range(segments):
            u = column / float(segments)
            theta = u * 6.283
            wave = math.sin(theta * folds + v * 3.1) * fold_amp * (0.4 + 0.6 * v)
            r = base * (1.0 + wave * 4.0)
            verts.append((math.cos(theta) * r, math.sin(theta) * r, z))
    for ring in range(rings):
        for column in range(segments):
            a = ring * segments + column
            b = ring * segments + (column + 1) % segments
            c = (ring + 1) * segments + (column + 1) % segments
            d = (ring + 1) * segments + column
            faces.append((a, b, c, d))
    return verts, faces


def _ruffle_mesh(spec):
    segments = max(24, _as_int(spec.get("segments", 96), 96))
    rings = max(2, _as_int(spec.get("rings", 4), 4))
    waves = max(3, _as_int(spec.get("folds", 18), 18))
    amplitude = _as_float(spec.get("fold_amplitude", 0.02), 0.02)
    radius = max(0.02, _as_float(spec.get("radius_top", 0.18), 0.18))
    height = max(0.005, _as_float(spec.get("height", 0.06), 0.06))
    verts = []
    faces = []
    for ring in range(rings + 1):
        v = ring / float(rings)
        for column in range(segments):
            u = column / float(segments)
            theta = u * 6.283
            wave = math.sin(theta * waves)
            r = radius + amplitude * wave * (0.4 + v)
            z = -height * v + abs(wave) * height * 0.35 * v
            verts.append((math.cos(theta) * r, math.sin(theta) * r, z))
    for ring in range(rings):
        for column in range(segments):
            a = ring * segments + column
            b = ring * segments + (column + 1) % segments
            c = (ring + 1) * segments + (column + 1) % segments
            d = (ring + 1) * segments + column
            faces.append((a, b, c, d))
    return verts, faces


def build_drape(spec, out_dir="", materials=None):
    entries = spec if isinstance(spec, list) else [spec]
    reports = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        kind = str(entry.get("type", entry.get("garment", "skirt"))).lower()
        if kind in ("skirt", "dress", "coat", "cloth"):
            verts, faces = _garment_mesh(kind, entry)
        elif kind in ("sleeve", "arm"):
            verts, faces = _sleeve_mesh(entry)
        elif kind in ("ruffle", "frill", "flounce"):
            verts, faces = _ruffle_mesh(entry)
        elif kind in ("cape", "veil", "cloak"):
            verts, faces = _garment_mesh("cape", {**entry, "span": _as_float(entry.get("span", 250.0), 250.0)})
        else:
            _warn("drape: unknown garment '%s'" % kind)
            continue
        name = str(entry.get("name") or ("Drape_" + kind.title()))
        mesh = bpy.data.meshes.new(name + "_mesh")
        mesh.from_pydata(verts, [], faces)
        mesh.validate()
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        coll = _collection(str(entry.get("collection") or "Cloth"))
        coll.objects.link(obj)
        obj.location = _as_vec3(entry.get("location", (0, 0, 0)))
        rotation = _as_vec3(entry.get("rotation", (0, 0, 0)))
        try:
            obj.rotation_euler = tuple(math.radians(v) for v in rotation)
        except Exception:
            pass
        thickness = _as_float(entry.get("thickness", 0.004), 0.004)
        if thickness > 0:
            mod = obj.modifiers.new("Solidify", "SOLIDIFY")
            mod.thickness = thickness
            mod.offset = 0.0
            if _as_float(entry.get("shrink", 0.0), 0.0):
                mod.thickness_clamp = _as_float(entry.get("shrink"), 0.0)
        if not entry.get("no_subsurf"):
            mod = obj.modifiers.new("Subdiv", "SUBSURF")
            mod.levels = _as_int(entry.get("subdivisions", 1), 1)
            mod.render_levels = mod.levels
        mat_spec = entry.get("material") or {"preset": entry.get("preset", "fabric"), "name": name + " Fabric"}
        mat = _material(mat_spec, materials, name)
        if mat is not None:
            obj.data.materials.append(mat)
        if entry.get("smooth", True) is not False:
            try:
                _active(obj)
                bpy.ops.object.shade_smooth()
            except Exception:
                pass
        reports.append({"garment": kind, "object": obj.name, "vertices": len(mesh.vertices), "faces": len(mesh.polygons)})
    return reports


# ---------------------------------------------------------------------------
# ornament / lace motifs
# ---------------------------------------------------------------------------

MOTIFS = {
    "scroll": "spiral volute with tapered tail",
    "leaf": "pointed leaf with centre vein",
    "braid": "interlaced two-strand braid",
    "rope": "helical rope trim",
    "diamond": "rhombus lattice cell",
    "band": "fluted/beaded edging band",
    "petal": "lobed petal cluster (lace fan)",
}


def _motif_splines(motif, scale=1.0, turns=2.4):
    """Return a list of polylines (list of Vector) in the XZ plane."""
    splines = []
    if motif == "scroll":
        points = []
        count = 48
        for index in range(count):
            t = index / float(count - 1)
            angle = t * turns * math.pi * 1.55
            radius = scale * (0.04 + 0.96 * math.exp(-2.35 * t))
            points.append((math.cos(angle) * radius, 0.0, math.sin(angle) * radius - scale * 0.05 * t))
        splines.append(points)
    elif motif == "leaf":
        points = []
        count = 26
        for index in range(count):
            t = index / float(count - 1)
            x = (t - 0.5) * scale
            z = math.sin(t * math.pi) * scale * 0.42
            points.append((x, 0.0, z))
        splines.append(points)
        vein = [(0.0, 0.0, -scale * 0.02), (0.0, 0.0, scale * 0.34)]
        splines.append(vein)
        for side in (-1.0, 1.0):
            ribs = []
            for index in range(7):
                t = index / 6.0
                ribs.append((side * (t - 0.5) * scale * 0.9, 0.0, math.sin(t * math.pi) * scale * 0.42))
            splines.append(ribs)
    elif motif == "braid":
        for offset in (0.0, math.pi):
            points = []
            count = 64
            for index in range(count):
                t = index / float(count - 1)
                x = (t - 0.5) * scale * 2.0
                y = math.sin(t * turns * 6.283 + offset) * scale * 0.16
                z = math.cos(t * turns * 6.283 + offset) * scale * 0.16
                points.append((x, y, z))
            splines.append(points)
    elif motif == "rope":
        for offset in (0.0, math.pi):
            points = []
            count = 72
            for index in range(count):
                t = index / float(count - 1)
                x = (t - 0.5) * scale * 2.0
                y = math.sin(t * turns * 6.283 + offset) * scale * 0.1
                z = math.cos(t * turns * 6.283 + offset) * scale * 0.1
                points.append((x, y, z))
            splines.append(points)
    elif motif == "diamond":
        half = scale * 0.5
        splines.append([(0.0, 0.0, half), (half * 0.55, 0.0, 0.0), (0.0, 0.0, -half), (-half * 0.55, 0.0, 0.0), (0.0, 0.0, half)])
        splines.append([(-half * 0.55, 0.0, 0.0), (0.0, 0.0, 0.0), (half * 0.55, 0.0, 0.0)])
    elif motif == "band":
        points = []
        count = 96
        for index in range(count):
            t = index / float(count - 1)
            x = (t - 0.5) * scale * 2.0
            z = math.sin(t * turns * 6.283) * scale * 0.09
            points.append((x, 0.0, z))
        splines.append(points)
    elif motif == "petal":
        for lobe in range(5):
            offset = (lobe / 5.0) * 6.283
            points = []
            for index in range(18):
                t = index / 17.0
                radius = t * scale * 0.55
                angle = offset + (t - 0.5) * 0.9
                points.append((math.cos(angle) * radius, 0.0, math.sin(angle) * radius))
            splines.append(points)
    else:
        _warn("unknown ornament motif '%s'" % motif)
    return splines


def _ornament_curve(name, splines, bevel=0.004, coll=None, taper=True):
    curve = bpy.data.curves.new(name + "_curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 6
    curve.bevel_depth = bevel
    curve.bevel_resolution = 2
    curve.use_fill_caps = True
    for points in splines:
        if len(points) < 2:
            continue
        spline = curve.splines.new("POLY")
        spline.points.add(len(points) - 1)
        total = len(points)
        for index, point in enumerate(points):
            spline.points[index].co = (float(point[0]), float(point[1]), float(point[2]), 1.0)
            if taper:
                t = index / float(total - 1)
                spline.points[index].radius = float(1.0 - 0.72 * t)
            else:
                spline.points[index].radius = 1.0
    obj = bpy.data.objects.new(name, curve)
    (coll or _collection("Ornaments")).objects.link(obj)
    return obj


def build_ornament(spec, out_dir="", materials=None):
    entries = spec if isinstance(spec, list) else [spec]
    reports = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        motif = str(entry.get("motif", "scroll")).lower()
        scale = max(0.005, _as_float(entry.get("scale", 0.12), 0.12))
        turns = _as_float(entry.get("turns", 2.4), 2.4)
        bevel = max(0.0004, _as_float(entry.get("bevel", 0.004), 0.004))
        name = str(entry.get("name") or ("Ornament_" + motif.title()))
        coll = _collection(str(entry.get("collection") or "Ornaments"))
        splines = _motif_splines(motif, scale, turns)
        if not splines:
            continue
        count = max(1, _as_int(entry.get("count", 1), 1))
        spacing = _as_vec3(entry.get("spacing", (0, 0, 0)))
        created = []
        for index in range(count):
            suffix = "" if count == 1 else "_%02d" % (index + 1)
            obj = _ornament_curve(name + suffix, splines, bevel, coll, entry.get("taper", True) is not False)
            base_location = np.array(_as_vec3(entry.get("location", (0, 0, 0))), dtype=float)
            offset = np.array(spacing, dtype=float) * index
            obj.location = tuple(base_location + offset)
            rotation = _as_vec3(entry.get("rotation", (0, 0, 0)))
            try:
                obj.rotation_euler = tuple(math.radians(v) for v in rotation)
            except Exception:
                pass
            if entry.get("scale_uniform"):
                factor = _as_float(entry.get("scale_uniform"), 1.0)
                obj.scale = (factor, factor, factor)
            mat_spec = entry.get("material")
            if mat_spec:
                mat = _material(mat_spec, materials, name)
                if mat is not None:
                    obj.data.materials.append(mat)
            if entry.get("mirror"):
                axis = str(entry.get("mirror_axis", "Y")).upper()
                mod = obj.modifiers.new("Mirror", "MIRROR")
                mod.use_axis = [axis.count("X") > 0, axis.count("Y") > 0, axis.count("Z") > 0]
                try:
                    mod.use_mirror_merge = False
                except Exception:
                    pass
            created.append(obj.name)
        reports.append({"motif": motif, "objects": created, "splines": len(splines)})
    return reports


# ---------------------------------------------------------------------------
# retopology / shading
# ---------------------------------------------------------------------------


def build_retopo(spec, out_dir="", materials=None):
    entries = spec if isinstance(spec, list) else [spec]
    reports = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        for obj in _objects(entry):
            if obj.type != "MESH":
                continue
            before = len(obj.data.polygons)
            _active(obj)
            quad = entry.get("quadriflow")
            if isinstance(quad, dict) and quad.get("enabled", True) is not False:
                faces = _as_int(quad.get("faces", quad.get("target_faces", 0)), 0)
                ratio = _as_float(quad.get("ratio", 0.0), 0.0)
                if not faces and ratio > 0:
                    faces = max(64, int(before * ratio))
                if not faces:
                    faces = max(500, min(20000, before // 2))
                try:
                    bpy.ops.object.quadriflow_remesh(
                        use_mesh_symmetry=bool(quad.get("symmetry", True)),
                        use_preserve_sharp=bool(quad.get("preserve_sharp", False)),
                        use_preserve_boundary=bool(quad.get("preserve_boundary", False)),
                        preserve_paint_mask=bool(quad.get("preserve_mask", False)),
                        smooth_normals=bool(quad.get("smooth_normals", True)),
                        mode="FACES",
                        target_faces=int(faces),
                        seed=_as_int(quad.get("seed", 0), 0),
                    )
                except Exception as exc:
                    _warn("quadriflow on %s failed: %s" % (obj.name, exc))
            voxel = entry.get("voxel") or entry.get("remesh")
            if voxel:
                size = _as_float(voxel if not isinstance(voxel, dict) else voxel.get("size", 0.01), 0.01)
                try:
                    mod = obj.modifiers.new("CV_Remesh", "REMESH")
                    mod.mode = "VOXEL"
                    mod.voxel_size = size
                    mod.use_smooth_shade = True
                    _apply_modifier(obj, mod)
                except Exception as exc:
                    _warn("voxel remesh on %s failed: %s" % (obj.name, exc))
            if entry.get("weighted_normal", True) is not False:
                try:
                    mod = obj.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")
                    mod.mode = "FACE_AREA_WITH_ANGLE"
                    mod.weight = 50
                    mod.keep_sharp = True
                except Exception as exc:
                    _warn("weighted normal on %s failed: %s" % (obj.name, exc))
            angle = _as_float(entry.get("sharp_angle", 0.0), 0.0)
            if angle > 0:
                _mark_geometry_by_angle(obj, angle, entry)
            if entry.get("smooth", True) is not False:
                try:
                    _active(obj)
                    bpy.ops.object.shade_smooth()
                    if hasattr(bpy.ops.object, "shade_smooth_by_angle"):
                        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle or 35.0))
                except Exception:
                    pass
            if entry.get("seams") or (angle > 0 and entry.get("seams_by_angle", True)):
                _mark_geometry_by_angle(obj, angle or 50.0, {**entry, "seams": True})
            if entry.get("uv", True) is not False:
                fn = H.get("smart_uv")
                if fn:
                    try:
                        fn(obj, {"angle": 66, "margin": 0.02})
                    except Exception as exc:
                        _warn("uv on %s failed: %s" % (obj.name, exc))
            reports.append(
                {
                    "object": obj.name,
                    "polygons_before": before,
                    "polygons_after": len(obj.data.polygons),
                    "vertices_after": len(obj.data.vertices),
                }
            )
    return reports


def _mark_geometry_by_angle(obj, angle_degrees, entry):
    """Sharp edges, seams and bevel weights from the face angle."""
    try:
        import bmesh

        mesh = obj.data
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bevel_layer = None
        if entry.get("bevel_weight"):
            try:
                bevel_layer = bm.edges.layers.float.get("bevel_weight_edge") or bm.edges.layers.float.new(
                    "bevel_weight_edge"
                )
            except Exception:
                bevel_layer = None
        threshold = math.radians(angle_degrees)
        for edge in bm.edges:
            if len(edge.link_faces) != 2:
                continue
            try:
                edge_angle = edge.calc_face_angle()
            except Exception:
                continue
            if edge_angle >= threshold:
                if entry.get("seams"):
                    edge.seam = True
                if entry.get("sharp", True):
                    edge.smooth = False
                if bevel_layer is not None:
                    edge[bevel_layer] = 1.0
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
    except Exception as exc:
        _warn("angle geometry pass on %s failed: %s" % (obj.name, exc))


# ---------------------------------------------------------------------------
# weights
# ---------------------------------------------------------------------------


def build_weights(spec, out_dir="", materials=None):
    entries = spec if isinstance(spec, list) else [spec]
    reports = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        mode = str(entry.get("mode", "transfer")).lower()
        targets = _objects(entry, default="all")
        if mode == "autoweight":
            armature = bpy.data.objects.get(str(entry.get("armature") or ""))
            if armature is None:
                armatures = [obj for obj in _scene().objects if obj.type == "ARMATURE"]
                armature = armatures[0] if armatures else None
            if armature is None:
                _warn("weights: no armature for autoweight")
                continue
            for obj in targets:
                if obj.type != "MESH":
                    continue
                try:
                    _select_only(obj)
                    obj.select_set(True)
                    armature.select_set(True)
                    _view_layer().objects.active = armature
                    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
                    reports.append({"object": obj.name, "mode": mode, "armature": armature.name})
                except Exception as exc:
                    _warn("autoweight on %s failed: %s" % (obj.name, exc))
            continue

        source = bpy.data.objects.get(str(entry.get("source") or ""))
        if source is None:
            meshes = [obj for obj in _scene().objects if obj.type == "MESH"]
            source = next((obj for obj in meshes if "body" in obj.name.lower()), meshes[0] if meshes else None)
        for obj in targets:
            if obj.type != "MESH" or obj is source:
                continue
            try:
                if source is not None and mode in ("transfer", "cloth", "copy"):
                    _select_only(obj)
                    obj.select_set(True)
                    source.select_set(True)
                    _view_layer().objects.active = source
                    bpy.ops.object.data_transfer(
                        use_reverse_transfer=True,
                        data_type="VGROUP_WEIGHTS",
                        vert_mapping="POLYINTERP_NEAREST",
                        layers_select_src="ALL",
                        layers_select_dst="NAME",
                        mix_mode="REPLACE",
                    )
                _select_only(obj)
                limit = max(1, _as_int(entry.get("limit", 4), 4))
                try:
                    bpy.ops.object.vertex_group_limit_total(group_select_mode="BONE_DEFORM", limit=limit)
                except Exception:
                    bpy.ops.object.vertex_group_limit_total(limit=limit)
                try:
                    bpy.ops.object.vertex_group_normalize_all(group_select_mode="BONE_DEFORM", lock_active=False)
                except Exception:
                    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
                iterations = _as_int(entry.get("smooth", 3 if mode == "cloth" else 1), 1)
                if iterations > 0:
                    bpy.ops.object.vertex_group_smooth(
                        group_select_mode="BONE_DEFORM",
                        factor=_as_float(entry.get("factor", 0.5), 0.5),
                        repeat=iterations,
                        expand=_as_float(entry.get("expand", 0.0), 0.0),
                    )
                reports.append(
                    {
                        "object": obj.name,
                        "mode": mode,
                        "source": source.name if source is not None else "",
                        "groups": len(obj.vertex_groups),
                    }
                )
            except Exception as exc:
                _warn("weights on %s failed: %s" % (obj.name, exc))
    return reports


# ---------------------------------------------------------------------------
# view overrides (clay / wire / freestyle)
# ---------------------------------------------------------------------------


def apply_view(spec, out_dir="", materials=None):
    entries = spec if isinstance(spec, list) else [spec]
    reports = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        mode = str(entry.get("mode", "clay")).lower()
        targets = _objects(entry, default="all")
        report = {"mode": mode, "objects": []}
        if mode in ("clay", "matcap", "grey", "view") and entry.get("restore"):
            for obj in targets:
                _restore_materials(obj)
            reports.append({**report, "restored": True})
            continue
        if mode in ("clay", "matcap", "grey", "view"):
            mat = _material(
                {
                    "name": "CV_Clay",
                    "base_color": str(entry.get("color", "#b9b2a8")),
                    "roughness": _as_float(entry.get("roughness", 0.62), 0.62),
                    "specular": _as_float(entry.get("specular", 0.35), 0.35),
                    "coat": _as_float(entry.get("coat", 0.08), 0.08),
                    "texture": {"type": "noise", "scale": 120, "detail": 8, "bump": 0.06, "bump_distance": 0.002,
                                "color_a": str(entry.get("color", "#b9b2a8")), "color_b": str(entry.get("color", "#b9b2a8"))},
                },
                materials,
                "Clay",
            )
            for obj in targets:
                if obj.type != "MESH":
                    continue
                _backup_materials(obj)
                obj.data.materials.clear()
                obj.data.materials.append(mat)
                report["objects"].append(obj.name)
        if mode in ("wire", "wireframe", "clay_wire", "wire_clay"):
            for obj in targets:
                if obj.type != "MESH":
                    continue
                wire = _make_wire_overlay(obj, entry)
                if wire is not None:
                    report.setdefault("wires", []).append(wire.name)
        if entry.get("freestyle"):
            try:
                scene = _scene()
                scene.render.use_freestyle = True
                layer = _view_layer()
                layer.use_freestyle = True
                settings = layer.freestyle_settings
                if not settings.linesets:
                    settings.linesets.new("CV_Lines")
                lineset = settings.linesets[0]
                lineset.select_silhouette = True
                lineset.select_border = True
                lineset.select_crease = True
                lineset.linestyle.color = (0.02, 0.02, 0.02)
                lineset.linestyle.thickness = _as_float(entry.get("line_thickness", 1.4), 1.4)
                report["freestyle"] = True
            except Exception as exc:
                _warn("freestyle enable failed: %s" % exc)
        reports.append(report)
    return reports


def _backup_materials(obj):
    if obj.get("cv_material_backup"):
        return
    names = [slot.material.name if slot.material else "" for slot in obj.material_slots]
    obj["cv_material_backup"] = json.dumps(names)


def _restore_materials(obj):
    raw = obj.get("cv_material_backup")
    if not raw:
        return
    try:
        names = json.loads(str(raw))
    except Exception:
        return
    obj.data.materials.clear()
    for name in names:
        if name and bpy.data.materials.get(name) is not None:
            obj.data.materials.append(bpy.data.materials[name])
    try:
        del obj["cv_material_backup"]
    except Exception:
        pass


def _make_wire_overlay(obj, entry):
    try:
        wire = obj.copy()
        wire.data = obj.data.copy()
        wire.name = obj.name + "_Wire"
        coll = _collection("Wire")
        coll.objects.link(wire)
        wire.parent = None
        for mod in list(wire.modifiers):
            if mod.type in ("SUBSURF", "SOLIDIFY", "MIRROR", "ARMATURE", "WEIGHTED_NORMAL"):
                wire.modifiers.remove(mod)
        thickness = _as_float(entry.get("wire_thickness", 0.0016), 0.0016)
        mod = wire.modifiers.new("Wire", "WIREFRAME")
        mod.thickness = thickness
        mod.use_replace = True
        mod.use_even_offset = True
        mat = bpy.data.materials.get("CV_WireMat") or bpy.data.materials.new("CV_WireMat")
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        nodes.clear()
        out = nodes.new("ShaderNodeOutputMaterial")
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        bsdf.location = (300, 0)
        color = tuple(list(_hex_to_rgb(str(entry.get("wire_color", "#101010")))) + [1.0])
        for socket, value in (
            ("Base Color", color),
            ("Roughness", 0.65),
            ("Emission Color", color),
            ("Emission Strength", _as_float(entry.get("wire_glow", 0.35), 0.35)),
        ):
            try:
                bsdf.inputs[socket].default_value = value
            except Exception:
                pass
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        wire.data.materials.clear()
        wire.data.materials.append(mat)
        return wire
    except Exception as exc:
        _warn("wire overlay on %s failed: %s" % (obj.name, exc))
        return None


def _hex_to_rgb(value):
    text = str(value).strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    try:
        return tuple(int(text[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    except Exception:
        return (0.05, 0.05, 0.05)


# ---------------------------------------------------------------------------
# plan entry points
# ---------------------------------------------------------------------------


def build_body(plan, out_dir=""):
    """Stage 1: base human (must exist before objects that hang off it)."""
    spec = plan.get("human")
    if not spec:
        return {}
    if not isinstance(spec, dict):
        spec = {}
    try:
        report = build_human(spec, out_dir, plan.setdefault("__materials", {}))
    except Exception as exc:
        _warn("human build failed: %s" % exc)
        traceback.print_exc()
        return {"error": str(exc)}
    return report


def apply_detail(plan, out_dir=""):
    """Stage 2: sculpt, hair, drape, ornaments, weights, retopo, view."""
    cache = plan.get("__materials") or {}
    results = {}
    order = (
        ("drape", build_drape),
        ("ornament", build_ornament),
        ("sculpt", build_sculpt),
        ("hair", build_hair),
        ("weights", build_weights),
        ("retopo", build_retopo),
        ("view", apply_view),
    )
    for key, builder in order:
        spec = plan.get(key)
        if not spec:
            continue
        try:
            results[key] = builder(spec, out_dir, cache)
        except Exception as exc:
            _warn("%s block failed: %s" % (key, exc))
            traceback.print_exc()
            results[key] = {"error": str(exc)}
    return results


def capabilities():
    return {
        "human": {
            "engine": "MPFB2 (MakeHuman) base mesh + target library",
            "keys": [
                "gender", "age", "muscle", "weight", "proportions", "height", "cupsize", "firmness",
                "race", "face (portrait|heroic|soft)", "targets[{name,value}]", "rig",
                "parts[eyes,teeth,tongue,lashes,scalp]", "material", "eye_material", "keep_shape_keys", "hide_helpers",
            ],
        },
        "sculpt": {
            "brushes": list(BRUSHES),
            "keys": [
                "object", "subdivide", "symmetry", "smooth_after", "final_subdiv", "max_displace",
                "strokes[{brush,points|center,radius,strength,height,hardness,pressure,spacing,direction,normal,region,z_range,front_only,pinch,offset}]",
            ],
        },
        "hair": {
            "modes": ["strands", "cards", "both"],
            "keys": [
                "head", "mode", "count", "segments", "length", "length_variation", "part", "gravity",
                "bend", "curl", "lift", "outward", "flow", "facing", "strand_radius", "tip",
                "card_width", "color", "seed", "material", "card_material",
            ],
        },
        "drape": {
            "garments": ["skirt", "dress", "sleeve", "ruffle", "cape", "veil"],
            "keys": [
                "type", "segments", "rings", "folds{count,amplitude,twist}", "wrinkle", "height",
                "radius_top", "radius_bottom", "thickness", "subdivisions", "puff", "material", "location", "rotation",
            ],
        },
        "ornament": {"motifs": list(MOTIFS.keys()), "keys": ["motif", "scale", "turns", "bevel", "count", "spacing", "mirror", "material"]},
        "retopo": {"keys": ["object", "quadriflow{faces|ratio,symmetry,preserve_sharp}", "voxel", "weighted_normal", "sharp_angle", "seams", "bevel_weight", "uv"]},
        "weights": {"modes": ["transfer", "cloth", "autoweight"], "keys": ["object", "source", "armature", "limit", "smooth", "factor", "expand"]},
        "view": {"modes": ["clay", "wire", "clay_wire", "matcap"], "keys": ["mode", "color", "wire_thickness", "wire_color", "freestyle", "line_thickness", "restore"]},
        "measure": ["vertices", "polygons", "triangles", "dimensions", "height", "landmarks"],
    }
