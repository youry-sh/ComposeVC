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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import characters as cv_characters
except Exception as _cv_char_err:  # pragma: no cover - keeps the driver usable alone
    cv_characters = None
    print("[cv:warn] character toolkit unavailable: %s" % _cv_char_err, flush=True)

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


def _srgb_to_linear(channel):
    value = max(0.0, min(1.0, as_float(channel, 0.0)))
    if value <= 0.04045:
        return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4


def as_color(value, fallback=(0.8, 0.8, 0.8), alpha=None, linear=True):
    """Accepts [r,g,b(,a)] in 0..1 or 0..255, or '#rrggbb'.

    Values are authored as sRGB (hex / 0-255 / picker style) and Blender colour
    sockets are linear, so the result is converted unless linear=False.
    """
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
    if linear:
        result = (_srgb_to_linear(result[0]), _srgb_to_linear(result[1]), _srgb_to_linear(result[2]), result[3])
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


MATERIAL_PRESETS = {
    "steel": {
        "base_color": "#8f98a3",
        "metallic": 1.0,
        "roughness": 0.3,
        "texture": {
            "type": "noise",
            "scale": 26,
            "detail": 5,
            "color_a": "#6d7681",
            "color_b": "#bcc5cf",
            "bump": 0.05,
            "roughness_map": True,
            "roughness_min": 0.18,
            "roughness_max": 0.42,
        },
    },
    "brushed_metal": {
        "base_color": "#a9afb7",
        "metallic": 1.0,
        "roughness": 0.34,
        "texture": {
            "type": "wave",
            "scale": 90,
            "distortion": 1.2,
            "direction": "X",
            "color_a": "#878e97",
            "color_b": "#d2d8df",
            "bump": 0.04,
            "roughness_map": True,
            "roughness_min": 0.22,
            "roughness_max": 0.5,
        },
    },
    "gold": {
        "base_color": "#d8a63f",
        "metallic": 1.0,
        "roughness": 0.22,
        "texture": {
            "type": "noise",
            "scale": 42,
            "detail": 3,
            "color_a": "#b07f24",
            "color_b": "#f3d585",
            "bump": 0.025,
        },
    },
    "copper": {
        "base_color": "#c47a4a",
        "metallic": 1.0,
        "roughness": 0.3,
        "texture": {
            "type": "noise",
            "scale": 30,
            "detail": 5,
            "color_a": "#8d4c2b",
            "color_b": "#e0a173",
            "bump": 0.04,
            "roughness_map": True,
        },
    },
    "wood": {
        "base_color": "#8b5a33",
        "metallic": 0.0,
        "roughness": 0.55,
        "texture": {
            "type": "wave",
            "scale": 6,
            "distortion": 7,
            "detail": 3,
            "direction": "Z",
            "color_a": "#46280f",
            "color_b": "#c08b52",
            "bump": 0.16,
            "roughness_map": True,
            "roughness_min": 0.4,
            "roughness_max": 0.78,
        },
    },
    "oak": {
        "base_color": "#b98a56",
        "metallic": 0.0,
        "roughness": 0.5,
        "texture": {
            "type": "wave",
            "scale": 5,
            "distortion": 5,
            "detail": 3,
            "direction": "Z",
            "color_a": "#7c5027",
            "color_b": "#e2c191",
            "bump": 0.12,
        },
    },
    "stone": {
        "base_color": "#8d8d8a",
        "metallic": 0.0,
        "roughness": 0.72,
        "texture": {
            "type": "voronoi",
            "scale": 7,
            "randomness": 1.0,
            "color_a": "#5f605e",
            "color_b": "#b4b3ad",
            "bump": 0.28,
            "roughness_map": True,
            "roughness_min": 0.55,
            "roughness_max": 0.9,
        },
    },
    "concrete": {
        "base_color": "#9c9c98",
        "roughness": 0.8,
        "texture": {
            "type": "noise",
            "scale": 14,
            "detail": 12,
            "color_a": "#73736f",
            "color_b": "#b9b8b2",
            "bump": 0.12,
            "roughness_map": True,
            "roughness_min": 0.6,
            "roughness_max": 0.95,
        },
    },
    "brick": {
        "base_color": "#8d5b45",
        "roughness": 0.78,
        "texture": {
            "type": "brick",
            "scale": 5,
            "color_a": "#7c4533",
            "color_b": "#a4694f",
            "mortar": "#cfc7b6",
            "mortar_size": 0.025,
            "bump": 0.35,
        },
    },
    "fabric": {
        "base_color": "#5c6470",
        "roughness": 0.85,
        "sheen": 0.5,
        "texture": {
            "type": "noise",
            "scale": 120,
            "detail": 8,
            "color_a": "#464d57",
            "color_b": "#79828f",
            "bump": 0.08,
        },
    },
    "leather": {
        "base_color": "#5b3a25",
        "roughness": 0.58,
        "texture": {
            "type": "voronoi",
            "scale": 55,
            "randomness": 0.6,
            "color_a": "#3f2718",
            "color_b": "#7e5336",
            "bump": 0.14,
            "roughness_map": True,
            "roughness_min": 0.45,
            "roughness_max": 0.7,
        },
    },
    "rubber": {
        "base_color": "#232426",
        "roughness": 0.92,
        "texture": {
            "type": "noise",
            "scale": 90,
            "detail": 4,
            "color_a": "#1b1c1e",
            "color_b": "#303236",
            "bump": 0.06,
        },
    },
    "plastic": {
        "base_color": "#c9ced6",
        "roughness": 0.35,
        "coat": 0.25,
        "texture": {
            "type": "noise",
            "scale": 70,
            "detail": 2,
            "color_a": "#b9bec6",
            "color_b": "#e2e7ee",
            "bump": 0.02,
        },
    },
    "ceramic": {
        "base_color": "#e6e1d6",
        "roughness": 0.22,
        "coat": 0.45,
        "texture": {
            "type": "noise",
            "scale": 24,
            "detail": 6,
            "color_a": "#d8d2c5",
            "color_b": "#f5f2ea",
            "bump": 0.02,
        },
    },
    "glass": {
        "base_color": "#bcd8e0",
        "roughness": 0.06,
        "transmission": 0.92,
        "ior": 1.45,
        "coat": 0.35,
        "texture": {
            "type": "noise",
            "scale": 42,
            "detail": 2,
            "color_a": "#a8c9d6",
            "color_b": "#e6f7ff",
            "bump": 0.008,
            "roughness_map": True,
            "roughness_min": 0.03,
            "roughness_max": 0.12,
        },
    },
    "emissive": {
        "base_color": "#3a0f12",
        "emission": "#ff5a2b",
        "emission_strength": 8.0,
        "roughness": 0.35,
        "texture": {
            "type": "noise",
            "scale": 18,
            "detail": 4,
            "color_a": "#24070a",
            "color_b": "#7a1f12",
            "bump": 0.05,
            "roughness_map": True,
            "roughness_min": 0.25,
            "roughness_max": 0.5,
        },
    },
    "hologram": {
        "base_color": "#1fd0ff",
        "emission": "#2fe4ff",
        "emission_strength": 3.0,
        "alpha": 0.42,
        "roughness": 0.15,
        "texture": {
            "type": "wave",
            "scale": 30,
            "distortion": 2.0,
            "direction": "Z",
            "color_a": "#0b6b86",
            "color_b": "#9bf3ff",
            "bump": 0.05,
        },
    },
    "skin": {
        "base_color": "#c58f74",
        "roughness": 0.52,
        "subsurface": 0.18,
        "texture": {
            "type": "noise",
            "scale": 45,
            "detail": 6,
            "color_a": "#a9715a",
            "color_b": "#e0b096",
            "bump": 0.03,
        },
    },
    "skin_sss": {
        "base_color": "#c98d72",
        "roughness": 0.42,
        "specular": 0.38,
        "subsurface": 0.45,
        "subsurface_radius": [1.0, 0.32, 0.18],
        "subsurface_scale": 0.011,
        "sheen": 0.25,
        "sheen_roughness": 0.34,
        "coat": 0.04,
        "coat_roughness": 0.28,
        "texture": {
            "type": "noise",
            "scale": 220,
            "detail": 10,
            "roughness": 0.55,
            "color_a": "#c1856a",
            "color_b": "#d09478",
            "bump": 0.055,
            "bump_distance": 0.0006,
            "roughness_map": True,
            "roughness_min": 0.32,
            "roughness_max": 0.58,
        },
        "bump_layers": [
            {"type": "voronoi", "scale": 640, "randomness": 0.85, "feature": "F1", "bump": 0.14, "bump_distance": 0.00025},
            {"type": "noise", "scale": 2200, "detail": 8, "roughness": 0.6, "bump": 0.1, "bump_distance": 0.00008},
        ],
    },
    "clay": {
        "base_color": "#b9b2a8",
        "roughness": 0.62,
        "specular": 0.32,
        "coat": 0.06,
        "texture": {
            "type": "noise",
            "scale": 120,
            "detail": 8,
            "color_a": "#b9b2a8",
            "color_b": "#b9b2a8",
            "bump": 0.12,
            "bump_distance": 0.0015,
        },
    },
    "hair": {
        "base_color": "#3a2418",
        "roughness": 0.32,
        "specular": 0.5,
        "anisotropic": 0.65,
        "sheen": 0.45,
        "sheen_roughness": 0.3,
        "coat": 0.12,
        "texture": {
            "type": "wave",
            "scale": 90,
            "distortion": 6,
            "direction": "Z",
            "color_a": "#241309",
            "color_b": "#4b2e1c",
            "bump": 0.22,
            "bump_distance": 0.001,
        },
    },
    "silk": {
        "base_color": "#d8cbe4",
        "roughness": 0.26,
        "specular": 0.55,
        "sheen": 0.6,
        "sheen_roughness": 0.25,
        "subsurface": 0.06,
        "texture": {
            "type": "noise",
            "scale": 260,
            "detail": 8,
            "color_a": "#c3b4d4",
            "color_b": "#ece2f4",
            "bump": 0.06,
            "bump_distance": 0.0008,
        },
    },
    "lace": {
        "base_color": "#efe9df",
        "roughness": 0.48,
        "specular": 0.4,
        "sheen": 0.3,
        "texture": {
            "type": "voronoi",
            "scale": 220,
            "randomness": 0.9,
            "color_a": "#c9c1b3",
            "color_b": "#fdfaf4",
            "bump": 0.25,
            "bump_distance": 0.001,
        },
    },
    "sci_fi_panel": {
        "base_color": "#3b424c",
        "metallic": 0.85,
        "roughness": 0.32,
        "texture": {
            "type": "magic",
            "scale": 9,
            "distortion": 0.5,
            "color_a": "#252a32",
            "color_b": "#59636f",
            "bump": 0.05,
            "roughness_map": True,
            "roughness_min": 0.2,
            "roughness_max": 0.5,
        },
    },
    "rust": {
        "base_color": "#7a4a2e",
        "metallic": 0.45,
        "roughness": 0.85,
        "texture": {
            "type": "noise",
            "scale": 18,
            "detail": 12,
            "color_a": "#4d2c19",
            "color_b": "#b06a3c",
            "bump": 0.3,
            "roughness_map": True,
            "roughness_min": 0.6,
            "roughness_max": 0.95,
        },
    },
    "marble": {
        "base_color": "#e8e6e2",
        "roughness": 0.18,
        "coat": 0.2,
        "texture": {
            "type": "wave",
            "scale": 4,
            "distortion": 14,
            "detail": 4,
            "direction": "Z",
            "color_a": "#b9b7b2",
            "color_b": "#f4f3f0",
            "bump": 0.02,
        },
    },
    "dirt": {
        "base_color": "#6b5334",
        "roughness": 0.9,
        "texture": {
            "type": "noise",
            "scale": 16,
            "detail": 14,
            "color_a": "#463420",
            "color_b": "#9a7c52",
            "bump": 0.2,
        },
    },
}


