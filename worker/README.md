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

```bash
cd worker
npx wrangler login   # once per machine
npm run deploy
```

The `routes` entry in `wrangler.jsonc` binds `api.nczoning.net` as a custom
domain on first deploy (DNS record + certificate are created automatically;
the zone must be on the same Cloudflare account).

## Routes (current)

| Route | Returns |
| --- | --- |
| `GET /v1/health` | `{ status, version }` in the standard envelope |

Every response uses the envelope
`{ schema, generated_at, dataset_version, data }`. Contract rules live in
the plan doc; the full API reference ships in phase B5.
