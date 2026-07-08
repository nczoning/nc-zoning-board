# Building Classification & Night Lighting

How the 3D scene turns the game's anonymous box cloud into individual buildings,
classifies them, lights them at night, and lets you correct the result by hand.

> **Scope.** This covers the building **segmentation → classification → lighting**
> pipeline, the **zone override** system + drawing tool, the **metadata table**,
> and the **tuning harness**. For the wider 3D scene (camera, terrain, shadows)
> see [`three-js-scene.md`](three-js-scene.md) and
> [`3d-map-lighting.md`](3d-map-lighting.md).

## The problem

Each district's `_data.dds` is a **transform-only** instance cloud: every texel
decodes to one box's position / rotation / scale — **no type, no grouping**. A
real building is many adjacent boxes (slabs, setbacks, a tower on a podium). To
light the city believably at night we need to know *which boxes form one
building* and *what kind of building it is* — both inferred purely from geometry.

## Pipeline

```text
_data.dds ──decode──► per-box transforms ──segment──► buildings ──classify──► archetype
   (CPU)               (loadBuildings)      (segmentBuildings)    (shader / CPU mirror)
                                                  │                      │
                                          zone MERGE override     zone forceClass/exclude/
                                          (one building per zone)  forceLit override
                                                  │                      │
                                          buildingAttrBuffer      buildingOverrideBuffer
                                          (vec4 per instance)     (vec2 per instance)
                                                  ▼                      ▼
                                             night windows + signage + city glow
```

Everything is built at **load time** in `loadBuildings()` (assets/js/three-scene.js).
There is no intermediate JSON — the decode + segmentation are CPU JS, the
classification + lighting are TSL on the GPU.

## 1. Segmentation — `segmentBuildings()`

Groups the box cloud into buildings. Replaced an earlier percolating union-find
(`clusterBuildingBoxes`, kept only as the tuning-harness baseline). The method is
**height-discontinuity region growing with a connectivity gate**:

1. **Ground grid** (`BUILDING_SEG_CELL`, 8 CET). Each cell records the max box-top
   elevation (its "roof").
2. **Footprint connected-components** (pure connectivity, height ignored). An
   isolated structure is its own component; a dense downtown percolates into one
   giant component.
3. **Region-grow**: 8-adjacent occupied cells join one building iff they share a
   footprint component **and** (that component is small enough to keep whole **or**
   their roofs are within `BUILDING_SEG_DH`, 18 CET). A roof cliff ≥ DH is a
   building boundary.
4. **Connectivity gate** (`BUILDING_SEG_KEEP_WHOLE`, 1200 cells): a footprint
   component at/below this size is kept **whole** — height-splitting only fires on
   the percolated downtown megablob, so an isolated structure with a varied roof
   (e.g. Kujira, a ship with a tall superstructure + low deck) stays one building.
5. **Absorb** sub-`BUILDING_SEG_MIN_CELLS` (3) regions into the neighbour they
   border most (kills roof-step slivers).
6. **Aggregate** each building's world AABB → `heightHalf`, `footMaxHalf`,
   `footMinHalf`, plus a dense `buildingId`.

Output: a per-instance **`buildingAttrBuffer`** (`vec4` = heightHalf, footMaxHalf,
footMinHalf, buildingId). The shader classifies + seeds windows/signs from these,
so every box inherits its building's class.

**Why this method** (see the percolation learning): downtown boxes physically
abut their neighbours — there are *no street gaps in the box data* (footprint CC
stays ~1 component even at a 4 CET cell), so connectivity alone over-merges. But
the **height field cleanly resolves individual buildings** as roof plateaus
separated by cliffs, and it's morphology-agnostic (flat / round / horizontal /
vertical all segment). The `.dds` carries no latent grouping to exploit (verified:
boxes are packed in spatially-incoherent order, no separators) — segmentation
*must* be geometric.

| Constant | Default | Meaning |
| --- | --- | --- |
| `BUILDING_SEG_CELL` | 8 | ground-grid cell (CET) |
| `BUILDING_SEG_DH` | 18 | roof-height cliff that separates two buildings |
| `BUILDING_SEG_MIN_CELLS` | 3 | regions smaller than this are absorbed |
| `BUILDING_SEG_KEEP_WHOLE` | 1200 | footprint components ≤ this (cells) are never height-split |

