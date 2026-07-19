# Nexus Mods V2 GraphQL API Reference

This document covers the Nexus Mods GraphQL API implementation used by NC Zoning Board: the two queries we use, the limitations of the public API, caching strategy, and known risks.

## Overview

**Endpoint:** `https://api.nexusmods.com/v2/graphql`

**Official Documentation:** https://graphql.nexusmods.com/

**Authentication:** None required. The V2 API returns only public mod data; no credentials are needed.

**Status:** ⚠️ **Technically Unsupported**

The V2 API is not officially supported by Nexus Mods. Per direct conversation with Nexus Mods staff (Pickysaurus), they intend to eventually migrate back to REST. The auto-discovery + thumbnail fetches run **entirely server-side** in [`worker/src/nexus.js`](../worker/src/nexus.js) (the Data API cron); the client-side copy that once lived in `services.js` has been removed, so the browser makes **no Nexus calls at all** — it consumes the server-built `/v1` dataset. The queries below are what the worker sends. Monitor [Nexus announcements](https://www.nexusmods.com) for any V2 retirement notices.

**Rate Limits:** No rate limits are publicly documented for V2 GraphQL, and none have been encountered in practice. For scale: the REST API's documented limits are **20,000 requests/day + 500 requests/hour**. Our 5-minute cron makes ~8 Nexus requests/run → ~96/hour (~2,300/day), comfortably under either figure.

### Nexus API v3 (REST): reviewed 2026-07-05, NOT a replacement for our discovery

Nexus published an official REST **API v3** (`https://api.nexusmods.com/v3`; OpenAPI at `https://api.nexusmods.com/openapi.yaml`; docs at <https://api-docs.nexusmods.com/>). It requires authentication (API key or OAuth JWT) and has a real stability + deprecation policy (stable endpoints get a 90-day notice). **But it does not replace what we depend on.** v3 is a mod *publishing / management* API: uploads, mod-files, versions, collections. Its only read operations are `getMod` / `getModsBatch` (by id) and `getTrendingMods`; there is **no "mods by tag" or mod-search endpoint**, and the spec surfaces no mod image/description fields. Our auto-discovery ("find every mod tagged `NCZoning`") exists **only** in V2 GraphQL, so V2 stays required and there is no v3 migration path for it today.

**Watch for:** (a) v3 gaining a mods-by-tag / search endpoint → a migration becomes possible; or (b) a V2 GraphQL retirement announcement → we'd need a new discovery mechanism (e.g. author self-registration), since v3 can't do tag discovery. Note: if we ever adopt v3, its API key must live **server-side** in the Worker cron (it can't go in the browser), which the B7 server-side move already accommodates.

## Queries Used

### 1. `modsByUid`: Thumbnail Fetch for Manual Mods

**Purpose:** Fetches featured images (`pictureUrl`, `thumbnailUrl`) for manually registered mods.

**Query:**

```graphql
query modsByUid($uids: [ID!]!, $count: Int!) {
  modsByUid(uids: $uids, count: $count) {
    nodes {
      modId
      pictureUrl
      thumbnailUrl
      updatedAt
    }
  }
}
```

**Input Variables:**
- `uids`: Array of composite Nexus UIDs (see UID Construction below)
- `count`: **Must equal the number of UIDs requested** ⚠️

**UID Construction:**

Nexus V2 uses a composite BigInt UID format. From [`constants.js`](../assets/js/constants.js), the conversion is:

```javascript
toNexusUid(modId) {
  return (BigInt(3333) << BigInt(32)) + BigInt(modId)
}.toString()
```

Where `3333` is the game ID for Cyberpunk 2077.

**Output Fields per Node:**
- `modId`: The numeric Nexus mod ID
- `pictureUrl`: URL to the featured image (full resolution)
- `thumbnailUrl`: URL to a thumbnail version of the featured image
- `updatedAt`: ISO 8601 timestamp of the mod's last update on Nexus; used to drive the recently-updated badge

**Pagination:** Chunked into batches of `NCZ.NEXUS_BATCH_SIZE` (50), dispatched in parallel via `Promise.all`. Single large requests are silently truncated by the API even when `count` is set correctly (see Silent Result Cap below).

**⚠️ Silent Result Cap:**

The Nexus API silently truncates `modsByUid` responses for large batches:

- **Fixed 2026-03-13:** If the `count` variable is omitted, only the first 20 results are returned regardless of UID count. Mitigation: always pass `count: validIds.length`.
- **Fixed 2026-05-04:** Even with `count` set correctly, batches of ~250 UIDs return only a partial subset of nodes, manifesting as missing pin thumbnails on first page load that "self-heal" on subsequent reloads (incremental cache fills the gaps as each retry sends a smaller batch). Mitigation: chunk into 50-UID batches before dispatch. Live testing showed *residual* per-UID flakiness even at chunk sizes well below 50, so each chunk also gets a single in-flight retry of just the dropped UIDs before the result is returned. Two warnings are logged for visibility:
  - `Thumbnails: chunk dropped X/Y UIDs (...); retrying`: first attempt dropped some UIDs; will be retried automatically.
  - `Thumbnails: N UIDs still missing after retry (...); likely deleted or hidden on Nexus`: both attempts failed for these UIDs. Persistent appearance of the same UIDs across reloads indicates a stale `nexus_id` in `data/locations/*.json` (mod hidden or deleted).

**Caching:** Handled server-side by the Data API cron (the browser no longer caches Nexus responses); see [Caching Strategy](#caching-strategy) below.

**Implementation:** [`fetchNexusThumbnails()` in worker/src/nexus.js](../worker/src/nexus.js)

---

### 2. `NCZoningMods` (`mods`): Auto-Discovery Query

**Purpose:** Finds all mods on Nexus Mods for Cyberpunk 2077 that have been tagged `NCZoning` by their authors. These mods' descriptions are parsed for an `[NCZoning]` metadata block.

**Query:**

```graphql
query NCZoningMods($filter: ModsFilter!, $count: Int!, $offset: Int!) {
  mods(filter: $filter, count: $count, offset: $offset) {
    nodes {
      modId
      name
      summary
      description
      pictureUrl
      thumbnailUrl
      updatedAt
      uploader {
        name
      }
    }
    totalCount
  }
}
```

**Input Variables:**
- `filter.gameId`: `[{ value: "3333" }]` (Cyberpunk 2077)
- `filter.tag`: `[{ value: "NCZoning" }]`
- `count`: Results per page (see Pagination below)
- `offset`: Current page offset

**Output Fields per Node:**
- `modId`: Numeric Nexus mod ID
- `name`: Mod title
- `summary`: Short description; used as the pin popup description (truncated to 500 chars)
- `description`: Full mod description; parsed for `[NCZoning]` metadata block
- `pictureUrl`: Featured image URL (full resolution)
- `thumbnailUrl`: Featured image thumbnail URL
- `updatedAt`: ISO 8601 timestamp of the mod's last update on Nexus; used to drive the recently-updated badge
- `uploader.name`: Nexus username of the mod author (used as first author)
- `totalCount`: Total number of mods matching the filter (used for pagination loop)

**Pagination: Offset-Based (Undocumented)**

The Nexus API does not document pagination for the `mods` query, but it supports offset-based paging:

- Page size: 50 mods per request (`NCZ.NEXUS_BATCH_SIZE`)
- Loop: `while (offset < totalCount)`
- Exit conditions:
  - `nodes.length === 0` (empty page)
  - `nodes.length < COUNT` (short final page)
  - `page` is absent from response
  - Network or parse error

**Caching:** Handled server-side by the Data API cron (the browser no longer caches Nexus responses); see [Caching Strategy](#caching-strategy) below.

**Post-Fetch Processing:**
1. For mods whose `modId` already exists in manual `mods.json`: collect `pictureUrl`, `thumbnailUrl`, and `updatedAt` into a `meta` map keyed by `nexusId`, then skip (manual entry wins for all other data)
2. Parse `node.description` for `[NCZoning]` metadata block (see [`parseNcZoningBlock()`](../worker/src/parse.js) in worker/src/parse.js)
3. If block missing or invalid, skip the mod with a log message
4. Construct authors array: Nexus uploader name + any additional authors from the block
5. Truncate `summary` to 500 characters for the popup description
6. Prepend `"nczoning"` tag automatically (identifies auto-discovered mods in the UI)
7. Store `updatedAt` as `_updatedAt` on the mod object; if within `NCZ.RECENTLY_UPDATED_DAYS` days, an `UPDATED` badge is shown in the popup, sidebar, and cluster flyout

The function returns `{ mods, meta }` where `meta` contains image/timestamp data for manually registered mods that are also NCZoning-tagged. In the worker's merge step ([`worker/src/merge.js`](../worker/src/merge.js)), `meta` is folded into each manual mod's thumbnail/`updated_at` fields without a separate `modsByUid` call. Mods covered by `meta` are excluded from the `modsByUid` batch.

**Implementation:** [`fetchNexusTaggedMods()` in worker/src/nexus.js](../worker/src/nexus.js)

---

## Image Availability Limitation ⚠️

**Only the featured/header image is available via the public API, for now.**

Both `modsByUid()` and `mods()` queries return only:
- `pictureUrl`: the mod's featured image (full resolution)
- `thumbnailUrl`: a thumbnail-sized version of the same featured image

**Full mod image galleries are NOT currently accessible** without authenticated/private API access.

This limitation has been **confirmed directly with Nexus Mods staff (Pickysaurus)**. Per Pickysaurus, featured image only is a "for now" limitation: full mod image galleries may be added to the public API in the future.

**Current design implication:** The UI can only display the single featured image per mod from Nexus. Manual mod entries can link to external image galleries in their `description` field or credits if needed.

---

## Caching Strategy

These Nexus calls now run only inside the Data API cron (`worker/`), not the browser — the old client-side `localStorage` caches (`nc_nexus_thumbs`, `nc_nexus_autodiscovery`) are gone. Freshness for the site is driven by the Data API instead:

- **Server side:** the cron re-runs auto-discovery + thumbnail fetches on its schedule and bakes the result into the `/v1` dataset. Nexus responses are not persisted between runs.
- **Browser side:** the site fetches `/v1/locations?full=1` once per load and revalidates with `If-None-Match`/`304` against a single `localStorage` entry (`nc_api_locations_full`). See `fetchLocationsFromApi()` in [`services.js`](../assets/js/services.js).

---

## Error Handling

**`modsByUid` (Thumbnail Fetch):**
- Network/parse errors → `console.warn()` + return empty object `{}`
- No retry logic

**`mods` (Auto-Discovery):**
- GraphQL errors in response → logged with `console.warn()`, loop continues collecting partial results
- Network/parse errors → logged with `console.warn()`, loop stops
- Partial results are still cached and returned

**No automatic retries** are implemented for either query. Transient failures silently return whatever was collected before the error.

---

## Known Risks & Future Considerations

1. **API Retirement Risk:** V2 is unsupported. Monitor for Nexus announcements of REST migration.
2. **Undocumented Pagination:** The `mods` query's offset-based pagination is not documented. Page size and behaviour may change without notice.
3. **No Retry Logic:** Transient network failures don't trigger retries; silent partial results are returned.
4. **Image URLs:** If Nexus changes URL formats or removes images, thumbnails will break without warning.
5. **Image Galleries (Future):** Full mod image galleries may be added to the public API in the future (per Pickysaurus). When that happens, the thumbnail fetch and auto-discovery queries should be revisited to consider caching and displaying gallery images.

---

## References

- **Nexus GraphQL API Docs:** https://graphql.nexusmods.com/
- **Auto-Discovery Workflow:** See [`docs/nczoning-auto-discovery.md`](./nczoning-auto-discovery.md) for how mod authors tag mods and provide metadata
- **Nexus fetch implementation (server-side):** [`worker/src/nexus.js`](../worker/src/nexus.js), merge in [`worker/src/merge.js`](../worker/src/merge.js), block parser in [`worker/src/parse.js`](../worker/src/parse.js)
- **Site data loader:** `fetchLocationsFromApi()` in [`assets/js/services.js`](../assets/js/services.js)
