# `NCZ.ThreeMarkers` — 3D pin/popup/cluster layer

The Three.js view's interactive layer: pins, tooltips, popups, cluster bubbles,
camera fly-to, and the cluster panel integration. Mirrors the Leaflet 2D
view's behaviour so the same sidebar drives both maps.

Single file: [`assets/js/three-markers.js`](../assets/js/three-markers.js).
Style for both views shared via [`assets/css/style.css`](../assets/css/style.css).
Cross-view glue (sidebar, filter, cluster panel, deep-link) lives in
[`assets/js/app.js`](../assets/js/app.js).

For the *plan* of what's done vs. pending vs. open for discussion, see
[`three-markers-leaflet-parity.md`](three-markers-leaflet-parity.md). For 3D
scene infrastructure (renderer, terrain, buildings, camera), see
[`three-js-scene.md`](three-js-scene.md).

## Public API

`NCZ.ThreeMarkers` exposes:

```js
attach(scene, camera, container, controls)         // lifecycle: called by ThreeScene.init
setMods(mods, nexusThumbs, tagsDict)               // data: full mod list + thumb URLs + tag dict
applyFilters(visibleIdSet)                          // filter: Set<modId> of currently-visible mods
getVisibleModIds()                                  // Discover button helper
focusMod(modId)                                     // sidebar/Discover click — fly + open popup
setPulse(modId, on)                                 // sidebar hover → pin pulse
setClusterClickHandler(fn)                          // app.js registers cluster-click bridge
setClustersChangedHandler(fn)                       // app.js registers map-aware panel hook
setActiveClusterMods(modSet | null)                 // app.js sets/clears active-cluster mark
closePopup({ silent }?)                             // programmatic popup close
render()                                            // called every frame from ThreeScene.renderLoop
onResize(w, h)                                      // called on viewport resize
```

`render()` is called every frame from `ThreeScene`'s render loop; everything
else is event-driven.

## Lifecycle

```text
ThreeScene.init()           ─► NCZ.ThreeMarkers.attach(scene, camera, container, controls)
                                  │  Creates CSS2DRenderer overlay, pinsLayer, _clusterLayer,
                                  │  tooltipObj. Wires controls 'change' → recompute clusters
                                  │  (rAF-debounced). Builds pins immediately if data already
                                  │  arrived (data path A below).

NCZ.fetchModData() resolves ─► NCZ.ThreeMarkers.setMods(mods, nexusThumbs, tagsDict)
                                  │  Caches data in _modsState. If pinsLayer exists (attach
                                  │  has run), buildPins(). Otherwise data sits idle until
                                  │  attach is called (data path B below).

applyFilters() in app.js    ─► NCZ.ThreeMarkers.applyFilters(visibleIds)
                                  │  Updates pin.visible per filter, closes popup if its mod
                                  │  is now filtered out, runs recomputeClusters() synchronously.

OrbitControls 'change'      ─► scheduleRecomputeClusters()
                                  │  rAF-debounced — at most one recompute per frame regardless
                                  │  of how often controls fires.

render() each frame         ─► updateFlyTween() (if active)
                                ─► cssRenderer.render(scene, camera)
                                ─► updatePopupPlacement() (if popup open) — toggles auto-flip
```

**Two data-arrival orders are supported** (whichever runs first triggers a
buildPins; the other is a no-op for buildPins):

- **Path A**: `attach` first (user switches to SCHEMA), then `setMods` later.
- **Path B**: `setMods` first (data fetched while still in SAT), then `attach` later.

## Module state (private)

```js
// Lifecycle
let scene, camera, container, controls;
let cssRenderer, pinsLayer;

// Pins
const pins = new Map();           // modId → CSS2DObject
let _modsState = { mods, nexusThumbs, tagsDict };

// Popup
let popup = null;                 // CSS2DObject or null
let popupModId = null;

// Tooltip — single reusable CSS2DObject
let tooltipObj = null;
let tooltipText = null;

// Camera fly-to tween (or null)
let _flyTween = null;
let _flyLastTime = 0;

// Clustering
let _clusterLayer = null;         // sibling group of pinsLayer at scene root
const _clusterPool = [];          // CSS2DObject[] reused across recomputes
let _filterVisibleIds = new Set();
let _recomputeFrame = null;       // rAF token
let _onClusterClick = null;       // app.js cluster-click bridge
let _onClustersChanged = null;    // app.js map-aware panel bridge
let _activeClusterMods = null;    // Set<modId> the cluster panel is showing
```

## Pins

