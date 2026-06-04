# NCZoning Auto-Discovery

The map can automatically discover and display your mod without a GitHub submission, by reading a structured metadata block from your Nexus mod description.

> **Results may take up to 10 minutes to appear on the map** after tagging your mod and adding the block.

---

## What the API Reads from Your Mod Page

When your mod is discovered, the map reads these fields from the Nexus V2 GraphQL API — no authentication required, all public data:

| Nexus field | Used as | Notes |
| --- | --- | --- |
| `modId` | Nexus mod ID / URL | Used to build `nexusmods.com/cyberpunk2077/mods/<id>` link |
| `name` | Mod display name | Shown in popup title and sidebar |
| `summary` | Popup description | Shown as the description text; truncated to 500 chars if longer |
| `description` | Metadata source | Full BBCode body — only used to extract the `[NCZoning]` block, then discarded |
| `uploader.name` | First author | Always prepended to the author list; additional authors come from `authors=` in the block |
| `thumbnailUrl` | Thumbnail image | Displayed in the popup and sidebar entry |
| `updatedAt` | Recently Updated badge | If within the last `NCZ.RECENTLY_UPDATED_DAYS` days, an `UPDATED` badge is shown on the pin popup, sidebar entry, and cluster flyout |

**Nothing else is read.** Tags, changelogs, version history, endorsements, file downloads, and all other mod fields are ignored.

---

## How It Works

When the map loads, it queries the Nexus Mods API for all Cyberpunk 2077 mods tagged with **NCZoning**. For each result it finds, it looks for a `[NCZoning]` metadata block inside the mod description. If a valid block is found, the mod is automatically added to the map as a live pin — no GitHub account or pull request required.

Auto-discovered pins are identical to manually submitted ones, with a small amber **[ N ]** badge in the popup title and sidebar entry (tooltip: "Sourced automatically from Nexus Mods"). They are also automatically tagged with **nczoning**, which appears as a tag badge on their popup and can be used in the tag filter to show only auto-discovered mods. If the mod was updated on Nexus within the last `NCZ.RECENTLY_UPDATED_DAYS` days, an additional **UPDATED** badge is shown alongside the title.

---

## Step 1 — Tag Your Mod on Nexus

On your mod's Nexus page, go to **Tags** and add the tag: **NCZoning**

---

## Step 2 — Add the Metadata Block

Paste the following block into your mod description. The easiest way to generate it is to use the **[+] Submit** button on the map itself — it builds the block from a form and copies it to your clipboard.

### Block format

```
[code]
NCZoning:
coords=X,Y,Z
category=new-location
yaw=180.0
tags=apartment,kitsch
credits=Optional attribution line
authors=SecondAuthor,ThirdAuthor
[/code]
```

If you want to hide the block from casual readers, wrap it in a `[spoiler]` tag:

```
[spoiler]
[code]
NCZoning:
coords=X,Y,Z
category=new-location
yaw=180.0
[/code]
[/spoiler]
```

### Fields