def apply_material_preset(spec):
    preset_name = spec.get("preset") or spec.get("style")
    if not preset_name or not isinstance(preset_name, str):
        return spec
    preset = MATERIAL_PRESETS.get(preset_name.lower())
    if preset is None:
        warn("unknown material preset '%s'" % preset_name)
        return spec
    merged = dict(preset)
    for key, value in spec.items():
        if key == "texture" and isinstance(value, dict) and isinstance(merged.get("texture"), dict):
            merged["texture"] = {**merged["texture"], **value}
        else:
            merged[key] = value
    merged["name"] = spec.get("name") or spec.get("id") or preset_name.title()
    return merged


def apply_material_animation(mat, bsdf, anim):
    if not isinstance(anim, dict) or not anim:
        return
    socket_names = {"emission_strength": ("Emission Strength",), "emission": ("Emission Color",)}
    for key, keys in anim.items():
        names = socket_names.get(key)
        if not names or not isinstance(keys, list):
            continue
        socket = None
        for name in names:
            socket = bsdf.inputs.get(name)
            if socket is not None:
                break
        if socket is None:
            warn("material animation: socket %s missing" % key)
            continue
        try:
            index = list(bsdf.inputs).index(socket)
        except Exception:
            index = None
        if index is None:
            continue
        data_path = 'nodes["%s"].inputs[%d].default_value' % (bsdf.name, index)
        for entry in keys:
            if not isinstance(entry, dict):
                continue
            frame = as_int(entry.get("frame", 1), 1)
            value = entry.get("value")
            try:
                if key == "emission":
                    socket.default_value = as_color(value)
                else:
                    socket.default_value = as_float(value, 1.0)
                mat.node_tree.keyframe_insert(data_path=data_path, frame=frame)
            except Exception as exc:
                warn("material animation key failed: %s" % exc)
                break


