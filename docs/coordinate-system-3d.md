# Three.js 3D Scene — Coordinate System Reference

Everything discovered about how CP2077's 3D map assets relate to CET game coordinates and how they should map into Three.js.

## The Three Coordinate Systems

### A. CET / Gameplay Coordinates
What `GetPlayer():GetWorldPosition()` returns. What mod authors use. What our location JSON files store.
- **X** = east/west
- **Y** = north/south  
- **Z** = height above sea level (elevation)
- World extent: X[-6298, 5815], Y[-7684, 4427], Z[0, ~500]
- This is our **source of truth** — all NC Zoning Board data uses CET coordinates.

### B. GLB / Engine Rendering Coordinates
What the WolvenKit-exported GLB meshes (terrain, roads, water, cliffs, metro) use internally.
- **GLB_X** = CET_X (east/west, same axis, same units, same origin)
- **GLB_Z** = -CET_Y (north/south, negated)
- **GLB_Y** = elevation (height) — positive Y is upward (correct rendering)
- Terrain bbox: X[-8000, 8000], Y[-99, 879], Z[-8000, 8001]
- The terrain covers MORE area than the CET world bounds (extra ocean and outer badlands). CET coordinates sit inside the terrain's XZ range at 1:1 scale — **there is no scaling factor**, the terrain just extends further.

### C. Building Instance Texture Coordinates
Decoded from `*_data.png` textures via `TRANS_MIN/MAX` and `CUBE_SIZE` values.
- Position: `cetX = TRANS_MIN_X + (TRANS_MAX_X - TRANS_MIN_X) * R_channel + DISTRICT_OFFSET_X`
- Position: `cetY = TRANS_MIN_Y + (TRANS_MAX_Y - TRANS_MIN_Y) * G_channel + DISTRICT_OFFSET_Y`
- Position: `cetZ = TRANS_MIN_Z + (TRANS_MAX_Z - TRANS_MIN_Z) * B_channel` (no Z offset)
- Scale: `half_width = R_scale * CUBE_SIZE`, `half_depth = G_scale * CUBE_SIZE`, `half_height = B_scale * CUBE_SIZE`
- Rotation: quaternion from Block 2, used for yaw extraction
- These decode directly to **CET coordinates** — verified against player CET Z positions (within 1–6 units).

## Coordinate System Validation

The GLB Y axis correctly represents elevation (positive = upward). Terrain and building positions render at the correct heights with proper shading and ordering.

## Verified Data Relationships

### CET XZ vs Terrain GLB XZ
Terrain GLB XZ coordinates ARE CET coordinates at 1:1 scale. The "1.32× ratio" previously observed was simply the terrain mesh extending 1700 units beyond the CET playable bounds on each side (ocean/outer terrain). Verified by:
- District borders (CET coordinates) aligning correctly with terrain features
- Building XY positions matching in-game map layout exactly (Biotechnica Flats diagonal rows)
- Known CET locations (Koi Fish, Pier, Nash Hideout) corresponding to correct terrain positions

### CET Z vs Terrain GLB Y (elevation)

**CET Z and terrain GLB Y are in the same coordinate space.** Validated 2026-05-01 via in-game teleport experiment to five terrain-only locations across the map:

| Location | CET (X, Y) | Recorded CET Z | Terrain GLB Y | Delta |
| --- | --- | --- | --- | --- |
| Eastern badlands | (3500, −1500) | 112.40 | 106.61 | +5.79 |
| Northeast outskirts | (1500, 5000) | 181.49 | 186.17 | −4.68 |
| South ranchland | (−1000, −6000) | 106.14 | 104.20 | +1.94 |
| Charter Hill (oilfield) | (−3000, 3500) | 0.72 | 0.02 | +0.70 |
| Coastal desert NW (clipped, est.) | (−500, 5500) | 243.41 | 247.01 | −3.60 |

All five samples agree within ±6m. The delta is consistent with:

- Player eye/hip height (~1.5m above the foot's contact point)
- Terrain mesh LOD smoothing (small bumps and valleys averaged)
- Slope-induced sliding before the position read

**No systematic offset, no scaling factor.** Pin placement in 3D can use CET Z directly with a small visual lift; no terrain raycast needed.

#### Earlier (incorrect) measurement

A previous version of this doc listed an "elevation gap" of 7–23m between CET Z and terrain GLB Y, derived from samples at the Pier, Koi Fish, and Nash Hideout. Those readings were taken on top of buildings/platforms, not on bare terrain — they measured infrastructure height, not a coordinate-space mismatch. Findings retracted.

See: `docs/cet-z-terrain-experiment.md` (the validation experiment), `docs/cet-z-terrain-experiment.csv` (raw data).

### Building Rotation
Buildings have per-instance quaternion rotations (Block 2 of instance texture). All four components (qx, qy, qz, qw) are kept — pitch and roll are used by the game shader to form non-upright primitives (wedges, ramps, bridges, gap-fillers), not just upright buildings.

Applied in Three.js with CET→Three.js axis remapping:

```javascript
dummy.quaternion.set(gQx, gQz, -gQy, gQw);
// CET X → Three.js X (unchanged)
// CET Z → Three.js Y (CET up becomes Three.js up)
// CET Y → Three.js -Z (CET north becomes Three.js -forward)
```

Verified: yaw-only case (gQx≈0, gQy≈0) reduces to `set(0, sin(θ/2), 0, cos(θ/2))` — a pure Three.js Y rotation matching the previously verified Biotechnica Flats orientation.

## The HLSL Shader (`minimap_instance_shader.hlsl`)

The game's vertex shader decodes building positions from the instance texture and transforms them through matrix `_25_m0` (entity world transform, a runtime constant buffer we can't export from WolvenKit). Key lines:

