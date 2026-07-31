# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The locations table sorts by any of Name, Category, Status, Added or Modified. Click a heading to sort, click it again to reverse. Dates start newest-first, text starts A to Z, because that is the question each one is usually being asked. Keyboard reachable, and the current sort is announced to screen readers.
- The dashboard shows when a location was **added** and when it was last **modified**, in the locations table as well as the detail pane, alongside when the mod itself was last **updated on Nexus**. Three different dates, named so they cannot be confused: the one a `/v1` record carries is the Nexus one.

### Fixed

- A restore from the location files would have produced a registry where every location had no tags. The importer wrote the tag column but not the join the map actually reads, so the database would have looked complete and served untagged. It writes both now, and the generated file ends with a check that prints what landed.
- Location dates were all the same timestamp: the moment the registry was imported, so every record claimed it was added and last edited at the same instant on 26 July. Backfilled from git history, which is the only place the real dates survived. 288 records now carry their true dates, spanning 7 March to 26 July, and 212 of them show a modified date genuinely later than their added date. The nine auto-discovered records keep the import date, because they have never existed as files and nothing recorded when they arrived.

- Two admins editing the same location no longer overwrite each other. A save applies only while the record still looks the way it did when the editor was opened; if it moved, the save is refused, nothing is written, and the current version is loaded so the change can be reapplied. Previously the second save won silently and the first admin's edit disappeared on next load.

## [2.0.0] - 2026-07-31

Submissions move onto the map. A location can now be added, corrected or reported
from the map itself, and everything goes through a review queue before it appears.
The registry moves out of git into a database, with a dashboard for maintainers.

### Added

- **Submit a location from the map.** Pick your mod, fill in the form, send it for review. Coordinates are checked as you type, and every problem in the row is named at once beside the field it belongs to.
- **Correct any pin from its own popup.** *Suggest a fix* opens the form filled in from the record and sends only the fields you change. The same form switches to asking for a pin to be taken down, with a reason. The pin is unchanged until a reviewer decides.
- **A review queue.** Nothing reaches the map without a reviewer approving it. Each submission shows a diff of what it changes and a mini-map of the proposed pin. A new pin for a mod already on the map lists the records it would sit alongside and how far away they are, since one mod can legitimately supply several locations.
- **An admin dashboard** at `/admin/`, signed in with GitHub and open to repository collaborators: browse and edit the registry, manage tags, work the queue, review tagged mods that have no pin yet, and watch API health and free-tier usage. Every change is recorded in an audit log.
- **A privacy note** at [docs/privacy.md](docs/privacy.md). Submissions are the first personal data the site collects: a salted one-way hash of the submitter's address, kept 90 days and then cleared automatically.
- The map notices when locations change while a tab is left open, and offers to refresh instead of showing its load-time snapshot indefinitely.

### Changed

- **The location registry lives in a database rather than in git.** The move itself changes nothing a visitor sees: same pins, same data. It removes the gap where a merged pull request and the live map could disagree.
- **The `NCZoning` tag is prefill only.** Tagging a mod puts it in the submit form's picker with its name, description and uploader ready to use. It no longer publishes a pin on its own.
- ⚠️ **Editing the block in a Nexus description no longer moves a pin.** Authors who kept their location up to date that way now do it from the map. Pins already on the map are unaffected.
- **API `0.3.0` to `0.5.0`, breaking twice.** `/v1/tags` returns an array of `{slug, name, description, sort_order}` instead of a `{tag: description}` map, matching `/v1/locations` and the shape the in-game parser maps most easily; `name` falls back to the slug, so nothing renders differently. And two fields leave every location record: `source` (`manual` / `auto`) and the synthetic `nczoning` tag, neither of which describes anything now that nothing auto-publishes. Where a record came from is still readable, because the auto-discovered nine keep their `nexus-<id>` ids. **The `/v1` API is versioned separately from the site**, and is still pre-1.0, where breaking changes cost a MINOR and the path stays `/v1`. Both were taken now because the only consumers are unreleased; the API returns to `1.0.0` when the first in-game mod ships.
- **The NCZONING filter button disappears** from the sidebar, and the small Nexus icon next to auto-discovered pins goes with it. Both marked a distinction that no longer exists: every location now arrives the same way, through the review queue.
- Tags are registry data, edited in the dashboard rather than by pull request. A mistyped tag is refused on write instead of caught in CI afterwards.
- `robots.txt` keeps `/admin` out of search results. The collaborator gate is what actually protects it.

### Fixed

- Share links pointed at the mod rather than the pin, so when one Nexus mod supplied two locations both produced the same link and it always opened the first. Links now use the location's own id. Links shared before this keep working.
- Admin tag edits reached the legacy column but not the one the map reads, so they reported success and changed nothing.
- The API never told browsers they could read the `ETag` header, so the site's own conditional-request cache had never stored anything and its `304` handling was unreachable. The browser's built-in cache masked it, which is why nothing looked wrong.

### Removed

- **The GitHub issue forms for submitting and editing locations**, and the three workflows behind them. They wrote locations into git, and the registry no longer lives there, so a submission could no longer reach the map: the form accepted it, a PR opened, CI passed, the merge went green, and no pin appeared. Submitting from the map replaces both.
- **The BBCode generator.** The block had to be placed and formatted by hand, most attempts needed correcting, and it published a pin with no review step. The submit form replaces it.

## [1.7.2] - 2026-07-26

### Changed

- The Data API Worker deploys to the project-owned Cloudflare account, with its production and staging KV namespaces repointed to match.
- The API surface returns to pre-1.0: `version` at `/v1/health` is now **0.3.0**, down from 1.3.0. While on `0.x`, breaking changes bump MINOR, additive changes bump PATCH, and the path stays `/v1`. `1.0.0` returns when the first in-game mod ships.

## [1.7.1] - 2026-07-25

