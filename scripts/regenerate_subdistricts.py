"""
Regenerate data/subdistricts.json with proper parent-chain transforms.

Walks the full parent transform chain for each trigger component, applying
rotation and translation at each level. This correctly handles:
  - Pacifica (65 degree yaw rotation in pacifica_transform)
  - Pacifica sub-districts (coastview, west_wind_estate, also rotated)
  - NCX/Spaceport (parented to morro_rock_trigger)
  - Dogtown (chains through pacifica_data0633)

City sub-district polygons are clipped to their parent district boundary
via Shapely intersection.

Badlands sub-district polygons are extracted from streaming sector files
(worldLocationAreaNode binary buffers); these zones aren't in 3dmap_view.ent
because they don't appear on the in-game map.
"""
import base64
import json
import math
import os
import struct
import sys
from shapely.geometry import Polygon as ShapelyPolygon, Point as ShapelyPoint
from shapely.ops import unary_union

ENT_JSON_PATH = r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\entities\cameras\3dmap\3dmap_view.ent.json"

SECTOR_DIR = r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\worlds\03_night_city\_compiled\default"

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
OUTPUT_PATH = os.path.join(REPO_ROOT, "data", "subdistricts.json")

# Strips subdistrict boundary edges that sit exactly on the parent district
# boundary after Shapely clipping. 0 works because clipped edges land at exact
# coordinates. Raise only if clipped edges aren't being stripped correctly.
BOUNDARY_TOLERANCE = 0.0


# District structure with sub-districts and their trigger names
DISTRICT_STRUCTURE = [
    {
        "id": "city_center", "name": "City Center", "trigger": "city_center_trigger",
        "subdistricts": [
            {"id": "corpo_plaza", "name": "Corpo Plaza", "trigger": "corpo_plaza_trigger"},
            {"id": "downtown", "name": "Downtown", "trigger": "downtown_trigger"},
        ]
    },
    {
        "id": "watson", "name": "Watson", "trigger": "watson_trigger",
        "subdistricts": [
            {"id": "arasaka_waterfront", "name": "Arasaka Waterfront", "trigger": "arasaka_waterfront_trigger"},
            {"id": "northside", "name": "Northside Industrial District", "trigger": "northside_trigger"},
            {"id": "kabuki", "name": "Kabuki", "trigger": "kabuki_trigger"},
            {"id": "little_china", "name": "Little China", "trigger": "little_china_trigger"},
        ]
    },
    {
        "id": "westbrook", "name": "Westbrook", "trigger": "westbrook_trigger",
        "subdistricts": [
            {"id": "japan_town", "name": "Japantown", "trigger": "japan_town_trigger"},
            {"id": "north_oak", "name": "North Oak", "trigger": "north_oak_trigger"},
            {"id": "charter_hill", "name": "Charter Hill", "trigger": "charter_hill_trigger"},
        ]
    },
    {
        "id": "heywood", "name": "Heywood", "trigger": "heywood_trigger",
        "subdistricts": [
            {"id": "wellspring", "name": "Wellsprings", "trigger": "wellspring_trigger"},
            {"id": "glen", "name": "The Glen", "trigger": "glen_trigger"},
            {"id": "vista_del_rey", "name": "Vista Del Rey", "trigger": "vista_del_rey_trigger"},
        ]
    },
    {
        "id": "santo_domingo", "name": "Santo Domingo", "trigger": "santo_domingo_trigger",
        "subdistricts": [
            {"id": "arroyo", "name": "Arroyo", "trigger": "arroyo_trigger"},
            {"id": "rancho_coronado", "name": "Rancho Coronado", "trigger": "rancho_coronado_trigger"},
        ]
    },
    {
        "id": "pacifica", "name": "Pacifica", "trigger": "pacifica_trigger",
        "subdistricts": [
            {"id": "coastview", "name": "Coastview", "trigger": "coastview_trigger"},
            {"id": "west_wind_estate", "name": "West Wind Estate", "trigger": "west_wind_estate_trigger"},
        ]
    },
    {
        "id": "dogtown", "name": "Dogtown", "trigger": "dogtown_trigger",
        "subdistricts": []
    },
    {
        # NCX trigger and morro_rock_trigger share the exact same outline:
        # NCX is parented to morro_rock_trigger. They're the same area.
        "id": "ncx_morro_rock", "name": "NCX Spaceport / Morro Rock", "trigger": "ncx_trigger",
        "subdistricts": []
    },
]