def build_material(spec):
    if not isinstance(spec, dict):
        return None
    spec = apply_material_preset(dict(spec))
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
    set_input(bsdf, as_float(spec.get("sheen_roughness", 0.5), 0.5), "Sheen Roughness")
    if spec.get("sheen_tint") is not None:
        set_input(bsdf, as_color(spec.get("sheen_tint"), (1.0, 1.0, 1.0)), "Sheen Tint")
    set_input(bsdf, as_float(spec.get("subsurface", 0.0)), "Subsurface Weight", "Subsurface")
    if spec.get("subsurface_scale") is not None:
        set_input(bsdf, as_float(spec.get("subsurface_scale"), 0.05), "Subsurface Scale")
    if spec.get("subsurface_radius"):
        set_input(bsdf, as_vec3(spec.get("subsurface_radius"), (1.0, 0.2, 0.1)), "Subsurface Radius")
    set_input(bsdf, as_float(spec.get("anisotropic", 0.0)), "Anisotropic")
    set_input(bsdf, as_float(spec.get("anisotropic_rotation", 0.0), 0.0), "Anisotropic Rotation")

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
    last_bump = None
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
                last_bump = bump

    # Micro-detail stack (skin pores, fabric weave, hair strands): each layer is
    # chained into the previous bump so the normals add up instead of replacing.
    bump_layers = spec.get("bump_layers") or spec.get("micro_bump")
    if isinstance(bump_layers, dict):
        bump_layers = [bump_layers]
    for index, layer in enumerate(bump_layers if isinstance(bump_layers, list) else []):
        if not isinstance(layer, dict):
            continue
        layer_spec = dict(layer)
        layer_spec.setdefault("type", "noise")
        layer_factor, _layer_color = _procedural_nodes(nodes, links, layer_spec, (-620, -900 - index * 220))
        if layer_factor is None:
            continue
        bump = nodes.new("ShaderNodeBump")
        bump.location = (-320, -900 - index * 220)
        set_input(bump, as_float(layer.get("bump", layer.get("strength", 0.25)), 0.25), "Strength")
        set_input(bump, as_float(layer.get("bump_distance", 0.002), 0.002), "Distance")
        links.new(layer_factor, bump.inputs["Height"])
        if last_bump is not None and "Normal" in bump.inputs:
            links.new(last_bump.outputs["Normal"], bump.inputs["Normal"])
        last_bump = bump
    if last_bump is not None:
        links.new(last_bump.outputs["Normal"], bsdf.inputs["Normal"])

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

    for key, names, lo_key, hi_key in (
        ("roughness_texture", ("Roughness",), "roughness_min", "roughness_max"),
        ("metallic_texture", ("Metallic",), "metallic_min", "metallic_max"),
    ):
        map_spec = spec.get(key)
        if isinstance(map_spec, str):
            map_spec = {"path": map_spec}
        if not isinstance(map_spec, dict) or not (map_spec.get("path") or map_spec.get("file")):
            continue
        map_node = _image_node(nodes, links, {**map_spec, "type": "image"}, (-420, -680))
        if map_node is None:
            continue
        try:
            map_node.image.colorspace_settings.name = "Non-Color"
        except Exception:
            pass
        target = None
        for socket_name in names:
            target = bsdf.inputs.get(socket_name)
            if target is not None:
                break
        if target is None:
            continue
        source = map_node.outputs["Color"]
        low = map_spec.get(lo_key)
        high = map_spec.get(hi_key)
        if low is not None or high is not None:
            mapper = nodes.new("ShaderNodeMapRange")
            mapper.location = (-180, -680)
            set_input(mapper, 0.0, "From Min")
            set_input(mapper, 1.0, "From Max")
            set_input(mapper, as_float(low, 0.0), "To Min")
            set_input(mapper, as_float(high, 1.0), "To Max")
            links.new(source, mapper.inputs["Value"])
            source = mapper.outputs["Result"]
        links.new(source, target)

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
    apply_material_animation(mat, bsdf, spec.get("animation"))
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
    animate_object(obj, spec)
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


# ── animation / rigging ────────────────────────────────────────────────────


def action_fcurves(action):
    """Blender 4.4+ actions are layered; older versions expose .fcurves directly."""
    curves = []
    try:
        for layer in getattr(action, "layers", []) or []:
            for strip in getattr(layer, "strips", []) or []:
                for bag in getattr(strip, "channelbags", []) or []:
                    curves.extend(list(getattr(bag, "fcurves", []) or []))
    except Exception:
        curves = []
    if not curves:
        curves = list(getattr(action, "fcurves", []) or [])
    return curves


def animate_object(obj, spec):
    anim = spec.get("animation")
    if not isinstance(anim, dict) or not anim:
        return
    interpolation = str(anim.get("interpolation", "BEZIER")).upper()
    channels = (("location", "location"), ("rotation", "rotation_euler"), ("scale", "scale"))
    for channel, data_path in channels:
        keys = anim.get(channel)
        if not isinstance(keys, list) or not keys:
            continue
        for entry in keys:
            if not isinstance(entry, dict):
                continue
            frame = as_int(entry.get("frame", 1), 1)
            value = entry.get("value", entry.get("to"))
            try:
                if channel == "rotation":
                    obj.rotation_euler = tuple(math.radians(v) for v in as_vec3(value))
                elif channel == "scale":
                    scale = as_vec3(value, (1, 1, 1))
                    obj.scale = scale if scale != (0.0, 0.0, 0.0) else (1.0, 1.0, 1.0)
                else:
                    obj.location = as_vec3(value)
                obj.keyframe_insert(data_path=data_path, frame=frame)
            except Exception as exc:
                warn("animation %s on %s failed: %s" % (channel, obj.name, exc))
                break
    try:
        action = obj.animation_data.action if obj.animation_data else None
        if action is not None:
            for curve in action_fcurves(action):
                for point in curve.keyframe_points:
                    point.interpolation = interpolation
    except Exception:
        pass


def create_armature(spec, coll):
    if not isinstance(spec, dict):
        return None
    name = str(spec.get("name") or "Armature")
    data = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, data)
    coll.objects.link(obj)
    select_only(obj)
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        created = {}
        for bone_spec in spec.get("bones") or []:
            if not isinstance(bone_spec, dict):
                continue
            bone_name = str(bone_spec.get("name") or ("Bone%d" % (len(created) + 1)))
            edit_bone = data.edit_bones.new(bone_name)
            edit_bone.head = as_vec3(bone_spec.get("head", (0, 0, 0)))
            edit_bone.tail = as_vec3(bone_spec.get("tail", (0, 0, 0.4)))
            parent_name = bone_spec.get("parent")
            if parent_name and parent_name in data.edit_bones:
                edit_bone.parent = data.edit_bones[parent_name]
                edit_bone.use_connect = bool(bone_spec.get("connect", False))
            created[bone_name] = edit_bone
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception as exc:
        warn("armature '%s' failed: %s" % (name, exc))
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except Exception:
            pass
    _apply_common_transform(obj, spec)
    mesh_name = spec.get("mesh") or spec.get("parent_mesh") or spec.get("bind")
    if mesh_name and spec.get("bind") is not False:
        mesh_obj = bpy.data.objects.get(str(mesh_name))
        if mesh_obj is None:
            warn("armature bind: mesh '%s' not found" % mesh_name)
        else:
            select_only(mesh_obj)
            try:
                mesh_obj.select_set(True)
                obj.select_set(True)
                view_layer().objects.active = obj
                bpy.ops.object.parent_set(type="ARMATURE_AUTO")
            except Exception as exc:
                warn("armature auto weights failed: %s" % exc)
    animate_object(obj, spec)
    return obj