## 2. Classification — archetypes

Each building is sorted into one of six archetypes from its aggregate dims. The
canonical logic is TSL in `buildBuildingMaterial`; an exact CPU mirror
(`classifyDimsCPU`) feeds the metadata table — **keep the two in sync.**

| Class | Colour | Meaning | Lit? |
| --- | --- | --- | --- |
| **Tower** | green | tall & slender | yes (dense windows + signage) |
| **Block** | blue | tall & broad | yes (sparser windows) |
| **Podium** | yellow | broad & **low** mass (malls, parking, oil tanks) | no |
| **Elongated** | orange | long & thin (walls, bridge decks, pipes) | no |
| **Thin** | red | narrow footprint (poles, masts, pillars) | no |
| **Short** | grey | below the height gate (ground clutter) | no |

Discriminators (all `smoothstep`, continuous), in precedence order
short > thin > elongated > podium > tower/block:

- **height gate** `WINDOW_MIN_HEIGHT` (+`WINDOW_HEIGHT_BAND`) → *short*
- **narrow-side floor** `ARCH_MIN_FOOTPRINT` → *thin*
- **elongation cap** `ARCH_MAX_ELONGATION` → *elongated*
- **podium**: broad (`ARCH_FOOTPRINT_BIG`) AND squat (`ARCH_VERTICALITY_*`)
  AND **low** — the **height veto** `ARCH_PODIUM_HEIGHT_LO/HI` means a genuinely
  tall mass is never podium however broad (fixes "too much yellow": big-footprint
  skyscrapers were misreading as dark podium).
- **tower vs block**: verticality `ARCH_VERTICALITY_LO/HI` (height ÷ footprint).

| Constant | Default | Meaning |
| --- | --- | --- |
| `WINDOW_MIN_HEIGHT` / `_BAND` | 22 / 12 | height-half gate for "tall enough to light" |
| `ARCH_VERTICALITY_LO` / `_HI` | 0.6 / 1.8 | block ↔ tower boundary (verticality) |
| `ARCH_FOOTPRINT_BIG` | 90 | broad-mass threshold (podium candidate) |
| `ARCH_PODIUM_HEIGHT_LO` / `_HI` | 45 / 85 | above HI height-half, never podium |
| `ARCH_MIN_FOOTPRINT` | 8 | narrow-side floor (below ⇒ thin) |
| `ARCH_MAX_ELONGATION` | 4 | max/min footprint ratio (above ⇒ elongated) |

### `?archdebug`

Colours every box by its **discrete** class (one solid legend colour — no
continuous blend, so no in-between teal/purple). The palette is the single source
`NCZ.ARCHDEBUG_COLORS`, which drives **both** the shader and the on-screen legend
(parked left of the overlays box, with hover definitions), so they match exactly.
Compile-time early-return — zero cost when the flag is absent.

## 3. Zone overrides — correcting the heuristic by hand

Geometry alone can't disambiguate every structure (a thin tower ≡ a wall; a ship ≡
a podium). **Zones** are hand-drawn CET volumes (footprint polygon + height range)
that override the result. Four ops:

| Op | Effect | Applied |
| --- | --- | --- |
| `merge` | all in-zone boxes become **one** building | segmentation (`segmentBuildings`) |
| `forceClass` | force the archetype (tower/block lit; podium/short/thin/elongated dark) | shader override |
| `exclude` | never lit | shader override |
| `forceLit` | force lit + window/sign density multiplier | shader override |

`merge` reassigns in-zone box labels to one sentinel before aggregation. The other
three become a per-instance **`buildingOverrideBuffer`** (`vec2` = op code, param)
built at load by a centroid point-in-polygon test; the shader mixes the geometric
`archMask`/`towerness` toward the forced value. Overrides **beat the region-density
mask** — a forced building lights anywhere.

### The drawing tool — `?zonetool`

