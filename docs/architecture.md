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
│   │   ├── bug_report.yml          # Locations are submitted from the map, not
│   │   ├── feature_request.yml     # from an issue form. The submission
│   │   └── feedback.yml            # templates retired at the D1 cutover.
│   └── workflows/
│       └── validate-mods.yml            # CI: validates mods.json against schema
│                                        # (deploys via Cloudflare Pages Git integration, not a workflow)
│
└── docs/                   # You are here
```

## Data Flow

> For what happens between pressing Submit and the pin appearing, see the
> [Submission Pipeline](submission-pipeline.md).

```text
┌─────────────┐     ┌────────────────────┐     ┌──────────────────┐
│ Mod Author  │────▶│  Map: [+] Submit   │────▶│ POST /submissions│
│ submits CET │     │  or "Suggest a fix"│     │ Turnstile + rate │
│ coordinates │     └────────────────────┘     │ limit            │
└─────────────┘                                └────────┬─────────┘
                                                        │
                                                        ▼
                                              ┌────────────────────┐
                                              │ D1 `submissions`   │
                                              │ status: pending    │
                                              └────────┬───────────┘
                                                       │  admin approves
                                                       ▼
                                              ┌────────────────────┐
                                              │ D1 `locations`     │
                                              │ + `audit_log` row  │
                                              └────────┬───────────┘
                                                       │  write-through
                                                       ▼
                                              ┌────────────────────┐
                                              │ materialize → KV   │
                                              │ /v1/locations      │
                                              └────────┬───────────┘
                                                       │
                                                       ▼
                                              ┌────────────────────┐
                                              │ services.js        │
                                              │ cetToLeaflet(x, y) │
                                              │ → [lat, lng]       │
                                              └────────┬───────────┘
                                                       │
                                                       ▼
                                              ┌────────────────────┐
                                              │ Leaflet map        │
                                              │ Three.js scene     │
                                              │ Sidebar            │
                                              └────────────────────┘
