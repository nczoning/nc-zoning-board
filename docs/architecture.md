# Architecture

This document explains how the NC Zoning Board is organised and how data flows through the system. **If you're new here:** Start with the [Project Overview](../README.md), then read this to understand how the pieces fit together. You don't need to know every detail to contribute, but this gives you the full picture of where things live and how they interact.

---

## File Structure

```text
nc-zoning-board/
├── index.html              # Single-page app entry point
├── data/
│   ├── locations/          # Individual mod JSON files (tracked by Git)
│   └── tags.json           # Registry of all valid tags and definitions
├── mods.json               # Compiled registry (Git-ignored, built in CI)
├── mods.schema.json        # JSON Schema for compiled data
├── package.json            # Node.js deps (sharp, build scripts)
│
├── assets/
│   ├── css/style.css       # Cyberpunk-themed styles (Orbitron + Rajdhani fonts)
│   ├── js/
│   │   ├── constants.js    # Shared constants (NCZ namespace)
│   │   ├── utils.js        # Pure utility functions (coordinate transform, cache, positioning)
│   │   ├── services.js     # API/fetch functions (Nexus thumbnails, auto-discovery, data loading)
│   │   └── app.js          # Main app logic (map init, DOM events, sidebar, modals)
│   ├── images/             # Static image assets
│   └── tiles/              # Generated map tiles (zoom levels 0-6)
│       └── {z}/{x}/{y}.webp
│
├── scripts/
│   ├── build_mods.js       # Compiles data/locations/*.json -> mods.json
│   ├── validate_tags.js    # Validates tags in data/ against tags.json
│   └── generate_tiles.js   # Slices 16k source image into 256×256 WebP tiles
│
├── raw maps/               # Source map images (not committed - too large)
│   ├── 4k/night_city.png   # 4096×4096, 27 MB
│   ├── 8k/night_city.png   # 8192×8192, 108 MB (archive)
│   ├── 16k/night_city_16k.png  # 16384×16384, 529 MB (current tile source)
│   └── 32k/                # 32768×32768 split into 4×4 quadrants
│
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── mod_submission.yml      # GitHub Issue form for mod submissions
│   │   └── suggest_edit.yml        # GitHub Issue form for suggesting edits
│   └── workflows/
│       ├── auto-pr-submission.yml       # Bot: submission issue → PR with new JSON
│       ├── modify-location-submission.yml # Bot: edit issue → PR with modified JSON
│       └── validate-mods.yml            # CI: validates mods.json against schema
│                                        # (deploys via Cloudflare Pages Git integration, not a workflow)
│
└── docs/                   # You are here
```

## Data Flow

> For a full breakdown of the bot implementation, see the [Submission Pipeline](submission-pipeline.md) documentation.

```text
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│ Mod Author  │────▶│ GitHub Issue  │────▶│  Auto-PR Bot  │
│ submits CET │     │   Form       │     │  (Actions)    │
│ coordinates │     └──────────────┘     └───────┬───────┘
└─────────────┘                                  │
                                                 ▼
                                         ┌──────────────┐
                                         │ data/locations│
                                         │ <UUID>.json  │
                                         └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │  build_mods  │
                                         │  → mods.json │
                                         └──────┬───────┘
                                                │
                                                ▼
                                    ┌────────────────────────┐
                                    │     services.js        │
                                    │  cetToLeaflet(x, y)    │
                                    │  → [lat, lng] on map   │
                                    └────────────┬───────────┘
                                                 │
                                                 ▼
                                    ┌────────────────────────┐
                                    │    Leaflet Map         │
                                    │  Sidebar GUI           │
                                    │  Category Filtering    │
                                    │  L.marker (pins)       │
                                    └────────────────────────┘
```

## Key Components

### JavaScript Architecture

The core frontend JS is four files loaded via `<script>` tags (no ES modules, no bundler). All shared symbols live on the `window.NCZ` namespace.

| File | Role |
| --- | --- |
| `constants.js` | All config values: category styles, API endpoints, cache keys, UI sizing, 3D scene constants |
| `utils.js` | Pure functions: `escapeHtml`, `cetToLeaflet`, `cetToThree`, positioning algorithm, BBCode parser |
| `services.js` | Fetch functions: Nexus thumbnail API, auto-discovery, `fetchModData()` |
| `app.js` | DOM logic: map init, sidebar, cluster panel, modals, image gallery, view switching |

Load order on `main`: `constants.js` → `utils.js` → `services.js` → `app.js`

**Three.js migration** (in progress on `dev` branch) adds four more files:

