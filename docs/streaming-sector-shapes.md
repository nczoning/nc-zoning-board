# Streaming Sector Shape Extraction

How to extract boundary polygons from CP2077 streaming sector files for district/subdistrict zones that aren't in the 3dmap entity.

## Background

The in-game 3D map entity (`3dmap_view.ent`) only contains trigger polygons for the 8 main city districts and their 16 subdistricts. The Badlands subdistricts (and any other zones not shown on the in-game map) store their boundary data in **streaming sector files** as `worldLocationAreaNode` entries.

These were previously considered too complex to decode because the `AreaShapeOutline.points` field is a placeholder unit square `(-1,-1)` to `(1,1)`. The actual shape data is in a **binary buffer** field — which turns out to have a simple format.

## Finding the Right Sector Files

Streaming sectors are in `base\worlds\03_night_city\_compiled\default\` and follow the naming convention:

```
exterior_{X}_{Y}_{Z}_{LOD}.streamingsector
```

Where X, Y are grid coordinates and LOD is the level of detail (higher = coarser, covers more area). The Badlands subdistricts are in LOD 4-6 sectors surrounding Night City:

| Sector File | Grid | Subdistricts |
|-------------|------|-------------|
| `exterior_0_-1_0_6` | (0,-1) | Laguna Bend, Red Peaks, Rocky Ridge |
| `exterior_1_-1_0_6` | (1,-1) | Sierra Sonora, Vasquez Pass |
| `exterior_-1_-1_0_6` | (-1,-1) | Jackson Plains |
| `exterior_-1_-2_0_6` | (-1,-2) | Rattlesnake Creek, Biotechnica Flats, *(Yucca, Dry Creek)* |
| `exterior_-1_1_0_6` | (-1,1) | North Sunrise Oil Field |
| `exterior_-3_-6_0_4` | (-3,-6) LOD 4 | SoCal Border Crossing |

To find which sector contains a specific area, you can search across exported sectors for `worldLocationAreaNode` entries whose `notifiers[0].Data.districtID` matches a TweakDB district path (e.g., `Districts.LagunaBend`).

## How to Export Sectors from WolvenKit

1. Open your WolvenKit project
2. In the Asset Browser, navigate to `base\worlds\03_night_city\_compiled\default\`
3. Find the sector file (e.g., `exterior_0_-1_0_6.streamingsector`)
4. Right-click → Add to Project
5. Right-click the added file → Convert to JSON
6. The JSON export appears in `source\raw\` with a `.streamingsector.json` extension

## Sector JSON Structure

Each exported `.streamingsector.json` has this structure:

```
Data.RootChunk
├── nodes[]              — Array of world nodes (meshes, triggers, areas, etc.)
│   └── [i].Data.$type   — Node type (e.g., "worldLocationAreaNode")
│   └── [i].Data.outline  — Contains the AreaShapeOutline with buffer
├── nodeData.Data[]      — Array of transform data (position, orientation, scale)
│   └── [i].NodeIndex    — Maps to the node index in nodes[]
│   └── [i].Position     — World-space position (Vector4: X, Y, Z, W)
└── nodeRefs[]           — Node reference strings
```

## Finding worldLocationAreaNode Entries

Filter `nodes[]` where `Data.$type == "worldLocationAreaNode"`. Each has:

| Field | Description |
|-------|-------------|
| `Data.debugName.$value` | Human-readable name (e.g., `"{laguna_bend}"`) |
| `Data.notifiers[0].Data.districtID.$value` | TweakDB path (e.g., `"Districts.LagunaBend"`) |
| `Data.outline.Data.buffer` | Base64-encoded binary polygon data |
| `Data.outline.Data.points` | **Placeholder only** — always a unit square, ignore this |

The node's world position comes from `nodeData.Data[]` where `NodeIndex` matches the node's index in the `nodes[]` array.

## Decoding the Binary Buffer

The `AreaShapeOutline.buffer` field is a base64-encoded binary blob with this format:

```
Offset  Size    Type        Description
──────  ──────  ──────────  ────────────────────────────────
0       4       uint32 LE   Point count (N)
4       N×16    float32×4   Points: (x, y, z, w) per point
4+N×16  4       float32 LE  Boundary volume height (how tall the trigger extends vertically)
```

Each point is 4 little-endian float32 values:
- **x** — local X coordinate
- **y** — local Y coordinate
- **z** — local Z coordinate (usually constant for a flat boundary; can be used for height)
- **w** — always 1.0

**To get CET world coordinates**, apply the node's `Orientation` quaternion (yaw rotation) then add the world `Position` from `nodeData`:

```
yaw = atan2(2 * (r*k + i*j), 1 - 2*(j*j + k*k))  # from Orientation quaternion

