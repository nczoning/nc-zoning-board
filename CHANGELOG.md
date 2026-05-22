# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Three.js 3D Schematic Map (in progress — dev branch)

#### Three.js-Parity: in-game lighting pipeline (ACES tonemap + grade + LUT)

- The 3D scene now reproduces the in-game map's full decoded colour pipeline — an ACES SSTS tonemap, the envparam colour grade, and the **braindance grading LUT** — all from `base/weather/24h_basic/3dmap.envparam`. New standalone module [`aces-tonemap.js`](assets/js/aces-tonemap.js) (the ACES Output Transform, registered as a custom WebGPU tone-mapping function); new [`scripts/build_lut.js`](scripts/build_lut.js) extracts the 32³ LUT to `assets/data/braindance-lut.bin`.
- Game theme `--scene-*` are now the exact extracted material albedo (no eyedropping); the grade + LUT are gated to the Game theme via the `--scene-grade` CSS variable — the five stylised themes keep their own look and get only the tonemap.
- Sun, ambient and `toneMappingExposure` calibrated against an SDR PIX capture of the in-game map. Full pipeline documented in [docs/3d-map-lighting.md](docs/3d-map-lighting.md).

#### Three.js-Parity: building edge surface gradient

- Building faces now carry the game's centre-dark → edge-light gradient. The decoded edge term `pow(X, EdgeSharpnessPower)` is a gradient, not a step — it had been rendered as a flat thin band, dropping the falloff. Now rendered as the real gradient, box-filtered over the pixel footprint so the steep rim self-antialiases under minification.

#### Default "Game" theme

- New **Game** theme — matches Cyberpunk 2077's in-game world-map palette (UI colours, calibrated 3D scene, roads/metro). Selectable from the theme dropdown.
- Road, border and metro decals now use the game's decoded blend — additive, with metro at the decoded `0.235` opacity (was eyeballed Normal-blend / `0.9`). The five other themes' `--overlay-metro-color` were rebrightened to suit the lower opacity.

#### Preem Map theme

- New **Preem Map** theme — based on the Preem Map mod by CyanideX (used with permission; attribution required at ship time). 3D-scene colours renderer-calibrated to the mod's in-game palette.
- New `--scene-landmarks` theme variable — the landmark monuments are now coloured independently of the building cubes (the Preem mod recolours buildings but leaves the monument meshes vanilla). The other six themes set it equal to their building colour, unchanged.

#### Three.js-Parity: intro camera fly-in (E5)

- The 3D map now opens with a brief (~1.2 s) fly-in — the camera eases from a far, slightly leaned-back pose down to a whole-city framing (11000 wu). Skipped when a `?mod=` deep-link is present. New `NCZ.SCHEMA_INTRO_*` constants.
- Fixed: the map silently opened fully zoomed out. The old `fitCameraToBox` opening computed a fit distance that always exceeded `controls.maxDistance`, so the documented opening distance never took effect. `fitCameraToBox` removed; `resetCamera` now snaps to the fly-in's rest pose.

#### Three.js-Parity: metro LOD crossfade

