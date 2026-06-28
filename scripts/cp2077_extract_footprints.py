"""
cp2077_extract_footprints.py
============================
Extracts 2D building footprints from CP2077 3D-minimap data textures and
produces the following outputs for the NC Zoning Board website:

  data/buildings.json              — building polygons as Leaflet [lat, lng] arrays
  data/roads.json                  — road face polygons as Leaflet [lat, lng] arrays
  data/metro.json                  — metro boundary edge segments as Leaflet [lat, lng] pairs
  scripts/output/buildings.svg     — vector building footprints by district
  scripts/output/roads.svg         — vector road surface fills
  scripts/output/metro.svg         — vector metro track edges
  scripts/output/district_borders.svg — district boundary outlines from trigger polygons
  scripts/output/combined_8k.png   — 8192×8192 RGBA composite (roads + metro + borders + buildings)

Usage:
  # Pass 1 — diagnose world extent (fast, position data only)
  python scripts/cp2077_extract_footprints.py --analyze

  # Pass 2 — full output (set WORLD_MIN/MAX_X/Y constants first)
  python scripts/cp2077_extract_footprints.py

Dependencies:
  pip install numpy pypng Pillow matplotlib

Input textures:
  Export *_data.xbm from WolvenKit as PNG (keep default 16-bit export).
  Set PNG_DIR to the folder containing the exported PNGs.

Metadata source:
  D:\\Modding\\CP2077 Mods\\MyMods\\map_data_export\\source\\raw\\base\\entities\\cameras\\3dmap\\3dmap_triangle_soup.Material.json
"""

import argparse
import json
import math
import os
import sys
import time

import numpy as np


# ── PATHS ──────────────────────────────────────────────────────────────────────

# Directory containing the exported *_data.png files from WolvenKit
PNG_DIR = r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\fx\textures\3dmap\static"

# Directory containing the exported .glb mesh files from WolvenKit
GLB_DIR = r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\entities\cameras\3dmap"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT   = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR  = os.path.join(SCRIPT_DIR, "output")
DATA_DIR    = os.path.join(REPO_ROOT, "data")
JSON_OUT    = os.path.join(DATA_DIR, "buildings.json")


# ── WORLD EXTENT ───────────────────────────────────────────────────────────────
# Imported from shared map_constants.py (derived from TweakDB WorldMap.DefaultSettings)
from map_constants import (
    WORLD_MIN_X, WORLD_MAX_X, WORLD_MIN_Y, WORLD_MAX_Y,
    IMG_SIZE, cet_to_pixel, cet_to_leaflet,
)


# ── CONFIG ─────────────────────────────────────────────────────────────────────
# No area filter — extract ALL building instances for 1-to-1 game map replica.
# Previously MIN_AREA_SQ = 50.0 which discarded 37% of instances (small buildings,
# kiosks, phone booths, etc. that are visible on the in-game map).


# ── DISTRICT WORLD OFFSETS ────────────────────────────────────────────────────
# Each district mesh has a localTransform in 3dmap_view.ent that shifts its
# local coordinate space into world (CET) space.
# Source: base\entities\cameras\3dmap\3dmap_view.ent.json
# Computed as: Bits / 131072.0 for each x/y component.
# Without these offsets all districts cluster at the wrong location.

DISTRICT_OFFSETS = {
    "westbrook":     (-97.209,    590.849),
    "city_center":   (-2116.637,  106.508),
    "heywood":       (-1576.732, -1002.811),
    "pacifica":      (-2422.441, -2368.156),
    "santo_domingo": (-15.944,  -1610.080),
    "watson":        (-1979.372,  1873.951),
    "ep1_dogtown":   (0.0,         0.0),
    "ep1_spaceport": (-4200.000,  200.000),
}


# ── DISTRICTS ──────────────────────────────────────────────────────────────────
# Metadata from 3dmap_triangle_soup.Material.json (verified against script values).
# TRANS_MIN/MAX: world-space decode range for texture colour channels.
# CUBE_SIZE: base half-extent multiplier (doubled per game shader).
# HEIGHT: texture height == block_w (number of instance rows).

DISTRICTS = {
    "westbrook": {
        "png":       "westbrook_data.png",
        "TRANS_MIN": (-1078.94739, -1148.69434, -18.4205875),
        "TRANS_MAX": (1155.12,     1562.87903,  507.894714),
        "CUBE_SIZE": 197.0,
        "HEIGHT":    197,
    },
    "city_center": {
        "png":       "city_center_data.png",
        "TRANS_MIN": (-770.609192, -530.549133,  -40.6581497),
        "TRANS_MAX": (1316.82483,   649.75531,   642.893127),
        "CUBE_SIZE": 168.289993,
        "HEIGHT":    204,
    },
    "heywood": {
        "png":       "heywood_data.png",
        "TRANS_MIN": (-1080.35107, -418.153046,  -38.4002304),
        "TRANS_MAX": (1136.94556,  1372.15979,   374.181305),
        "CUBE_SIZE": 197.236832,
        "HEIGHT":    205,
    },
    "pacifica": {
        "png":       "pacifica_data.png",
        "TRANS_MIN": (-4008.396,  -4575.14941,  -51.9539986),
        "TRANS_MAX": (8258.31641,  7254.10059,  264.306946),
        "CUBE_SIZE": 305.600006,
        "HEIGHT":    153,
    },
    "santo_domingo": {
        "png":       "santo_domingo_data.png",
        "TRANS_MIN": (-1328.95288, -1880.02502,  -37.5960007),
        "TRANS_MAX": (1555.26318,  1369.01294,   332.348328),
        "CUBE_SIZE": 139.342102,
        "HEIGHT":    195,
    },
    "watson": {
        "png":       "watson_data.png",
        "TRANS_MIN": (-1254.46997, -1258.68469,  -24.7028503),
        "TRANS_MAX": (1988.5448,   2032.52405,   475.268005),
        "CUBE_SIZE": 237.175003,
        "HEIGHT":    206,
    },
    "ep1_dogtown": {
        "png":       "ep1_dogtown_data.png",
        "TRANS_MIN": (-2650.0,     -3126.6084,   -0.750015974),
        "TRANS_MAX": (-1025.51855, -1803.58118,  493.576111),
        "CUBE_SIZE": 198.020691,
        "HEIGHT":    148,
    },
    "ep1_spaceport": {
        "png":       "ep1_spaceport_data.png",
        "TRANS_MIN": (-1168.5874,  -765.104614,  -41.4592323),
        "TRANS_MAX": (1219.45483,  1018.70129,   296.498138),
        "CUBE_SIZE": 115.298218,
        "HEIGHT":    94,
    },
}

# ── DISTRICT COLOURS ──────────────────────────────────────────────────────────
# Chosen to complement the Night Corp cyberpunk palette.
# Dogtown and Spaceport (Phantom Liberty) get their own distinct colours.

DISTRICT_COLORS = {
    "city_center":   "#ffb300",  # amber
    "watson":        "#b47aff",  # purple
    "westbrook":     "#00f0ff",  # cyan
    "heywood":       "#ff4081",  # pink
    "santo_domingo": "#ff9800",  # orange
    "pacifica":      "#69ff47",  # lime
    "ep1_dogtown":   "#ff5252",  # red
    "ep1_spaceport": "#40c4ff",  # light blue
}
BADLANDS_COLOR = "#c8a96a"  # sandy/golden for buildings outside all district triggers


# ── DISTRICT TRIGGER POLYGONS ────────────────────────────────────────────────
# Extracted from gameStaticTriggerAreaComponent entries in 3dmap_view.ent.json.
# These are the same polygons the game uses to detect which district the player
# is in. Points are in CET world-space (local trigger offset already applied).
#
# Used for point-in-polygon tests to assign each building to a district,
# replacing the old approach of trusting which texture file a building came from.
# This properly handles Pacifica (whose texture covers far more area than the
# actual district) and Dogtown (which needs its own distinct colour).

ENT_JSON_PATH = r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\entities\cameras\3dmap\3dmap_view.ent.json"

# Map from trigger name → district key used in DISTRICT_COLORS
TRIGGER_TO_DISTRICT = {
    "city_center_trigger":   "city_center",
    "watson_trigger":        "watson",
    "westbrook_trigger":     "westbrook",
    "heywood_trigger":       "heywood",
    "santo_domingo_trigger": "santo_domingo",
    "pacifica_trigger":      "pacifica",
    "dogtown_trigger":       "ep1_dogtown",
    "ncx_trigger":           "ep1_spaceport",
}