# For each local point:
rotated_x = x * cos(yaw) - y * sin(yaw)
rotated_y = x * sin(yaw) + y * cos(yaw)
CET_X = rotated_x + nodeData.Position.X
CET_Y = rotated_y + nodeData.Position.Y
```

Most nodes have identity rotation (`r=1, k=0` → yaw=0°), but some like SoCal Border Crossing have significant rotation (-37.6°).

The trailing 4 bytes after the point data are a float32 representing the **boundary volume height** — how tall the trigger area extends vertically. Areas with more elevation variation have larger values (Laguna Bend: 895, Jackson Plains: 463, SoCal: 43). Not needed for 2D map rendering.

### Rotation Data

All renderable Badlands subdistricts have **identity rotation** (yaw=0°). Only nomad lifepath areas have rotation:

| Node | Yaw | Notes |
|------|-----|-------|
| SoCal Border Crossing | -37.6° | Only rotated renderable subdistrict |
| Yucca (nomad start) | -23.7° | Not on world map |
| Dry Creek (nomad start) | -23.7° | Not on world map |
| All others | 0° | No rotation needed |

### Python Example

```python
import json, base64, struct

def decode_area_outline(sector_json_path):
    """Extract all worldLocationAreaNode polygons from a streaming sector JSON."""
    with open(sector_json_path, encoding='utf-8') as f:
        data = json.load(f)

    root = data["Data"]["RootChunk"]
    nodes = root["nodes"]
    node_data_list = root["nodeData"]["Data"]

    results = []
    for i, node in enumerate(nodes):
        nd = node.get("Data", {})
        if nd.get("$type") != "worldLocationAreaNode":
            continue

        name = nd.get("debugName", {}).get("$value", "")
        notifiers = nd.get("notifiers", [])
        district_id = ""
        if notifiers:
            district_id = (notifiers[0].get("Data", {})
                          .get("districtID", {}).get("$value", ""))

        # Get world position from nodeData
        pos_x, pos_y = 0.0, 0.0
        for ndi in node_data_list:
            if ndi.get("NodeIndex") == i:
                pos = ndi.get("Position", {})
                pos_x = pos.get("X", 0.0)
                pos_y = pos.get("Y", 0.0)
                break

        # Decode binary buffer
        outline = nd.get("outline", {}).get("Data", {})
        buf_b64 = outline.get("buffer", "")
        raw = base64.b64decode(buf_b64)
        if len(raw) < 4:
            continue

        count = struct.unpack_from('<I', raw, 0)[0]
        polygon = []
        for pi in range(count):
            offset = 4 + pi * 16
            if offset + 16 > len(raw):
                break
            x, y, z, w = struct.unpack_from('<ffff', raw, offset)
            polygon.append([round(x + pos_x, 2), round(y + pos_y, 2)])

        results.append({
            "name": name,
            "district_id": district_id,
            "polygon": polygon,  # CET world-space [X, Y] pairs
        })

    return results