In-3D editor (assets/js/zone-tool.js), lazy-loaded only on the flag. WebGPU-safe by
construction: `MeshBasicNodeMaterial` handles + `Line2NodeMaterial` edges, and
**no `TransformControls`** — manipulations are constrained (footprint on the ground
plane via `groundPointAt`, extrude on the vertical axis via a camera-facing plane),
so a couple of raycasts replace the gizmo.

- **Draw**: click ground points → click the first to close. Or **Circle** /
  **Ellipse** (centre → edge/corner) generate a 24-gon footprint.
- **Extrude**: drag the amber top handle up for the zone height.
- **Edit**: drag cyan vertices; click an edge to **split** (insert a vertex);
  **right-click** a vertex to remove it (right-drag still tilts the camera).
- **Manage**: per-zone Edit (load back / rename) and Delete; draggable panel.
- **Persist**: see below. **Apply ⟳** saves + reloads so the engine re-segments.

### Persistence

Working edits live in **localStorage** (`NCZ.ZONES_KEY` = `ncz-building-zones`) and
take precedence over the committed baseline **`data/building-zones.json`**. The tool
**Export**s (download + clipboard) and **Import**s JSON files. Workflow: author live
→ export to a file → commit `data/building-zones.json` when finalised. `loadBuildings()`
reads localStorage-else-baseline at load.

Zone JSON shape:

```json
{ "zones": [
  { "name": "kujira", "op": "merge", "footprint": [[x,y], …], "minZ": 0, "maxZ": 80 },
  { "name": "red-slab", "op": "forceClass", "forceClass": "block", "footprint": […], "minZ": 0, "maxZ": 2000 }
]}
```

## 4. Per-building metadata table

Built at load (in-memory, **not persisted** — a pure projection of geometry +
polygons, regenerated every load). One record per building:

```js
{ cloud, id, boxCount, centroid:[cetX,cetY], heightHalf, footMax, footMin,
  geoClass, districtId, subId }
```

The **district tag** is the smallest subdistrict polygon
(`data/subdistricts.json`) containing the building's **centroid** — a *building-level*
decision, so a structure straddling a boundary isn't split, and a `.dds` cloud that
spans districts tags correctly (the `city_center` cloud → mostly city_center, some
heywood/westbrook). Read via `NCZ.ThreeScene.getBuildingMeta()`. This is the
foundation a future block-selection editor (Project: Roadmap) will read/write.

## 5. Tuning harness (`scripts/tune_*.js`)

Headless Node tools that run the **real** decode + segmentation + classification
(they *lift* `DISTRICT_META`, `clusterBuildingBoxes`, `segmentBuildings`,
`pointInPolygon` verbatim out of the source, so they can't drift). No GPU/browser.

| Script | Purpose |
| --- | --- |
| `tune_lib.js` | shared pipeline (lift + decode + classify mirror + district tag) |
| `tune_archetypes.js` | sweep `ARCH_*`/gap params, score by class distribution |
| `tune_analyze.js` | percolation + cluster-size + district-span analysis |
| `tune_probe_source.js` | tests the `.dds` for any latent grouping (verdict: none) |
| `tune_probe_megablob.js` | renders footprint-CC + height field PNGs (street gaps? ridges?) |
| `tune_segment.js` | segmentation prototype + colour-per-building PNG renders |

Outputs go to `_lighting_demo/tune/` (gitignored).

## Live param overrides

`?archdebug&fbig=220&dh=24&keepwhole=2000&podlo=50&…` overrides the cluster /
archetype / segmentation constants live (no rebuild). See
[`url-parameters.md`](url-parameters.md) for the full key list.

## Key files

- `assets/js/three-scene.js` — `segmentBuildings`, `buildBuildingMaterial`
  (classification + lighting + overrides), `buildDistrictMeta`, `getBuildingMeta`,
  `loadBuildingZones`.
- `assets/js/zone-tool.js` — the `?zonetool` drawing tool.
- `assets/js/constants.js` — `ARCH_*`, `BUILDING_SEG_*`, `WINDOW_*`,
  `ARCHDEBUG_COLORS`, `ZONES_KEY`, the URL override hook.
- `data/building-zones.json` — committed zone baseline.
- `data/subdistricts.json` — district polygons (CET) for tagging.
- `scripts/tune_*.js` — the headless tuning harness.
