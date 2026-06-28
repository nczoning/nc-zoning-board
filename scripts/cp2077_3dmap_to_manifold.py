"""
cp2077_3dmap_to_manifold.py
===========================
Converts Cyberpunk 2077 3D-map data textures into watertight (manifold)
OBJ meshes suitable for 3D printing or further processing.


Generated with the assistance of Claude (Anthropic) and GitHub Copilot.


---------------------------------------------------------------------------
OVERVIEW
---------------------------------------------------------------------------
The game's 3D minimap is rendered via a GPU instancing shader that reads
instance data (position, rotation, scale) from a packed texture. Each
pixel encodes one box (building chunk) in three side-by-side blocks:


  [ 0 .. block_w-1 ]       position  (RGB = XYZ world coords, A = validity)
  [ block_w .. 2*block_w-1] rotation  (RGBA = quaternion XYZW, range -1..1)
  [2*block_w .. 3*block_w-1] scale    (RGB = XYZ half-extents)


TRANS_MIN / TRANS_MAX define the world-space bounding box; each colour
channel linearly interpolates between the min and max of its axis.


---------------------------------------------------------------------------
INPUT FILES
---------------------------------------------------------------------------
Export the *_data.xbm textures from the game archive with WolvenKit
(File > Export Tool, keep default PNG export).


The textures use rawFormat = TRF_DeepColor (16-bit per channel).
Each district has a corresponding entry in DISTRICTS below; fill in the
path to the exported PNG and the metadata values from the .xbm JSON.


WARNING: do NOT open/re-save the PNGs in Photoshop or any tool that
applies colour management — the data channels must be read as raw bytes.
This script uses pypng which ignores sRGB/gAMA/iCCP chunks entirely.


---------------------------------------------------------------------------
DEPENDENCIES
---------------------------------------------------------------------------
    pip install manifold3d trimesh pypng numpy


Tested with:
    Python        3.11+
    manifold3d    3.x
    trimesh       4.x
    pypng         0.20220715.0+
    numpy         1.x / 2.x


---------------------------------------------------------------------------
OUTPUT
---------------------------------------------------------------------------
One <district>_manifold.obj per active district, written to OUTPUT_DIR.
The mesh is guaranteed manifold (result.status() == ManifoldError.NoError).
Import directly into OrcaSlicer, PrusaSlicer, Blender, etc.


---------------------------------------------------------------------------
USAGE
---------------------------------------------------------------------------
1. Set OUTPUT_DIR to your desired output folder.
2. Uncomment the districts you want to process and fill in the PNG paths.
3. Run:  python cp2077_3dmap_to_manifold.py
"""


import numpy as np
from manifold3d import Manifold, Mesh
import trimesh
import os
import time


# ── OUTPUT ───────────────────────────────────────────────────────────────────


OUTPUT_DIR = "output"   # relative or absolute path


# ── DISTRICTS ────────────────────────────────────────────────────────────────
# For each district:
#   "tga"       : path to the WolvenKit-exported PNG  (*_data.png)
#   "TRANS_MIN" : world-space minimum corner  (from the .xbm or material JSON)
#   "TRANS_MAX" : world-space maximum corner
#   "CUBE_SIZE" : base half-extent of one instance cube (game units)
#   "HEIGHT"    : texture height in pixels (== number of instance rows)
#
# Values must be copied exactly from the source JSON — no rounding.


DISTRICTS = {
#   "westbrook": {
#       "tga":       "path/to/westbrook_data.png",
#       "TRANS_MIN": (-1078.94739, -1148.69434, -18.4205875),
#       "TRANS_MAX": (1155.12,     1562.87903,  507.894714),
#       "CUBE_SIZE": 197.0,
#       "HEIGHT":    197,
#   },
#   "city_center": {
#       "tga":       "path/to/city_center_data.png",
#       "TRANS_MIN": (-770.609192, -530.549133,  -40.6581497),
#       "TRANS_MAX": (1316.82483,   649.75531,   642.893127),
#       "CUBE_SIZE": 168.289993,
#       "HEIGHT":    204,
#   },
#   "heywood": {
#       "tga":       "path/to/heywood_data.png",
#       "TRANS_MIN": (-1080.35107, -418.153046,  -38.4002304),
#       "TRANS_MAX": (1136.94556,  1372.15979,   374.181305),
#       "CUBE_SIZE": 197.236832,
#       "HEIGHT":    205,
#   },
#   "pacifica": {
#       "tga":       "path/to/pacifica_data.png",
#       "TRANS_MIN": (-4008.396,  -4575.14941,  -51.9539986),
#       "TRANS_MAX": (8258.31641,  7254.10059,  264.306946),
#       "CUBE_SIZE": 305.600006,
#       "HEIGHT":    153,
#   },
#   "santo_domingo": {
#       "tga":       "path/to/santo_domingo_data.png",
#       "TRANS_MIN": (-1328.95288, -1880.02502,  -37.5960007),
#       "TRANS_MAX": (1555.26318,  1369.01294,   332.348328),
#       "CUBE_SIZE": 139.342102,
#       "HEIGHT":    195,
#   },
#   "watson": {
#       "tga":       "path/to/watson_data.png",
#       "TRANS_MIN": (-1254.46997, -1258.68469,  -24.7028503),
#       "TRANS_MAX": (1988.5448,   2032.52405,   475.268005),
#       "CUBE_SIZE": 237.175003,
#       "HEIGHT":    206,
#   },
#   "ep1_dogtown": {
#       "tga":       "path/to/ep1_dogtown_data.png",
#       "TRANS_MIN": (-2650.0,     -3126.6084,   -0.750015974),
#       "TRANS_MAX": (-1025.51855, -1803.58118,  493.576111),
#       "CUBE_SIZE": 198.020691,
#       "HEIGHT":    148,
#   },
#   "ep1_spaceport": {
#       "tga":       "path/to/ep1_spaceport_data.png",
#       "TRANS_MIN": (-1168.5874,  -765.104614,  -41.4592323),
#       "TRANS_MAX": (1219.45483,  1018.70129,   296.498138),
#       "CUBE_SIZE": 115.298218,
#       "HEIGHT":    94,
#   },
}


