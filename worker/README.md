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

### What staging is for (and what it is not)

**`nczoning-data-staging` is a write sandbox, not a preview of production.** It
does not mirror prod, and there is deliberately **no sync job**. It exists so the
Phase 4/5 admin operations — approve, reject, hide, dismiss — can be run once
against throwaway data before they touch the real registry.

It is empty until then, on purpose. Note that staging has **no cron** and the
health monitor does not watch it, so nothing there refreshes or is observed;
`?api=dev` tests API *code*, never API *data*.

**Reseed it by copying production**, then treat it as disposable:

```bash
npx wrangler d1 export nczoning-data --remote \
  --table locations --table dismissed_candidates --no-schema \
  --output .import/prod-data.sql -y
npx wrangler d1 execute nczoning-data-staging --env staging --remote \
  --command "DELETE FROM locations; DELETE FROM dismissed_candidates;"
npx wrangler d1 execute nczoning-data-staging --env staging --remote --file .import/prod-data.sql
```

`--table` and `--no-schema` are both load-bearing: a full export carries the
schema and the `d1_migrations` table, which staging already has, so it conflicts.

**Do not reseed staging with `import-locations.mjs`.** That script regenerates
from `data/locations/` plus the live API, which produces *equivalent* data, not
a *copy* — it stamps `created_at`/`updated_at` with the import time and knows
nothing about the D1-only columns (`admin_notes`, `owner_id`, dismissal reasons,
`audit_log`). Seeding staging that way left it holding the same 296 records as
production under a `created_at` almost three hours adrift.

Those columns are not served on `/v1`, so this does not affect the parity gates
today. It will matter from **Phase 4**, when D1 becomes the source of truth and
`data/locations/` goes stale — at which point regenerating from the repo would
actively produce wrong data.

`import-locations.mjs` remains the right tool for exactly one job: the initial
seed of an empty database, or a rebuild from git if D1 is ever lost.

Full reasoning, including why the Phase 2 soak cannot run here: the
`staging-is-a-write-sandbox-not-a-preview` decision in the project wiki.

### One-time import + the parity gate

```bash
node scripts/import-locations.mjs --out .import/0001-seed.sql   # 287 manual + 9 auto, + 1 dismissal
npx wrangler d1 execute nczoning-data --remote --file .import/0001-seed.sql
node scripts/parity-check.mjs                                   # the gate
```

`parity-check.mjs` rebuilds `/v1/locations` from D1 via `src/materialize.js` and
diffs it **byte-for-byte** against what the live API is serving. All 18 served
fields are rebuilt: 11 from `locations`, 4 from `nexus_cache`, and
`district`/`subdistrict`/`recently_updated` recomputed from D1's own data. It
**fails on any served field it neither rebuilds nor feeds in**, so a new `/v1`
field cannot slip past as "not compared".

It then mutates the input nine ways (five location columns and the four
Nexus-derived fields) and asserts the diff catches each one. A green run that
did not also prove it can go red exits non-zero: the header comment explains
what the check does and does not cover, and is worth reading before trusting a
pass.

**It needs a swept `nexus_cache`.** Against a database the sweep has never run
on, every image rebuilds as null; the script says so and stops rather than
reporting ~300 mismatches.

### `nexus_cache`: the Nexus mod index

One row per mod, swept from the cron: every NCZoning-tagged mod (the candidate
pool for submissions) plus every mod the map serves a pin for. It supplies the
four Nexus-derived fields on each location through a join on `nexus_id`, and it
lets the candidates list be a SQL query instead of a live Nexus call on a public
route.

Three properties worth knowing before changing anything here:

- **The sweep writes only what changed.** ~300 rows on 288 daily ticks would be
  86k row-writes against a 100k/day free-tier cap, so an unchanged tick must
  cost zero writes. Measured against the live corpus: a first sweep writes 296
  rows, the next writes 0.
- **`nexus_id` is not unique across locations.** 296 locations use 295 distinct
  ids: mod 23896 supplies two tattoo shops. The join is one-to-many by design.
- **`name` is stored for comparison, never for display.** 34 location names
  differ from their Nexus title by curation, not staleness. Serving this column
  would undo that; diffing it detects a rename.

Archive listings (the `.archive` file names behind installed-mod detection) live
here too, in `archives`, with `archives_at` recording the mod `updated_at` they
were read against. `updated_at` alone cannot carry that, because the sweep
overwrites it the moment Nexus reports a re-upload, so the two columns are
compared to decide a refetch.

The KV key `dataset:v1:archives` is now a carry-over source, read once by the
sweep and never written. **Do not delete it until the sweep has run against both
databases**: it holds the hand-built listings from `scripts/archive-seeds.json`
for mods whose Nexus file preview is broken, and a refetch replaces those with
nothing.

### Switching the source (`DATA_SOURCE`)

`DATA_SOURCE` in `wrangler.jsonc` decides where the cron reads the registry
from: `mods` (the compiled `mods.json`) or `d1`. **Anything other than `d1`
means `mods`, including unset** — absent config must never read as "switch
production onto the new source".

