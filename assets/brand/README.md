# Brand kit — parked / source assets

Brand assets that are **not currently wired into the site**, kept here so they
stay version-controlled and out of the runtime `assets/img/` directory (where
everything is assumed live). Nothing in this folder is fetched by the app.

When you activate one of these, move it into the appropriate runtime location
(`assets/img/…`) and reference it from there.

| Asset | What it is | Status |
| --- | --- | --- |
| `nightcorp-monogram.svg` | Compact Night Corp mark (the `NC` monogram alone, no wordmark). Black fill — recolour before use, same as the header logo. | Parked |
| `shards/shard_*.svg` | Candidate geometric "shard" UI icons (hex/shard motifs). Not yet assigned to any UI role. | Parked |
| `favicon-gold/` | Full Gold-tinted favicon set (SVG + ico + PNGs + apple-touch + manifest) — colour variant of the active Cyan set. Wire up by moving it under `assets/img/favicon/` and pointing the `<head>` links at it. | Parked |

## Active brand assets (for reference — these live outside this folder)

- **Header logo:** `assets/img/nightcorp-logo.svg` (per-theme; each theme has its own file)
- **Favicon (active):** `assets/img/favicon/` (Cyan set)
- **Display font (Tier 0):** `assets/fonts/NightCorpDisplay-Regular.{woff2,otf}`

See `docs/branding.md` for the full brand guidelines and typography tiers.