| Field | Required | Format | Notes |
|---|---|---|---|
| `coords` | Yes | `X,Y,Z` | CET float values (X=east/west, Y=north/south, Z=height/elevation) — see [Getting Coordinates](#getting-coordinates) |
| `category` | Yes | enum | `location-overhaul`, `new-location`, or `other` |
| `yaw` | No | degrees | Player facing direction in degrees from CET output |
| `tags` | No | comma-separated | Must match tags from the [Tag Registry](tags.md) — unknown tags are silently ignored |
| `credits` | No | free text | Optional — team name or secondary acknowledgments |
| `authors` | No | comma-separated names | Additional authors beyond the Nexus uploader |

The Nexus uploader is always included as the first author automatically. Use `authors=` only for co-authors.

### Parsing rules

- The parser finds the `NCZoning:` marker (it can sit inline — even glued to the end of a sentence) and reads the `key=value` lines that follow it; if `NCZoning:` also appears in your prose, the real block is still found as long as its `coords`/`category` are valid
- `coords` and `category` are required — mods missing either are skipped entirely
- `coords` accepts either 2 values (`X,Y` — legacy format) or 3 values (`X,Y,Z` — new format). For new submissions, Z is required
- `tags` that don't exist in the tag registry are silently dropped (the mod still appears)
- All BBCode formatting is stripped before parsing, so the block still works if it loses its `[code]` wrapper or picks up stray styling (`[spoiler]`, `[size]`, `[font]`, `[color]`) — e.g. from a copy-paste round-trip. The `[code]` wrapper is still recommended for readability; the generator emits it

### Transition Note

The old `coords=X,Y` format (2 values) remains valid for existing mod descriptions during the transition period. If you update your description, we recommend upgrading to the new `coords=X,Y,Z` format. Z is the height/elevation coordinate from CET.

---

## Getting Coordinates

1. Stand at the location in-game
2. Open the CET console (`~`)
3. Run: `local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))`
4. Use the **X**, **Y**, **Z**, and **Yaw** values from the output — do not swap X and Y

See [Coordinate System](coordinate-system.md) for more detail and alternative tools like Simple Location Manager.

---

## Editing Your Entry

To update your mod's map data, edit the `[NCZoning]` block in your Nexus description and save. The map fetches live on every page load — your changes will be reflected within a few minutes.

There is no "Suggest Edit" button for auto-discovered mods. All edits go through the Nexus description directly.

If you want to update your **mod name**, **summary**, or **thumbnail**, those also come from Nexus and will update automatically.

---

## Removing Your Entry

To remove your mod from the map:

1. Remove the `[NCZoning]` block from your Nexus description, **or**
2. Remove the **NCZoning** tag from your mod on Nexus

Either action will cause the mod to be skipped on the next page load. There is nothing to delete from the repository — auto-discovered entries are never committed.

---

## Conflict Resolution

If a mod has both an auto-discovered entry (via this system) and a manually submitted entry (via GitHub), the **manual entry always wins** for mod data (name, authors, coordinates, description, category, tags).

However, the auto-discovery response's image and timestamp metadata (`thumbnailUrl`, `pictureUrl`, `updatedAt`) is preserved and applied to the manual entry. This means a manually registered mod that is also tagged NCZoning will still receive its thumbnail and recently-updated badge from Nexus without needing a separate API call.

This means maintainers can always override an auto-discovered pin with a corrected manual submission without any extra steps.

---

## Limitations

- The **Suggest Edit** button is not shown for auto-discovered mods — to correct the data, update the `[NCZoning]` block in your Nexus description directly
- Auto-discovered pins are not stored in the repository — they are fetched fresh on every page load
- Description text shown in the popup comes from your Nexus mod **summary** field (max 500 characters), not the `[NCZoning]` block
- The `nczoning` tag is applied automatically and is not part of `data/tags.json` — it cannot be added to manually submitted entries

---

## Misuse Policy

The **NCZoning** tag is provided by the Nexus Mods team specifically for this system. Maintainers reserve the right to request removal of the tag from mods that misuse it — including mods using the tag with incorrect or misleading coordinates, mods unrelated to Cyberpunk 2077 location content, or any use intended to spam or pollute the map.

---

## Exclusion List (maintainers)

Some mods carry the **NCZoning** tag but should not appear on the map — a mistaken tag, or a mod the maintainers judge too minor to register. These can't be handled by a manual entry (we don't *want* them on the map), and a tag we don't control can't simply be removed, so they are listed in `data/excluded_mods.json`:

```json
{
  "29860": "Ripperdoc Sogo Interior Changes — minor mod, tagged without a block; kept off the map."
}
```

The format is a flat `{ "nexusId": "reason" }` object (same shape as `data/tags.json`). The `reason` is a maintainer note only — it is never shown to users.

An excluded id is honoured in two places:

1. **Auto-discovery (`services.js`)** — the mod is never rendered as a pin, *even if its block parses correctly*. This is what stops a mistakenly-tagged mod that happens to have valid coordinates from showing up.
2. **Health monitor (`scripts/monitor_auto_discovery.js`)** — the mod is skipped, so the daily Discord alert stops flagging it. Without this, an intentionally-excluded mod with no block would be reported every single day.

To exclude a mod, add its Nexus id and a short reason to `data/excluded_mods.json` and open a PR. To re-include it later, delete the entry.

---

## Using the BBCode Generator

The map includes a built-in generator to make adding the block easier. Click **[+] Submit** in the map header (or the **Submit a New Mod Location** button in the sidebar) to open the generator. The modal walks you through four steps:

1. **Acquire Coordinates** — get your CET X/Y values in-game
2. **Configure Metadata** — fill out the form (category, tags, credits, authors) and click **Generate Block**
3. **Tag Your Mod** — add the `NCZoning` tag on your Nexus mod page
4. **Deploy Block** — copy the output and paste it into your Nexus mod description

The block can be placed anywhere in your description. A common spot is at the bottom. Use the **spoiler wrap** option to keep it hidden from casual readers.