# ── Blender add-ons / extensions ────────────────────────────────────────────


def _zip_addon_info(path):
    """Returns (legacy_module_candidates, extension_id) for an add-on zip."""
    import re
    import zipfile

    modules = []
    extension_id = ""
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            manifest_entry = next(
                (name for name in names if name == "blender_manifest.toml" or name.endswith("/blender_manifest.toml")),
                "",
            )
            if manifest_entry:
                text = archive.read(manifest_entry).decode("utf-8", "replace")
                match = re.search(r'^\s*id\s*=\s*"([^"]+)"', text, re.MULTILINE)
                if match:
                    extension_id = match.group(1)
            for name in names:
                if name.endswith("/__init__.py"):
                    modules.append(name.split("/")[0])
                elif name.endswith(".py") and "/" not in name:
                    modules.append(name[:-3])
    except Exception as exc:
        warn("cannot read add-on zip %s: %s" % (path, exc))
    unique = []
    for module in modules:
        if module and module not in unique:
            unique.append(module)
    return unique, extension_id


def addon_installed(module):
    try:
        import addon_utils

        for entry in addon_utils.modules(refresh=True):
            if getattr(entry, "__name__", "") == module:
                return True
        loaded, enabled = addon_utils.check(module)
        return bool(loaded or enabled)
    except Exception:
        return False


def enable_addon_module(module):
    """Enable an add-on the way Blender itself does it.

    `default_set=True` + `persistent=True` matters: add-ons with services/UI
    registration (MPFB, Rigify helpers, etc.) raise errors when enabled in
    transient mode, and the enabled state otherwise disappears on reload.
    """
    import importlib

    import addon_utils

    candidates = [module]
    if not module.startswith("bl_ext."):
        candidates.append("bl_ext.user_default." + module)
        candidates.append("bl_ext.blender_org." + module)
    last_error = ""
    for candidate in candidates:
        try:
            addon_utils.enable(candidate, default_set=True, persistent=True)
        except Exception as exc:
            last_error = str(exc)
            try:
                bpy.ops.preferences.addon_enable(module=candidate)
            except Exception as exc2:
                last_error = str(exc2)
                continue
        try:
            loaded, enabled = addon_utils.check(candidate)
        except Exception:
            loaded, enabled = (False, False)
        if not enabled:
            last_error = last_error or ("add-on did not report enabled: %s" % candidate)
            continue
        try:
            importlib.import_module(candidate)
        except Exception as exc:
            # Some add-ons only register operators (no importable side effects);
            # keep them enabled and surface the import error to the caller.
            return candidate, "enabled but import failed: %s" % exc
        return candidate, ""
    return "", last_error


def disable_addon_module(module):
    try:
        import addon_utils

        addon_utils.disable(module, default_set=True)
        try:
            _loaded, enabled = addon_utils.check(module)
        except Exception:
            enabled = False
        if enabled:
            bpy.ops.preferences.addon_disable(module=module)
            _loaded, enabled = addon_utils.check(module)
        return not enabled, ""
    except Exception as exc:
        return False, str(exc)


def try_install_extension_module(module):
    """Best-effort install for a missing `bl_ext.user_default.<pkg>` entry."""
    if not module.startswith("bl_ext."):
        return False, "not an extension module"
    package_id = module.split(".")[-1]
    if not package_id:
        return False, "empty package id"
    try:
        bpy.ops.extensions.userpref_allow_online()
    except Exception:
        pass
    attempts = [
        {"pkg_id": package_id, "enable_on_install": True},
        {"pkg_id": package_id, "repo": "user_default", "enable_on_install": True},
    ]
    last_error = ""
    for kwargs in attempts:
        try:
            bpy.ops.extensions.package_install(**kwargs)
            return True, ""
        except Exception as exc:
            last_error = str(exc)
    return False, last_error



def install_addon(path, enable=True):
    report = {"path": path, "kind": "addon", "installed": False, "modules": [], "errors": []}
    if not path or not os.path.exists(path):
        report["errors"].append("file not found")
        return report
    modules, extension_id = _zip_addon_info(path)
    if extension_id:
        report["kind"] = "extension"
        installed = False
        for repo in ("user_default", "DEFAULT", None):
            try:
                kwargs = {"filepath": path, "enable_on_install": bool(enable), "overwrite": True}
                if repo is not None:
                    kwargs["repo"] = repo
                bpy.ops.extensions.package_install_files(**kwargs)
                installed = True
                break
            except Exception as exc:
                report["errors"].append("%s: %s" % (repo or "auto", exc))
        if not installed:
            # Some packages are legacy add-ons shipped with a manifest; fall back
            # to the classic installer instead of failing the job.
            try:
                bpy.ops.preferences.addon_install(filepath=path, overwrite=True)
                installed = True
                report["kind"] = "addon"
                report["errors"].append("extension installer failed, installed as a legacy add-on")
            except Exception as exc:
                report["errors"].append(str(exc))
        if installed and enable:
            candidates = ["bl_ext.user_default." + extension_id] + modules
            for candidate in candidates:
                module, error = enable_addon_module(candidate)
                if module:
                    report["modules"].append(module)
                    break
                if error:
                    report["errors"].append("%s: %s" % (candidate, error))
        report["installed"] = installed
        return report
    try:
        bpy.ops.preferences.addon_install(filepath=path, overwrite=True)
        report["installed"] = True
    except Exception as exc:
        report["errors"].append(str(exc))
    if enable:
        for module in modules:
            enabled, error = enable_addon_module(module)
            if enabled:
                report["modules"].append(enabled)
            elif error:
                report["errors"].append("%s: %s" % (module, error))
    return report