# Badlands sub-districts extracted from streaming sector worldLocationAreaNode entries.
# These don't exist in 3dmap_view.ent (not shown on the in-game map) so they come from
# a separate source. See docs/streaming-sector-shapes.md for the extraction method.
BADLANDS_SECTOR_SUBDISTRICTS = [
    {
        "sector": "exterior_0_-1_0_6.streamingsector.json",
        "subdistricts": [
            {"id": "laguna_bend", "name": "Laguna Bend", "debug_name": "{laguna_bend}"},
            {"id": "red_peaks", "name": "Red Peaks", "debug_name": "{red_peaks}"},
            {"id": "rocky_ridge", "name": "Rocky Ridge", "debug_name": "{rocky_ridge}"},
        ]
    },
    {
        "sector": "exterior_1_-1_0_6.streamingsector.json",
        "subdistricts": [
            {"id": "sierra_sonora", "name": "Sierra Sonora", "debug_name": "{sierra_sonora}"},
            {"id": "vasquez_pass", "name": "Vasquez Pass", "debug_name": "{vasquez_pass}"},
        ]
    },
    {
        "sector": "exterior_-1_-1_0_6.streamingsector.json",
        "subdistricts": [
            {"id": "jackson_plains", "name": "Jackson Plains", "debug_name": "{jackson_plains}"},
        ]
    },
    {
        "sector": "exterior_-1_-2_0_6.streamingsector.json",
        "subdistricts": [
            {"id": "rattlesnake_creek", "name": "Rattlesnake Creek", "debug_name": "{rattlesnake_creek}"},
            {"id": "biotechnica_flats", "name": "Biotechnica Flats", "debug_name": "{biotechnica_flats}"},
        ]
    },
    {
        "sector": "exterior_-1_1_0_6.streamingsector.json",
        "subdistricts": [
            {"id": "north_sunrise_oil_field", "name": "North Sunrise Oil Field", "debug_name": "{north_sunrise_oil_field}"},
        ]
    },
    {
        "sector": "exterior_-3_-6_0_4.streamingsector.json",
        "subdistricts": [
            {"id": "socal_border_crossing", "name": "SoCal Border Crossing",
             "debug_name": "{q000_nomad_tr_border_crossing_loc_area_}001"},
        ]
    },
]