```

## Extracted Badlands Subdistrict Boundaries

All coordinates in CET world-space (game coordinates). These were extracted on 2026-03-29 from game version 2310.

### Laguna Bend (14 points)
- **Sector:** `exterior_0_-1_0_6`
- **TweakDB:** `Districts.LagunaBend`
- **Node Position:** (1404.97, -3313.27)
- **Extent:** X [447, 1985] Y [-4849, -2233]

```json
[[720.89, -2585.9], [911.34, -2671.75], [913.77, -2859.79], [1202.71, -2808.49], [1613.15, -2454.13], [1579.72, -2281.1], [1984.87, -2232.73], [1954.83, -3142.64], [1645.79, -5423.82], [1308.68, -5848.91], [1404.97, -5879.77], [1055.55, -5700.97], [447.49, -4447.91], [664.24, -3003.64]]
```

### Red Peaks (34 points)
- **Sector:** `exterior_0_-1_0_6`
- **TweakDB:** `Districts.RedPeaks`
- **Node Position:** (1284.31, -777.39)
- **Extent:** X [505, 2012] Y [-2870, 1605]

```json
[[505.41, -2870.19], [541.43, -2826.04], [755.66, -2717.97], [897.02, -2802.2], [1153.66, -2672.15], [1189.69, -2604.28], [1227.1, -2489.41], [1283.53, -2332.03], [1568.31, -2257.62], [1568.31, -2230.27], [1993.17, -2145.04], [2011.77, -1958.15], [1860.02, -1897.48], [1905.47, -1781.71], [1970.84, -1601.69], [1998.28, -1381.25], [1998.28, -1131.73], [1950.5, -1011.42], [1887.76, -866.5], [1831.64, -732.43], [1833.62, -665.05], [1867.41, -509.76], [1761.72, -327.71], [1708.59, -223.59], [1520.07, 93.58], [1345.93, 1041.59], [1284.32, 1292.69], [1284.31, 1604.73], [922.35, 1604.73], [505.41, 1604.73], [505.41, 1206.03], [505.41, 505.36], [505.41, -1218.97], [505.41, -1879.39]]
```

### Rocky Ridge (49 points)
- **Sector:** `exterior_0_-1_0_6`
- **TweakDB:** `Districts.RockyRidge`
- **Node Position:** (2493.43, -1255.42)
- **Extent:** X [-448, 5127] Y [-2302, 4289]

```json
[[-448.16, -2301.81], [1284.32, -2301.81], [2633.55, -2301.81], [2706.58, -2301.81], [3152.98, -2301.81], [3152.98, -2143.81], [3050.98, -2030.81], [3152.98, -1807.81], [3256.98, -1584.81], [3463.98, -1473.81], [3619.98, -1538.81], [3743.98, -1538.81], [3927.98, -1419.81], [3871.98, -1299.81], [4102.98, -1088.81], [4502.98, -1217.81], [4502.98, -862.81], [4838.98, -575.81], [5126.98, -398.81], [5126.98, 109.19], [4838.98, 319.19], [4574.98, 319.19], [4358.98, 510.19], [4358.98, 675.19], [4270.98, 675.19], [4270.98, 917.19], [4102.98, 1034.19], [3972.98, 1223.19], [3972.98, 1516.19], [3900.98, 1789.19], [3763.98, 1877.19], [3599.98, 1921.19], [3491.98, 2163.19], [3463.98, 2433.19], [3399.98, 2703.19], [3265.98, 3034.19], [3152.98, 3336.19], [2996.98, 3661.19], [2855.98, 3818.19], [2855.98, 4058.19], [2693.98, 4289.19], [1284.32, 4289.19], [922.35, 4289.19], [-448.16, 4289.19], [-448.16, 3539.19], [-448.16, 1604.73], [-448.16, 505.36], [-448.16, -1218.97], [-448.16, -1879.39]]
```

### Sierra Sonora (5 points)
- **Sector:** `exterior_1_-1_0_6`
- **TweakDB:** `Districts.SierraSonora`
- **Node Position:** (3844.96, -2465.32)
- **Extent:** X [1900, 5653] Y [-3153, -1830]

```json
[[1900.3, -3152.59], [5652.7, -3152.59], [5652.7, -1830.17], [1900.3, -1830.17], [1900.3, -2491.38]]
```

### Vasquez Pass (7 points)
- **Sector:** `exterior_1_-1_0_6`
- **TweakDB:** `Districts.VasquezPass`
- **Node Position:** (5339.53, -1337.32)
- **Extent:** X [4694, 6016] Y [-3122, 585]

```json
[[5652.63, -3121.89], [6015.53, -3121.89], [6015.53, -1337.33], [6015.53, 584.61], [5013.53, 584.61], [4694.53, -1337.33], [5652.63, -1337.33]]
```

### Jackson Plains (19 points)
- **Sector:** `exterior_-1_-1_0_6`
- **TweakDB:** `Districts.JacksonPlains`
- **Node Position:** (-941.57, -3815.99)
- **Extent:** X [-2607, 721] Y [-5612, -2295]

```json
[[-575.27, -2294.99], [720.87, -2294.99], [720.87, -2862.53], [625.0, -2957.27], [720.87, -3011.04], [541.01, -3237.1], [468.29, -3308.3], [308.89, -3402.44], [-82.21, -3680.87], [-226.48, -3792.43], [-375.23, -3815.99], [-406.59, -3852.58], [-565.71, -4079.64], [-847.81, -4341.15], [-1133.02, -4641.56], [-1420.23, -4926.49], [-2606.96, -5611.79], [-2606.96, -2294.99], [-1506.47, -2294.99]]
```

### Rattlesnake Creek (18 points)
- **Sector:** `exterior_-1_-2_0_6`
- **TweakDB:** `Districts.RattlesnakeCreek`
- **Node Position:** (-1369.79, -5737.53)
- **Extent:** X [-2776, 89] Y [-6225, -5306]

```json
[[-2776.2, -5737.54], [-2776.2, -6224.77], [-1821.46, -6224.77], [-1369.8, -6224.77], [-917.36, -6224.77], [-368.14, -6224.77], [88.82, -6224.77], [88.82, -5737.54], [88.82, -5568.99], [-237.47, -5307.56], [-458.88, -5306.11], [-579.98, -5335.89], [-799.37, -5505.09], [-1071.07, -5583.55], [-1369.8, -5705.59], [-1598.8, -5737.54], [-2173.86, -5737.54], [-2455.13, -5737.54]]
```

### Biotechnica Flats (36 points)
- **Sector:** `exterior_-1_-2_0_6`
- **TweakDB:** `Districts.BiotechnicaFlats`
- **Node Position:** (-2819.86, -3856.13)
- **Extent:** X [-5419, -462] Y [-5574, -1960]

```json
[[-462.03, -1960.12], [-575.28, -1960.12], [-756.64, -1960.12], [-941.15, -2000.96], [-1163.56, -2079.45], [-1328.65, -2157.77], [-1526.49, -2266.5], [-1753.37, -2406.57], [-1908.71, -2537.87], [-2101.0, -2765.35], [-2273.0, -3023.55], [-2350.32, -3181.95], [-2428.0, -3397.39], [-2619.93, -3695.71], [-2779.98, -3856.13], [-2856.62, -3956.91], [-2980.42, -3993.49], [-2930.25, -4211.51], [-3016.16, -4277.28], [-3232.43, -4319.89], [-3429.28, -4367.28], [-3661.0, -4517.07], [-3898.47, -4653.74], [-4095.86, -4708.56], [-4238.33, -4800.16], [-4435.6, -4929.02], [-4616.63, -5056.86], [-4830.56, -5159.85], [-5106.07, -5311.44], [-5418.82, -5574.13], [-5418.82, -3856.13], [-5418.82, -1960.12], [-4327.6, -1960.12], [-3177.91, -1960.12], [-1870.13, -1960.12], [-1005.53, -1960.12]]
```

### North Sunrise Oil Field (21 points)
- **Sector:** `exterior_-1_1_0_6`
- **TweakDB:** `Districts.NorthSunriseOilField`
- **Node Position:** (-1801.09, 3874.67)
- **Extent:** X [-3420, -69] Y [3120, 5037]

```json
[[-1283.48, 5037.22], [-1801.09, 5037.22], [-2223.08, 5037.22], [-2689.02, 5037.22], [-3050.69, 5037.22], [-3419.95, 5037.22], [-3419.95, 4625.22], [-3419.95, 4281.22], [-3419.95, 3874.67], [-3419.95, 3466.83], [-3419.95, 3120.12], [-2737.44, 3120.12], [-2223.08, 3120.12], [-1801.09, 3120.12], [-1283.48, 3120.12], [-808.18, 3120.12], [-69.53, 3120.12], [-69.53, 3874.67], [-69.53, 4625.22], [-69.53, 5037.22], [-808.18, 5037.22]]
```

### SoCal Border Crossing (4 points)
- **Sector:** `exterior_-3_-6_0_4`
- **TweakDB:** `Districts.SoCalBorderCrossing`
- **Node Position:** (-2863.62, -5628.52)
- **Extent:** X [-2940, -2788] Y [-5790, -5467]

```json
[[-2939.62, -5789.52], [-2787.62, -5789.52], [-2787.62, -5467.52], [-2939.62, -5467.52]]
```

## Nomad Lifepath Areas (Not on World Map)

These were also found in the sectors but are nomad lifepath start areas, not geographic subdistricts:

### Yucca (7 points)
- **Sector:** `exterior_-1_-2_0_6`
- **TweakDB:** `Districts.Yucca`
- **Node Position:** (-3977.66, -6582.86)
- **Extent:** X [-4094, -3861] Y [-6732, -6434]

### Dry Creek (4 points)
- **Sector:** `exterior_-1_-2_0_6`
- **TweakDB:** `Districts.DryCreek`
- **Node Position:** (-3253.88, -6773.62)
- **Extent:** X [-3587, -2920] Y [-7051, -6496]

## Overlap Issues & Clipping

The `worldLocationAreaNode` polygons are **3D trigger volumes** — they detect when the player enters a zone to update the HUD district name. They were never designed to be rendered as non-overlapping 2D map regions. As a result:

1. **Badlands subdistricts overlap city districts.** Red Peaks, Rocky Ridge, Jackson Plains, Biotechnica Flats, and North Sunrise Oil Field all have edges that cross into city district territory (1-3% overlap each).

2. **Badlands subdistricts overlap each other.** Adjacent zones share edges or have slivers of overlap (Sierra Sonora/Rocky Ridge, Jackson Plains/Laguna Bend, etc.).

### Fixing overlaps for 2D map rendering

The NC Zoning Board project uses a two-pass Shapely clipping approach in `scripts/regenerate_subdistricts.py`:

**Pass 1: Subtract city districts.** The 7 main city district polygons from `3dmap_view.ent.json` are authoritative (they're the canonical map boundaries CDPR designed for the in-game map). Combine them into a `unary_union`, then `difference()` each Badlands subdistrict against it. This cleanly trims any Badlands edges that intrude into Night City proper.

```python
from shapely.ops import unary_union

