# Three.js 3D Scene: Reference Documentation

Full documentation for the Three.js schematic view. For pending phase-by-phase work see the [GitHub Project](https://github.com/users/spuddeh/projects/1) (WebGPU Migration stream). For the overall app architecture see [`architecture.md`](architecture.md).

---

## Overview

The NC Zoning Board has two map views that share the same sidebar, filters, and mod data:

| View | Container | Technology | Purpose |
|------|-----------|------------|---------|
| Satellite | `#map` | Leaflet.js | Real satellite tile layer with location pins |
| Schematic | `#map-3d` | Three.js | Live 3D scene: terrain, buildings, roads, pins |

Only one container is visible at a time. Neither is destroyed on switch: Leaflet state persists and the Three.js scene stays in GPU memory. The Three.js render loop pauses when `#map-3d` is hidden.

---

## File Structure

```
assets/js/
  constants.js      - NCZ namespace + all shared constants (unchanged)
  utils.js          - Pure utility functions including shared popup/filter logic
  services.js       - Nexus API + data loading (unchanged)
  three-scene.js    - Three.js scene: renderer, camera, GLB loading, materials, render loop
  three-markers.js  - 3D pin/popup/tooltip/cluster layer (NCZ.ThreeMarkers). See three-markers.md.
  app.js            - Main app: Leaflet init, DOM events, view switching
```

### Load order in `index.html`

```
constants.js (regular script)
utils.js (regular script)
services.js (regular script)
three-scene.js (type="module")
three-markers.js (type="module")
app.js (regular script)
```

`type="module"` scripts are deferred by default and always execute before the subsequent regular `app.js` script, even though they appear earlier in the file.

### Why two Three.js files

`three-scene.js` owns the renderer: it has no knowledge of mod data. `three-markers.js` owns the pins: it reads mod data and calls into the scene to position things, but doesn't control the renderer. This mirrors the existing `services.js` / `app.js` split: data vs. DOM. You can iterate on hover/click behaviour in `three-markers.js` without touching the scene, and vice versa.

### Namespaces

Both files write to `window.NCZ` so `app.js` (a regular script) can access them:

```javascript
// three-scene.js
window.NCZ.ThreeScene = { init, loadTerrain, startRenderLoop, stopRenderLoop, ... };

// three-markers.js
window.NCZ.ThreeMarkers = {
  attach, setMods, applyFilters, focusMod,
  setPulse, setClusterClickHandler, setClustersChangedHandler,
  setActiveClusterMods, getVisibleModIds, closePopup, render, onResize,
};
// Full API + lifecycle: see three-markers.md
```

---

## Three.js Setup

### Import map

Three.js is loaded via an import map in `index.html`:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
  }
}
</script>
```

This lets module scripts use bare specifiers without a bundler:

```javascript
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
```

### Renderer

`WebGLRenderer` fills `#map-3d`. A `CSS2DRenderer` is layered on top (same size, `position: absolute`, `pointerEvents: none`) to render pin DOM elements in screen space.

### Camera

Orthographic camera, top-down by default, right-click to tilt (via OrbitControls). Zoom adjusts the frustum dimensions rather than moving the camera position along Z.

```javascript
controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
controls.minPolarAngle = 0;             // top-down
controls.maxPolarAngle = Math.PI * 0.39; // ~70° max tilt
controls.enableDamping = true;
```

Camera frustum is derived from the terrain mesh bounding box after loading, not from hardcoded WORLD constants. This lets the game geometry define the viewport, matching exactly what the in-game map camera sees.

TweakDB values from `map_data_export/source/raw/nczoning_tweakdb_map_data.json`:
- Default yaw: **-45°** (in-game map is rotated 45° from north)
- Yaw range: -85° to -30°
- Zoom: min=800, max=10500, default=3000
- FOV: 25 (fixed)

The web map defaults to north-up (yaw 0°) rather than -45° because it's more intuitive for comparison with the satellite view.