The Phase 2 cutover is that one word, and so is the rollback. That is the point
of it being a var: reverting is a config change on a build already known to
work, not a revert-and-redeploy while production is wrong.

```bash
node scripts/parity-ab.mjs      # both code paths, swept clock  <- run this first
node scripts/parity-check.mjs   # D1 vs the live API, byte-for-byte
```

**`parity-ab.mjs` is the one to trust for the cutover.** `parity-check.mjs`
compares against the live API, which only changes when the content hash does —
so on a quiet day re-running it compares the same bytes for hours and cannot
fail. `parity-ab.mjs` instead runs `buildDataset` and `materializeFromD1`
head-to-head on identical Nexus input, then sweeps the clock ±365 days across
the `recently_updated` boundary. It exercises the drift a multi-day soak was
hoping to stumble into, in seconds, and it **fails if the swept field never
varied** — a sweep that changed nothing tested nothing.

Waiting is not a test. Do not gate the cutover on elapsed time; gate it on both
scripts green.

## Admin auth (Phase 3)

Sign-in and the collaborator gate. The write routes it gates are in
[Admin API](#admin-api-phase-4) below; `/admin/` in the site repo is the
dashboard that drives them.

| Route | Method | Does |
| --- | --- | --- |
| `/auth/login` | GET | 302 to GitHub, sets a one-shot signed `state` cookie |
| `/auth/callback` | GET | Verifies state, exchanges the code, checks collaborator status, sets the session |
| `/auth/me` | GET | `{authenticated, login, collaborator}` |
| `/auth/logout` | POST | Clears the session (POST so a stray link cannot sign you out) |

**The repo's collaborator list is the admin list.** Adding an admin is a
repo-collaborator change; there is no separate allowlist to drift out of step.

The user's OAuth token is used for exactly one thing — reading their login — and
is never stored. Collaborator status is checked with the **App's** installation
token, so an admin never has to grant `repo` scope just to find out they are an
admin.

### The collaborator check has three outcomes, not two

`GET /repos/{owner}/{repo}/collaborators/{login}` answers **204 = yes**,
**404 = no**, and a broken or under-permissioned credential answers **401/403**.
Collapsing that third case is a security bug in *both* directions:

- `not 404 → allow` — a dead credential grants everyone admin
- `not 204 → deny` — a dead credential locks everyone out, silently

So `checkCollaborator()` returns `'yes' | 'no' | 'error'`, and `'error'`:

- **fails closed** for the request,
- is **never written to the `users` cache** (caching "no" from a transient blip
  would lock a real admin out for the full 10-minute TTL),
- surfaces as **503 `check_unavailable`**, not 403 — "we cannot tell" is not
  "you are not allowed", and the stub page words it that way deliberately.

A consequence worth knowing: **if the App's permissions are wrong, you get
`check_unavailable`, not a lockout that looks like a refusal.** That is the
intended diagnosis path.

### One-time setup

Create a **GitHub App** in the `nczoning` org (Settings → Developer settings →
GitHub Apps):

- **Callback URLs** (add both, one App serves both environments):
  `https://api.nczoning.net/auth/callback` and
  `https://api-dev.nczoning.net/auth/callback`
- **Webhook:** disable (nothing consumes one)
- **Repository permissions:** `Administration: Read-only` — this is what the
  collaborator endpoint requires. If it is wrong the check returns 403, which
  surfaces as `check_unavailable`; it does not silently deny.
- **Install it on `nczoning/nc-zoning-board`.**

Then fill `GITHUB_APP_ID` and `GITHUB_OAUTH_CLIENT_ID` in `wrangler.jsonc` (both
public, both environments) and set three secrets **per environment**:

```bash
# GitHub hands out a PKCS#1 key; WebCrypto only imports PKCS#8. Convert once:
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in downloaded-private-key.pem -out app-key-pkcs8.pem

npx wrangler secret put GITHUB_APP_PRIVATE_KEY      # paste the PKCS#8 PEM
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET              # e.g. openssl rand -base64 48

npx wrangler secret put GITHUB_APP_PRIVATE_KEY      --env staging
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET  --env staging
npx wrangler secret put SESSION_SECRET              --env staging
```

**`SESSION_SECRET` must differ between production and staging.** It is the
session signing key: share it and a staging session token is accepted as valid
by production.

Skipping the PKCS#8 conversion fails with an opaque WebCrypto `DataError`, so
`github-app.js` detects a PKCS#1 key and says exactly this instead.

### Test the cron locally

```bash
npm run dev
curl "http://127.0.0.1:8787/__scheduled"                 # trigger one refresh
npx wrangler kv key get "dataset:v1:meta" --binding DATASET --local
```

## Admin API (Phase 4)

Every route below is gated on collaborator status, answers `no-store`, and needs
`credentials: 'include'` from an origin in `ADMIN_ORIGINS` (`src/auth.js`).
**`*.pages.dev` preview URLs are not on that list**, so a PR preview cannot
exercise auth. Test on `dev.nczoning.net`. These are deliberately absent from
`openapi.json`, which documents the public read surface only.

| Route | Method | Does |
| --- | --- | --- |
| `/admin/locations` | GET | every location, all statuses, including `admin_notes` |
| `/admin/locations` | POST | 201; `id` is server-generated and refused from input |
| `/admin/locations/{id}` | GET / PATCH / DELETE | PATCH is partial; DELETE keeps the full record in the audit row |
| `/admin/tags` | GET | the registry, each row with `usage_count` |
| `/admin/tags` | POST | 201; 409 `tag_exists` on a duplicate slug |
| `/admin/tags/{slug}` | GET / PATCH / DELETE | see the two rules below |
| `/admin/audit` | GET | newest first, `?limit=` capped at 500 |
| `/admin/refresh` | POST | rebuild the served dataset now; see below |

**Unknown payload keys are a 422, not an ignore**, and `id` is refused outright.
A silently dropped typo looks exactly like a successful save.

### Rebuilding the read path by hand

**Staging has no cron.** It was removed to stay inside the 1,000 KV writes/day
free-tier cap, which means nothing there re-materializes on its own: staging's
KV was found 14 hours stale, still serving the pre-4b `/v1/tags` map shape, with
nothing to notice it. `POST /admin/refresh` is the fix, and the dashboard shows
dataset age in the top bar so the state is visible rather than assumed.

Unlike the write-through materialize, it is **not** gated on `DATA_SOURCE`. That
gate exists so an admin write does not spend a KV write rebuilding from a source
the write did not touch; this route is someone explicitly asking, and
`runRefresh` honours `DATA_SOURCE` either way: from `mods.json` in production,
from D1 on staging. It cannot flip the cutover.

**`runRefresh` does not throw on failure.** It catches, keeps last-known-good,
flags `discovery_stale` and *returns* `{stale: true}`. So the route branches on
that return value, not on whether the call threw. Treating "it did not throw" as
success would report every failed rebuild as a win. `changed: false` is a
success, meaning the content hash matched and nothing needed rewriting.

### Keeping D1 in step with `data/locations/` before the cutover

Submissions still arrive the old way: issue → PR → `main` → a new
`data/locations/<uuid>.json`. `mods.json` is rebuilt from those files so
production picks the record up, and **D1 hears nothing**, so staging, which
reads D1, silently serves a smaller map than production. A mod merged overnight
did exactly that.

```bash
node scripts/sync-locations.mjs --db nczoning-data-staging --env staging --out .import/sync.sql
npx wrangler d1 execute nczoning-data-staging --env staging --remote --file .import/sync.sql
```

Emits SQL rather than running it, INSERT-only, and writes **both**
`locations` and `location_tags`. A record inserted without the join rows
renders with no tags at all. It never deletes: rows in D1 with no file are not
drift, since the nine auto-discovered records have never existed as files. It
also reports records that exist in both and disagree, without rewriting them.

Run it against **both** databases, and delete the script at cleanup. Keeping it
after submissions land in D1 directly would preserve git as a second source of
truth.

### Tags live in the join, and writes must go through it

`locations.tags` is still present (migration 0002 is additive so parity can be
proven before the column drops), but `materializeFromD1` reads
**`location_tags`**. A write that touched only the column returned `200` and
changed nothing on the map. `syncLocationTags()` in `src/tag-registry.js` owns
both representations and is the only thing that may write either; it batches so
the join is never briefly empty, and it keeps the synthetic `nczoning` marker in
the legacy column for `source='auto'` rows so the stored shape does not drift.

Tag validation reads the **`tags` table**, not the KV snapshot. Reading KV was
correct while tags came from a file in git and became wrong the moment they were
editable: a tag created through the API would have 422'd on first use.

### Two tag rules the schema implies but does not enforce

- **`slug` is the primary key**, so renaming one is an `ON UPDATE CASCADE`
  through `location_tags` and a link-breaking event. The cascade only fires with
  foreign keys enforced (D1 has them on, SQLite does not by default), so the
  handler re-counts the links after a rename and returns **500 `cascade_failed`**
  rather than reporting a success that silently orphaned every record. The
  dashboard keeps the slug read-only behind an explicit unlock; routine
  relabelling is what `name` is for.
- **Deleting a tag still in use is refused**: 409 `tag_in_use`, with the count
  and the affected records in the body. `location_tags` has no `ON DELETE` for
  `tag_slug`, so a bare delete fails on the foreign key with an opaque error, and
  a cascade would strip the tag from every record as a side effect of one click.
  Detach first, then delete.
- **`nczoning` can never be created or renamed into.** It is not a registry row;
  it is a marker the materializer prepends to auto-sourced records. A row with
  that slug would collide with it, and deleting that row would strip the tag from
  every auto-discovered record at once.

Tests run against **real SQLite with the real migrations**
(`test-support/d1-sqlite.mjs`), not a SQL-shape-matching mock: the two rules
above are claims about constraints, and a mock can only restate the belief it was
written from.

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
