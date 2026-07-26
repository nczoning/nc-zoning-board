# NC Zoning Data API reference

Read-only API serving the NC Zoning Board registry (Cyberpunk 2077 location
mods) to in-game mods and the website.

- **Production:** `https://api.nczoning.net` — used by **every** consumer,
  including dev.nczoning.net, preview builds and localhost.
- **Staging:** `https://api-dev.nczoning.net` — for testing API changes only.
  It has **no cron**, so its dataset is stale until refreshed manually, and the
  website reads it only when given `?api=dev` (see
  [`url-parameters.md`](url-parameters.md)).
- **Interactive docs:** open the base URL in a browser (rendered from
  [`worker/openapi.json`](../worker/openapi.json)).

Everything here is GET-only, unauthenticated, HTTPS-only (TLS 1.2+), and
CORS-open.

## The envelope

Every response is wrapped:

```json
{
  "schema": 1,
  "generated_at": "2026-07-05T00:00:00.000Z",
  "dataset_version": "87cc60cf7332…",
  "recently_updated_days": 7,
  "data": <route-specific>
}
```

`dataset_version` is a content hash of the whole dataset. It's also the
`ETag`, so it's how you detect changes (see [Caching](#caching)).

`recently_updated_days` is the recency window in days: a location's
`recently_updated` bool is `true` when its Nexus update falls within this many
days. It's published so consumers (and UI text) read the rule instead of
hardcoding it, though a clockless in-game consumer doesn't need it: it just
reads each record's `recently_updated` bool directly.

## Contract rules (why the JSON looks the way it does)

The shapes are frozen to stay parseable by the in-game **RedData** JSON
parser:

- **No arrays-of-arrays.** `coordinates` is a flat `[X, Y, Z]`; district
  boundaries are flattened to `[x1, y1, x2, y2, …]`. This maps cleanly to
  redscript `array<Float>`.
- **Property names are case-sensitive** and stable: they match DTO field
  names exactly.
- **Coordinates are raw CET world values**: the same numbers
  `GetWorldPosition()` returns in-game. No transform needed to teleport to
  them or compare against the player.
- **Stable ids:** manual entries keep a UUID; auto-discovered mods get
  `nexus-<nexus_id>`. Safe to bookmark.
- **`district` is never null**: anywhere outside every district polygon is
  Badlands (the game's own default). `subdistrict` may be null.
- **Additive versioning:** new fields may appear within `/v1/`; breaking
  changes would ship as `/v2/`. Which additive changes have landed is readable
  from `/v1/health`'s `version` — see [Versioning](#versioning).

## Routes

| Route | Returns |
| --- | --- |
| `GET /v1/health` | `{ status, version, last_refresh_at, refresh_age_seconds }` (uncached) |
| `GET /v1/locations` | all locations (full records) as an array |
| `GET /v1/locations?full=1` | identical to `/v1/locations` (`full=1` is a no-op alias kept for older consumers) |
| `GET /v1/locations/{id}` | one location record, or 404 |
| `GET /v1/districts` | district/subdistrict hierarchy (flat boundaries + centroids) |
| `GET /v1/tags` | tag id → description |
| `GET /v1/meta` | `{ discovery_stale, skipped }` (operational health flags) |

There is a **single location representation**: every record carries all fields.
Consumers derive any aggregate (per-district counts, category breakdown, recency
counts) by grouping these records locally; the API does not ship precomputed
aggregates.

A location record:

```json
{
  "id": "nexus-27618",
  "name": "Atari Canyon - Blade Runner",
  "nexus_id": "27618",
  "coordinates": [-2229.57, 3618.96, 12.22],
  "yaw": 180.0,
  "category": "new-location",
  "tags": ["nczoning", "corpo"],
  "authors": ["SomeModder"],
  "source": "auto",
  "district": "City Center",
  "subdistrict": "Corpo Plaza",
  "recently_updated": true,
  "description": "…",
  "credits": "Optional team name",
  "thumbnail_url": "https://…",
  "picture_url": "https://…",
  "updated_at": "2026-07-02T12:00:00.000Z",
  "archives": ["Atari AIO.archive"]
}
```

- `recently_updated` is server-computed: `true` when `updated_at` is within
  `recently_updated_days` (on the envelope). It's the answer a clockless in-game
  consumer can't compute for itself, so the server provides it.
- `credits` appears only when set; `thumbnail_url` / `picture_url` / `updated_at`
  are `null` when unknown (e.g. WIP/Dummy entries with no Nexus page, which are
  also never `recently_updated`).
- `archives` is the list of the mod's detectable install files — `.archive` load
  files and `.xl` (ArchiveXL) files (the latter is the only fingerprint a
  removal-only mod has). Both live in `archive/pc/mod/`. **Match these against the
  player's `archive/pc/mod/` folder to detect which location mods are installed.**
  Names are the bare filename (`Atari AIO.archive`), not a path, so
  a case-sensitive set-membership test against the folder listing is all a
  consumer needs. It's always present — `[]` means "not determinable / not yet
  fetched", never "ships no archives" (freshly added mods fill in over a few
  cron ticks; see the note below).