def setup_addons(plan):
    reports = []
    for module in plan.get("disable_addons") or []:
        ok, error = disable_addon_module(str(module))
        reports.append({"module": str(module), "disabled": ok, "error": error})
    entries = list(plan.get("install_addons") or [])
    entries.extend(plan.get("addons") or [])
    for entry in entries:
        if isinstance(entry, str):
            entry = {"module": entry}
        if not isinstance(entry, dict):
            continue
        if entry.get("error"):
            reports.append({"kind": "addon", "error": str(entry.get("error")), "installed": False})
            continue
        if entry.get("url") and not entry.get("path"):
            reports.append({"kind": "addon", "error": "archive was not downloaded: %s" % entry.get("url"), "installed": False})
            continue
        if entry.get("path") or entry.get("file"):
            reports.append(install_addon(str(entry.get("path") or entry.get("file")), entry.get("enable", True)))
            continue
        module = str(entry.get("module") or entry.get("name") or "")
        if not module:
            continue
        if entry.get("enable") is False:
            ok, error = disable_addon_module(module)
            reports.append({"module": module, "disabled": ok, "error": error})
            continue
        enabled, error = enable_addon_module(module)
        installed = bool(enabled) or addon_installed(module)
        if not enabled and module.startswith("bl_ext."):
            # Configured extension is missing/disabled — try to install it from
            # the configured extensions repository, then enable again.
            install_ok, install_error = try_install_extension_module(module)
            if install_ok:
                enabled, error = enable_addon_module(module)
                installed = bool(enabled) or addon_installed(module)
            elif install_error:
                error = (error + " | install: " + install_error).strip(" |")
        reports.append(
            {
                "module": enabled or module,
                "enabled": bool(enabled),
                "installed": bool(installed),
                "error": error,
            }
        )
    return reports


# ── optimization / quality audit ────────────────────────────────────────────


def optimize_meshes(plan):
    config = plan.get("optimize")
    if not config:
        return []
    if not isinstance(config, dict):
        config = {}
    merged = {"apply_scale": True, "merge_distance": 0.0, "triangulate": False, "origin": ""}
    merged.update(config)
    touched = []
    for obj in [item for item in scene().objects if item.type == "MESH"]:
        if merged.get("apply_scale") and obj.animation_data is None:
            try:
                select_only(obj)
                bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            except Exception as exc:
                warn("apply scale on %s failed: %s" % (obj.name, exc))
        if merged.get("merge_distance"):
            try:
                mod = obj.modifiers.new(name="CV_Weld", type="WELD")
                mod.merge_threshold = as_float(merged.get("merge_distance"), 0.0001)
                select_only(obj)
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception as exc:
                warn("weld on %s failed: %s" % (obj.name, exc))
        if merged.get("triangulate"):
            try:
                mod = obj.modifiers.new(name="CV_Triangulate", type="TRIANGULATE")
                select_only(obj)
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception as exc:
                warn("triangulate on %s failed: %s" % (obj.name, exc))
        origin = str(merged.get("origin") or "").lower()
        if origin in ("center_floor", "floor", "base", "bottom"):
            try:
                bpy.context.view_layer.update()
                corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
                xs = [corner.x for corner in corners]
                ys = [corner.y for corner in corners]
                zs = [corner.z for corner in corners]
                scene().cursor.location = ((min(xs) + max(xs)) * 0.5, (min(ys) + max(ys)) * 0.5, min(zs))
                select_only(obj)
                bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
            except Exception as exc:
                warn("origin on %s failed: %s" % (obj.name, exc))
        touched.append(obj.name)
    return touched


PROCEDURAL_NODE_TYPES = {
    "TEX_NOISE",
    "TEX_VORONOI",
    "TEX_WAVE",
    "TEX_CHECKER",
    "TEX_BRICK",
    "TEX_GRADIENT",
    "TEX_MAGIC",
    "TEX_MUSGRAVE",
    "TEX_SKY",
}


def _material_has_texture(mat):
    if mat is None or not mat.use_nodes:
        return False
    for node in mat.node_tree.nodes:
        if node.type == "TEX_IMAGE" and getattr(node, "image", None) is not None:
            return True
        if node.type in PROCEDURAL_NODE_TYPES:
            return True
    return False


def _mesh_non_manifold(mesh):
    try:
        import bmesh

        bm = bmesh.new()
        bm.from_mesh(mesh)
        count = sum(1 for edge in bm.edges if not edge.is_manifold)
        bm.free()
        return count
    except Exception:
        return -1


def _mesh_triangles(mesh):
    try:
        mesh.calc_loop_triangles()
        return len(mesh.loop_triangles)
    except Exception:
        return sum(max(0, len(poly.vertices) - 2) for poly in mesh.polygons)


def quality_report(plan):
    config = plan.get("quality") if isinstance(plan.get("quality"), dict) else {}
    config = dict(config)
    if "require_textures" not in config:
        exports = plan.get("export")
        if isinstance(exports, (str, dict)):
            exports = [exports]
        presets = [
            str(spec.get("preset", "")).lower()
            for spec in (exports or [])
            if isinstance(spec, dict)
        ]
        if any(preset in ("unity", "unreal", "godot", "web") for preset in presets):
            config["require_textures"] = True
    require_textures = bool(config.get("require_textures", False))
    require_uv = config.get("require_uv", True) is not False
    require_scale = config.get("require_applied_scale", False) is not False
    max_polygons = as_int(config.get("max_polygons", 0), 0)
    report = {
        "score": 100,
        "game_ready": True,
        "issues": [],
        "checks": [],
        "meshes": [],
        "materials": {"total": 0, "textured": 0, "flat": 0},
        "textures": len([image for image in bpy.data.images if image.source == "FILE" or image.filepath]),
    }
    penalty = 0
    critical = 0
    materials_seen = set()
    for obj in [item for item in scene().objects if item.type == "MESH"]:
        mesh = obj.data
        tris = _mesh_triangles(mesh)
        mats = [slot for slot in mesh.materials if slot is not None]
        textured = any(_material_has_texture(mat) for mat in mats)
        for mat in mats:
            if mat.name not in materials_seen:
                materials_seen.add(mat.name)
                report["materials"]["total"] += 1
                if _material_has_texture(mat):
                    report["materials"]["textured"] += 1
                else:
                    report["materials"]["flat"] += 1
        non_manifold = _mesh_non_manifold(mesh)
        scale_applied = all(abs(as_float(value, 1.0) - 1.0) < 1e-3 for value in obj.scale)
        record = {
            "name": obj.name,
            "polygons": len(mesh.polygons),
            "triangles": tris,
            "uv": bool(mesh.uv_layers),
            "materials": [mat.name for mat in mats],
            "textured": textured,
            "scale_applied": scale_applied,
            "non_manifold_edges": non_manifold,
            "issues": [],
        }
        if not mats:
            record["issues"].append("no_material")
            penalty += 20
            critical += 1
        elif require_textures and not textured:
            record["issues"].append("flat_material")
            penalty += 15
            critical += 1
        if require_uv and not mesh.uv_layers:
            record["issues"].append("no_uv")
            penalty += 12
            critical += 1
        if require_scale and not scale_applied:
            record["issues"].append("scale_not_applied")
            penalty += 8
            critical += 1
        if max_polygons and tris > max_polygons:
            record["issues"].append("high_polygons")
            penalty += 10
            critical += 1
        if non_manifold > 0:
            record["issues"].append("open_geometry")
            penalty += 3
        if tris == 0:
            record["issues"].append("empty_mesh")
            penalty += 15
            critical += 1
        report["meshes"].append(record)
    if report["materials"]["total"] and report["materials"]["textured"] == 0:
        report["issues"].append("no_textures_in_scene")
        penalty += 10
        if require_textures:
            critical += 1
    report["score"] = max(0, min(100, 100 - penalty))
    report["game_ready"] = critical == 0
    report["issues"].extend(sorted({issue for mesh in report["meshes"] for issue in mesh["issues"]}))
    report["checks"] = [
        {"id": "uv", "ok": all(mesh["uv"] for mesh in report["meshes"]) if report["meshes"] else False},
        {"id": "materials", "ok": all(mesh["materials"] for mesh in report["meshes"]) if report["meshes"] else False},
        {"id": "textures", "ok": report["materials"]["textured"] > 0},
        {"id": "applied_scale", "ok": all(mesh["scale_applied"] for mesh in report["meshes"]) if report["meshes"] else False},
    ]
    return report