def extract_sector_subdistricts(sector_path, wanted_debug_names):
    """Extract worldLocationAreaNode polygons from a streaming sector JSON.

    Returns a dict mapping debug_name -> list of [x, y] CET world-space points.
    See docs/streaming-sector-shapes.md for the binary buffer format.
    """
    with open(sector_path, encoding="utf-8") as f:
        data = json.load(f)

    root = data["Data"]["RootChunk"]
    nodes = root["nodes"]
    node_data_list = root["nodeData"]["Data"]

    results = {}
    for i, node in enumerate(nodes):
        nd = node.get("Data", {})
        if nd.get("$type") != "worldLocationAreaNode":
            continue

        debug_name = nd.get("debugName", {}).get("$value", "")
        if debug_name not in wanted_debug_names:
            continue

        # Get world position from nodeData
        pos_x, pos_y = 0.0, 0.0
        for ndi in node_data_list:
            if ndi.get("NodeIndex") == i:
                pos = ndi.get("Position", {})
                pos_x = pos.get("X", 0.0)
                pos_y = pos.get("Y", 0.0)
                break

        # Get orientation quaternion from nodeData (for yaw rotation)
        ori_r, ori_k = 1.0, 0.0
        for ndi in node_data_list:
            if ndi.get("NodeIndex") == i:
                ori = ndi.get("Orientation", {})
                ori_r = ori.get("r", 1.0)
                ori_i = ori.get("i", 0.0)
                ori_j = ori.get("j", 0.0)
                ori_k = ori.get("k", 0.0)
                break

        yaw = math.atan2(2.0 * (ori_r * ori_k + ori_i * ori_j),
                         1.0 - 2.0 * (ori_j * ori_j + ori_k * ori_k))

        # Decode binary buffer: uint32 count + N × (x, y, z, w) float32
        outline = nd.get("outline", {}).get("Data", {})
        buf_b64 = outline.get("buffer", "")
        raw = base64.b64decode(buf_b64)
        if len(raw) < 4:
            continue

        count = struct.unpack_from("<I", raw, 0)[0]
        polygon = []
        for pi in range(count):
            offset = 4 + pi * 16
            if offset + 16 > len(raw):
                break
            x, y, z, w = struct.unpack_from("<ffff", raw, offset)
            # Apply yaw rotation (local space), then translate to world
            if abs(yaw) > 1e-6:
                cos_a = math.cos(yaw)
                sin_a = math.sin(yaw)
                rx = x * cos_a - y * sin_a
                ry = x * sin_a + y * cos_a
                x, y = rx, ry
            polygon.append([round(x + pos_x, 2), round(y + pos_y, 2)])

        results[debug_name] = polygon

    return results


