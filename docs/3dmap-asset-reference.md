# 3D Map Asset Reference

This document is a complete reference for all exported files from the CP2077 3D minimap entity. After exporting from WolvenKit, the relevant files are under:

```text
<your export root>\base\entities\cameras\3dmap\
```

Set `GLB_DIR` at the top of `scripts/cp2077_extract_footprints.py` to point at this folder on your machine.

For the pipeline overview and how these assets are used in extraction, see [map-data-extraction.md](map-data-extraction.md).

## Asset Inventory

All files are exported from the game archive using WolvenKit. The table below covers every file in the folder, its type, whether it is referenced in `3dmap_view.ent.json`, and its status in the extraction pipeline.

| File | Type | In ent JSON | Pipeline status | Notes |
| --- | --- | --- | --- | --- |
| `3dmap_view.ent.json` | Entity template | — | **Used** | Master component hierarchy; defines all transforms, triggers, and mesh placements |
| `3dmap_triangle_soup.glb` | Visual mesh | Yes | **Used** | District-colored fill mesh; 8 `meshAppearance` variants (one per district) |
| `3dmap_roads.glb` | Visual mesh | Yes | **Used** | Road surface mesh (~56k faces); rendered as low-opacity fill |
| `3dmap_metro.glb` | Visual mesh | Yes | **Used** | Metro track mesh; rendered as boundary edges (edges with exactly 1 face) |
| `3dmap_roads_borders.glb` | Visual mesh | Yes | Not used | In-game UI road border overlay — **not district boundaries**; same geometry class as roads |
| `3dmap_terrain.glb` | Visual mesh | Yes | Excluded | Full terrain mesh (247k verts); too large for 2D projection, dark background serves the same purpose |
| `3dmap_water.glb` | Visual mesh | Yes | Excluded | World-scale flat plane; projects to fill the entire canvas |
| `3dmap_cliffs.glb` | Visual mesh | Yes | Excluded | Terrain geometry — overwhelms the Dogtown/Badlands border area at 2D projection scale |
| `3dmap_obelisk.glb` | Landmark mesh | Yes | **Rendered** | Dogtown obelisk; written to `landmarks.svg` / `data/landmarks.json` |
| `3dmap_statue_splash_a.glb` | Landmark mesh | Yes | **Rendered** | Dogtown statue on the plaza |
| `3dmap_ext_monument_av_building_b.glb` | Landmark mesh | Yes | **Rendered** | Dogtown AV building monument |
| `northoak_sign_a.glb` | Landmark mesh | Yes | **Rendered** | North Oak area sign (Westbrook); ~33° world yaw |
| `rcr_park_ferris_wheel.glb` | Landmark mesh | Yes | **Rendered** | Two instances: upright (Pacifica) and collapsed (Santo Domingo border) |
| `monument_ave_pyramid.glb` | Landmark mesh | Yes | **Rendered** | Monument Avenue pyramid (Dogtown) |
| `cz_cz_building_h_icosphere.glb` | Landmark mesh | Yes | **Rendered** | Dogtown icosphere on a landmark building |
| `mappin_geo_bulb.glb` | Utility mesh | Yes | Skip | 3D map pin teardrop geometry; used for the in-game hover tooltip pin, not needed for 2D |
| `3dmap_coll_buildings.glb` | Collision mesh | Yes | Skip | Simplified building collision hull; no visual data |
| `3dmap_coll_buildings2.glb` | Collision mesh | Yes | Skip | As above |
| `3dmap_coll_buildings3.glb` | Collision mesh | Yes | Skip | As above |
| `3dmap_coll_roads.glb` | Collision mesh | Yes | Skip | Road collision hull; no visual data |
| `3dmap_coll_santo.glb` | Collision mesh | **No** | Skip | On disk but **not referenced anywhere in `3dmap_view.ent.json`** — see anomaly note below |
| `3dmap_mesh_static.mi.json` | Material instance | Yes (resolvedDeps) | Reference only | Shader parameter overrides for the triangle soup mesh — see material files section |
| `3dmap_terrain.mi.json` | Material instance | Yes | Reference only | Shader params for terrain |
| `3dmap_water.mi.json` | Material instance | Yes | Reference only | Shader params for water |
| `3dmap_highlight_off.effect.json` | Visual effect | Yes | Skip | District de-highlight animation — see effect files section |
| `3dmap_highlight_on.effect.json` | Visual effect | Yes | Skip | District highlight animation — see effect files section |

## Building Instance Textures

The building instance textures live in a separate folder from the GLBs:

```text
base\fx\textures\3dmap\static\
```

Each district has two textures:

