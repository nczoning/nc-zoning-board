# Caching strategy (Cloudflare Pages)

The site is served by **Cloudflare Pages**. Cache behaviour is controlled by the
[`_headers`](../_headers) file at the repo root, which Pages reads from the build
output. GitHub Pages ignored this file, so none of this applied before the
Cloudflare migration.

## The one rule

There are **two independent caches**, and only one of them is under your control
after the fact:

1. **Cloudflare's edge cache** — shared, on Cloudflare's servers. You can **purge**
   it from the dashboard or API at any time.
2. **The visitor's browser cache** — private, on their machine. You **cannot**
   reach it. It obeys the `Cache-Control` header that was sent *when the file was
   downloaded*, until that instruction expires.

So the rule that drives everything here:

> `immutable` is a promise to the browser that the bytes at this exact URL will
> **never** change. Use it only for content that genuinely never changes at a
> fixed path. Purging Cloudflare does **not** reach browsers that already hold an
> `immutable` copy.

`no-cache` does **not** mean "don't cache". It means "cache it, but revalidate
before reusing". The browser keeps the file and sends a conditional request; if
unchanged, Cloudflare (using an auto-generated content `ETag`) replies `304 Not
Modified` — a few hundred bytes, no re-download. If changed, it sends the new
file. This gives **automatic correctness on update** with almost no bandwidth
cost, which is why it's the default for anything that can change.

## What each asset class gets, and why

| Path | Policy | Why |
| --- | --- | --- |
| `/assets/tiles/*` | `immutable`, 1 year | Thousands of files, content-stable at a fixed path. `immutable` skips even the revalidation round-trip. The *only* class that needs a manual bust on change. |
| `/assets/dds/*` | `no-cache` | Building data textures. Change occasionally as new fixed assets land. ETag revalidation auto-refreshes browsers on deploy — nothing to remember. |
| `/assets/glb-meshopt/*` | `no-cache` | Meshes. Same reasoning as DDS. |
| `/assets/js/*`, `/assets/css/*`, `/index.html` | `no-cache` | Un-hashed filenames that change every deploy. Must revalidate or users run stale code. |

## Maintainer procedures

### Updating or adding DDS building data or GLB meshes

**Nothing to do.** Drop the new/updated file in at its path and deploy. The file's
content ETag changes, browsers revalidate on their next load and pull the new
bytes automatically. This is the whole point of putting these on `no-cache`.

### Changing JS, CSS, or `index.html`

**Nothing to do.** Same automatic revalidation as above.

### Regenerating tiles

This is the **only** case that needs manual action, because tiles are
`immutable` — browsers that already downloaded them will never re-check on their
own. Two steps, both required:

1. **Bump the version token** in the tile URL. In
   [`assets/js/app.js`](../assets/js/app.js), find the `L.tileLayer(...)` call and
   increment the `?v=` number:

   ```js
   L.tileLayer("assets/tiles/{z}/{x}/{y}.webp?v=2", { ... })
   ```

   Changing the query string makes every tile a new URL, so existing browsers
   treat them as never-before-seen and fetch fresh. **Skipping this leaves
   returning visitors on the old tiles for up to a year.**

2. **Purge the Cloudflare edge cache** for the tiles (dashboard → Caching → purge,
   or purge everything). This clears the *shared* cache so first-time and
   cache-busted requests don't get served the old bytes from Cloudflare's edge.

Step 1 fixes returning browsers; step 2 fixes the edge. You need both.

## Dev vs prod caching

The same [`_headers`](../_headers) applies to both the production site and the
dev site (`dev.nczoning.net`), and that's intentional — it keeps the rules a
single source of truth with no per-branch divergence to drift.

This is fine for dev in practice: everything you iterate on (JS, CSS, DDS, GLB)
is `no-cache`, so it always revalidates and you never see stale code or textures.
The only hard-cached class is tiles (`immutable`), which you rarely regenerate on
dev — and DevTools "Disable cache" overrides all of it during active development
anyway.

**If** stale tiles ever become a problem on dev, the fix is a **Cloudflare
Response Header Transform Rule scoped to `dev.nczoning.net`** that overrides
`Cache-Control` to `no-cache` for all responses. Keep this at the dashboard
(platform) layer — do **not** give the `dev` branch a different `_headers` than
`main`, as that reintroduces the exact drift this file exists to prevent. It must
be a *response header* transform, not a cache-bypass rule: bypassing the edge
cache doesn't change the `Cache-Control` the browser receives, so the browser
would still honour `immutable`.

## Where the config lives

- [`_headers`](../_headers) — the actual Cloudflare Pages rules.
- [`assets/js/app.js`](../assets/js/app.js) — the tile `?v=` bust token (with an
  inline comment pointing back here).
