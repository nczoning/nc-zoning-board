# NC Zoning Data API (worker/)

Cloudflare Worker serving the mod registry at `api.nczoning.net/v1/*` for
in-game consumers (and, later, the website itself). Architecture and phase
plan: [docs/data-api-plan.md](../docs/data-api-plan.md).

Deploys independently of the Pages site, but mirrors its main/dev split with
two environments:

| Env | Worker | Domain | Source origin | Deployed from |
| --- | --- | --- | --- | --- |
| production | `nczoning-api` | api.nczoning.net | nczoning.net | `main` |
| staging | `nczoning-api-staging` | api-dev.nczoning.net | dev.nczoning.net | `dev` |

CI (`.github/workflows/deploy-api.yml`) deploys production on push to `main`
and staging on push to `dev`, path-filtered to `worker/**`. So the live site
(main → nczoning.net → api.nczoning.net) only changes through the same
dev→main gate that protects the site itself; dev work stays on the staging
API.

## Local development

```bash
cd worker
npm install
npm run dev          # wrangler dev on http://127.0.0.1:8787
curl http://127.0.0.1:8787/v1/health
```

## Deploy

Normally you don't — CI deploys on merge (see the table above). Manual
deploy for local iteration:

```bash
cd worker
npx wrangler login                    # once per machine
npm run deploy                        # production
npx wrangler deploy --env staging     # staging
```

CI needs one GitHub Actions secret: `CLOUDFLARE_API_TOKEN` (a token with
Workers Scripts:Edit, Workers KV Storage:Edit, and Zone DNS:Edit on the
nczoning.net zone — DNS is needed so the custom-domain route can be created).
The `DISCORD_WEBHOOK_URL` Worker secret and the KV namespaces persist across
deploys; they're set once with `wrangler secret put` / `kv namespace create`
and are not touched by CI.

The `routes` entry binds the custom domain on first deploy (DNS + certificate
created automatically; the zone must be on the same Cloudflare account). The
`triggers.crons` entry starts the 15-minute refresh once deployed; a freshly
deployed env returns `503 not_ready` until its first cron tick seeds KV.

## Dataset refresh (cron)

Every 15 minutes the `scheduled` handler runs `runRefresh` (`src/refresh.js`):
fetch `mods.json` + tags + exclusions + `subdistricts.json` from
`SITE_ORIGIN`, run the Nexus auto-discovery merge with district enrichment,
and write to KV **only when the content hash changes**. On any source
failure it keeps the last-known-good dataset, sets `discovery_stale` in the
meta record, and (if configured) posts a Discord alert — it never serves an
empty or partial dataset.

KV keys: `dataset:v1` (slim), `dataset:v1:full`, `dataset:v1:districts`,
`dataset:v1:tags`, `dataset:v1:meta`.

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
| `GET /v1/health` | `{ status, version }` (uncached) |
| `GET /v1/locations` | slim location array |
| `GET /v1/locations/{id}` | one full entry (adds description/credits), or 404 |
| `GET /v1/districts` | district/subdistrict hierarchy (flat boundaries) |
| `GET /v1/tags` | tag dictionary |
| `GET /v1/meta` | `{ counts, discovery_stale, skipped }` |

Every response uses the envelope
`{ schema, generated_at, dataset_version, data }`. Dataset routes carry
`ETag: "<dataset_version>"` and `Cache-Control: public, max-age=300,
stale-while-revalidate=3600`; send `If-None-Match` to get a `304` when your
copy is current. Before the first cron tick the dataset routes return `503
not_ready`.

Docs: `openapi.json` is the source of truth (drift-guarded by
`test/openapi.test.js` — every served route must be documented and vice
versa). The human-facing reference with redscript/CET snippets is
[docs/api-reference.md](../docs/api-reference.md).

## Rate limiting

The read-only routes are edge-cached (`max-age=300`), so the vast majority
of traffic never reaches the Worker, and the free tier (100k Worker
requests/day) has a wide margin. A belt-and-braces WAF rate-limit rule is
recommended but not code — add it in the Cloudflare dashboard:

> Security → WAF → Rate limiting rules → Create, on the `nczoning.net` zone:
> match `http.host eq "api.nczoning.net"`, **60 requests / 1 min per IP**,
> action **Block** (or Managed Challenge). Mirror for `api-dev.nczoning.net`.

Rate-limit rules are zone config, not part of `wrangler deploy`.
