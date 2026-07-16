# Adding Mods to the Map

> **Looking for the easiest way to add your mod?** Use [NCZoning Auto-Discovery](nczoning-auto-discovery.md): tag your mod on Nexus and paste a metadata block into your description. No GitHub required.
>
> This guide covers the GitHub issue and manual PR methods for permanent, manually curated entries.

## mods.json Schema

Each mod entry is stored in its own file in `data/locations/<UUID>.json`. The schema for a mod object is:

```json
{
    "id": "7e846694-63b3-4c92-8c3f-beea64344457",
    "name": "Human Readable Mod Name",
    "authors": ["AuthorName", "CoAuthor"],
    "coordinates": [CET_X, CET_Y, CET_Z],
    "nexus_id": "12345",
    "category": "apartment",
    "tags": ["apartment", "neokitsch"],
    "description": "Brief description of what the mod does (max 500 chars).",
    "yaw": 180.0
}
```

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | UUID v4 (**auto-generated**, do not set manually) |
| `name` | string | Min 3 characters |
| `authors` | array[string] | Array of modding aliases |
| `coordinates` | [number, number, number] | `[CET_X, CET_Y, CET_Z]`, in-game coordinates from CET (X=east/west, Y=north/south, Z=height) |
| `yaw` | number | (Optional) Player facing direction in degrees from CET |
| `nexus_id` | string | Numeric Nexus ID (Used to automatically fetch thumbnails/images via API), or "WIP" / "Dummy" |
| `category` | string | `location-overhaul`, `new-location`, or `other` |
| `tags` | array[string] | Tags from `data/tags.json` (see [Tag Registry](tags.md) for the full list) |
| `description` | string | Max 500 characters |
| `credits` | string | (Optional) Team name or secondary acknowledgements |

### Important: Coordinate Order

Coordinates are stored as **`[X, Y, Z]`**, matching the order CET reports them. Z (height/elevation) is required for new submissions.

## Getting Your Coordinates

### Option 1: Cyber Engine Tweaks Console

1. Stand at the location you want to register
2. Open CET console (`~`)
3. Run:

   ```lua
   local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
   ```

4. Note the **X**, **Y**, **Z**, and **Yaw** values from the output

### Option 2: Simple Location Manager

Use [Simple Location Manager](https://www.nexusmods.com/cyberpunk2077/mods/26454) to save your location with a name, then read the X/Y coordinates from the saved entry.

See the [Coordinate System docs](coordinate-system.md) for more details and a pre-built calibration preset.

## Submission Methods

### Method 1: GitHub Issue Form (Recommended)

Best for modders who don't use Git:

1. Go to the [Issues tab](https://github.com/spuddeh/nc-zoning-board/issues)
2. Click **New Issue** → **"📍 Submit a New Mod Location"**
3. Fill in the form fields
4. Submit. The automated bot creates a PR (with `validate-json` running automatically)
5. A maintainer reviews and merges → **the issue closes automatically**, pin appears on the map

### Method 2: Manual Pull Request

Best for modders comfortable with Git:

1. Fork the repository
2. Create a new `<UUID>.json` file in `data/locations/`.
3. Fill in your data following the schema rules above.
4. Run validation locally: `node scripts/build_mods.js` then `npx ajv validate -s mods.schema.json -d mods.json`
5. Commit and open a PR

### Validation

All submissions are validated against `mods.schema.json` by a GitHub Actions workflow. PRs that fail validation will be flagged automatically.
