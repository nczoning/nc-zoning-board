# URL Parameters

Query-string flags the app reads at load time. Append to the site URL, e.g.
`https://nczoning.net/?debug` or `http://localhost:3000/?only=my_district`.

| Parameter | Type | What it does | Read in |
| --- | --- | --- | --- |
| `?mod=<nexus_id>` | value | Deep-link: opens the given mod's pin/popup and flies to it on load. Used by the in-app "copy link" button. See `docs/` deep-link notes. | `app.js`, `three-scene.js` |
| `?debug` | flag | Shows the on-screen stats panel (FPS, draw calls, triangles) and a **Copy debug info** button; enables extra console diagnostics. | `three-scene.js` |
| `?webgpuprobe` | flag | Runs a WebGPU adapter/device negotiation probe and logs the result — diagnostic for "scene fell back to WebGL / won't start". | `three-scene.js` |
| `?forcewebgl` | flag | Forces the Three.js renderer to the WebGL2 backend instead of WebGPU (for comparison/debugging; the scene's compute buildings need WebGPU, so expect a degraded/2D fallback). | `three-scene.js` |
| `?gamelight` | flag | Lighting **calibration reference** mode: pins the decoded in-game sun, freezes the time-of-day slider, and strips Districts/Pins overlays so surfaces can be matched against the in-game capture. | `app.js`, `three-scene.js` |
| `?only=<district>` | value | Renders **only** the named `DISTRICT_META` building cloud (e.g. `?only=my_district`, `?only=ugly_building`, `?only=watson`) — isolates one cloud for diagnosing placement/content. | `three-scene.js` |
| `?archdebug` | flag | Colours every building box by its **discrete** archetype class (tower/block/podium/elongated/thin/short) and shows the legend (with hover definitions) left of the overlays box. See [`building-classification.md`](building-classification.md). | `three-scene.js`, `app.js` |
| `?segdebug` | flag | **Structure** visualiser: colours every box by its **segmented building id** (hash colour), so adjacent buildings differ and you can see which boxes form one building — the result of the road / height / split segmentation. Complements `?archdebug` (which shows *class*, not *grouping*). Self-lit. See [`building-classification.md`](building-classification.md). | `three-scene.js`, `app.js` |
| `?zonetool` | flag | Loads the in-3D **building-zone drawing tool** (draw/extrude/edit CET zones; merge/forceClass/exclude/forceLit; localStorage + file import/export). See [`building-classification.md`](building-classification.md). | `three-scene.js`, `zone-tool.js` |
| `?facedebug` | flag | **Exterior-face mask** visualiser: renders the per-fragment occlusion gate exactly as the night emissive sees it — green = wall area allowed to light, red = wall area whose in-front probe sits inside a neighbouring box (covered by that neighbour's surface), grey = roofs/floors. Self-lit. | `three-scene.js` |

## Live building-tuning overrides (with `?archdebug` / `?zonetool`)

These override the cluster / archetype / segmentation constants at load (no
rebuild) — handy for A/B'ing classification. Read in `constants.js` (the override
hook) and consumed by `three-scene.js`. Absent = the committed default.

| Key | Constant | Key | Constant |
| --- | --- | --- | --- |
| `gap` | `BUILDING_CLUSTER_GAP` (legacy) | `dh` | `BUILDING_SEG_DH` |
| `cell` | `BUILDING_SEG_CELL` | `mincells` | `BUILDING_SEG_MIN_CELLS` |
| `keepwhole` | `BUILDING_SEG_KEEP_WHOLE` | `fbig` | `ARCH_FOOTPRINT_BIG` |
| `vlo` / `vhi` | `ARCH_VERTICALITY_LO/HI` | `minf` | `ARCH_MIN_FOOTPRINT` |
| `maxe` | `ARCH_MAX_ELONGATION` | `podlo` / `podhi` | `ARCH_PODIUM_HEIGHT_LO/HI` |
| `winmin` / `winband` | `WINDOW_MIN_HEIGHT` / `_BAND` | `facemask` | `FACE_MASK_STRENGTH` (0 = mask off) |
| `faceeps` | `FACE_EPS` | | |

Example: `?archdebug&fbig=220&dh=24&keepwhole=2000`.

Notes:

- Flags are presence-based (`?debug` — no value needed); value params take `=<value>`.
- Combine with `&` (e.g. `?debug&only=my_district`).
- These are developer/diagnostic aids except `?mod`, which is a user-facing share link.

## Valid `?only=` district names

The value must match a `DISTRICT_META` entry name in `assets/js/three-scene.js`:

| Name | Set | Notes |
| --- | --- | --- |
| `westbrook` | both | |
| `city_center` | both | |
| `heywood` | both | |
| `pacifica` | both | |
| `santo_domingo` | both | |
| `watson` | both | |
| `ep1_dogtown` | both | Phantom Liberty |
| `ep1_spaceport` | both | no fixed variant — base-game in either set |
| `my_district` | Fixed only | malgalad's combined corrections overlay |
| `ugly_building` | Fixed only | malgalad's "ugly building" add-on (Watson) |

`my_district` / `ugly_building` only render when the **Fixed** asset set is
active (Settings → Map data). See [`3dmap-fixed-assets.md`](3dmap-fixed-assets.md).

## Other debug aids (not URL flags)

Not query params, but the same family of developer/diagnostic tools — catalogued
here so they're easy to find.

| Aid | How | What it does | Read in |
| --- | --- | --- | --- |
| Showcase pause | `Space` during the showcase | Freezes the flyover on the current frame (camera + audio stop) while keeping pins clickable — open a pin's popup to identify which mod it is on a suspect frame. `Space` again resumes from the same point. No on-screen UI advertises it; intended for the maintainer or "screenshot this frame for me" requests. | `flyover.js` |