# city_district_shapes = list of ShapelyPolygon for each of the 7 city districts
city_union = unary_union(city_district_shapes)

for sub in badlands_subdistricts:
    shape = ShapelyPolygon(sub["polygon"])
    clipped = shape.difference(city_union)
    # Handle MultiPolygon result (keep largest piece) or empty result
    sub["polygon"] = extract_coords(clipped)
```

**Pass 2: Resolve inter-subdistrict overlaps.** Process subdistricts in order of area, smallest first. Each subdistrict subtracts all previously processed shapes. This gives priority to smaller, more specific zones — SoCal Border Crossing (tiny) won't get consumed by the much larger Jackson Plains or Rattlesnake Creek.

```python
# Sort indices by area (smallest first = highest priority)
indexed = sorted(range(len(subs)),
                 key=lambda i: ShapelyPolygon(subs[i]["polygon"]).area)

processed_shapes = []
for idx in indexed:
    shape = ShapelyPolygon(subs[idx]["polygon"])
    for prev in processed_shapes:
        shape = shape.difference(prev)
    subs[idx]["polygon"] = extract_coords(shape)
    processed_shapes.append(ShapelyPolygon(subs[idx]["polygon"]))
```

### Pass 3: Gap filling between Badlands subdistricts

After Passes 1 and 2, small geometric voids remain between adjacent Badlands subdistricts. These occur because the original trigger volumes were authored independently — their edges meet at single vertices, not shared lines, leaving slivers of unclaimed space that are visually obvious as dark voids in the rendered map.

**Detection method:** Buffer the union of all Badlands subdistricts by a small amount (50 CET units), subtract the original union and all city districts, keep only pieces smaller than 200,000 sq units. The large open wasteland area always appears as a single large piece and is excluded by this size filter.

**Why `distance() == 0` is misleading:** Shapely's `distance()` returns 0 if two polygons share even a single vertex. Two polygons can share one point and still have a triangular gap between them — they are topologically touching but not edge-sharing.

**Assignment rule:** Single-neighbor gaps are merged directly into that neighbor. Multi-neighbor gaps are split using a centroid-distance priority rule — each neighbor claims the portion of the gap closer to it than to any other neighbor.

**Results of Pass 3:**

| Gap | Area (sq) | Resolution |
|-----|-----------|------------|
| Biotechnica Flats general gaps | 31,164 + 502 | Merged into Biotechnica Flats |
| Sierra Sonora / Rocky Ridge / Vasquez Pass / Laguna Bend triangle | 6,609 | Split between 4 neighbors |
| Red Peaks south edge (borders Rancho Coronado) | 4,706 | Merged into Red Peaks |
| Red Peaks / Rocky Ridge junction | 108 | Split between 2 neighbors |
| Jackson Plains / Biotechnica / Rattlesnake Creek junction | 16 | Split between 3 neighbors |

### Known unfixable gaps

Two gaps cannot be resolved without modifying authoritative city district polygons (which must not be changed):

**1. SoCal Border Crossing wedges**

SoCal Border Crossing is a small rotated rectangle (4 points, -37.6° yaw). Its straight edges create wedge-shaped voids against the irregular polygon edges of Rattlesnake Creek and Jackson Plains. These voids connect directly to the large open-wasteland void, so the buffer detection method sees them as part of the wasteland and excludes them. The gap edges exist inside the coordinate space between SoCal and its neighbors but cannot be isolated cleanly.

This is consistent with the nature of the SoCal zone — it marks the exact point where the nomad lifepath start connects to Night City. The geometry reflects that it was authored as a standalone trigger, not designed to tile with surrounding zones.

**2. Biotechnica Flats / Dogtown / West Wind Estate triangle**

A triangular dark void is visible at the point where the Dogtown district (city, authoritative) and West Wind Estate subdistrict (Pacifica, authoritative) touch at a single vertex (-2437.95, -2593.64). Biotechnica Flats' nearest boundary is 381 CET units south of this meeting point.

Investigation confirmed:
- Dogtown and West Wind Estate touch at exactly one vertex — their boundary is a degenerate zero-length line
- The triangle between that vertex and Biotechnica's north edge lies **inside Dogtown's polygon** (99.6% of the triangle area overlaps with Dogtown)
- Biotechnica cannot be expanded to fill this area without crossing into Dogtown's city district boundary
- The void is geometrically a property of how CDPR authored the Dogtown and West Wind Estate trigger volumes — they were designed for 3D trigger detection, not 2D tiling

**Why both are unfixable:** The correct fix for both would require editing Dogtown, West Wind Estate, or the Pacifica subdistricts — all of which are authoritative CDPR-defined boundaries that must not be modified. In the actual frontend implementation, these zones use border-only rendering (no fill), so the dark voids are only visible in the preview SVG, not in the final map.

### For modding: using raw polygons vs clipped polygons

If you're creating a mod that adds Badlands subdistricts to the in-game map (e.g., via `gameStaticTriggerAreaComponent` in a custom entity), you probably want the **raw unclipped polygons** from this document. The game's trigger system handles overlaps naturally — the district manager uses a stack, and the most specific (innermost) zone takes precedence. The clipping is only needed for 2D flat map rendering where overlapping fills look wrong.

The raw polygon coordinates in this document are the **unclipped originals** as decoded from the streaming sectors. For the clipped versions used in the NC Zoning Board map, see `data/subdistricts.json` (regenerated by `scripts/regenerate_subdistricts.py`).

## Notes

- The `AreaShapeOutline.points` field is always a placeholder unit square — ignore it
- The `z` coordinate in buffer points is usually constant per polygon (the boundary height above sea level) — useful for 3D rendering but not needed for 2D map overlays
- Some nodes have `isVisibleInGame: 1` — this controls whether the area name shows in the HUD when the player enters
- The `sourcePrefabHash` field is shared across nodes in the same sector — it identifies the prefab template
- World coordinates are CET space: X increases east, Y increases north
- For a mod adding these to the in-game map, you'd create `gameStaticTriggerAreaComponent` entries in a custom `.ent` file, similar to how `3dmap_view.ent` defines city district triggers. The polygon points go in the `outline.Data.points` array, and the `notifiers` array links to the TweakDB `District_Record` via `districtID`
