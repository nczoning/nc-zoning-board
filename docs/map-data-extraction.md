# Map Data Extraction

## Overview

The game's 3D minimap renders Night City using a GPU instancing shader. Building positions, rotations, and scales are packed into per-district data textures as raw pixel values. We decode these textures to extract 2D building footprints, roads, metro lines, and district boundaries.

This pipeline was inspired by [a Reddit post](https://www.reddit.com/r/cyberpunk2077mods/comments/1rzqh2m/in_game_minimap_extraction/) that decoded the same textures into 3D OBJ meshes for 3D printing. Our version skips the 3D boolean union and projects everything to 2D instead.

> **Note:** This document covers `scripts/cp2077_extract_footprints.py` — the **2D extraction pipeline** used for district borders, roads, metro, and landmark SVGs. The **Three.js 3D building rendering** uses a completely separate pipeline that reads DDS files directly and renders via `MeshLambertMaterial`. See [`coordinate-system-3d.md`](coordinate-system-3d.md) for the 3D pipeline.

## Prerequisites

### Software

```bash
pip install numpy pypng Pillow trimesh matplotlib
```

### WolvenKit Exports

All source files must be exported from the game archive using [WolvenKit](https://wiki.redmodding.org/wolvenkit). Set your local export path at the top of each script:

```python
# In cp2077_extract_footprints.py and regenerate_subdistricts.py
GLB_DIR = r"<your WolvenKit export path>\base\entities\cameras\3dmap"
```

The scripts expect files at `<export root>\base\...` — point `GLB_DIR` and the texture/entity paths at the top of each script to wherever WolvenKit wrote the exports on your machine.

**Required exports:**

| Type | Game Path | Notes |
|------|-----------|-------|
| Building textures | `base\fx\textures\3dmap\static\*_data.xbm` | Export as PNG (16-bit, keep default settings) |
| Entity transforms | `base\entities\cameras\3dmap\3dmap_view.ent` | Convert to JSON in WolvenKit |
| Material metadata | `base\entities\cameras\3dmap\3dmap_triangle_soup.Material` | Convert to JSON |
| Road/metro meshes | `base\entities\cameras\3dmap\3dmap_roads.mesh`, `3dmap_metro.mesh` | Export as GLB |
| District icons | `base\gameplay\gui\common\icons\district_icons.xbm` + `.inkatlas` | Export PNG + convert inkatlas to JSON |

> **Warning:** Do NOT open/re-save the exported PNGs in Photoshop or any colour-managed tool. The pixel values encode coordinates — any gamma or sRGB correction will corrupt them. The script uses pypng which reads raw bytes and ignores colour profile chunks.

## Scripts

### `scripts/cp2077_extract_footprints.py`

Main extraction script. Decodes building textures, renders overlays, and produces all output files.

```bash
# Pass 1 — Analyze building positions (fast, no rendering)
python scripts/cp2077_extract_footprints.py --analyze

# Pass 2 — Full output (buildings.png, buildings.svg, buildings.json, etc.)
python scripts/cp2077_extract_footprints.py
```

**Pass 1 (`--analyze`)** decodes centre positions only and outputs:
- `scripts/output/analysis.txt` — per-district position ranges
- `scripts/output/analysis_scatter.png` — scatter plot of all building positions

Use this to verify the world extent constants (`WORLD_MIN/MAX_X/Y`) before running the full pipeline.

**Pass 2 (default)** runs the full pipeline and outputs everything listed in [Outputs](#outputs).

### `scripts/regenerate_subdistricts.py`

Regenerates `data/subdistricts.json` with proper parent-chain transforms applied. Run this after any changes to the entity transform data.

```bash
python scripts/regenerate_subdistricts.py
```

### `scripts/cp2077_3dmap_to_manifold.py` (reference)

Original Reddit script for 3D printing. Not used in the pipeline — kept as reference for the texture decoding logic.

## How It Works

### 1. Building Texture Decoding

Each district has a data texture with a 3:1 aspect ratio, divided into three horizontal blocks:

```
[  Position (RGB=XYZ, A=valid)  |  Rotation (RGBA=quaternion)  |  Scale (RGB=XYZ)  ]
```

Each pixel row encodes one building instance. Decoding:
- **Position:** `world_pos = TRANS_MIN + (TRANS_MAX - TRANS_MIN) × pixel_color + district_offset`
- **Rotation:** `quaternion = pixel_color × 2 - 1` (remap [0,1] → [-1,1])
- **Scale:** `half_extent = pixel_color × CUBE_SIZE`

The 4 corner points of each building's 2D footprint are computed by rotating the local rectangle corners by the quaternion's XY-plane projection and translating to world position.

### 2. District Offsets

Each district texture decodes positions in district-local space. The `3dmap_view.ent` entity file contains per-district world transforms that place each district into CET world space.

These offsets are defined in `DISTRICT_OFFSETS` in the script:

```python
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
```

### 3. District Classification (Trigger Polygons)

The game uses trigger area polygons to detect which district the player is in. These same polygons are used to classify each building to a district by point-in-polygon test.

**Priority order matters:** Dogtown and Spaceport are tested first (they sit inside broader texture areas).

Buildings outside all trigger polygons are classified as "badlands."

### 4. Parent Transform Chains

This is the trickiest part. Trigger polygon outline points are stored in component-local space. To convert to CET world coordinates, you must walk the full parent transform chain:

```
component → parentTransform.bindName → parent → grandparent → ...
```

At each level: **rotate** points by the component's yaw, then **translate** by its position.

Example — Pacifica's chain:
```
pacifica_trigger (offset, no rotation)
  → pacifica_transform (65° yaw + offset)  ← THIS ROTATION IS CRITICAL
    → pacifica_transform_fix (identity)
      → pacifica_data0633 (district mesh offset)
        → Transform5641 (root, identity)
```

Without walking the full chain, Pacifica's trigger polygon is oriented ~65° wrong.

Example — NCX/Spaceport's chain:
```
ncx_trigger (no offset)
  → ncx_transform (identity)
    → morro_rock_trigger (offset -3087, 556)  ← POSITION COMES FROM PARENT
      → Transform5641 (root)
```

### 5. GLB Mesh Rendering

GLB meshes are rendered in two separate passes via `render_glb_base_layer()`, which is called twice in `run_full_output()`:

1. **Roads + metro pass** (`GLB_LAYERS[:2]`) — composited under buildings
2. **Landmark pass** (`GLB_LAYERS[2:]`, `combined_label="landmarks"`) — composited over buildings, under district borders

The `combined_label` parameter controls SVG/JSON output grouping. When set, all layers are written to a single file per type. Each landmark gets its own `<g id="{label}">` (fill) and `<g id="{label}_outline">` (boundary edges) group in the SVG. The JSON uses the structure `{label: {"faces": [...], "edges": [...]}}`. When `None` (roads/metro), each layer writes its own flat file.

World placement and orientation are read from the ent JSON via `load_mesh_transforms()`.

**Axis mapping** (determined empirically — roads 180° from buildings without this):
- `-GLB_X` → CET_X (X is negated; corrects for coordinate handedness difference)
- `+GLB_Z` → CET_Y (Z maps directly to north-south)
- `+GLB_Y` → CET_Z (height — projected out, but used during 3D rotation)

**Orientation:** `load_mesh_transforms()` walks the full `parentTransform` chain for each `entMeshComponent` and accumulates the world-space orientation as a quaternion (Hamilton product up the chain). For rendering, the full quaternion is converted to a 3×3 rotation matrix and applied to the GLB vertices in CET space before projection. This correctly handles pitch and roll (e.g. the collapsed ferris wheel lying on its side) not just yaw.

**Roads/metro orientation exception:** The road and metro meshes have a **116.6° world yaw** in the ent (confirmed from entity quaternion: both instances of 3dmap_roads.mesh and 3dmap_metro.mesh). The net effect of this rotation when projected top-down is equivalent to negating the X axis, so the projection formula uses `-GLB_X` = `CET_X`. This was confirmed empirically — roads appear 180° mirrored from buildings without the negation. These meshes use `offset_key=None` in `GLB_LAYERS`, which suppresses the ent quaternion so it isn't double-applied.

**Rendering approaches per mesh type:**
- **Roads:** Fill faces at low opacity — shows grey road areas between buildings
- **Metro:** Boundary edges only (edges belonging to exactly 1 face) — clean track lines without interior mesh tessellation
- **Landmarks:** Fill faces + boundary edge outline, both using the district colour resolved from the landmark's world CET position via `classify_district()`. Alpha 200/255 for fill, 240/255 for outline — matching building visual style. Each landmark's colour is looked up at render time so it blends with the surrounding district rather than being visually distinct
- **Water:** Excluded — world-scale flat plane floods the entire canvas
- **Terrain/Cliffs:** Excluded — terrain is too large and obscures the map at 2D projection scale; `3dmap_cliffs.glb` in particular overwhelms the Dogtown/Badlands border area

### 5a. Landmark Mesh Transforms

`load_mesh_transforms()` extracts world-space position and orientation for all `entMeshComponent` entries in `3dmap_view.ent.json`. It walks the full parent chain (same pattern as `load_trigger_polygons()`), accumulating:

- **Position**: yaw-rotated and translated at each parent level → final CET (x, y)
- **Orientation**: Hamilton product of quaternions up the chain → final world quaternion

The returned dict maps component name → `(cet_x, cet_y, (qr, qi, qj, qk))`.

Use `--list-landmarks` to print all component names with resolved world positions and yaw angles, which is needed to verify or add `offset_key` values in `GLB_LAYERS`.

**Known component names for landmark GLBs** (confirmed from ent JSON):

| GLB file | ent component name | World position (CET) |
| --- | --- | --- |
| `3dmap_obelisk.glb` | `obelisk` | (-1714.5, -2331.3) |
| `monument_ave_pyramid.glb` | `monument_ave_pyramid` | (-1595.2, -2344.3) |
| `3dmap_statue_splash_a.glb` | `statue_splash_a` | (-1673.8, -2466.1) |
| `3dmap_ext_monument_av_building_b.glb` | `ext_monument_av_building_b` | (-1717.3, -2412.0) |
| `northoak_sign_a.glb` | `northoak_sign_a` | (196.9, 873.7) |
| `cz_cz_building_h_icosphere.glb` | `cz_cz_building_h_icosphere` | (-1974.8, -2701.0) |
| `rcr_park_ferris_wheel.glb` (upright) | `ferris_wheel_pacifica` | (-2442.4, -2178.0) |
| `rcr_park_ferris_wheel.glb` (collapsed) | `ferris_wheel_collapsed` | (445.2, -1672.2) |

Note: The ferris wheel in Pacifica is parented to the Pacifica transform hierarchy. Its `localTransform` in the ent stores local coordinates (-19.98, 190.11); `load_mesh_transforms()` resolves these to world CET via parent chain walking.

### 6. World Extent & Coordinate Mapping

The 8192×8192 output canvas maps to CET world space via:

```python
pixel_x = (cet_x - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X) * 8192
pixel_y = (WORLD_MAX_Y - cet_y) / (WORLD_MAX_Y - WORLD_MIN_Y) * 8192  # Y flipped
```

World extent constants were derived by inverting the existing `cetToLeaflet` formula at the four tile corners, ensuring the building output aligns with the existing night city tile set.

## Outputs

| File | Description | Size |
|------|-------------|------|
| `scripts/output/combined_8k.png` | Z-sorted composite: roads + metro + buildings + landmarks + borders | ~large |
| `scripts/output/combined.svg` | Z-sorted combined SVG — all categories, cross-category depth correct | ~17 MB |
| `scripts/output/buildings.svg` | Building footprints by district; Z-sorted within each `<g>` | ~large |
| `scripts/output/roads.svg` | Road surface fills; Z-sorted within file | ~3.6 MB |
| `scripts/output/metro.svg` | Metro track boundary edges; Z-sorted within file | ~0.9 MB |
| `scripts/output/landmarks.svg` | Landmark fills and outlines as `<g id="label">` / `<g id="label_outline">`; Z-sorted within each group | ~5.5 MB |
| `scripts/output/district_borders.svg` | District boundary outlines from trigger polygons | ~6 KB |
| `data/buildings.json` | Building polygons by district; each polygon: `{"z": float, "pts": [[lat,lng],...]}` — **gitignored, no longer used by the Three.js 3D view** | ~13 MB |
| `data/roads.json` | Road face polygons; each entry: `{"z": float, "pts": [[lat,lng],...]}` | ~3.7 MB |
| `data/metro.json` | Metro edge segments; each entry: `{"z": float, "pts": [[lat,lng],[lat,lng]]}` | ~0.7 MB |
| `data/landmarks.json` | `{label: {"faces": [{"z":,"pts":},...], "edges": [{"z":,"pts":},...}]}}` | ~5.0 MB |
| `data/subdistricts.json` | District + sub-district boundary polygons in CET coords | ~small |

### Output Statistics (as of 2026-04-01)

- **255,220** total building instances decoded across 8 district textures (no area filter — all instances extracted)
- **236,010** classified into districts, **19,210** classified as badlands
- All buildings include `hz` (height half-extent) for shadow/extrusion rendering
- **8** landmark meshes with names and district classification
- **8** district-level trigger polygons, **16** city sub-district polygons, **10** Badlands sub-district polygons (from streaming sectors)
- **1** non-canonical sub-district: North Oaks Casino (cut content, Westbrook)

### Delivery

Terrain and satellite base layers are delivered as WebP `L.imageOverlay` files (no tiles):

| File | Size | Notes |
|------|------|-------|
| `assets/img/terrain_8k.webp` | 290 KB | Schematic terrain, neutral dark grey |
| `assets/img/satellite_8k.webp` | 9.6 MB | Satellite photograph, RGBA with transparency |

Overlay data (roads, buildings, metro, landmarks) is rendered via a canvas-based `L.GridLayer` (`overlay.js`) with unified z-sorted drawing and grid-based spatial index. (Note: this section describes the legacy 2D overlay; the current schema view uses the live Three.js scene — see [`three-js-scene.md`](three-js-scene.md).)

## District Colours (from game Ink styles)

| District | Hex | Colour | Source |
|----------|-----|--------|--------|
| City Center | `#ffd741` | Yellow | MainColors.Yellow |
| Watson | `#ff3e34` | Red | MainColors.CombatRed |
| Westbrook | `#ff5100` | Orange | MainColors.Orange |
| Heywood | `#1ded83` | Green | MainColors.Green |
| Santo Domingo | `#5ef6ff` | Cyan | MainColors.Blue |
| Pacifica | `#ff6158` | Pink-red | MainColors.Red |
| Dogtown | `#00a32c` | Dark green | MainColors.DarkGreen |
| Morro Rock | `#349197` | Teal | MainColors.MildBlue |
| Badlands | `#c882ff` | Violet | Custom (visibility on desert) |

## Troubleshooting

### Buildings clustered in the centre
Missing or wrong district offsets. Check `DISTRICT_OFFSETS` against the `localTransform.Position.Bits / 131072` values in `3dmap_view.ent.json`.

### Buildings 2× too large
The 2D script uses `CUBE_SIZE` directly as the half-extent multiplier. The 3D script uses `CUBE_SIZE × 2` because it applies ±0.5 cube vertices. Don't double it for 2D.

### Roads rotated 180°
GLB axis mapping requires negating the X axis: `-GLB_X → CET_X`. Without this, roads appear upside down relative to buildings.

### Pacifica trigger polygon oriented wrong
The `pacifica_transform` component has a 65° yaw rotation. The `load_trigger_polygons()` function must walk the full parent chain and apply rotation at each level.

### District borders SVG same as roads
`3dmap_roads_borders.glb` is road geometry, not district borders. True district boundaries come from the trigger area polygon data in `3dmap_view.ent.json`.

### Colour-corrupted coordinates
The source PNGs must be loaded as raw bytes. Any colour management (gamma, sRGB) applied by image editors or Python libraries will corrupt the encoded position data. Use pypng, not Pillow/OpenCV, for loading.
