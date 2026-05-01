"""
query_terrain_heights.py — Look up terrain Y at a list of CET (X, Y) coordinates.

Used to pick safe teleport Z values for the CET-Z-vs-terrain-Y experiment so
the player drops a minimal distance instead of plummeting from Z=500.

Axis mapping (per docs/coordinate-system-3d.md and the Three.js scene):
  GLB_X = +CET_X   (no flip)
  GLB_Z = -CET_Y   (NEGATED — north/south flips)
  GLB_Y = elevation (height)

NOTE: scripts/generate_terrain_contours.py uses the opposite Y convention
(no flip). Both produce visually correct output for their respective targets
(2D Leaflet vs. 3D Three.js) because each pipeline cancels the error
internally. We use the flipped convention here because we want to match
the 3D scene the user actually experiences in-game.

Usage:
  python scripts/query_terrain_heights.py
"""

import os
import numpy as np
import trimesh

GLB_PATH = r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\entities\cameras\3dmap\3dmap_terrain.glb"

# (label, cet_x, cet_y) — from docs/cet-z-terrain-experiment.csv
POINTS = [
    ("Eastern badlands",         3500, -1500),
    ("Northeast outskirts",      1500,  5000),
    ("South ranchland",         -1000, -6000),
    ("Charter Hill terrain",    -3000,  3500),
    ("Coastal desert NW",        -500,  5500),
    ("Eastern oilfield flats",   4000,     0),
]

mesh = trimesh.load(GLB_PATH, force="mesh")
print(f"Loaded {len(mesh.vertices):,} verts / {len(mesh.faces):,} faces")
print(f"GLB bbox: X[{mesh.vertices[:,0].min():.0f}, {mesh.vertices[:,0].max():.0f}] "
      f"Y[{mesh.vertices[:,1].min():.0f}, {mesh.vertices[:,1].max():.0f}] "
      f"Z[{mesh.vertices[:,2].min():.0f}, {mesh.vertices[:,2].max():.0f}]")
print()

# Cast rays straight DOWN in GLB space at (CET_X, very_high_Y, -CET_Y)
ray_origins = np.array([[x, 2000.0, -y] for _, x, y in POINTS], dtype=np.float64)
ray_dirs    = np.tile(np.array([[0.0, -1.0, 0.0]]), (len(POINTS), 1))

intersector = trimesh.ray.ray_triangle.RayMeshIntersector(mesh)
locs, idx_ray, idx_tri = intersector.intersects_location(
    ray_origins, ray_dirs, multiple_hits=False
)

# Map back: idx_ray[k] is which input ray locs[k] came from
hits_by_ray = {}
for k, ri in enumerate(idx_ray):
    hits_by_ray[int(ri)] = float(locs[k][1])  # GLB_Y is height

print(f"{'#':>2}  {'Label':<26} {'CET_X':>7} {'CET_Y':>7} {'terrain_Y':>10}  {'teleport_Z':>11}")
print("-" * 78)
for i, (label, cx, cy) in enumerate(POINTS):
    th = hits_by_ray.get(i)
    if th is None:
        print(f"{i+1:>2}  {label:<26} {cx:>7} {cy:>7} {'no hit':>10}  {'(skip)':>11}")
        continue
    # Teleport from 5m above measured terrain — minimal drop, fall damage trivial.
    tp = round(th + 5)
    print(f"{i+1:>2}  {label:<26} {cx:>7} {cy:>7} {th:>10.2f}  {tp:>11}")