# ── render effects (compositor) ─────────────────────────────────────────────


def _configure_glare(node, config):
    glare_type = str(config.get("type", "Fog Glow"))
    quality = str(config.get("quality", "High"))
    threshold = as_float(config.get("threshold", 0.85), 0.85)
    strength = as_float(config.get("strength", 0.6), 0.6)
    size = as_float(config.get("size", 0.6), 0.6)
    if hasattr(node, "glare_type"):
        try:
            node.glare_type = glare_type.upper().replace(" ", "_")
        except Exception:
            node.glare_type = "FOG_GLOW"
        try:
            node.quality = quality.upper()
        except Exception:
            pass
        try:
            node.threshold = threshold
            node.size = max(1, int(round(size * 9)))
        except Exception:
            pass
        return
    set_input(node, glare_type, "Type")
    set_input(node, quality, "Quality")
    set_input(node, threshold, "Threshold")
    set_input(node, strength, "Strength")
    set_input(node, size, "Size")
    set_input(node, as_float(config.get("smoothness", 0.1), 0.1), "Smoothness")


def _configure_lens(node, config):
    distortion = as_float(config.get("distortion", config.get("chromatic", 0.02)), 0.02)
    dispersion = as_float(config.get("dispersion", config.get("chromatic", 0.02)), 0.02)
    if hasattr(node, "distort"):
        try:
            node.distort = distortion
            node.dispersion = dispersion
        except Exception:
            pass
        return
    set_input(node, distortion, "Distortion")
    set_input(node, dispersion, "Dispersion")