# ── CUBE GEOMETRY ─────────────────────────────────────────────────────────────
# Unit cube centred at origin, CCW winding, float64.


_CUBE_VERTS_F64 = np.array([
    [-0.5, -0.5, -0.5],  # 0
    [ 0.5, -0.5, -0.5],  # 1
    [ 0.5,  0.5, -0.5],  # 2
    [-0.5,  0.5, -0.5],  # 3
    [-0.5, -0.5,  0.5],  # 4
    [ 0.5, -0.5,  0.5],  # 5
    [ 0.5,  0.5,  0.5],  # 6
    [-0.5,  0.5,  0.5],  # 7
], dtype=np.float64)


_CUBE_FACES = np.array([
    [0, 3, 2], [0, 2, 1],   # bottom  (-Z)
    [4, 5, 6], [4, 6, 7],   # top     (+Z)
    [0, 1, 5], [0, 5, 4],   # front   (-Y)
    [3, 7, 6], [3, 6, 2],   # back    (+Y)
    [0, 4, 7], [0, 7, 3],   # left    (-X)
    [1, 2, 6], [1, 6, 5],   # right   (+X)
], dtype=np.uint32)



# ── HELPERS ───────────────────────────────────────────────────────────────────


def load_png_raw_f64(path: str) -> tuple[np.ndarray, int]:
    """
    Load a PNG as a float64 array with shape (H, W, 4), values in [0, 1].


    Uses pypng, which reads raw integer samples and ignores any embedded
    colour-profile chunks (sRGB, gAMA, iCCP).  This matches Blender's
    'Non-Color' / 'Raw' colour space behaviour exactly.


    Supports both 8-bit (uint8, max=255) and 16-bit (uint16, max=65535)
    PNGs.  WolvenKit exports *_data textures as 16-bit (TRF_DeepColor).


    IMPORTANT: never pre-process the source PNG with colour-managed
    software — any gamma correction will corrupt the encoded coordinates.
    """
    import png


    reader = png.Reader(filename=path)
    width, height, rows, info = reader.read()


    bit_depth  = info["bitdepth"]       # 8 or 16
    n_channels = info.get("planes", 4)  # 1=grey, 2=grey+A, 3=RGB, 4=RGBA


    dtype   = np.uint16 if bit_depth == 16 else np.uint8
    max_val = np.float64(65535 if bit_depth == 16 else 255)


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



def lerp_f64(a: np.float64, b: np.float64, t: np.float64) -> np.float64:
    return a + (b - a) * t



def quat_to_matrix_f64(w, x, y, z) -> np.ndarray:
    """
    Quaternion (w, x, y, z) -> 3x3 rotation matrix, float64.
    Not normalised — consistent with the game shader and the original
    Blender import scripts.
    """
    return np.array([
        [1.0 - 2.0*(y*y + z*z),  2.0*(x*y - w*z),        2.0*(x*z + w*y)       ],
        [2.0*(x*y + w*z),        1.0 - 2.0*(x*x + z*z),  2.0*(y*z - w*x)       ],
        [2.0*(x*z - w*y),        2.0*(y*z + w*x),        1.0 - 2.0*(x*x + y*y) ],
    ], dtype=np.float64)



def make_cube_manifold(loc, quat_wxyz, scale_xyz) -> Manifold:
    """
    Build a Manifold for a single transformed cube.


    All arithmetic stays in float64 until the very last step where
    manifold3d requires float32 for its Mesh constructor.


    Transform order: Scale -> Rotate -> Translate  (matches Blender TRS).
    """
    verts = _CUBE_VERTS_F64.copy()


    sx, sy, sz = scale_xyz
    verts[:, 0] *= sx
    verts[:, 1] *= sy
    verts[:, 2] *= sz


    R = quat_to_matrix_f64(*quat_wxyz)
    verts = (R @ verts.T).T


    wx, wy, wz = loc
    verts[:, 0] += wx
    verts[:, 1] += wy
    verts[:, 2] += wz


    return Manifold(Mesh(
        vert_properties=verts.astype(np.float32),
        tri_verts=_CUBE_FACES,
    ))