### Lighting

Hillshade matching the in-game map appearance:
- `DirectionalLight` from NW direction `(-1, 1.5, -1)` for hillshading
- `AmbientLight` at 0.35 intensity

### Theme support

Material colours are read from CSS custom properties at scene init and on theme change:

```javascript
function readThemeColor(varName) {
  return new THREE.Color(
    getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  );
}
```

When the user switches theme, `NCZ.ThreeScene.updateMaterials()` is called to re-read all CSS vars and update material colours. This means the 3D scene is fully theme-aware: terrain, water, roads, and buildings all respond to theme switches.

---

## Coordinate System

For full details on the three coordinate systems (CET, GLB, building instance textures) and how they relate, see [`coordinate-system-3d.md`](coordinate-system-3d.md).

### Camera Up Vector

The camera uses the standard Three.js up vector `up=(0,1,0)`. This ensures correct rendering at all camera angles: when tilted, the Y-axis orientation is preserved and buildings correctly extend upward from terrain.

### CET → Three.js mapping

```javascript
NCZ.cetToThree = function(cetX, cetY, cetZ) {
  return [cetX, cetZ || 0, -cetY];
};
```

CET and GLB share the same XZ coordinate space at 1:1 scale. The terrain GLB extends beyond CET world bounds (extra ocean/outer terrain) but coordinates within the city area match exactly.

---

## GLB Assets

The runtime loads from `assets/glb-meshopt/` (gltfpack-compressed). The repo only commits this folder. Source GLBs (uncompressed WolvenKit exports) live at `assets/glb-source/` which is **gitignored**. Drop fresh exports there before running `npm run encode-meshopt`. The runtime path is the `NCZ.GLB_DIR` constant in [`assets/js/constants.js`](../assets/js/constants.js).

Loaded in tiers so the scene is interactive as quickly as possible.

| File | Source (uncompressed) | Shipped (meshopt) | Tier | Notes |
|------|----------------------:|------------------:|------|-------|
| `3dmap_terrain.glb` | 6.4 MB | **423 KB** | 1 (required) | Terrain surface, 247k verts (sub-meshes merged by gltfpack) |
| `3dmap_water.glb` | ~5 KB | ~2 KB | 1 (required) | Water plane with land cutouts; writes stencil=2 |
| `3dmap_cliffs.glb` | 3.4 MB | 891 KB | 1 (with terrain) | Dogtown cliff faces |
| `3dmap_roads.glb` | 1.4 MB | 223 KB | 2 (idle) | Road surfaces, loaded twice (see Roads section) |
| `3dmap_roads_borders.glb` | 5.9 MB | **357 KB** | 2 (idle) | Road border outlines, loaded twice |
| `3dmap_metro.glb` | 530 KB | 69 KB | 2 (idle) | Metro tracks with vertex-color LOD |
| `3dmap_obelisk.glb` | 175 KB | 32 KB | 3 (with buildings) | The Needle, Dogtown |
| `monument_ave_pyramid.glb` | 4 KB | 2 KB | 3 (with buildings) | Heavy Hearts Club, Dogtown |
| `3dmap_statue_splash_a.glb` | 542 KB | 121 KB | 3 (with buildings) | De-votion statue, Dogtown |
| `3dmap_ext_monument_av_building_b.glb` | 364 KB | 55 KB | 3 (with buildings) | Brainporium, Dogtown |
| `northoak_sign_a.glb` | 124 KB | 20 KB | 3 (with buildings) | North Oak arch gate, Westbrook |
| `cz_cz_building_h_icosphere.glb` | 70 KB | 16 KB | 3 (with buildings) | Brave Atlas, Dogtown |
| `rcr_park_ferris_wheel.glb` | 86 KB | 22 KB | 3 (with buildings) | Used twice: upright (Pacifica) + collapsed (Santo Domingo border) |
| **Total** | **18.5 MB** *(not in repo)* | **2.18 MB (-88%) committed** | | |

