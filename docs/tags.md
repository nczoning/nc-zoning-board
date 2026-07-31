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

> **The tag registry lives in D1 and is served at `/v1/tags`.** It is edited in the
> dashboard, and a mistyped tag is refused on write rather than caught in CI
> afterwards. `data/tags.json` survives only as the site's fallback if the API is
> unreachable, and as the file `scripts/validate_tags.js` checks `mods.json`
> against while `mods.json` is still built. Both retire at Phase 6.

---

## Synthetic Tags

Synthetic tags are applied automatically by the map system. They are **not** rows
in the `tags` registry, cannot be manually assigned, and will not pass validation
if submitted on a location.

| Tag | Applied by | Description |
| --- | --- | --- |
| `nczoning` | Auto-discovery (server-side, `worker/src/nexus.js`) | Applied to every mod sourced automatically from Nexus Mods. Appears as a filter tag and as a badge on the popup and sidebar entry. |
| `updated` | `app.js` filter setup | A virtual filter that surfaces any recently updated mod, matched via `isRecentlyUpdated()`, which reads the API's server-computed `recently_updated` bool (or, for an older API deploy that omits the bool, computes from `updatedAt` vs the recency window). Not a stored tag. |

---

## Adding a Tag

Tags are registry data in D1, edited in the dashboard. There are no files to
change and no deploy to wait for.

1. Sign in to [/admin/](https://nczoning.net/admin/) and open the **Tags** tab.
2. Add the tag: a **slug** (the identifier, e.g. `entropism`), an optional
   **display name**, a **description**, and a **sort order**.

The description is the authoritative definition and is used as tooltip text on
the live map. If the display name is left empty it falls back to the slug, which
is how every tag currently renders.

The sidebar filter UI in `app.js` is fully data-driven: the new tag appears once
any location uses it. No frontend change is needed.

---

## Modifying a Tag

**Editing the display name or the description is safe.** Neither is an
identifier, so nothing else has to move. This is the normal way to relabel a
tag: set the display name to `Neo-Militarism` and the slug stays
`neomilitarism`.

Splitting the two is the point of having both. Before the D1 move there was no
display label at all, so the identifier *was* the label and relabelling meant
renaming the key.

---

## Renaming a Tag Slug

Renaming the slug re-points every location carrying it, so the dashboard puts it
behind an explicit unlock rather than treating it as ordinary editing.

`location_tags.tag_slug` is declared `ON UPDATE CASCADE`, so one update
propagates to every record. That makes it safe for the data and still a
link-breaking event, which is why it is deliberate rather than routine. Reach for
it only to fix a genuine mistake such as a typo in the identifier. For anything
else, edit the display name.

---

## Removing a Tag

1. Open the **Tags** tab and delete the tag.
2. **A tag still attached to locations cannot be deleted.** The refusal is a
   `409` naming the usage count and the records using it, so the next step is
   obvious. Clear the tag from those locations first, then delete it.

The refusal is deliberate: neither a cascade that silently strips a tag from
every record on one click, nor a bare delete failing on a foreign key with an
opaque error, is a good answer.

The tag disappears from the sidebar filter on the next dataset refresh.