def load_trigger_polygons():
    """
    Load district trigger area polygons from the .ent JSON file.
    Returns dict: district_key -> [(x, y), ...] polygon in CET world coords.

    Each trigger's outline points are in local space. To convert to world CET
    coords, we walk the full parent transform chain (localTransform → parent →
    grandparent → ...) and accumulate translation + rotation at each level.

    This is critical for:
      - Pacifica: trigger → pacifica_transform (65° yaw + offset) → mesh offset
      - NCX/Spaceport: trigger → ncx_transform → morro_rock_trigger (offset)
    """
    if not os.path.exists(ENT_JSON_PATH):
        print(f"WARNING: .ent JSON not found — {ENT_JSON_PATH}")
        print("  District coloring will fall back to texture-source assignment.")
        return {}

    with open(ENT_JSON_PATH, "r") as f:
        data = json.load(f)

    chunks = data["Data"]["RootChunk"]["compiledData"]["Data"]["Chunks"]

    # Build component lookup by name for parent chain walking
    components = {}
    for chunk in chunks:
        name = chunk.get("name", {})
        if isinstance(name, dict):
            name = name.get("$value", "")
        if name:
            components[name] = chunk

    def get_local_transform(comp):
        """Extract (tx, ty, yaw_radians) from a component's localTransform."""
        lt = comp.get("localTransform", {})
        pos = lt.get("Position", {})
        ori = lt.get("Orientation", {})
        tx = pos.get("x", {}).get("Bits", 0) / 131072.0
        ty = pos.get("y", {}).get("Bits", 0) / 131072.0
        qr = ori.get("r", 1.0)
        qi = ori.get("i", 0.0)
        qj = ori.get("j", 0.0)
        qk = ori.get("k", 0.0)
        yaw = math.atan2(2.0 * (qr * qk + qi * qj),
                         1.0 - 2.0 * (qj * qj + qk * qk))
        return tx, ty, yaw

    def get_parent_name(comp):
        """Get the bindName of a component's parentTransform."""
        pt = comp.get("parentTransform", {})
        if not pt or not isinstance(pt, dict):
            return None
        pd = pt.get("Data", {})
        if not pd:
            return None
        bn = pd.get("bindName", {})
        if not bn:
            return None
        return bn.get("$value", None)

    def compute_world_points(comp, outline_points):
        """
        Walk the parent transform chain and apply each transform (rotate + translate)
        to convert outline points from local space to world CET space.
        """
        # Collect the full chain of transforms (child → parent → grandparent → ...)
        chain = []
        current = comp
        while current is not None:
            tx, ty, yaw = get_local_transform(current)
            chain.append((tx, ty, yaw))
            parent_name = get_parent_name(current)
            current = components.get(parent_name) if parent_name else None

        # Apply transforms from the component itself up through parents.
        # At each level: rotate points by yaw, then translate.
        pts = [(p["X"], p["Y"]) for p in outline_points]
        for tx, ty, yaw in chain:
            if abs(yaw) > 1e-6:
                cos_a = math.cos(yaw)
                sin_a = math.sin(yaw)
                pts = [(x * cos_a - y * sin_a, x * sin_a + y * cos_a) for x, y in pts]
            if abs(tx) > 1e-6 or abs(ty) > 1e-6:
                pts = [(x + tx, y + ty) for x, y in pts]
        return pts

    polygons = {}
    for chunk in chunks:
        if chunk.get("$type") != "gameStaticTriggerAreaComponent":
            continue
        trigger_name = chunk["name"]["$value"]
        if trigger_name not in TRIGGER_TO_DISTRICT:
            continue

        district_key = TRIGGER_TO_DISTRICT[trigger_name]
        outline = chunk["outline"]["Data"]
        points = compute_world_points(chunk, outline["points"])
        polygons[district_key] = points

    print(f"Loaded {len(polygons)} district trigger polygons")
    for dk, pts in polygons.items():
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        print(f"  {dk:20s}  {len(pts):3d} pts  "
              f"X [{min(xs):8.0f}, {max(xs):8.0f}]  Y [{min(ys):8.0f}, {max(ys):8.0f}]")

    return polygons


def load_mesh_transforms(verbose=False):
    """
    Load world-space (CET X, CET Y) positions for all entMeshComponent entries
    in the 3dmap_view.ent JSON. Returns dict: component_name -> (cet_x, cet_y).

    Walks the full parentTransform chain for each component (rotate then translate
    at each level), so components parented to the Pacifica hierarchy (e.g. the
    upright ferris wheel) are correctly placed in world CET space.

    Run with --list-landmarks to print all components and verify positions.
    """
    if not os.path.exists(ENT_JSON_PATH):
        print(f"WARNING: .ent JSON not found — {ENT_JSON_PATH}")
        return {}

    with open(ENT_JSON_PATH, "r") as f:
        data = json.load(f)

    chunks = data["Data"]["RootChunk"]["compiledData"]["Data"]["Chunks"]

    # Build component lookup by name for parent chain walking
    components = {}
    for chunk in chunks:
        name = chunk.get("name", {})
        if isinstance(name, dict):
            name = name.get("$value", "")
        if name:
            components[name] = chunk

    def get_local_transform(comp):
        """Return (tx, ty, (qr, qi, qj, qk)) for a component's localTransform."""
        lt = comp.get("localTransform", {})
        pos = lt.get("Position", {})
        ori = lt.get("Orientation", {})
        tx = pos.get("x", {}).get("Bits", 0) / 131072.0
        ty = pos.get("y", {}).get("Bits", 0) / 131072.0
        qr = ori.get("r", 1.0)
        qi = ori.get("i", 0.0)
        qj = ori.get("j", 0.0)
        qk = ori.get("k", 0.0)
        return tx, ty, (qr, qi, qj, qk)

    def quat_yaw(q):
        """Extract yaw (rotation around CET Z-up axis) from quaternion."""
        qr, qi, qj, qk = q
        return math.atan2(2.0 * (qr * qk + qi * qj), 1.0 - 2.0 * (qj**2 + qk**2))

    def quat_multiply(q1, q2):
        """Hamilton product q1 * q2 (apply q2 first, then q1)."""
        r1, i1, j1, k1 = q1
        r2, i2, j2, k2 = q2
        return (
            r1*r2 - i1*i2 - j1*j2 - k1*k2,
            r1*i2 + i1*r2 + j1*k2 - k1*j2,
            r1*j2 - i1*k2 + j1*r2 + k1*i2,
            r1*k2 + i1*j2 - j1*i2 + k1*r2,
        )

    def get_parent_name(comp):
        pt = comp.get("parentTransform", {})
        if not pt or not isinstance(pt, dict):
            return None
        pd = pt.get("Data", {})
        if not pd:
            return None
        bn = pd.get("bindName", {})
        if not bn:
            return None
        return bn.get("$value", None)

    def compute_world_transform(comp):
        """Walk the parent chain applying each transform (rotate then translate)
        to convert the component's local position to world CET coordinates.

        Position uses yaw-only rotation (correct for horizontal CET plane).
        Orientation accumulates the full quaternion via Hamilton products so
        pitch and roll are preserved for 3D vertex rotation in the renderer.

        Returns (cet_x, cet_y, world_quaternion) where world_quaternion is
        (qr, qi, qj, qk) representing the mesh's full world-space orientation.
        """
        tx0, ty0, q0 = get_local_transform(comp)

        chain = []
        parent_name = get_parent_name(comp)
        current = components.get(parent_name) if parent_name else None
        while current is not None:
            chain.append(get_local_transform(current))
            parent_name = get_parent_name(current)
            current = components.get(parent_name) if parent_name else None

        x, y = tx0, ty0
        q_world = q0
        for tx, ty, q_parent in chain:
            yaw = quat_yaw(q_parent)
            if abs(yaw) > 1e-6:
                cos_a = math.cos(yaw)
                sin_a = math.sin(yaw)
                x, y = x * cos_a - y * sin_a, x * sin_a + y * cos_a
            x += tx
            y += ty
            q_world = quat_multiply(q_parent, q_world)

        return x, y, q_world

    _identity_quat = (1.0, 0.0, 0.0, 0.0)

    transforms = {}
    for chunk in chunks:
        if chunk.get("$type") != "entMeshComponent":
            continue
        name = chunk.get("name", {})
        if isinstance(name, dict):
            name = name.get("$value", "")
        if not name:
            continue
        transforms[name] = compute_world_transform(chunk)

    if verbose:
        print(f"entMeshComponent transforms from ent JSON ({len(transforms)} components):")
        for name, (x, y, q) in sorted(transforms.items()):
            print(f"  {name:50s}  X={x:10.3f}  Y={y:10.3f}  yaw={math.degrees(quat_yaw(q)):8.2f}°")

    return transforms


