# NC Zoning Data API (worker/)

Cloudflare Worker serving the mod registry at `api.nczoning.net/v1/*` for
in-game consumers and the website itself. Routes, envelope and contract:
[docs/api-reference.md](../docs/api-reference.md).

Deploys independently of the Pages site, but mirrors its main/dev split with
two environments:

| Env | Worker | Domain | Source origin | Deployed from | Cron |
| --- | --- | --- | --- | --- | --- |
| production | `nczoning-api` | api.nczoning.net | nczoning.net | `main` | every 5 min |
| staging | `nczoning-api-staging` | api-dev.nczoning.net | dev.nczoning.net | `dev` | **none** |

CI (`.github/workflows/deploy-api.yml`) deploys production on push to `main`
and staging on push to `dev`, path-filtered to `worker/**`. So the live site
(main → nczoning.net → api.nczoning.net) only changes through the same
dev→main gate that protects the site itself.

**Production serves every consumer**, including dev.nczoning.net and localhost.
Staging exists to test *API changes* and is opt-in per page load with `?api=dev`
(`assets/js/constants.js`). It has no cron because KV bills writes per ACCOUNT
(1,000/day, shared by both Workers) and a 5-min staging cron spent ~29% of that
budget keeping a dataset nobody read fresh. Refresh it by hand when testing:

```bash
npx wrangler dev --env staging --test-scheduled   # then curl /__scheduled
```

## Local development

```bash
cd worker
npm install
npm run dev          # wrangler dev on http://127.0.0.1:8787
curl http://127.0.0.1:8787/v1/health
```

## Deploy

Normally you don't: CI deploys on merge (see the table above). Manual
deploy for local iteration:

```bash
cd worker
npx wrangler login                    # once per machine
npm run deploy                        # production
npx wrangler deploy --env staging     # staging
```

CI needs one GitHub Actions secret: `CLOUDFLARE_API_TOKEN` (a token with
Workers Scripts:Edit, Workers KV Storage:Edit, and Zone DNS:Edit on the
nczoning.net zone; DNS is needed so the custom-domain route can be created).
Refresh-failure alerts post to the dedicated map-alerts channel via the
`NCZ_ALERTS_DISCORD_WEBHOOK_URL` Worker secret (set once per environment:
`wrangler secret put NCZ_ALERTS_DISCORD_WEBHOOK_URL` and again with
`--env staging`). It falls back to the legacy `DISCORD_WEBHOOK_URL` secret if
the new one isn't set, so there's no alerting gap during the move. The secrets
and KV namespaces persist across deploys and are not touched by CI.

The `routes` entry binds the custom domain on first deploy (DNS + certificate
created automatically; the zone must be on the same Cloudflare account). The
`triggers.crons` entry starts the 15-minute refresh once deployed; a freshly
deployed env returns `503 not_ready` until its first cron tick seeds KV.

## Dataset refresh (cron)

Every 5 minutes (production only) the `scheduled` handler runs `runRefresh`
(`src/refresh.js`): fetch `mods.json` + tags + exclusions + `subdistricts.json`
from `SITE_ORIGIN`, run the Nexus auto-discovery merge with district
enrichment, and write to KV **only when the content hash changes**. On any
source failure it keeps the last-known-good dataset, sets `discovery_stale` in
the meta record, and (if configured) posts a Discord alert. It never serves an
empty or partial dataset.