```

## Key Components

### JavaScript Architecture

The frontend JS is nine files loaded via `<script>` tags (no bundler; two are ES modules). All shared symbols live on the `window.NCZ` namespace.

| File | Role |
| --- | --- |
| `constants.js` | All config values: category styles, API endpoints, cache keys, UI sizing, 3D scene constants |
| `utils.js` | Pure functions: `escapeHtml`, `cetToLeaflet`, `cetToThree`, positioning algorithm, submit-form validation (`collectLocationForm`) |
| `services.js` | Fetch functions: the `/v1` Data API loader (`fetchLocationsFromApi()`) and the submissions POST |
| `app.js` | DOM logic: map init, sidebar, cluster panel, modals, image gallery, view switching |

The 3D scene ships on `main`. These are the other five files:

| File | Role |
| --- | --- |
| `overlay.js` | District/subdistrict GeoJSON border overlays for the satellite view |
| `three-scene.js` | Three.js scene: renderer, camera, GLBs, buildings, sun/shadows (`NCZ.ThreeScene`) |
| `three-markers.js` | 3D pin/popup/tooltip/cluster layer: interactive parity with Leaflet (`NCZ.ThreeMarkers`). See [three-markers.md](three-markers.md) for the full architecture. |
| `flyover.js` | Optional cinematic flyover showcase, include/exclude via `<script>` tag |

**Load order, identical on `main` and `dev`** (verified against `index.html`, 2026-07-31):

`constants.js` → `utils.js` → `district-info.js` → `services.js` → `overlay.js` →
`three-scene.js` (module) → `three-markers.js` (module) → `flyover.js` → `app.js`

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

### Location Data (D1)

- **The registry is a Cloudflare D1 database**, served at `/v1/locations`. It stopped living in git at the 2.0.0 cutover.
- **Attributes**: `id` (UUID, or `nexus-<id>` for the nine legacy auto-discovered records), `name`, `authors` (array), `coordinates` ([X, Y, Z]), `yaw`, `nexus_id` (ID string, "WIP" or "Dummy"), `category`, `tags` (via the `location_tags` join), `description`, `credits`, `status` and `admin_notes`.
- **Never served**: `admin_notes` is admin-only and is deliberately withheld from `/v1`.
- **Validation** happens on the write path in the Worker, so a bad value is refused at submission rather than caught in CI afterwards.
- `data/locations/*.json` remains in the repo as the pre-cutover record and is read by nothing. It goes at Phase 6.

### Styling (`style.css`)

- Cyberpunk theme using CSS custom properties (all prefixed `--`)
- Fonts: **Orbitron** (headings), **Rajdhani** (body) from Google Fonts
- Colour palette: `--primary` (#0a192f), `--secondary` (#00f0ff), `--tertiary` (#ffb300), `--white` (#e6f1ff), `--gray` (#8892b0)
- Custom Leaflet popup, tooltip, and cluster styling
- MarkerCluster CSS is inlined (no external CDN dependency)
- Uses native CSS nesting; see [browser support](https://caniuse.com/css-nesting)

## Repo Setup (for new maintainers)

Discord alerting uses secrets configured in **repo Settings → Secrets and variables → Actions**. The Worker's own secrets are a **separate store**, set with `npx wrangler secret put` from inside `worker/`:

```powershell
cd worker
$env:CLOUDFLARE_ACCOUNT_ID='b9937d8d595fad7de8d1549b22390281'
npx wrangler secret put <NAME>              # production
npx wrangler secret put <NAME> --env staging
```

`wrangler` is a devDependency of `worker/`, not a global install, so it resolves only through `npx` (or an npm script, which puts `node_modules/.bin` on PATH). Running it from the repo root fails twice over: npm cannot find the binary, and `wrangler.jsonc` is not there either.

| Secret | Value |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | Legacy webhook for the retired **submissions** channel. Nothing writes to it now; it survives only as a fallback for the alerts webhook below, and retires at Phase 6 |
| `NCZ_ALERTS_DISCORD_WEBHOOK_URL` | Webhook for the dedicated **map-alerts** channel. Held by the **Worker** now (`npx wrangler secret put`), because the Worker is what posts to Discord. The Actions copy is unused |
| `ALERTS_INGEST_SECRET` | Bearer token for `POST /internal/alerts`. Needed in **both** stores: a GitHub Actions secret for `monitor_api_health.js`, and a Cloudflare Worker secret for the Worker that checks it. Setting one does not set the other |

### Alerts

Every alert goes through one place: **`POST /internal/alerts` on the Worker**,
which **records it in the `alerts` table and then forwards it to Discord**.

The ordering is the point. The table exists so alert history survives Discord
burying or dropping a message, and forwarding first would mean a Discord outage
loses the record as well as the notification. The two steps fail independently:
a failed D1 write still notifies, and a failed Discord post still leaves the
alert in the dashboard's **Alerts** tab, where it can be acknowledged.

Alerts come from four sources, and the `source` column names them:

| Source | Raised by | When |
| --- | --- | --- |
| `api-health` | `monitor-api-health.yml`, every 15 min | The Data API (`/v1`) is not serving, **or** its refresh cron has wedged (a frozen `/v1/health.last_refresh_at` heartbeat older than 45 min; the API can serve stale data silently, see #849). On a wedged cron it also **self-heals**: it dispatches `deploy-api.yml` to redeploy the affected Worker (re-registers the Cron Trigger), capped at 2 redeploys/env/hour before escalating for a human |
| `refresh` | `worker/src/refresh.js`, on the 5-minute cron | A dataset rebuild failed (amber: last-known-good is still served), and the matching all-clear when one later succeeds |
| `submissions` | `worker/src/submissions.js` | A submission reached the review queue. A plain "one is waiting" post linking to the dashboard, deliberately not the old edit-in-place embed |
| `quota` | `worker/src/quota.js`, hourly on the cron | A free-tier cap passed 80% for the UTC day. Checked on one tick an hour, and suppressed to once per cap per UTC day |

**In-Worker producers call `raiseAlert()` directly** rather than making an HTTP
request to their own Worker. `/internal/alerts` is the remote entry point to the
same function, and exists because a GitHub Action cannot hold a session.

**Why `/internal/` and not `/admin/`.** Every `/admin/*` route is gated on GitHub
collaborator status, and `index.js` states that as an invariant. The machine
surface authenticates with a shared secret instead, so it sits on its own prefix
and the invariant stays literally true. Reading and acknowledging alerts *are*
on `/admin/alerts`, behind the session, because those are done by a person.

The legacy **submissions** channel (`DISCORD_WEBHOOK_URL`) covered the mod
submission lifecycle: a bot posted an embed when a submission PR opened, then
edited that message in place to show merged or closed. Discord was acting as the
queue's UI. The dashboard holds that state now, and all three producing workflows
retired at the D1 cutover. It survives only as a fallback for the alerts webhook,
and retires at Phase 6.