### Changed

- Daily Workers KV writes cut from ~576–700 to ~100–200 (of a 1,000/day per-account free-tier cap): the staging Worker's cron is removed, and the cron liveness heartbeat is now written at most every 15 minutes on an unchanged tick instead of on all 288.
- The health monitor's staleness threshold moves 20 → 45 minutes to match, and no longer probes staging (a cronless Worker's heartbeat never advances, so it would page and self-heal in a loop).
- The site reads the **production** API from every origin — dev, previews and localhost included. Use `?api=dev` to opt into staging when testing an API change. There was never a deliberate dev dataset; dev only differed from main by being behind.

## [1.7.0] - 2026-07-22

### Changed

- The API's `version` (served at `/v1/health`) is now real SemVer for the API surface — MINOR on an additive field or route, MAJOR on a break — instead of a static `0.1.0`. Backfilled to **1.3.0** for the three additive changes already shipped: `recently_updated` (1.1.0), `archives` (1.2.0), the cron heartbeat (1.3.0). It is not the in-game `ApiVersion()`, which gates only on breaking changes. ([#857](https://github.com/spuddeh/nc-zoning-board/issues/857))
- CI now fails if `openapi.json`'s shape changes without an `API_VERSION` bump, or if the four places the version is declared disagree. The worker suite also runs on pull requests now, not only at deploy. ([#857](https://github.com/spuddeh/nc-zoning-board/issues/857))

## [1.6.0] - 2026-07-21

### Added

