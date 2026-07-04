# NC Zoning Data API (worker/)

Cloudflare Worker serving the mod registry at `api.nczoning.net/v1/*` for
in-game consumers (and, later, the website itself). Architecture and phase
plan: [docs/data-api-plan.md](../docs/data-api-plan.md).

Deploys independently of the Pages site. The Pages Git integration ignores
this directory; the Worker ships via `wrangler deploy` (CI workflow arrives
in phase B6).

## Local development

```bash
cd worker
npm install
npm run dev          # wrangler dev on http://127.0.0.1:8787
curl http://127.0.0.1:8787/v1/health
```

## Deploy

One-time setup (before the first deploy):

```bash
cd worker
npx wrangler login                       # once per machine
npx wrangler kv namespace create nczoning-api-dataset   # paste the id into wrangler.jsonc
npx wrangler secret put DISCORD_WEBHOOK_URL   # optional: refresh-failure alerts
npm run deploy
```

The `routes` entry in `wrangler.jsonc` binds `api.nczoning.net` as a custom
domain on first deploy (DNS + certificate created automatically; the zone
must be on the same Cloudflare account). The `triggers.crons` entry starts
the 15-minute refresh once deployed.

To seed KV immediately without waiting for the first cron tick, trigger the
scheduled handler once from the dashboard (Worker → Triggers → run) or
redeploy.

## Dataset refresh (cron)

Every 15 minutes the `scheduled` handler runs `runRefresh` (`src/refresh.js`):
fetch `mods.json` + tags + exclusions + `subdistricts.json` from
`SITE_ORIGIN`, run the Nexus auto-discovery merge with district enrichment,
and write to KV **only when the content hash changes**. On any source
failure it keeps the last-known-good dataset, sets `discovery_stale` in the
meta record, and (if configured) posts a Discord alert — it never serves an
empty or partial dataset.

KV keys: `dataset:v1` (slim), `dataset:v1:full`, `dataset:v1:districts`,
`dataset:v1:meta`.

### Test the cron locally

```bash
npm run dev
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"   # trigger one refresh
npx wrangler kv key get "dataset:v1:meta" --binding DATASET --local
```

## Routes (current)

| Route | Returns |
| --- | --- |
| `GET /v1/health` | `{ status, version }` in the standard envelope |

Every response uses the envelope
`{ schema, generated_at, dataset_version, data }`. The read routes that
serve the dataset from KV (`/v1/locations`, `/v1/districts`, `/v1/meta`,
`/v1/tags`) ship in phase B4; the full API reference in B5.