One `CSS2DObject` per mod. The element is `<div class="three-marker category-marker"><div class="marker-pin {category}"></div></div>` — same `marker-pin` class as Leaflet's 2D markers, so the diamond shape and category colours come from a single CSS source ([style.css:790-835](../assets/css/style.css#L790)).

Pin Y position uses `mod.coordinates[2]` (CET Z) directly + `PIN_3D_GROUND_OFFSET` (cosmetic lift). CET Z and terrain GLB Y are in the same coordinate space — see [coordinate-system-3d.md](coordinate-system-3d.md) for the validation experiment.

## Popups

Click pin → `openPopup(mod)`. Single popup at a time; clicking the same pin again deselects (Leaflet-style toggle). Outside-click closes (with drag detection so a camera drag doesn't close the popup).

Popup chrome is **shared CSS** with Leaflet — `.ncz-dynamic-popup` background gradient, arrow geometry, category colours. The 3D popup uses `.three-popup-anchor` (zero-size CSS2DObject element) wrapping `.three-popup` (the styled card) inside it. Direction classes `.ncz-popup-top` / `.ncz-popup-bottom` toggled by `updatePopupPlacement()` for auto-flip when the pin is near the viewport top.

Popup HTML comes from `NCZ.buildPopupHtml(mod, catStyle, nexusThumbs, tagsDict)` — also shared between views.

Cross-view popup state syncs via `?mod=` URL param. `switchView()` re-opens the same popup in the destination view via `onViewSwitched`.

## Tooltips

Single persistent `CSS2DObject` created at attach time. On pin `mouseenter`, position it at the pin and show; on `mouseleave`, hide. Reuses Leaflet's `.pin-tooltip` skin so 2D and 3D tooltips render identically.

`tooltipObj.visible` controls show/hide via CSS2DRenderer's automatic `display: none` on hidden objects. `.pin-tooltip` class always carries `visible` modifier so the visibility flag actually toggles display.

## Camera fly-to

`focusMod(modId)` triggers `flyTo(pin, onComplete=openPopup)`:

1. Compute start/end target (current `controls.target` → pin position, full Y).
2. Compute matching camera-position delta (preserves OrbitControls' spherical offset).
3. Tween over `PIN_3D_FLY_DURATION_MS` (default 700ms, ease-in-out cubic).
4. Camera zoom tweens to `PIN_3D_FLY_ZOOM` (default 15).
5. On complete: open popup at the pin.
6. User input cancels mid-tween (controls 'start' event).

## Clustering

Detailed page on the wiki ([three-markers-clustering.md](../wiki/sources/three-markers-clustering.md), Obsidian-only).
TL;DR: **world-space XZ proximity grouping** (not screen-space — switched 2026-05 after Aki's UX feedback). Cluster radius is `PIN_3D_CLUSTER_RADIUS_PX` (40) converted to world units at current zoom, so clusters dissolve as the user zooms in (matching Leaflet's behaviour) but stay invariant to camera tilt and rotation (unlike the original screen-space approach which mis-clustered visually-close-but-far-apart pins at high tilt). Greedy O(N²) on filter-visible pins, recomputed on **zoom change** or filter change only — pan and tilt leave clusters intact. Cluster bubbles use `.marker-cluster` class + Leaflet's existing colour ramp. Pool of CSS2DObjects reused across recomputes.

## Cluster panel integration

The cluster panel DOM (`#cluster-panel` in `index.html`) is shared with Leaflet.
ThreeMarkers fires `_onClusterClick(modIds)` when a cluster bubble is clicked;
app.js registers a handler that calls the shared `populateClusterPanel(modsList, opts)`
helper. ThreeMarkers also fires `_onClustersChanged(sets)` after every recompute so
app.js can implement map-aware track-and-update of the panel.

Both views' panel handlers are registered *inside* the data-load try block in
app.js so they have access to `mods` and `nexusThumbs`.

The active cluster bubble (the one whose contents are showing in the panel)
gets `.marker-cluster.marker-cluster-active` — cyan ring + glow. Mark
auto-syncs across recomputes via `setActiveClusterMods(modSet)` and
`refreshActiveClusterMark()`.

## Constants — all in [`constants.js`](../assets/js/constants.js)

| Name | Default | What it does |
|---|---|---|
| `PIN_3D_GROUND_OFFSET` | 5 | CET metres above CET Z — cosmetic lift only, never read elsewhere |
| `PIN_3D_DRAG_THRESHOLD_PX` | 4 | Pixels of pointerdown→pointerup movement before treating as a drag (popup doesn't close on drag end) |
| `PIN_3D_POPUP_FLIP_PADDING_PX` | 24 | Pixels of clearance above viewport top before popup flips below pin |
| `PIN_3D_FLY_DURATION_MS` | 700 | Total tween time for sidebar click → camera fly-to-pin |
| `PIN_3D_FLY_ZOOM` | 15 | Target `camera.zoom` at end of fly |
| `PIN_3D_CLUSTER_RADIUS_PX` | 40 | Equivalent pixel radius for cluster grouping. Converted to world units at recompute time — `PIN_3D_CLUSTER_RADIUS_PX × ((camera.right − camera.left) / (camera.zoom × canvasWidth))` — so clusters dissolve at the same rate as Leaflet's pixel-radius does. Stays in `_PX` for naming because the dev-intuition target is a Leaflet-equivalent pixel size. |

All five are JS-side runtime tunables. Visual constants (popup margin, arrow
size, tooltip padding) live in CSS — see [style.css](../assets/css/style.css)
sections at `.three-popup`, `.three-tooltip-anchor`, etc.

## Shared substrate with Leaflet

Both views share, by design:

- **Mod data** — `mods.json` parsed once, fed into both layers.
- **Filter logic** — `NCZ.computeVisibleMods(mods, filterState)` returns a `Set<modId>` consumed by both views' `applyFilters`.
- **Popup HTML** — `NCZ.buildPopupHtml(mod, catStyle, nexusThumbs, tagsDict)`.
- **Cluster panel DOM** — `#cluster-panel` in `index.html`, populated by `populateClusterPanel(modsList, opts)`.
- **CSS classes** — `.marker-pin`, `.pin-tooltip*`, `.marker-cluster*`, `.ncz-dynamic-popup*`, `.pulsing`.
- **`?mod=` URL state** — both views write/read on popup open/close.
- **Sidebar event handlers** — sidebar item click and hover dispatch to whichever view is active.

The split:

- **Leaflet renders to** `#map` via tile layer + `L.marker` + `L.markerClusterGroup`.
- **ThreeMarkers renders to** `#map-3d` via `CSS2DRenderer` overlay + `CSS2DObject` per pin/popup/tooltip/cluster bubble.

Active view is detected by `mapEl.style.display === "none"` (display toggle
between the two containers in `switchView`).

## Why dual-canvas (and not single-canvas like AtlasForge)

Discussed in detail in the [parity plan §B0 prelude](three-markers-leaflet-parity.md)
and [`atlasforge-architecture-comparison.md`](../wiki/sources/atlasforge-architecture-comparison.md)
(Obsidian-only).

Short version: AtlasForge runs Three.js inside a MapLibre `CustomLayerInterface`
(single GL context). That works when 2D and 3D fuse into one view. Our product
treats SAT and SCHEMA as **distinct visual experiences** — the schematic 3D
scene has its own theme palette, lighting, flyover, and pin-Z-anchored popups
that wouldn't translate to a flat-pins overlay. Dual canvas is the correct
trade-off; cross-view consistency comes from the shared substrate above, not
from sharing the renderer.

## Adding a new pin behaviour — quick guide

1. Decide whether the behaviour is view-agnostic or 3D-only.
   - **View-agnostic** (e.g. a new badge, sidebar tweak, popup field): add to the relevant shared helper (`NCZ.buildPopupHtml`, `populateClusterPanel`, etc.) and let both views inherit.
   - **3D-only** (e.g. building-shadow on pin hover, animated pin entry): add to ThreeMarkers, exposed via a new method on the public API.
2. If you need new tunables: add to `constants.js` under the `// 3D pin layer` section, named `PIN_3D_*` to make scope explicit.
3. If you need new CSS: see if Leaflet already has equivalent styling (`grep "\.pin-tooltip\|\.marker-pin\|\.marker-cluster" assets/css/style.css`). If yes, share via combined selectors (e.g. `.leaflet-popup.ncz-dynamic-popup, .three-popup.ncz-dynamic-popup`). If no, add a new rule.
4. Cross-reference the parity plan — if you're adding something Leaflet does too, it probably has an entry in the plan that should be ticked off or expanded.

## Related documents

- [three-js-scene.md](three-js-scene.md) — 3D scene infrastructure (renderer, GLBs, camera, lighting, shadows). ThreeMarkers attaches to it.
- [three-markers-leaflet-parity.md](three-markers-leaflet-parity.md) — living plan: what's done, pending, won't translate, open for discussion.
- [coordinate-system-3d.md](coordinate-system-3d.md) — CET ↔ Three.js coordinate spaces, including the validated CET-Z = terrain-GLB-Y finding that lets `pinYFor()` work without a raycast.
- [architecture.md](architecture.md) — repo-wide file structure and module loading order.