- `/v1/health` now reports the refresh cron's liveness: `last_refresh_at` (stamped every cron cycle, unlike the content-driven `generated_at`) and a server-computed `refresh_age_seconds`. The health monitor alerts on the map-alerts Discord when the heartbeat stops advancing, so a wedged-but-still-serving cron no longer freezes the dataset silently. ([#849](https://github.com/spuddeh/nc-zoning-board/issues/849))
- The health monitor now self-heals a wedged cron: it redeploys the affected Worker (which re-registers the Cron Trigger), capped at 2 attempts/env/hour before escalating to a "manual fix needed" alert. ([#849](https://github.com/spuddeh/nc-zoning-board/issues/849))

## [1.5.0] - 2026-07-20

### Added

- Each `/v1` location record now carries an `archives` array — the `.archive` and `.xl` filenames the mod installs to `archive/pc/mod/` (so removal-only mods are detectable too) — letting an in-game mod detect which location mods a player has installed. ([#841](https://github.com/spuddeh/nc-zoning-board/issues/841))

## [1.4.1] - 2026-07-19

### Changed

- The website now loads exclusively from the `/v1` Data API — the legacy client-side Nexus merge and its fallback are removed, so the browser makes no Nexus calls at all.
- If the API is unreachable the map shows a loud "temporarily unavailable" state that auto-retries, instead of silently blanking. This keeps the site an honest canary for API outages.

## [1.4.0] - 2026-07-16

### Changed

- **Data API now carries per-location records only.** `/v1/locations` is a single representation (the slim/full split is gone; `?full=1` is a no-op alias), and `/v1/meta` no longer ships aggregate `counts`. Consumers derive counts by grouping records.
- Each location carries a server-computed `recently_updated` boolean, and the response envelope publishes the `recently_updated_days` window, so the clockless in-game mod can show recency, and the website reads the bool instead of computing it.
- The district info panel now groups stats by the API's assigned district/subdistrict labels rather than recomputing them client-side.

### Fixed

- District info panel no longer undercounts: locations outside every district/subdistrict polygon are now counted under Badlands (the API's assignment), instead of being dropped from all stats. Fixes Badlands count (41 → 44) and the `% of all locations` denominator (292 → 295). ([#823](https://github.com/spuddeh/nc-zoning-board/issues/823))

## [1.3.0] - 2026-07-09

### Design

- New Cyan favicon set (SVG + ico + PNGs + apple-touch + manifest) replaces the single `.ico`.
- Header logo is now an SVG (was WebP); recoloured to read on the navy header.
- New Tier 0 brand face **Night Corp Display** (`--font-nightcorp`, derived from the logo) on the header wordmark and welcome-modal splash. Orbitron keeps all headings.

### Infrastructure

- Data API refresh cadence 15 → 5 min, so new/updated mods propagate to the map faster after a submission. (Nexus load stays well under limits.)
- API alerts are now self-healing: the health monitor posts a green "recovered" all-clear once the API is serving again after an outage, and the refresh cron does the same when a failed refresh next succeeds.
- The `/v1` API no longer bot-challenges automated consumers (tools, servers, uptime checks): Cloudflare Bot Fight Mode was returning `403` to datacentre clients, including our own health monitor. Disabled it; a `/v1` rate-limit rule remains, and DDoS + WAF protection are unaffected.

## [1.2.0] - 2026-07-05

> **Headline: the NC Zoning Data API is live for modders.** A read-only HTTPS API at `api.nczoning.net/v1/` serves the full mod registry (locations, districts and tags) to in-game mods and tools, running the same server-side merge the website used to do in the browser. The website now consumes it too.

### Data API

- Public read-only API at `api.nczoning.net/v1/`: `/locations` (+ `?full=1`), `/locations/{id}`, `/districts`, `/tags`, `/meta`, `/health`. Versioned envelope, `ETag`/`304` caching, and DTO-mappable JSON for the in-game RedData parser. Interactive docs at the API root; reference in `docs/api-reference.md`.

### Infrastructure

- The website now loads the mod registry from the `/v1` Data API instead of running the Nexus auto-discovery merge in the browser; mod thumbnails moved server-side, so the browser no longer calls Nexus. Falls back to the client-side path if the API is unavailable.
- Added a Data API health monitor (`monitor-api-health.yml`) that alerts if `/v1` stops serving. Operational alerts (API health + auto-discovery) now post to a dedicated Discord channel, separate from submissions.

## [1.1.0] - 2026-07-04

### Infrastructure

- The live site is now served by Cloudflare Pages instead of GitHub Pages, for faster loads via a closer edge and long-lived asset caching (see `docs/caching-strategy.md`).

### 3D Schematic Map

#### Changed

- three.js upgraded r184 → r185.1; adopts the upstream fix for district outline rays at close zoom (#773).
- The render loop (including the showcase flyover) now runs on `renderer.setAnimationLoop`, the WebGPU-native frame driver; idle render-on-demand behaviour is unchanged (#768).
- District outlines render through our own TSL line material instead of three.js `Line2NodeMaterial` (#775): true semi-transparent compositing over roads, metro and water, ring corners no longer over-brighten, and the r185 line workarounds (resize mitigation, alpha-to-coverage opt-out) are gone.
- Roads, borders and the metro now layer correctly at every camera angle: no more borders or roads glowing through overlapping decks, and metro/tunnel roads render correctly over water (#770).

#### Fixed

- Resizing the window no longer permanently blacks out the 3D view on three.js r185 (#771); the showcase also renders at native fullscreen resolution now instead of an upscaled windowed buffer.
- Showcase: pins and district labels stay locked to the ground, the sidebar hides during the show, and district outlines display (bright, hover-style) regardless of starting zoom (#769).
- Showcase options now offer district names and district outlines as separate toggles.
- District outlines were invisible at their resting brightness on three.js r185 (#773).

## [1.0.0] - 2026-06-28

> **Headline: the flat schematic is now a live 3D map.** A navigable 3D recreation of Cyberpunk 2077's in-game world map: terrain, hundreds of thousands of buildings, roads, the metro, district borders and landmarks, lit and shaded like the game. Everything below ships together as one update.

### 3D Schematic Map

#### The city in 3D (new default view)

- SCHEMA (3D) is now the landing view, with a SAT (2D satellite) toggle. Your place carries across when you switch: centre, zoom, and in 3D your heading and tilt (#744).
- Renders terrain, water and cliffs, every district's buildings, roads, the metro network, district and subdistrict borders, and 8 landmark monuments (The Needle, Heavy Hearts Club, the De-votion statue, both ferris wheels, and more).
- Left-drag to pan, right-drag to tilt (up to ~70°), scroll to zoom. Opens with a brief cinematic fly-in to a whole-city framing (#689).

#### Buildings

- The full skyline: ~254k instanced building cubes per district, decoded from the game's own map data with correct position, height and rotation (#595, #605).
- Faces carry the game's centre-dark to edge-light gradient and surface shading, decoded from the in-game `3d_map_cubes` shader (#686, #692, #687).
- Buildings use malgalad's **3D World Map Fixed** data by default, correcting misaligned and missing buildings such as the Corpo Plaza cluster. The game's uncorrected layout is available by turning off **Settings → Map data → Fixed building assets** (#739).

#### Lighting & colour

- Reproduces the in-game map's decoded colour pipeline: ACES tonemap, colour grade and the braindance grading LUT, all from the game's environment data (#694).
- **Time-of-day** lighting: the sun slider drives Night City's real (Morro Bay) sun position, spanning summer-solstice sunrise to sunset (the longest day, for the most daylight to play with). Midday holds a calibrated brightness while sunrise and sunset stay dim and atmospheric, readable across the whole day (#737).

#### Shadows

- Real-time sun shadows on terrain, buildings, cliffs and landmarks, including casters just off-screen so edge-of-view shadows don't pop in (#647, #651).
- Shadow edges stay put as you pan, rotate and tilt instead of crawling or shimmering (#754).
- Zoomed all the way out (and during the showcase fly-over), shadows now cover the whole city instead of a camera-tracking box that left the far side unlit (#756).
- The **Shadows** toggle now fully skips the shadow render when off (a real performance gain, not just hidden shadows), and shadows stop re-rendering on frames that don't change geometry (#751).

#### Themes

- New **Game** theme: matches Cyberpunk 2077's in-game world-map palette (UI, 3D scene, roads and metro) with the decoded additive road/metro blend (#690).
- New **Preem Map** theme, based on CyanideX's Preem Map mod (used with permission); landmark monuments are coloured independently of the buildings (#691).
- New **Synthwave** theme: deep-indigo land, lighter-violet bay, vibrant purple buildings, neon cyan edges (#737).
- The four themes that shipped with the 2D map (Night Corp, Arasaka, Militech and Aldecaldos) were extended with per-layer 3D scene colours, so each one now styles the full 3D city and not just the 2D UI.
- Each 3D layer (buildings, terrain, water, cliffs, roads, metro, grid) is themed independently, and themes switch instantly with no page reload.
- New **Settings** toggles for any theme: the in-game **Colour grade (LUT)** and a self-lit neon **Edge glow** (defaults: LUT on for Game and Preem, edge glow on for Synthwave) (#737).

#### Map overlays: roads, metro, districts

- Roads, road borders and the metro network with the game's additive blend. The Pacifica underwater tunnel shows through the bay while staying hidden through terrain (#606, #648).
- **Metro LOD** (dotted, thin and wide lines) crossfades by zoom, decoded from the game's metro shader (#688).
- The game's procedural "graph-paper" terrain grid on terrain, water and cliffs (#685).
- District and subdistrict **borders** match the game: districts when zoomed out, subdistricts mid-zoom, neither up close. Outlines sit faint and brighten when your cursor enters a district (#655, #742).
- District and subdistrict **name labels** at their centroids: faint by default, emphasised on hover, and legible over the satellite imagery in 2D (#743).

#### District info panel

- Hovering a district shows an in-game-style readout, top-right: district icon and name, the subdistrict under the cursor, and location stats (count, category breakdown, share of all locations, recently-updated count). Works in both views (#745).

#### Mod pins in 3D

- Interactive mod pins, popups, tooltips, clustering and the Discover button all work in the 3D view, driven by the same sidebar and filters as 2D (#621).
- Clustering groups pins by real-world distance, not screen pixels, so tilting the camera doesn't reshuffle clusters. The shared cluster panel and active-cluster highlight work across both views (#621, #659).
- A distance scale bar in the 3D view, plus pin share-links (`?mod=`) that reopen the pin whether you land in 2D or 3D (#621).
- Pins are a toggleable overlay, and pan, zoom and tilt gestures pass cleanly through pins, clusters and on-canvas controls to the camera (#634, #658, #668).

#### Showcase flyover

- A cinematic camera sweep across Night City synced to *Good Morning Night City*, with beat-driven theme cross-dissolves and a sunrise-to-sunset sun arc.
- **Showcase Options** modal: pick a fixed theme or beat-cycle, stagger the layer reveal, show mod pins during the flyover, mute the music, and loop (#633, #634). Spacebar pauses (#747).

#### Performance & loading

- **3D payload cut ~88%** (18.5 MB down to 2.18 MB) via meshopt-compressed assets, for a much faster first load (#622).
- **Render-on-demand**: the scene only redraws when something actually changes, so an idle map costs near-zero GPU/CPU and saves battery (#641).
- Renderer pixel ratio capped at 1.5 (saves ~44% GPU work on Retina/4K), and pins stay aligned to buildings on fractional-DPR displays (#640).

#### Renderer: WebGPU (under the hood)

- The 3D scene renders through **WebGPU** with native depth, lighting and GPU-compute building culling. It falls back to the existing 2D map (with a notice) when WebGPU is unavailable, and works on Firefox (#644-#650, #666, #667).

#### For developers

- `?debug=1` stats panel plus a "Copy debug info" snapshot, and the `?webgpuprobe`, `?gamelight` and `?only=<district>` URL flags catalogued in [docs/url-parameters.md](docs/url-parameters.md) (#618, #619, #665).
- Every Object3D is named for Needle Inspector legibility (#635). New maintainer docs: [docs/3dmap-fixed-assets.md](docs/3dmap-fixed-assets.md) and [docs/3d-map-lighting.md](docs/3d-map-lighting.md).
- The About modal gained a **Credits** section (CDPR Fan Content disclaimer plus CyanideX and Malgalad) (#738).

#### Fixes

- The 2D fallback (no WebGPU) now opens framed on the city instead of a zoomed-out fit-to-all-pins (#749).
- The default sun time now actually applies on cold load; it was being overridden by an init race (#733).
- `_m` roof detail no longer paints onto the sloped faces of tilted buildings (#734).
- Showcase pins no longer ghost into the sky on low or away-facing sweeps (#746).
- Removed the `?lighttune` debug panel, superseded by the time-of-day lighting curve (#737).

## [0.3.6] - 2026-06-05

### Added

- **Auto-discovery exclusion list** (`data/excluded_mods.json`): mods tagged `NCZoning` that shouldn't appear on the map (mistaken or too-minor tags) are listed here and skipped by both auto-discovery (`services.js`) and the health monitor. The latter stops re-flagging them daily. First entry: mod 29860.

### Changed

- **Monitor Discord alert**: clearer copy. Each category now states the concrete action ("ask the author to regenerate", "add a manual entry or exclude"), and the footer/description note how many mods are on the exclusion list.

## [0.3.5] - 2026-05-16

### Added

- **Auto-discovery health monitor**: scheduled GitHub Action runs the real `parseNcZoningBlock()` against all live NCZoning-tagged Nexus mods daily and posts a Discord alert listing any that are missing from the map, split into "malformed block" (author fix needed) vs "tagged, no block". Catches silent parse failures within a day instead of when an author complains. Local/dry runs (no webhook) print the payload for review instead of sending.

## [0.3.4] - 2026-05-16

### Fixed

- **Auto-discovery (resilient BBCode parsing)**: `parseNcZoningBlock()` now strips all BBCode tags and token-anchors the `NCZoning:` sentinel (anywhere in the description, every occurrence) instead of requiring an intact `[code]…[/code]` wrapper. Blocks that lost their `[code]` tags, picked up stray `[spoiler]`/`[size]`/`[font]`/`[color]` styling, or were pasted glued inline to prose (e.g. from a copy-paste round-trip) now parse correctly.

## [0.3.3] - 2026-05-04

### Fixed

- **Thumbnails (chunked `modsByUid` fetch)**: Large single `modsByUid` requests (~250 UIDs) were silently truncated by the Nexus V2 API, so some manual-mod pins loaded without thumbnails until a later reload "self-healed" it. Now chunked into 50-UID parallel batches (`NEXUS_BATCH_SIZE`) with a one-shot retry of dropped UIDs; short chunks log the missing UIDs to tell flakiness apart from stale `nexus_id`s.

## [0.3.2] - 2026-04-09

### 16k WebP Tile Layer

- **16k WebP tiles**: Upgraded satellite base layer from the single-image WebP overlay (9.6 MB blocking download) to 16k WebP tiles (zoom 0–6, 5,461 tiles). Generated directly from the lossless 16k PNG source at quality 90, effort 6. Max-zoom upscaling reduced from 8× to 4× for significantly sharper detail. Progressive tile loading eliminates the first-paint latency on GitHub Pages.

## [0.3.1] - 2026-04-09

### Coordinate Transform and Satellite Map

- **Coordinate accuracy**: Replaced the 16-point in-game survey calibration with a mathematically exact transform derived from the [Realistic Map 8k mod](https://www.nexusmods.com/cyberpunk2077/mods/17811) terrain quad UV mapping. The old calibration had up to ~2 Leaflet unit (~16px at max zoom) drift at map edges; the new transform is exact by construction. Pin positions shift by up to ~0.25 units near the map centre and ~2 units at the far edges, visually imperceptible for most pins.
  - Added `NCZ.WORLD_MIN_X/MAX_X/MIN_Y/MAX_Y` as named constants (single source of truth for world extent)
  - `cetToLeaflet()` and `leafletDistanceMeters()` both derive from these constants. Scale indicator accuracy improved automatically
- **Satellite base layer**: Replaced the tile pyramid (`assets/tiles/{z}/{x}/{y}.png`, 256×256 tiles at zoom 0–5) with a single 9.6 MB WebP image overlay (`assets/img/satellite_8k.webp`). Eliminates tile-loading seams, simplifies serving, and leverages WebP compression for a smaller total payload.

## [0.3.0] - 2026-04-06

### Coordinate Expansion: Z and Yaw

- **Data schema**:
  - `coordinates` extended from `[X, Y]` to `[X, Y, Z]`: Z (height/elevation) is now required for new submissions; existing `[X, Y]` entries remain valid
  - Optional `yaw` top-level field added: player facing direction in degrees from CET
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
  - **Copy Link button**: each mod popup now includes a "Copy Link" button (chain icon) that copies a shareable URL to the clipboard (e.g. `https://nczoning.net?mod=13821`) with 2-second "Copied!" feedback
  - **Deep-link support**: URLs with `?mod=<id>` parameter now automatically open and focus the matching pin on page load. Uses numeric `nexus_id` for Nexus mods; falls back to UUID for WIP/Dummy entries
  - **URL sync**: the browser address bar updates to reflect the current open pin (`?mod=` parameter), allowing users to share the map URL directly from their browser
- **Icons**:
  - Added `link.svg`: new Feather-style chain-link icon for the Copy Link button
- **Constants**:
  - `NCZ.SITE_URL`: canonical site URL for deep-link generation
  - `NCZ.URL_PARAM_MOD`: configurable URL parameter name (defaults to `"mod"`)

## [0.1.0] - 2026-03-28

### 2026-03-27

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Ko-Fi donation link**: "Buy us a coffee" link added to the sidebar footer and about modal, pointing to [ko-fi.com/nczoning](https://ko-fi.com/nczoning). Rendered with the Ko-Fi logo as an inline image.
  - **Discover button repositioned**: the "Discover a location" button is now anchored to the bottom-left of the map container. On desktop it dynamically offsets its `left` position by the sidebar's current pixel width when the sidebar is visible, and resets when the sidebar is hidden. Position updates on sidebar open/close and window resize.
  - **Cluster pin contrast**: cluster count badges now use bold white text with a text-shadow and a larger solid background area, improving legibility against varied map tile backgrounds.
- **UI**:
  - **Sidebar sort by last updated**: the mod list and cluster panel now sort by Nexus `updatedAt` descending (most recently updated first) instead of alphabetically. Mods with no Nexus timestamp (WIP/Dummy) fall to the end and sort alphabetically among themselves. Prevents gaming the list order by prefixing mod names with special characters.
- **Utils**:
  - `NCZ.sortModsByUpdated` added to `utils.js`: a comparator function `(a, b) => number` for use with `Array.sort()`. Orders by `_updatedAt` descending with alphabetical fallback for untimestamped mods.
- **Bug fixes**:
  - Fixed `_updatedAt` backfill for manual Nexus mods running inside the `.forEach()` body after `.sort()` had already completed. The backfill is now hoisted before the sort, so manual mods sort with their correct timestamps.
  - Fixed auto-discovery silently discarding `updatedAt`, `thumbnailUrl`, and `pictureUrl` for manually registered mods that are also tagged NCZoning. That metadata is now collected into a separate map and merged into `nexusThumbs`, so NCZoning-tagged manual mods receive their timestamps and images from the auto-discovery response. These mods are also excluded from the `modsByUid` batch, reducing its size.

### 2026-03-23

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Map scale indicator**: a Leaflet scale bar is displayed bottom-right (metric only). The scale is calibrated to in-game distances by overriding `L.CRS.Simple`'s `distance()` method with the inverse CET coordinate transform.
  - **"Discover a location" button**: new header button picks a random visible (post-filter) marker and zooms to it, opening its popup. Hides the sidebar on mobile when triggered.
  - **Focused pin persistence**: when the active popup's marker gets clustered on zoom-out, the cluster auto-spiderfies to keep the popup visible. Focus clears on manual close or when the marker is filtered out.
  - **Header button polish**: `#about-btn`, `#parameters-btn`, and `#bbcode-btn` now share a `.header-action-btn` base class with inline SVG icons and bold text. Submit button uses `.header-action-btn-tertiary` for the amber colour variant.
  - **Map pannable bounds**: `maxBounds` now extends 50% of the viewport past each edge so pins near the border can be panned to centre. Bounds recalculate on zoom and resize.
  - **Filter clear buttons**: "Clear all" buttons in the Tag and Author filter sections, visible only when filters are active.
  - **Active filter counts**: section headers show `(N)` beside "Filter by Tags" and "Author Filters" when filters are selected.
  - **Search clear button**: an × button inside the search input clears it; pressing Escape also clears the field.
  - **Popup height fix**: `positionDynamicPopup` now measures the full `.custom-popup-header.has-image` element (previously `.popup-thumb` only) for accurate arrow placement.
- **Constants**:
  - CET→Leaflet transform coefficients extracted to named constants (`NCZ.CET_TO_LEAFLET_X_SCALE`, `NCZ.CET_TO_LEAFLET_Y_SCALE`, `NCZ.CET_TO_LEAFLET_X_OFFSET`, `NCZ.CET_TO_LEAFLET_Y_OFFSET`, `NCZ.CET_UNITS_PER_METER`).
  - Added `NCZ.UPDATED_LABEL` (`"RECENTLY UPDATED"`): corrected badge text from `UPDATED`, applied across popup, sidebar, cluster panel, and filter tag.
- **Utils**:
  - Added `NCZ.leafletDistanceMeters()`: converts a Leaflet lat/lng pair to in-game metres using the inverse CET transform.

### 2026-03-22

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Popup redesign**: mod popups have been fully restyled:
    - Category-coloured border gradient: the popup frame fades from the category colour at the image/title boundary to the base secondary colour below.
    - Category badge floated top-left outside the frame; RECENTLY UPDATED badge floated top-right.
    - Thumbnail now `object-fit: contain` inside a max-height container: fills popup width without cropping.
    - Title accent underline and glow text-shadow both driven by `--popup-title-accent` (set to the category colour).
    - Tags moved below description with a dark background band.
    - Credits names individually coloured in amber via `.custom-popup-credit-name`.
    - Nexus link is flex-grow; Edit button is flex-shrink-0.
    - Popup `className` now includes `popup-cat-{category}` for per-category CSS targeting.

### 2026-03-21

- **UI**:
  - **Recently Updated badge**: mods updated on Nexus within the last 7 days now display an `UPDATED` badge in the popup title, sidebar entry, and cluster flyout panel. Tooltip reads "Updated on Nexus within the last N days" (N driven by `NCZ.RECENTLY_UPDATED_DAYS` constant).
  - **"updated" filter tag**: a synthetic `updated` filter tag is prepended to the sidebar tag list (before `nczoning`) whenever at least one recently updated mod is present. Selecting it shows only recently updated mods.
  - **Welcome modal disclaimer**: replaced the updated-badge explanation with a clear disclaimer that this map is a visibility tool, not a reservation system. Mod authors retain full creative freedom over any location.
- **API**:
  - `updatedAt` is now fetched in both the `modsByUid` (manual mods) and `NCZoningMods` (auto-discovery) GraphQL queries.
  - Manual mods receive `updatedAt` from the thumbnail fetch; auto-discovered mods receive it from the discovery query.
- **Constants**:
  - Added `NCZ.RECENTLY_UPDATED_DAYS`: controls the badge and filter threshold (default: 7 days).

### 2026-03-15 (refactor & CI)

- **Refactor**:
  - Split monolithic `app.js` (~1500 lines) into four focused modules using a `window.NCZ` global namespace (no bundler, no ES modules, loaded via ordered `<script>` tags):
    - `constants.js`: all shared config values, category styles, API endpoints, cache keys, UI sizing
    - `utils.js`: pure utility functions: `escapeHtml`, coordinate transform, localStorage cache helpers, tooltip/popup positioning algorithm, BBCode block parser
    - `services.js`: Nexus V2 GraphQL API functions: thumbnail fetch, auto-discovery, new `NCZ.fetchModData()` which fetches `mods.json` and `tags.json` in parallel
    - `app.js`: DOM logic, map init, sidebar filtering, cluster panel, modals, image gallery
  - Added `NCZ.DATA_MODS_PATH` and `NCZ.DATA_TAGS_PATH` constants for data file paths (contributed by [@Akiway](https://github.com/Akiway))
- **CI**:
  - Fixed `validate-json` required status check blocking all non-data PRs: the workflow now always runs on every PR and reports a status immediately. Validation steps (build, schema check, tag check) are gated behind a `git diff` check and only execute when `data/locations/`, `data/tags.json`, or `mods.schema.json` are modified.
- **Docs**:
  - Updated `docs/architecture.md`: new file structure tree, added JavaScript Architecture section with module table, updated component section headers, added CSS nesting note.
  - Updated `docs/submission-pipeline.md`: Stage 4 now describes the change-detection step.
  - Updated `docs/coordinate-system.md`: `cetToLeaflet` reference updated to `utils.js`.

- **UI** (contributed by [@Akiway](https://github.com/Akiway)):
  - **Cluster menu panel**: clicking a cluster now opens a resizable side panel listing all mods within that cluster, with thumbnails, tags, descriptions, and category-coloured headers. Clicking a mod in the panel zooms to its pin and opens its popup. Panel width is draggable and persisted in localStorage. On mobile, the panel uses a fixed width and hides the resize handle. Replaces the previous hover-to-spiderfy interaction.
  - **Custom cluster thresholds**: cluster icon colours now use a 4-tier system (small/medium/large/xlarge at 0/10/25/50 mods) with a custom `iconCreateFunction`, replacing the default 0/10/100 thresholds. Added a radial gradient overlay for depth.
  - **Inlined MarkerCluster CSS**: removed the two external CDN stylesheet links for `MarkerCluster.css` and `MarkerCluster.Default.css`, replacing them with inlined styles in `style.css`. Eliminates external requests and CDN dependency.
  - **Marker tooltips**: hovering a map pin now shows a tooltip with the mod name. Tooltip uses smart directional placement (top/bottom/left/right) to stay within map bounds, with CSS arrows pointing back to the pin.
  - **Dynamic popup positioning**: popups now reposition dynamically to stay visible within the map container, with directional CSS arrows. Repositions on map move, zoom, and resize. Uses `requestAnimationFrame` coalescing for performance.
  - **Zoom button fix**: corrected vertical alignment of +/- icons in Leaflet zoom controls.
- **Docs**:
  - Updated `docs/architecture.md`: corrected colour palette to current `--nc-` CSS variables.
  - Updated `docs/branding.md`: fixed amber hex code to match actual CSS value (`#ffb300`).
  - Updated `docs/roadmap.md`: added cluster panel, tooltips, and dynamic popup positioning to completed features.

### 2026-03-14

- **UI**:
  - Replaced "show more / show less" toggles on Tag and Author filter sections with collapsible section headers: click the header to expand/collapse. Both sections are collapsed by default to remove perceived bias toward alphabetically-first entries.
  - Added close buttons (X) to the terminal header bar of all modals (Welcome, About, BBCode Generator) for improved usability.
  - Location count now updates dynamically when filters or search are applied, showing filtered/total format (e.g., `42/97`).
  - `nczoning` tag now sorts first in the tag filter list (before alphabetical tags).
  - Added amber warning note below coordinate inputs in the BBCode Generator modal reminding users to include the minus sign for negative coordinates.
  - Updated About modal description to neutral tone: removed "avoid overlapping builds" language.
- **Issue Templates**:
  - Rewrote mod submission template description to neutral tone: removed "to prevent overlaps" language that implied the tool gatekeeps or plays favourites.
  - Strengthened negative coordinate guidance in both X and Y coordinate fields with warning emoji and clearer instructions.
  - Changed X coordinate placeholder to show a negative example (`-500`).

### 2026-03-13 (BBCode modal)

- **UI**:
  - Added step-by-step instructions to the BBCode Generator modal (Acquire Coordinates, Configure Metadata, Tag Your Mod, Deploy Block) replacing the single warning line.
  - Added placement recommendations in the output section: suggests bottom of description as common spot, notes block can go anywhere, references spoiler wrap option.
  - Added link to full auto-discovery documentation from the modal.
  - Updated CET coordinate tooltip to use `print(GetPlayer():GetWorldPosition())`.

### 2026-03-13 (API optimisation)

- **Performance**:
  - Eliminated duplicate image API calls: auto-discovered mods now carry their own `pictureUrl`/`thumbnailUrl` from the discovery query, so `fetchNexusThumbnails()` only fetches images for manual mods.
  - Added localStorage caching for Nexus API responses: auto-discovery results cached for 10 minutes, thumbnail data cached for 24 hours. Incremental fetches for new IDs not yet in cache.
  - Added 200ms debounce to sidebar search input to avoid excessive re-filtering on every keystroke.
  - Extracted magic numbers (`NEXUS_BATCH_SIZE`, `DESCRIPTION_MAX_LENGTH`, `SPIDERFY_DEBOUNCE_MS`, `COPY_FEEDBACK_MS`, `SEARCH_DEBOUNCE_MS`) into named constants.

### 2026-03-13 (security & hardening)

- **Security**:
  - Added `escapeHtml()` utility and applied to all user-supplied data in popup and sidebar HTML (`mod.name`, `mod.credits`, `mod.description`, authors, tag names/descriptions, URLs). Prevents XSS from Nexus API or submitted JSON.
  - Replaced inline `onclick` handler on popup thumbnails with a `data-full-src` attribute and delegated event listener.
  - Added `nexus_id` pattern validation (`^\d+|WIP|Dummy$`) to `mods.schema.json`.
  - Added coordinate range validation to the BBCode generator: rejects non-finite values and coordinates outside ±5000.
- **Bug Fixes**:
  - `build_mods.js` now exits with code 1 on any JSON parse error and detects duplicate IDs before writing output.
  - `deploy.yml` build step now uses `set -e` to propagate build failures.
  - `modify-location-submission.yml` now preserves existing coordinates when both coordinate fields are left blank (instead of failing with "Invalid coordinates").
  - Added `.catch()` to clipboard API call: shows "COPY FAILED" feedback instead of silently failing.
  - Removed stale `ripperdoc` tag from both issue templates and `docs/tags.md` (tag was removed from registry but references remained, causing validation failures).
- **Docs**:
  - Added Nexus V2 GraphQL API section to `CLAUDE.md` (endpoint, docs URL, query descriptions, caching strategy).
  - Added "What the API Reads from Your Mod Page" table to `docs/nczoning-auto-discovery.md`.
  - Standardised CET coordinate command to `print(GetPlayer():GetWorldPosition())` across all docs.
  - Added `npm run build` and `npm run validate` scripts to `package.json`.
  - Cleaned up `.gitignore`: removed dead `assets/images/raw maps/` pattern and duplicate `README.md` entry.

### 2026-03-13 (NCZoning auto-discovery)

- **Features**:
  - **NCZoning Auto-Discovery**: the map now queries the Nexus Mods V2 GraphQL API on page load for all Cyberpunk 2077 mods tagged with `NCZoning`. Mods with a valid `[NCZoning]` metadata block in their description are automatically added to the map as live pins, no GitHub submission required.
  - **BBCode Generator modal**: new `[+] SUBMIT` button in the header and sidebar opens a form that generates the `[code]NCZoning:...[/code]` metadata block. Includes CET coordinate inputs with a tooltip, category dropdown, tag checkboxes (populated from `tags.json`), credits, additional authors, an optional `[spoiler]` wrapper, a copy-to-clipboard button, and a reset button.
  - **Auto-discovered pin indicators**: auto-discovered mods display an amber `[ N ]` badge in the popup title and sidebar entry (tooltip: "Sourced automatically from Nexus Mods"). They also receive an automatic `nczoning` tag badge (with matching tooltip) visible in the popup, tag filter panel, and sidebar.
  - **Conflict resolution**: if a mod has both an auto-discovered entry and a manually submitted entry sharing the same `nexus_id`, the manual entry always wins.
  - **"Suggest Edit" suppressed** for auto-discovered mods: edits go through the Nexus description directly.
- **Bug Fixes**:
  - Fixed Nexus GraphQL filter sending `gameId` as a number: API requires a string (`"3333"`).
  - Fixed GraphQL query sending `uploader` as a scalar: corrected to `uploader { name }` (returns a `User` object).
  - Fixed BBCode block parsing failing on mod descriptions returned by the Nexus API with `<br />` HTML line breaks: parser now normalises these to `\n` before matching.
  - Fixed `applyFilters()` author lookup breaking when the `[ N ]` badge was added to the sidebar item name: authors are now stored in `li.dataset.authors` and read directly.
- **Docs**:
  - Added `docs/nczoning-auto-discovery.md`: full guide covering setup, BBCode format, field reference, editing, removal, conflict resolution, limitations, and misuse policy.
  - Updated `README.md`: NCZoning auto-discovery is now the preferred submission method; docs table updated.
  - Updated `CONTRIBUTING.md`: auto-discovery listed as preferred; GitHub issue listed as alternative; NCZoning guide added to useful docs list.
  - Updated `docs/adding-mods.md`: callout at top pointing to auto-discovery for mod authors who land there first.

### 2026-03-13

- **UI Improvements**:
  - Filter sections ("Filter by Tags", "Author Filters") now collapse to 2 rows by default with a "show more / show less" toggle. Sections with ≤2 rows of buttons hide the toggle automatically.
  - Sidebar location click now uses `flyTo` to the marker, then opens the popup after the animation completes. If the marker is inside a cluster, it spiderfies the cluster before opening the popup.
  - Map now calls `invalidateSize()` before `fitBounds` to ensure correct container dimensions on page load.
  - Popup `autoPan` disabled: the `maxBounds` constraint caused a visible snap-back; sidebar clicks handle positioning via `flyTo` instead.
- **Data**:
  - Removed `ripperdoc` tag from the tag registry.
- **Bug Fixes**:
  - Fixed workflow condition logic in `auto-pr-submission.yml` and `modify-location-submission.yml`: replaced `pull-request-created == 'true'` with `pull-request-operation != 'none'` to correctly detect PR creation/update using the v6 output. The old boolean output was unreliable and could cause both the "PR created" and "no changes" comments to fire simultaneously, or neither to fire.
  - Fixed missing mod thumbnails caused by the Nexus V2 GraphQL API silently capping `modsByUid` results at 20: the query now passes an explicit `count` equal to the number of IDs requested, ensuring all thumbnails are fetched regardless of roster size.
- **Workflow Updates**:
  - `notify-discord-pr-status.yml` now automatically deletes the `add-mod-*` / `mod-mod-*` branch after a PR is closed (merged or not), keeping the repo branch list clean. Added `contents: write` permission to support this.
- **Maintenance**:
  - One-off deletion of 49 stale `add-mod-*` and `mod-mod-*` branches that had accumulated from previous workflow runs.
- **Docs**:
  - Updated mod submission and modification issue templates: added a coordinate guide (CET console and Simple Location Manager methods), a warning not to use World Builder coordinates, and a reminder to include the minus sign for negative values.

### 2026-03-12 (tags)

- **Data**:
  - Added new `photos` tag: scenic or atmospheric locations well-suited for virtual photography.
- **Docs**:
  - Created `docs/tags.md`: canonical reference for the tag registry, including the full tag list and step-by-step processes for adding, modifying, renaming, and removing tags.
  - Updated `CONTRIBUTING.md`: added link to `docs/tags.md` in the Useful Docs section.
  - Updated `docs/adding-mods.md`: tags field now links to the tag registry doc.

### 2026-03-12

- **Bug Fixes**:
  - Fixed `ReferenceError: path is not defined` in `auto-pr-submission.yml` that was crashing the workflow before the PR title output was set, causing new mod submissions to fail silently.
  - Fixed malformed SVG namespace (`http://www.w3.org/-2000/svg`) in sidebar footer icon.
  - Fixed incorrect CSS class `"collapsed"` applied to the sidebar on mobile when clicking a location: corrected to `"hidden"` to match the existing style contract.
  - Fixed author extraction in `auto-pr-submission.yml`: the `Author Alias(es)` label heading contains parentheses that broke the regex match, producing empty `authors` arrays in generated JSON files.
  - Fixed `_No response_` placeholder not being stripped from the `credits` field in `auto-pr-submission.yml` and `modify-location-submission.yml`.
  - Fixed `modify-location-submission.yml` overwriting an existing `credits` value with `"_No response_"` when credits were left blank on the form: a blank entry now correctly preserves the existing value.
- **GitHub Issue Form Improvements**:
  - Added `Category` dropdown to the modify/removal form (with "Keep existing" option to leave it unchanged).
  - Replaced the free-text `Tags` input on both the submission and modify forms with a `checkboxes` field listing all 14 valid tags with inline definitions: eliminates invalid tag submissions and removes the need to reference `tags.json`.
  - Made X/Y coordinates optional on the modify/removal form (removal requests no longer need to provide coordinates).
  - Moved the `Description` field to the last position on both forms.
  - Removed prefilled title prefixes (e.g. `[Mod Submission]:`) from all five issue templates: submitters must now write a meaningful title themselves.
- **Workflow Updates**:
  - Updated `auto-pr-submission.yml` and `modify-location-submission.yml` tag parsers to read the new checkbox format.
  - `modify-location-submission.yml` now extracts and applies category changes; defaults to "Keep existing" if unchanged.
  - Both submission workflows now trigger on `issues: labeled` only (replacing `opened`): eliminates double-fire when a form auto-applies a label at creation, and allows maintainers to manually re-trigger by removing and re-adding the label.
  - `modify-location-submission.yml` Discord notifications now follow the same stored-ID pattern as the submission workflow: the initial "Awaiting Review" message ID is saved as a hidden comment on the issue so `notify-discord-pr-status.yml` can edit it on merge/close rather than post a new message.
  - `notify-discord-pr-status.yml` split into two jobs: `notify-submission` (edits the existing Discord message for `add-mod-*` PRs) and `notify-modification` (edits the existing Discord message for `mod-mod-*` PRs).
- **Labels**:
  - Created missing `mod-modification` label: its absence was silently preventing all modification/removal issue form submissions from triggering the automation workflow.
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
- **Night Corp Modernisation & UI Polish**:
  - Thematic branding applied to headers, modals, and list items.
  - Unified SVG icon system for sidebar navigation and replaced native emoji icons.
  - Category-coloured active filter buttons for improved UX.
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
