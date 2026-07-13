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
| `?colldebug` | flag | Draws the **game's own** 3D-map building collision boxes (10,166 `physicsColliderBox` shapes from `3dmap_coll_buildings{,2,3}.mesh`) as translucent hash-coloured boxes over the scene — CDPR's own decomposition of the map into solid objects, next to ours. `?collalpha=` sets opacity (0.3), `?collwire` renders unfilled. Data: `data/3dmap-colliders.json` (regenerate with `node scripts/extract_colliders.js`); fetched only under the flag. | `three-scene.js` |
| `?partdebug` | flag | **Part** visualiser — the twin of `?segdebug`, one level finer. Colours every box by its **part id** (hash colour), so a tower and the podium it rises from render as two colours *inside one building*, and a mast separates from its apron. Read the two together: `?segdebug` = what the segmenter calls one building, `?partdebug` = the strata inside it. Tune with `?partdh=`. Self-lit. See [`building-classification.md`](building-classification.md). | `three-scene.js` |
| `?zonetool` | flag | Loads the in-3D **building-zone drawing tool** (draw/extrude/edit CET zones; merge/forceClass/exclude/forceLit; localStorage + file import/export). See [`building-classification.md`](building-classification.md). | `three-scene.js`, `zone-tool.js` |
| `?facedebug` | flag | **Exterior-face mask** visualiser: renders the per-fragment occlusion gate exactly as the night emissive sees it — green = wall area allowed to light, red = wall area whose in-front probe sits inside a neighbouring box (covered by that neighbour's surface), grey = roofs/floors. Self-lit. | `three-scene.js` |
| `?shapemark` | flag | **Shape-detection** verification view: labelled beacon pillars (S/C/R/X + number) at every shape-detector candidate — red = sphere, cyan = cylinder, amber = ring, magenta = round-ish. Candidate list is currently the prototype detector's baked output; verdicts in `_lighting_demo/shape_candidates.txt`. | `three-scene.js` |
| `?glassdebug` | flag | **Measured glass share**, as baked per building — blue → green → yellow → red over 0–30%. Verifies the *data path*, not the look: every building in one subdistrict must be a single flat colour, and the colours must rank as `data/night-profile.json` does. A building disagreeing with its neighbours is tagged to the wrong polygon; a whole district reading black means the profile failed to load or its `subId` doesn't join. Both are silent under the real shader — they just look "a bit dark". | `three-scene.js` |
| `?noglassprof` | flag | Bakes a flat 0.2 glass share for every building, ignoring the measured profile — isolates the shader from the data. (Sign-density twin: `?nosignprof`.) | `three-scene.js` |

## City lights (window + signage emissive)

The game never gates its window light on the clock: the parallax interior is always
there, and `AmountTurnOffAtNight` is what turns *half* of it off after dark. So the
lights have their own control, independent of the sun.

| Key | Type | What it does |
| --- | --- | --- |
| `?lights=auto\|on\|off` | value | `auto` = the sun-driven dusk ramp (the old behaviour, still the default). `on` = lit at every hour, floored at `LIGHTS_DAY_FLOOR` so noon doesn't blow out. `off` = dark; windows, signage and the city glow all go. Mirrors the **Lights** control in the Overlays box. |
| `?lightsday=<0..1>` | value | `LIGHTS_DAY_FLOOR` — the emissive floor in full daylight when `lights=on`. A deliberate *look* choice for the schematic map, not a game-derived value. |

## The measured window model

The district's **glass share** (measured per subdistrict from the streaming sectors,
`data/night-profile.json`) sets each window pane's **area**; the game's measured window
aspect sets its **shape**. See `scripts/night_analyse.js`.

| Key | Constant | What it does |
| --- | --- | --- |
| `winmodel` | `WINDOW_MODEL` | `glass` (default, the measured model) or `legacy` (the pre-rebuild look: fixed square panes, one flat lit fraction city-wide). For side-by-side A/B on the same camera. |
| `glasssrc` | `GLASS_SHARE_SOURCE` | Which column of the profile to believe: `panel` (default — glass area ÷ facade area over kit panels, the only pieces where "this mesh is glass" is true of the whole mesh), `area` (same without excluding bespoke part-glass megameshes), `count` (the original instance-count share). |
| `glassgain` | `GLASS_SHARE_GAIN` | Global multiplier on every glass share — pulls the whole city up or down without touching the measured *ratios between* districts. |
| `litglass` | `WINDOW_LIT_IN_GLASS` | Fraction of windows inside glass that are lit. **Measured, not a knob**: `1 − AmountTurnOffAtNight` = 0.5536, area-weighted across every placed window material. If you find yourself turning this, what's wrong is somewhere else. |
| `winaspect` | `WINDOW_PANE_ASPECT` | Window width ÷ height. Measured: the dominant glass module is 3.0 × 1.4 m (51% of all placed glass area). Keeps low-glass districts' windows reading as *windows* (thin wide slots) instead of shrinking to square dots. |
| `wincellw` / `wincellh` | `WINDOW_CELL_W/H` | Facade grid spacing (CET). A **legibility** knob, not a measurement: the lit area is `paneArea × P(lit)`, so average brightness is identical at any cell size — the cell only decides how big each window blob reads at map zoom. |
| `winint` | `WINDOW_INTENSITY` | Emissive brightness of a lit window. |
| `winpanew` / `winpaneh` / `winlit` / `winlitb` / `winco` / `wincol` | *(deprecated)* | Legacy-model only (`?winmodel=legacy`). Superseded by the measured model. |

## Live building-tuning overrides (with `?archdebug` / `?zonetool`)

These override the cluster / archetype / segmentation constants at load (no
rebuild) — handy for A/B'ing classification. Read in `constants.js` (the override
hook) and consumed by `three-scene.js`. Absent = the committed default.

| Key | Constant | Key | Constant |
| --- | --- | --- | --- |
| `gap` | `BUILDING_CLUSTER_GAP` (legacy) | `dh` | `BUILDING_SEG_DH` |
| `cell` | `BUILDING_SEG_CELL` | `mincells` | `BUILDING_SEG_MIN_CELLS` |
| `keepwhole` | `BUILDING_SEG_KEEP_WHOLE` | `fbig` | `ARCH_FOOTPRINT_BIG` |
| `partdh` | `BUILDING_PART_DH` (with `?partdebug`) | | |
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