def point_in_polygon(x, y, polygon):
    """
    Ray-casting algorithm: shoot a ray from (x, y) in +X direction,
    count how many polygon edges it crosses. Odd = inside.
    """
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def classify_district(cx, cy, trigger_polygons):
    """
    Determine which district a building center (cx, cy) belongs to.
    Tests against trigger polygons in priority order (Dogtown before Pacifica,
    since Dogtown is inside the broader Pacifica texture area).
    Returns the district key or None if outside all districts.
    """
    # Test Dogtown first — it overlaps with no main district but needs priority
    # to avoid being swallowed by a broader texture decode
    priority_order = ["ep1_dogtown", "ep1_spaceport", "city_center", "watson",
                      "westbrook", "heywood", "santo_domingo", "pacifica"]
    for dk in priority_order:
        if dk in trigger_polygons and point_in_polygon(cx, cy, trigger_polygons[dk]):
            return dk
    return None


# ── GLB MESH LAYERS ────────────────────────────────────────────────────────────
# Each GLB is in local mesh space. The ent localTransform (CET X, CET Y) is the
# full world placement. Vertex coords: GLB_X = CET_X, GLB_Z = CET_Y (confirmed
# via obelisk centroid ≈ 0,0 with ent offset = known world position).
# Meshes at offset (0,0) are already in world/CET space.
#
# Offsets are looked up from load_mesh_transforms() at runtime using offset_key.
# offset_key must match the entMeshComponent name in 3dmap_view.ent.json.
# Run --list-landmarks to print all component names and verify before editing.

# Layers rendered under the building footprints (back to front).
#
# Rendering notes:
#   - Water mesh: a world-scale flat plane — when filled as 2D polygons it covers
#     the entire canvas. Excluded; dark background gives ocean context for free.
#   - Road/terrain fills: 3D surface polygons are huge when projected flat.
#     Use BOUNDARY edges only (edges belonging to exactly 1 face) to get road
#     outlines without interior mesh triangulation artefacts.
#   - Metro: same boundary-edge approach for clean track lines.
#   - Landmarks: filled top-down silhouettes — faint so they don't overpower
#     building footprints, which are composited on top.
#
# Set to an empty list [] to produce buildings-only output.

# Human-readable names for landmark meshes (for hover tooltips in the frontend)
LANDMARK_NAMES = {
    "obelisk":                 "The Needle",
    "pyramid":                 "Heavy Hearts Club",
    "statue":                  "De-votion",
    "av_building":             "Brainporium",
    "icosphere":               "Brave Atlas",
    "northoak_sign":           "North Oak Sign",
    "ferris_wheel_upright":    "Pacifica Ferris Wheel",
    "ferris_wheel_collapsed":  "Rancho Coronado Ferris Wheel",
}

GLB_LAYERS = [
    # (filename, fill_rgba, edge_rgba, edge_width, label, offset_key)
    # offset_key: entMeshComponent name in 3dmap_view.ent.json (None = use filename stem)
    #
    # Roads: fill the road surface faces at low opacity → shows grey road areas
    # between buildings. Buildings are composited on top so fills only appear
    # where there are no buildings (the streets themselves). No edges — the
    # boundary-edge approach shows mesh slab outlines, not readable roads.
    ("3dmap_roads.glb",   (45, 45, 65, 100), None,               0, "roads", None),
    ("3dmap_metro.glb",   None,              (255, 200, 0, 230), 3, "metro", None),

    # Landmark meshes — filled top-down silhouettes rendered over buildings.
    # Both fill_rgba and edge_rgba use ("district", alpha) sentinels: colour is
    # resolved at render time from the landmark's world CET position via
    # classify_district() + DISTRICT_COLORS, so each landmark uses the same
    # colour as surrounding buildings (fill alpha=200, outline alpha=240).
    # offset_key values confirmed via --list-landmarks; update if ent changes.
    # Note: 3dmap_cliffs.glb is excluded — terrain geometry, not a landmark, and
    # obscures the map in the Dogtown/Badlands border area at 2D projection scale.
    ("3dmap_obelisk.glb",                    ("district", 200), ("district", 240), 1, "obelisk",             "obelisk"),
    ("monument_ave_pyramid.glb",             ("district", 200), ("district", 240), 1, "pyramid",             "monument_ave_pyramid"),
    ("3dmap_statue_splash_a.glb",            ("district", 200), ("district", 240), 1, "statue",              "statue_splash_a"),
    ("3dmap_ext_monument_av_building_b.glb", ("district", 200), ("district", 240), 1, "av_building",         "ext_monument_av_building_b"),
    ("northoak_sign_a.glb",                  ("district", 200), ("district", 240), 1, "northoak_sign",       "northoak_sign_a"),
    ("cz_cz_building_h_icosphere.glb",       ("district", 200), ("district", 240), 1, "icosphere",           "cz_cz_building_h_icosphere"),
    # Ferris wheel is placed twice in the ent — upright in Pacifica and collapsed.
    # Both reference the same GLB; offset_key distinguishes the two instances.
    # Run --list-landmarks to find the exact component names if these don't match.
    ("rcr_park_ferris_wheel.glb",            ("district", 200), ("district", 240), 1, "ferris_wheel_upright",   "ferris_wheel_pacifica"),
    ("rcr_park_ferris_wheel.glb",            ("district", 200), ("district", 240), 1, "ferris_wheel_collapsed", "ferris_wheel_collapsed"),
]


