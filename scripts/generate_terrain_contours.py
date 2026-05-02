"""
generate_terrain_contours.py — Terrain elevation contour lines for the NC Zoning Board map.

Loads 3dmap_terrain.glb, interpolates face heights to a grid, and extracts elevation isolines.

Outputs:
  data/terrain_contours.json        -- Elevation isolines as Leaflet lat/lng segments
  scripts/output/terrain_contours.svg  -- SVG version on 8k canvas

Usage:
  python scripts/generate_terrain_contours.py

Dependencies:
  pip install trimesh scikit-image scipy numpy
"""

import json
import os
import sys

import numpy as np

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_DIR   = os.path.dirname(SCRIPT_DIR)
GLB_DIR    = r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\entities\cameras\3dmap"
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
DATA_DIR   = os.path.join(REPO_DIR, "data")

# ---------------------------------------------------------------------------
# Constants — imported from shared map_constants.py
# ---------------------------------------------------------------------------
from map_constants import (
    WORLD_MIN_X, WORLD_MAX_X, WORLD_MIN_Y, WORLD_MAX_Y,
    IMG_SIZE, cet_to_pixel, cet_to_leaflet,
)

CONTOUR_GRID     = 512   # grid resolution for height interpolation
N_CONTOUR_LEVELS = 12


# ---------------------------------------------------------------------------
# Load terrain face centroids
# ---------------------------------------------------------------------------

def load_terrain_heights():
    """
    Load 3dmap_terrain.glb and return per-face centroid CET coords + heights.

    Axis mapping (terrain GLB — identity transform, no world yaw):
      CET_X = +GLB_X,  CET_Y = +GLB_Z,  height = +GLB_Y

    NOTE — convention mismatch with the 3D scene:
      The Three.js scene and docs/coordinate-system-3d.md use GLB_Z = -CET_Y
      (negated). This script uses GLB_Z = +CET_Y (unflipped). The script
      still produces correct Leaflet output because the error cancels through
      cet_to_leaflet, but if you copy this code to query terrain heights for
      the 3D pipeline you MUST flip the Y sign on lookup (see
      scripts/query_terrain_heights.py for the corrected pattern).
      Validated 2026-05-01 — see wiki/learnings/cet-z-equals-terrain-y.md.
    """
    try:
        import trimesh
    except ImportError:
        sys.exit("trimesh not installed -- pip install trimesh")

    glb_path = os.path.join(GLB_DIR, "3dmap_terrain.glb")
    print(f"Loading terrain mesh: {glb_path}")
    mesh  = trimesh.load(glb_path, force="mesh")
    verts = np.asarray(mesh.vertices, dtype=np.float32)
    faces = np.asarray(mesh.faces,    dtype=np.int32)
    print(f"  {len(verts):,} vertices, {len(faces):,} faces")

    i0, i1, i2 = faces[:, 0], faces[:, 1], faces[:, 2]
    fc_x = (verts[i0, 0] + verts[i1, 0] + verts[i2, 0]) / 3.0   # CET_X = +GLB_X
    fc_y = (verts[i0, 2] + verts[i1, 2] + verts[i2, 2]) / 3.0   # CET_Y = +GLB_Z
    fc_h = (verts[i0, 1] + verts[i1, 1] + verts[i2, 1]) / 3.0   # height = +GLB_Y

    print(f"  Height range: [{fc_h.min():.1f}, {fc_h.max():.1f}] GLB_Y units")
    return fc_x, fc_y, fc_h


# ---------------------------------------------------------------------------
# Generate contours
# ---------------------------------------------------------------------------

def generate_contours(fc_x, fc_y, fc_h):
    try:
        from skimage.measure import find_contours
    except ImportError:
        sys.exit("scikit-image not installed -- pip install scikit-image")
    try:
        from scipy.interpolate import griddata
    except ImportError:
        sys.exit("scipy not installed -- pip install scipy")

    # Clip to pipeline world bounds
    in_bounds = (
        (fc_x >= WORLD_MIN_X) & (fc_x <= WORLD_MAX_X) &
        (fc_y >= WORLD_MIN_Y) & (fc_y <= WORLD_MAX_Y)
    )
    pts_xy = np.stack([fc_x[in_bounds], fc_y[in_bounds]], axis=1)
    pts_h  = fc_h[in_bounds]
    print(f"  {in_bounds.sum():,} faces within world bounds")

    # Interpolate scattered face centroids onto a regular grid
    G  = CONTOUR_GRID
    gx = np.linspace(WORLD_MIN_X, WORLD_MAX_X, G)
    gy = np.linspace(WORLD_MAX_Y, WORLD_MIN_Y, G)   # north at row 0
    gxx, gyy = np.meshgrid(gx, gy)

    print(f"  Interpolating to {G}x{G} grid ...")
    H = griddata(pts_xy, pts_h, (gxx, gyy), method="linear", fill_value=np.nan)
    nan_mask = np.isnan(H)
    if nan_mask.any():
        H_near = griddata(pts_xy, pts_h, (gxx, gyy), method="nearest")
        H = np.where(nan_mask, H_near, H)

    # Normalise using percentile clip to ignore edge artefacts
    lo, hi = np.percentile(H, 5), np.percentile(H, 95)
    if hi == lo:
        sys.exit("Heightfield has no variation — check GLB_DIR path")
    H_norm = np.clip((H - lo) / (hi - lo), 0.0, 1.0)

    levels = np.linspace(0.05, 0.95, N_CONTOUR_LEVELS)
    print(f"  Extracting {N_CONTOUR_LEVELS} contour levels ...")

    json_features = []
    svg_lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{IMG_SIZE}" height="{IMG_SIZE}" '
        f'viewBox="0 0 {IMG_SIZE} {IMG_SIZE}">',
        '  <g id="terrain_contours" fill="none" stroke="#8892b0" stroke-width="1.2" opacity="0.5">',
    ]
    total_segs = 0

    for level in levels:
        for contour in find_contours(H_norm, level):
            if len(contour) < 5:
                continue
            rows_c, cols_c = contour[:, 0], contour[:, 1]
            latlon_pts = []
            px_pts     = []
            for r, c in zip(rows_c, cols_c):
                cx = WORLD_MIN_X + (c / G) * (WORLD_MAX_X - WORLD_MIN_X)
                cy = WORLD_MAX_Y - (r / G) * (WORLD_MAX_Y - WORLD_MIN_Y)
                lat, lng = cet_to_leaflet(cx, cy)
                latlon_pts.append([round(lat, 6), round(lng, 6)])
                spx, spy = cet_to_pixel(cx, cy)
                px_pts.append((round(spx, 1), round(spy, 1)))

            json_features.append({"level": round(float(level), 4), "pts": latlon_pts})
            pts_str = " ".join(f"{x},{y}" for x, y in px_pts)
            svg_lines.append(f'    <polyline points="{pts_str}"/>')
            total_segs += 1

    svg_lines += ["  </g>", "</svg>"]

    json_path = os.path.join(DATA_DIR, "terrain_contours.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(json_features, f, separators=(",", ":"))
    print(f"  Saved -> {json_path}  ({total_segs} segments)")

    svg_path = os.path.join(OUTPUT_DIR, "terrain_contours.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write("\n".join(svg_lines))
    print(f"  Saved -> {svg_path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(DATA_DIR,   exist_ok=True)

    print("=== NC Zoning Board — Terrain Contour Generator ===\n")
    fc_x, fc_y, fc_h = load_terrain_heights()
    print()
    generate_contours(fc_x, fc_y, fc_h)
    print("\nDone.")


if __name__ == "__main__":
    main()
