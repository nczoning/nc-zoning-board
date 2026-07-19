# Tag Registry

Tags are used to describe the aesthetic, function, or intended audience of a location mod. They appear as filterable badges on the map and as checkboxes in the submission issue form.

---

## Current Tags

| Tag | Description |
| --- | --- |
| `apartment` | A player housing unit, usually a smaller dwelling within a megabuilding or high-rise. |
| `corpo` | High-end corporate architecture, slick aesthetics, and security-focused areas. |
| `entertainment` | Bars, clubs, casinos, and nightlife venues. |
| `entropism` | The look of poverty that derives from humans grappling with and struggling against technology and its unforgiving advance. |
| `house` | A standalone player dwelling or safehouse structure. |
| `infrastructure` | Roads, bridges, parking structures, and public works. |
| `kitsch` | Flashy, bold and usually cheap: the look of a long lost golden age. |
| `neokitsch` | Synonymous with luxury and infinite wealth. |
| `neomilitarism` | Cold, sharp, and modern: making everyone look ready for combat. |
| `nomad` | Off-the-grid, scrapyard, desert, or vehicular-based habitats. |
| `photos` | Scenic or atmospheric locations well-suited for virtual photography. |
| `quest` | A location closely tied to custom gigs, missions, or storylines. |
| `shop` | A retail location to purchase weapons, clothing, items, etc. |
| `streetkid` | Environments resonating with gang culture, neon lights, and urban survival. |

> The tag registry is the source of truth: `data/tags.json`. Entries in `mods.json` are validated against it at build time by `scripts/validate_tags.js`.

---

## Synthetic Tags

Synthetic tags are applied automatically by the map system. They are **not** in `data/tags.json`, cannot be manually assigned, and will not pass schema validation if added to a location file.

| Tag | Applied by | Description |
| --- | --- | --- |
| `nczoning` | Auto-discovery (server-side, `worker/src/nexus.js`) | Applied to every mod sourced automatically from Nexus Mods. Appears as a filter tag and as a badge on the popup and sidebar entry. |
| `updated` | `app.js` filter setup | A virtual filter that surfaces any recently updated mod, matched via `isRecentlyUpdated()`, which reads the API's server-computed `recently_updated` bool (or, for an older API deploy that omits the bool, computes from `updatedAt` vs the recency window). Not a stored tag. |

---

## Adding a Tag

1. **`data/tags.json`**: Add the new key and a concise definition sentence.

2. **`.github/ISSUE_TEMPLATE/mod_submission.yml`**: Add a checkbox entry under the `tags` checkboxes field, in alphabetical order:
   ```yaml
   - label: "your-tag — Short description matching the one in tags.json"
   ```

3. **`.github/ISSUE_TEMPLATE/modify_location.yml`**: Add the same checkbox entry in the same alphabetical position.

The sidebar filter UI in `app.js` is fully data-driven: the new tag will appear automatically once any mod uses it. No frontend changes are needed.

---

## Modifying a Tag Description

If you only need to update the wording of an existing tag's description (not rename the key):

1. **`data/tags.json`**: Update the definition string for the key.
2. **`.github/ISSUE_TEMPLATE/mod_submission.yml`**: Update the matching checkbox label text.
3. **`.github/ISSUE_TEMPLATE/modify_location.yml`**: Update the matching checkbox label text.

> The label text shown in the issue form (after ` — `) is cosmetic only. The authoritative definition lives in `tags.json` and is used as tooltip text on the live map.

---

## Renaming a Tag Key

Renaming a tag key (e.g. `photos` → `photography`) is a **breaking change**: it invalidates any existing location data that uses the old key.

1. **Audit existing data**: find all locations using the old key:
   ```bash
   grep -rl '"old-tag"' data/locations/
   ```
2. **Update each affected location file**: replace the old key with the new key in the `tags` array.
3. Follow the [Adding a Tag](#adding-a-tag) steps for the new key.
4. Follow the [Removing a Tag](#removing-a-tag) steps for the old key.

---

## Removing a Tag

1. **Audit existing data**: confirm no location files use the tag (see command above). If any do, update or remove the tag from those files first.
2. **`data/tags.json`**: Delete the key.
3. **`.github/ISSUE_TEMPLATE/mod_submission.yml`**: Remove the checkbox entry.
4. **`.github/ISSUE_TEMPLATE/modify_location.yml`**: Remove the checkbox entry.

The tag will disappear from the sidebar filter automatically on next deploy.