The `last_refresh_at` liveness heartbeat (#849) is the one write that bypasses
the hash gate, so on an *unchanged* tick it is rate-limited to
`HEARTBEAT_MIN_INTERVAL_MS` (`src/config.js`, 15 min) — otherwise proving the
cron is alive would cost 288 writes/day on its own. A healthy idle cron
therefore reports a `refresh_age_seconds` of up to 15 min, which is why
`MAX_REFRESH_AGE_S` in `scripts/monitor_api_health.js` sits at 45 min. **Those
two constants are one parameter pair — never change one alone.**

KV keys: `dataset:v1:full`, `dataset:v1:districts`, `dataset:v1:tags`,
`dataset:v1:meta`, `dataset:v1:archives` (a cross-run cache of per-mod
`.archive` names, not part of any served payload). There is no longer a slim
`dataset:v1`: the slim/full fork was collapsed to one representation.

## D1 (`DB` binding)

The location registry. **Phase 1 only populates and verifies it — nothing reads
it yet**, and the cron still sources from `mods.json`.

Two databases, because named Wrangler environments inherit nothing: production
is `nczoning-data`, staging is `nczoning-data-staging`. **Every migration must
be applied to both**, and to remote as well as local — `--local` and `--remote`
are entirely separate stores that answer the same command, which is exactly how
a "verified" migration ends up missing in production.

```bash
export CLOUDFLARE_ACCOUNT_ID=b9937d8d595fad7de8d1549b22390281
npx wrangler d1 migrations apply nczoning-data --remote
npx wrangler d1 migrations apply nczoning-data-staging --env staging --remote
```

**`--env staging` is not optional on the second line.** Wrangler resolves
database names from the top-level config only, so without it the staging
database does not exist as far as the command is concerned and you get
`Couldn't find a D1 DB with the name or binding` — which is the mechanism by
which "apply it to both" quietly becomes "applied to one".

Unlike KV, this content is **not derived** — losing it loses data. D1 Time
Travel covers 30 days; `data/locations/` in git is the longer backstop until
the nightly export lands.

### One-time import + the parity gate

```bash
node scripts/import-locations.mjs --out .import/0001-seed.sql   # 287 manual + 9 auto, + 1 dismissal
npx wrangler d1 execute nczoning-data --remote --file .import/0001-seed.sql
node scripts/parity-check.mjs                                   # the gate
```

`parity-check.mjs` rebuilds `/v1/locations` from D1 via `src/materialize.js` and
diffs it **byte-for-byte** against what the live API is serving. It rebuilds the
14 fields D1 owns (including `district`/`subdistrict`, recomputed from D1's own
coordinates) and feeds in the 4 Nexus-derived ones it does not own until Phase 2
— and it **fails on any served field that falls into neither set**, so a new
`/v1` field cannot slip past as "not compared".

It then mutates a row five ways and asserts the diff catches each one. A green
run that did not also prove it can go red exits non-zero: the header comment
explains what the check does and does not cover, and is worth reading before
trusting a pass.

### Test the cron locally

```bash
npm run dev
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"   # trigger one refresh
npx wrangler kv key get "dataset:v1:meta" --binding DATASET --local
```

## Routes

| Route | Returns |
| --- | --- |
| `GET /` | interactive docs (Scalar, renders `openapi.json`) |
| `GET /openapi.json` | the OpenAPI 3.1 spec |
| `GET /v1/health` | `{ status, version, last_refresh_at, refresh_age_seconds }` (uncached) |
| `GET /v1/locations` | all locations, full records, as an array |
| `GET /v1/locations/{id}` | one full record, or 404 |
| `GET /v1/districts` | district/subdistrict hierarchy (flat boundaries) |
| `GET /v1/tags` | tag dictionary |
| `GET /v1/meta` | `{ discovery_stale, skipped }` (no aggregate counts) |

Every response uses the envelope
`{ schema, generated_at, dataset_version, data }`. Dataset routes carry
`ETag: "<dataset_version>"` and `Cache-Control: public, max-age=300,
stale-while-revalidate=3600`; send `If-None-Match` to get a `304` when your
copy is current. Before the first cron tick the dataset routes return `503
not_ready`.

Docs: `openapi.json` is the source of truth (drift-guarded by
`test/openapi.test.js`: every served route must be documented and vice
versa). The human-facing reference with redscript/CET snippets is
[docs/api-reference.md](../docs/api-reference.md).

## Versioning

`API_VERSION` (served as `version` on `/v1/health`) is SemVer for the API
*surface*: **MINOR** on an additive field or route, **MAJOR** on a break (which
also moves `/v1` → `/v2`), **PATCH** on a behaviour fix. It is not
`dataset_version` (a content hash), and not the in-game NCZoningCore mod's
`ApiVersion()` integer (a breaking-change gate). Rationale and the backfilled
history: [docs/api-reference.md#versioning](../docs/api-reference.md#versioning).

It is declared in **four** places that must agree — `wrangler.jsonc` production
*and* staging (named environments don't inherit `vars`), `openapi.json`
`info.version`, `package.json`. Bump all four, then:

```bash
npm run version:lock     # rewrites api-version.lock.json
```

`test/api-version.test.js` fails the deploy gate when the four disagree, or when
`openapi.json`'s machine-readable shape moved without a bump. Prose-only edits
(`description`, `summary`, `example`) don't count as a shape change — but field
*names* inside a `properties` map do, even when a field is called
`description`.

## Rate limiting

The read-only routes are edge-cached (`max-age=300`), so most traffic never
reaches the Worker and the free tier (100k Worker requests/day) has wide
margin. A WAF rate-limit rule is deployed as belt-and-braces (zone config,
not `wrangler deploy`):

> Dashboard → nczoning.net → **Security → Security rules → Rate limiting
> rules**. Rule "API rate limit": match **URI Path starts with `/v1/`**,
> characteristic **IP**, **100 requests / 10 seconds**, action **Block**,
> duration **10 s**.

**Free-plan constraints (why it's path-based, not host-based):** the free
rate-limiting rule only matches on **URI Path** (hostname isn't offered),
the period is fixed at **10 seconds**, and the only action is **Block**.
Matching `/v1/` is unaffected by this because that path only exists on the
API (the main site has no `/v1/` routes), so one rule covers both the prod
and staging API hosts and never touches the site. The `/` docs page and
`/openapi.json` are intentionally left uncovered (`/` would collide with the
site homepage). Verified by burst test: request 101 within a 10 s window
returns `429`.