| File pattern | Format | Content |
| --- | --- | --- |
| `*_data.xbm` / `*_data.dds` | DXGI_FORMAT_R16G16B16A16_UNORM (16-bit RGBA) | Per-instance position, rotation, scale. Three 1:1 horizontal blocks: Position \| Rotation \| Scale. Each pixel row = one building. |
| `*_m.xbm` / `*_m.dds` | DXGI_FORMAT_R8_UNORM (8-bit greyscale) | Surface detail baked top-down view of the district. Applied to building cube surfaces via world-space planar UV. |

The `*_data` textures use the `3d_map_cubes.mt` GPU instancing shader. The decode parameters (CubeSize, TransMin, TransMax) are in `3dmap_triangle_soup.Material.json` — one entry per district.

**`*_data.dds` block layout** (blockW = width / 3):

| Block | Columns | Channels |
| --- | --- | --- |
| Position | 0..blockW | RGB = XYZ world position (transMin→transMax), A = validity |
| Rotation | blockW..2×blockW | RGBA = quaternion XYZw, remapped [0,1] → [-1,1] |
| Scale | 2×blockW..3×blockW | RGB = XYZ half-extents × cubeSize |

**sw5 / nw4 — legacy:** `sw1_data.xbm` (used by `sw5` material) has no TransMin/TransMax in `3dmap_triangle_soup.Material.json` and is not referenced in `3dmap_view.ent.json`. `nw4_data.xbm` is similarly unreferenced. Both are considered legacy and are not decoded by the current pipeline.

**Export format:** WolvenKit exports `*_data.xbm` as DDS with a DX10 extended header (128 byte standard header + 20 byte DX10 extension = 148 bytes before pixel data). Use `Uint16Array(buffer, 148)` to access raw pixel values.

## Effect Files (`.effect.json`)

`3dmap_highlight_on.effect.json` and `3dmap_highlight_off.effect.json` define the animated district highlight that plays in the in-game minimap UI when the player enters or leaves a district zone. They drive opacity and color transitions on the triangle soup mesh appearances.

**These are not useful for static map generation.** The pipeline applies district colors directly in Python — the in-engine animation system is bypassed entirely.

## Material Instance Files (`.mi.json`)

Material Instance (`.mi`) files are shader parameter overrides. They reference a base shader and specify texture maps, colors, opacity values, and other render properties. In-engine, `3dmap_mesh_static.mi` provides the visual style for the triangle soup district fills — translucent colored faces over the map canvas.

**These are not needed for the Python extraction pipeline.** Colors are applied directly when rendering to the 8k canvas; there is no shader system to configure.