| File | Role |
| --- | --- |
| `overlay.js` | District/subdistrict GeoJSON border overlays for the satellite view |
| `three-scene.js` | Three.js scene: renderer, camera, GLBs, buildings, sun/shadows (`NCZ.ThreeScene`) |
| `three-markers.js` | 3D pin/popup/tooltip/cluster layer: interactive parity with Leaflet (`NCZ.ThreeMarkers`). See [three-markers.md](three-markers.md) for the full architecture. |
| `flyover.js` | Optional cinematic flyover showcase, include/exclude via `<script>` tag |

Load order on `dev`/feature branches: `constants.js` → `utils.js` → `services.js` → `overlay.js` → `three-scene.js` (module) → `three-markers.js` (module) → `app.js` → `[flyover.js optional]`

### Map Layer (`app.js`)

- Uses **Leaflet.js** with `L.CRS.Simple` (non-geographic coordinate reference system)
- Map image is served as **256×256 WebP tiles** at zoom levels 0–6 (16k source), with upscaled zoom to level 8
- At max native zoom (6), the image is 64×64 = 4,096 tiles (5,461 total across all zoom levels)
- Bounds are calculated via `map.unproject()` to align pixel coordinates with the tile grid

### Coordinate Transform (`utils.js`)

- `NCZ.cetToLeaflet(x, y)` converts CET game coordinates to Leaflet `[lat, lng]`
- Exact linear mapping derived from `NCZ.WORLD_MIN/MAX_X/Y` constants (from the Realistic Map mod terrain quad UV mapping), not a calibrated approximation
- `NCZ.cetToThree(x, y, z)` converts CET coordinates to Three.js scene space (`[x, z||0, -y]`)
- See [Coordinate System](coordinate-system.md) for full details

### Mod Data (`data/locations/*.json`)

- Individual JSON files per mod to prevent merge conflicts.
- **Attributes**: `id` (UUID), `name`, `authors` (array), `coordinates` ([X, Y]), `nexus_id` (ID string, "WIP", or "Dummy"), `category`, `tags` (array), and `description`.
- **Credits**: Optional field for team-based acknowledgements.
- **Validation**: Individual tags are checked against `data/tags.json` and the final compiled `mods.json` is validated against `mods.schema.json` in CI.

### Styling (`style.css`)

- Cyberpunk theme using CSS custom properties (all prefixed `--`)
- Fonts: **Orbitron** (headings), **Rajdhani** (body) from Google Fonts
- Colour palette: `--primary` (#0a192f), `--secondary` (#00f0ff), `--tertiary` (#ffb300), `--white` (#e6f1ff), `--gray` (#8892b0)
- Custom Leaflet popup, tooltip, and cluster styling
- MarkerCluster CSS is inlined (no external CDN dependency)
- Uses native CSS nesting; see [browser support](https://caniuse.com/css-nesting)

## Repo Setup (for new maintainers)

The auto-PR pipeline and Discord notifications require two secrets configured in **repo Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `ACTIONS_PAT` | A GitHub Personal Access Token (fine-grained) with `Contents: Read/Write` and `Pull requests: Read/Write` on this repo |
| `DISCORD_WEBHOOK_URL` | Webhook for the **submissions** channel: new/modified submission embeds and their PR-status edits (channel Settings → Integrations → Webhooks) |
| `NCZ_ALERTS_DISCORD_WEBHOOK_URL` | Webhook for the dedicated **map-alerts** channel: auto-discovery parse failures and Data API health/outage alerts, kept separate from submissions |

> **Why ACTIONS_PAT?** GitHub's `GITHUB_TOKEN` cannot trigger other workflow runs (a security design). Using a PAT for `create-pull-request` allows the `validate-json` check to fire automatically on the generated PR.

### Discord Notifications

Two channels, two webhooks. **Submissions** (`DISCORD_WEBHOOK_URL`) covers the mod
submission lifecycle:

- **`auto-pr-submission.yml`**: Posts a new embed when a submission PR is created (status: ⏳ Awaiting review). Stores the Discord message ID as a hidden comment on the issue.
- **`modify-location-submission.yml`**: Posts an embed for modification/removal requests.
- **`notify-discord-pr-status.yml`**: When the PR is merged or closed, edits the original embed in-place to show the outcome (✅ Approved or ❌ Closed). Must use the same webhook that posted the message.

**Alerts** (`NCZ_ALERTS_DISCORD_WEBHOOK_URL`) covers operational health on a separate channel:

- **`monitor-auto-discovery.yml`**: Daily scan; alerts when a NCZoning-tagged mod fails to parse and isn't covered by a manual entry.
- **`monitor-api-health.yml`**: Every 15 min; alerts when the Data API (`/v1`) isn't serving. The Worker's own refresh-failure alert (`worker/src/refresh.js`) posts here too (Cloudflare Worker secret, set separately via `wrangler secret put`).
