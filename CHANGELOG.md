# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Auto-discovery health monitor**: scheduled GitHub Action runs the real `parseNcZoningBlock()` against all live NCZoning-tagged Nexus mods daily and posts a Discord alert listing any that are missing from the map — split into "malformed block" (author fix needed) vs "tagged, no block". Catches silent parse failures within a day instead of when an author complains.

## [0.3.4] - 2026-05-16

### Fixed

- **Auto-discovery — resilient BBCode parsing**: `parseNcZoningBlock()` now strips all BBCode tags and token-anchors the `NCZoning:` sentinel (anywhere in the description, every occurrence) instead of requiring an intact `[code]…[/code]` wrapper. Blocks that lost their `[code]` tags, picked up stray `[spoiler]`/`[size]`/`[font]`/`[color]` styling, or were pasted glued inline to prose (e.g. from a copy-paste round-trip) now parse correctly.

## [0.3.3] - 2026-05-04

### Fixed

- **Thumbnails — chunked `modsByUid` fetch**: Large single `modsByUid` requests (~250 UIDs) were silently truncated by the Nexus V2 API, so some manual-mod pins loaded without thumbnails until a later reload "self-healed" it. Now chunked into 50-UID parallel batches (`NEXUS_BATCH_SIZE`) with a one-shot retry of dropped UIDs; short chunks log the missing UIDs to tell flakiness apart from stale `nexus_id`s.

## [0.3.2] - 2026-04-09

### 16k WebP Tile Layer

- **16k WebP tiles**: Upgraded satellite base layer from the single-image WebP overlay (9.6 MB blocking download) to 16k WebP tiles (zoom 0–6, 5,461 tiles). Generated directly from the lossless 16k PNG source at quality 90, effort 6. Max-zoom upscaling reduced from 8× to 4× for significantly sharper detail. Progressive tile loading eliminates the first-paint latency on GitHub Pages.

## [0.3.1] - 2026-04-09

### Coordinate Transform and Satellite Map

