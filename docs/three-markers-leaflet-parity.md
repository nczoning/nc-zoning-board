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

---

## Section B · Pending — high-impact UX, small effort

Most of B is now in Section A. Only B4 remains, deferred to discussion (see Section E).

| ID | Item | Why it matters | Est. LOC | Notes (you fill in) |
| --- | --- | --- | --- | --- |
| B4 | **fitBounds equivalent on first load** (frame all visible pins) | Right now camera defaults to centred top-down; doesn't react to data | ~15 | ? — see E5 |

**B4 details** — Three lines: compute world bbox of all pin positions, set camera frustum to fit. Run once after first `setMods` call.

---

## Section C · Pending — medium effort

| ID | Item | Why it matters | Est. LOC | Notes (you fill in) |
| --- | --- | --- | --- | --- |
| C1 | **Pin clustering** (proximity grouping at low zoom) | Pin density is heavy in city centre — at full zoom-out it's an unreadable mess of dots | ~150 | ✓ |
| C2 | **Cluster click → cluster panel** (existing DOM panel reused) | Same UX as Leaflet — click a cluster bubble, side panel lists mods inside | ~50 (depends on C1) | ✓ |
| C3 | **Pannable bounds** (constrain camera to world bounds + padding) | OrbitControls currently lets you pan to infinity; Leaflet has bounds | ~20 | ✓ |
| C4 | **Distance scale bar** (moved from D2) | Orthographic projection means scale is uniform across screen along the camera's screen-X axis; works fine in 3D, just needs different math than Leaflet's | ~30 | ✓ |

**C1 details** — Project each visible pin to screen pixels via `pin.position.project(camera)`, group within ~80px radius using a simple spatial grid. Each cluster becomes a CSS2DObject showing the count. Re-cluster on `controls.change` event with rAF debouncing. The colour-step ramp from Leaflet ([app.js:766](assets/js/app.js#L766)) ports directly. Spiderfy is **not** included — that's its own Section D item (won't translate cleanly).

**C2 details** — Cluster click → call `populateClusterPanel(modsInCluster)` (the existing handler at [app.js:1097](assets/js/app.js#L1097) is generic — sort of). Need to refactor to take a mod list directly rather than a Leaflet cluster object.

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
| E5 | **B4 — fitBounds on first load**: should the 3D camera frame all visible pins on initial load, or stay at default centred top-down? Tradeoff is between "show me the data immediately" vs "user controls their first view". | 🟥 deferred for discussion |
| E6 | **D1 — Spiderfy in 3D**: original ruling was "won't translate" because the 2D radial fan looks wrong with a tilted camera. User believes a 3D-friendly version is possible — perhaps a vertical fan, depth-staggered offsets, or a hybrid where the cluster panel (C2) handles the same job. | 🟥 deferred for discussion |

---

## Total scope

Section A done so far: ~750 LOC across [three-markers.js](../assets/js/three-markers.js) + [app.js](../assets/js/app.js) + CSS dedup. Two PR rounds (initial scaffold, then B/F items).

Remaining: C1–C4 (~250 LOC, mostly C1 clustering) + open discussions on B4/D1.

## Cross-cutting note

None of these require touching `three-scene.js` further. The marker layer is fully decoupled from the scene at this point — it just needs scene/camera/container handles, which it already has.
