# Adding Mods to the Map

> **Submit from the map**, at [nczoning.net](https://nczoning.net). No GitHub
> account and no Git. This guide covers the coordinates you need and what each
> field means; the [Submission Pipeline](submission-pipeline.md) covers what
> happens after you press Submit.

## The Location Record

Every location is a row in the D1 registry. These are the fields you fill in when
you submit, and what each one means:

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

## How to Submit

1. Open [nczoning.net](https://nczoning.net) and press **[+] Submit**.
2. **Pick your mod.** Tagged mods appear in a picker with their name, description
   and uploader prefilled. If yours is not listed, paste its Nexus link.
3. Fill in the coordinates and the rest of the fields above.
4. Send it. A reviewer approves or rejects it, and an approved submission puts
   your pin on the map within seconds.

Coordinates are checked as you type, and every problem in a row is named at once
beside the field it belongs to.

### Correcting an existing pin

Open the pin's popup and press **Suggest a fix**. The form arrives filled in from
the record and sends only the fields you change, so a reviewer sees exactly what
moved. One choice inside the same form switches to requesting removal, which asks
for a reason instead.

### Validation

The Worker validates every write against the same rules on the way in, so a bad
value is refused at submission rather than caught later. There is no PR to fail.

> **Retired at 2.0.0:** the GitHub issue forms and the manual pull request. Both
> wrote locations into git, and the registry lives in D1 now, so neither could
> reach the map.