- **Coordinate accuracy**: Replaced the 16-point in-game survey calibration with a mathematically exact transform derived from the [Realistic Map 8k mod](https://www.nexusmods.com/cyberpunk2077/mods/17811) terrain quad UV mapping. The old calibration had up to ~2 Leaflet unit (~16px at max zoom) drift at map edges; the new transform is exact by construction. Pin positions shift by up to ~0.25 units near the map centre and ~2 units at the far edges — visually imperceptible for most pins.
  - Added `NCZ.WORLD_MIN_X/MAX_X/MIN_Y/MAX_Y` as named constants (single source of truth for world extent)
  - `cetToLeaflet()` and `leafletDistanceMeters()` both derive from these constants — scale indicator accuracy improved automatically
- **Satellite base layer**: Replaced the tile pyramid (`assets/tiles/{z}/{x}/{y}.png`, 256×256 tiles at zoom 0–5) with a single 9.6 MB WebP image overlay (`assets/img/satellite_8k.webp`). Eliminates tile-loading seams, simplifies serving, and leverages WebP compression for a smaller total payload.

## [0.3.0] - 2026-04-06

### Coordinate Expansion — Z and Yaw

- **Data schema**:
  - `coordinates` extended from `[X, Y]` to `[X, Y, Z]` — Z (height/elevation) is now required for new submissions; existing `[X, Y]` entries remain valid
  - Optional `yaw` top-level field added — player facing direction in degrees from CET
- **BBCode Generator modal**:
  - Added **Z Coordinate** input (required) and **Yaw** input (optional, above Category)
  - Canonical CET command displayed in a styled code block with a copy icon button
  - Generated block now outputs `coords=X,Y,Z` with optional `yaw=` line directly below coords
  - New `copy.svg` icon (Feather-style stroke, works with CSS `mask-image`)
- **Auto-discovery (Nexus BBCode)**:
  - `parseNcZoningBlock()` accepts both `coords=X,Y` (legacy, remains valid) and `coords=X,Y,Z`; parses optional `yaw=` field
  - `yaw` is now included in auto-discovered mod objects when present in the Nexus description
- **GitHub issue forms**:
  - Submission form: added required **Z Coordinate** and optional **Yaw** fields
  - Modify form: added required **Z Coordinate** (pre-filled from deep link) and optional **Yaw**; X/Y/Z marked `required: true`
  - Both forms: updated to canonical CET command; added SLM **Print Coordinates** button reference
- **GitHub workflows**: `auto-pr-submission` and `modify-location-submission` parse and write Z and Yaw; modify workflow preserves existing values when fields are blank
- **Documentation**: removed all "ignore Z" guidance; updated `coordinate-system.md`, `adding-mods.md`, `nczoning-auto-discovery.md`; legacy `coords=X,Y` Nexus blocks remain valid during transition
- **Canonical CET command** (replaces `print(GetPlayer():GetWorldPosition())`):

  ```lua
  local p,r = GetPlayer():GetWorldPosition(), GetPlayer():GetWorldOrientation():ToEulerAngles(); print(string.format("x=%.4f  y=%.4f  z=%.4f  yaw=%.4f", p.x, p.y, p.z, r.yaw))
  ```

## [0.2.0] - 2026-04-02

### Deep-link Sharing

- **UI**:
  - **Copy Link button** — each mod popup now includes a "Copy Link" button (chain icon) that copies a shareable URL to the clipboard (e.g. `https://nczoning.net?mod=13821`) with 2-second "Copied!" feedback
  - **Deep-link support** — URLs with `?mod=<id>` parameter now automatically open and focus the matching pin on page load. Uses numeric `nexus_id` for Nexus mods; falls back to UUID for WIP/Dummy entries
  - **URL sync** — the browser address bar updates to reflect the current open pin (`?mod=` parameter), allowing users to share the map URL directly from their browser
- **Icons**:
  - Added `link.svg` — new Feather-style chain-link icon for the Copy Link button
- **Constants**:
  - `NCZ.SITE_URL` — canonical site URL for deep-link generation
  - `NCZ.URL_PARAM_MOD` — configurable URL parameter name (defaults to `"mod"`)

## [0.1.0] - 2026-03-28

### 2026-03-27

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Ko-Fi donation link** — "Buy us a coffee" link added to the sidebar footer and about modal, pointing to [ko-fi.com/nczoning](https://ko-fi.com/nczoning). Rendered with the Ko-Fi logo as an inline image.
  - **Discover button repositioned** — the "Discover a location" button is now anchored to the bottom-left of the map container. On desktop it dynamically offsets its `left` position by the sidebar's current pixel width when the sidebar is visible, and resets when the sidebar is hidden. Position updates on sidebar open/close and window resize.
  - **Cluster pin contrast** — cluster count badges now use bold white text with a text-shadow and a larger solid background area, improving legibility against varied map tile backgrounds.
- **UI**:
  - **Sidebar sort by last updated** — the mod list and cluster panel now sort by Nexus `updatedAt` descending (most recently updated first) instead of alphabetically. Mods with no Nexus timestamp (WIP/Dummy) fall to the end and sort alphabetically among themselves. Prevents gaming the list order by prefixing mod names with special characters.
- **Utils**:
  - `NCZ.sortModsByUpdated` added to `utils.js` — a comparator function `(a, b) => number` for use with `Array.sort()`. Orders by `_updatedAt` descending with alphabetical fallback for untimestamped mods.
- **Bug fixes**:
  - Fixed `_updatedAt` backfill for manual Nexus mods running inside the `.forEach()` body after `.sort()` had already completed. The backfill is now hoisted before the sort, so manual mods sort with their correct timestamps.
  - Fixed auto-discovery silently discarding `updatedAt`, `thumbnailUrl`, and `pictureUrl` for manually registered mods that are also tagged NCZoning. That metadata is now collected into a separate map and merged into `nexusThumbs`, so NCZoning-tagged manual mods receive their timestamps and images from the auto-discovery response. These mods are also excluded from the `modsByUid` batch, reducing its size.

### 2026-03-23

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Map scale indicator** — a Leaflet scale bar is displayed bottom-right (metric only). The scale is calibrated to in-game distances by overriding `L.CRS.Simple`'s `distance()` method with the inverse CET coordinate transform.
  - **"Discover a location" button** — new header button picks a random visible (post-filter) marker and zooms to it, opening its popup. Hides the sidebar on mobile when triggered.
  - **Focused pin persistence** — when the active popup's marker gets clustered on zoom-out, the cluster auto-spiderfies to keep the popup visible. Focus clears on manual close or when the marker is filtered out.
  - **Header button polish** — `#about-btn`, `#parameters-btn`, and `#bbcode-btn` now share a `.header-action-btn` base class with inline SVG icons and bold text. Submit button uses `.header-action-btn-tertiary` for the amber colour variant.
  - **Map pannable bounds** — `maxBounds` now extends 50% of the viewport past each edge so pins near the border can be panned to centre. Bounds recalculate on zoom and resize.
  - **Filter clear buttons** — "Clear all" buttons in the Tag and Author filter sections, visible only when filters are active.
  - **Active filter counts** — section headers show `(N)` beside "Filter by Tags" and "Author Filters" when filters are selected.
  - **Search clear button** — an × button inside the search input clears it; pressing Escape also clears the field.
  - **Popup height fix** — `positionDynamicPopup` now measures the full `.custom-popup-header.has-image` element (previously `.popup-thumb` only) for accurate arrow placement.
- **Constants**:
  - CET→Leaflet transform coefficients extracted to named constants (`NCZ.CET_TO_LEAFLET_X_SCALE`, `NCZ.CET_TO_LEAFLET_Y_SCALE`, `NCZ.CET_TO_LEAFLET_X_OFFSET`, `NCZ.CET_TO_LEAFLET_Y_OFFSET`, `NCZ.CET_UNITS_PER_METER`).
  - Added `NCZ.UPDATED_LABEL` (`"RECENTLY UPDATED"`) — corrected badge text from `UPDATED`, applied across popup, sidebar, cluster panel, and filter tag.
- **Utils**:
  - Added `NCZ.leafletDistanceMeters()` — converts a Leaflet lat/lng pair to in-game meters using the inverse CET transform.

### 2026-03-22

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Popup redesign** — mod popups have been fully restyled:
    - Category-coloured border gradient: the popup frame fades from the category colour at the image/title boundary to the base secondary colour below.
    - Category badge floated top-left outside the frame; RECENTLY UPDATED badge floated top-right.
    - Thumbnail now `object-fit: contain` inside a max-height container — fills popup width without cropping.
    - Title accent underline and glow text-shadow both driven by `--popup-title-accent` (set to the category colour).
    - Tags moved below description with a dark background band.
    - Credits names individually coloured in amber via `.custom-popup-credit-name`.
    - Nexus link is flex-grow; Edit button is flex-shrink-0.
    - Popup `className` now includes `popup-cat-{category}` for per-category CSS targeting.

### 2026-03-21

- **UI**:
  - **Recently Updated badge** — mods updated on Nexus within the last 7 days now display an `UPDATED` badge in the popup title, sidebar entry, and cluster flyout panel. Tooltip reads "Updated on Nexus within the last N days" (N driven by `NCZ.RECENTLY_UPDATED_DAYS` constant).
  - **"updated" filter tag** — a synthetic `updated` filter tag is prepended to the sidebar tag list (before `nczoning`) whenever at least one recently updated mod is present. Selecting it shows only recently updated mods.
  - **Welcome modal disclaimer** — replaced the updated-badge explanation with a clear disclaimer that this map is a visibility tool, not a reservation system. Mod authors retain full creative freedom over any location.
- **API**:
  - `updatedAt` is now fetched in both the `modsByUid` (manual mods) and `NCZoningMods` (auto-discovery) GraphQL queries.
  - Manual mods receive `updatedAt` from the thumbnail fetch; auto-discovered mods receive it from the discovery query.
- **Constants**:
  - Added `NCZ.RECENTLY_UPDATED_DAYS` — controls the badge and filter threshold (default: 7 days).

### 2026-03-15 (refactor & CI)

- **Refactor**:
  - Split monolithic `app.js` (~1500 lines) into four focused modules using a `window.NCZ` global namespace (no bundler, no ES modules — loaded via ordered `<script>` tags):
    - `constants.js` — all shared config values, category styles, API endpoints, cache keys, UI sizing
    - `utils.js` — pure utility functions: `escapeHtml`, coordinate transform, localStorage cache helpers, tooltip/popup positioning algorithm, BBCode block parser
    - `services.js` — Nexus V2 GraphQL API functions: thumbnail fetch, auto-discovery, new `NCZ.fetchModData()` which fetches `mods.json` and `tags.json` in parallel
    - `app.js` — DOM logic, map init, sidebar filtering, cluster panel, modals, image gallery
  - Added `NCZ.DATA_MODS_PATH` and `NCZ.DATA_TAGS_PATH` constants for data file paths (contributed by [@Akiway](https://github.com/Akiway))
- **CI**:
  - Fixed `validate-json` required status check blocking all non-data PRs — the workflow now always runs on every PR and reports a status immediately. Validation steps (build, schema check, tag check) are gated behind a `git diff` check and only execute when `data/locations/`, `data/tags.json`, or `mods.schema.json` are modified.
- **Docs**:
  - Updated `docs/architecture.md` — new file structure tree, added JavaScript Architecture section with module table, updated component section headers, added CSS nesting note.
  - Updated `docs/submission-pipeline.md` — Stage 4 now describes the change-detection step.
  - Updated `docs/coordinate-system.md` — `cetToLeaflet` reference updated to `utils.js`.

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Cluster menu panel** — clicking a cluster now opens a resizable side panel listing all mods within that cluster, with thumbnails, tags, descriptions, and category-coloured headers. Clicking a mod in the panel zooms to its pin and opens its popup. Panel width is draggable and persisted in localStorage. On mobile, the panel uses a fixed width and hides the resize handle. Replaces the previous hover-to-spiderfy interaction.
  - **Custom cluster thresholds** — cluster icon colours now use a 4-tier system (small/medium/large/xlarge at 0/10/25/50 mods) with a custom `iconCreateFunction`, replacing the default 0/10/100 thresholds. Added a radial gradient overlay for depth.
  - **Inlined MarkerCluster CSS** — removed the two external CDN stylesheet links for `MarkerCluster.css` and `MarkerCluster.Default.css`, replacing them with inlined styles in `style.css`. Eliminates external requests and CDN dependency.
  - **Marker tooltips** — hovering a map pin now shows a tooltip with the mod name. Tooltip uses smart directional placement (top/bottom/left/right) to stay within map bounds, with CSS arrows pointing back to the pin.
  - **Dynamic popup positioning** — popups now reposition dynamically to stay visible within the map container, with directional CSS arrows. Repositions on map move, zoom, and resize. Uses `requestAnimationFrame` coalescing for performance.
  - **Zoom button fix** — corrected vertical alignment of +/- icons in Leaflet zoom controls.
- **Docs**:
  - Updated `docs/architecture.md` — corrected colour palette to current `--nc-` CSS variables.
  - Updated `docs/branding.md` — fixed amber hex code to match actual CSS value (`#ffb300`).
  - Updated `docs/roadmap.md` — added cluster panel, tooltips, and dynamic popup positioning to completed features.

### 2026-03-14

- **UI**:
  - Replaced "show more / show less" toggles on Tag and Author filter sections with collapsible section headers — click the header to expand/collapse. Both sections are collapsed by default to remove perceived bias toward alphabetically-first entries.
  - Added close buttons (X) to the terminal header bar of all modals (Welcome, About, BBCode Generator) for improved usability.
  - Location count now updates dynamically when filters or search are applied, showing filtered/total format (e.g., `42/97`).
  - `nczoning` tag now sorts first in the tag filter list (before alphabetical tags).
  - Added amber warning note below coordinate inputs in the BBCode Generator modal reminding users to include the minus sign for negative coordinates.
  - Updated About modal description to neutral tone — removed "avoid overlapping builds" language.
- **Issue Templates**:
  - Rewrote mod submission template description to neutral tone — removed "to prevent overlaps" language that implied the tool gatekeeps or plays favourites.
  - Strengthened negative coordinate guidance in both X and Y coordinate fields with warning emoji and clearer instructions.
  - Changed X coordinate placeholder to show a negative example (`-500`).

### 2026-03-13 (BBCode modal)

- **UI**:
  - Added step-by-step instructions to the BBCode Generator modal (Acquire Coordinates, Configure Metadata, Tag Your Mod, Deploy Block) replacing the single warning line.
  - Added placement recommendations in the output section — suggests bottom of description as common spot, notes block can go anywhere, references spoiler wrap option.
  - Added link to full auto-discovery documentation from the modal.
  - Updated CET coordinate tooltip to use `print(GetPlayer():GetWorldPosition())`.

### 2026-03-13 (API optimization)

- **Performance**:
  - Eliminated duplicate image API calls — auto-discovered mods now carry their own `pictureUrl`/`thumbnailUrl` from the discovery query, so `fetchNexusThumbnails()` only fetches images for manual mods.
  - Added localStorage caching for Nexus API responses — auto-discovery results cached for 10 minutes, thumbnail data cached for 24 hours. Incremental fetches for new IDs not yet in cache.
  - Added 200ms debounce to sidebar search input to avoid excessive re-filtering on every keystroke.
  - Extracted magic numbers (`NEXUS_BATCH_SIZE`, `DESCRIPTION_MAX_LENGTH`, `SPIDERFY_DEBOUNCE_MS`, `COPY_FEEDBACK_MS`, `SEARCH_DEBOUNCE_MS`) into named constants.

### 2026-03-13 (security & hardening)

- **Security**:
  - Added `escapeHtml()` utility and applied to all user-supplied data in popup and sidebar HTML (`mod.name`, `mod.credits`, `mod.description`, authors, tag names/descriptions, URLs). Prevents XSS from Nexus API or submitted JSON.
  - Replaced inline `onclick` handler on popup thumbnails with a `data-full-src` attribute and delegated event listener.
  - Added `nexus_id` pattern validation (`^\d+|WIP|Dummy$`) to `mods.schema.json`.
  - Added coordinate range validation to the BBCode generator — rejects non-finite values and coordinates outside ±5000.
- **Bug Fixes**:
  - `build_mods.js` now exits with code 1 on any JSON parse error and detects duplicate IDs before writing output.
  - `deploy.yml` build step now uses `set -e` to propagate build failures.
  - `modify-location-submission.yml` now preserves existing coordinates when both coordinate fields are left blank (instead of failing with "Invalid coordinates").
  - Added `.catch()` to clipboard API call — shows "COPY FAILED" feedback instead of silently failing.
  - Removed stale `ripperdoc` tag from both issue templates and `docs/tags.md` (tag was removed from registry but references remained, causing validation failures).
- **Docs**:
  - Added Nexus V2 GraphQL API section to `CLAUDE.md` (endpoint, docs URL, query descriptions, caching strategy).
  - Added "What the API Reads from Your Mod Page" table to `docs/nczoning-auto-discovery.md`.
  - Standardized CET coordinate command to `print(GetPlayer():GetWorldPosition())` across all docs.
  - Added `npm run build` and `npm run validate` scripts to `package.json`.
  - Cleaned up `.gitignore` — removed dead `assets/images/raw maps/` pattern and duplicate `README.md` entry.

### 2026-03-13 (NCZoning auto-discovery)

- **Features**:
  - **NCZoning Auto-Discovery** — the map now queries the Nexus Mods V2 GraphQL API on page load for all Cyberpunk 2077 mods tagged with `NCZoning`. Mods with a valid `[NCZoning]` metadata block in their description are automatically added to the map as live pins — no GitHub submission required.
  - **BBCode Generator modal** — new `[+] SUBMIT` button in the header and sidebar opens a form that generates the `[code]NCZoning:...[/code]` metadata block. Includes CET coordinate inputs with a tooltip, category dropdown, tag checkboxes (populated from `tags.json`), credits, additional authors, an optional `[spoiler]` wrapper, a copy-to-clipboard button, and a reset button.
  - **Auto-discovered pin indicators** — auto-discovered mods display an amber `[ N ]` badge in the popup title and sidebar entry (tooltip: "Sourced automatically from Nexus Mods"). They also receive an automatic `nczoning` tag badge (with matching tooltip) visible in the popup, tag filter panel, and sidebar.
  - **Conflict resolution** — if a mod has both an auto-discovered entry and a manually submitted entry sharing the same `nexus_id`, the manual entry always wins.
  - **"Suggest Edit" suppressed** for auto-discovered mods — edits go through the Nexus description directly.
- **Bug Fixes**:
  - Fixed Nexus GraphQL filter sending `gameId` as a number — API requires a string (`"3333"`).
  - Fixed GraphQL query sending `uploader` as a scalar — corrected to `uploader { name }` (returns a `User` object).
  - Fixed BBCode block parsing failing on mod descriptions returned by the Nexus API with `<br />` HTML line breaks — parser now normalises these to `\n` before matching.
  - Fixed `applyFilters()` author lookup breaking when the `[ N ]` badge was added to the sidebar item name — authors are now stored in `li.dataset.authors` and read directly.
- **Docs**:
  - Added `docs/nczoning-auto-discovery.md` — full guide covering setup, BBCode format, field reference, editing, removal, conflict resolution, limitations, and misuse policy.
  - Updated `README.md` — NCZoning auto-discovery is now the preferred submission method; docs table updated.
  - Updated `CONTRIBUTING.md` — auto-discovery listed as preferred; GitHub issue listed as alternative; NCZoning guide added to useful docs list.
  - Updated `docs/adding-mods.md` — callout at top pointing to auto-discovery for mod authors who land there first.

### 2026-03-13

- **UI Improvements**:
  - Filter sections ("Filter by Tags", "Author Filters") now collapse to 2 rows by default with a "show more / show less" toggle. Sections with ≤2 rows of buttons hide the toggle automatically.
  - Sidebar location click now uses `flyTo` to the marker, then opens the popup after the animation completes. If the marker is inside a cluster, it spiderfies the cluster before opening the popup.
  - Map now calls `invalidateSize()` before `fitBounds` to ensure correct container dimensions on page load.
  - Popup `autoPan` disabled — the `maxBounds` constraint caused a visible snap-back; sidebar clicks handle positioning via `flyTo` instead.
- **Data**:
  - Removed `ripperdoc` tag from the tag registry.
- **Bug Fixes**:
  - Fixed workflow condition logic in `auto-pr-submission.yml` and `modify-location-submission.yml` — replaced `pull-request-created == 'true'` with `pull-request-operation != 'none'` to correctly detect PR creation/update using the v6 output. The old boolean output was unreliable and could cause both the "PR created" and "no changes" comments to fire simultaneously, or neither to fire.
  - Fixed missing mod thumbnails caused by the Nexus V2 GraphQL API silently capping `modsByUid` results at 20 — the query now passes an explicit `count` equal to the number of IDs requested, ensuring all thumbnails are fetched regardless of roster size.
- **Workflow Updates**:
  - `notify-discord-pr-status.yml` now automatically deletes the `add-mod-*` / `mod-mod-*` branch after a PR is closed (merged or not), keeping the repo branch list clean. Added `contents: write` permission to support this.
- **Maintenance**:
  - One-off deletion of 49 stale `add-mod-*` and `mod-mod-*` branches that had accumulated from previous workflow runs.
- **Docs**:
  - Updated mod submission and modification issue templates — added a coordinate guide (CET console and Simple Location Manager methods), a warning not to use World Builder coordinates, and a reminder to include the minus sign for negative values.

### 2026-03-12 (tags)

- **Data**:
  - Added new `photos` tag — scenic or atmospheric locations well-suited for virtual photography.
- **Docs**:
  - Created `docs/tags.md` — canonical reference for the tag registry, including the full tag list and step-by-step processes for adding, modifying, renaming, and removing tags.
  - Updated `CONTRIBUTING.md` — added link to `docs/tags.md` in the Useful Docs section.
  - Updated `docs/adding-mods.md` — tags field now links to the tag registry doc.

### 2026-03-12

- **Bug Fixes**:
  - Fixed `ReferenceError: path is not defined` in `auto-pr-submission.yml` that was crashing the workflow before the PR title output was set, causing new mod submissions to fail silently.
  - Fixed malformed SVG namespace (`http://www.w3.org/-2000/svg`) in sidebar footer icon.
  - Fixed incorrect CSS class `"collapsed"` applied to the sidebar on mobile when clicking a location — corrected to `"hidden"` to match the existing style contract.
  - Fixed author extraction in `auto-pr-submission.yml` — the `Author Alias(es)` label heading contains parentheses that broke the regex match, producing empty `authors` arrays in generated JSON files.
  - Fixed `_No response_` placeholder not being stripped from the `credits` field in `auto-pr-submission.yml` and `modify-location-submission.yml`.
  - Fixed `modify-location-submission.yml` overwriting an existing `credits` value with `"_No response_"` when credits were left blank on the form — a blank entry now correctly preserves the existing value.
- **GitHub Issue Form Improvements**:
  - Added `Category` dropdown to the modify/removal form (with "Keep existing" option to leave it unchanged).
  - Replaced the free-text `Tags` input on both the submission and modify forms with a `checkboxes` field listing all 14 valid tags with inline definitions — eliminates invalid tag submissions and removes the need to reference `tags.json`.
  - Made X/Y coordinates optional on the modify/removal form (removal requests no longer need to provide coordinates).
  - Moved the `Description` field to the last position on both forms.
  - Removed prefilled title prefixes (e.g. `[Mod Submission]:`) from all five issue templates — submitters must now write a meaningful title themselves.
- **Workflow Updates**:
  - Updated `auto-pr-submission.yml` and `modify-location-submission.yml` tag parsers to read the new checkbox format.
  - `modify-location-submission.yml` now extracts and applies category changes; defaults to "Keep existing" if unchanged.
  - Both submission workflows now trigger on `issues: labeled` only (replacing `opened`) — eliminates double-fire when a form auto-applies a label at creation, and allows maintainers to manually re-trigger by removing and re-adding the label.
  - `modify-location-submission.yml` Discord notifications now follow the same stored-ID pattern as the submission workflow: the initial "Awaiting Review" message ID is saved as a hidden comment on the issue so `notify-discord-pr-status.yml` can edit it on merge/close rather than post a new message.
  - `notify-discord-pr-status.yml` split into two jobs: `notify-submission` (edits the existing Discord message for `add-mod-*` PRs) and `notify-modification` (edits the existing Discord message for `mod-mod-*` PRs).
- **Labels**:
  - Created missing `mod-modification` label — its absence was silently preventing all modification/removal issue form submissions from triggering the automation workflow.
  - Created missing `feedback` label referenced by the General Feedback issue template.
- **UI**:
  - Restored the Join Discord link and SVG icon to the sidebar footer, beneath the Submit a Location button.

### [0.1.0-pre.1] - 2026-03-11

- **Nexus Mods API Integration**:
  - Successfully integrated the Nexus V2 GraphQL API.
  - Dynamically fetches official mod thumbnails and full-size promotional images using the provided `nexus_id`.
  - Image modals updated to exclusively display the officially fetched Nexus thumbnails.
- **Frontend Enhancements**:
  - Added a welcome modal loosely aligning with the "Dream On" quest to immerse users immediately upon load.
  - Interactive Map/Sidebar Integration: Hovering over a sidebar mod entry now triggers a neon pulse animation on the corresponding map pin or cluster icon.
  - Dynamic Map Pin Clustering: Integrated `Leaflet.markercluster` to group dense map pins. Clusters automatically "spider out" on hover to reveal individual pins, and remain expanded while a popup is open.
  - Added automated Nexus profile link generation for mod authors.
  - Unified Author and Tag filter layouts for visual consistency.
- **Automated Modification System**:
  - Implemented "Suggest Edit" system on all map popups using pre-filled GitHub issue templates.
  - Created `modify-location-submission.yml` workflow for automated location updates and removals.
  - Integrated Discord webhooks for real-time submission alerts.
- **Night Corp Modernization & UI Polish**:
  - Thematic branding applied to headers, modals, and list items.
  - Unified SVG icon system for sidebar navigation and replaced native emoji icons.
  - Category-colored active filter buttons for improved UX.
  - Cyberpunk-styled scrollbars and Leaflet map controls.
  - Moved external links (Discord, Report Bug, Suggest Feature) into the 'About Night Corp' modal and footer.
  - Added a mock `SYNC_OFFSET` telemetry generator in the footer to simulate an active system status (operates nominally 85% of the time, improving visual calmness).
- **Maintenance & Bug Fixes**:
  - Swept, removed, and resolved all underlying CSS variables conflicting with the old colour palette (`--cb-` to `--nc-`).
  - Fixed duplicate CSS header rules causing potential layering issues (`z-index`).
  - Corrected raw markdown syntax rendering incorrectly inside the Welcome Modal DOM.

### 2026-03-07

- **Data Architecture Refactor**:
  - Migrated monolithic `mods.json` into individual granular JSON files in `data/locations/`.
  - Implemented a build step (`scripts/build_mods.js`) to compile individual files.
  - Updated `mods.schema.json` to support multi-author arrays and team credits.
- **Mod Locations**:
  - Added **Improved Aldecaldos Camp** (Mod ID: 13821) and **V's Edgerunners Mansion Reloaded** (Mod ID: 26023).
  - Corrected author alias for "APEX - Sonora Canyon and Safehouse".
- **Dynamic Tagging**:
  - Implemented `tags.json` registry and automated validation script.
  - Added tag badges and filtering sidebar.
- **CI/CD Workflows**:
  - Overhauled `auto-pr-submission.yml` for granular JSON structure.
  - Integrated validation and build steps into `deploy.yml` and `validate-mods.yml`.
- **Security**:
  - Updated `.gitignore` to prevent tracking of compiled `mods.json`.