def render_glb_base_layer(wbounds, mesh_transforms=None, trigger_polygons=None, svg_output_dir=None, json_output_dir=None, layers=None, combined_label=None):
    """
    Collect GLB mesh elements as Z-annotated draw primitives and write per-category SVG/JSON.

    Returns a list of z_elements dicts — one per face or edge — for use in the
    unified Z-sorted draw pass in run_full_output().  No PIL drawing is done here.

    Each z_element:
      {"z": float, "fill_rgba": tuple|None, "edge_rgba": tuple|None,
       "edge_width": int, "pts": [(px,py),...], "svg_str": str}

    layers:         list of GLB_LAYERS tuples to render; defaults to all of GLB_LAYERS.
    combined_label: if set, all layers write to a single SVG/JSON named after this
                    label instead of one file per layer. Each layer gets its own
                    <g id="{label}"> group within the combined SVG.
    Coordinate mapping: GLB vertex[0] (X) -> CET_X, GLB vertex[2] (Z) -> CET_Y.
    World placement offsets are looked up from mesh_transforms by offset_key
    (the 6th element of each GLB_LAYERS tuple, or the filename stem if None).
    """
    try:
        import trimesh
    except ImportError:
        print("  [GLB] trimesh not installed — skipping GLB layer (pip install trimesh)")
        return []

    min_x, max_x, min_y, max_y = wbounds

    def verts_to_px(verts, off_x=0.0, off_y=0.0):
        """Batch-convert GLB vertices to pixel (x, y) arrays.

        Axis mapping (confirmed empirically — roads 180° from buildings without this):
          GLB_X  -> -CET_X  (X is negated)
          GLB_Y  -> height   (used for Z depth)
          GLB_Z  -> +CET_Y  (Z maps directly to north-south, no negation)
        """
        wx = -verts[:, 0] + off_x         # -GLB_X =  CET_X
        wy =  verts[:, 2] + off_y         # +GLB_Z =  CET_Y
        px = (wx - min_x) / (max_x - min_x) * IMG_SIZE
        py = (max_y - wy) / (max_y - min_y) * IMG_SIZE
        return px, py

    z_elements = []  # collected draw primitives returned to run_full_output for unified pass

    transforms = mesh_transforms or {}

    # Accumulators for SVG/JSON output.
    # out_key = combined_label (when set) or label (one file per layer).
    # svg_fill_acc: out_key -> {"fill_hex":, "fill_alpha":, "groups": [(label, [(z, poly_str)])]}
    # svg_edge_acc: out_key -> {"svg_hex":, "svg_alpha":, "lw":, "lines": [(z, line_str)]}
    # json_fill_acc: out_key -> [{"z":, "pts":}]         flat list (roads.json)
    #                        -> {label: [{"z":, "pts":}]} dict by label (landmarks.json)
    # json_edge_acc: out_key -> [{"z":, "pts":}]         flat list (metro.json)
    svg_fill_acc  = {}
    svg_edge_acc  = {}
    json_fill_acc = {}
    json_edge_acc = {}

    for layer in (layers if layers is not None else GLB_LAYERS):
        filename, fill_rgba, edge_rgba, edge_width, label = layer[:5]
        offset_key = layer[5] if len(layer) > 5 else None
        path = os.path.join(GLB_DIR, filename)
        if not os.path.exists(path):
            print(f"  [GLB] not found — {filename}")
            continue

        out_key = combined_label or label

        stem = filename.replace(".glb", "")
        key = offset_key if offset_key is not None else stem
        off_x, off_y, off_quat = transforms.get(key, (0.0, 0.0, (1.0, 0.0, 0.0, 0.0)))

        # Resolve ("district", alpha) sentinel → actual RGBA using the landmark's
        # world CET position and the loaded district trigger polygons.
        landmark_district = None  # Track district for JSON output
        if isinstance(fill_rgba, tuple) and len(fill_rgba) == 2 and fill_rgba[0] == "district":
            alpha = fill_rgba[1]
            if trigger_polygons:
                landmark_district = classify_district(off_x, off_y, trigger_polygons)
                hex_col = DISTRICT_COLORS.get(landmark_district, BADLANDS_COLOR) if landmark_district else BADLANDS_COLOR
            else:
                hex_col = "#dcdcc8"  # fallback off-white if no polygon data
            r, g, b = int(hex_col[1:3], 16), int(hex_col[3:5], 16), int(hex_col[5:7], 16)
            fill_rgba = (r, g, b, alpha)
            print(f"  [GLB] {label}: district={landmark_district or 'badlands'}, colour {hex_col} (alpha={alpha})")

        # Same sentinel resolution for edge_rgba
        if isinstance(edge_rgba, tuple) and len(edge_rgba) == 2 and edge_rgba[0] == "district":
            alpha = edge_rgba[1]
            if trigger_polygons:
                dk = classify_district(off_x, off_y, trigger_polygons)
                hex_col = DISTRICT_COLORS.get(dk, BADLANDS_COLOR) if dk else BADLANDS_COLOR
            else:
                hex_col = "#dcdcc8"
            r, g, b = int(hex_col[1:3], 16), int(hex_col[3:5], 16), int(hex_col[5:7], 16)
            edge_rgba = (r, g, b, alpha)

        # Roads/metro (offset_key=None) are already in world space with orientation
        # handled by the -GLB_X axis flip in verts_to_px — don't apply ent rotation.
        if offset_key is None:
            off_quat = (1.0, 0.0, 0.0, 0.0)

        print(f"  [GLB] loading {filename}...")
        mesh = trimesh.load(path, force="mesh")

        # Apply full 3D world-space rotation from the ent quaternion.
        # Operates in CET space (CET_X=-GLB_X, CET_Y=+GLB_Z, CET_Z=+GLB_Y)
        # so pitch and roll that mix the height axis are correctly projected.
        qr, qi, qj, qk = off_quat
        is_identity = (abs(qr - 1.0) < 1e-6 and
                       abs(qi) < 1e-6 and abs(qj) < 1e-6 and abs(qk) < 1e-6)
        if not is_identity:
            # Build rotation matrix from quaternion (acts on CET [X, Y, Z] vectors)
            R00 = 1 - 2*(qj**2 + qk**2);  R01 = 2*(qi*qj - qr*qk);  R02 = 2*(qi*qk + qr*qj)
            R10 = 2*(qi*qj + qr*qk);      R11 = 1 - 2*(qi**2 + qk**2); R12 = 2*(qj*qk - qr*qi)
            R20 = 2*(qi*qk - qr*qj);      R21 = 2*(qj*qk + qr*qi);  R22 = 1 - 2*(qi**2 + qj**2)
            # Convert GLB → CET, rotate, convert back
            cx = -mesh.vertices[:, 0]   # CET_X = -GLB_X
            cy =  mesh.vertices[:, 2]   # CET_Y = +GLB_Z
            cz =  mesh.vertices[:, 1]   # CET_Z = +GLB_Y (height)
            verts = mesh.vertices.copy()
            verts[:, 0] = -(R00*cx + R01*cy + R02*cz)  # rotated CET_X → GLB_X
            verts[:, 2] =   R10*cx + R11*cy + R12*cz   # rotated CET_Y → GLB_Z
            verts[:, 1] =   R20*cx + R21*cy + R22*cz   # rotated CET_Z → GLB_Y
            yaw_deg = math.degrees(math.atan2(2*(qr*qk + qi*qj), 1 - 2*(qj**2 + qk**2)))
            print(f"  [GLB] {label}: applying 3D rotation (yaw={yaw_deg:.1f}°)")
        else:
            verts = mesh.vertices

        px, py = verts_to_px(verts, off_x, off_y)

        # Collect filled faces — Z = average vertex height (verts[:, 1] = CET_Z after rotation)
        if fill_rgba is not None:
            svg_polys = []   # list of (z, poly_str) tuples for per-file SVG
            json_polys = []  # list of {"z": float, "pts": [[lat,lng],...]}
            fill_hex = "#{:02x}{:02x}{:02x}".format(fill_rgba[0], fill_rgba[1], fill_rgba[2])
            fill_alpha = fill_rgba[3] / 255.0
            svg_poly_style = f'fill="{fill_hex}" fill-opacity="{fill_alpha:.2f}" stroke="none"'
            for face in mesh.faces:
                face_z = float(np.mean(verts[face, 1]))  # average CET_Z height of face vertices
                pts = [(float(px[i]), float(py[i])) for i in face]
                z_elements.append({
                    "z": face_z, "fill_rgba": fill_rgba, "edge_rgba": None,
                    "edge_width": 0, "pts": pts,
                    "svg_str": f'<polygon {svg_poly_style} points="'
                               + " ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in pts) + '"/>',
                })
                if svg_output_dir:
                    pts_str = " ".join(f"{p[0]:.1f},{p[1]:.1f}" for p in pts)
                    svg_polys.append((face_z, f'    <polygon points="{pts_str}"/>'))
                if json_output_dir:
                    ll_pts = [
                        world_to_leaflet(float(-verts[i, 0] + off_x),
                                         float( verts[i, 2] + off_y), wbounds)
                        for i in face
                    ]
                    json_polys.append({"z": round(face_z, 3), "pts": ll_pts})

            if svg_output_dir and svg_polys:
                if out_key not in svg_fill_acc:
                    svg_fill_acc[out_key] = {"groups": []}
                svg_fill_acc[out_key]["groups"].append((label, fill_hex, fill_alpha, svg_polys))
            if json_output_dir and json_polys:
                if combined_label:
                    if out_key not in json_fill_acc:
                        json_fill_acc[out_key] = {}
                    json_fill_acc[out_key].setdefault(label, []).extend(json_polys)
                else:
                    if out_key not in json_fill_acc:
                        json_fill_acc[out_key] = []
                    json_fill_acc[out_key].extend(json_polys)

        # Collect BOUNDARY edges only — edges belonging to exactly 1 face.
        # Using all edges_unique draws interior mesh tessellation (triangles).
        # Boundary edges give clean road/track outlines with no interior artefacts.
        if edge_rgba is not None:
            # faces_unique_edges: (N_faces, 3) — edge indices per face
            edge_counts = np.bincount(
                mesh.faces_unique_edges.ravel(),
                minlength=len(mesh.edges_unique)
            )
            boundary_edges = mesh.edges_unique[edge_counts == 1]
            print(f"  [GLB] {label}: {len(mesh.edges_unique):,} unique edges, "
                  f"{len(boundary_edges):,} boundary")

            px_arr = np.clip(px, -1, IMG_SIZE + 1)
            py_arr = np.clip(py, -1, IMG_SIZE + 1)
            lw = max(1, int(edge_width))

            svg_lines = []   # list of (z, line_str) tuples for per-file SVG
            json_segs = []   # list of {"z": float, "pts": [[lat,lng],[lat,lng]]}
            svg_hex = "#{:02x}{:02x}{:02x}".format(edge_rgba[0], edge_rgba[1], edge_rgba[2])
            svg_alpha = edge_rgba[3] / 255.0
            svg_line_style = f'stroke="{svg_hex}" stroke-opacity="{svg_alpha:.2f}" stroke-width="{lw}" fill="none"'

            for e in boundary_edges:
                edge_z = float((verts[e[0], 1] + verts[e[1], 1]) * 0.5)  # average CET_Z
                x0, y0 = float(px_arr[e[0]]), float(py_arr[e[0]])
                x1, y1 = float(px_arr[e[1]]), float(py_arr[e[1]])
                z_elements.append({
                    "z": edge_z, "fill_rgba": None, "edge_rgba": edge_rgba,
                    "edge_width": lw, "pts": [(x0, y0), (x1, y1)],
                    "svg_str": f'<line {svg_line_style} x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}"/>',
                })
                if svg_output_dir:
                    svg_lines.append(
                        (edge_z, f'  <line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}"/>')
                    )
                if json_output_dir:
                    json_segs.append({
                        "z": round(edge_z, 3),
                        "pts": [
                            world_to_leaflet(float(-verts[e[0], 0] + off_x),
                                             float( verts[e[0], 2] + off_y), wbounds),
                            world_to_leaflet(float(-verts[e[1], 0] + off_x),
                                             float( verts[e[1], 2] + off_y), wbounds),
                        ],
                    })

            if svg_output_dir and svg_lines:
                if out_key not in svg_edge_acc:
                    svg_edge_acc[out_key] = {"groups": []}
                svg_edge_acc[out_key]["groups"].append((label, svg_hex, svg_alpha, lw, svg_lines))
            if json_output_dir and json_segs:
                if combined_label:
                    if out_key not in json_edge_acc:
                        json_edge_acc[out_key] = {}
                    json_edge_acc[out_key].setdefault(label, []).extend(json_segs)
                else:
                    if out_key not in json_edge_acc:
                        json_edge_acc[out_key] = []
                    json_edge_acc[out_key].extend(json_segs)

        print(f"  [GLB] {label}: {len(mesh.vertices):,} verts, {len(mesh.faces):,} faces")

    # Write accumulated SVG files — polygons/lines sorted by Z within each group
    if svg_output_dir:
        all_svg_keys = set(svg_fill_acc) | set(svg_edge_acc)
        for out_key in all_svg_keys:
            g_elements = []
            if out_key in svg_fill_acc:
                for lbl, f_hex, f_alpha, z_polys in svg_fill_acc[out_key]["groups"]:
                    sorted_polys = [s for _, s in sorted(z_polys, key=lambda t: t[0])]
                    g_elements.append(
                        f'  <g id="{lbl}" fill="{f_hex}" '
                        f'fill-opacity="{f_alpha:.2f}" stroke="none">\n'
                        + "\n".join(sorted_polys)
                        + "\n  </g>"
                    )
            if out_key in svg_edge_acc:
                for lbl, s_hex, s_alpha, lw, z_lines in svg_edge_acc[out_key]["groups"]:
                    sorted_lines = [s for _, s in sorted(z_lines, key=lambda t: t[0])]
                    g_elements.append(
                        f'  <g id="{lbl}_outline" stroke="{s_hex}" '
                        f'stroke-opacity="{s_alpha:.2f}" stroke-width="{lw}" fill="none">\n'
                        + "\n".join(sorted_lines)
                        + "\n  </g>"
                    )
            svg_content = (
                f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {IMG_SIZE} {IMG_SIZE}">\n'
                + "\n".join(g_elements)
                + "\n</svg>\n"
            )
            svg_file = os.path.join(svg_output_dir, f"{out_key}.svg")
            with open(svg_file, "w", encoding="utf-8") as f:
                f.write(svg_content)
            size_mb = os.path.getsize(svg_file) / (1024 * 1024)
            print(f"  [GLB] SVG  -> {svg_file} ({size_mb:.1f} MB)")

    # Write accumulated JSON files — each element carries a "z" field.
    # Combined (landmark) format: {label: {"faces": [{"z":,"pts":},...], "edges": [...]}}
    # Non-combined format: flat list (roads = faces, metro = edges)
    if json_output_dir:
        all_json_keys = set(json_fill_acc) | set(json_edge_acc)
        for out_key in all_json_keys:
            fills = json_fill_acc.get(out_key)
            edges = json_edge_acc.get(out_key)
            if isinstance(fills, dict) or isinstance(edges, dict):
                # Combined (landmark) output: merge per-label faces + edges + metadata
                labels = set(fills or {}) | set(edges or {})
                data = {}
                for lbl in labels:
                    entry = {}
                    if fills and lbl in fills:
                        entry["faces"] = fills[lbl]
                    if edges and lbl in edges:
                        entry["edges"] = edges[lbl]
                    # Add landmark metadata (name, district) from LANDMARK_NAMES
                    # and the district classified during rendering
                    if lbl in LANDMARK_NAMES:
                        entry["name"] = LANDMARK_NAMES[lbl]
                    # Find the district for this landmark from the layer data
                    for layer in (layers if layers is not None else GLB_LAYERS):
                        if layer[4] == lbl:  # label match
                            lm_offset_key = layer[5] if len(layer) > 5 else None
                            lm_key = lm_offset_key if lm_offset_key is not None else layer[0].replace(".glb", "")
                            lm_off_x, lm_off_y, _ = transforms.get(lm_key, (0.0, 0.0, (1,0,0,0)))
                            if trigger_polygons:
                                lm_dist = classify_district(lm_off_x, lm_off_y, trigger_polygons)
                                entry["district"] = lm_dist or "badlands"
                            break
                    data[lbl] = entry
                json_file = os.path.join(json_output_dir, f"{out_key}.json")
                with open(json_file, "w", encoding="utf-8") as f:
                    json.dump(data, f, separators=(",", ":"))
                size_mb = os.path.getsize(json_file) / (1024 * 1024)
                total_faces = sum(len(v.get("faces", [])) for v in data.values())
                total_edges = sum(len(v.get("edges", [])) for v in data.values())
                print(f"  [GLB] JSON -> {json_file} ({len(data)} landmarks, "
                      f"{total_faces:,} faces, {total_edges:,} edge segments, {size_mb:.1f} MB)")
            else:
                # Non-combined: write fill (faces) and edge (segments) as separate flat files
                if fills is not None:
                    json_file = os.path.join(json_output_dir, f"{out_key}.json")
                    with open(json_file, "w", encoding="utf-8") as f:
                        json.dump(fills, f, separators=(",", ":"))
                    size_mb = os.path.getsize(json_file) / (1024 * 1024)
                    print(f"  [GLB] JSON -> {json_file} ({len(fills):,} faces, {size_mb:.1f} MB)")
                if edges is not None:
                    json_file = os.path.join(json_output_dir, f"{out_key}.json")
                    with open(json_file, "w", encoding="utf-8") as f:
                        json.dump(edges, f, separators=(",", ":"))
                    size_mb = os.path.getsize(json_file) / (1024 * 1024)
                    print(f"  [GLB] JSON -> {json_file} ({len(edges):,} segments, {size_mb:.1f} MB)")

    return z_elements


