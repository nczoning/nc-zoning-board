# Data API Plan (v1)

Plan for a read-only API backend at `api.nczoning.net`, so Cyberpunk 2077 mods
can consume the registry in-game. Approved 2026-07-04; not yet built.

## Why an API

The static `mods.json` is not enough for game clients, for three reasons:

1. **It is incomplete.** The auto-discovery merge (Nexus mods tagged
   `NCZoning`, parsed and merged with manual entries) runs client-side in the
   browser (`assets/js/services.js`). A game mod reading the static file would
   miss every auto-discovered mod.
2. **It is a build artifact, not a contract.** `mods.json` can change shape
   whenever the site refactors. `/v1/` is a versioned promise that shipped
   game mods can rely on.
3. **It shields clients from Nexus.** The Nexus V2 GraphQL API is unsupported
   and may change; with the merge running server-side, game clients never
   touch it.

## Architecture

- **Standalone Cloudflare Worker** on `api.nczoning.net/v1/*`, code in this
  repo under `worker/`. Its own project: it shares only the domain with the
  proposed submission-system Worker (separate concern, separate deploys).
- **Workers KV** storage, refreshed by a **Cron Trigger every 15 minutes**:
  fetch `mods.json` + `data/excluded_mods.json` + `data/tags.json` +
  `data/subdistricts.json` from the CDN, run the auto-discovery merge (port of
  `services.js` / `scripts/monitor_auto_discovery.js`), enrich each location
  with `district` and `subdistrict` via point-in-polygon (the polygons in
  `data/subdistricts.json` are already in CET world coordinates), then write
  to KV only when the content hash changes.
- **Failure posture:** keep last-known-good data, set `discovery_stale=true`,
  alert Discord on the dedicated map-alerts channel
  (`NCZ_ALERTS_DISCORD_WEBHOOK_URL`, separate from submissions). Never serve an
  empty or partial dataset. Git remains the source of truth for manual
  entries; the Worker only reads deployed CDN artifacts. A separate
  `monitor-api-health.yml` GitHub Action probes `/v1` every 15 min and alerts
  on the same channel if the API stops serving (independent of the Worker's own
  alert — catches cases where the Worker can't alert for itself).
- **Free tier:** ~1 conditional GET per player session against a 100k req/day
  cap; KV writes at most 96/day. Passes with a huge margin.

## Routes

Every response uses the envelope
`{ "schema": 1, "generated_at": "...", "dataset_version": "<hash>", "data": ... }`.

| Route | Returns |
| --- | --- |
| `GET /v1/locations` | Slim list: id, name, nexus_id, coordinates, yaw, category, tags, authors, source, district, subdistrict |
| `GET /v1/locations/{id}` | Full entry (adds description, credits) |
| `GET /v1/districts` | District/subdistrict hierarchy with names, centroids and boundaries |
| `GET /v1/meta` | dataset_version, generated_at, counts, discovery_stale, min_client, notices |
| `GET /v1/tags` | Tag dictionary |
| `GET /v1/health` | 200 + Worker version |

Caching: `ETag` + `If-None-Match` (a 304 is the delta mechanism at ~300
entries), `Cache-Control: public, max-age=300, stale-while-revalidate=3600`,
edge cache, CORS `*` on GET, one WAF rate-limit rule.

## Contract rules

- **Stable ids:** manual entries keep their UUID; auto-discovered entries get
  the deterministic id `nexus-<nexus_id>`.
- **DTO-mappable JSON:** the in-game consumer (RedData `FromJson`) cannot
  parse arrays-of-arrays, and property names are case-sensitive. Flat numeric
  arrays such as `coordinates: [X, Y, Z]` are fine; polygon boundaries are
  served flattened (`[x1, y1, x2, y2, ...]`). Any future field must respect
  this.
- **Versioning:** path-based. Additive fields are non-breaking; breaking
  changes go to `/v2/` with `/v1/` kept alive for at least 6 months.

## Consumer: the NCZoningCore framework mod

A companion Cyberpunk 2077 mod (separate project) fetches `/v1/` via
RedHttpClient, caches offline via RedFileSystem, and exposes the registry to
other mods through a public redscript module (`NCZoning.Api`) and Codeware
events. First consumers: a Simple Location Manager integration tab, plus small
demos (district guide, nearby-location notification). Details live with the
mod project; the frozen contract above is the interface between the two.

## Phases

| Phase | Scope | Size |
| --- | --- | --- |
| B0 | Decision docs + contract freeze (unblocks the mod side) | S |
| B1 | Worker scaffold, `api.nczoning.net` custom domain, `/v1/health` | S |
| B2 | Server-side merge engine + district enrichment (testable module) | M |
| B3 | Cron to KV refresh, last-known-good, Discord alerting | M |
| B4 | Read endpoints live, payload size measured, contract finalised | M |
| B5 | Modder docs (see below) + WAF rate rule | M |
| B6 | Worker CI deploy (wrangler action, path-filtered) | S |
| B7 | Website consumes `/v1/` (parity verification + fallback) | M |

The mod project runs in parallel from B0 using local fixtures; it ships only
against the live `/v1/`.

## API documentation (for modders)

Two layers:

1. **`docs/api-reference.md`** (this repo) is canonical: routes, envelope,
   DTO constraints, and copy-paste redscript/CET usage snippets. These are
   the things modders actually need, and the things generated reference
   pages are bad at.
2. **OpenAPI spec** (`worker/openapi.yaml`) rendered as an interactive
   reference page served by the Worker itself at the `api.nczoning.net`
   root (Scalar or Redoc, a single static HTML). Zero extra hosting, and
   the spec doubles as a CI artifact: the Worker's real responses are
   validated against it.

A separate docs-site product would be overkill for six read-only routes.

## Dogfooding: the website as first consumer (B7)

Once `/v1/` is live, the site itself switches to it instead of running the
auto-discovery merge client-side. This is the strongest verification the
API can get: the map's pins, District Info Panel counts and thumbnails
exercise `/v1` on every page load, so any merge bug is immediately visible
on the map. The switch ships with a graceful fallback to the current
client-side path; the client-side Nexus GraphQL code is deleted only after
parity is confirmed (auto-discovered counts match, exclusion list honoured,
thumbnails present).

## Risks

- Nexus V2 GraphQL volatility: contained in the cron path; clients only ever
  see KV data.
- TLS: the in-game HTTP client requires HTTPS with TLS 1.2+. Cloudflare
  Universal SSL satisfies this; verify the zone minimum TLS version is 1.2 or
  lower.
- Abuse: read-only, edge-cached, rate-limited; the hard ceiling is the free
  plan's request cap.

## Deferred

- Live player-position features (opt-in heartbeat): sketched only; privacy
  design deliberately deferred.
- Fast-travel / metro-station / POI data: no such dataset exists in the repo
  yet (future TweakDB/WolvenKit extraction).
- The submission-system Worker (separate proposal).
