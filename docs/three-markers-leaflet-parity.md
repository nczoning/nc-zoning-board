# Leaflet → ThreeMarkers Parity Plan

> Living plan for reaching feature parity between the 2D (Leaflet) and 3D
> (Three.js / `NCZ.ThreeMarkers`) views. Each item is something Leaflet does
> today that the 3D view also needs (or doesn't — see "Won't translate").
>
> **How to use this doc:** read each row, leave a `✓ keep`, `✗ skip`, or `?
> needs discussion` next to its ID in the Notes column. Reorder priority by
> moving rows between sections. We'll work through whatever survives.

## Status legend

| Symbol | Meaning |
| --- | --- |
| ✅ | Done — already shipped on `feat/three-markers-scaffold` |
| 🟨 | Pending — agreed scope, just needs implementation |
| 🟦 | Won't translate — inherently 2D, no equivalent in 3D |
| 🟥 | Open question — design decision needed before implementation |

---

## Section A · Already done on this branch

These are live in the current PR. Nothing to action.

| ID | Item | Leaflet API mirrored | Status |
| --- | --- | --- | --- |
| A1 | Pin rendering (one DOM node per mod) | `L.marker` + `L.divIcon` | ✅ |
| A2 | Popup rendering (shared HTML via `NCZ.buildPopupHtml`) | `marker.bindPopup` | ✅ |
| A3 | Click pin → popup open | `marker.on("click")` | ✅ |
| A4 | Click outside → popup close | `map.on("click")` | ✅ |
| A5 | Drag-aware close (drag end ≠ click) | Leaflet's built-in click filter | ✅ |
| A6 | Auto-flip popup above ↔ below pin | Leaflet's auto-pan + flip | ✅ |
| A7 | Sidebar filter checkboxes affect pin visibility | `markerClusterGroup.addLayer` toggle | ✅ |
| A8 | Sidebar item click → focus pin in active view | `focusMarker` | ✅ |
| A9 | Deep-link `?mod=` URL sync (open/close) | `popupopen` / `popupclose` handlers | ✅ |
| A10 | Popup persists across SAT ↔ SCHEMA switch | (new — uses URL state) | ✅ |
| A11 | Pin Y derived from CET Z (gameplay surface) | (no Leaflet equivalent — flat in 2D) | ✅ |
| A12 | Popups always render above pins (z-order) | (was bug F1) | ✅ |
| A13 | Click selected pin → deselect | (was bug F2) | ✅ |
| A14 | Hover pin → tooltip with mod name | `pinTooltip.show/hide` | ✅ (was B1) |
| A15 | Sidebar item hover → pin pulse | `.pulsing` class toggle | ✅ (was B2) |
| A16 | Sidebar item click → camera fly-to-pin | `markerClusterGroup.zoomToShowLayer` | ✅ (was B3) |
| A17 | Discover button works in 3D | `focusRandomVisibleMarker` | ✅ (was B5) |
| A18 | Popup chrome (background, arrows, category colours) shared between Leaflet and 3D — single CSS source of truth | `.ncz-dynamic-popup` chrome rules | ✅ |
| A19 | Pin clustering (world-space XZ distance, zoom-scaled radius, recomputes only on zoom/filter — stable across pan/tilt) | `L.markerClusterGroup` | ✅ (was C1) — switched from screen-space to world-space after Aki's UX feedback |
| A20 | Cluster click → cluster panel; map-aware (track-and-update successor; close on view switch); active-bubble visual indicator | `clusterclick` event + populateClusterPanel | ✅ (was C2) |
| A21 | Pannable bounds — clamp camera target inside terrain extent + viewport-relative padding | (no Leaflet API; manual `controls.change` clamp) | ✅ (was C3; tilt-aware fix deferred to E7) |
| A22 | Distance scale bar (Leaflet-style nice-number rounding, shared `.leaflet-control-scale-line` skin) | `L.control.scale` | ✅ (was C4) |

---

## Section B · Pending — high-impact UX, small effort

Most of B is now in Section A. Only B4 remains, deferred to discussion (see Section E).

| ID | Item | Why it matters | Est. LOC | Notes (you fill in) |
| --- | --- | --- | --- | --- |
| B4 | **fitBounds equivalent on first load** (frame all visible pins) | Right now camera defaults to centred top-down; doesn't react to data | ~15 | ? — see E5 |

**B4 details** — Three lines: compute world bbox of all pin positions, set camera frustum to fit. Run once after first `setMods` call.

---

## Section C · Pending — medium effort

_All Section C items shipped — see A21, A22 above. Section retained for historical context of the original plan._

~~| C3 | **Pannable bounds** (constrain camera to world bounds + padding) | OrbitControls currently lets you pan to infinity; Leaflet has bounds | ~20 | ✓ |~~
~~| C4 | **Distance scale bar** (moved from D2) | Orthographic projection means scale is uniform across screen along the camera's screen-X axis; works fine in 3D, just needs different math than Leaflet's | ~30 | ✓ |~~

**C3 details** — Set `controls.minPan` / `controls.maxPan` to the world bbox + 500m padding. May want soft bounds (rubber-banding) rather than hard stops.

**C4 details** — Compute `metresPerPixel = (camera.right − camera.left) / (canvas.clientWidth × camera.zoom)`. Render a horizontal bar in the bottom-left corner labelled with a round number ("100m", "500m", "1km" depending on zoom). Update on `controls.change`. Note: when the camera is tilted, the bar is accurate for screen-X distance only (parallel to the ground plane); screen-Y is foreshortened. Acceptable trade-off — the bar reading "100m east-west" is still useful information.

---

## Section D · Won't translate (inherently 2D)

These are Leaflet behaviours that don't have a meaningful 3D equivalent. Listed so you know we considered them and chose not to port.

| ID | Item | Status | Why it's skipped | Notes (you fill in) |
| --- | --- | --- | --- | --- |
| D1 | ~~**Spiderfy** (cluster expands radially when clicked at max zoom)~~ → moved to **E6** | — | Reopened 2026-05-01. User thinks a 3D-friendly spiderfy can be made to work; specific design pending discussion. | reopened |
| D2 | ~~**`L.control.scale`** (distance scale bar)~~ → moved to **C4** | — | Original "won't translate" call was wrong. In our orthographic camera, scale is uniform along the screen-X axis even when tilted, so a horizontal scale bar reads true. Reclassified after review. | moved |
| D3 | **`L.control.zoom`** (+ / − zoom buttons) | 🟦 | OrbitControls handles zoom via scroll; explicit buttons are redundant in 3D. | ✗ |
| D4 | **Manual popup repositioning** (`positionDynamicPopup`) | 🟦 | We needed this in Leaflet because the popup is detached from the marker; CSS2DRenderer reprojects every frame for free. | ✗ |
| D5 | **`zoomstart`/`zoomend` event hooks** for clearing UI state | 🟦 | These exist for Leaflet's tile-load animation; not relevant to a continuously-rendered 3D scene. | ✗ |

---

## Section E · Open questions / discussion items

E1–E4 were resolved 2026-05-01 (all confirmed current behaviour). E5–E6 are open
discussion items the user wants to revisit AFTER the rest of the parity work is
shipped, per "leave our discussion points until after we have done everything else".

| ID | Question | Status |
| --- | --- | --- |
| E1 | Should popup close when you click on terrain in 3D? | ✅ resolved — yes, matches Leaflet |
| E2 | Should pins always face the camera? | ✅ resolved — yes, CSS2DRenderer billboards automatically |
| E3 | Pin Z-order when overlapping | ✅ resolved — closer on top (depth-tested) |
| E4 | Scaling pins with zoom | ✅ resolved — stay constant (fixed pixel size) |
| E5 | **Cinematic intro on first load** (revised from fitBounds): when there's no `?mod=` URL param, fly the camera in from a tilted, zoomed-out angle to a city-centre framing in the first second after load. Skipped when deep-linked (the existing fly-to-mod takes over). Reuses the fly-tween infrastructure from ThreeMarkers' `focusMod`. Sells the 3D-ness of the map without overriding deep-link behavior. The original fitBounds-to-pins idea was rejected — pins span the entire Night City map already, so it would resolve to roughly the default viewport. | 🟥 deferred for separate PR |
| E6 | **Spiderfy in 3D** — resolved as won't-translate. The cluster panel (C2) is the canonical "see what's in this cluster" UX: click a cluster, see all mods inside with thumbnails, names, descriptions. Visual radial fan was a Leaflet stylistic flourish that doesn't translate to 3D. Three cluster-panel UX follow-ups are tracked in E12. | ✅ resolved (won't-translate) |
| E7 | **Tilt-aware pan bounds** — resolved as accept-the-trade-off. Current bound (terrain edge at viewport centre at max pan) ships clean. The `1/cos(polar)` overshoot at extreme tilt + zoom-out (~33% off-screen) is mildly annoying but every fix attempt produced worse failure modes (catastrophic camera jumps when bounds invert). The alternatives — capping max tilt, suspending the clamp during tilt input, replacing OrbitControls' bounds with a separate constraint system — were judged not worth the cost for a cosmetic offset. | ✅ resolved (no-action) |
| E8 | **Pins are static during the flyover showcase** — resolved by PR #634. Pins, clusters, popup and tooltip CSS2DObjects sit on `NCZ.LAYER_PINS` (1); the schema camera enables it by default and the showcase flyCamera enables it when the modal's "Show mod pins during showcase" toggle is on. ThreeMarkers' `setActiveCamera(flyCamera)` swaps the projection camera so positions track the cinematic camera, and `setUnclusteredMode(true)` hides cluster bubbles + unhides every filter-passing pin so individual mods fly past instead of number-badges. Pins also join the staggered layer reveal (after buildings) when `revealLayers` is enabled. The "Pins" entry in the overlay-controls panel toggles 3D-only pin visibility independently of sidebar filters. | ✅ resolved (PR #634) |
| E9 | **Camera gestures blocked when cursor is over a pin/cluster/popup**: in Leaflet you can pan/zoom by click-dragging or scrolling anywhere on the map, even with the cursor over a marker. In 3D, pin/cluster DOM has `pointer-events: auto` (so clicks register), which means OrbitControls — which listens on the canvas — never receives `pointerdown` when the gesture starts on a marker. A synthetic-event-forwarding attempt was reverted because `setPointerCapture` (called by OrbitControls inside the synthetic handler) redirects subsequent `pointerup` events to the canvas, breaking the natural `pointerdown → pointerup → click` chain on the pin. Proper fix: refactor pins/clusters to `pointer-events: none` and move click/tooltip dispatch to canvas-level handlers using screen-space hit detection (project pin world positions to NDC, compare against pointer pixel position). Popups stay interactive. ~150–200 LOC change touching the marker module's public surface. To be addressed in a separate PR. | 🟥 deferred for separate PR |
| E10 | **Two distinct visual artifacts during the showcase** (likely separate causes): (1) **wave/undulation** on terrain (and possibly buildings) — only obvious during the flyover; may be present in normal use but unnoticeable. Showcase-specific candidates: perspective camera + waypoint interpolation, dynamic sun + shadow-cam update cadence, log-depth precision under perspective, beat-driven theme cross-dissolve hitting material colours mid-render. (2) **shimmer** — the known sub-pixel triangle-aliasing pan-shimmer flagged in PR #627/#628 (logarithmicDepthBuffer + powerPreference fixes); always present in normal use, made worse by the showcase's continuous camera motion. Treat (2) as an extension of the existing shimmer thread; (1) needs its own diagnostic. To investigate (1): toggle shadows off mid-flyover, freeze sun position, lock theme to a single value to bypass beat dissolve, swap perspective for orthographic on the same waypoint path. Land each fix as its own PR once the cause is narrowed. | 🟥 deferred for investigation |
| E11 | **Pin occlusion by scene geometry**: pins are CSS2D DOM elements rendered after the WebGL pass and don't depth-test against terrain, buildings, metro or roads — so a pin "behind" a tower still paints over it. Wanted: only show pins whose world position has unobstructed line-of-sight to the camera. Two implementation options: (a) per-frame raycast against terrain + buildings InstancedMesh from camera through each pin world position, hide if first hit is closer than the pin distance — needs a BVH (`three-mesh-bvh` library, ~100KB) for acceptable perf with hundreds of pins × thousands of building instances; (b) depth-buffer readback at each pin's projected pixel and compare to the pin's NDC depth — accurate but readbacks are expensive (1–10 ms each), so a many-readback-per-frame implementation likely needs an instanced GPU comparison pass instead. Option (a) is the more standard Three.js solution. To be addressed in a separate PR; useful both in normal SCHEMA mode (pins behind tall buildings get hidden when zoomed in) and during the showcase (pins not visible from the cinematic camera get hidden naturally). | 🟥 deferred for separate PR |
| E12 | **Cluster panel UX cleanup** (three behaviours surfaced 2026-05-04 while resolving E6 spiderfy): (1) When opening a popup via the cluster panel in 3D, the popup currently anchors to the underlying clustered pin's hidden CET position rather than the cluster bubble's centroid — popup floats away from where the user clicked. Fix: anchor popup to the cluster bubble centroid when opened from a cluster-panel item. (2) The cluster panel currently closes when a location is clicked from it; should stay open so users can compare multiple mods in the same cluster without having to reopen the panel. (3) Clicking the cluster bubble that's currently displayed in the panel should toggle-close the panel (today: nothing happens). Apply each behaviour in both the Leaflet (2D) and ThreeMarkers (3D) views where applicable; verify each by inspection — Leaflet uses `markerClusterGroup.zoomToShowLayer` which uncluster the pin before opening the popup, so behaviour (1) is 3D-specific while (2) and (3) likely affect both views. ~50–100 LOC, one PR, touches `app.js` + `three-markers.js`. | 🟥 deferred for separate PR |

---

## Total scope

Section A done so far: ~750 LOC across [three-markers.js](../assets/js/three-markers.js) + [app.js](../assets/js/app.js) + CSS dedup. Two PR rounds (initial scaffold, then B/F items).

Remaining: C1–C4 (~250 LOC, mostly C1 clustering) + open discussions on B4/D1.

## Cross-cutting note

None of these require touching `three-scene.js` further. The marker layer is fully decoupled from the scene at this point — it just needs scene/camera/container handles, which it already has.