```hlsl
// Decode instance center from texture
_243 = (TRANS_RANGE_X * texture_R) + TRANS_MIN_X;  // center X
_244 = (TRANS_RANGE_Y * texture_G) + TRANS_MIN_Y;  // center Y (CET north)
_245 = (TRANS_RANGE_Z * texture_B) + TRANS_MIN_Z;  // center Z (elevation)

// Apply cube vertex offset (rotated + scaled by CUBE_SIZE)
_414 = vertex_offset_x * CUBE_SIZE + _243;
_415 = vertex_offset_y * CUBE_SIZE + _244;
_416 = vertex_offset_z * CUBE_SIZE + _245;

// Transform through world matrix (_25_m0) then view-projection (_15_m0)
```

The `_25_m0` matrix handles the CET→engine coordinate conversion that we bypass.

## Available Texture Assets

In `map_data_export/source/raw/base/worlds/03_night_city/sectors/`:

| File | Size | Format | Description |
|------|------|--------|-------------|
| `world_map_albedo.png` | 2.1 MB | 1008×1016 RGBA | Base color texture |
| `world_map_depth.png` | 243 KB | 1008×1016 Greyscale | Height/elevation map |
| `world_map_normal.png` | 1.5 MB | 1008×1016 RGBA | Normal map |

The depth map provides CET Z approximations at any XY location (linear fit: `CET_Z ≈ 0.83 * pixel_value - 7.6`, errors ±5 units).

## Decompiled Script References

From `cyberpunk-decompiled-scripts/cyberpunk/UI/fullscreen/map/worldMap.swift`:
- Camera modes: TopDown (orthographic) and ZoomLevels
- Max tilt: ~70° (TweakDB maxPolarAngle)
- Default yaw: -45° (game map rotated 45° from north, we use 0° = north-up)
- Zoom range: 800 (in) to 15000 (out), default 3000
- District view states: None, Districts, SubDistricts

## Data Pipeline — Evolution

### Generation 1 (obsolete): Python script → JSON → InstancedMesh

```
*_data.png (WolvenKit 8-bit PNG export — precision loss from 16-bit source)
    ↓ scripts/build_buildings_3d.py
    ↓   Decodes position/rotation/scale; samples _m.png for per-instance brightness
    ↓
data/buildings_3d.json  [cetX, cetY, cetZ, width, depth, height, brightness, districtIdx, qx, qy, qz, qw]
    ↓ loadBuildings() in three-scene.js
    ↓   CPU loop: setMatrixAt() per instance
    ↓
RawShaderMaterial + InstancedMesh → shadow workarounds required
```

**Precision problem**: 8-bit PNG exports introduced ~9.4 CET units of position error.
Circular ring structures appeared jumbled. Terrain raycasting (`fix_building_heights.py`)
was added to correct Y positions but was solving a camera configuration issue, not a data
problem, and was later removed.

### Generation 2 (obsolete): xbm.json → GPU instancing via DataTexture

```
*_data.xbm.json (WolvenKit JSON sidecar — 16-bit RGBA base64 in textureData.Bytes)
    ↓ loadXbmDataTexture() → Uint16 → Float32 → THREE.DataTexture
    ↓
RawShaderMaterial BUILDING_VERT reads via gl_InstanceID + texelFetch()
    → position: transMin + (transMax - transMin) × posRaw.rgb + offset
    → quaternion: rotRaw * 2.0 - 1.0 (remap [0,1] → [-1,1])
    → scale: sclRaw.rgb × cubeSize

*_m.xbm.json (BC4/RGTC1 compressed, 10 mip levels)
    ↓ loadXbmMTexture() → JS BC4 decompressor → float DataTexture
    ↓
RawShaderMaterial BUILDING_FRAG: planar UV + Lambert + edge highlight
```

**Why replaced**: Full 16-bit precision achieved (error ~0.036 CET units). But
`RawShaderMaterial` required custom `customDepthMaterial` + `packDepthToRGBA` matching
Three.js's exact algorithm, identity matrix workarounds for shadow bounding spheres, and
`frustumCulled = false`. No shadow receiving. Non-standard for contributors.

### Generation 3 (current): DDS binary → CPU matrices → MeshLambertMaterial

```
assets/dds/*_data.dds  (DXGI_FORMAT_R16G16B16A16_UNORM — raw binary, DX10 header)
    ↓ loadDataDds() → fetch → Uint16Array (skip 148-byte DX10 header)
    ↓ CPU decode: position / quaternion / scale per valid pixel
    ↓ setMatrixAt() → InstancedMesh with correct bounding sphere
    ↓
MeshLambertMaterial + onBeforeCompile
    → Shadow casting + receiving via standard Three.js (no customDepthMaterial)
    → Correct bounding sphere → frustum culling works automatically
    → onBeforeCompile patches: world-space planar UV, _m texture, edge highlight

assets/dds/*_m.dds  (DXGI_FORMAT_R8_UNORM — 8-bit greyscale, DX10 header)
    ↓ loadMDds() → Uint8Array (mip 0) → DataTexture (RedFormat, generateMipmaps)
    ↓
Fragment shader samples surface detail via world-space planar UV
```

DDS files are ~25% smaller than xbm.json (no base64 overhead). Standard material means
any Three.js contributor can understand and maintain the building rendering without
needing to understand the custom GPU instancing approach.