def render_district_borders(trigger_polygons, wbounds, svg_output_dir=None):
    """
    Render district boundary outlines from trigger polygon data onto an
    8k×8k RGBA PIL Image and optionally write an SVG file.

    Two-tier rendering:
      - District borders: thick solid lines (width=3, alpha=180)
      - Subdistrict borders: thin dashed lines (width=1, alpha=100), same color

    District data comes from trigger_polygons (flat dict, already loaded).
    Subdistrict data is loaded from data/subdistricts.json if it exists.

    These are the actual game trigger area boundaries — much cleaner than the
    3dmap_roads_borders.glb mesh (which is just road surface geometry).
    """
    from PIL import Image, ImageDraw

    # subdistricts.json uses "dogtown" / "ncx_morro_rock" as IDs, but
    # DISTRICT_COLORS uses "ep1_dogtown" / "ep1_spaceport" — map them here.
    SUBDIST_ID_TO_COLOR_KEY = {
        "dogtown":        "ep1_dogtown",
        "ncx_morro_rock": "ep1_spaceport",
    }

    subdist_path = os.path.join(DATA_DIR, "subdistricts.json")
    subdist_data = None
    if os.path.exists(subdist_path):
        with open(subdist_path, "r") as f:
            subdist_data = json.load(f)

    border_img = Image.new("RGBA", (IMG_SIZE, IMG_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(border_img)

    svg_groups = []

    for dk, polygon in trigger_polygons.items():
        hex_color = DISTRICT_COLORS.get(dk, "#ffffff")
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)
        district_rgba = (r, g, b, 180)

        # Convert world coords to pixel coords
        pixel_pts = [world_to_pixel(wx, wy, wbounds) for wx, wy in polygon]

        # Draw outlined polygon (no fill, just border)
        draw.polygon(pixel_pts, fill=None, outline=district_rgba)
        # Draw again with thicker lines
        for i in range(len(pixel_pts)):
            p0 = pixel_pts[i]
            p1 = pixel_pts[(i + 1) % len(pixel_pts)]
            draw.line([p0, p1], fill=district_rgba, width=3)

        if svg_output_dir:
            pts_str = " ".join(f"{px:.1f},{py:.1f}" for px, py in pixel_pts)
            group_lines = [
                f'  <g id="{dk}">',
                f'    <polygon points="{pts_str}" fill="none" '
                f'stroke="{hex_color}" stroke-width="3" stroke-opacity="0.7"/>',
            ]

            # Subdistrict borders within this district group
            if subdist_data:
                for dist_entry in subdist_data["districts"]:
                    color_key = SUBDIST_ID_TO_COLOR_KEY.get(dist_entry["id"], dist_entry["id"])
                    if color_key != dk:
                        continue
                    for sub in dist_entry.get("subdistricts", []):
                        sub_pts = [world_to_pixel(wx, wy, wbounds) for wx, wy in sub["polygon"]]
                        sub_pts_str = " ".join(f"{px:.1f},{py:.1f}" for px, py in sub_pts)
                        group_lines.append(
                            f'    <polygon points="{sub_pts_str}" fill="none" '
                            f'stroke="{hex_color}" stroke-width="1.5" '
                            f'stroke-dasharray="18,10" stroke-opacity="0.45" '
                            f'id="{sub["id"]}"/>'
                        )

            group_lines.append("  </g>")
            svg_groups.append("\n".join(group_lines))

    # PIL subdistrict lines (drawn after districts so they render on top)
    if subdist_data:
        for dist_entry in subdist_data["districts"]:
            color_key = SUBDIST_ID_TO_COLOR_KEY.get(dist_entry["id"], dist_entry["id"])
            hex_color = DISTRICT_COLORS.get(color_key, "#ffffff")
            r = int(hex_color[1:3], 16)
            g = int(hex_color[3:5], 16)
            b = int(hex_color[5:7], 16)
            sub_rgba = (r, g, b, 100)
            for sub in dist_entry.get("subdistricts", []):
                sub_pts = [world_to_pixel(wx, wy, wbounds) for wx, wy in sub["polygon"]]
                for i in range(len(sub_pts)):
                    p0 = sub_pts[i]
                    p1 = sub_pts[(i + 1) % len(sub_pts)]
                    draw.line([p0, p1], fill=sub_rgba, width=1)

    if svg_output_dir and svg_groups:
        svg_content = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {IMG_SIZE} {IMG_SIZE}">\n'
            + "\n".join(svg_groups)
            + "\n</svg>\n"
        )
        svg_file = os.path.join(svg_output_dir, "district_borders.svg")
        with open(svg_file, "w", encoding="utf-8") as f:
            f.write(svg_content)
        size_kb = os.path.getsize(svg_file) / 1024
        sub_count = sum(len(d.get("subdistricts", [])) for d in subdist_data["districts"]) if subdist_data else 0
        print(f"  District borders SVG -> {svg_file} ({size_kb:.1f} KB, {len(trigger_polygons)} districts, {sub_count} subdistricts)")

    return border_img


