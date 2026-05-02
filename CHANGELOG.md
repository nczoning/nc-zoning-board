# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Three.js 3D Schematic Map (in progress — dev branch)

#### GLB compression via gltfpack/meshopt (PR #622)

- **Total 3D scene payload: 18.5 MB → 2.18 MB (-88%)** — terrain alone went 6.4 MB → 423 KB; `roads_borders` went 5.9 MB → 357 KB
- New folder `assets/glb-meshopt/` ships the compressed copies; uncompressed source GLBs live at the gitignored `assets/glb-source/` (drop WolvenKit exports there before running `npm run encode-meshopt`). Runtime path: `NCZ.GLB_DIR` in [`constants.js`](assets/js/constants.js)
- Encoded via [`gltfpack`](https://github.com/zeux/meshoptimizer/tree/master/gltf) with `EXT_meshopt_compression` + `KHR_mesh_quantization` (vertex cache + fetch optimization, sub-mesh consolidation, 16-bit position quantization on world-coord meshes, 14-bit on local-space landmarks)
- Decoded at runtime by `MeshoptDecoder` (bundled with three.js examples, ~30 KB WASM, single fetch). Decoded geometry preserves vertex/index ordering, so GPU vertex cache stays warm
- New build command: `npm run encode-meshopt`
- **Side benefit:** gltfpack also merges sub-meshes per material → halved draw calls (67 → 33) and geometries (46 → 23). Replaces the legacy `strip_glb_attributes.js` step entirely
- **Measured perf on Radeon 840M iGPU (external 1440p, AA on, full shadows):** idle FPS 44 → 63 (+43%) vs uncompressed; +31% over the considered Draco alternative (#617, closed). Full three-way comparison in `wiki/decisions/meshopt-over-draco.md`
- **Bug fixed during integration:** `loadLandmarks()` was creating new `THREE.Mesh` objects from only `geometry + material`, discarding the source mesh's `position`/`scale` — fine for uncompressed GLBs (identity transform) but broke `KHR_mesh_quantization` dequantization (vertices rendered at raw int16 scale, ~4× too large). Now copies position/quaternion/scale to mirror the existing `makeSeeThrough()` pattern
- **Repo size reduction:** `assets/glb/` removed from version control (was 18.5 MB of dead weight; WolvenKit is the canonical source). Local re-encoding workflow: copy WKit exports to `assets/glb-source/`, run `npm run encode-meshopt`

#### Performance instrumentation (PR #618, #619)

- `?debug=1` URL flag activates a vertical stats.js panel in the top-right of the 3D view — FPS, MS/frame, MB heap, draw calls, triangles. All five always visible (no click-cycling), `pointer-events:none` so mouse drags pass through to the scene
- `Copy debug info` button captures a comprehensive snapshot: rolling 5 s FPS buffer (avg / p50 / worst-5%), `renderer.info` counters, renderer settings (DPR / AA / shadow type), display dimensions, GPU/vendor identification, hardware concurrency, max texture size. Logs to console + clipboard
- New `NCZ.ThreeScene` console exports: `getRenderInfo()`, `setOverrideMaterial(true|false)` (fragment-cost diagnostic), `dumpDebugInfo()` (programmatic equivalent of the button)
- No behaviour change for normal users — fully gated on `?debug=1`

#### Landmarks (Task 4)

- **7 GLBs, 8 instances** — The Needle (obelisk), Heavy Hearts Club (pyramid), De-votion statue, Brainporium AV building, North Oak arch gate, Brave Atlas icosphere, Pacifica ferris wheel (upright), Rancho Coronado ferris wheel (collapsed on its side)
- Full quaternion rotation from `3dmap_view.ent` — all three axes; collapsed ferris wheel correctly lies on its side
- **Coordinate system** — GLBs are in local model space; world XY from `cp2077_extract_footprints.py --list-landmarks`, world Z (height) from ent `Position.z`; no X-flip needed (unlike roads/terrain)
- Shares `--scene-buildings` colour and toggles with the buildings layer
- Casts and receives shadows

#### Shadow system improvements

- **Shadows on by default** — enabled at startup rather than requiring manual toggle
- **Dynamic shadow frustum** — shadow camera frustum scales with camera zoom and tilt angle, concentrating all 4096² shadow map texels on the visible area; sharp shadows when zoomed in without visible boundary
- **Shadow tracks camera pan** — shadow camera follows `controls.target` so shadows don't cut off when panning; sun direction preserved
- **Dynamic bias scaling** — `shadow.bias` and `shadow.normalBias` scale down with the frustum to reduce peter panning at high zoom while preserving acne prevention at wide zoom-out
- Terrain, cliffs, and landmarks all cast and receive shadows (normals restored to GLBs for correct shadow normal-bias computation)

#### Flyover colour system refactor

- `getColorBindings()` registry in `three-scene.js` — adding a new material requires one entry; `captureColors()`, `transitionToColors()`, `transitionMaterials()`, and flyover `readThemeColors()` all derive from it automatically
- `getSceneColorVars()` exposed on `NCZ.ThreeScene` — flyover reads CSS var list dynamically, no manual updates needed when materials change
- Road borders and landmarks now correctly participate in beat-cycle and theme-switch transitions

#### Synthwave theme update

- Tertiary colour changed from amber to cyan `#00d4ff` — completes the magenta + cyan synthwave palette
- Road borders use cyan with additive blending for neon grid effect
- Building edges now cyan; background darkened to near-black `#0d0020`

#### GLB attribute stripping improvements

- `strip_glb_attributes.js` now accepts a keep-list argument: `node strip_glb_attributes.js in.glb out.glb POSITION,NORMAL`
- Bug fix: multi-attribute remap now iterates all kept attributes (previously only remapped POSITION)
- Terrain, water, cliffs, and landmarks retain NORMAL for correct shadow normal-bias; roads/borders/metro keep POSITION only

#### Phase 3 Bug Fixes & Rendering Overhaul

##### Road rendering system

- **Road borders layer** — `3dmap_roads_borders.glb` now loaded and rendered with additive blending, matching the game's `AdditiveAlphaBlend=1` material setting
- **Stencil buffer rendering** — Pacifica underwater tunnel now visible through the bay while being correctly hidden through terrain/mountains. Roads and borders use a dual draw pass: normal (depth-tested) for surface roads + SeeThrough (depth-ignored, stencil-gated) for the tunnel. This is a deliberate improvement over the game's `RenderOnTop` approach which shows roads through everything.
  - Buildings write stencil=1; water writes stencil=2; SeeThrough roads only render where stencil=2
- **Metro LOD shader** — vertex `COLOR_0` channels encode three mutually exclusive visibility tiers: B=wide bold line (far zoom), G=thin line (medium zoom), R=dotted detail (close zoom). Metro now renders above road layer via `renderOrder`.

##### Building edge highlight

- Fixed shader injection — was targeting a chunk that doesn't exist in Three.js r170, silently doing nothing
- Added `BUILDING_EDGE_INTENSITY` to tune the effect strength independently of thickness
- `--scene-buildings-edge` defined per-theme in `theme.css` (previously auto-derived, now explicit and independent — confirmed by Preem Map mod data)
- Edge thickness raised from game default (sub-pixel, causes flickering) to a stable value

##### UI & controls

- Shadow checkbox now syncs to actual scene state when changed programmatically or via console
- Sun slider reverse-mapped from scene elevation using SunCalc — stays in sync regardless of what set the sun position
- Any overlay checkbox with `data-overlay="layerName"` is automatically synced by the poll (no per-layer code needed for future layers)

##### Loading

- Loading bar visible for full asset load duration (previously hid after terrain, before buildings)
- Per-step progress bar with themed panel backdrop; loading text updates per building district
- `registerLoadStep()` / `stepProgress()` pattern — adding future loaders requires no hardcoded count updates

##### Performance

- All GLB assets stripped of unused vertex attributes before deploy. WolvenKit exports 6 attributes per mesh; most materials only need `POSITION` (`MeshBasicMaterial`) or `POSITION` alone for Lambert + flatShading (normals derived in shader via `dFdx/dFdy`). Metro LOD shader additionally keeps `COLOR_0`.
  - terrain: 17.6 MB → 3.4 MB · cliffs: 9.5 MB → 1.8 MB · roads: 6.3 MB → 1.3 MB · borders: 32 MB → 5.8 MB · metro: 1.2 MB → 0.5 MB
  - **Total: 66 MB → 13 MB (81% reduction)**

#### Phase 3 — Buildings, Dynamic Sun, Shadows, and Showcase Flyover

##### Buildings (instanced cubes)

- ~254k building instances per district rendered as `THREE.InstancedMesh` via `MeshLambertMaterial` + `onBeforeCompile`
- Position/rotation/scale decoded on CPU from DDS binary (`DXGI_FORMAT_R16G16B16A16_UNORM`, 16-bit precision) → `setMatrixAt()`
- Full quaternion rotation (all 4 components); `_m.dds` surface detail texture via world-space planar UV
- Buildings cast **and receive** shadows via standard Three.js — no custom depth material
- Y-axis inversion fixed: `camera.up.set(0, 1, 0)` (standard Three.js convention)
- Edge highlight matching game shader `3d_map_cubes.mt` EdgeColor/EdgeThickness/EdgeSharpnessPower via `onBeforeCompile` fragment patch

**Pipeline evolution:**
- Gen 1 (removed): `build_buildings_3d.py` → `buildings_3d.json` → 8-bit precision (±9.4 CET unit error)
- Gen 2 (removed): `assets/xbm/*.xbm.json` → GPU `RawShaderMaterial` + `gl_InstanceID` → required custom depth material + workarounds
- Gen 3 (current): `assets/dds/*.dds` → CPU decode → `MeshLambertMaterial` — standard, maintainable, full shadow support

##### Dynamic Sun and Hillshade

- **SunCalc integration** — real sun azimuth/altitude for any time at Morro Bay, CA (35.37°N, 120.85°W), Night City's real-world location, computed via [SunCalc](https://github.com/mourner/suncalc) (by Vladimir Agafonkin, Leaflet's author)
- **Time-of-day slider** in scene controls, spanning summer solstice sunrise (05:53 PDT) to sunset (20:16 PDT); defaults to 10:00 AM for optimal hillshading contrast
- Directional light colour shifts warm orange at the horizon → neutral white at noon; ambient intensity scales with sun elevation
- Visible sun sphere (radius 600, 20 000 units from Night City centre) tracks the sun direction, coloured to match the warm-to-white elevation curve
- All time math uses UTC with explicit PDT offset so the slider is timezone-independent regardless of the user's browser locale

##### Real-time Shadow Mapping

- `PCFSoftShadowMap` at 4096×4096; shadow camera frustum ±7000 units centred on Night City
- Terrain and cliffs cast and receive shadows; water receives only; buildings cast onto terrain
- Shadow toggle in overlay panel (off by default); ⚠ performance warning on label
- Shadow casting disabled below 5° sun elevation to avoid degenerate projections at sunrise/sunset; state persists through the theme beat-cycle

##### Live Theme Switching

- Themes now switch instantly without a page reload — `applyThemeById` calls `updateMaterials()` and clears the 2D overlay tile cache on every change
- Material references stored (terrain, water, cliffs, roads, metro, buildings + per-instance brightness array) so all scene colors update together
- `NCZ.applyTheme(id)` exposed globally with `persist: false` so programmatic changes don't overwrite the user's saved preference

##### Synthwave Theme

- New theme: deep purple background (`#1a0533`), magenta primary (`#ff2d78`), gold accent (`#ff9d00`), purple terrain (`#4a2e6e`), violet water (`#1a0840`)
- Logo: `assets/img/synthwave-logo.png`

##### Showcase Flyover (`assets/js/flyover.js`)

Opt-in cinematic module — add or remove the `<script>` tag to include or exclude the feature.

- **Camera**: PerspectiveCamera (55° FOV) sweeping 11 waypoints across 57.417 s; camera path synced to Audacity label timestamps for _Good Morning Night City_ so the camera is over the named district exactly when the announcer says it
- **Audio**: `assets/audio/GMNC.mp3` plays during showcase; `audio.currentTime` drives beat events, sun position, and end-of-showcase fade — no clock drift between visual and audio
- **Beat-driven theme visualiser**: 33 exact beat timestamps from Audacity beat-finder; each fires a smooth cross-dissolve to the next theme palette (Night Corp → Militech → Arasaka → Aldecaldos → Synthwave → repeat), cycling at the track's ~1.34 s bass pulse
- **Layer reveal**: Roads → Metro → Buildings stagger in across the 6.9 s ocean approach, timed to land before "Good Morning Night City" hits; district lines stay off throughout the showcase
- **Sun arc**: summer solstice sunrise-to-sunset over 57 s driven by `audio.currentTime`; sun sphere visible in sky, rises from below the terrain horizon and sets into the ocean
- **Shadows**: always enabled during showcase; restored to checkbox state on exit
- **Fullscreen**: requests native browser fullscreen on start; exits on showcase end or manual F11/Escape
- **Fade**: overlay div created dynamically on start (solid black), 2 s fade-in reveals scene; 2 s fade-to-black on end, triggered by `audio.ended` for frame-accurate sync; div removed from DOM on exit
- **Opening title card**: "NC ZONING BOARD / NIGHT CITY · 2077" fades in with the scene
- **One-shot**: plays through once, cleans up fully on natural end or early exit (Escape/button)
- **Theme save/restore**: user's active theme saved before showcase starts, restored via cross-dissolve on exit without writing to localStorage

##### Per-Layer Scene Theming

- Each 3D scene layer now has its own dedicated CSS variable — buildings no longer share terrain colour
- `--scene-buildings` added to all 5 themes; default values use darker terrain / lighter buildings (~50 lightness points apart) so Lambert shading doesn't collapse contrast
- `--scene-buildings-edge` defined once in `:root` via `color-mix(buildings 40%, white)` — edge glow auto-derives from building colour, no per-theme duplication
- Roads and metro use muted colours in the same hue family as terrain rather than bright accent colours
- `setLayerVisibility()` extended to cover `terrain`, `water`, and `cliffs` (previously only roads/metro/buildings/districts)
- `getLayerVisibility(name)` added to `NCZ.ThreeScene` public API

##### Constants Refactor

- All 3D scene magic numbers moved from `three-scene.js` to `constants.js` under `NCZ.*`:
  - Camera: NEAR/FAR/HEIGHT, all OrbitControls values (MIN_TILT/MAX_TILT/DAMPING/ZOOM_MIN/ZOOM_MAX/ZOOM_SPEED/PAN_SPEED/ROTATE_SPEED) — all wired into live controls, tunable without touching scene code
  - Shadow: MAP_SIZE/FRUSTUM/CAM_NEAR/CAM_FAR/BIAS/NORMAL_BIAS/MIN_ELEV with explanatory comments
  - Lighting: AMBIENT_INTENSITY/SUN_DIST/SPHERE_DIST/SPHERE_RADIUS/COLOR_ELEV/INTENSITY_ELEV/INTENSITY_MIN/AMBIENT_MIN
  - Building decode: DDS_PIXEL_OFFSET/UINT16_MAX/DDS_ALPHA_THRESH
  - Building shader: EDGE_THICKNESS/EDGE_SHARPNESS/TEX_FLOOR/TEX_RANGE (with game `3d_map_cubes.mt` defaults in comments)
- `WORLD_CX/CY/H` derived from existing `NCZ.WORLD_MIN/MAX_*` values rather than duplicated
- All OrbitControls comments include Three.js default values for quick comparison

##### Showcase Flyover Improvements

- **State restore**: pre-showcase state now fully captured (all overlay checkboxes, sun slider value, theme) and restored exactly on exit — layer visibility, shadow checkbox, and sun position all snap back
- **Beat cycle colors**: hardcoded `BEAT_COLORS` replaced with `readThemeColors(themeId)` which reads CSS variables directly; beat cycle auto-syncs with `theme.css` changes with no separate update needed; buildings included in transitions
- **`FLYOVER_REVEAL_LAYERS` flag**: `false` (default) = all layers on from frame 1 for immediate shadow visibility; `true` = original stagger reveal. Either way, WP0 always sets its own layer state (not inherited from user)
- All flyover magic numbers extracted to module-level constants at top of `flyover.js` (kept separate from `constants.js` — flyover is opt-in)

##### Bug Fixes

- Canvas no longer pushes sidebar and overlay buttons out of view — renderer canvas is now `position: absolute; inset: 0` (removed from document flow) so its pixel-buffer dimensions can't affect layout
- Sun slider time calculation was wrong in non-Pacific timezones — all conversions now use `setUTCHours` with explicit PDT offset (-7), browser locale never involved
- Sun position was dark on page load — slider input is dispatched from `hideLoading()` post-terrain so `setSunPosition` is called after the scene is ready
- Showcase exit left terrain dark — `stopFlyover` now runs full cleanup on natural end (render loop restart, controls, layers, sun, theme, shadows)

#### Phase 0 — View-Agnostic Data Layer

- Extracted shared popup/filter logic from `app.js` into the `NCZ` namespace so both Leaflet and Three.js views consume the same code: `NCZ.isRecentlyUpdated`, `NCZ.cetToThree`, `NCZ.buildPopupHtml`, `NCZ.prepareModRenderData`, `NCZ.computeVisibleMods`
- Added `#map-3d` container, Three.js import map, and module script stubs (`three-scene.js`, `three-markers.js`)
- Added `docs/three-js-migration-plan.md`, `docs/three-js-scene.md`, `docs/dev-environment.md`

#### Phase 2 — Roads, Metro, District Borders

- Roads and metro GLBs (~7.6 MB Tier 2) load after terrain; roads X-axis inversion corrected via `rotation.y = Math.PI`
- District borders rendered in both views using the same data (`data/subdistricts.json`):
  - SAT: Leaflet GeoJSON layers
  - SCHEMA: `Line2` fat lines with `depthTest: false` (always renders over terrain, matching the game's UI overlay approach)
- Zoom-based district/subdistrict switching on both views — outer district borders hide when zoomed in, subdistricts appear
- Districts without canonical subdistricts (Dogtown, Morro Rock) always show their border; `canonical: false` entries (casino) always visible
- Shared appearance constants in `constants.js`: `NCZ.DISTRICT_LINE_WIDTH`, `NCZ.SUBDISTRICT_LINE_WIDTH`, `NCZ.DISTRICT_LINE_OPACITY`
- Per-theme `--overlay-road-color` and `--overlay-metro-color` CSS vars
- Overlay toggles: Districts toggle affects both views; Roads/Metro are SCHEMA-only and dim when on SAT

#### Phase 1 — Terrain Scene + View Switching

- **New default view**: SCHEMA (3D) replaces SAT as the landing view
- Live Three.js scene rendering terrain, water, and cliffs GLBs (~28 MB Tier 1)
- Orthographic camera with OrbitControls: left-drag pan, right-drag tilt (max ~70°), scroll zoom
- Hillshade lighting matching the game's `DarkEdgeWidth` shader (DirectionalLight from NW + AmbientLight 0.35)
- Cliffs correctly offset via WolvenKit entity localTransform (`-2255, 0, 3050`)
- Terrain/cliffs colors derived from game material data (`BaseColorScale RGB(86,108,136)`); per-theme `--scene-terrain/water/cliffs` CSS vars
- SCHEMA/SAT view toggle with tooltips; controls reference and Reset view button

## [0.3.2] - 2026-04-09

### 16k WebP Tile Layer

- **16k WebP tiles**: Upgraded satellite base layer from the single-image WebP overlay (9.6 MB blocking download) to 16k WebP tiles (zoom 0–6, 5,461 tiles). Generated directly from the lossless 16k PNG source at quality 90, effort 6. Max-zoom upscaling reduced from 8× to 4× for significantly sharper detail. Progressive tile loading eliminates the first-paint latency on GitHub Pages.

## [0.3.1] - 2026-04-09

### Coordinate Transform and Satellite Map

- **Coordinate accuracy**: Replaced the 16-point in-game survey calibration with a mathematically exact transform derived from the [Realistic Map 8k mod](https://www.nexusmods.com/cyberpunk2077/mods/17811) terrain quad UV mapping. The old calibration had up to ~2 Leaflet unit (~16px at max zoom) drift at map edges; the new transform is exact by construction. Pin positions shift by up to ~0.25 units near the map centre and ~2 units at the far edges — visually imperceptible for most pins.
  - Added `NCZ.WORLD_MIN_X/MAX_X/MIN_Y/MAX_Y` as named constants (single source of truth for world extent)
  - `cetToLeaflet()` and `leafletDistanceMeters()` both derive from these constants — scale indicator accuracy improved automatically
- **Satellite base layer**: Replaced the tile pyramid (`assets/tiles/{z}/{x}/{y}.png`, 256×256 tiles at zoom 0–5) with a single 9.6 MB WebP image overlay (`assets/img/satellite_8k.webp`). Eliminates tile-loading seams, simplifies serving, and leverages WebP compression for a smaller total payload.

## [0.3.0] - 2026-04-06

### Coordinate Expansion — Z and Yaw

- **Data schema**:
  - `coordinates` extended from `[X, Y]` to `[X, Y, Z]` — Z (height/elevation) is now required for new submissions; existing `[X, Y]` entries remain valid
  - Optional `yaw` top-level field added — player facing direction in degrees from CET
- **BBCode Generator modal**:
  - Added **Z Coordinate** input (required) and **Yaw** input (optional, above Category)
  - Canonical CET command displayed in a styled code block with a copy icon button
  - Generated block now outputs `coords=X,Y,Z` with optional `yaw=` line directly below coords
  - New `copy.svg` icon (Feather-style stroke, works with CSS `mask-image`)
- **Auto-discovery (Nexus BBCode)**:
  - `parseNcZoningBlock()` accepts both `coords=X,Y` (legacy, remains valid) and `coords=X,Y,Z`; parses optional `yaw=` field
  - `yaw` is now included in auto-discovered mod objects when present in the Nexus description
- **GitHub issue forms**:
  - Submission form: added required **Z Coordinate** and optional **Yaw** fields
  - Modify form: added required **Z Coordinate** (pre-filled from deep link) and optional **Yaw**; X/Y/Z marked `required: true`
  - Both forms: updated to canonical CET command; added SLM **Print Coordinates** button reference
- **GitHub workflows**: `auto-pr-submission` and `modify-location-submission` parse and write Z and Yaw; modify workflow preserves existing values when fields are blank
- **Documentation**: removed all "ignore Z" guidance; updated `coordinate-system.md`, `adding-mods.md`, `nczoning-auto-discovery.md`; legacy `coords=X,Y` Nexus blocks remain valid during transition
- **Canonical CET command** (replaces `print(GetPlayer():GetWorldPosition())`):

  ```lua
  local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
  ```

## [0.2.0] - 2026-04-02

### Deep-link Sharing

- **UI**:
  - **Copy Link button** — each mod popup now includes a "Copy Link" button (chain icon) that copies a shareable URL to the clipboard (e.g. `https://nczoning.net?mod=13821`) with 2-second "Copied!" feedback
  - **Deep-link support** — URLs with `?mod=<id>` parameter now automatically open and focus the matching pin on page load. Uses numeric `nexus_id` for Nexus mods; falls back to UUID for WIP/Dummy entries
  - **URL sync** — the browser address bar updates to reflect the current open pin (`?mod=` parameter), allowing users to share the map URL directly from their browser
- **Icons**:
  - Added `link.svg` — new Feather-style chain-link icon for the Copy Link button
- **Constants**:
  - `NCZ.SITE_URL` — canonical site URL for deep-link generation
  - `NCZ.URL_PARAM_MOD` — configurable URL parameter name (defaults to `"mod"`)

## [0.1.0] - 2026-03-28

### 2026-03-27

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Ko-Fi donation link** — "Buy us a coffee" link added to the sidebar footer and about modal, pointing to [ko-fi.com/nczoning](https://ko-fi.com/nczoning). Rendered with the Ko-Fi logo as an inline image.
  - **Discover button repositioned** — the "Discover a location" button is now anchored to the bottom-left of the map container. On desktop it dynamically offsets its `left` position by the sidebar's current pixel width when the sidebar is visible, and resets when the sidebar is hidden. Position updates on sidebar open/close and window resize.
  - **Cluster pin contrast** — cluster count badges now use bold white text with a text-shadow and a larger solid background area, improving legibility against varied map tile backgrounds.
- **UI**:
  - **Sidebar sort by last updated** — the mod list and cluster panel now sort by Nexus `updatedAt` descending (most recently updated first) instead of alphabetically. Mods with no Nexus timestamp (WIP/Dummy) fall to the end and sort alphabetically among themselves. Prevents gaming the list order by prefixing mod names with special characters.
- **Utils**:
  - `NCZ.sortModsByUpdated` added to `utils.js` — a comparator function `(a, b) => number` for use with `Array.sort()`. Orders by `_updatedAt` descending with alphabetical fallback for untimestamped mods.
- **Bug fixes**:
  - Fixed `_updatedAt` backfill for manual Nexus mods running inside the `.forEach()` body after `.sort()` had already completed. The backfill is now hoisted before the sort, so manual mods sort with their correct timestamps.
  - Fixed auto-discovery silently discarding `updatedAt`, `thumbnailUrl`, and `pictureUrl` for manually registered mods that are also tagged NCZoning. That metadata is now collected into a separate map and merged into `nexusThumbs`, so NCZoning-tagged manual mods receive their timestamps and images from the auto-discovery response. These mods are also excluded from the `modsByUid` batch, reducing its size.

### 2026-03-23

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Map scale indicator** — a Leaflet scale bar is displayed bottom-right (metric only). The scale is calibrated to in-game distances by overriding `L.CRS.Simple`'s `distance()` method with the inverse CET coordinate transform.
  - **"Discover a location" button** — new header button picks a random visible (post-filter) marker and zooms to it, opening its popup. Hides the sidebar on mobile when triggered.
  - **Focused pin persistence** — when the active popup's marker gets clustered on zoom-out, the cluster auto-spiderfies to keep the popup visible. Focus clears on manual close or when the marker is filtered out.
  - **Header button polish** — `#about-btn`, `#parameters-btn`, and `#bbcode-btn` now share a `.header-action-btn` base class with inline SVG icons and bold text. Submit button uses `.header-action-btn-tertiary` for the amber colour variant.
  - **Map pannable bounds** — `maxBounds` now extends 50% of the viewport past each edge so pins near the border can be panned to centre. Bounds recalculate on zoom and resize.
  - **Filter clear buttons** — "Clear all" buttons in the Tag and Author filter sections, visible only when filters are active.
  - **Active filter counts** — section headers show `(N)` beside "Filter by Tags" and "Author Filters" when filters are selected.
  - **Search clear button** — an × button inside the search input clears it; pressing Escape also clears the field.
  - **Popup height fix** — `positionDynamicPopup` now measures the full `.custom-popup-header.has-image` element (previously `.popup-thumb` only) for accurate arrow placement.
- **Constants**:
  - CET→Leaflet transform coefficients extracted to named constants (`NCZ.CET_TO_LEAFLET_X_SCALE`, `NCZ.CET_TO_LEAFLET_Y_SCALE`, `NCZ.CET_TO_LEAFLET_X_OFFSET`, `NCZ.CET_TO_LEAFLET_Y_OFFSET`, `NCZ.CET_UNITS_PER_METER`).
  - Added `NCZ.UPDATED_LABEL` (`"RECENTLY UPDATED"`) — corrected badge text from `UPDATED`, applied across popup, sidebar, cluster panel, and filter tag.
- **Utils**:
  - Added `NCZ.leafletDistanceMeters()` — converts a Leaflet lat/lng pair to in-game meters using the inverse CET transform.

### 2026-03-22

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Popup redesign** — mod popups have been fully restyled:
    - Category-coloured border gradient: the popup frame fades from the category colour at the image/title boundary to the base secondary colour below.
    - Category badge floated top-left outside the frame; RECENTLY UPDATED badge floated top-right.
    - Thumbnail now `object-fit: contain` inside a max-height container — fills popup width without cropping.
    - Title accent underline and glow text-shadow both driven by `--popup-title-accent` (set to the category colour).
    - Tags moved below description with a dark background band.
    - Credits names individually coloured in amber via `.custom-popup-credit-name`.
    - Nexus link is flex-grow; Edit button is flex-shrink-0.
    - Popup `className` now includes `popup-cat-{category}` for per-category CSS targeting.

### 2026-03-21

- **UI**:
  - **Recently Updated badge** — mods updated on Nexus within the last 7 days now display an `UPDATED` badge in the popup title, sidebar entry, and cluster flyout panel. Tooltip reads "Updated on Nexus within the last N days" (N driven by `NCZ.RECENTLY_UPDATED_DAYS` constant).
  - **"updated" filter tag** — a synthetic `updated` filter tag is prepended to the sidebar tag list (before `nczoning`) whenever at least one recently updated mod is present. Selecting it shows only recently updated mods.
  - **Welcome modal disclaimer** — replaced the updated-badge explanation with a clear disclaimer that this map is a visibility tool, not a reservation system. Mod authors retain full creative freedom over any location.
- **API**:
  - `updatedAt` is now fetched in both the `modsByUid` (manual mods) and `NCZoningMods` (auto-discovery) GraphQL queries.
  - Manual mods receive `updatedAt` from the thumbnail fetch; auto-discovered mods receive it from the discovery query.
- **Constants**:
  - Added `NCZ.RECENTLY_UPDATED_DAYS` — controls the badge and filter threshold (default: 7 days).

### 2026-03-15 (refactor & CI)

- **Refactor**:
  - Split monolithic `app.js` (~1500 lines) into four focused modules using a `window.NCZ` global namespace (no bundler, no ES modules — loaded via ordered `<script>` tags):
    - `constants.js` — all shared config values, category styles, API endpoints, cache keys, UI sizing
    - `utils.js` — pure utility functions: `escapeHtml`, coordinate transform, localStorage cache helpers, tooltip/popup positioning algorithm, BBCode block parser
    - `services.js` — Nexus V2 GraphQL API functions: thumbnail fetch, auto-discovery, new `NCZ.fetchModData()` which fetches `mods.json` and `tags.json` in parallel
    - `app.js` — DOM logic, map init, sidebar filtering, cluster panel, modals, image gallery
  - Added `NCZ.DATA_MODS_PATH` and `NCZ.DATA_TAGS_PATH` constants for data file paths (contributed by [@Akiway](https://github.com/Akiway))
- **CI**:
  - Fixed `validate-json` required status check blocking all non-data PRs — the workflow now always runs on every PR and reports a status immediately. Validation steps (build, schema check, tag check) are gated behind a `git diff` check and only execute when `data/locations/`, `data/tags.json`, or `mods.schema.json` are modified.
- **Docs**:
  - Updated `docs/architecture.md` — new file structure tree, added JavaScript Architecture section with module table, updated component section headers, added CSS nesting note.
  - Updated `docs/submission-pipeline.md` — Stage 4 now describes the change-detection step.
  - Updated `docs/coordinate-system.md` — `cetToLeaflet` reference updated to `utils.js`.

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Cluster menu panel** — clicking a cluster now opens a resizable side panel listing all mods within that cluster, with thumbnails, tags, descriptions, and category-coloured headers. Clicking a mod in the panel zooms to its pin and opens its popup. Panel width is draggable and persisted in localStorage. On mobile, the panel uses a fixed width and hides the resize handle. Replaces the previous hover-to-spiderfy interaction.
  - **Custom cluster thresholds** — cluster icon colours now use a 4-tier system (small/medium/large/xlarge at 0/10/25/50 mods) with a custom `iconCreateFunction`, replacing the default 0/10/100 thresholds. Added a radial gradient overlay for depth.
  - **Inlined MarkerCluster CSS** — removed the two external CDN stylesheet links for `MarkerCluster.css` and `MarkerCluster.Default.css`, replacing them with inlined styles in `style.css`. Eliminates external requests and CDN dependency.
  - **Marker tooltips** — hovering a map pin now shows a tooltip with the mod name. Tooltip uses smart directional placement (top/bottom/left/right) to stay within map bounds, with CSS arrows pointing back to the pin.
  - **Dynamic popup positioning** — popups now reposition dynamically to stay visible within the map container, with directional CSS arrows. Repositions on map move, zoom, and resize. Uses `requestAnimationFrame` coalescing for performance.
  - **Zoom button fix** — corrected vertical alignment of +/- icons in Leaflet zoom controls.
- **Docs**:
  - Updated `docs/architecture.md` — corrected colour palette to current `--nc-` CSS variables.
  - Updated `docs/branding.md` — fixed amber hex code to match actual CSS value (`#ffb300`).
  - Updated `docs/roadmap.md` — added cluster panel, tooltips, and dynamic popup positioning to completed features.

### 2026-03-14

- **UI**:
  - Replaced "show more / show less" toggles on Tag and Author filter sections with collapsible section headers — click the header to expand/collapse. Both sections are collapsed by default to remove perceived bias toward alphabetically-first entries.
  - Added close buttons (X) to the terminal header bar of all modals (Welcome, About, BBCode Generator) for improved usability.
  - Location count now updates dynamically when filters or search are applied, showing filtered/total format (e.g., `42/97`).
  - `nczoning` tag now sorts first in the tag filter list (before alphabetical tags).
  - Added amber warning note below coordinate inputs in the BBCode Generator modal reminding users to include the minus sign for negative coordinates.
  - Updated About modal description to neutral tone — removed "avoid overlapping builds" language.
- **Issue Templates**:
  - Rewrote mod submission template description to neutral tone — removed "to prevent overlaps" language that implied the tool gatekeeps or plays favourites.
  - Strengthened negative coordinate guidance in both X and Y coordinate fields with warning emoji and clearer instructions.
  - Changed X coordinate placeholder to show a negative example (`-500`).

### 2026-03-13 (BBCode modal)

- **UI**:
  - Added step-by-step instructions to the BBCode Generator modal (Acquire Coordinates, Configure Metadata, Tag Your Mod, Deploy Block) replacing the single warning line.
  - Added placement recommendations in the output section — suggests bottom of description as common spot, notes block can go anywhere, references spoiler wrap option.
  - Added link to full auto-discovery documentation from the modal.
  - Updated CET coordinate tooltip to use `print(GetPlayer():GetWorldPosition())`.

### 2026-03-13 (API optimization)

- **Performance**:
  - Eliminated duplicate image API calls — auto-discovered mods now carry their own `pictureUrl`/`thumbnailUrl` from the discovery query, so `fetchNexusThumbnails()` only fetches images for manual mods.
  - Added localStorage caching for Nexus API responses — auto-discovery results cached for 10 minutes, thumbnail data cached for 24 hours. Incremental fetches for new IDs not yet in cache.
  - Added 200ms debounce to sidebar search input to avoid excessive re-filtering on every keystroke.
  - Extracted magic numbers (`NEXUS_BATCH_SIZE`, `DESCRIPTION_MAX_LENGTH`, `SPIDERFY_DEBOUNCE_MS`, `COPY_FEEDBACK_MS`, `SEARCH_DEBOUNCE_MS`) into named constants.

### 2026-03-13 (security & hardening)

- **Security**:
  - Added `escapeHtml()` utility and applied to all user-supplied data in popup and sidebar HTML (`mod.name`, `mod.credits`, `mod.description`, authors, tag names/descriptions, URLs). Prevents XSS from Nexus API or submitted JSON.
  - Replaced inline `onclick` handler on popup thumbnails with a `data-full-src` attribute and delegated event listener.
  - Added `nexus_id` pattern validation (`^\d+|WIP|Dummy$`) to `mods.schema.json`.
  - Added coordinate range validation to the BBCode generator — rejects non-finite values and coordinates outside ±5000.
- **Bug Fixes**:
  - `build_mods.js` now exits with code 1 on any JSON parse error and detects duplicate IDs before writing output.
  - `deploy.yml` build step now uses `set -e` to propagate build failures.
  - `modify-location-submission.yml` now preserves existing coordinates when both coordinate fields are left blank (instead of failing with "Invalid coordinates").
  - Added `.catch()` to clipboard API call — shows "COPY FAILED" feedback instead of silently failing.
  - Removed stale `ripperdoc` tag from both issue templates and `docs/tags.md` (tag was removed from registry but references remained, causing validation failures).
- **Docs**:
  - Added Nexus V2 GraphQL API section to `CLAUDE.md` (endpoint, docs URL, query descriptions, caching strategy).
  - Added "What the API Reads from Your Mod Page" table to `docs/nczoning-auto-discovery.md`.
  - Standardized CET coordinate command to `print(GetPlayer():GetWorldPosition())` across all docs.
  - Added `npm run build` and `npm run validate` scripts to `package.json`.
  - Cleaned up `.gitignore` — removed dead `assets/images/raw maps/` pattern and duplicate `README.md` entry.

### 2026-03-13 (NCZoning auto-discovery)

- **Features**:
  - **NCZoning Auto-Discovery** — the map now queries the Nexus Mods V2 GraphQL API on page load for all Cyberpunk 2077 mods tagged with `NCZoning`. Mods with a valid `[NCZoning]` metadata block in their description are automatically added to the map as live pins — no GitHub submission required.
  - **BBCode Generator modal** — new `[+] SUBMIT` button in the header and sidebar opens a form that generates the `[code]NCZoning:...[/code]` metadata block. Includes CET coordinate inputs with a tooltip, category dropdown, tag checkboxes (populated from `tags.json`), credits, additional authors, an optional `[spoiler]` wrapper, a copy-to-clipboard button, and a reset button.
  - **Auto-discovered pin indicators** — auto-discovered mods display an amber `[ N ]` badge in the popup title and sidebar entry (tooltip: "Sourced automatically from Nexus Mods"). They also receive an automatic `nczoning` tag badge (with matching tooltip) visible in the popup, tag filter panel, and sidebar.
  - **Conflict resolution** — if a mod has both an auto-discovered entry and a manually submitted entry sharing the same `nexus_id`, the manual entry always wins.
  - **"Suggest Edit" suppressed** for auto-discovered mods — edits go through the Nexus description directly.
- **Bug Fixes**:
  - Fixed Nexus GraphQL filter sending `gameId` as a number — API requires a string (`"3333"`).
  - Fixed GraphQL query sending `uploader` as a scalar — corrected to `uploader { name }` (returns a `User` object).
  - Fixed BBCode block parsing failing on mod descriptions returned by the Nexus API with `<br />` HTML line breaks — parser now normalises these to `\n` before matching.
  - Fixed `applyFilters()` author lookup breaking when the `[ N ]` badge was added to the sidebar item name — authors are now stored in `li.dataset.authors` and read directly.
- **Docs**:
  - Added `docs/nczoning-auto-discovery.md` — full guide covering setup, BBCode format, field reference, editing, removal, conflict resolution, limitations, and misuse policy.
  - Updated `README.md` — NCZoning auto-discovery is now the preferred submission method; docs table updated.
  - Updated `CONTRIBUTING.md` — auto-discovery listed as preferred; GitHub issue listed as alternative; NCZoning guide added to useful docs list.
  - Updated `docs/adding-mods.md` — callout at top pointing to auto-discovery for mod authors who land there first.

### 2026-03-13

- **UI Improvements**:
  - Filter sections ("Filter by Tags", "Author Filters") now collapse to 2 rows by default with a "show more / show less" toggle. Sections with ≤2 rows of buttons hide the toggle automatically.
  - Sidebar location click now uses `flyTo` to the marker, then opens the popup after the animation completes. If the marker is inside a cluster, it spiderfies the cluster before opening the popup.
  - Map now calls `invalidateSize()` before `fitBounds` to ensure correct container dimensions on page load.
  - Popup `autoPan` disabled — the `maxBounds` constraint caused a visible snap-back; sidebar clicks handle positioning via `flyTo` instead.
- **Data**:
  - Removed `ripperdoc` tag from the tag registry.
- **Bug Fixes**:
  - Fixed workflow condition logic in `auto-pr-submission.yml` and `modify-location-submission.yml` — replaced `pull-request-created == 'true'` with `pull-request-operation != 'none'` to correctly detect PR creation/update using the v6 output. The old boolean output was unreliable and could cause both the "PR created" and "no changes" comments to fire simultaneously, or neither to fire.
  - Fixed missing mod thumbnails caused by the Nexus V2 GraphQL API silently capping `modsByUid` results at 20 — the query now passes an explicit `count` equal to the number of IDs requested, ensuring all thumbnails are fetched regardless of roster size.
- **Workflow Updates**:
  - `notify-discord-pr-status.yml` now automatically deletes the `add-mod-*` / `mod-mod-*` branch after a PR is closed (merged or not), keeping the repo branch list clean. Added `contents: write` permission to support this.
- **Maintenance**:
  - One-off deletion of 49 stale `add-mod-*` and `mod-mod-*` branches that had accumulated from previous workflow runs.
- **Docs**:
  - Updated mod submission and modification issue templates — added a coordinate guide (CET console and Simple Location Manager methods), a warning not to use World Builder coordinates, and a reminder to include the minus sign for negative values.

### 2026-03-12 (tags)

- **Data**:
  - Added new `photos` tag — scenic or atmospheric locations well-suited for virtual photography.
- **Docs**:
  - Created `docs/tags.md` — canonical reference for the tag registry, including the full tag list and step-by-step processes for adding, modifying, renaming, and removing tags.
  - Updated `CONTRIBUTING.md` — added link to `docs/tags.md` in the Useful Docs section.
  - Updated `docs/adding-mods.md` — tags field now links to the tag registry doc.

### 2026-03-12

- **Bug Fixes**:
  - Fixed `ReferenceError: path is not defined` in `auto-pr-submission.yml` that was crashing the workflow before the PR title output was set, causing new mod submissions to fail silently.
  - Fixed malformed SVG namespace (`http://www.w3.org/-2000/svg`) in sidebar footer icon.
  - Fixed incorrect CSS class `"collapsed"` applied to the sidebar on mobile when clicking a location — corrected to `"hidden"` to match the existing style contract.
  - Fixed author extraction in `auto-pr-submission.yml` — the `Author Alias(es)` label heading contains parentheses that broke the regex match, producing empty `authors` arrays in generated JSON files.
  - Fixed `_No response_` placeholder not being stripped from the `credits` field in `auto-pr-submission.yml` and `modify-location-submission.yml`.
  - Fixed `modify-location-submission.yml` overwriting an existing `credits` value with `"_No response_"` when credits were left blank on the form — a blank entry now correctly preserves the existing value.
- **GitHub Issue Form Improvements**:
  - Added `Category` dropdown to the modify/removal form (with "Keep existing" option to leave it unchanged).
  - Replaced the free-text `Tags` input on both the submission and modify forms with a `checkboxes` field listing all 14 valid tags with inline definitions — eliminates invalid tag submissions and removes the need to reference `tags.json`.
  - Made X/Y coordinates optional on the modify/removal form (removal requests no longer need to provide coordinates).
  - Moved the `Description` field to the last position on both forms.
  - Removed prefilled title prefixes (e.g. `[Mod Submission]:`) from all five issue templates — submitters must now write a meaningful title themselves.
- **Workflow Updates**:
  - Updated `auto-pr-submission.yml` and `modify-location-submission.yml` tag parsers to read the new checkbox format.
  - `modify-location-submission.yml` now extracts and applies category changes; defaults to "Keep existing" if unchanged.
  - Both submission workflows now trigger on `issues: labeled` only (replacing `opened`) — eliminates double-fire when a form auto-applies a label at creation, and allows maintainers to manually re-trigger by removing and re-adding the label.
  - `modify-location-submission.yml` Discord notifications now follow the same stored-ID pattern as the submission workflow: the initial "Awaiting Review" message ID is saved as a hidden comment on the issue so `notify-discord-pr-status.yml` can edit it on merge/close rather than post a new message.
  - `notify-discord-pr-status.yml` split into two jobs: `notify-submission` (edits the existing Discord message for `add-mod-*` PRs) and `notify-modification` (edits the existing Discord message for `mod-mod-*` PRs).
- **Labels**:
  - Created missing `mod-modification` label — its absence was silently preventing all modification/removal issue form submissions from triggering the automation workflow.
  - Created missing `feedback` label referenced by the General Feedback issue template.
- **UI**:
  - Restored the Join Discord link and SVG icon to the sidebar footer, beneath the Submit a Location button.

### [0.1.0-pre.1] - 2026-03-11

- **Nexus Mods API Integration**:
  - Successfully integrated the Nexus V2 GraphQL API.
  - Dynamically fetches official mod thumbnails and full-size promotional images using the provided `nexus_id`.
  - Image modals updated to exclusively display the officially fetched Nexus thumbnails.
- **Frontend Enhancements**:
  - Added a welcome modal loosely aligning with the "Dream On" quest to immerse users immediately upon load.
  - Interactive Map/Sidebar Integration: Hovering over a sidebar mod entry now triggers a neon pulse animation on the corresponding map pin or cluster icon.
  - Dynamic Map Pin Clustering: Integrated `Leaflet.markercluster` to group dense map pins. Clusters automatically "spider out" on hover to reveal individual pins, and remain expanded while a popup is open.
  - Added automated Nexus profile link generation for mod authors.
  - Unified Author and Tag filter layouts for visual consistency.
- **Automated Modification System**:
  - Implemented "Suggest Edit" system on all map popups using pre-filled GitHub issue templates.
  - Created `modify-location-submission.yml` workflow for automated location updates and removals.
  - Integrated Discord webhooks for real-time submission alerts.
- **Night Corp Modernization & UI Polish**:
  - Thematic branding applied to headers, modals, and list items.
  - Unified SVG icon system for sidebar navigation and replaced native emoji icons.
  - Category-colored active filter buttons for improved UX.
  - Cyberpunk-styled scrollbars and Leaflet map controls.
  - Moved external links (Discord, Report Bug, Suggest Feature) into the 'About Night Corp' modal and footer.
  - Added a mock `SYNC_OFFSET` telemetry generator in the footer to simulate an active system status (operates nominally 85% of the time, improving visual calmness).
- **Maintenance & Bug Fixes**:
  - Swept, removed, and resolved all underlying CSS variables conflicting with the old colour palette (`--cb-` to `--nc-`).
  - Fixed duplicate CSS header rules causing potential layering issues (`z-index`).
  - Corrected raw markdown syntax rendering incorrectly inside the Welcome Modal DOM.

### 2026-03-07

- **Data Architecture Refactor**:
  - Migrated monolithic `mods.json` into individual granular JSON files in `data/locations/`.
  - Implemented a build step (`scripts/build_mods.js`) to compile individual files.
  - Updated `mods.schema.json` to support multi-author arrays and team credits.
- **Mod Locations**:
  - Added **Improved Aldecaldos Camp** (Mod ID: 13821) and **V's Edgerunners Mansion Reloaded** (Mod ID: 26023).
  - Corrected author alias for "APEX - Sonora Canyon and Safehouse".
- **Dynamic Tagging**:
  - Implemented `tags.json` registry and automated validation script.
  - Added tag badges and filtering sidebar.
- **CI/CD Workflows**:
  - Overhauled `auto-pr-submission.yml` for granular JSON structure.
  - Integrated validation and build steps into `deploy.yml` and `validate-mods.yml`.
- **Security**:
  - Updated `.gitignore` to prevent tracking of compiled `mods.json`.
