"""
Scan exported .streamingsector.json files for district/location boundary data.

Looks for node types relevant to district boundaries:
  - worldLocationAreaNode
  - worldAreaShapeNode
  - worldTriggerAreaNode
  - AreaShapeOutline

Reports a summary of what's found and dumps any location/district nodes with
their coordinates to a results file for inspection.

Usage:
  python scan_streaming_sectors.py [sectors_dir]

Default sectors_dir:
  D:\\Modding\\CP2077 Mods\\MyMods\\map_data_export\\source\\raw\\base\\worlds\\03_night_city\\sectors
"""
import json
import os
import sys
from collections import defaultdict

SECTORS_DIR = (
    sys.argv[1] if len(sys.argv) > 1
    else r"D:\Modding\CP2077 Mods\MyMods\map_data_export\source\raw\base\worlds\03_night_city\_compiled\default"
)

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(SCRIPT_DIR, "output", "sector_scan_results.json")

# Node types we care about
TARGET_TYPES = {
    "worldLocationAreaNode",
    "worldAreaShapeNode",
    "worldTriggerAreaNode",
    "worldLocationAreaNodeInstance",
}

# Fields that might carry a location/district name
NAME_FIELDS = {"locationName", "LocationName", "debugName", "DebugName", "name", "Name"}


def find_json_files(root):
    for dirpath, _, filenames in os.walk(root):
        for fname in filenames:
            if fname.endswith(".streamingsector.json"):
                yield os.path.join(dirpath, fname)


def extract_points(obj):
    """Recursively find any AreaShapeOutline with Points arrays."""
    results = []
    if isinstance(obj, dict):
        if obj.get("$type") == "AreaShapeOutline" and "Points" in obj:
            results.append(obj["Points"])
        for v in obj.values():
            results.extend(extract_points(v))
    elif isinstance(obj, list):
        for item in obj:
            results.extend(extract_points(item))
    return results


def scan_file(path):
    """Return list of hit nodes from one sector file."""
    hits = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        return hits, str(e)

    def walk(obj):
        if isinstance(obj, dict):
            t = obj.get("$type", "")
            if t in TARGET_TYPES:
                hit = {"$type": t, "_source_file": os.path.basename(path)}
                # Grab any name-like field
                for field in NAME_FIELDS:
                    if field in obj:
                        hit["_name"] = obj[field]
                        break
                # Grab outline/points if present
                points = extract_points(obj)
                if points:
                    hit["_points"] = points
                # For worldLocationAreaNode dump the full node so we can inspect it
                if t == "worldLocationAreaNode":
                    hit["_raw"] = obj
                hits.append(hit)
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for item in obj:
                walk(item)

    walk(data)
    return hits, None


def main():
    print(f"Scanning: {SECTORS_DIR}")
    files = list(find_json_files(SECTORS_DIR))
    print(f"Found {len(files)} .streamingsector.json files\n")

    if not files:
        print("No files found. Check the sectors directory path.")
        return

    type_counts  = defaultdict(int)
    named_hits   = []   # nodes that have a recognisable name field
    errors       = []
    files_with_hits = 0

    for i, path in enumerate(files):
        if (i + 1) % 100 == 0:
            print(f"  {i + 1}/{len(files)} files scanned...")

        hits, err = scan_file(path)
        if err:
            errors.append({"file": path, "error": err})
            continue
        if hits:
            files_with_hits += 1
        for h in hits:
            type_counts[h["$type"]] += 1
            if "_name" in h:
                named_hits.append(h)

    print(f"\n=== RESULTS ===")
    print(f"Files scanned:       {len(files)}")
    print(f"Files with hits:     {files_with_hits}")
    print(f"Parse errors:        {len(errors)}")
    print(f"\nNode type counts:")
    for t, count in sorted(type_counts.items()):
        print(f"  {t:45s} {count}")

    print(f"\nNamed location nodes: {len(named_hits)}")
    for h in named_hits[:20]:
        name = h.get("_name", "?")
        t    = h["$type"]
        pts  = len(h.get("_points", []))
        print(f"  [{t}]  name={name}  point_arrays={pts}  file={h['_source_file']}")
    if len(named_hits) > 20:
        print(f"  ... and {len(named_hits) - 20} more (see output file)")

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "files_scanned":    len(files),
            "files_with_hits":  files_with_hits,
            "type_counts":      dict(type_counts),
            "named_hits":       named_hits,
            "errors":           errors[:50],
        }, f, indent=2)
    print(f"\nFull results written to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