# ── CORE HELPERS ───────────────────────────────────────────────────────────────

def load_png_raw_f64(path):
    """
    Load a PNG as float64 RGBA in [0,1].
    Uses pypng which ignores sRGB/gAMA/iCCP chunks — raw bytes only.
    Supports 8-bit and 16-bit PNGs (WolvenKit exports TRF_DeepColor as 16-bit).
    """
    import png

    reader = png.Reader(filename=path)
    width, height, rows, info = reader.read()

    bit_depth  = info["bitdepth"]
    n_channels = info.get("planes", 4)
    dtype      = np.uint16 if bit_depth == 16 else np.uint8
    max_val    = np.float64(65535 if bit_depth == 16 else 255)

    arr = np.array(list(rows), dtype=dtype).reshape(height, width, n_channels)

    if n_channels == 1:
        arr = np.concatenate([arr] * 3 + [np.full_like(arr, int(max_val))], axis=-1)
    elif n_channels == 2:
        arr = np.concatenate([arr[:, :, :1]] * 3 + [arr[:, :, 1:2]], axis=-1)
    elif n_channels == 3:
        alpha = np.full(arr.shape[:2] + (1,), int(max_val), dtype=dtype)
        arr = np.concatenate([arr, alpha], axis=-1)
    # n_channels == 4: already RGBA

    return arr.astype(np.float64) / max_val, bit_depth


def quat_to_matrix_f64(w, x, y, z):
    """Quaternion (w,x,y,z) -> 3×3 rotation matrix (float64, not normalised)."""
    return np.array([
        [1 - 2*(y*y + z*z),  2*(x*y - w*z),       2*(x*z + w*y)      ],
        [2*(x*y + w*z),      1 - 2*(x*x + z*z),   2*(y*z - w*x)      ],
        [2*(x*z - w*y),      2*(y*z + w*x),        1 - 2*(x*x + y*y) ],
    ], dtype=np.float64)


def world_to_pixel(wx, wy, wbounds):
    """
    World (CET) XY -> pixel (px, py) in IMG_SIZE×IMG_SIZE canvas.
    wbounds = (min_x, max_x, min_y, max_y)
    Y axis flipped: world Y increases north, image Y increases downward.
    """
    min_x, max_x, min_y, max_y = wbounds
    px = (wx - min_x) / (max_x - min_x) * IMG_SIZE
    py = (max_y - wy) / (max_y - min_y) * IMG_SIZE
    return px, py


def world_to_leaflet(wx, wy, wbounds):
    """
    Exact CET -> Leaflet [lat, lng] derived from world extent constants.
    Matches the coordinate system used by tiles generated from combined_8k.png.

    Relation to tile space (L.CRS.Simple, tileSize=256, maxNativeZoom=5):
      Leaflet lat = -(pixel_y / 32)
      Leaflet lng =   pixel_x  / 32
    """
    px, py = world_to_pixel(wx, wy, wbounds)
    scale = IMG_SIZE / 256  # = 32 at IMG_SIZE=8192
    return [round(-(py / scale), 5), round(px / scale, 5)]


# ── DISTRICT DECODER ──────────────────────────────────────────────────────────

def decode_district(name, d, positions_only=False):
    """
    Decode all valid instances from a district texture.

    positions_only=True  -> fast mode (--analyze): returns center XY only.
    positions_only=False -> full mode: returns center + 4 rotated 2D corners.

    Each result is a dict:
      {"center": (cx, cy)}                             (positions_only)
      {"center": (cx, cy), "corners_world": [(x,y)×4]} (full)
    """
    path = os.path.join(PNG_DIR, d["png"])
    if not os.path.exists(path):
        print(f"  [SKIP] {name}: PNG not found — {path}")
        return []

    print(f"  Loading {d['png']}...")
    t0 = time.time()
    px, _ = load_png_raw_f64(path)
    img_h, img_w = px.shape[:2]
    t1 = time.time()
    print(f"  {img_w}×{img_h} loaded in {t1-t0:.1f}s")

    block_w = img_w // 3
    block_h = min(img_h, block_w)

    tmin_x, tmin_y, tmin_z = (np.float64(v) for v in d["TRANS_MIN"])
    tmax_x, tmax_y, tmax_z = (np.float64(v) for v in d["TRANS_MAX"])
    # Half-extent = scale_pixel × CUBE_SIZE (the 3D script uses ±0.5 × scale × 2×CUBE_SIZE
    # which equals ±scale×CUBE_SIZE; our 2D corners are already at ±hx so no ×2 here)
    cube_val = np.float64(d["CUBE_SIZE"])

    # World offset from 3dmap_view.ent localTransform (Bits / 131072)
    off_x, off_y = (np.float64(v) for v in DISTRICT_OFFSETS.get(name, (0.0, 0.0)))

    instances = []
    skipped   = 0

    for y in range(block_h):
        for x in range(block_w):

            # Validity: alpha channel of position block
            if px[y, x, 3] < 0.01:
                skipped += 1
                continue

            # Centre position (XY + Z height)
            # Decoded in district-local space; add world offset from 3dmap_view.ent
            pr, pg, pb = px[y, x, 0], px[y, x, 1], px[y, x, 2]
            cx = tmin_x + (tmax_x - tmin_x) * pr + off_x
            cy = tmin_y + (tmax_y - tmin_y) * pg + off_y
            wz = tmin_z + (tmax_z - tmin_z) * pb

            # Scale (half-extents) — X, Y for footprint, Z for building height
            sr, sg, sb = px[y, x + 2*block_w, 0], px[y, x + 2*block_w, 1], px[y, x + 2*block_w, 2]
            hx = sr * cube_val
            hy = sg * cube_val
            hz = sb * cube_val  # building height (vertical extrusion)

            if hx == 0.0 and hy == 0.0:
                skipped += 1
                continue

            if positions_only:
                instances.append({"center": (float(cx), float(cy))})
                continue

            # Quaternion -> 2D rotation via top-left 2×2 of rotation matrix
            rr, rg, rb, ra = (px[y, x + block_w, c] for c in range(4))
            qx_ = rr * 2.0 - 1.0
            qy_ = rg * 2.0 - 1.0
            qz_ = rb * 2.0 - 1.0
            qw_ = ra * 2.0 - 1.0

            R  = quat_to_matrix_f64(qw_, qx_, qy_, qz_)
            R2 = R[:2, :2]  # XY-plane rotation submatrix

            # Rotate the 4 local corners into world space
            local = np.array([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]], dtype=np.float64)
            world_offsets = (R2 @ local.T).T
            corners = [(float(cx + dx), float(cy + dy)) for dx, dy in world_offsets]

            instances.append({
                "center": (float(cx), float(cy)),
                "z": float(wz),
                "hz": float(hz),  # building height (half-extent Z, for shadow/extrusion)
                "corners_world": corners,
            })

    t2 = time.time()
    print(f"  {len(instances)} instances decoded, {skipped} skipped ({t2-t0:.1f}s total)")
    return instances