def main():
    if not os.path.exists(ENT_JSON_PATH):
        print(f"ERROR: .ent JSON not found: {ENT_JSON_PATH}")
        sys.exit(1)

    with open(ENT_JSON_PATH, "r") as f:
        data = json.load(f)

    chunks = data["Data"]["RootChunk"]["compiledData"]["Data"]["Chunks"]

    # Build component lookup by name
    components = {}
    for chunk in chunks:
        name = chunk.get("name", {})
        if isinstance(name, dict):
            name = name.get("$value", "")
        if name:
            components[name] = chunk

    def get_local_transform(comp):
        lt = comp.get("localTransform", {})
        pos = lt.get("Position", {})
        ori = lt.get("Orientation", {})
        tx = pos.get("x", {}).get("Bits", 0) / 131072.0
        ty = pos.get("y", {}).get("Bits", 0) / 131072.0
        qr = ori.get("r", 1.0)
        qi = ori.get("i", 0.0)
        qj = ori.get("j", 0.0)
        qk = ori.get("k", 0.0)
        yaw = math.atan2(2.0 * (qr * qk + qi * qj),
                         1.0 - 2.0 * (qj * qj + qk * qk))
        return tx, ty, yaw

    def get_parent_name(comp):
        pt = comp.get("parentTransform", {})
        if not pt or not isinstance(pt, dict):
            return None
        pd = pt.get("Data", {})
        if not pd:
            return None
        bn = pd.get("bindName", {})
        return bn.get("$value", None) if bn else None

    def compute_world_points(comp):
        """Walk parent chain, apply rotate+translate at each level."""
        outline = comp["outline"]["Data"]["points"]
        chain = []
        current = comp
        while current is not None:
            tx, ty, yaw = get_local_transform(current)
            chain.append((tx, ty, yaw))
            pn = get_parent_name(current)
            current = components.get(pn) if pn else None

        pts = [(p["X"], p["Y"]) for p in outline]
        for tx, ty, yaw in chain:
            if abs(yaw) > 1e-6:
                cos_a = math.cos(yaw)
                sin_a = math.sin(yaw)
                pts = [(x * cos_a - y * sin_a, x * sin_a + y * cos_a)
                       for x, y in pts]
            if abs(tx) > 1e-6 or abs(ty) > 1e-6:
                pts = [(x + tx, y + ty) for x, y in pts]
        return [[round(x, 2), round(y, 2)] for x, y in pts]

    def find_trigger(trigger_name):
        for chunk in chunks:
            if chunk.get("$type") == "gameStaticTriggerAreaComponent":
                if chunk["name"]["$value"] == trigger_name:
                    return chunk
        return None

    output = {
        "description": (
            "District and sub-district boundary polygons extracted from "
            "CP2077 3dmap_view.ent trigger areas. Coordinates are in CET "
            "world-space (game coordinates). Full parent transform chain "
            "(rotation + translation) applied. Sub-district polygons are "
            "clipped to their parent district boundary via Shapely intersection."
        ),
        "source": "base/entities/cameras/3dmap/3dmap_view.ent.json",
        "districts": []
    }

    city_district_shapes = []  # Collect for Badlands clipping (Pass 1)

    for dist in DISTRICT_STRUCTURE:
        comp = find_trigger(dist["trigger"])
        if not comp:
            print(f"WARNING: trigger not found: {dist['trigger']}")
            continue

        polygon = compute_world_points(comp)
        xs = [p[0] for p in polygon]
        ys = [p[1] for p in polygon]
        print(f"{dist['id']:20s} {len(polygon):3d} pts  "
              f"X [{min(xs):8.0f}, {max(xs):8.0f}]  "
              f"Y [{min(ys):8.0f}, {max(ys):8.0f}]")

        district_shape = ShapelyPolygon(polygon)
        city_district_shapes.append(district_shape)

        district_entry = {
            "id": dist["id"],
            "name": dist["name"],
            "trigger": dist["trigger"],
            "polygon": polygon,
            "subdistricts": []
        }

        for sub in dist["subdistricts"]:
            sub_comp = find_trigger(sub["trigger"])
            if not sub_comp:
                print(f"  WARNING: sub-trigger not found: {sub['trigger']}")
                continue
            sub_polygon = compute_world_points(sub_comp)

            # Clip subdistrict to parent district boundary.
            # Game trigger zones don't tile perfectly so raw subdistrict polygons
            # can extend outside their parent. Shapely handles non-convex
            # parent boundaries correctly.
            clipped = district_shape.intersection(ShapelyPolygon(sub_polygon))
            if clipped.is_empty:
                print(f"  WARNING: {sub['id']} has no overlap with parent — using original")
            elif clipped.geom_type == "MultiPolygon":
                largest = max(clipped.geoms, key=lambda g: g.area)
                sub_polygon = [[round(x, 2), round(y, 2)]
                               for x, y in list(largest.exterior.coords)[:-1]]
                print(f"  NOTE: {sub['id']} clipped to MultiPolygon, keeping largest piece")
            elif clipped.geom_type == "Polygon":
                sub_polygon = [[round(x, 2), round(y, 2)]
                               for x, y in list(clipped.exterior.coords)[:-1]]

            sxs = [p[0] for p in sub_polygon]
            sys_ = [p[1] for p in sub_polygon]
            print(f"  {sub['id']:20s} {len(sub_polygon):3d} pts  "
                  f"X [{min(sxs):8.0f}, {max(sxs):8.0f}]  "
                  f"Y [{min(sys_):8.0f}, {max(sys_):8.0f}]")

            district_entry["subdistricts"].append({
                "id": sub["id"],
                "name": sub["name"],
                "trigger": sub["trigger"],
                "polygon": sub_polygon,
            })

        output["districts"].append(district_entry)

    # ── Badlands sub-districts from streaming sectors ─────────────────────
    print("\n--- Badlands sub-districts (streaming sectors) ---")
    badlands_entry = {
        "id": "badlands",
        "name": "Badlands",
        "trigger": None,
        "polygon": None,  # No single boundary polygon for Badlands
        "subdistricts": []
    }

    for sector_group in BADLANDS_SECTOR_SUBDISTRICTS:
        sector_file = os.path.join(SECTOR_DIR, sector_group["sector"])
        if not os.path.exists(sector_file):
            print(f"  WARNING: sector not found: {sector_group['sector']}")
            continue

        wanted = {s["debug_name"] for s in sector_group["subdistricts"]}
        extracted = extract_sector_subdistricts(sector_file, wanted)

        for sub_def in sector_group["subdistricts"]:
            polygon = extracted.get(sub_def["debug_name"])
            if not polygon:
                print(f"  WARNING: {sub_def['id']} not found in {sector_group['sector']}")
                continue

            xs = [p[0] for p in polygon]
            ys = [p[1] for p in polygon]
            print(f"  {sub_def['id']:25s} {len(polygon):3d} pts  "
                  f"X [{min(xs):8.0f}, {max(xs):8.0f}]  "
                  f"Y [{min(ys):8.0f}, {max(ys):8.0f}]")

            badlands_entry["subdistricts"].append({
                "id": sub_def["id"],
                "name": sub_def["name"],
                "trigger": sub_def["debug_name"],
                "polygon": polygon,
            })

    # ── Pass 1: Subtract city districts from Badlands subdistricts ───────
    # City district shapes are authoritative: Badlands zones must not overlap them.
    if badlands_entry["subdistricts"] and city_district_shapes:
        print("\n--- Pass 1: Clipping Badlands against city districts ---")
        city_union = unary_union(city_district_shapes)
        for sub in badlands_entry["subdistricts"]:
            shape = ShapelyPolygon(sub["polygon"])
            original_area = shape.area
            clipped = shape.difference(city_union)
            if clipped.is_empty:
                print(f"  WARNING: {sub['id']} fully inside city districts — keeping original")
            elif clipped.geom_type == "MultiPolygon":
                largest = max(clipped.geoms, key=lambda g: g.area)
                sub["polygon"] = [[round(x, 2), round(y, 2)]
                                  for x, y in list(largest.exterior.coords)[:-1]]
                pct = (1 - largest.area / original_area) * 100
                print(f"  {sub['id']:25s} clipped {pct:.0f}% (MultiPolygon, kept largest)")
            elif clipped.geom_type == "Polygon":
                sub["polygon"] = [[round(x, 2), round(y, 2)]
                                  for x, y in list(clipped.exterior.coords)[:-1]]
                pct = (1 - clipped.area / original_area) * 100
                if pct > 0.1:
                    print(f"  {sub['id']:25s} clipped {pct:.0f}%")

    # ── Pass 2: Resolve inter-subdistrict overlaps ────────────────────────
    # Process smallest first: smaller/more specific zones take priority.
    if badlands_entry["subdistricts"]:
        print("\n--- Pass 2: Resolving Badlands inter-subdistrict overlaps ---")
        subs = badlands_entry["subdistricts"]
        # Sort by area (smallest first = highest priority, processed first)
        indexed = sorted(range(len(subs)),
                         key=lambda i: ShapelyPolygon(subs[i]["polygon"]).area)

        processed_shapes = []
        for idx in indexed:
            sub = subs[idx]
            shape = ShapelyPolygon(sub["polygon"])
            original_area = shape.area
            # Subtract all previously processed (higher-priority) shapes
            for prev_shape in processed_shapes:
                shape = shape.difference(prev_shape)
            if shape.is_empty:
                print(f"  WARNING: {sub['id']} fully consumed by higher-priority neighbors")
            elif shape.geom_type == "MultiPolygon":
                largest = max(shape.geoms, key=lambda g: g.area)
                sub["polygon"] = [[round(x, 2), round(y, 2)]
                                  for x, y in list(largest.exterior.coords)[:-1]]
                pct = (1 - largest.area / original_area) * 100
                if pct > 0.1:
                    print(f"  {sub['id']:25s} trimmed {pct:.0f}% (overlap with smaller neighbors)")
            elif shape.geom_type == "Polygon":
                sub["polygon"] = [[round(x, 2), round(y, 2)]
                                  for x, y in list(shape.exterior.coords)[:-1]]
                pct = (1 - shape.area / original_area) * 100
                if pct > 0.1:
                    print(f"  {sub['id']:25s} trimmed {pct:.0f}% (overlap with smaller neighbors)")
            # Add the ORIGINAL (unclipped) shape to processed list:
            # this means later (larger) subs subtract the full original zone,
            # not the already-trimmed version
            processed_shapes.append(ShapelyPolygon(subs[idx]["polygon"]))

    # ── Pass 3: Fill genuine boundary gaps between Badlands subdistricts ──
    # Detects gaps using a buffer approach: expand the union of all subdistricts
    # by a small amount, subtract the original union and city districts. Small
    # pieces (< 200,000 sq units) are genuine boundary voids; the big void is
    # open wasteland and is intentionally left empty.
    if badlands_entry["subdistricts"]:
        print("\n--- Pass 3: Filling Badlands boundary gaps ---")

        bl_shapes = {s["id"]: ShapelyPolygon(s["polygon"])
                     for s in badlands_entry["subdistricts"]}
        bl_union = unary_union(list(bl_shapes.values()))
        city_union_p3 = unary_union(city_district_shapes)

        GAP_BUFFER = 50
        GAP_MAX_AREA = 50_000   # Excludes the North Oaks Casino void (~96,949 sq)
                                # which is handled separately as a non-canonical subdistrict

        buffered = bl_union.buffer(GAP_BUFFER)
        all_gap_geom = buffered.difference(bl_union).difference(city_union_p3)
        gap_pieces = (list(all_gap_geom.geoms)
                      if all_gap_geom.geom_type == "MultiPolygon"
                      else ([all_gap_geom] if not all_gap_geom.is_empty else []))
        real_gaps = [p for p in gap_pieces if 5 < p.area < GAP_MAX_AREA]

        print(f"  Found {len(real_gaps)} boundary gap(s) to fill")

        for gap in sorted(real_gaps, key=lambda g: g.area, reverse=True):
            neighbors = [(sid, s, s.distance(gap))
                         for sid, s in bl_shapes.items()
                         if s.distance(gap) < GAP_BUFFER + 20]
            neighbors.sort(key=lambda x: x[2])
            if not neighbors:
                continue

            if len(neighbors) == 1:
                sid = neighbors[0][0]
                merged = neighbors[0][1].union(gap)
                if merged.geom_type == "MultiPolygon":
                    merged = max(merged.geoms, key=lambda g: g.area)
                bl_shapes[sid] = merged
                print(f"  -> Merged gap ({gap.area:.0f} sq) into {sid}")
            else:
                # Split gap: each neighbour claims the portion closer to it
                for sid, shape, _ in neighbors:
                    claim = gap
                    for other_sid, other_shape, _ in neighbors:
                        if other_sid == sid:
                            continue
                        d_self  = shape.distance(gap.centroid)
                        d_other = other_shape.distance(gap.centroid)
                        if d_other < d_self:
                            claim = claim.difference(other_shape.buffer(GAP_BUFFER * 2))
                    if not claim.is_empty and claim.area > 1:
                        if claim.geom_type == "MultiPolygon":
                            claim = max(claim.geoms, key=lambda g: g.area)
                        merged = bl_shapes[sid].union(claim)
                        if merged.geom_type == "MultiPolygon":
                            merged = max(merged.geoms, key=lambda g: g.area)
                        bl_shapes[sid] = merged
                print(f"  -> Split gap ({gap.area:.0f} sq) between: {[n[0] for n in neighbors]}")

        # Note: The gap between Biotechnica Flats, Dogtown, and West Wind Estate
        # cannot be filled; the void lies inside Dogtown's city district polygon,
        # and city district polygons are authoritative and cannot be modified.

        # Write updated polygons back, cleaning geometry with buffer(0)
        for sub in badlands_entry["subdistricts"]:
            if sub["id"] in bl_shapes:
                shape = bl_shapes[sub["id"]].buffer(0)  # clean floating-point artefacts
                if shape.geom_type == "MultiPolygon":
                    shape = max(shape.geoms, key=lambda g: g.area)
                if not shape.is_empty and shape.geom_type == "Polygon":
                    sub["polygon"] = [[round(x, 2), round(y, 2)]
                                      for x, y in list(shape.exterior.coords)[:-1]]

    if badlands_entry["subdistricts"]:
        output["districts"].append(badlands_entry)

    # ── North Oaks Casino (optional, cut-content district) ───────────────
    # The North Oaks Casino is cut content: a district void between North Oak
    # (Westbrook), Red Peaks, and Rocky Ridge. It exists as empty space in-game
    # and is the target of a community restoration mod led by Kao.
    #
    # Computed via triple-buffer intersection: the area within 1200 CET units
    # of all three surrounding districts, minus those districts themselves.
    # canonical=False flags this as non-canon / mod-specific.
    print("\n--- North Oaks Casino (cut content, optional) ---")
    _noc_north_oak = None
    _noc_red_peaks = None
    _noc_rocky_ridge = None
    for _dist in output["districts"]:
        if _dist["id"] == "westbrook":
            for _sub in _dist["subdistricts"]:
                if _sub["id"] == "north_oak":
                    _noc_north_oak = ShapelyPolygon(_sub["polygon"])
        for _sub in _dist.get("subdistricts", []):
            if _sub["id"] == "red_peaks":
                _noc_red_peaks = ShapelyPolygon(_sub["polygon"])
            if _sub["id"] == "rocky_ridge":
                _noc_rocky_ridge = ShapelyPolygon(_sub["polygon"])

    if _noc_north_oak and _noc_red_peaks and _noc_rocky_ridge:
        _buf = 1200  # Stable convergence point for this triple-buffer
        _triple = (_noc_north_oak.buffer(_buf)
                   .intersection(_noc_red_peaks.buffer(_buf))
                   .intersection(_noc_rocky_ridge.buffer(_buf)))
        # Small buffer(0) fixes floating-point self-intersections after gap-filling
        _three_union = unary_union([_noc_north_oak.buffer(0),
                                    _noc_red_peaks.buffer(0),
                                    _noc_rocky_ridge.buffer(0)])
        _city_union = unary_union(city_district_shapes)
        _casino = _triple.difference(_three_union).difference(_city_union)

        # Keep only the largest piece (the main casino void)
        if _casino.geom_type == "MultiPolygon":
            _casino = max(_casino.geoms, key=lambda g: g.area)

        # Clean degenerate spikes/tendrils from the buffer computation
        if not _casino.is_empty:
            _casino = _casino.buffer(0)
            if _casino.geom_type == "MultiPolygon":
                _casino = max(_casino.geoms, key=lambda g: g.area)

        if not _casino.is_empty and _casino.geom_type == "Polygon":
            _casino_polygon = [[round(x, 2), round(y, 2)]
                               for x, y in list(_casino.exterior.coords)[:-1]]
            xs = [p[0] for p in _casino_polygon]
            ys = [p[1] for p in _casino_polygon]
            print(f"  north_oaks_casino      {len(_casino_polygon):3d} pts  "
                  f"X [{min(xs):8.0f}, {max(xs):8.0f}]  "
                  f"Y [{min(ys):8.0f}, {max(ys):8.0f}]")

            # Inject into Westbrook as an optional, non-canonical subdistrict
            for _dist in output["districts"]:
                if _dist["id"] == "westbrook":
                    _dist["subdistricts"].append({
                        "id": "north_oaks_casino",
                        "name": "North Oaks Casino",
                        "trigger": None,
                        "canonical": False,
                        "note": (
                            "Cut content — never released in the base game. "
                            "Part of a community restoration mod led by Kao. "
                            "Polygon computed from the void between North Oak, "
                            "Red Peaks, and Rocky Ridge via triple-buffer intersection."
                        ),
                        "polygon": _casino_polygon,
                    })
                    break
        else:
            print("  WARNING: Could not compute North Oaks Casino polygon")
    else:
        print("  WARNING: Missing required district polygons for casino computation")

    # ── Write output ──────────────────────────────────────────────────────
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"\nWritten {OUTPUT_PATH}")
    total_districts = len(output["districts"])
    total_subs = sum(len(d["subdistricts"]) for d in output["districts"])
    print(f"  {total_districts} districts, {total_subs} sub-districts")


if __name__ == "__main__":
    main()