- Metro LOD tiers (dotted / thin / wide) now **crossfade** by camera distance instead of hard-switching, decoded from the `3d_map_metro.mt` pixel shader (PIX capture). Real thresholds: tiers change at 2500 / 9000 / 15000 wu (game `VisibilityDistance*` ÷ 2 — the game's metric is `2 × cameraZ`), crossfading over a 150 wu band.
- Fixed: the metro showed the wrong tier on first load until the camera moved — the distance uniform was seeded from a constant instead of the live camera.

#### Three.js-Parity: building surface modulation

- Building `_m` surface modulation corrected to the game's decoded value — `0.4 + 0.5·m` (was a guessed `0.3 + 0.7·m`). Decoded from the same `3d_map_cubes.mt` shader capture; the shader's vertical-AO term ships disabled, so it collapses to a flat floor + range.

#### Three.js-Parity: building edge highlight

- Building edge highlight rewritten to the game's actual algorithm, decoded from the `3d_map_cubes.mt` gbuffer shader (PIX capture): `saturate(pow(max(|1-2u|,|1-2v|), EdgeSharpnessPower))` mixed into the albedo. Real per-district constants (`EdgeThickness`/`EdgeSharpnessPower`) replace the previous guessed values.
- Flicker fixed — analytic `fwidth` anti-aliasing stands in for the game's TAA, the same approach as the terrain grid.

#### Three.js-Parity: procedural terrain grid

- Terrain, water and cliffs now carry the game's "graph-paper" grid — a procedural three-tier anti-aliased line grid (cells 80 / 8 / 400 wu) on world XZ, decoded from the game's `3d_map_terrain` pixel shader.
- New theme variable `--scene-grid` colours the grid lines per theme; surface base colours are unchanged. New `NCZ.TERRAIN_GRID_*` constants in [`constants.js`](assets/js/constants.js).

#### Three.js-Parity: cluster panel UX cleanup (E12)

- Picking a mod from the cluster panel now flies to the pin and **keeps the panel open** as a comparison list (was: closed on click). The picked pin stays full-opacity, the rest of its cluster dims; re-clicking the active cluster bubble (before a pin is picked) toggles the panel closed; empty-canvas click closes the panel in 3D too (2D parity).
- The cluster is **guaranteed to dissolve** on pick via force-individual (2D pulls the markers out of `markerClusterGroup`; 3D excludes them from the distance clusterer) instead of depending on zoom/spacing. **Spiderfy removed entirely** — `focusMarker` no longer uses `zoomToShowLayer`; a clustered-but-focused pin is kept visible by force-individual instead.
- `?mod=` deep-link is now written eagerly on focus (not on popup open) so cross-view camera/popup restore works for clustered pins; 2D popup-open deferred to flyTo settle to kill the ghost/vibrating double-popup.

#### Three.js-Parity: camera gestures over pins/clusters/popups

- `OrbitControls` now attaches to `#map-3d` (parent of canvas + CSS2D overlay) instead of `renderer.domElement`, with `setPointerCapture` / `releasePointerCapture` overridden to no-ops on that element. Copies Leaflet's `Draggable` pattern (drag handler at the container, no pointer capture) so pan/zoom gestures pass through pins and cluster bubbles to the camera while the per-element `click` handlers stay intact.
- Drag-vs-click discrimination via a `_dragSuppressClick` flag in `three-markers.js` (set when the container-level `pointerdown→pointerup` distance exceeds `PIN_3D_DRAG_THRESHOLD_PX`). Popup card stops `pointerdown` propagation so internal interactions don't arm phantom drags.
- `#scene-controls` (Reset/Showcase buttons, sun slider, tilt) now stops `pointerdown`/`wheel`/`contextmenu` propagation so operating an on-canvas control no longer pans/zooms the camera (the inverse of the pin case — Leaflet's `disableClickPropagation` idiom).

#### Three.js-Parity: district outline visibility + camera ergonomics

Three changes, all matching game behaviour more closely than what shipped in #653:

- **Three-state district outline visibility** mirroring TweakDB `WorldMap.ZoomLevel*` `showDistricts` / `showSubDistricts` flags: districts visible at d ≥ 11000, subdistricts at 7000 ≤ d < 11000, **neither** below 7000. The "always-visible" group (Dogtown / Morro Rock main outlines, Casino subdistrict) is now tied to the outline-tier-visible rule too — vanishes with subs at close zoom. Closes the long-standing "colored rays across the viewport at close zoom" bug as a side effect: the rays originated in `Line2NodeMaterial`'s screen-space line shader hitting some failure mode under perspective + reverse-Z (issue [#654](https://github.com/spuddeh/nc-zoning-board/issues/654)), but they only ever appeared when subdistrict outlines were rendered at d < 7000 — exactly the zoom band the game itself leaves empty. Matching the game's visibility eliminates the bug surface entirely.
- **Ground-plane panning** (`controls.screenSpacePanning = false`) replaces the OrbitControls default. Under perspective, the default screen-space pan has a world-Y component whenever the camera is tilted — left-drag panning at high tilt slowly lifts `controls.target` off the ground, the orbit pivot moves up, and the camera itself appears to climb as you pan. Orthographic hid this; perspective surfaced it. Ground-plane panning constrains the target to Y=0 implicitly and makes vertical-drag move at the same rate as horizontal-drag at any tilt.
- **Polygon vertex dedup at load** (epsilon = 0.1 wu) in `buildLine` defends against zero-length edges in `data/subdistricts.json` — the Shapely `difference()` / `unary_union()` pipeline in `scripts/regenerate_subdistricts.py` rounds output coordinates to 2 decimal places, which can collapse points produced 0.001 wu apart into identical coordinates. Catches the 8 degenerate vertices currently present in 4 badlands/pacifica subdistricts. Not the root cause of the rays (verified by testing), kept as defensive code.

Issue #654 still tracks the underlying `Line2NodeMaterial` × `reversedDepthBuffer` interaction (the actual shader path causing the rays — root cause likely the screen-space line shader producing NaN/Inf direction vectors for some near-camera projection edge case). The visibility-rule fix puts that bug out of the user's typical zoom range without solving the shader bug itself.

#### Renderer: WebGL → WebGPU

The 3D scene renders through `WebGPURenderer` (automatic WebGL2 fallback). Native engine features replace the old WebGL workarounds; visuals are parity-or-better at the five canonical viewpoints.

- **Native depth + lighting** — reverse-Z depth buffer (`reversedDepthBuffer: true`) replaces `logarithmicDepthBuffer` and keeps early-Z; the two `onBeforeCompile` shader patches (building-edge highlight, metro LOD discard) are now TSL node materials; `AmbientLight` → `HemisphereLight` ("lit like it's outside") with one fitted orthographic shadow map tracking the visible-ground footprint (no cascades).
- **GPU compute frustum culling for buildings** — a compute pass (per camera change) appends the visible building instances to a storage buffer and writes the indirect-draw `instanceCount`; replaces Three's host-side cull, which was a no-op for our cube-at-origin instances. Building instance matrices moved from `InstancedMesh.instanceMatrix` to an `instancedArray` storage buffer.
- **SeeThrough-roads stencil (Pacifica tunnel)** — ported to material-level stencil flags. `transparent: true` on the water material (opacity 1.0 — still visually opaque) puts it in the always-last transparent pass so its `stencil = 2` write stays depth-confined to the open bay; terrain and cliffs over-stamp `stencil = 1` like buildings.
- **Debug dump** — `dumpDebugInfo()` branches on `renderer.isWebGPURenderer`; GPU name/vendor read from `GPUDevice.adapterInfo`. New `getCullCounts()` console helper reads the indirect buffer back for visible-vs-total building instances.
- **Firefox WebGPU fix** — `requiredLimits` is now built from the adapter's real limits: `maxStorageBuffersInVertexStage` is requested only on adapters that expose it (Chrome). Firefox 150 lacks that newer per-stage limit name, and WebGPU rejects the whole device request for an unrecognized `requiredLimits` key — which silently demoted the 3D scene to WebGL2 on Firefox.
- **WebGL2 fallback → 2D map** — when no real WebGPU backend initialises, `init()` aborts before building the scene and the user is dropped onto the fully-functional 2D Leaflet map with a one-time notice (the building compute pipeline has no WebGL2 path, so a degraded 3D view isn't shown).
- Backend detection switched from `renderer.isWebGPURenderer` (true even on the WebGL2 fallback) to `renderer.backend.isWebGPUBackend`; corrects the previously-mislabelled debug-dump backend line.

New constants in [`constants.js`](assets/js/constants.js): `NCZ.STENCIL_WATER` (2), `NCZ.STENCIL_OCCLUDER` (1), `NCZ.WATER_OPACITY` (1.0); plus a reworked `SHADOW_*` set for the single fitted shadow map (`SHADOW_MAP_SIZE`, `SHADOW_MAX_DISTANCE`, `SHADOW_GROUND_MARGIN`, `SHADOW_NORMAL_BIAS_TEXELS`) and `SUN_DIST`.

#### Three.js-Parity: schema camera (orthographic → perspective)

- Schema camera is now `PerspectiveCamera` at **FOV 25°** matching the game's TopDown view. Values mirror TweakDB `WorldMap.TopDownCameraSettingsDefault` (zoom min/default/max = 800 / 3000 / 15000 CET units). Replaces the prior `OrthographicCamera` — chosen originally without reference to the game's actual setup. See [`docs/data/worldmap_tweakdb_tree.json`](docs/data/worldmap_tweakdb_tree.json) for the full record dump.
- Downstream perspective-aware refactors: shadow camera footprint via a 4-corner ray-cast against `Y=0` (handles tilt without an analytic `1/cos` stretch); scale bar, district→subdistrict label switch, and pin cluster threshold all driven by camera-to-target distance; `flyTo` lands at `SCHEMA_FLY_TO_DISTANCE = 1250` (TweakDB `zoomToZoomValue`).
- **Pan envelope** now uses the game's canonical `cursorBoundary` (X[−5500..6050], Y[−7300..5000] in CET → Z[−5000..7300] in Three.js) instead of the wider terrain GLB extent.
- **Showcase exit** dips the 3D container's opacity for ~150 ms across the camera swap (schema 25° ↔ flyover 55° FOV) so the perspective change reads as an intentional transition rather than a hard cut.
- **Metro LOD** mutex tier switch (B wide → G thin → R dotted) driven by schema camera-to-target distance, replacing the legacy `camera.zoom` reading. Thresholds at `MED = 7000` and `NEAR = 2500` (CET wu) align with the WorldMap zoom-ladder rather than the metro material's `VisibilityDistance*` values — the latter don't map onto a camera-to-target metric since our `zoomMax = 15000 < 18000`. Constants page documents the deviation.
- Follow-ups queued: **CSM shadows** (the "no cascades because schema is ortho" rationale dissolved with this change); cluster-radius re-tune for the new screen-space behaviour; `pitchRelativeToZoom` lean-back curve from TweakDB; **Line2 near-plane clipping** under perspective (district outline segments whose endpoints cross the camera near plane stretch as straight rays across the viewport — pre-existing latent bug, only visible under perspective).

#### Three.js-Parity: shadow accuracy

- Off-screen buildings now cast shadows into the visible area. The Phase 2B GPU compute cull tests each building instance against the union of the camera frustum and the sun's shadow-camera frustum (12 planes via boolean OR) instead of the camera alone — so a caster just outside the view still makes it into the indirect-draw buffer.

#### Showcase fly-through — WebGPU parity (partial)

- `renderFrame(cam)` now dispatches the Phase 2B cull computes and refreshes the cam-frustum uniforms each cinematic frame. Previously the cull only ran in the schema `renderLoop()` (suppressed during showcase), so the building indirect buffer's `instanceCount` was frozen at whatever the schema cam last culled — buildings popped in/out of the cinematic and most shadows were missing because their casters were never in the buffer.
- Metro LOD pinned to the R-tier (dashed close-zoom variant) for the whole showcase. The previous tier-switching read `camera.zoom`, which a perspective camera doesn't have; calibrating altitude→tier across all 11 waypoints isn't worth the tuning effort.
- `startRenderLoop()` snaps the cull-frustum uniforms, shadow camera, and metro pseudo-zoom back to schema-cam values on showcase exit so the first post-cinematic frame draws cleanly.
- **Shadow fit for the fly cam** — replaces the schema cam's NDC-corner rect-fit (which produced 11000-wu single-frame jumps at horizon-tilted poses) with a fixed-size box centred where the camera-forward ray meets the ground. Ray-to-ground distance is capped (`MAX_T_HIT = SHADOW_MAX_DISTANCE * 0.6`) so near-horizontal cameras don't fling the centre tens of km off-world; the centre is then clamped to world bounds (`WORLD_MIN_X..MAX_X`, `−WORLD_MAX_Y..−WORLD_MIN_Y` in three-space) since the scene is finite. Schema cam still uses rect-fit unchanged. CSM revisit deferred — single fitted box is stable across all 11 waypoints now (verified via per-frame trace, `NCZ.__shadowTrace = true`).
- **Shadow cap reduced** `SHADOW_MAX_DISTANCE` 12000 → 8600 (matches the world half-diagonal of ~8565 wu with tiny headroom). Trace data showed `half` pinned at the cap (12600 = 12000 + 600 margin) every showcase frame; the cap was sized for a hypothetical scene larger than this one, so reducing it shrinks the shadow box uniformly without affecting coverage — nothing renders past world bounds. Net effect: **texels go from 6.15 wu → 4.49 wu (~1.37× sharper) at zero perf cost**. Bonus: smaller cap also tightens `MAX_T_HIT` (7200 → 5160 wu), which halves frame-to-frame centre motion (max jump 1591 → 723 wu) — smoother shadow tracking as a side effect.

#### Render-on-demand

- The 3D scene's rAF loop now runs only when something has actually changed (camera moved, damping in progress, sun/theme/layer/material updated, pins added) instead of unconditionally re-rendering every frame. Idle map views cost zero GPU/CPU; saves battery on every machine and recovers headroom on weaker iGPUs (Intel UHD without Iris Xe was the worst case). Implemented in [`three-scene.js`](assets/js/three-scene.js) via a new `requestRender()` entrypoint hooked into every state-mutating helper, with a `_suppressed` flag that prevents in-flight color tweens from racing the flyover camera.
- ThreeMarkers added a private `_redraw()` helper that forwards to `ThreeScene.requestRender()` and is called from every pin/popup/cluster state mutation, plus the camera fly-tween (which mutates camera position/zoom directly without firing OrbitControls 'change'). The fly-tween now self-extends the loop until completion.

#### Pin/canvas alignment on fractional DPR + capped renderer DPR at 1.5

- Pins drifted off the WebGL scene on any DPR > 1.0 (~25% off at 1.25, ~50% at 1.5). The `<canvas>` was missing a `width:100%; height:100%` CSS rule, so it fell back to its intrinsic drawingBuffer size while the `CSS2DRenderer` overlay correctly filled the container. Added the missing rule in [`style.css`](assets/css/style.css).
- Capped `renderer.setPixelRatio` at `NCZ.MAX_DEVICE_PIXEL_RATIO = 1.5`. Saves ~44% GPU pixel work on Retina / 4K@200% displays; no-op for anyone at DPR ≤ 1.5.

#### Object3D naming for Needle Inspector hierarchy

Every Object3D in the scene now has a `.name` so the Needle Inspector reads as English (`buildings-westbrook`, `landmark-3dmap_obelisk`, `pin: Crystal Palace Resort`) instead of Three.js's auto-generated `Group_335` / `mesh_0`. Pure metadata — no behaviour change.

- **Top-level scene entities** in [`three-scene.js`](assets/js/three-scene.js): `main-scene`, `schema-camera`, `sun`, `sun-target`, `ambient-light`, `sun-sphere`, `terrain`, `water`, `cliffs`, `roads`, `metro`, `districts`, `landmarks`, `buildings`, plus `flyover-camera` from [`flyover.js`](assets/js/flyover.js) when the showcase runs.
- **Per-instance names** so the Inspector filter is actually useful: `buildings-<district>` for each district's InstancedMesh, `landmark-<glb-filename>` for each landmark, `district-outline-<id>` and `subdistrict-outline-<dist>/<sub>` for boundary lines.
- **Pin/cluster/popup/tooltip names** in [`three-markers.js`](assets/js/three-markers.js): each pin is `pin: <mod.name>`, each popup is `popup: <mod.name>`, the singleton tooltip is `pin-tooltip`, cluster bubbles update per recompute to `cluster (N mods)`. Typing `pin:` in the Inspector filter shows only pins; `cluster` shows only clusters.
- **`nameSubtree(root, prefix)` helper** walks each loaded GLB and gives every descendant a prefixed, type-tagged name (`road-mesh-0`, `metro-line2-3`, etc.). A regex overrides WolvenKit/Blender-baked generic names like `mesh_0` while preserving any genuinely descriptive name an artist might have set.

Driven by wiring up the Needle Inspector Chrome extension to the dev server. Pre-naming, every loaded GLB collapsed to `Group_NNN → mesh_0`; post-naming, every node identifies itself.

#### ThreeMarkers — pins on a Three.js layer + Pins overlay toggle + showcase camera follow

Pins, clusters, popup and tooltip CSS2DObjects now sit on a dedicated Three.js scene-graph layer (`NCZ.LAYER_PINS = 1`) rather than living silently on the default layer. Cameras opt into the marker overlay through `Camera.layers`, which means visibility is now governed by the same primitive Three.js uses for everything else.

- **Pins overlay toggle** — new `<input data-overlay="pins" checked>` entry in `#overlay-controls`, sitting alongside Districts/Roads/Metro/Buildings/Shadows. Routes through the existing `ThreeScene.setLayerVisibility('pins', bool)` / `getLayerVisibility('pins')` API, which forwards to `ThreeMarkers.setOverlayVisible` / `getOverlayVisible` — those flip the schema camera's `LAYER_PINS` membership. CSS2DRenderer's per-object layer test sets each pin/cluster/popup/tooltip DOM element's `display` to `'none'` on the next render frame, so toggling the checkbox immediately hides the marker overlay without disturbing the underlying scene.
- **Showcase: pins follow the cinematic camera** — the showcase modal now has a "Show mod pins during showcase" checkbox (off by default). When on, `flyover.js` enables `LAYER_PINS` on the perspective `flyCamera` and calls `ThreeMarkers.setActiveCamera(flyCamera)` so the CSS2DRenderer projects pins against the cinematic camera. Every showcase rAF tick now also calls `ThreeMarkers.render()` after `NCZ.ThreeScene.renderFrame(flyCamera)`, so positions reproject each frame and the layer-test handles visibility transparently. When off, the same machinery runs but the flyCamera doesn't enable `LAYER_PINS`, so each pin DOM gets `display: 'none'` — no leftover frozen pin positions, no hammer-style `setVisible` needed.
- **Cluster recompute guard for the perspective camera** — cluster math reads orthographic-only fields (`camera.zoom`, `camera.right`, `camera.left`). The recompute scheduler now early-returns when the active camera isn't the schema camera, so the math never sees a perspective camera. Clusters keep their last-recomputed positions for the duration of the showcase. On showcase exit, `setActiveCamera(null)` triggers a fresh recompute against the schema camera so post-showcase zoom changes work correctly.
- **Removed `ThreeMarkers.setVisible`** — the PR #633 hammer that toggled `cssRenderer.domElement.style.display` is gone; visibility now flows through the layer system. `app.js`'s `enterShowcase` / `exitShowcase` no longer manage marker visibility — `flyover.js` owns the active-camera lifecycle entirely.
- **Camera reference split inside ThreeMarkers** — the previous `let camera` is now `let _schemaCamera` (used by orthographic-only math: cluster recompute, fly-to-pin tween) and `let _activeCamera` (used by the popup projection and the render call). `getCam()` returns the active one, falling back to the schema camera. New public API: `setActiveCamera(cam)`, `setOverlayVisible(bool)`, `getOverlayVisible()`, `setUnclusteredMode(bool)`.
- **Pins are unclustered during the showcase** — when `showPins` is on, individual mod pins fly past instead of cluster number-badges. ThreeMarkers' `setUnclusteredMode(true)` hides the `_clusterLayer` and unhides every filter-passing pin; on stop, `setUnclusteredMode(false)` followed by `setActiveCamera(null)` triggers the recompute that rebuilds the normal clustered state. Cluster bubbles in the SCHEMA view are unaffected.
- **Pins join the staggered layer reveal** — when both `revealLayers` and `showPins` are on, pins reveal at `FLYOVER_REVEAL_PINS = 6000ms` after WP0 (1500ms after buildings, matching the existing roads/metro/buildings cadence). Without `revealLayers`, pins are visible from frame 1 of the showcase as before.

The two visibility flags — overlay toggle and showcase "Show pins" — are intentionally orthogonal: toggling Pins off in the overlay panel doesn't affect what the showcase does, and ticking "Show mod pins during showcase" doesn't permanently enable pins after the cinematic ends. Two cameras, two independent layer masks, one shared scene graph.

New constant in [`constants.js`](assets/js/constants.js):

- `NCZ.LAYER_DEFAULT` (0) — scene geometry (terrain, water, buildings, roads, metro, districts, landmarks)
- `NCZ.LAYER_PINS`    (1) — marker overlay (pins, clusters, popup, tooltip)

#### Showcase Options modal — user-configurable flyover

Clicking the Showcase button now opens an options modal instead of starting the cinematic immediately. Defaults match today's behaviour exactly, so the experience is unchanged unless you opt into something.

- **Theme** — drop-down with "Cycle (beat-driven)" as default plus each of the five themes. Selecting a specific theme suppresses the per-beat cross-dissolve and locks the scene to that palette for the whole showcase. The hard-coded `applyTheme('night-corp')` at WP0 also honours the lock, so a chosen Synthwave run never flashes Night Corp on the way in.
- **Stagger layer reveal at start** — exposes the previously-hard-coded `FLYOVER_REVEAL_LAYERS` flag. Off by default (matching today). When on, roads → metro → buildings reveal across the 6.9s ocean approach.
- **Show district outlines** — toggle for keeping district lines visible during showcase (today they're always off). The WP9 "drop districts before Badlands sweep" event is conditional on this flag, so user-enabled districts persist through the city-behind-camera waypoint.
- **Play music** — mute the announcer track. Beats and sun position still drive off `audio.currentTime` and the `'ended'` event, both of which fire on muted media in Chromium and Firefox, so muting doesn't introduce timing drift.
- **Loop showcase** — at `audio.ended`, rewind and restart instead of fading to black. `_beatColorIndex` deliberately persists across loops (per the existing comment) so the colour cycle continues seamlessly. Esc still exits cleanly.
- **Persistence** — selections are stored in `localStorage[NCZ.SHOWCASE_OPTIONS_KEY]` and restored on next modal open. Validation falls back to defaults on parse error or junk values, mirroring the theme-preference pattern.
- **API change** — `NCZ.Flyover.startFlyover()` now accepts an optional options object: `{ theme, revealLayers, districts, audio, loop }`. All fields default to today's behaviour, so the zero-arg call still works for any legacy caller.

The showcase trigger preserves its current toggle UX: clicking the button while a showcase is running calls `exitShowcase()` directly, no modal. The modal only appears when starting from a stopped state. Fullscreen request stays inside the user-gesture task because Start-button click → `enterShowcase` is synchronous.

#### ThreeMarkers — pin/popup layer for the 3D view

The 3D scene now has interactive mod pins matching the Leaflet view's behaviour. Pins, popups, sidebar interactions, and the Discover button all work in SCHEMA mode.

- **Pin rendering** — one `CSS2DObject` per mod, anchored at the player's CET (X, Y, Z) position with a small visual lift (`PIN_3D_GROUND_OFFSET`). Validated against in-game readings (see `docs/cet-z-terrain-experiment.md`): CET Z and terrain GLB Y are in the same coordinate space — no raycast or offset needed beyond the cosmetic lift.
- **Popups** — click a pin to open a popup with the same HTML, border gradient, category colour, and arrow as the Leaflet view. Auto-flips above/below the pin based on viewport position. Closes on outside-click (drag-aware: dragging the camera does not close the popup).
- **Click selected pin to deselect** — Leaflet-style toggle behaviour.
- **Hover pin → tooltip** — single reusable `CSS2DObject` shows the mod name on pin hover; reuses the Leaflet `.pin-tooltip` skin so 2D and 3D tooltips look identical.
- **Sidebar integration** — the same sidebar (filters, search, mod list) drives both views. Filter checkboxes affect 3D pin visibility via `applyFilters()`. Sidebar item hover pulses the corresponding pin in both views simultaneously. Sidebar item click flies the camera to the pin (smooth tween, configurable via `PIN_3D_FLY_DURATION_MS` / `PIN_3D_FLY_ZOOM`) and opens the popup.
- **Camera fly-to** — tweens `controls.target` and `camera.position` by the same delta (preserving the spherical offset) plus `camera.zoom` over `PIN_3D_FLY_DURATION_MS` (default 700ms, ease-in-out cubic). Cancels immediately on user input. Targets the pin's full Y so rooftop pins (e.g. Crystal Palace Resort) land at screen centre regardless of camera tilt.
- **Discover button works in 3D** — `focusRandomVisibleMarker` routes to ThreeMarkers in SCHEMA mode, picking a random pin whose CSS2DObject is visible (i.e. passed the active filters).
- **Pin clustering in 3D — world-space distance** — groups pins by their actual XZ distance in CET world units, not by screen pixels. Cluster radius scales with zoom (PIN_3D_CLUSTER_RADIUS_PX × world-units-per-pixel at current zoom) so clusters dissolve as the user zooms in, matching Leaflet's behaviour. Recomputes only on zoom change or filter change — pan and tilt leave clusters intact, so rotating the camera no longer reshuffles cluster membership. Renders cluster bubbles at world centroid using the same `marker-cluster-step-N` colour ramp as Leaflet. (Earlier screen-space clustering produced semantically wrong groups at high tilt — pins far apart in the world but visually close on screen would cluster together. Aki's UX call to switch.)
- **Right-click context menu suppression on the 3D overlay** — drag-aware. Releasing a right-click camera-tilt over a pin / cluster / popup / tooltip used to pop the OS context menu (OrbitControls only suppresses the canvas, not the CSS2D overlay siblings). New listener on `#map-3d` records right-pointerdown position and only `preventDefault`s the `contextmenu` if the cursor moved more than `PIN_3D_DRAG_THRESHOLD_PX` (= it was a tilt-drag). Standalone right-clicks still fire the menu so devs can use inspect-element / "open image" / etc.
- **Cluster click → cluster panel (both views)** — refactored Leaflet's inline cluster handler into a shared `populateClusterPanel(modsList, opts)` helper that both views call. Clicking a cluster bubble in either view populates the same DOM panel with thumbnails, names, authors, tags, descriptions, and image-modal triggers.
- **Map-aware cluster panel** — when 3D clusters recompute (camera moved/zoomed/tilted) or Leaflet clusters re-form (zoom/filter), the panel finds the *successor* cluster (the one with the most overlap with the panel's mod set) and updates its contents. Closes when the cluster fully dissolves into singletons or the view switches. Behaves identically in both views.
- **Active-cluster visual indicator** — the cluster bubble whose contents are showing in the panel gets a `.marker-cluster-active` class (cyan ring + glow + raised z-index). Shared CSS rule across views; both layers track and re-apply the mark across their respective recompute lifecycles.
- **Stays-open-on-zoom** — removed the `map.on("zoomstart", hideClusterPanel)` side-effect that was incidentally closing the panel when sidebar item clicks triggered Leaflet's `zoomToShowLayer`. Both views now leave the panel open during camera moves; closes only on outside-click, close button, view switch, or cluster going stale.
- **Pannable bounds in 3D** — `controls.change` listener clamps `controls.target` to the terrain GLB extent (square `~[-8000, 8000]` in X and Z) plus viewport-relative padding (`PIN_3D_PAN_EDGE_FRACTION = 0.5` matches Leaflet's `panEdgeFraction` — at max pan, terrain edge sits at viewport centre). Camera position moves by the same delta as target so OrbitControls' spherical offset stays consistent. Tilt-aware refinement deferred (a first attempt produced catastrophic camera jumps when bounds inverted at extreme zoom-out + tilt; reverted in favour of the stable simpler bound).
- **Distance scale bar in 3D** — bottom-right of the scene, between the view-toggle and controls strip. Picks "nice" 1/2/5 × 10ⁿ-metre rounded lengths closest to ~100 px wide, recomputed on every `controls.change` and on resize. Shares the `.leaflet-control-scale-line` skin with the SAT scale bar — single CSS source of truth, both views render identically.
- **Cross-view popup state sync** — opening a popup in either view updates `?mod=` in the URL. Switching SAT ↔ SCHEMA re-opens the same pin in the new view.
- **Popup chrome unified** — `.ncz-dynamic-popup` is now the single source of truth for popup background gradient, arrows, and category colours. Both `.leaflet-popup-content-wrapper` (2D) and `.three-popup` (3D) target the same shared rules; only Leaflet's structural reset and the 3D anchor positioning are view-specific. Removed ~100 lines of duplicated CSS in the process.
- **Coordinate-system finding (retraction)** — the previous "elevation gap" claim between CET Z and terrain GLB Y (7–23m) was sampling bias from readings taken on top of platforms. In-game teleport experiment to five terrain-only locations confirmed the two are in the same coordinate space (±6m noise from player height + LOD smoothing). See `wiki/learnings/cet-z-equals-terrain-y.md`.

New constants in [`constants.js`](assets/js/constants.js):

- `PIN_3D_GROUND_OFFSET` (5) — visual lift above CET Z
- `PIN_3D_DRAG_THRESHOLD_PX` (4) — drag-vs-click pixel detection
- `PIN_3D_POPUP_FLIP_PADDING_PX` (24) — auto-flip viewport padding
- `PIN_3D_FLY_DURATION_MS` (700) — fly-to-pin tween length
- `PIN_3D_FLY_ZOOM` (15) — target camera zoom at end of fly

New helper script: [`scripts/query_terrain_heights.py`](scripts/query_terrain_heights.py) — raycasts the terrain GLB at given CET (X, Y) coordinates, used to compute safe teleport heights for the coordinate-system experiment. Documents the axis-convention mismatch with `generate_terrain_contours.py` (corrected pattern in the new script's comments).

#### Debug dump — RAM as power-of-2 range, not floor

- The hardware-info section of the debug dump previously showed `Memory: ≥X GB (approx)` from `navigator.deviceMemory`. The `≥` was correct in spirit but readers were silently parsing it as "approximately X" — a 64 GB system reported "≥32 GB" and a 16 GB system reported "≥8 GB", suggesting much smaller hardware tiers than the user actually had.
- Root cause is the API itself: `navigator.deviceMemory` is Chromium-only (Firefox and Safari return `undefined` and fall through to `Memory: unknown`). Where it IS supported, the value is the largest power of 2 strictly less than the actual RAM — Chromium ignores the spec's 8 GB cap but still applies the rounding. The actual RAM therefore always falls in `(reported, 2 × reported]`. There is no better browser API for total system memory — `performance.memory.jsHeapSizeLimit` is the V8 heap cap (2–4 GB), unrelated to physical RAM.
- Display now shows the half-open range explicitly: `Memory: 32–64 GB (browser reports power-of-2 floor)`. Same data, no room for misreading the floor as a precise figure. Phrased as "browser" rather than "Chrome" since the rounding is observable in every Chromium variant (Edge, Brave, Vivaldi, etc.). Trailing parenthetical signals the limitation is browser-side, not a bug in the dump.

#### Static-subtree matrix freeze + camera frustum tighten (PR #629)

- `matrixWorldAutoUpdate = false` on terrain, water, cliffs, roads/borders, metro, districts, landmarks, and the buildings InstancedMesh group. Each subtree's world matrices are computed once after positioning and then frozen — Three.js's per-frame `updateMatrixWorld()` traversal skips the entire branch instead of walking thousands of nodes only to find no work
- New `freezeStatic(obj)` helper in [`three-scene.js`](assets/js/three-scene.js) wraps the "compute once + disable auto-recurse" pattern
- Dynamic objects (sun light, sun sphere, camera) keep default auto-update — visibility toggles, theme transitions, and shadow-camera updates don't depend on this change
- Camera near/far tightened from `±50000` → `±20000`. Worst-case camera-local depth (max 70° tilt + max-pan to world edge) is ~23k, so 20k leaves comfortable margin while halving the orthographic depth budget. Linear precision benefit is muted by the `logarithmicDepthBuffer` change in #627 but no reason to keep the budget 2.5× oversized

#### Renderer GPU hint: `powerPreference: 'high-performance'` (PR #628)

- One-flag `WebGLRenderer` option that hints the OS to pick the discrete GPU on hybrid-graphics laptops (NVIDIA Optimus, AMD Switchable Graphics, Apple's automatic switching). Driver/OS policy can override, but free for users who'd otherwise get stuck on the integrated chip
- An exploratory 0.2% building-instance scale shrink was bundled into the original PR and reverted before merge — the shrink didn't reduce residual pan-shimmer, ruling out building-vs-building coplanarity as the cause. Sub-pixel triangle aliasing during motion is the new leading suspect, addressable later via TAA / higher-MSAA / LOD work outside this PR's scope

#### Z-fighting mitigation: `logarithmicDepthBuffer` (PR #627)

- One-flag `WebGLRenderer` option that distributes depth precision logarithmically across the frustum rather than uniformly
- Diagnosed root cause via systematic elimination: AF on `_m` texture (#624) didn't fix it; edge highlight at intensity 0 (#626) reduced but didn't eliminate; shadows off didn't fix; toggling terrain/cliffs/water layers didn't move the needle. Shimmer was visible **on vertical edges of buildings sharing walls** (block-style `BoxGeometry` instances at coplanar XY) and at the **water/terrain coastline** during flyover — both the canonical pattern for depth-buffer Z-fighting between near-coplanar surfaces
- Cheap fragment-shader op, no per-asset changes needed. Also enabled the camera-frustum tighten in #629 (less wasteful budget once log-depth is on)

#### Runtime setter: building edge highlight intensity (PR #626)

- New `NCZ.ThreeScene.setBuildingEdgeIntensity(value)` console export — iterates `buildingMaterials[]` and updates each shader's `uEdgeIntensity` uniform live
- Why a setter is needed: the uniform value is captured at material-compile time from `NCZ.BUILDING_EDGE_INTENSITY`; mutating the constant from the console alone doesn't propagate to existing materials
- Used as a console diagnostic (isolating the edge highlight's contribution to pan-shimmer in #627), and earmarked as the runtime knob for a future `Low` quality preset to dim or disable the highlight

#### Anisotropic filtering on `_m` texture (PR #624)

- `tex.anisotropy = renderer.capabilities.getMaxAnisotropy()` in `loadMDds()` — addresses oblique-view surface shimmer that mips alone weren't catching
- Mip + trilinear filtering handles aliasing perpendicular to the camera; AF handles the *along-view-axis* aliasing that elongated texture footprints produce when surfaces stretch into the distance. Mip selection is conservative (smaller of the two screen-space derivatives), so a fragment whose footprint stretches into the distance still samples a small mip and aliases along its long axis without AF
- Effectively free on modern GPUs — dedicated fixed-function on AMD/NVIDIA/Intel, Radeon 840M supports up to 16x. Defense-in-depth: kept on even after #627 turned out to be the actual fix for most of the shimmer

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

## [0.3.5] - 2026-05-16

### Added

- **Auto-discovery health monitor**: scheduled GitHub Action runs the real `parseNcZoningBlock()` against all live NCZoning-tagged Nexus mods daily and posts a Discord alert listing any that are missing from the map — split into "malformed block" (author fix needed) vs "tagged, no block". Catches silent parse failures within a day instead of when an author complains. Local/dry runs (no webhook) print the payload for review instead of sending.

## [0.3.4] - 2026-05-16

### Fixed

- **Auto-discovery — resilient BBCode parsing**: `parseNcZoningBlock()` now strips all BBCode tags and token-anchors the `NCZoning:` sentinel (anywhere in the description, every occurrence) instead of requiring an intact `[code]…[/code]` wrapper. Blocks that lost their `[code]` tags, picked up stray `[spoiler]`/`[size]`/`[font]`/`[color]` styling, or were pasted glued inline to prose (e.g. from a copy-paste round-trip) now parse correctly.

## [0.3.3] - 2026-05-04

### Fixed

- **Thumbnails — chunked `modsByUid` fetch**: Large single `modsByUid` requests (~250 UIDs) were silently truncated by the Nexus V2 API, so some manual-mod pins loaded without thumbnails until a later reload "self-healed" it. Now chunked into 50-UID parallel batches (`NEXUS_BATCH_SIZE`) with a one-shot retry of dropped UIDs; short chunks log the missing UIDs to tell flakiness apart from stale `nexus_id`s.

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