# ── PASS 1: ANALYZE ────────────────────────────────────────────────────────────

def run_analyze():
    """
    Decode centre positions only across all districts, print statistics,
    and save a scatter plot so the user can choose WORLD_MIN/MAX constants.
    """
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        has_matplotlib = True
    except ImportError:
        has_matplotlib = False
        print("Warning: matplotlib not installed — scatter plot skipped.")
        print("  pip install matplotlib")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    all_positions = {}
    all_x, all_y  = [], []

    for name, d in DISTRICTS.items():
        print(f"\n[{name}]")
        instances = decode_district(name, d, positions_only=True)
        positions = [inst["center"] for inst in instances]
        all_positions[name] = positions
        if positions:
            xs = [p[0] for p in positions]
            ys = [p[1] for p in positions]
            all_x.extend(xs)
            all_y.extend(ys)
            print(f"  X: {min(xs):.1f} -> {max(xs):.1f}")
            print(f"  Y: {min(ys):.1f} -> {max(ys):.1f}")

    # Print and save statistics
    lines = [
        "=== Building Position Analysis ===",
        f"Total instances (all districts): {len(all_x)}",
        "",
        f"Overall X range: {min(all_x):.2f} -> {max(all_x):.2f}",
        f"Overall Y range: {min(all_y):.2f} -> {max(all_y):.2f}",
        "",
        "Per-district breakdown:",
    ]
    for name, positions in all_positions.items():
        if positions:
            xs = [p[0] for p in positions]
            ys = [p[1] for p in positions]
            lines.append(
                f"  {name:20s}  X [{min(xs):8.1f}, {max(xs):8.1f}]"
                f"  Y [{min(ys):8.1f}, {max(ys):8.1f}]  n={len(positions)}"
            )

    txt_path = os.path.join(OUTPUT_DIR, "analysis.txt")
    with open(txt_path, "w") as f:
        f.write("\n".join(lines))
    print("\n" + "\n".join(lines))
    print(f"\nSaved: {txt_path}")

    # Scatter plot
    if has_matplotlib:
        fig, ax = plt.subplots(figsize=(12, 12), facecolor="#0a192f")
        ax.set_facecolor("#0a192f")

        for name, positions in all_positions.items():
            if not positions:
                continue
            xs = [p[0] for p in positions]
            ys = [p[1] for p in positions]
            color = DISTRICT_COLORS.get(name, "#ffffff")
            ax.scatter(xs, ys, s=0.5, c=color, alpha=0.4, label=name, rasterized=True)

        ax.set_aspect("equal")
        # No invert_yaxis() — matplotlib default (positive Y at top) already = north-up
        ax.legend(loc="upper right", fontsize=8, facecolor="#0a192f", labelcolor="white",
                  markerscale=6)
        ax.set_title("Building position scatter — all districts", color="white", fontsize=14)
        ax.tick_params(colors="#8892b0")
        ax.set_xlabel("CET X (world)", color="#8892b0")
        ax.set_ylabel("CET Y (world)", color="#8892b0")
        for spine in ax.spines.values():
            spine.set_edgecolor("#8892b0")

        scatter_path = os.path.join(OUTPUT_DIR, "analysis_scatter.png")
        fig.savefig(scatter_path, dpi=150, bbox_inches="tight")
        plt.close()
        print(f"Saved: {scatter_path}")

    print("\n" + "="*60)
    print("Next step:")
    print("  1. Open scripts/output/analysis_scatter.png")
    print("  2. Note where buildings actually cluster (ignore sparse outliers)")
    print("  3. Set WORLD_MIN_X, WORLD_MAX_X, WORLD_MIN_Y, WORLD_MAX_Y in this script")
    print("  4. Re-run without --analyze to generate full output")
    print("="*60)


# ── PASS 2: FULL OUTPUT ────────────────────────────────────────────────────────

def get_world_bounds():
    """Return (min_x, max_x, min_y, max_y) or abort if not configured."""
    if any(v is None for v in [WORLD_MIN_X, WORLD_MAX_X, WORLD_MIN_Y, WORLD_MAX_Y]):
        print("ERROR: World extent not configured.")
        print("  Run with --analyze first, then set WORLD_MIN_X/MAX_X/MIN_Y/MAX_Y in this script.")
        sys.exit(1)
    return (WORLD_MIN_X, WORLD_MAX_X, WORLD_MIN_Y, WORLD_MAX_Y)