## Versioning

Three separate numbers travel with this API. They answer different questions,
so don't substitute one for another:

| Signal | Where | Moves when |
| --- | --- | --- |
| `/v1` path prefix | every route | **only** on a breaking change (→ `/v2`) |
| `version` | `GET /v1/health` | the API's *shape* changes — SemVer, see below |
| `dataset_version` | every envelope | the *content* changes (it's a hash, and the `ETag`) |

`version` is SemVer for the API surface.

> ⚠️ **The API is currently pre-1.0 (`0.3.0`), and the rules below are inverted
> while it is.** The surface was rolled back from `1.3.0` because nothing
> consuming it has shipped yet, and the upcoming admin/D1 work takes shape
> changes rather than deferring them. On a 1.x line each of those would need
> MAJOR plus a `/v1` → `/v2` move, standing up a parallel surface with no
> consumers to preserve.
>
> **While on `0.x`:** breaking → **MINOR**, additive → **PATCH**, and **the path
> stays `/v1` throughout** — SemVer permits breaking changes before 1.0, which is
> what makes this resolve cleanly. Pin to a shape you have read, not to `/v1`
> alone.
>
> `1.0.0` returns the day the first in-game mod ships, and the rules below resume
> in full from there.

From `1.0.0` onward:

- **MAJOR** — a breaking change. This also moves `/v1` → `/v2`, so a consumer
  pinned to a path prefix never silently breaks.
- **MINOR** — an additive field or route. Safe: existing consumers are
  unaffected, but a new field is now available.
- **PATCH** — a behaviour or performance fix worth marking a deploy for, with
  no change to the shape.

So a consumer can read `/v1/health` once and know whether the field it wants
exists yet, without probing for it.

The three additive changes the surface has taken, in order:

| Shape change | Under the 1.x numbering | Now |
| --- | --- | --- |
| the initial `/v1` surface | 1.0.0 | 0.0.0 |
| `recently_updated`, `recently_updated_days` | 1.1.0 | 0.1.0 |
| `archives` | 1.2.0 | 0.2.0 |
| `last_refresh_at`, `refresh_age_seconds` on `/v1/health` | 1.3.0 | **0.3.0** *(current)* |

The rollback is mechanical: the MINOR digit is preserved and the MAJOR drops, so
the three changes already made survive as `0.3.0`.

**Honesty note:** the marker was a static `0.1.0` until the SemVer policy landed,
so live deploys through the site's 1.6.0 release all reported `0.1.0` regardless
of shape ([#857](https://github.com/nczoning/nc-zoning-board/issues/857)). The
policy backfilled it to `1.3.0`, which shipped in 1.7.0 — and it has now been
rolled back to `0.3.0`. The middle column above is a reconstruction (what each
deploy *should* have served); the right-hand column is what the API serves today.

⚠️ **`0.3.0` is numerically lower than the `1.3.0` recent deploys served.**
Nothing compares this field numerically — verified before the rollback — but a
consumer that starts doing so must not read the decrease as a downgrade.

### Not to be confused with `ApiVersion()`

The in-game **NCZoningCore** mod exposes its own `ApiVersion()` — an integer
that increments **only on a breaking change**, so redscript consumers can gate
on compatibility. This API's `version` is a *deploy and shape marker* that moves
on additive changes too. They are unrelated numbers and will not match.

### For maintainers

`API_VERSION` is declared in four places that must agree — `wrangler.jsonc`
(production **and** staging; named Wrangler environments don't inherit `vars`),
`openapi.json` `info.version`, and `package.json`. After bumping all four:

```bash
cd worker && npm run version:lock
```

`worker/test/api-version.test.js` fails the deploy gate if the four disagree, or
if `openapi.json`'s machine-readable shape moved without a bump. Prose-only
edits (descriptions, summaries, examples) don't count as a shape change.

## Caching

Dataset routes send:

```
ETag: "87cc60cf7332…"
Cache-Control: public, max-age=300, stale-while-revalidate=3600
```

Store the `dataset_version` from your last fetch and send it back as
`If-None-Match`. If nothing changed you get a **`304 Not Modified`** with no
body: the cheap path. The data changes at most a few times a day, so one
fetch per game session (plus an optional occasional re-check) is plenty.

Before the very first dataset build a route returns **`503 not_ready`**:
retry shortly.

## Using it from a mod

The API is designed for the **RedHttpClient + RedData** stack (see the
NCZoningCore framework). Minimal redscript:

```swift
import RedHttpClient.*
import RedData.Json.*

// DTO - field names match the JSON exactly (case-sensitive).
public class NCZLocation {
  let id: String;
  let name: String;
  let coordinates: array<Float>;   // [X, Y, Z] raw CET
  let category: String;
  let district: String;
  let subdistrict: String;
  let recently_updated: Bool;      // server-computed; no client clock needed
}

public class NCZExample extends ScriptableSystem {
  private func Fetch() {
    let cb = HttpCallback.Create(this, n"OnLocations");
    AsyncHttpClient.Get(cb, "https://api.nczoning.net/v1/locations");
  }

  private cb func OnLocations(response: ref<HttpResponse>) {
    // Runs on a worker thread - parse/store here, apply game changes on the
    // next tick via DelaySystem.
    let root = response.GetJson();          // the envelope
    let data = (root as JsonObject).GetKey("data") as JsonArray;
    let i = 0u;
    while i < data.GetSize() {
      let loc = FromJson(data.GetItem(i) as JsonObject, n"NCZLocation") as NCZLocation;
      FTLog(s"\(loc.name) @ \(loc.district)");
      i += 1u;
    }
  }
}
```

From **CET (Lua)**, use `NewProxy` for the callback and CET's own
`json.decode` on `response:GetText()` if you're not using RedData.

**Threading note:** RedHttpClient delivers callbacks on a worker thread, not
the game thread. Parse and store there; bounce any game/UI mutation to the
next tick (DelaySystem / a Codeware event). Send `If-None-Match` to avoid
re-downloading unchanged data.

## Notes

- The API never talks to Nexus on your behalf at request time: a cron
  rebuilds the dataset every 5 minutes and serves it from cache, so you're
  shielded from Nexus API hiccups. If a refresh fails, `meta.discovery_stale`
  is `true` and the last-known-good data is served.
- Freshness vs. liveness: the envelope's `generated_at` is the *content* time —
  it only moves when the dataset changes (a few times a day), so it can be hours
  old on a perfectly healthy API. To tell whether the refresh cron is still
  *running*, read `/v1/health.last_refresh_at` (or the server-computed
  `refresh_age_seconds`): it advances on every cron cycle. A heartbeat that stops
  advancing means the cron has wedged and the data is silently frozen.
- `meta.skipped` lists mods tagged `NCZoning` whose metadata block didn't
  parse: useful if you're a mod author debugging why yours isn't appearing.
- `archives` is near-static, so the cron fetches it lazily: a mod's archive
  names are (re)fetched only when its Nexus `updated_at` changes, and a fresh
  dataset back-fills them a batch per cron tick rather than all at once. A newly
  added mod can therefore show `archives: []` for a short window before its names
  land. A small residual stays `[]` (loose-file mods with no `.archive`, or
  WIP/Dummy entries with no Nexus page). Either way, treat `[]` as "unknown",
  never "ships no archives".
- `recently_updated` rides the content hash: because it depends on the clock,
  a location crossing the `recently_updated_days` boundary changes
  `dataset_version` (and the `ETag`) even when nothing on Nexus changed, so a
  conditional GET correctly sees the flip rather than a stale `304`.