Tier 1 loads in parallel on scene init. Tier 2 loads after Tier 1 resolves, during idle. Tier 3 loads after Tier 2.

### Compression pipeline: gltfpack/meshopt

GLBs are compressed with [`gltfpack`](https://github.com/zeux/meshoptimizer/tree/master/gltf) (from the meshoptimizer project). The runtime loads them via the `MeshoptDecoder` bundled with three.js examples: no extra dependency, ~30 KB WASM decoder fetched once. Decoded geometry preserves vertex/index ordering, so vertex cache + fetch optimisations remain effective on the GPU.

```bash
# Re-encode all GLBs from assets/glb/ → assets/glb-meshopt/
npm run encode-meshopt
```

The encoder script ([`scripts/encode_glbs_meshopt.js`](../scripts/encode_glbs_meshopt.js)) replaces both the older Draco-compression flow (considered, see decisions wiki) AND the legacy `strip_glb_attributes.js` step in one tool: gltfpack drops unused vertex attributes, merges sub-meshes per material, runs vertex cache + fetch optimisation, applies quantisation, then encodes via `EXT_meshopt_compression`.

Key flags used:

- `-cc`: aggressive `EXT_meshopt_compression`
- `-vp 16`: 16-bit position quantisation for world-coord meshes (CET 12 km extent → ~0.18 m precision)
- `-vp 14`: for landmarks (local mesh space, smaller bounding box → sub-cm precision)
- `-vn 10 -vt 12 -vc 8`: quantisation bits for normals/UVs/colours
- **No `-kn`** (deliberately): preserving named nodes confuses Three.js's transform composition through the wrapper hierarchy and prevents gltfpack from merging sub-meshes

### Legacy: GLB attribute stripping (no longer needed)

`scripts/strip_glb_attributes.js` is retained for inspection but **not required** in the live pipeline: `gltfpack` does the same attribute pruning automatically. If you do need to inspect a stripped-but-uncompressed GLB:

```bash
# POSITION only (default)
node scripts/strip_glb_attributes.js input.glb output.glb

# Keep multiple attributes
node scripts/strip_glb_attributes.js input.glb output.glb POSITION,NORMAL
node scripts/strip_glb_attributes.js input.glb output.glb POSITION,COLOR_0
```

| Material | Keep | Reason |
| --- | --- | --- |
| `MeshBasicMaterial` | `POSITION` only | No lighting, no UVs |
| `MeshLambertMaterial` + `flatShading:true` (**terrain, water, cliffs, landmarks**) | `POSITION,NORMAL` | NORMAL required for `shadow.normalBias`: stripping it causes shadow acne |
| Metro LOD shader | `POSITION,COLOR_0` | `COLOR_0` encodes LOD tier (B/G/R) |
| Building DDS pipeline | N/A, no GLB | Geometry is `BoxGeometry(1,1,1)` generated in JS |

**Bug fixed:** The remap loop previously only remapped `POSITION`. With a multi-attribute keep-list, other attributes (e.g. `NORMAL`, `COLOR_0`) were left with their original large accessor indices, causing GLTFLoader to fail with `bufferView undefined`. Fixed in the current script.

#### Size savings per file

| File | WolvenKit export | After strip | Keep |
| --- | --- | --- | --- |
| `3dmap_terrain.glb` | 17.6 MB | 6.2 MB | POSITION,NORMAL |
| `3dmap_cliffs.glb` | 9.5 MB | 3.3 MB | POSITION,NORMAL |
| `3dmap_roads_borders.glb` | 32.0 MB | 5.8 MB | POSITION |
| `3dmap_roads.glb` | 6.3 MB | 1.3 MB | POSITION |
| `3dmap_metro.glb` | 1.2 MB | 0.5 MB | POSITION,COLOR_0 |
| `3dmap_statue_splash_a.glb` | 1.3 MB | 0.5 MB | POSITION,NORMAL |
| `3dmap_ext_monument_av_building_b.glb` | 1.0 MB | 0.4 MB | POSITION,NORMAL |
| `3dmap_obelisk.glb` | 0.5 MB | 0.2 MB | POSITION,NORMAL |
| `northoak_sign_a.glb` | 0.3 MB | 0.1 MB | POSITION,NORMAL |
| `cz_cz_building_h_icosphere.glb` | 0.2 MB | 0.1 MB | POSITION,NORMAL |
| `rcr_park_ferris_wheel.glb` | 0.1 MB | 0.1 MB | POSITION,NORMAL |
| `3dmap_water.glb` | ~0 MB | ~0 MB | POSITION,NORMAL |
| `monument_ave_pyramid.glb` | ~0 MB | ~0 MB | POSITION,NORMAL |
| **Total** | **~70 MB** | **~18.5 MB (74%)** | |

All files stay well under Cloudflare Pages' 25 MB per-file limit. Terrain/cliffs/landmarks keep NORMAL (required for shadow normal-bias); roads/borders keep POSITION only (MeshBasicMaterial, no lighting).

### Roads axis inversion

`3dmap_roads.glb` (and `3dmap_metro.glb`) have their X axis inverted relative to CET space. After loading:

```javascript
mesh.rotation.y = Math.PI;
```

### Materials

| Layer | Material type | Colour source |
|-------|--------------|--------------|
| Terrain | `MeshLambertMaterial` (flatShading, DoubleSide) | `--scene-terrain` CSS var |
| Water | `MeshLambertMaterial` (flatShading, DoubleSide, stencil=2) | `--scene-water` CSS var |
| Cliffs | `MeshLambertMaterial` (flatShading, DoubleSide) | `--scene-cliffs` CSS var |
| Roads (normal) | `MeshBasicMaterial` (depthTest:true) | `--overlay-road-color` CSS var |
| Roads (SeeThrough) | `MeshBasicMaterial` (depthTest:false, stencil=2) | `--overlay-road-color` CSS var |
| Borders (normal) | `MeshBasicMaterial` (additive) | `--overlay-road-border-color` CSS var |
| Borders (SeeThrough) | `MeshBasicMaterial` (depthTest:false, additive, stencil=2) | `--overlay-road-border-color` CSS var |
| Metro | `MeshBasicMaterial` (additive, LOD shader) | `--overlay-metro-color` CSS var |
| Buildings | `MeshLambertMaterial` (stencil=1) | `--scene-buildings` CSS var, per-instance brightness |

---

## Landmarks

7 GLBs, 8 instances (ferris wheel shared). Added to `layers.buildings` group: toggles with the buildings checkbox. Uses `--scene-buildings` colour, `MeshLambertMaterial` with `flatShading:true`.

### Coordinate system: critical difference from roads/terrain

Landmark GLBs are in **local model space** (vertices centred near origin), not world CET space like roads/terrain. This means:

- **No** `rotation.y = Math.PI` (X-flip) needed, unlike roads/terrain
- World position comes from two sources in the ent file:
  - **XY**: resolved by `cp2077_extract_footprints.py --list-landmarks` (walks the full parent transform chain)
  - **Z (height)**: from `localTransform.Position.z` field (`Bits / 131072.0`); the 2D extraction script discards this
- Three.js placement: `position.set(cetX, cetZ, -cetY)`; note cetZ as the Y (height) axis

### Quaternion conversion

CET space is Z-up; Three.js is Y-up. Ent quaternion `[i, j, k, r]` → Three.js `Quaternion(x=i, y=k, z=-j, w=r)`.

Note: `cp2077_extract_footprints.py` applies `CET_X = -GLB_X` when projecting to Leaflet 2D space. This negation is **not** needed in Three.js 3D rendering: the model-local vertices render correctly without the X-flip.

### World positions (from ent + extraction script)

| Landmark | CET X | CET Y | CET Z | Notes |
| --- | --- | --- | --- | --- |
| Obelisk (The Needle) | -1714.5 | -2331.3 | 35.68 | Near-180° yaw |
| Monument Ave Pyramid | -1595.2 | -2344.3 | 55.74 | Identity rotation |
| De-votion statue | -1673.8 | -2466.1 | 43.20 | -143° yaw |
| Brainporium AV building | -1717.3 | -2412.0 | -8.02 | -53° yaw |
| North Oak sign | 196.9 | 873.7 | 152.76 | High elevation on cliffs |
| Brave Atlas icosphere | -1974.8 | -2701.0 | 102.70 | Complex pitch+roll |
| Ferris wheel (Pacifica) | -2442.4 | -2178.0 | 34.26 | Upright |
| Ferris wheel (collapsed) | 445.2 | -1672.2 | 10.87 | Lying on side, full pitch+roll quaternion |

### GLB stripping gotcha

The `strip_glb_attributes.js` script had a bug with the `byteOffset` field: use `bv.byteOffset || 0` not `bv.byteOffset` (the field is optional in GLTF and defaults to 0; missing field caused incorrect slice).

---

## Roads, Borders & Metro Rendering

Roads and borders are each rendered **twice** from the same geometry, matching the game's `entMeshComponent` dual-appearance setup (`default` + `SeeThrough1` in `3dmap_view.ent`).

### Normal pass (depthTest:true)

Surface roads sit correctly in the scene, occluded by terrain when viewed at tilt angles. Underground sections are correctly hidden.

### SeeThrough pass (depthTest:false + water stencil)

A second draw call using the same geometry with `depthTest:false`. This is NOT a full "show through everything" pass. It uses the **WebGL stencil buffer** to limit where it renders:

- **Water** (`3dmap_water.glb`) writes `stencil=2` during the opaque pass
- **Buildings** write `stencil=1` during the opaque pass
- **SeeThrough roads**: `stencilFunc=EQUAL, stencilRef=2` → only renders where water is

Result:

- **Pacifica tunnel**: water writes stencil=2 above the underground road → SeeThrough renders → tunnel visible ✓
- **Road through mountain**: terrain has no stencil=2 → SeeThrough blocked → hidden ✓ (improvement over the game, which shows roads through terrain)
- **Road through buildings**: stencil=1 ≠ 2 → blocked ✓

This is a deliberate improvement over the game's `RenderOnTop=1` approach, which shows all roads through all terrain.

### Metro LOD

Metro uses `onBeforeCompile` to read vertex `COLOR_0` for LOD tier:

Channels are **mutually exclusive**, only one tier is visible at any zoom level:

| Channel | Tier | Visible when | Game distance parameter |
| ------- | ---- | ------------ | ----------------------- |
| B=1 (27%) | Wide solid | `zoom < LOD_MED` (far) | VisibilityDistanceBold=30000 |
| G=1 (26%) | Thin solid | `LOD_MED < zoom < LOD_NEAR` (medium) | VisibilityDistanceRegular=18000 |
| R=1 (47%) | Dotted | `zoom > LOD_NEAR` (close) | VisibilityDistanceDashed=5000 |

B must be discarded at both ends (two separate discard conditions in the shader). Metro uses `AdditiveAlphaBlend=1` in-game. The channel-to-tier mapping was determined by visual isolation testing: it is NOT documented in the exported material JSON (shader bytecode only).

---

## Buildings

~254k buildings across 8 districts. Each district is one `THREE.InstancedMesh` with
`MeshLambertMaterial`. Shadow casting and receiving work via standard Three.js.

### Data pipeline

```
assets/dds/*_data.dds  (DXGI_FORMAT_R16G16B16A16_UNORM - 16-bit RGBA, DX10 header)
    ↓ loadDataDds()  - fetch → Uint16Array (skip 148-byte DX10 header)
    ↓ CPU decode per valid pixel: position / quaternion / scale → setMatrixAt()
    ↓
THREE.InstancedMesh with correct bounding sphere and frustum culling

assets/dds/*_m.dds  (DXGI_FORMAT_R8_UNORM - 8-bit greyscale, DX10 header)
    ↓ loadMDds()  - Uint8Array (mip 0) → DataTexture (RedFormat, generateMipmaps)
    ↓
MeshLambertMaterial.onBeforeCompile injects planar UV + _m modulation + edge highlight
```

### DDS texture format

Each `_data.dds` pixel encodes one building instance across three horizontal blocks
(blockW = width / 3):

| Block | Column range | Encodes |
|-------|-------------|---------|
| Position | 0..blockW | RGB=XYZ (Uint16 0→65535 → transMin→transMax + offset), A=validity |
| Rotation | blockW..2×blockW | RGBA=quaternion (0→65535 → -1→1) |
| Scale | 2×blockW..3×blockW | RGB=XYZ half-extents × cubeSize |

Position precision: ~0.036 CET units (16-bit). Earlier 8-bit PNG exports gave ~9.4 CET
units error, visible as jumbled circular ring structures.

### CPU decode (loadDataDds)

```javascript
const { pixels, width, height } = await loadDataDds(meta.dataDds); // Uint16Array
const blockW = Math.floor(width / 3);
for (let y = 0; y < Math.min(height, blockW); y++) {
  for (let x = 0; x < blockW; x++) {
    if (pixels[(y*width+x)*4 + 3] < 655) continue; // alpha < ~1% → invalid
    // decode position, quaternion, scale → dummy.position/quaternion/scale
    // CET→Three.js remap: position.set(cetX, cetZ, -cetY)
    // quaternion.set(qx, qz, -qy, qw)  (CET Z-up → Three.js Y-up)
    // scale.set(hx*2, hz*2, hy*2)      (CET X→X, Z→Y, Y→Z)
    mesh.setMatrixAt(validCount++, dummy.matrix);
  }
}
mesh.count = validCount;
```

### MeshLambertMaterial + onBeforeCompile

`buildBuildingMaterial()` in `three-scene.js` creates one material per district:

- **Lambert lighting**: driven by scene lights automatically; no manual uniform syncing
- **Planar UV**: computed from `instanceMatrix * vertex` world position in `project_vertex`
- **`_m.dds` modulation**: `diffuseColor.rgb *= 0.3 + mVal * 0.7` before lighting
- **Edge highlight**: from `3d_map_cubes.mt` EdgeColor/EdgeThickness/EdgeSharpnessPower

`mat.userData.shader` stores the `onBeforeCompile` shader reference for later uniform
updates (edge colour on theme change).

### District metadata (DISTRICT_META in three-scene.js)

Each district entry specifies `dataDds`/`mDds` paths, `cubeSize`, `transMin`/`transMax`
(3D XYZ), and world XY `offset`. Values sourced from `3dmap_triangle_soup.Material.json`.

For full pipeline history (Python → xbm.json → DDS) and shadow implementation details
see [`coordinate-system-3d.md`](coordinate-system-3d.md) and
[`3dmap-lighting-shadows.md`](3dmap-lighting-shadows.md).

---

## Location Pins

Pins are `CSS2DObject` instances from Three.js's `CSS2DRenderer`. They use the same CSS classes as the Leaflet markers (`category-marker`, `marker-pin`, `marker-pin--location-overhaul`, etc.) so they are visually identical and theme-aware automatically.

```javascript
const div = document.createElement('div');
div.className = 'category-marker';
div.innerHTML = `<div class="marker-pin ${catStyle.class}"></div>`;
const pin = new CSS2DObject(div);
pin.position.set(cetX, cetZ || 0, -cetY);
```

Popup HTML is generated by `NCZ.buildPopupHtml()` (in `utils.js`), the same function used by the Leaflet view, so both views produce identical popups.

### Clustering

Screen-space proximity clustering, recalculated on camera change. Pins within 40px (matching Leaflet's `maxClusterRadius`) are grouped into a single cluster element using the same `.marker-cluster-step-N` CSS classes. The `#cluster-panel` DOM element is shared between both views.

### Filter integration

`applyFilters()` in `app.js` calls `NCZ.computeVisibleMods(mods, filters)` to get a `Set<modId>`, then delegates:
- Leaflet view: adds/removes markers from `markerClusterGroup`
- Three.js view: calls `NCZ.ThreeMarkers.applyFilters(visibleIds)` which toggles `pin.visible` and re-runs cluster proximity grouping

---

## Shared Utility Functions

All in `utils.js`. Both views call these: nothing view-specific lives here.

| Function | Description |
|----------|-------------|
| `NCZ.isRecentlyUpdated(mod)` | True if mod was recently updated on Nexus. Reads the API's server-computed `recently_updated` bool; on the API-down fallback path, computes from `_updatedAt` vs the effective window (`NCZ.recentlyUpdatedDays`, default `NCZ.RECENTLY_UPDATED_DAYS`) |
| `NCZ.cetToThree(cetX, cetY, cetZ)` | CET → Three.js `[x, y, z]` |
| `NCZ.buildPopupHtml(mod, catStyle, nexusThumbs, tagsDict)` | Full popup HTML string, used by both views |
| `NCZ.prepareModRenderData(mod, nexusThumbs, tagsDict)` | Returns `{ catStyle, popupHtml, thumbSrc, fullSrc, nexusUrl, nexusLabel }` |
| `NCZ.computeVisibleMods(allMods, filters)` | Returns `Set<modId>` of mods passing all active filters |

---

## View Switching

Handled in `overlay.js` via `NCZ.switchBaseLayer(layerName)`. On switch:

1. The outgoing container is hidden (`display: none`), its render loop paused
2. The incoming container is shown, its init called (lazy, only runs once)

Camera state is synced on switch via coordinate transform: Leaflet center → inverse `cetToLeaflet()` → CET coords → `cetToThree()` → Three.js camera target, and vice versa. Zoom is mapped proportionally between Leaflet zoom levels and Three.js frustum size.

---

## WebGL Fallback

On page load, `WebGL2RenderingContext` is checked. If unavailable, the "3D" view option is hidden and the satellite view is the only option.

---

## Console Commands

All commands are available in the browser DevTools console while the 3D view is active.

### Layer visibility

```javascript
// Hide/show individual scene layers
NCZ.ThreeScene.setLayerVisibility('water',     false)
NCZ.ThreeScene.setLayerVisibility('terrain',   false)
NCZ.ThreeScene.setLayerVisibility('cliffs',    false)
NCZ.ThreeScene.setLayerVisibility('roads',     false)
NCZ.ThreeScene.setLayerVisibility('metro',     false)
NCZ.ThreeScene.setLayerVisibility('buildings', false)
NCZ.ThreeScene.setLayerVisibility('districts', false)

// Restore
NCZ.ThreeScene.setLayerVisibility('water', true)
```

### Camera state

```javascript
// Capture current camera position + sun angle (copies JSON to clipboard)
copy(JSON.stringify(NCZ.ThreeScene.getCameraState()))
// → { target, position, zoom, polar, azimuth, sunAz, sunEl }

// Restore a saved state (camera + sun)
NCZ.ThreeScene.setCameraState(JSON.parse('PASTE_JSON_HERE'))
```

Useful for taking consistent before/after screenshots. If the showcase flyover is running, pause it before restoring: the flyover overrides sun state on each tick.

### Sun position

```javascript
// setSunPosition(azimuthRad, altitudeRad)
NCZ.ThreeScene.setSunPosition(Math.PI * 0.25, Math.PI * 0.35)  // default
NCZ.ThreeScene.setShadowsEnabled(true)
```