def run_full_output():
    """
    Pass 2: decode all footprints and write JSON + 8k PNG + SVG.
    WORLD_MIN/MAX_X/Y must be set before running this.
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("ERROR: Pillow not installed. pip install Pillow")
        sys.exit(1)

    wbounds = get_world_bounds()
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    print(f"World extent: X [{wbounds[0]}, {wbounds[1]}]  Y [{wbounds[2]}, {wbounds[3]}]")
    print(f"Canvas: {IMG_SIZE}×{IMG_SIZE} px\n")

    # Derive new cetToLeaflet coefficients from world extent (for reference)
    scale = IMG_SIZE / 256  # = 32
    print("Derived cetToLeaflet formula (update utils.js after verification):")
    print(f"  lat = -((WORLD_MAX_Y - cetY) / (WORLD_MAX_Y - WORLD_MIN_Y) * {IMG_SIZE}) / {scale:.0f}")
    print(f"  lng =  ((cetX - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X) * {IMG_SIZE}) / {scale:.0f}")
    print()

    # Load district trigger polygons for accurate building → district assignment
    print("Loading district trigger polygons...")
    trigger_polygons = load_trigger_polygons()
    print()

    # Load mesh component transforms for GLB landmark placement
    print("Loading mesh transforms from ent JSON...")
    mesh_transforms = load_mesh_transforms()
    print(f"  {len(mesh_transforms)} entMeshComponent transforms loaded\n")

    # Collect roads + metro as z_elements; also writes roads.svg, metro.svg, roads.json, metro.json
    print("Collecting GLB base layer (roads + metro)...")
    base_z_elems = render_glb_base_layer(wbounds, mesh_transforms=mesh_transforms, svg_output_dir=OUTPUT_DIR, json_output_dir=DATA_DIR, layers=GLB_LAYERS[:2])

    # Collect landmarks as z_elements; also writes landmarks.svg + data/landmarks.json
    print("Collecting GLB landmark layer...")
    landmark_z_elems = render_glb_base_layer(wbounds, mesh_transforms=mesh_transforms, trigger_polygons=trigger_polygons, svg_output_dir=OUTPUT_DIR, json_output_dir=DATA_DIR, layers=GLB_LAYERS[2:], combined_label="landmarks")

    # Render district borders from trigger polygons (always drawn topmost — not Z-sorted)
    print("Rendering district borders from trigger polygons...")
    if trigger_polygons:
        border_layer = render_district_borders(trigger_polygons, wbounds, svg_output_dir=OUTPUT_DIR)
    else:
        border_layer = None

    # Collect all building instances from all textures first, then classify
    # by trigger polygon. This decouples "which texture" from "which district".
    print("Decoding all district textures...")
    all_instances = []
    for name, d in DISTRICTS.items():
        print(f"[{name}]")
        instances = decode_district(name, d, positions_only=False)
        # Tag each instance with its source texture (fallback if no trigger match)
        for inst in instances:
            inst["source_texture"] = name
        all_instances.extend(instances)
    print(f"\nTotal instances: {len(all_instances)}")

    # Classify each building into a district via trigger polygon test
    print("Classifying buildings by trigger polygon...")
    district_buckets = {dk: [] for dk in DISTRICT_COLORS}
    district_buckets["_badlands"] = []  # buildings outside all districts
    classified = 0
    badlands_count = 0

    for inst in all_instances:
        corners_w = inst.get("corners_world")
        if not corners_w or len(corners_w) < 3:
            continue

        cx, cy = inst["center"]

        if trigger_polygons:
            dk = classify_district(cx, cy, trigger_polygons)
        else:
            # No trigger data available: use source texture as district
            dk = inst["source_texture"]

        if dk is None:
            district_buckets["_badlands"].append(inst)
            badlands_count += 1
        else:
            district_buckets[dk].append(inst)
            classified += 1

    print(f"  Classified: {classified}, Badlands/outside: {badlands_count}\n")

    # Collect per-district building z_elements (deferred drawing — unified pass below)
    svg_groups      = []   # per-district SVG groups for buildings.svg
    json_districts  = []   # per-district data for buildings.json
    building_z_elems = []  # z_elements for unified PNG/combined-SVG draw pass

    for dk, instances in district_buckets.items():
        if not instances:
            continue

        hex_color = DISTRICT_COLORS.get(dk, BADLANDS_COLOR)
        r = int(hex_color[1:3], 16)
        g = int(hex_color[3:5], 16)
        b = int(hex_color[5:7], 16)
        fill_rgba    = (r, g, b, 200)   # solid fill
        outline_rgba = (r, g, b, 240)   # visible outline

        label = dk if dk != "_badlands" else "badlands"
        print(f"[{label}] {len(instances)} buildings, color={hex_color}")

        svg_poly_style = (f'fill="{hex_color}" fill-opacity="0.78" '
                          f'stroke="{hex_color}" stroke-width="1" stroke-opacity="0.94"')
        z_polys          = []   # (z, svg_str) tuples for Z-sorted buildings.svg group
        polygons_leaflet = []   # {"z": float, "pts": [...]} for buildings.json

        for inst in instances:
            corners_w = inst["corners_world"]
            inst_z    = inst["z"]

            # Pixel-space corners for PNG and SVG
            pixel_corners = [world_to_pixel(wx, wy, wbounds) for wx, wy in corners_w]

            # Collect for unified Z-sorted PIL pass
            building_z_elems.append({
                "z": inst_z, "fill_rgba": fill_rgba, "edge_rgba": outline_rgba,
                "edge_width": 1, "pts": pixel_corners,
                "svg_str": (f'<polygon {svg_poly_style} points="'
                            + " ".join(f"{px:.1f},{py:.1f}" for px, py in pixel_corners) + '"/>'),
            })

            # SVG polygon element (z-keyed for sorting within district group)
            pts_str = " ".join(f"{px:.1f},{py:.1f}" for px, py in pixel_corners)
            z_polys.append(
                (inst_z,
                 f'    <polygon points="{pts_str}" {svg_poly_style}/>')
            )

            # Leaflet coordinates for buildings.json (z-enriched)
            leaflet_corners = [world_to_leaflet(wx, wy, wbounds) for wx, wy in corners_w]
            entry = {"z": round(inst_z, 3), "pts": leaflet_corners}
            if "hz" in inst:
                entry["hz"] = round(inst["hz"], 2)
            polygons_leaflet.append(entry)

        json_districts.append({"district": label, "polygons": polygons_leaflet})
        sorted_polys = [s for _, s in sorted(z_polys, key=lambda t: t[0])]
        svg_groups.append(
            f'  <g id="district-{label}">\n' + "\n".join(sorted_polys) + "\n  </g>"
        )
        print(f"  {len(polygons_leaflet)} polygons\n")

    # Unified Z-sorted PNG + combined SVG
    # Merge all z_elements from roads/metro, buildings, and landmarks.
    # Sort by Z ascending so higher elements paint over lower ones (painter's algorithm).
    # District borders are drawn on top afterwards — not Z-sorted, always topmost.
    all_z_elems = sorted(
        (base_z_elems or []) + building_z_elems + (landmark_z_elems or []),
        key=lambda e: e["z"]
    )
    print(f"\nUnified Z-sorted draw pass: {len(all_z_elems):,} elements "
          f"({len(base_z_elems or []):,} GLB base, {len(building_z_elems):,} buildings, "
          f"{len(landmark_z_elems or []):,} landmarks)...")

    combined_img = Image.new("RGBA", (IMG_SIZE, IMG_SIZE), (0, 0, 0, 0))
    combined_draw = ImageDraw.Draw(combined_img)
    combined_svg_elems = []  # (z, svg_str) for combined.svg

    for elem in all_z_elems:
        pts = elem["pts"]
        if elem["fill_rgba"] is not None:
            combined_draw.polygon(pts, fill=elem["fill_rgba"],
                                  outline=elem["edge_rgba"] if elem["edge_rgba"] is not None else None)
        elif elem["edge_rgba"] is not None:
            combined_draw.line(pts, fill=elem["edge_rgba"], width=elem["edge_width"])
        combined_svg_elems.append((elem["z"], elem["svg_str"]))

    if border_layer is not None:
        combined_img.paste(border_layer, (0, 0), border_layer)

    combined_path = os.path.join(OUTPUT_DIR, "combined_8k.png")
    combined_img.save(combined_path)
    print(f"PNG  -> {combined_path}  (Z-sorted: roads + metro + buildings + landmarks + borders)")

    # Write buildings.svg (per-district groups, Z-sorted within each group)
    svg_content = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {IMG_SIZE} {IMG_SIZE}">\n'
        + "\n".join(svg_groups)
        + "\n</svg>\n"
    )
    svg_path = os.path.join(OUTPUT_DIR, "buildings.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg_content)
    print(f"SVG  -> {svg_path}")

    # Write combined.svg — all elements from all categories sorted by Z (full cross-category accuracy)
    sorted_svg_strs = [s for _, s in sorted(combined_svg_elems, key=lambda t: t[0])]
    combined_svg_path = os.path.join(OUTPUT_DIR, "combined.svg")
    with open(combined_svg_path, "w", encoding="utf-8") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {IMG_SIZE} {IMG_SIZE}">\n')
        f.write("\n".join(sorted_svg_strs))
        f.write("\n</svg>\n")
    size_mb = os.path.getsize(combined_svg_path) / (1024 * 1024)
    print(f"SVG  -> {combined_svg_path}  (Z-sorted combined, {size_mb:.1f} MB)")

    # Write buildings.json (z-enriched: each polygon is {"z": float, "pts": [[lat,lng],...]})
    with open(JSON_OUT, "w", encoding="utf-8") as f:
        json.dump(json_districts, f, separators=(",", ":"))
    total   = sum(len(d["polygons"]) for d in json_districts)
    size_kb = os.path.getsize(JSON_OUT) / 1024
    print(f"JSON -> {JSON_OUT}  ({total} polygons, {size_kb:.0f} KB)")

    print("\nDone. Next steps:")
    print("  1. Inspect combined_8k.png — does Night City look right?")
    print("  2. If generating new tiles: copy combined_8k.png to raw maps/ and run generate_tiles.js")
    print("  3. Update cetToLeaflet in assets/js/utils.js with the formula printed above")
    print("  4. Verify alignment: npx serve . and check overlay vs existing tile map")


# ── ENTRY POINT ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="CP2077 building footprint extractor for NC Zoning Board"
    )
    parser.add_argument(
        "--analyze",
        action="store_true",
        help="Pass 1: decode positions only and produce scatter plot (fast)"
    )
    parser.add_argument(
        "--list-landmarks",
        action="store_true",
        help="List all entMeshComponent names and CET positions from the ent JSON (for verifying GLB_LAYERS offset_key values)"
    )
    args = parser.parse_args()

    if args.analyze:
        run_analyze()
    elif args.list_landmarks:
        load_mesh_transforms(verbose=True)
    else:
        run_full_output()
