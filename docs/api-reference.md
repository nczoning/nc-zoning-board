# NC Zoning Data API reference

Read-only API serving the NC Zoning Board registry (Cyberpunk 2077 location
mods) to in-game mods and the website.

- **Production:** `https://api.nczoning.net`
- **Staging:** `https://api-dev.nczoning.net` (serves the dev site's data)
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
  "data": <route-specific>
}
```

`dataset_version` is a content hash of the whole dataset. It's also the
`ETag`, so it's how you detect changes (see [Caching](#caching)).

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
  changes would ship as `/v2/`.

## Routes

| Route | Returns |
| --- | --- |
| `GET /v1/health` | `{ status, version }` (uncached) |
| `GET /v1/locations` | all locations, slim |
| `GET /v1/locations?full=1` | all locations, full (adds `description`, `credits`, image URLs): one request for everything |
| `GET /v1/locations/{id}` | one full entry (adds `description`, `credits`, image URLs), or 404 |
| `GET /v1/districts` | district/subdistrict hierarchy (flat boundaries + centroids) |
| `GET /v1/tags` | tag id → description |
| `GET /v1/meta` | `{ counts, discovery_stale, skipped }` |

A location (slim):

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
  "subdistrict": "Corpo Plaza"
}
```

Full entries (`/v1/locations/{id}` or the whole list via `/v1/locations?full=1`)
add `description`, `credits` (if present), and the Nexus image fields
`thumbnail_url` / `picture_url` / `updated_at` (each `null` when unknown, e.g.
WIP/Dummy entries). Images live on the full entry only; the slim list stays
lean for the in-game RedData consumer. The `?full=1` list carries its own ETag
(the dataset version suffixed `-full`), so caching it never collides with the
slim list.

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
  rebuilds the dataset every 15 minutes and serves it from cache, so you're
  shielded from Nexus API hiccups. If a refresh fails, `meta.discovery_stale`
  is `true` and the last-known-good data is served.
- `meta.skipped` lists mods tagged `NCZoning` whose metadata block didn't
  parse: useful if you're a mod author debugging why yours isn't appearing.