def union_tree(manifolds: list) -> Manifold:
    """
    Balanced binary union tree: O(N log N).


    Each level halves the list by pairwise union, so all operands at
    a given level have comparable complexity.  This is much faster than
    a linear progressive union (O(N^2)) where the accumulator grows
    with every step.
    """
    if not manifolds:
        return None
    while len(manifolds) > 1:
        next_level = []
        for i in range(0, len(manifolds), 2):
            if i + 1 < len(manifolds):
                next_level.append(manifolds[i] + manifolds[i + 1])
            else:
                next_level.append(manifolds[i])
        manifolds = next_level
        print(f"    reduction level: {len(manifolds)} manifolds remaining...")
    return manifolds[0]



# ── MAIN PIPELINE ─────────────────────────────────────────────────────────────


def build_district(name: str, d: dict):
    print(f"\n[{name}] Loading: {d['tga']}")


    px, bit_depth = load_png_raw_f64(d["tga"])
    img_h, img_w = px.shape[:2]
    print(f"[{name}] Size: {img_w}x{img_h}, {bit_depth}-bit per channel")


    block_w = img_w // 3
    block_h = min(img_h, block_w)


    tmin_x = np.float64(d["TRANS_MIN"][0])
    tmin_y = np.float64(d["TRANS_MIN"][1])
    tmin_z = np.float64(d["TRANS_MIN"][2])
    tmax_x = np.float64(d["TRANS_MAX"][0])
    tmax_y = np.float64(d["TRANS_MAX"][1])
    tmax_z = np.float64(d["TRANS_MAX"][2])
    cube_val = np.float64(d["CUBE_SIZE"]) * np.float64(2.0)


    print(f"[{name}] Parsing pixels ({block_w}x{block_h})...")
    t0 = time.time()


    manifolds = []
    skipped   = 0


    for y in range(block_h):
        for x in range(block_w):


            pa = px[y, x, 3]
            if pa < np.float64(0.01):
                skipped += 1
                continue


            pr, pg, pb = px[y, x, 0], px[y, x, 1], px[y, x, 2]
            wx = lerp_f64(tmin_x, tmax_x, pr)
            wy = lerp_f64(tmin_y, tmax_y, pg)
            wz = lerp_f64(tmin_z, tmax_z, pb)


            rr, rg, rb, ra = (px[y, x + block_w, c] for c in range(4))
            qx_ = rr * np.float64(2.0) - np.float64(1.0)
            qy_ = rg * np.float64(2.0) - np.float64(1.0)
            qz_ = rb * np.float64(2.0) - np.float64(1.0)
            qw_ = ra * np.float64(2.0) - np.float64(1.0)


            sr, sg, sb = (px[y, x + 2 * block_w, c] for c in range(3))
            sx = sr * cube_val
            sy = sg * cube_val
            sz = sb * cube_val
            if sx == np.float64(0.0) and sy == np.float64(0.0) and sz == np.float64(0.0):
                skipped += 1
                continue


            manifolds.append(make_cube_manifold(
                loc       = (wx,  wy,  wz),
                quat_wxyz = (qw_, qx_, qy_, qz_),
                scale_xyz = (sx,  sy,  sz),
            ))


    t1 = time.time()
    print(f"[{name}] {len(manifolds)} cubes built, {skipped} pixels skipped  ({t1-t0:.1f}s)")


    if not manifolds:
        print(f"[{name}] ERROR: no cubes generated — check the PNG path and metadata.")
        return


    print(f"[{name}] Boolean union (binary tree)...")
    t2 = time.time()
    result = union_tree(manifolds)
    t3 = time.time()
    print(f"[{name}] Union done in {t3-t2:.1f}s")


    out_mesh = result.to_mesh()
    tri = trimesh.Trimesh(
        vertices=out_mesh.vert_properties,
        faces=out_mesh.tri_verts,
        process=False,
    )


    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, f"{name}_manifold.obj")
    tri.export(out_path)


    t4 = time.time()
    print(f"[{name}] Exported:  {out_path}")
    print(f"[{name}] Vertices:  {len(tri.vertices):,}")
    print(f"[{name}] Faces:     {len(tri.faces):,}")
    print(f"[{name}] Total time:{t4-t0:.1f}s")
    print(f"[{name}] Manifold:  {result.status().name}")



# ── ENTRY POINT ───────────────────────────────────────────────────────────────


if __name__ == "__main__":
    if not any(True for v in DISTRICTS.values()):
        print("No districts active. Uncomment entries in DISTRICTS and set PNG paths.")
    for district_name, district_data in DISTRICTS.items():
        build_district(district_name, district_data)