If you ever need to match the exact in-game visual style (e.g. for a tile set that closely mirrors the game's own minimap), these files contain the color and opacity values used by the original renderer.

## Collision Meshes

All `3dmap_coll_*.glb` files are simplified collision hulls used by the game's physics system to detect player position for the minimap zoom transitions. They contain no vertex color or visual data — skip them entirely.

### The `3dmap_coll_santo.glb` Anomaly

This collision file exists on disk but is **not referenced anywhere in `3dmap_view.ent.json`**. Every other collision mesh has a corresponding `entPhysicsDestructionComponent` or `entColliderComponent` entry in the entity template. `coll_santo` does not.

Possible explanations:

- A leftover from a cut feature (perhaps a separate Santo Domingo collision pass that was merged into the main `coll_buildings` meshes)
- An export artifact from WolvenKit picking up a file that wasn't properly cleaned up
- A variant that was replaced by `coll_buildings3` in a later game patch

It is a non-visual collision mesh regardless, so it can be safely skipped.

## Landmark Meshes — Pipeline Status

The landmark GLBs are decorative 3D models placed at recognisable locations on the in-game minimap. All are now rendered by the extraction pipeline as filled top-down silhouettes composited **over buildings and under district borders** in `combined_8k.png`.

All landmarks are written to single combined outputs (`scripts/output/landmarks.svg`, `data/landmarks.json`). Each landmark gets a fill group `<g id="{label}">` and an outline group `<g id="{label}_outline">` in the SVG. The JSON uses `{label: {"faces": [...], "edges": [...]}}` — faces for fill polygons, edges for boundary outline segments.

**Landmark colours** are not hardcoded. At render time, each landmark's world CET position is tested against the district trigger polygons via `classify_district()`, and the matching district colour from `DISTRICT_COLORS` is used for both fill (alpha 200) and outline (alpha 240). This means landmarks blend visually with the district they sit in rather than standing out as a separate layer.

World placement and orientation are extracted automatically from `3dmap_view.ent.json` by `load_mesh_transforms()`. Run `--list-landmarks` to print all `entMeshComponent` names with resolved world CET positions and yaw angles.

**Full 3D rotation is applied**: the quaternion from each component's `localTransform.Orientation` is accumulated through the parent chain (Hamilton products) and applied to vertices as a 3×3 rotation matrix in CET space before projection. This correctly handles pitch and roll, not just yaw — the collapsed ferris wheel lying on its side is one example where this matters.

| Mesh | ent component name | Location | Pipeline status | Notes |
| --- | --- | --- | --- | --- |
| `3dmap_obelisk.glb` | `obelisk` | Dogtown | **Rendered** | Tall obelisk near the center |
| `3dmap_statue_splash_a.glb` | `statue_splash_a` | Dogtown | **Rendered** | Dogtown statue on the plaza |
| `3dmap_ext_monument_av_building_b.glb` | `ext_monument_av_building_b` | Dogtown | **Rendered** | AV building silhouette |
| `northoak_sign_a.glb` | `northoak_sign_a` | North Oak (Westbrook) | **Rendered** | Entrance arch gate; has ~33° world yaw |
| `rcr_park_ferris_wheel.glb` | `ferris_wheel_pacifica` | Pacifica | **Rendered** | Upright ferris wheel; parented to Pacifica hierarchy — `localTransform` is local, not world space |
| `rcr_park_ferris_wheel.glb` | `ferris_wheel_collapsed` | Santo Domingo border | **Rendered** | Collapsed (on its side); world position (445, -1672) |
| `monument_ave_pyramid.glb` | `monument_ave_pyramid` | Dogtown | **Rendered** | Monument Avenue pyramid |
| `cz_cz_building_h_icosphere.glb` | `cz_cz_building_h_icosphere` | Dogtown | **Rendered** | Icosphere on a landmark building |
| `3dmap_cliffs.glb` | `3dmap_cliffs` | Dogtown/Badlands border | **Excluded** | Terrain geometry — overwhelms the border area at 2D projection scale and adds no landmark value |

**Composite layer order** (bottom to top in `combined_8k.png`):

1. Roads + metro (`GLB_LAYERS[:2]`, rendered first)
2. Building footprints (colour-coded by district)
3. Landmark silhouettes (`GLB_LAYERS[2:]`, rendered over buildings so they remain visible)
4. District borders (always topmost)

**Axis mapping for landmark GLBs:**

- `-GLB_X` → CET_X
- `+GLB_Z` → CET_Y
- `+GLB_Y` → CET_Z (height — projected out, but participates in 3D rotation before projection)

## Why `3dmap_roads_borders.glb` Is Not District Borders

A common point of confusion: `3dmap_roads_borders.glb` sounds like it should contain district boundary outlines, but it does not. It is the road border overlay — a slightly wider version of the road geometry used by the in-game renderer to paint a darker edge around road surfaces for visual depth.

**True district boundaries** come from the `gameStaticTriggerAreaComponent` entries in `3dmap_view.ent.json`. These trigger areas define the polygonal regions the game uses to detect which district the player is in. The extraction pipeline converts these to world-space polygons (with full parent chain resolution) and exports them as `district_borders.svg` and `data/subdistricts.json`.

## Transform Chain Quick Reference

Trigger polygon outline points are stored in component-local space. To place them in CET world space, walk the full `parentTransform.bindName` chain from the trigger component up to the root, applying rotation then translation at each level.

The chains that require special attention (non-trivial parents):

### Pacifica district and sub-districts

```text
pacifica_trigger
  → pacifica_transform        pos: (939.909, 319.285)  quat yaw: ~65°
    → pacifica_transform_fix  identity
      → pacifica_data0633     pos: (-2422.441, -2368.156)
        → Transform5641       root (identity)
```

`coastview_trigger` and `west_wind_estate_trigger` are also parented (via intermediate nodes) to `pacifica_transform_fix`, so they inherit the same 65° rotation.

### NCX / Spaceport

```text
ncx_trigger
  → ncx_transform        identity
    → morro_rock_trigger  pos: (-3087.360, 556.390)
      → Transform5641     root (identity)
```

NCX and Morro Rock share the same outline polygon — they represent the same physical area.

### Dogtown

`dogtown_transform` position: `(2422.441, 2368.156)`, parent: `pacifica_transform_fix`. Note that this is the exact negation of `pacifica_data0633`'s offset, which is intentional — Dogtown's coordinate space is the inverse of Pacifica's.

### Quaternion Yaw Extraction

For any component with a non-identity quaternion `(i, j, k, r)`:

```python
yaw_rad = math.atan2(2 * (r*k + i*j), 1 - 2 * (j**2 + k**2))
```

Apply rotation around the component origin first, then translate by the component's position. Repeat for each parent up the chain.

### Position Bit Format

All `localTransform.Position` values in the ent JSON use a fixed-point format:

```python
world_pos = bits_value / 131072.0
```
