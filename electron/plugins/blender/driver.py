"""ComposeVC Blender driver.

Runs inside `blender --background --python driver.py -- --plan plan.json --out <dir>`.
Reads a declarative scene plan (JSON), builds the scene with bpy, optionally
renders presentation stills, bakes procedural materials to image textures and
exports game-ready files. Every failure is captured per step so one broken
object never destroys the whole job.

Modes:
  --plan <file.json> --out <dir>   build/render/export a scene
  --probe --out <dir>              report version/engines/exporters as JSON
"""

import json
import math
import os
import sys
import time
import traceback

import bpy
from mathutils import Matrix, Vector

WARNINGS = []
STARTED = time.time()
OUT_DIR = ""
RESULT = {
    "ok": False,
    "warnings": WARNINGS,
    "artifacts": [],
    "renders": [],
    "exports": [],
    "stats": {},
    "engine": "",
    "blenderVersion": "",
    "warningsCount": 0,
}


def log(message):
    print("[cv] %s" % message, flush=True)


def progress(stage, percent, **extra):
    payload = {"stage": stage, "percent": int(max(0, min(100, percent)))}
    payload.update(extra)
    print("CVJOB " + json.dumps(payload), flush=True)


def warn(message):
    text = str(message)
    WARNINGS.append(text[:600])
    print("[cv:warn] %s" % text, flush=True)


def as_float(value, fallback=0.0):
    try:
        return float(value)
    except Exception:
        return fallback


def as_int(value, fallback=0):
    try:
        return int(round(float(value)))
    except Exception:
        return fallback


def as_vec3(value, fallback=(0.0, 0.0, 0.0)):
    if value is None:
        return tuple(fallback)
    try:
        if isinstance(value, (int, float)):
            return (float(value),) * 3
        seq = list(value)
        while len(seq) < 3:
            seq.append(0.0)
        return tuple(as_float(v) for v in seq[:3])
    except Exception:
        return tuple(fallback)