def setup_effects(effects):
    if not isinstance(effects, dict) or effects.get("enabled") is False:
        return False
    try:
        if hasattr(scene(), "compositing_node_group"):
            tree = bpy.data.node_groups.new("ComposeVC Compositor", "CompositorNodeTree")
            scene().compositing_node_group = tree
            tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            output = tree.nodes.new("NodeGroupOutput")
            output_socket = output.inputs[0]
        else:
            scene().use_nodes = True
            tree = scene().node_tree
            tree.nodes.clear()
            output = tree.nodes.new("CompositorNodeComposite")
            output_socket = output.inputs["Image"]
        render_layers = tree.nodes.new("CompositorNodeRLayers")
        last = render_layers.outputs["Image"]
        bloom = effects.get("bloom", True)
        if bloom is not False:
            config = bloom if isinstance(bloom, dict) else {}
            glare = tree.nodes.new("CompositorNodeGlare")
            _configure_glare(glare, config)
            tree.links.new(last, glare.inputs["Image"])
            last = glare.outputs["Image"]
        if effects.get("chromatic") or effects.get("dispersion") or effects.get("distortion"):
            lens = tree.nodes.new("CompositorNodeLensdist")
            _configure_lens(lens, effects)
            tree.links.new(last, lens.inputs["Image"])
            last = lens.outputs["Image"]
        tree.links.new(last, output_socket)
        return True
    except Exception as exc:
        warn("render effects unavailable: %s" % exc)
        return False


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
    "portrait": {
        "world": {"color": "#12141a", "strength": 0.22},
        "absolute": True,
        "lights": [
            {"type": "AREA", "name": "Key", "location": (-0.85, -1.05, 1.86), "energy": 55.0, "size": 0.9, "color": "#fff1de"},
            {"type": "AREA", "name": "Fill", "location": (1.15, -0.85, 1.55), "energy": 14.0, "size": 1.4, "color": "#cfe0ff"},
            {"type": "AREA", "name": "Rim", "location": (0.35, 0.95, 1.62), "energy": 48.0, "size": 0.7, "color": "#ffffff"},
            {"type": "AREA", "name": "Bounce", "location": (0.0, -0.55, 1.15), "energy": 6.0, "size": 1.2, "color": "#ffd9c2"},
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


def apply_lighting(preset, scale=1.0, aim=None):
    if not preset or preset == "none":
        return
    spec = LIGHTING_PRESETS.get(str(preset))
    if spec is None:
        warn("unknown lighting preset '%s'" % preset)
        return
    setup_world(spec.get("world"))
    if not any(obj.type in ("LIGHT",) for obj in scene().objects):
        coll = ensure_collection("Lighting")
        absolute = bool(spec.get("absolute"))
        for light_spec in spec.get("lights", []):
            entry = dict(light_spec)
            if entry.get("location") and not absolute:
                entry["location"] = [as_float(v) * max(0.6, min(3.0, scale / 2.0 + 0.6)) for v in entry["location"]]
            if aim is not None and (entry.get("look_at") is None or list(as_vec3(entry.get("look_at"), (0, 0, 0))) == [0.0, 0.0, 0.0]):
                entry["look_at"] = [as_float(v) for v in aim]
            create_object({**entry, "type": entry.get("type", "AREA")}, coll, {})


CAMERA_VIEWS = {
    "three_quarter": (1.15, -1.65, 0.75),
    "front": (0.0, -2.4, 0.32),
    "back": (0.0, 2.4, 0.32),
    "side": (2.4, 0.0, 0.32),
    "top": (0.0, -0.05, 2.6),
    "hero": (0.75, -1.9, 0.42),
    "closeup": (0.6, -1.15, 0.35),
    "portrait": (0.38, -1.0, 0.06),
    "bust": (0.28, -1.0, 0.03),
    "face": (0.12, -1.0, 0.01),
    "head": (0.22, -1.0, 0.04),
}

# Zoom factor applied to the head radius for the portrait views above.
HEAD_VIEW_ZOOM = {"portrait": 2.55, "bust": 3.6, "face": 1.85, "head": 2.1}


def _character_frame(view, spec):
    """Frame a portrait from the body landmarks written by the character kit."""
    if view not in HEAD_VIEW_ZOOM:
        return None
    body = None
    selector = spec.get("frame_object") or spec.get("object")
    if selector:
        body = bpy.data.objects.get(str(selector))
    if body is None or not body.get("cv_landmarks"):
        for obj in scene().objects:
            if obj.get("cv_landmarks") and (body is None or "body" in obj.name.lower()):
                body = obj
    if body is None or not body.get("cv_landmarks"):
        return None
    try:
        data = json.loads(str(body.get("cv_landmarks")))
    except Exception:
        return None
    eye = data.get("eye_mid")
    if not eye:
        return None
    radius = max(0.02, as_float(data.get("head_radius"), 0.09))
    center = (as_float(eye[0]), as_float(eye[1]), as_float(eye[2]) + radius * 0.12)
    return center, radius * HEAD_VIEW_ZOOM[view]


def place_camera(spec, coll=r"DEFAULT"):
    if isinstance(spec, str):
        spec = {"view": spec}
    if not isinstance(spec, dict):
        spec = {}
    view = str(spec.get("view", "three_quarter")).lower()
    center, radius = scene_bounds()
    framed = _character_frame(view, spec)
    if framed is not None:
        center, radius = framed
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
    if spec.get("effects"):
        if setup_effects(spec.get("effects")):
            log("render effects enabled")

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

    turntable = spec.get("turntable")
    if turntable:
        config = turntable if isinstance(turntable, dict) else {}
        frames = as_int(config.get("frames", turntable if isinstance(turntable, (int, float)) else 8), 8)
        frames = max(2, min(120, frames))
        camera = scene_obj.camera or place_camera("three_quarter", "RenderCameras")
        if camera is not None:
            center, _radius = scene_bounds()
            offset = camera.location - Vector(center)
            start = math.radians(as_float(config.get("start_angle", 0.0), 0.0))
            original = camera.location.copy()
            for index in range(frames):
                angle = start + (math.tau * index / frames)
                camera.location = Vector(center) + (Matrix.Rotation(angle, 4, "Z") @ offset)
                aim_at(camera, center)
                do_render("turntable_%02d" % (index + 1))
            camera.location = original
            aim_at(camera, center)

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
    preset = str(spec.get("preset") or spec.get("engine_target") or "").lower()
    preset_defaults = {
        "unity": {"format": "GLB", "include_lights": False, "include_cameras": False},
        "godot": {"format": "GLB", "include_lights": False, "include_cameras": False},
        "web": {"format": "GLB", "include_lights": False, "include_cameras": False},
        "unreal": {"format": "FBX", "include_lights": False, "include_cameras": False},
        "3dprint": {"format": "STL"},
        "print": {"format": "STL"},
        "blender": {"format": "BLEND"},
    }.get(preset)
    if preset_defaults:
        spec = {**preset_defaults, **spec}
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
    include_lights = bool(spec.get("include_lights", spec.get("lights", False)))
    include_cameras = bool(spec.get("include_cameras", spec.get("cameras", False)))
    try:
        if fmt == "GLB":
            op = bpy.ops.export_scene.gltf
            kwargs = dict(
                filepath=filepath,
                export_format="GLB",
                use_selection=use_selection,
                export_apply=bool(spec.get("apply_modifiers", True)),
                export_yup=True,
                export_animations=spec.get("export_animations", True) is not False,
                export_cameras=include_cameras,
                export_lights=include_lights,
            )
        elif fmt == "GLTF":
            op = bpy.ops.export_scene.gltf
            kwargs = dict(
                filepath=filepath,
                export_format="GLTF_SEPARATE",
                use_selection=use_selection,
                export_apply=bool(spec.get("apply_modifiers", True)),
                export_yup=True,
                export_animations=spec.get("export_animations", True) is not False,
                export_cameras=include_cameras,
                export_lights=include_lights,
            )
        elif fmt == "FBX":
            op = bpy.ops.export_scene.fbx
            fbx_types = {"MESH", "ARMATURE"}
            if include_lights:
                fbx_types.add("LIGHT")
            if include_cameras:
                fbx_types.add("CAMERA")
            kwargs = dict(
                filepath=filepath,
                use_selection=use_selection,
                apply_scale_options="FBX_SCALE_ALL",
                path_mode="COPY",
                embed_textures=True,
                mesh_smooth_type="FACE",
                bake_anim=spec.get("export_animations", True) is not False,
                object_types=fbx_types,
            )
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

    if op is None:
        warn("export %s: no operator" % fmt)
        return []
    try:
        kwargs = _filter_op_kwargs(op, kwargs)
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


def _strip_baked_nodes(mat):
    if mat is None or not mat.use_nodes:
        return
    for node in list(mat.node_tree.nodes):
        if node.type == "TEX_IMAGE" and node.image is not None and node.image.name.lower().startswith("cvbake_"):
            mat.node_tree.nodes.remove(node)


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
    scene_obj = scene()
    previous_engine = scene_obj.render.engine
    use_engine("CYCLES")
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
    baked_materials = set()
    for obj in objects:
        ensure_uv(obj)
        if not obj.data.materials:
            continue
        for slot_index, mat in enumerate(list(obj.data.materials)):
            if mat is None or not mat.use_nodes:
                continue
            if mat.name in baked_materials:
                # Shared material used by another object: its UV layout differs,
                # so bake into a per-object copy instead of overwriting the map.
                clone = mat.copy()
                clone.name = "%s_%s" % (mat.name, obj.name)
                obj.data.materials[slot_index] = clone
                _strip_baked_nodes(clone)
                mat = clone
            for pass_name in passes:
                mapping = bake_type_map.get(pass_name)
                if mapping is None:
                    warn("bake: unsupported pass '%s'" % pass_name)
                    continue
                bake_type, pass_filter = mapping
                image_name = "CVBAKE_%s_%s_%s" % (obj.name, mat.name, pass_name.lower())
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
            baked_materials.add(mat.name)
    if spec.get("apply") and results:
        apply_baked_textures(results, objects)
    try:
        scene_obj.render.engine = previous_engine
    except Exception:
        pass
    return results


def apply_baked_textures(results, objects):
    if not results:
        return
    for obj in objects:
        for mat in obj.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            nodes = mat.node_tree.nodes
            links = mat.node_tree.links
            bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
            if bsdf is None:
                continue

            def find(suffix):
                for node in nodes:
                    if node.type == "TEX_IMAGE" and node.image is not None and node.image.name.lower().endswith(suffix):
                        return node
                return None

            base = find("_base_color")
            if base is not None:
                links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
            roughness = find("_roughness")
            if roughness is not None:
                try:
                    roughness.image.colorspace_settings.name = "Non-Color"
                except Exception:
                    pass
                links.new(roughness.outputs["Color"], bsdf.inputs["Roughness"])
            normal = find("_normal")
            if normal is not None:
                try:
                    normal.image.colorspace_settings.name = "Non-Color"
                except Exception:
                    pass
                normal_node = next((node for node in nodes if node.type == "NORMAL_MAP"), None)
                if normal_node is None:
                    normal_node = nodes.new("ShaderNodeNormalMap")
                    normal_node.location = (-220, -720)
                links.new(normal.outputs["Color"], normal_node.inputs["Color"])
                links.new(normal_node.outputs["Normal"], bsdf.inputs["Normal"])


def materials_need_bake():
    for obj in scene().objects:
        if obj.type != "MESH":
            continue
        for mat in obj.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                if node.type in PROCEDURAL_NODE_TYPES:
                    return True
    return False


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

    progress("addons", 4)
    addon_reports = setup_addons(plan)
    animation_spec = plan.get("animation") if isinstance(plan.get("animation"), dict) else {}
    try:
        if animation_spec.get("frame_start") is not None:
            scene().frame_start = max(1, as_int(animation_spec.get("frame_start"), 1))
        if animation_spec.get("frame_end") is not None:
            scene().frame_end = max(scene().frame_start, as_int(animation_spec.get("frame_end"), 120))
        if animation_spec.get("fps") is not None:
            scene().render.fps = max(1, as_int(animation_spec.get("fps"), 24))
        scene().frame_set(scene().frame_start)
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

    plan["__materials"] = materials
    character_report = {}
    if cv_characters is not None:
        cv_characters.init(
            {
                "warn": warn,
                "log": log,
                "progress": progress,
                "as_float": as_float,
                "as_int": as_int,
                "as_vec3": as_vec3,
                "as_color": as_color,
                "ensure_collection": ensure_collection,
                "select_only": select_only,
                "build_material": build_material,
                "material_for": material_for,
                "smart_uv": smart_uv,
                "scene_fn": scene,
            }
        )
        if plan.get("human"):
            progress("human", 14)
            character_report["human"] = cv_characters.build_body(plan, out_dir)

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

    rig_specs = plan.get("armatures") or []
    if rig_specs:
        rig_coll = ensure_collection("Rig")
        for spec in rig_specs:
            if isinstance(spec, dict):
                create_armature(spec, rig_coll)

    if cv_characters is not None and any(
        plan.get(key) for key in ("sculpt", "hair", "drape", "ornament", "weights", "retopo", "view")
    ):
        progress("character", 52)
        character_report.update(cv_characters.apply_detail(plan, out_dir))

    if plan.get("lighting"):
        center, radius = scene_bounds()
        aim = None
        camera_hint = plan.get("camera")
        view_hint = str(
            (camera_hint.get("view") if isinstance(camera_hint, dict) else camera_hint) or ""
        ).lower()
        if view_hint in HEAD_VIEW_ZOOM:
            framed_hint = _character_frame(view_hint, camera_hint if isinstance(camera_hint, dict) else {})
            if framed_hint is not None:
                aim = framed_hint[0]
        apply_lighting(plan.get("lighting"), scale=radius * 2.0, aim=aim)

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

    optimized = []
    if plan.get("optimize"):
        progress("optimize", 58)
        optimized = optimize_meshes(plan)

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
        auto_bake = False
        for spec in export_specs:
            if not isinstance(spec, dict):
                continue
            fmt = str(spec.get("format", "GLB")).upper()
            preset = str(spec.get("preset", "")).lower()
            wants_textures = preset in ("unity", "godot", "web", "unreal") or fmt in ("GLB", "GLTF", "FBX", "OBJ")
            if (
                wants_textures
                and not plan.get("bake")
                and spec.get("auto_bake", True) is not False
                and materials_need_bake()
            ):
                auto_bake = True
                break
        if auto_bake:
            progress("bake", 88)
            resolution = as_int(plan.get("bake_resolution", 1024), 1024)
            auto_spec = {
                "objects": [obj.name for obj in scene().objects if obj.type == "MESH"],
                "passes": ["BASE_COLOR", "ROUGHNESS", "NORMAL"],
                "width": resolution,
                "height": resolution,
                "margin": 8,
                "apply": True,
                "samples": as_int(plan.get("bake_samples", 4), 4),
                "dir": "textures",
            }
            bake_results.extend(bake_plan(auto_spec, out_dir))
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

    progress("audit", 96)
    quality = quality_report(plan)

    stats = describe_scene()
    progress("done", 100)
    return {
        "blendPath": blend_path,
        "renders": render_result[0],
        "engine": render_result[1],
        "exports": exports,
        "bakes": bake_results,
        "stats": stats,
        "addons": addon_reports,
        "quality": quality,
        "optimized": optimized,
        "character": character_report,
        "frameRange": {"start": scene().frame_start, "end": scene().frame_end, "fps": scene().render.fps},
    }


def check_configured_addons(modules):
    reports = []
    for module in modules or []:
        name = str(module or "").strip()
        if not name:
            continue
        enabled, error = enable_addon_module(name)
        installed = bool(enabled) or addon_installed(name)
        if not enabled and name.startswith("bl_ext."):
            install_ok, install_error = try_install_extension_module(name)
            if install_ok:
                enabled, error = enable_addon_module(name)
                installed = bool(enabled) or addon_installed(name)
            elif install_error:
                error = (error + " | install: " + install_error).strip(" |")
        reports.append(
            {
                "module": enabled or name,
                "requested": name,
                "enabled": bool(enabled),
                "installed": bool(installed),
                "error": error,
            }
        )
    return reports


def probe(out_dir, check_addons=None):
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
    addon_checks = check_configured_addons(check_addons)
    user_addons = ""
    user_extensions = ""
    try:
        user_addons = bpy.utils.user_resource("SCRIPTS", path="addons", create=True) or ""
    except Exception:
        pass
    try:
        user_extensions = bpy.utils.user_resource("EXTENSIONS", create=True) or ""
    except Exception:
        pass
    result = {
        "ok": True,
        "blenderVersion": bpy.app.version_string,
        "engines": engines,
        "operators": operators,
        "addons": sorted(list(bpy.context.preferences.addons.keys())),
        "addonChecks": addon_checks,
        "userAddons": user_addons,
        "userExtensions": user_extensions,
    }
    if cv_characters is not None:
        try:
            result["character"] = cv_characters.capabilities()
        except Exception as exc:
            warn("character capabilities failed: %s" % exc)
    RESULT.update(result)
    RESULT["warningsCount"] = len(WARNINGS)
    return result


def main():
    global OUT_DIR
    argv = sys.argv
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    plan_path = ""
    probe_mode = False
    check_addons_path = ""
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
        if token == "--check-addons" and index + 1 < len(args):
            check_addons_path = args[index + 1]
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
        modules = []
        if check_addons_path and os.path.exists(check_addons_path):
            try:
                with open(check_addons_path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                modules = payload if isinstance(payload, list) else payload.get("modules") or []
            except Exception as exc:
                warn("cannot read add-on check list: %s" % exc)
        probe(OUT_DIR, [str(module) for module in modules if isinstance(module, str)])
        RESULT["finishedAt"] = int(time.time() * 1000)
        RESULT["durationMs"] = int((time.time() - STARTED) * 1000)
        write_result()
        return

    if not plan_path or not os.path.exists(plan_path):
        RESULT["error"] = "plan file not found: %s" % plan_path
        write_result()
        sys.exit(3)
    try:
        with open(plan_path, "r", encoding="utf-8-sig") as handle:
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