def as_color(value, fallback=(0.8, 0.8, 0.8), alpha=None):
    """Accepts [r,g,b(,a)] in 0..1 or 0..255, or '#rrggbb'."""
    result = None
    if isinstance(value, str):
        text = value.strip().lstrip("#")
        try:
            if len(text) == 3:
                text = "".join(ch * 2 for ch in text)
            rgb = [int(text[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
            a = 1.0
            if len(text) >= 8:
                a = int(text[6:8], 16) / 255.0
            result = (rgb[0], rgb[1], rgb[2], a)
        except Exception:
            result = None
    elif isinstance(value, (list, tuple)):
        seq = [as_float(v) for v in value[:4]]
        if seq and max(seq[:3] or [0]) > 1.0:
            seq = [v / 255.0 for v in seq]
        while len(seq) < 3:
            seq.append(fallback[len(seq)])
        a = seq[3] if len(seq) > 3 else 1.0
        result = (seq[0], seq[1], seq[2], a)
    if result is None:
        result = (fallback[0], fallback[1], fallback[2], fallback[3] if len(fallback) > 3 else 1.0)
    if alpha is not None:
        result = (result[0], result[1], result[2], as_float(alpha, 1.0))
    return result


def set_input(node, value, *names):
    if node is None or value is None:
        return False
    for name in names:
        socket = node.inputs.get(name) if hasattr(node.inputs, "get") else None
        if socket is None:
            continue
        try:
            current = socket.default_value
            if hasattr(current, "__len__") and not isinstance(current, str):
                if isinstance(value, (int, float)):
                    socket.default_value = tuple([float(value)] * len(current))
                else:
                    seq = list(value)
                    while len(seq) < len(current):
                        seq.append(0.0)
                    socket.default_value = tuple(float(v) for v in seq[: len(current)])
            else:
                socket.default_value = value
            return True
        except Exception:
            continue
    return False


def set_attr(obj, name, value, label=""):
    if obj is None or value is None or not hasattr(obj, name):
        return False
    try:
        current = getattr(obj, name)
        if hasattr(current, "__len__") and not isinstance(current, str):
            seq = list(value)
            while len(seq) < len(current):
                seq.append(0.0)
            setattr(obj, name, [float(v) for v in seq[: len(current)]])
        else:
            setattr(obj, name, value)
        return True
    except Exception as exc:
        warn("attribute %s%s: %s" % (name, (" on " + label) if label else "", exc))
        return False


def scene():
    return bpy.context.scene


def view_layer():
    return bpy.context.view_layer


def coll_root():
    return scene().collection


def ensure_collection(name, parent_name=None):
    name = str(name or "Collection")
    root = coll_root()
    if name == root.name:
        return root
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
    parent = bpy.data.collections.get(parent_name) if parent_name else None
    target = parent if parent is not None else root
    if not any(child.name == coll.name for child in target.children):
        try:
            target.children.link(coll)
        except Exception:
            pass
    return coll


def move_to_collection(obj, coll):
    if obj is None or coll is None:
        return
    for owner in list(getattr(obj, "users_collection", []) or []):
        try:
            owner.objects.unlink(obj)
        except Exception:
            pass
    try:
        coll.objects.link(obj)
    except Exception:
        pass


def select_only(obj):
    try:
        bpy.ops.object.select_all(action="DESELECT")
    except Exception:
        pass
    if obj is None:
        return
    try:
        obj.select_set(True)
        view_layer().objects.active = obj
    except Exception:
        pass


def aim_at(obj, target):
    if obj is None or target is None:
        return
    try:
        direction = Vector(target) - obj.location
        if direction.length < 1e-6:
            return
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    except Exception as exc:
        warn("look_at failed: %s" % exc)


# ── materials ────────────────────────────────────────────────────────────────


def _ramp(nodes, links, factor_socket, color_a, color_b, location=(0, 0), softness=0.5):
    node = nodes.new("ShaderNodeValToRGB")
    node.location = location
    ramp = node.color_ramp
    try:
        ramp.elements[0].position = 0.0
        ramp.elements[0].color = color_a
        ramp.elements[1].position = 1.0
        ramp.elements[1].color = color_b
        if softness is not None:
            ramp.elements[0].position = max(0.0, min(0.9, 0.5 - float(softness) * 0.4))
            ramp.elements[1].position = min(1.0, max(0.1, 0.5 + float(softness) * 0.4))
    except Exception:
        pass
    if factor_socket is not None:
        links.new(factor_socket, node.inputs["Fac"])
    return node


def _mapping(nodes, links, scale=1.0, rotation=(0, 0, 0), location=(0, 0, 0), use_uv=False):
    tex_coord = nodes.new("ShaderNodeTexCoord")
    tex_coord.location = (-1000, 0)
    mapping = nodes.new("ShaderNodeMapping")
    mapping.location = (-820, 0)
    if hasattr(tex_coord.outputs, "get") and tex_coord.outputs.get("UV"):
        links.new(tex_coord.outputs["UV" if use_uv else "Object"], mapping.inputs["Vector"])
    scale_value = scale if isinstance(scale, (list, tuple)) else (scale, scale, scale)
    set_input(mapping, as_vec3(scale_value, (1, 1, 1)), "Scale")
    set_input(mapping, as_vec3(rotation), "Rotation")
    set_input(mapping, as_vec3(location), "Location")
    return mapping


def _procedural_nodes(nodes, links, tex, location=(0, 0)):
    """Returns (factor_socket|None, color_socket|None)."""
    kind = str(tex.get("type", "noise")).lower()
    mapping = _mapping(
        nodes,
        links,
        scale=tex.get("uv_scale", tex.get("mapping_scale", 1.0)),
        rotation=as_vec3(tex.get("rotation", (0, 0, 0))),
        location=as_vec3(tex.get("offset", (0, 0, 0))),
        use_uv=bool(tex.get("uv", False)),
    )
    vector_socket = mapping.outputs["Vector"]
    node = None
    factor = None
    color = None
    if kind in ("noise", "musgrave", "fractal", "clouds"):
        node = nodes.new("ShaderNodeTexNoise")
        node.location = location
        set_input(node, as_float(tex.get("scale", 5.0), 5.0), "Scale")
        set_input(node, as_float(tex.get("detail", 6.0), 6.0), "Detail")
        set_input(node, as_float(tex.get("roughness", 0.5), 0.5), "Roughness")
        set_input(node, as_float(tex.get("distortion", 0.0), 0.0), "Distortion")
        if kind == "musgrave":
            try:
                node.noise_type = "MULTIFRACTAL"
                set_input(node, as_float(tex.get("lacunarity", 2.0), 2.0), "Lacunarity")
            except Exception:
                pass
        links.new(vector_socket, node.inputs["Vector"])
        factor = node.outputs["Fac"]
        color = node.outputs["Color"]
    elif kind in ("voronoi", "cells", "scales"):
        node = nodes.new("ShaderNodeTexVoronoi")
        node.location = location
        set_input(node, as_float(tex.get("scale", 6.0), 6.0), "Scale")
        set_input(node, as_float(tex.get("randomness", 1.0), 1.0), "Randomness")
        try:
            node.feature = str(tex.get("feature", "F1")).upper()
        except Exception:
            pass
        try:
            node.distance = str(tex.get("metric", "EUCLIDEAN")).upper()
        except Exception:
            pass
        links.new(vector_socket, node.inputs["Vector"])
        factor = node.outputs.get("Distance")
        color = node.outputs.get("Color")
    elif kind in ("wave", "wood", "rings"):
        node = nodes.new("ShaderNodeTexWave")
        node.location = location
        try:
            node.wave_type = "RINGS" if kind == "rings" else str(tex.get("wave_type", "BANDS")).upper()
        except Exception:
            pass
        try:
            node.bands_direction = str(tex.get("direction", "Z")).upper()
        except Exception:
            pass
        set_input(node, as_float(tex.get("scale", 3.0), 3.0), "Scale")
        set_input(node, as_float(tex.get("distortion", 4.0), 4.0), "Distortion")
        set_input(node, as_float(tex.get("detail", 2.0), 2.0), "Detail")
        links.new(vector_socket, node.inputs["Vector"])
        factor = node.outputs.get("Fac")
        color = node.outputs.get("Color")
    elif kind in ("checker", "checkers"):
        node = nodes.new("ShaderNodeTexChecker")
        node.location = location
        set_input(node, as_float(tex.get("scale", 8.0), 8.0), "Scale")
        set_input(node, as_color(tex.get("color_a", "#dddddd")), "Color1")
        set_input(node, as_color(tex.get("color_b", "#111111")), "Color2")
        links.new(vector_socket, node.inputs["Vector"])
        factor = node.outputs.get("Fac")
        color = node.outputs.get("Color")
    elif kind in ("brick", "tiles"):
        node = nodes.new("ShaderNodeTexBrick")
        node.location = location
        set_input(node, as_float(tex.get("scale", 4.0), 4.0), "Scale")
        set_input(node, as_float(tex.get("mortar_size", 0.02), 0.02), "Mortar Size")
        set_input(node, as_float(tex.get("brick_width", 0.5), 0.5), "Brick Width")
        set_input(node, as_float(tex.get("row_height", 0.25), 0.25), "Row Height")
        set_input(node, as_color(tex.get("color_a", "#8d6b58")), "Color1")
        set_input(node, as_color(tex.get("color_b", "#6f5142")), "Color2")
        set_input(node, as_color(tex.get("mortar", "#d8d2c6")), "Mortar")
        links.new(vector_socket, node.inputs["Vector"])
        factor = node.outputs.get("Fac")
        color = node.outputs.get("Color")
    elif kind in ("gradient", "ramp"):
        node = nodes.new("ShaderNodeTexGradient")
        node.location = location
        try:
            node.gradient_type = str(tex.get("gradient", "LINEAR")).upper()
        except Exception:
            pass
        links.new(vector_socket, node.inputs["Vector"])
        factor = node.outputs.get("Fac")
        color = node.outputs.get("Color")
    elif kind == "magic":
        node = nodes.new("ShaderNodeTexMagic")
        node.location = location
        set_input(node, as_float(tex.get("scale", 5.0), 5.0), "Scale")
        set_input(node, as_float(tex.get("distortion", 1.0), 1.0), "Distortion")
        links.new(vector_socket, node.inputs["Vector"])
        factor = node.outputs.get("Fac")
        color = node.outputs.get("Color")
    else:
        warn("unknown texture type '%s' (using noise)" % kind)
        return _procedural_nodes(nodes, links, {**tex, "type": "noise"}, location)
    return factor, color


def _image_node(nodes, links, tex, location=(0, 0)):
    file_path = str(tex.get("path") or tex.get("file") or "").strip()
    if not file_path or not os.path.exists(file_path):
        warn("texture image not found: %s" % file_path)
        return None
    try:
        image = bpy.data.images.load(file_path, check_existing=True)
    except Exception as exc:
        warn("cannot load image %s: %s" % (file_path, exc))
        return None
    tex_node = nodes.new("ShaderNodeTexImage")
    tex_node.location = location
    tex_node.image = image
    try:
        tex_node.interpolation = str(tex.get("interpolation", "Linear"))
    except Exception:
        pass
    if tex.get("projection", "uv") in ("box", "BOX", "triplanar"):
        mapping = _mapping(
            nodes,
            links,
            scale=tex.get("uv_scale", tex.get("mapping_scale", 1.0)),
            rotation=as_vec3(tex.get("rotation", (0, 0, 0))),
            location=as_vec3(tex.get("offset", (0, 0, 0))),
        )
        try:
            tex_node.projection = "BOX"
            tex_node.projection_blend = as_float(tex.get("blend", 0.3), 0.3)
        except Exception:
            pass
        links.new(mapping.outputs["Vector"], tex_node.inputs["Vector"])
    else:
        mapping = _mapping(
            nodes,
            links,
            scale=tex.get("uv_scale", tex.get("mapping_scale", 1.0)),
            rotation=as_vec3(tex.get("rotation", (0, 0, 0))),
            location=as_vec3(tex.get("offset", (0, 0, 0))),
            use_uv=True,
        )
        links.new(mapping.outputs["Vector"], tex_node.inputs["Vector"])
    return tex_node


def build_material(spec):
    if not isinstance(spec, dict):
        return None
    name = str(spec.get("name") or spec.get("id") or "Material")
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    output.location = (620, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (280, 0)
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    base_color = as_color(spec.get("base_color", spec.get("color", "#cfcfcf")))
    set_input(bsdf, base_color, "Base Color")
    set_input(bsdf, as_float(spec.get("metallic", 0.0)), "Metallic")
    set_input(bsdf, as_float(spec.get("roughness", 0.45)), "Roughness")
    set_input(bsdf, as_float(spec.get("ior", 1.45), 1.45), "IOR")
    set_input(bsdf, as_float(spec.get("specular", 0.5), 0.5), "Specular IOR Level", "Specular")
    set_input(bsdf, as_float(spec.get("transmission", 0.0)), "Transmission Weight", "Transmission")
    set_input(bsdf, as_float(spec.get("coat", 0.0)), "Coat Weight", "Clearcoat")
    set_input(bsdf, as_float(spec.get("coat_roughness", 0.03), 0.03), "Coat Roughness", "Clearcoat Roughness")
    set_input(bsdf, as_float(spec.get("sheen", 0.0)), "Sheen Weight", "Sheen")
    set_input(bsdf, as_float(spec.get("subsurface", 0.0)), "Subsurface Weight", "Subsurface")
    set_input(bsdf, as_float(spec.get("anisotropic", 0.0)), "Anisotropic")

    emission = spec.get("emission")
    if emission is not None:
        emission_color = as_color(emission, base_color)
        set_input(bsdf, emission_color, "Emission Color", "Emission")
        set_input(bsdf, as_float(spec.get("emission_strength", 2.0), 2.0), "Emission Strength")

    alpha = as_float(spec.get("alpha", 1.0), 1.0)
    if alpha < 0.999 or spec.get("blend"):
        set_input(bsdf, alpha, "Alpha")
        try:
            mat.surface_render_method = "DITHERED" if alpha > 0.0 else "BLENDED"
        except Exception:
            pass
        try:
            mat.blend_method = "BLEND" if alpha < 1.0 else "OPAQUE"
        except Exception:
            pass
        try:
            mat.show_transparent_back = False
        except Exception:
            pass
    try:
        mat.use_backface_culling = bool(spec.get("backface_culling", False))
    except Exception:
        pass

    tex = spec.get("texture") or spec.get("texture_map")
    if isinstance(tex, str):
        tex = {"type": tex}
    factor = None
    if isinstance(tex, dict):
        kind = str(tex.get("type", "noise")).lower()
        if kind in ("image", "file", "texture", "png", "jpg", "photo"):
            image_node = _image_node(nodes, links, tex, (-420, 120))
            if image_node is not None:
                links.new(image_node.outputs["Color"], bsdf.inputs["Base Color"])
                if tex.get("alpha_to_alpha"):
                    links.new(image_node.outputs["Alpha"], bsdf.inputs["Alpha"])
                if tex.get("normal") or kind == "normal":
                    pass
        else:
            factor, color = _procedural_nodes(nodes, links, tex, (-420, 120))
            if color is not None:
                if tex.get("use_raw_color"):
                    links.new(color, bsdf.inputs["Base Color"])
                else:
                    ramp = _ramp(
                        nodes,
                        links,
                        factor,
                        as_color(tex.get("color_a", spec.get("color_a", base_color))),
                        as_color(tex.get("color_b", spec.get("color_b", base_color))),
                        (-180, 120),
                        tex.get("contrast", 0.5),
                    )
                    links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
            if tex.get("roughness_map"):
                map_range = nodes.new("ShaderNodeMapRange")
                map_range.location = (-180, -120)
                lo = as_float(tex.get("roughness_min", max(0.02, as_float(spec.get("roughness", 0.45)) * 0.35)), 0.1)
                hi = as_float(tex.get("roughness_max", min(1.0, as_float(spec.get("roughness", 0.45)) * 1.9 + 0.05)), 0.8)
                set_input(map_range, 0.0, "From Min")
                set_input(map_range, 1.0, "From Max")
                set_input(map_range, lo, "To Min")
                set_input(map_range, hi, "To Max")
                if factor is not None:
                    links.new(factor, map_range.inputs["Value"])
                    links.new(map_range.outputs["Result"], bsdf.inputs["Roughness"])
            bump_strength = as_float(tex.get("bump", tex.get("bump_strength", 0.0)), 0.0)
            if bump_strength > 0 and factor is not None:
                bump = nodes.new("ShaderNodeBump")
                bump.location = (-180, -360)
                set_input(bump, bump_strength, "Strength")
                set_input(bump, as_float(tex.get("bump_distance", 0.05), 0.05), "Distance")
                links.new(factor, bump.inputs["Height"])
                links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    normal_map = spec.get("normal_map") or spec.get("normal_texture")
    if isinstance(normal_map, dict) or (isinstance(normal_map, str) and normal_map):
        nm_spec = normal_map if isinstance(normal_map, dict) else {"type": "image", "path": normal_map}
        nm_spec.setdefault("type", "image")
        nm_node = _image_node(nodes, links, nm_spec, (-420, -520))
        if nm_node is not None:
            normal_node = nodes.new("ShaderNodeNormalMap")
            normal_node.location = (-180, -520)
            set_input(normal_node, as_float(nm_spec.get("strength", 1.0), 1.0), "Strength")
            links.new(nm_node.outputs["Color"], normal_node.inputs["Color"])
            links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])
            try:
                nm_node.image.colorspace_settings.name = "Non-Color"
            except Exception:
                pass

    for extra in spec.get("nodes") or []:
        if not isinstance(extra, dict):
            continue
        try:
            node = nodes.new(str(extra.get("type")))
            for key, value in (extra.get("inputs") or {}).items():
                set_input(node, value, key)
            if extra.get("location"):
                node.location = as_vec3(extra["location"])[:2]
            for target in extra.get("link") or []:
                links.new(node.outputs[str(target.get("from"))], bsdf.inputs[str(target.get("to"))])
        except Exception as exc:
            warn("material extra node failed: %s" % exc)
    return mat


def material_for(spec, cache, hint=""):
    if spec is None:
        return None
    if isinstance(spec, str):
        existing = bpy.data.materials.get(spec)
        if existing is not None:
            return existing
        return cache.get(spec)
    if isinstance(spec, dict):
        name = str(spec.get("name") or spec.get("id") or ((str(hint) + " Material") if hint else "Material"))
        if name in cache:
            return cache[name]
        mat = build_material({**spec, "name": name})
        if mat is not None:
            cache[name] = mat
        return mat
    return None


# ── objects ──────────────────────────────────────────────────────────────────

PRIMITIVES = {
    "cube": ("primitive_cube_add", {"size": 1.0}),
    "box": ("primitive_cube_add", {"size": 1.0}),
    "sphere": ("primitive_uv_sphere_add", {"radius": 1.0}),
    "uv_sphere": ("primitive_uv_sphere_add", {"radius": 1.0}),
    "ico_sphere": ("primitive_ico_sphere_add", {"radius": 1.0}),
    "cylinder": ("primitive_cylinder_add", {"radius": 1.0, "depth": 2.0}),
    "cone": ("primitive_cone_add", {"radius1": 1.0, "radius2": 0.0, "depth": 2.0}),
    "torus": ("primitive_torus_add", {"major_radius": 1.0, "minor_radius": 0.25}),
    "plane": ("primitive_plane_add", {"size": 2.0}),
    "circle": ("primitive_circle_add", {"radius": 1.0, "fill_type": "NGON"}),
    "grid": ("primitive_grid_add", {"size": 2.0, "x_subdivisions": 10, "y_subdivisions": 10}),
    "monkey": ("primitive_monkey_add", {"size": 1.0}),
}


def _apply_common_transform(obj, spec):
    obj.location = as_vec3(spec.get("location", (0, 0, 0)))
    rotation = as_vec3(spec.get("rotation", (0, 0, 0)))
    try:
        obj.rotation_euler = tuple(math.radians(v) for v in rotation)
    except Exception:
        pass
    if spec.get("rotation_radians") is not None:
        try:
            obj.rotation_euler = as_vec3(spec.get("rotation_radians"))
        except Exception:
            pass
    scale = as_vec3(spec.get("scale", (1, 1, 1)), (1, 1, 1))
    if scale == (0.0, 0.0, 0.0):
        scale = (1.0, 1.0, 1.0)
    obj.scale = scale
    dims = spec.get("dimensions")
    if dims:
        try:
            bpy.context.view_layer.update()
            obj.dimensions = as_vec3(dims, (1, 1, 1))
        except Exception as exc:
            warn("dimensions failed: %s" % exc)
    if spec.get("look_at") is not None:
        aim_at(obj, as_vec3(spec.get("look_at")))


def _create_mesh_object(spec, coll):
    verts = spec.get("vertices") or spec.get("verts")
    faces = spec.get("faces") or spec.get("polygons")
    if not verts:
        return None
    mesh = bpy.data.meshes.new(str(spec.get("name", "Mesh")) + "_mesh")
    try:
        mesh.from_pydata([as_vec3(v) for v in verts], [], [list(map(int, f)) for f in (faces or [])])
        mesh.validate()
        mesh.update()
    except Exception as exc:
        warn("mesh from data failed: %s" % exc)
        return None
    obj = bpy.data.objects.new(str(spec.get("name") or mesh.name), mesh)
    coll.objects.link(obj)
    return obj


def _create_curve_object(spec, coll):
    points = spec.get("points") or spec.get("spline")
    if not points:
        return None
    curve = bpy.data.curves.new(str(spec.get("name", "Curve")) + "_curve", "CURVE")
    curve.dimensions = "3D"
    try:
        spline_type = str(spec.get("spline_type", "BEZIER")).upper()
        spline = curve.splines.new(spline_type)
        if spline_type == "BEZIER":
            spline.bezier_points.add(len(points) - 1)
            for index, point in enumerate(points):
                bp = spline.bezier_points[index]
                bp.co = as_vec3(point)
                bp.handle_left_type = "AUTO"
                bp.handle_right_type = "AUTO"
        else:
            spline.points.add(len(points) - 1)
            for index, point in enumerate(points):
                co = as_vec3(point)
                spline.points[index].co = (co[0], co[1], co[2], 1.0)
        spline.use_cyclic_u = bool(spec.get("cyclic", False))
        curve.bevel_depth = as_float(spec.get("bevel_depth", 0.02), 0.02)
        curve.bevel_resolution = as_int(spec.get("bevel_resolution", 2), 2)
        curve.use_fill_caps = True
        curve.resolution_u = as_int(spec.get("resolution", 12), 12)
    except Exception as exc:
        warn("curve creation failed: %s" % exc)
    obj = bpy.data.objects.new(str(spec.get("name") or curve.name), curve)
    coll.objects.link(obj)
    return obj


def _create_text_object(spec, coll):
    body = spec.get("text") or spec.get("body")
    if body is None:
        return None
    curve = bpy.data.curves.new(str(spec.get("name", "Text")) + "_text", "FONT")
    curve.body = str(body)
    curve.size = as_float(spec.get("size", 1.0), 1.0)
    curve.align_x = str(spec.get("align_x", "CENTER")).upper()
    curve.align_y = str(spec.get("align_y", "CENTER")).upper()
    curve.extrude = as_float(spec.get("extrude", 0.0), 0.0)
    if spec.get("font"):
        try:
            curve.font = bpy.data.fonts.load(str(spec.get("font")), check_existing=True)
        except Exception as exc:
            warn("font load failed: %s" % exc)
    obj = bpy.data.objects.new(str(spec.get("name") or curve.name), curve)
    coll.objects.link(obj)
    return obj


def _create_light_object(spec, coll):
    kind = str(spec.get("type", "point")).upper()
    light_type = {"SUN": "SUN", "AREA": "AREA", "SPOT": "SPOT", "POINT": "POINT", "LIGHT": "POINT"}.get(
        kind, "POINT"
    )
    light = bpy.data.lights.new(str(spec.get("name") or "Light"), light_type)
    color = as_color(spec.get("color", "#ffffff"))
    light.color = (color[0], color[1], color[2])
    light.energy = as_float(spec.get("energy", 500.0), 500.0)
    try:
        if light_type in ("POINT", "SPOT"):
            light.shadow_soft_size = as_float(spec.get("size", 0.15), 0.15)
        if light_type == "AREA":
            light.shape = str(spec.get("shape", "DISK" if spec.get("disk") else "RECTANGLE")).upper()
            size = spec.get("size", (2.0, 2.0))
            if isinstance(size, (int, float)):
                size = (size, size)
            light.size = as_float(size[0], 2.0)
            if len(size) > 1:
                light.size_y = as_float(size[1], 2.0)
        if light_type == "SPOT":
            light.spot_size = math.radians(as_float(spec.get("spot_size", 45.0), 45.0))
            light.spot_blend = as_float(spec.get("spot_blend", 0.3), 0.3)
        if hasattr(light, "use_shadow"):
            light.use_shadow = spec.get("shadow", True) is not False
    except Exception as exc:
        warn("light settings: %s" % exc)
    obj = bpy.data.objects.new(str(spec.get("name") or light.name), light)
    coll.objects.link(obj)
    return obj


def _create_camera_object(spec, coll):
    cam_data = bpy.data.cameras.new(str(spec.get("name") or "Camera"))
    cam_data.lens = as_float(spec.get("lens", spec.get("focal", 50.0)), 50.0)
    try:
        cam_data.sensor_width = as_float(spec.get("sensor_width", 36.0), 36.0)
        if spec.get("orthographic") or spec.get("ortho"):
            cam_data.type = "ORTHO"
            cam_data.ortho_scale = as_float(spec.get("ortho_scale", 4.0), 4.0)
        if spec.get("dof"):
            dof = spec.get("dof") if isinstance(spec.get("dof"), dict) else {}
            cam_data.dof.use_dof = True
            cam_data.dof.focus_distance = as_float(dof.get("distance", spec.get("focus_distance", 5.0)), 5.0)
            cam_data.dof.aperture_fstop = as_float(dof.get("fstop", 2.8), 2.8)
    except Exception as exc:
        warn("camera settings: %s" % exc)
    obj = bpy.data.objects.new(str(spec.get("name") or cam_data.name), cam_data)
    coll.objects.link(obj)
    return obj


def _filter_op_kwargs(op, kwargs):
    """Silently drop keys the operator does not accept (keeps plans forgiving)."""
    try:
        allowed = set(op.get_rna_type().properties.keys())
    except Exception:
        return kwargs
    return {key: value for key, value in kwargs.items() if key in allowed}


def create_object(spec, coll, materials):
    if not isinstance(spec, dict):
        return None
    kind = str(spec.get("type", "cube")).lower()
    obj = None
    if kind in PRIMITIVES:
        op_name, defaults = PRIMITIVES[kind]
        kwargs = dict(defaults)
        int_keys = {"segments", "ring_count", "subdivisions", "vertices", "major_segments", "minor_segments", "x_subdivisions", "y_subdivisions"}
        for key in int_keys.union({"radius", "radius1", "radius2", "depth", "major_radius", "minor_radius", "size"}):
            if spec.get(key) is None:
                continue
            kwargs[key] = int(spec[key]) if key in int_keys else as_float(spec[key], defaults.get(key, 0))
        try:
            op = getattr(bpy.ops.mesh, op_name)
            op(**_filter_op_kwargs(op, kwargs))
            obj = bpy.context.active_object
        except Exception as exc:
            warn("primitive %s failed: %s" % (kind, exc))
            obj = None
        if obj is not None:
            obj.name = str(spec.get("name") or kind.title())
            move_to_collection(obj, coll)
    elif kind == "mesh":
        obj = _create_mesh_object(spec, coll)
    elif kind in ("curve", "poly", "path"):
        obj = _create_curve_object(spec, coll)
    elif kind == "text":
        obj = _create_text_object(spec, coll)
    elif kind in ("light", "point", "sun", "area", "spot"):
        light_spec = dict(spec)
        if kind != "light":
            light_spec["type"] = kind
        obj = _create_light_object(light_spec, coll)
    elif kind == "camera":
        obj = _create_camera_object(spec, coll)
    elif kind in ("empty", "null", "locator"):
        try:
            bpy.ops.object.empty_add(type=str(spec.get("empty_type", "PLAIN_AXES")).upper(), location=(0, 0, 0))
            obj = bpy.context.active_object
            obj.name = str(spec.get("name") or "Empty")
            move_to_collection(obj, coll)
        except Exception as exc:
            warn("empty failed: %s" % exc)

    if obj is None:
        warn("object '%s' could not be created (type=%s)" % (spec.get("name"), kind))
        return None

    _apply_common_transform(obj, spec)

    material_specs = spec.get("materials") if spec.get("materials") is not None else spec.get("material")
    if material_specs is not None:
        if not isinstance(material_specs, list):
            material_specs = [material_specs]
        for entry in material_specs:
            mat = material_for(entry, materials, obj.name)
            if mat is None:
                continue
            try:
                obj.data.materials.append(mat)
            except Exception:
                warn("cannot assign material to %s" % obj.name)
        if obj.type == "MESH" and not obj.data.uv_layers:
            # Image textures need UVs; game exports look broken without them.
            smart_uv(obj, {})

    if spec.get("smooth") or spec.get("shade_smooth"):
        try:
            if obj.type == "MESH":
                for poly in obj.data.polygons:
                    poly.use_smooth = True
        except Exception:
            pass
    if spec.get("auto_smooth"):
        try:
            angle = math.radians(as_float(spec.get("auto_smooth"), 40.0))
            bpy.ops.object.shade_auto_smooth(angle=angle) if hasattr(bpy.ops.object, "shade_auto_smooth") else None
        except Exception:
            pass

    modifiers = list(spec.get("modifiers") or [])
    if spec.get("bevel"):
        bevel = spec.get("bevel")
        bevel = bevel if isinstance(bevel, dict) else {"width": as_float(bevel, 0.02)}
        modifiers.append({"type": "BEVEL", **bevel})
    if spec.get("subdivision"):
        modifiers.append({"type": "SUBSURF", "levels": as_int(spec.get("subdivision"), 2), "render_levels": as_int(spec.get("subdivision"), 2)})
    if spec.get("array"):
        array = spec.get("array")
        array = array if isinstance(array, dict) else {"count": as_int(array, 2)}
        modifiers.append({"type": "ARRAY", **array})
    if spec.get("mirror"):
        mirror = spec.get("mirror")
        mirror = mirror if isinstance(mirror, dict) else {"axis": str(mirror).upper() if isinstance(mirror, str) else "X"}
        modifiers.append({"type": "MIRROR", **mirror})

    apply_now = bool(spec.get("apply_modifiers", False))
    for mod_spec in modifiers:
        if not isinstance(mod_spec, dict):
            continue
        add_modifier(obj, mod_spec, apply_now)

    if spec.get("uv") or spec.get("smart_uv"):
        uv_spec = spec.get("uv") if isinstance(spec.get("uv"), dict) else {}
        smart_uv(obj, uv_spec)

    if spec.get("parent"):
        parent = bpy.data.objects.get(str(spec.get("parent")))
        if parent is not None:
            try:
                obj.parent = parent
                obj.matrix_parent_inverse = parent.matrix_world.inverted()
            except Exception:
                pass
    return obj


MODIFIER_AXIS = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}


def add_modifier(obj, spec, apply_now=False):
    kind = str(spec.get("type", "")).upper()
    if not kind:
        return
    try:
        mod = obj.modifiers.new(name=str(spec.get("name") or kind.title()), type=kind)
    except Exception as exc:
        warn("modifier %s on %s: %s" % (kind, obj.name, exc))
        return
    if kind == "MIRROR":
        axis = str(spec.get("axis", "X")).upper()
        flags = [axis.count("X") > 0 or axis == "X", axis.count("Y") > 0 or axis == "Y", axis.count("Z") > 0 or axis == "Z"]
        try:
            mod.use_axis = flags
        except Exception:
            pass
    for key, value in spec.items():
        if key in ("type", "name", "object", "collection", "axis"):
            continue
        if not hasattr(mod, key):
            continue
        try:
            setattr(mod, key, value)
        except Exception:
            try:
                setattr(mod, key, float(value))
            except Exception:
                warn("modifier %s.%s=%r ignored" % (kind, key, value))
    target = spec.get("object")
    if target:
        target_obj = bpy.data.objects.get(str(target))
        if target_obj is not None and hasattr(mod, "object"):
            mod.object = target_obj
        elif target_obj is None:
            warn("modifier %s target object '%s' not found" % (kind, target))
    if apply_now:
        select_only(obj)
        try:
            bpy.ops.object.modifier_apply(modifier=mod.name)
        except Exception as exc:
            warn("apply modifier %s on %s: %s" % (kind, obj.name, exc))


def smart_uv(obj, spec):
    if obj.type != "MESH":
        return
    select_only(obj)
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(
            angle_limit=math.radians(as_float(spec.get("angle", 66.0), 66.0)),
            island_margin=as_float(spec.get("margin", 0.02), 0.02),
        )
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception as exc:
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass
        warn("smart uv on %s: %s" % (obj.name, exc))


def ensure_uv(obj):
    if obj.type != "MESH":
        return
    if obj.data.uv_layers:
        return
    smart_uv(obj, {"margin": 0.02})


# ── world / lights / camera ─────────────────────────────────────────────────


def setup_world(spec):
    if spec is None:
        return
    world = scene().world
    if world is None:
        world = bpy.data.worlds.new("World")
        scene().world = world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    background = nodes.get("Background")
    if background is None:
        nodes.clear()
        output = nodes.new("ShaderNodeOutputWorld")
        background = nodes.new("ShaderNodeBackground")
        links.new(background.outputs["Background"], output.inputs["Surface"])
    color = as_color(spec.get("color", "#1b1d22"), (0.02, 0.02, 0.025, 1))
    strength = as_float(spec.get("strength", 1.0), 1.0)
    set_input(background, color, "Color")
    set_input(background, strength, "Strength")
    hdri = spec.get("hdri") or spec.get("environment")
    if hdri and os.path.exists(str(hdri)):
        try:
            image = bpy.data.images.load(str(hdri), check_existing=True)
            env = nodes.new("ShaderNodeTexEnvironment")
            env.image = image
            mapping = nodes.new("ShaderNodeMapping")
            tex_coord = nodes.new("ShaderNodeTexCoord")
            mapping.inputs["Rotation"].default_value = as_vec3(spec.get("hdri_rotation", (0, 0, 0)))
            links.new(tex_coord.outputs["Generated"], mapping.inputs["Vector"])
            links.new(mapping.outputs["Vector"], env.inputs["Vector"])
            links.new(env.outputs["Color"], background.inputs["Color"])
        except Exception as exc:
            warn("hdri failed: %s" % exc)
    elif hdri:
        warn("hdri not found: %s" % hdri)
    sky = spec.get("sky")
    if isinstance(sky, dict):
        try:
            sky_node = nodes.new("ShaderNodeTexSky")
            try:
                sky_node.sky_type = str(sky.get("type", "NISHITA")).upper()
            except Exception:
                pass
            set_input(sky_node, as_float(sky.get("sun_elevation", 15.0), 15.0), "Sun Elevation")
            set_input(sky_node, as_float(sky.get("sun_rotation", 0.0), 0.0), "Sun Rotation")
            set_input(sky_node, as_float(sky.get("altitude", 200.0), 200.0), "Altitude")
            set_input(sky_node, as_float(sky.get("air", 1.0), 1.0), "Air")
            set_input(sky_node, as_float(sky.get("dust", 1.0), 1.0), "Dust")
            set_input(sky_node, as_float(sky.get("ozone", 1.0), 1.0), "Ozone")
            links.new(sky_node.outputs["Color"], background.inputs["Color"])
            set_input(background, as_float(spec.get("sky_strength", strength), strength), "Strength")
        except Exception as exc:
            warn("sky failed: %s" % exc)


def scene_bounds():
    try:
        bpy.context.view_layer.update()
    except Exception:
        pass
    meshes = [obj for obj in scene().objects if obj.type == "MESH"]
    if not meshes:
        return Vector((0, 0, 0)), 1.0
    minimum = Vector((1e18, 1e18, 1e18))
    maximum = Vector((-1e18, -1e18, -1e18))
    for obj in meshes:
        try:
            for corner in obj.bound_box:
                world_corner = obj.matrix_world @ Vector(corner)
                for axis in range(3):
                    minimum[axis] = min(minimum[axis], world_corner[axis])
                    maximum[axis] = max(maximum[axis], world_corner[axis])
        except Exception:
            continue
    center = (minimum + maximum) * 0.5
    radius = max((maximum - minimum).length * 0.5, 0.25)
    return center, radius


LIGHTING_PRESETS = {
    "studio": {
        "world": {"color": "#16181c", "strength": 0.25},
        "lights": [
            {"type": "AREA", "name": "Key", "location": (-2.4, -3.0, 2.6), "energy": 900.0, "size": 3.0, "color": "#fff3e2", "look_at": [0, 0, 0]},
            {"type": "AREA", "name": "Fill", "location": (3.0, -1.6, 1.4), "energy": 320.0, "size": 4.0, "color": "#cfe3ff", "look_at": [0, 0, 0]},
            {"type": "AREA", "name": "Rim", "location": (0.6, 3.2, 2.2), "energy": 700.0, "size": 2.4, "color": "#ffffff", "look_at": [0, 0, 0]},
        ],
    },
    "three_point": {
        "world": {"color": "#101216", "strength": 0.2},
        "lights": [
            {"type": "SUN", "name": "KeySun", "energy": 3.4, "rotation": [52, 0, 38], "color": "#fff2dc"},
            {"type": "AREA", "name": "Fill", "location": (3.4, -2.4, 1.8), "energy": 260.0, "size": 5.0, "color": "#d9e7ff", "look_at": [0, 0, 0]},
            {"type": "AREA", "name": "Rim", "location": (-0.4, 3.4, 2.6), "energy": 520.0, "size": 2.0, "color": "#ffffff", "look_at": [0, 0, 0]},
        ],
    },
    "product": {
        "world": {"color": "#f2f2f4", "strength": 0.6},
        "lights": [
            {"type": "AREA", "name": "Top", "location": (0, 0, 4.0), "energy": 500.0, "size": 5.0, "color": "#ffffff", "look_at": [0, 0, 0]},
            {"type": "AREA", "name": "Left", "location": (-3.6, -1.4, 1.8), "energy": 320.0, "size": 3.0, "color": "#ffffff", "look_at": [0, 0, 0]},
            {"type": "AREA", "name": "Right", "location": (3.6, -1.4, 1.8), "energy": 260.0, "size": 3.0, "color": "#ffffff", "look_at": [0, 0, 0]},
        ],
    },
    "sunset": {
        "world": {"color": "#2a1c22", "strength": 0.35, "sky": {"sun_elevation": 4.0, "sun_rotation": 120.0, "dust": 3.0}},
        "lights": [
            {"type": "SUN", "name": "Sunset", "energy": 5.0, "rotation": [82, 0, 118], "color": "#ffb27a"},
        ],
    },
    "dramatic": {
        "world": {"color": "#05060a", "strength": 0.12},
        "lights": [
            {"type": "AREA", "name": "Rim", "location": (1.6, 3.0, 2.4), "energy": 1100.0, "size": 1.6, "color": "#bfd4ff", "look_at": [0, 0, 0]},
            {"type": "SPOT", "name": "Top", "location": (0, -1.2, 4.2), "energy": 1400.0, "spot_size": 40.0, "look_at": [0, 0, 0]},
        ],
    },
    "outdoor": {
        "world": {"color": "#9fc4ea", "strength": 0.9, "sky": {"sun_elevation": 35.0, "sun_rotation": 40.0}},
        "lights": [
            {"type": "SUN", "name": "Sun", "energy": 4.2, "rotation": [48, 0, 40], "color": "#fff6e6"},
        ],
    },
}


def apply_lighting(preset, scale=1.0):
    if not preset or preset == "none":
        return
    spec = LIGHTING_PRESETS.get(str(preset))
    if spec is None:
        warn("unknown lighting preset '%s'" % preset)
        return
    setup_world(spec.get("world"))
    if not any(obj.type in ("LIGHT",) for obj in scene().objects):
        coll = ensure_collection("Lighting")
        for light_spec in spec.get("lights", []):
            entry = dict(light_spec)
            if entry.get("location"):
                entry["location"] = [as_float(v) * max(0.6, min(3.0, scale / 2.0 + 0.6)) for v in entry["location"]]
            create_object({**entry, "type": entry.get("type", "AREA")}, coll, {})


CAMERA_VIEWS = {
    "three_quarter": (1.15, -1.65, 0.75),
    "front": (0.0, -2.4, 0.32),
    "back": (0.0, 2.4, 0.32),
    "side": (2.4, 0.0, 0.32),
    "top": (0.0, -0.05, 2.6),
    "hero": (0.75, -1.9, 0.42),
    "closeup": (0.6, -1.15, 0.35),
}


def place_camera(spec, coll=r"DEFAULT"):
    if isinstance(spec, str):
        spec = {"view": spec}
    if not isinstance(spec, dict):
        spec = {}
    center, radius = scene_bounds()
    view = str(spec.get("view", "three_quarter")).lower()
    direction = CAMERA_VIEWS.get(view, CAMERA_VIEWS["three_quarter"])
    lens = as_float(spec.get("lens", 50.0), 50.0)
    sensor = as_float(spec.get("sensor_width", 36.0), 36.0)
    fov = 2.0 * math.atan((sensor * 0.5) / max(lens, 12.0))
    base_distance = radius / max(0.12, math.tan(fov * 0.5)) * as_float(spec.get("margin", 1.12), 1.12)
    distance = base_distance * max(0.15, as_float(spec.get("distance", 1.0), 1.0))
    target = as_vec3(spec.get("look_at")) if spec.get("look_at") is not None else center
    if spec.get("location") is not None:
        location = as_vec3(spec.get("location"))
    else:
        unit = Vector(direction)
        try:
            unit.normalize()
        except Exception:
            unit = Vector((1.0, -1.0, 0.6)).normalized()
        location = Vector(target) + unit * distance
    cam_spec = {
        "name": spec.get("name") or "Camera",
        "type": "camera",
        "location": tuple(location),
        "lens": lens,
        "sensor_width": sensor,
        "look_at": tuple(target),
        "dof": spec.get("dof"),
        "focus_distance": spec.get("focus_distance", distance),
        "orthographic": spec.get("orthographic"),
        "ortho_scale": spec.get("ortho_scale", radius * 2.4),
    }
    coll_obj = None if coll == "DEFAULT" else ensure_collection(coll)
    obj = create_object(cam_spec, coll_obj or coll_root(), {})
    if obj is not None:
        try:
            scene().camera = obj
        except Exception:
            pass
    return obj


# ── render / export / bake ──────────────────────────────────────────────────


def available_engines():
    try:
        return [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    except Exception:
        return []


def use_engine(preference):
    pref = str(preference or "EEVEE").upper().strip()
    scene_obj = scene()
    mapping = {
        "EEVEE": ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_EEVEE_LEGACY"],
        "CYCLES": ["CYCLES"],
        "WORKBENCH": ["BLENDER_WORKBENCH"],
    }
    if pref == "CYCLES":
        try:
            bpy.ops.preferences.addon_enable(module="cycles")
        except Exception:
            pass
    for candidate in mapping.get(pref, mapping["EEVEE"]):
        try:
            scene_obj.render.engine = candidate
            return candidate
        except Exception:
            continue
    for candidate in ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES", "BLENDER_WORKBENCH"]:
        try:
            scene_obj.render.engine = candidate
            warn("engine %s unavailable, using %s" % (pref, candidate))
            return candidate
        except Exception:
            continue
    warn("no render engine could be selected")
    return scene_obj.render.engine


def apply_color_management(spec):
    vs = scene().view_settings
    look = spec.get("look")
    transform = spec.get("view_transform") or spec.get("transform")
    if transform:
        try:
            vs.view_transform = str(transform)
        except Exception:
            warn("view transform '%s' unavailable" % transform)
    if look:
        try:
            vs.look = str(look)
        except Exception:
            try:
                vs.look = "AgX - Medium High Contrast"
            except Exception:
                pass
    if spec.get("exposure") is not None:
        try:
            vs.exposure = as_float(spec.get("exposure"), 0.0)
        except Exception:
            pass
    if spec.get("gamma") is not None:
        try:
            vs.gamma = as_float(spec.get("gamma"), 1.0)
        except Exception:
            pass


def render_views(spec, out_dir):
    spec = spec or {}
    if spec.get("enabled") is False or spec.get("render") is False:
        return [], ""
    renders = []
    scene_obj = scene()
    engine = use_engine(spec.get("engine") or "EEVEE")
    apply_color_management(spec)
    width = as_int((spec.get("resolution") or [1600, 1000])[0] if isinstance(spec.get("resolution"), (list, tuple)) else spec.get("width", 1600), 1600)
    height = as_int((spec.get("resolution") or [1600, 1000])[1] if isinstance(spec.get("resolution"), (list, tuple)) else spec.get("height", 1000), 1000)
    scene_obj.render.resolution_x = max(64, min(8192, width))
    scene_obj.render.resolution_y = max(64, min(8192, height))
    scene_obj.render.resolution_percentage = as_int(spec.get("percentage", 100), 100)
    samples = as_int(spec.get("samples", 64), 64)
    try:
        scene_obj.eevee.taa_render_samples = max(1, samples)
        if hasattr(scene_obj.eevee, "use_raytracing"):
            scene_obj.eevee.use_raytracing = spec.get("raytracing", True) is not False
        if hasattr(scene_obj.eevee, "use_shadows"):
            scene_obj.eevee.use_shadows = True
        if hasattr(scene_obj.eevee, "use_gtao"):
            scene_obj.eevee.use_gtao = True
    except Exception:
        pass
    if scene_obj.render.engine == "CYCLES":
        try:
            scene_obj.cycles.samples = max(1, samples)
            scene_obj.cycles.use_denoising = spec.get("denoise", True) is not False
            if spec.get("device"):
                scene_obj.cycles.device = str(spec.get("device")).upper()
            scene_obj.cycles.max_bounces = as_int(spec.get("bounces", 8), 8)
        except Exception as exc:
            warn("cycles settings: %s" % exc)
    transparent = bool(spec.get("transparent", False))
    scene_obj.render.film_transparent = transparent
    try:
        scene_obj.render.image_settings.file_format = "PNG"
        scene_obj.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
        scene_obj.render.image_settings.color_depth = str(spec.get("color_depth", "8"))
    except Exception:
        pass
    if spec.get("transparent") is not None:
        try:
            bpy.context.preferences.filepaths.save_version = 0
        except Exception:
            pass

    names = []

    def do_render(name):
        filename = "%s.png" % name
        filepath = os.path.join(out_dir, filename)
        scene_obj.render.filepath = filepath
        try:
            bpy.ops.render.render(write_still=True)
            renders.append({"name": filename, "path": filepath})
            names.append(filename)
            return True
        except Exception as exc:
            warn("render %s failed: %s" % (name, exc))
            return False

    views = spec.get("views")
    if views:
        base_camera = scene_obj.camera
        for index, view in enumerate(views):
            camera_obj = None
            if isinstance(view, dict) and view.get("location"):
                if view.get("view") and not view.get("look_at"):
                    center, radius = scene_bounds()
                    direction = CAMERA_VIEWS.get(str(view.get("view")), CAMERA_VIEWS["three_quarter"])
                    view = {**view, "look_at": tuple(center)}
                camera_obj = place_camera({**view, "name": "CV_View_%d" % index}, "RenderCameras")
            else:
                camera_obj = place_camera(
                    {"view": view if isinstance(view, str) else view.get("view", "three_quarter")},
                    "RenderCameras",
                )
            if camera_obj is not None:
                scene_obj.camera = camera_obj
            do_render("view_%02d_%s" % (index + 1, str(view if isinstance(view, str) else view.get("name", "view"))))
        if base_camera is not None:
            scene_obj.camera = base_camera
    else:
        do_render(str(spec.get("filename", "preview")).replace(".png", ""))

    RESULT["engine"] = scene_obj.render.engine
    return renders, scene_obj.render.engine


def resolve_path(out_dir, value, default_name):
    name = str(value or default_name)
    if os.path.isabs(name):
        return name
    return os.path.join(out_dir, name)


def select_objects(names):
    try:
        bpy.ops.object.select_all(action="DESELECT")
    except Exception:
        pass
    for name in names or []:
        obj = bpy.data.objects.get(str(name))
        if obj is not None:
            try:
                obj.select_set(True)
                view_layer().objects.active = obj
            except Exception:
                pass


def export_scene(spec, out_dir):
    if not spec or spec.get("enabled") is False:
        return []
    if isinstance(spec, str):
        spec = {"format": spec}
    fmt = str(spec.get("format", "GLB")).upper()
    exports = []
    selected = list(spec.get("objects") or [])
    use_selection = bool(spec.get("selected", False) or selected)
    if selected:
        select_objects(selected)

    defaults = {"GLB": "model.glb", "GLTF": "model.gltf", "FBX": "model.fbx", "OBJ": "model.obj", "USD": "model.usdc", "STL": "model.stl", "PLY": "model.ply", "BLEND": "scene.blend"}
    filepath = resolve_path(out_dir, spec.get("filepath"), defaults.get(fmt, "model.glb"))
    os.makedirs(os.path.dirname(filepath) or out_dir, exist_ok=True)
    op = None
    kwargs = {}
    try:
        if fmt == "GLB":
            op = bpy.ops.export_scene.gltf
            kwargs = dict(filepath=filepath, export_format="GLB", use_selection=use_selection, export_apply=bool(spec.get("apply_modifiers", True)), export_yup=True)
        elif fmt == "GLTF":
            op = bpy.ops.export_scene.gltf
            kwargs = dict(filepath=filepath, export_format="GLTF_SEPARATE", use_selection=use_selection, export_apply=bool(spec.get("apply_modifiers", True)), export_yup=True)
        elif fmt == "FBX":
            op = bpy.ops.export_scene.fbx
            kwargs = dict(filepath=filepath, use_selection=use_selection, apply_scale_options="FBX_SCALE_ALL", path_mode="COPY", embed_textures=True, mesh_smooth_type="FACE")
        elif fmt == "OBJ":
            if hasattr(bpy.ops.wm, "obj_export"):
                op = bpy.ops.wm.obj_export
                kwargs = dict(filepath=filepath, export_selected_objects=use_selection, export_materials=True, apply_modifiers=bool(spec.get("apply_modifiers", True)))
            else:
                op = bpy.ops.export_scene.obj
                kwargs = dict(filepath=filepath, use_selection=use_selection, use_materials=True)
        elif fmt == "USD":
            op = bpy.ops.wm.usd_export
            kwargs = dict(filepath=filepath, selected_objects_only=use_selection)
        elif fmt == "STL":
            if hasattr(bpy.ops.wm, "stl_export"):
                op = bpy.ops.wm.stl_export
                kwargs = dict(filepath=filepath, export_selected_objects=use_selection, apply_modifiers=bool(spec.get("apply_modifiers", True)))
            else:
                op = bpy.ops.export_mesh.stl
                kwargs = dict(filepath=filepath, use_selection=use_selection)
        elif fmt == "PLY":
            if hasattr(bpy.ops.wm, "ply_export"):
                op = bpy.ops.wm.ply_export
                kwargs = dict(filepath=filepath, export_selected_objects=use_selection)
            else:
                op = bpy.ops.export_mesh.ply
                kwargs = dict(filepath=filepath, use_selection=use_selection)
        elif fmt == "BLEND":
            op = bpy.ops.wm.save_as_mainfile
            kwargs = dict(filepath=filepath)
        else:
            warn("unsupported export format '%s'" % fmt)
            return []
    except Exception as exc:
        warn("export setup failed: %s" % exc)
        return []

    try:
        op(**kwargs)
    except TypeError:
        try:
            minimal = {"filepath": filepath}
            if "use_selection" in kwargs:
                minimal["use_selection"] = use_selection
            op(**minimal)
        except Exception as exc:
            warn("export %s failed: %s" % (fmt, exc))
            return []
    except Exception as exc:
        warn("export %s failed: %s" % (fmt, exc))
        return []
    try:
        size = os.path.getsize(filepath)
    except Exception:
        size = 0
    exports.append({"format": fmt, "path": filepath, "bytes": size})
    return exports


def bake_plan(spec, out_dir):
    if not spec or spec.get("enabled") is False:
        return []
    if isinstance(spec, list):
        spec = {"objects": spec}
    objects = []
    for name in spec.get("objects") or []:
        obj = bpy.data.objects.get(str(name))
        if obj is None:
            warn("bake: object '%s' not found" % name)
            continue
        if obj.type == "MESH":
            objects.append(obj)
    if not objects:
        objects = [obj for obj in scene().objects if obj.type == "MESH"]
    if not objects:
        warn("bake: no mesh objects")
        return []
    use_engine("CYCLES")
    scene_obj = scene()
    try:
        scene_obj.cycles.samples = as_int(spec.get("samples", 8), 8)
        scene_obj.cycles.use_denoising = False
    except Exception:
        pass
    width = as_int(spec.get("width", 2048), 2048)
    height = as_int(spec.get("height", 2048), 2048)
    passes = [str(p).upper() for p in (spec.get("passes") or ["BASE_COLOR"])]
    texture_dir = resolve_path(out_dir, spec.get("dir"), "textures")
    os.makedirs(texture_dir, exist_ok=True)
    bake_type_map = {"BASE_COLOR": ("DIFFUSE", {"COLOR"}), "DIFFUSE": ("DIFFUSE", {"COLOR"}), "ROUGHNESS": ("ROUGHNESS", None), "NORMAL": ("NORMAL", None)}
    results = []
    for obj in objects:
        ensure_uv(obj)
        if not obj.data.materials:
            continue
        for slot_index, mat in enumerate(list(obj.data.materials)):
            if mat is None or not mat.use_nodes:
                continue
            for pass_name in passes:
                mapping = bake_type_map.get(pass_name)
                if mapping is None:
                    warn("bake: unsupported pass '%s'" % pass_name)
                    continue
                bake_type, pass_filter = mapping
                image_name = "%s_%s_%s" % (obj.name, mat.name, pass_name.lower())
                try:
                    image = bpy.data.images.new(image_name, width=width, height=height, alpha=True)
                    image.colorspace_settings.name = "Non-Color" if pass_name in ("ROUGHNESS", "NORMAL") else "sRGB"
                    node = mat.node_tree.nodes.new("ShaderNodeTexImage")
                    node.image = image
                    node.select = True
                    mat.node_tree.nodes.active = node
                    select_only(obj)
                    kwargs = dict(type=bake_type, use_clear=True, margin=as_int(spec.get("margin", 8), 8))
                    if pass_filter:
                        kwargs["pass_filter"] = pass_filter
                    bpy.ops.object.bake(**kwargs)
                    file_path = os.path.join(texture_dir, image_name + ".png")
                    image.filepath_raw = file_path
                    image.file_format = "PNG"
                    image.save()
                    results.append({"name": image_name, "path": file_path, "pass": pass_name})
                except Exception as exc:
                    warn("bake %s / %s failed: %s" % (obj.name, pass_name, exc))
    if spec.get("apply") and results:
        apply_baked_textures(results, objects)
    return results


def apply_baked_textures(results, objects):
    by_key = {}
    for item in results:
        by_key.setdefault((item["path"].split(os.sep)[-1]), item)
    for obj in objects:
        for mat in obj.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            nodes = mat.node_tree.nodes
            links = mat.node_tree.links
            for node in nodes:
                if node.type != "TEX_IMAGE" or node.image is None:
                    continue
                name = node.image.name.lower()
                if name.endswith("_base_color"):
                    bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
                    if bsdf is not None:
                        for link in list(bsdf.inputs["Base Color"].links):
                            links.remove(link)
                        links.new(node.outputs["Color"], bsdf.inputs["Base Color"])


# ── assets / plan execution ────────────────────────────────────────────────


def import_assets(items):
    for item in items or []:
        if not isinstance(item, dict):
            continue
        file_path = str(item.get("path") or "")
        if not file_path or not os.path.exists(file_path):
            warn("import: file not found %s" % file_path)
            continue
        fmt = str(item.get("format") or os.path.splitext(file_path)[1].lstrip(".")).lower()
        try:
            if fmt in ("glb", "gltf"):
                bpy.ops.import_scene.gltf(filepath=file_path)
            elif fmt == "fbx":
                bpy.ops.import_scene.fbx(filepath=file_path)
            elif fmt == "obj":
                if hasattr(bpy.ops.wm, "obj_import"):
                    bpy.ops.wm.obj_import(filepath=file_path)
                else:
                    bpy.ops.import_scene.obj(filepath=file_path)
            elif fmt == "stl":
                if hasattr(bpy.ops.wm, "stl_import"):
                    bpy.ops.wm.stl_import(filepath=file_path)
                else:
                    bpy.ops.import_mesh.stl(filepath=file_path)
            elif fmt == "ply":
                if hasattr(bpy.ops.wm, "ply_import"):
                    bpy.ops.wm.ply_import(filepath=file_path)
                else:
                    bpy.ops.import_mesh.ply(filepath=file_path)
            elif fmt == "usd" or fmt == "usdc" or fmt == "usdz":
                bpy.ops.wm.usd_import(filepath=file_path)
            else:
                warn("import: unsupported format %s" % fmt)
                continue
            for obj in list(bpy.context.selected_objects or []):
                if item.get("location") is not None:
                    obj.location = as_vec3(item.get("location"))
                if item.get("scale") is not None:
                    obj.scale = as_vec3(item.get("scale"), (1, 1, 1))
                if item.get("rotation") is not None:
                    obj.rotation_euler = tuple(math.radians(v) for v in as_vec3(item.get("rotation")))
        except Exception as exc:
            warn("import %s failed: %s" % (file_path, exc))


def append_assets(items):
    for item in items or []:
        if not isinstance(item, dict):
            continue
        blend_path = str(item.get("blend") or item.get("path") or "")
        if not blend_path or not os.path.exists(blend_path):
            warn("append: blend not found %s" % blend_path)
            continue
        names = item.get("objects") or item.get("names") or []
        try:
            with bpy.data.libraries.load(blend_path, link=False) as (src, dst):
                available = list(src.objects)
                wanted = available if not names or names == ["*"] else [n for n in available if n in names]
                dst.objects = wanted
            for obj in dst.objects:
                if obj is None:
                    continue
                try:
                    coll_root().objects.link(obj)
                except Exception:
                    pass
        except Exception as exc:
            warn("append %s failed: %s" % (blend_path, exc))


def run_python_snippet(code, out_dir):
    if not code:
        return
    namespace = {
        "bpy": bpy,
        "math": math,
        "os": os,
        "Vector": Vector,
        "Matrix": Matrix,
        "cv_out_dir": out_dir,
        "cv_warn": warn,
        "cv_log": log,
        "cv_progress": progress,
    }
    try:
        exec(compile(str(code), "<composevc-plan>", "exec"), namespace)
    except Exception as exc:
        warn("inline python failed: %s" % exc)
        traceback.print_exc()


def describe_scene():
    stats = {
        "objects": len(scene().objects),
        "meshes": 0,
        "polygons": 0,
        "vertices": 0,
        "materials": len(bpy.data.materials),
        "lights": 0,
        "cameras": 0,
        "collections": len(bpy.data.collections),
        "images": len(bpy.data.images),
    }
    objects = []
    for obj in scene().objects:
        entry = {"name": obj.name, "type": obj.type, "location": [round(v, 4) for v in obj.location]}
        if obj.type == "MESH":
            stats["meshes"] += 1
            try:
                stats["polygons"] += len(obj.data.polygons)
                stats["vertices"] += len(obj.data.vertices)
                entry["polygons"] = len(obj.data.polygons)
                entry["materials"] = [m.name for m in obj.data.materials if m is not None]
            except Exception:
                pass
        elif obj.type == "LIGHT":
            stats["lights"] += 1
        elif obj.type == "CAMERA":
            stats["cameras"] += 1
        objects.append(entry)
    stats["objectsDetail"] = objects
    stats["materialsDetail"] = [m.name for m in bpy.data.materials]
    return stats


def execute_plan(plan, out_dir):
    progress("prepare", 2)
    reset = plan.get("reset", True)
    source = plan.get("source") or plan.get("open_blend")
    if source:
        if not os.path.exists(str(source)):
            raise RuntimeError("source blend not found: %s" % source)
        bpy.ops.wm.open_mainfile(filepath=str(source))
    elif reset:
        bpy.ops.wm.read_factory_settings(use_empty=True)

    if plan.get("unit_scale") or plan.get("unit"):
        unit_map = {"METRIC": "METRIC", "IMPERIAL": "IMPERIAL"}
        try:
            scene().unit_settings.system = unit_map.get(str(plan.get("unit", "METRIC")).upper(), "METRIC")
            scene().unit_settings.scale_length = as_float(plan.get("unit_scale", 1.0), 1.0)
        except Exception:
            pass

    progress("materials", 10)
    materials = {}
    for spec in plan.get("materials") or []:
        if isinstance(spec, dict):
            mat = build_material(spec)
            if mat is not None:
                materials[mat.name] = mat

    progress("scene", 16)
    setup_world(plan.get("world"))
    collections = {}
    for spec in plan.get("collections") or []:
        if isinstance(spec, str):
            spec = {"name": spec}
        if isinstance(spec, dict) and spec.get("name"):
            collections[str(spec["name"])] = ensure_collection(str(spec["name"]), spec.get("parent"))

    append_assets(plan.get("append"))
    import_assets(plan.get("import"))

    objects = plan.get("objects") or []
    extra_lights = [obj for obj in (plan.get("lights") or [])]
    extra_cameras = [obj for obj in (plan.get("cameras") or [])]
    total = max(1, len(objects))
    for index, spec in enumerate(objects):
        if not isinstance(spec, dict):
            continue
        collection_name = str(spec.get("collection") or "Scene")
        coll = collections.get(collection_name) or ensure_collection(collection_name)
        create_object(spec, coll, materials)
        progress("objects", 18 + int(32 * (index + 1) / total), object=spec.get("name"))

    if plan.get("lighting"):
        center, radius = scene_bounds()
        apply_lighting(plan.get("lighting"), scale=radius * 2.0)

    lighting_coll = ensure_collection("Lighting")
    for spec in extra_lights:
        if isinstance(spec, dict):
            create_object({**spec, "type": spec.get("type", "AREA")}, lighting_coll, materials)

    camera_spec = plan.get("camera")
    if camera_spec is not None:
        if isinstance(camera_spec, dict) and camera_spec.get("type") == "camera" and camera_spec.get("location"):
            obj = create_object(camera_spec, ensure_collection("Camera"), materials)
            if obj is not None:
                try:
                    scene().camera = obj
                except Exception:
                    pass
        else:
            place_camera(camera_spec, "Camera")
    for spec in extra_cameras:
        if isinstance(spec, dict):
            obj = create_object({**spec, "type": "camera"}, ensure_collection("Camera"), materials)
            if obj is not None and spec.get("active") is not False:
                try:
                    scene().camera = obj
                except Exception:
                    pass

    progress("detail", 55)
    if plan.get("python"):
        run_python_snippet(plan.get("python"), out_dir)
    for step in plan.get("steps") or []:
        if isinstance(step, dict) and step.get("python"):
            run_python_snippet(step.get("python"), out_dir)

    bake_results = []
    if plan.get("bake"):
        progress("bake", 62)
        bake_results = bake_plan(plan.get("bake"), out_dir)

    save_spec = plan.get("save", "scene.blend")
    blend_path = ""
    if save_spec is not False and save_spec is not None:
        target = resolve_path(out_dir, save_spec if isinstance(save_spec, str) else "scene.blend", "scene.blend")
        if not target.lower().endswith(".blend"):
            target += ".blend"
        try:
            os.makedirs(os.path.dirname(target) or out_dir, exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=target)
            blend_path = target
        except Exception as exc:
            warn("save blend failed: %s" % exc)

    render_result = ([], "")
    if plan.get("render"):
        progress("render", 70)
        render_result = render_views(plan.get("render"), out_dir)

    exports = []
    export_specs = plan.get("export")
    if export_specs:
        if isinstance(export_specs, (str, dict)):
            export_specs = [export_specs]
        progress("export", 92)
        for spec in export_specs:
            exports.extend(export_scene(spec, out_dir))

    # Save again after render/export so the .blend keeps the final render
    # settings and baked texture nodes the job actually used.
    if blend_path:
        try:
            bpy.ops.wm.save_as_mainfile(filepath=blend_path)
        except Exception as exc:
            warn("final blend save failed: %s" % exc)

    stats = describe_scene()
    progress("done", 100)
    return {
        "blendPath": blend_path,
        "renders": render_result[0],
        "engine": render_result[1],
        "exports": exports,
        "bakes": bake_results,
        "stats": stats,
    }


def probe(out_dir):
    engines = available_engines()
    operators = {}
    for group, name in [
        ("export_scene", "gltf"),
        ("export_scene", "fbx"),
        ("wm", "obj_export"),
        ("wm", "stl_export"),
        ("wm", "usd_export"),
        ("wm", "save_as_mainfile"),
    ]:
        try:
            operators["%s.%s" % (group, name)] = hasattr(getattr(bpy.ops, group), name)
        except Exception:
            operators["%s.%s" % (group, name)] = False
    result = {
        "ok": True,
        "blenderVersion": bpy.app.version_string,
        "engines": engines,
        "operators": operators,
        "addons": sorted(list(bpy.context.preferences.addons.keys())),
    }
    RESULT.update(result)
    RESULT["warningsCount"] = len(WARNINGS)
    return result


def main():
    global OUT_DIR
    argv = sys.argv
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    plan_path = ""
    probe_mode = False
    out_dir = ""
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--plan" and index + 1 < len(args):
            plan_path = args[index + 1]
            index += 2
            continue
        if token == "--out" and index + 1 < len(args):
            out_dir = args[index + 1]
            index += 2
            continue
        if token == "--probe":
            probe_mode = True
        index += 1
    OUT_DIR = out_dir or os.path.dirname(plan_path) or os.getcwd()
    os.makedirs(OUT_DIR, exist_ok=True)
    RESULT["outDir"] = OUT_DIR
    RESULT["startedAt"] = int(STARTED * 1000)

    if probe_mode:
        probe(OUT_DIR)
        RESULT["finishedAt"] = int(time.time() * 1000)
        RESULT["durationMs"] = int((time.time() - STARTED) * 1000)
        write_result()
        return

    if not plan_path or not os.path.exists(plan_path):
        RESULT["error"] = "plan file not found: %s" % plan_path
        write_result()
        sys.exit(3)
    try:
        with open(plan_path, "r", encoding="utf-8") as handle:
            plan = json.load(handle)
    except Exception as exc:
        RESULT["error"] = "cannot read plan: %s" % exc
        write_result()
        sys.exit(3)

    RESULT["blenderVersion"] = bpy.app.version_string
    try:
        outcome = execute_plan(plan, OUT_DIR)
        RESULT.update(outcome)
        RESULT["ok"] = True
        RESULT["artifacts"] = [item["path"] for item in (outcome.get("renders") or [])] + [
            item["path"] for item in (outcome.get("exports") or [])
        ]
        if outcome.get("blendPath"):
            RESULT["artifacts"].append(outcome["blendPath"])
    except Exception as exc:
        RESULT["ok"] = False
        RESULT["error"] = "%s: %s" % (exc.__class__.__name__, exc)
        traceback.print_exc()
        try:
            RESULT["stats"] = describe_scene()
        except Exception:
            RESULT["stats"] = {}
    RESULT["warningsCount"] = len(WARNINGS)
    RESULT["finishedAt"] = int(time.time() * 1000)
    RESULT["durationMs"] = int((time.time() - STARTED) * 1000)
    write_result()
    if not RESULT["ok"]:
        sys.exit(3)


def write_result():
    try:
        target = os.path.join(OUT_DIR, "result.json")
        with open(target, "w", encoding="utf-8") as handle:
            json.dump(RESULT, handle, indent=2, ensure_ascii=False)
    except Exception as exc:
        print("[cv:warn] cannot write result.json: %s" % exc, flush=True)
    try:
        print("CVRESULT " + json.dumps({"ok": RESULT.get("ok"), "error": RESULT.get("error", ""), "renders": len(RESULT.get("renders") or []), "exports": len(RESULT.get("exports") or [])}), flush=True)
    except Exception:
        pass


if __name__ == "__main__":
    main()
