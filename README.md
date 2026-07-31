# `data-snapshots`: the location registry's off-Cloudflare backup

**This branch is written by a robot and read by a human once, in an emergency.
Do not merge it, do not branch from it, do not open a PR against it.**

It shares **no history** with `main` or `dev`. `git log` here is a clean
per-record change history and nothing else: no code, no site, no CI.

## What this is

Since the D1 cutover the location registry lives in Cloudflare D1, not in git.
`.github/workflows/export-d1-snapshot.yml` (on `main`) reads that database every
night and commits the result here. A quiet night produces no commit.

| Path | Contents |
| --- | --- |
| `data/locations/<id>.json` | one file per registry record, all statuses, including the `nexus-<id>` records that have never existed as files on `main` |
| `data/excluded_mods.json` | dismissed Nexus candidate IDs, as a bare array |
| `data/tags.json` | the tag registry, as an array of full rows (`slug`, `name`, `description`, `sort_order`, timestamps) |
| `data/audit_log.jsonl` | the audit log, **appended** to, never rewritten. One JSON object per line |

## What is deliberately NOT here

- **`admin_notes` and dismissal reasons.** Both are admin-only and are stripped
  before anything is written, including from the `before`/`after` payloads in
  the audit log, which would otherwise carry them verbatim. Accepted
  consequence: those two fields have no git backup, and D1 Time Travel's 30 days
  is the only one they get.
- **`submissions`, `alerts`, `users`, `nexus_cache`.** Submissions carry
  submitter contact details and an IP hash. `nexus_cache` is fully derived and
  the 5-minute cron rebuilds it.

This is a backup of the **registry**, not of the database.

## Restoring

D1 Time Travel (30-day point-in-time restore) covers "oops, last Tuesday". This
branch covers "the account is gone".

```bash
git clone -b data-snapshots <repo> snapshot
cd <repo-on-main>

# Fresh database: run the migrations first so the tables exist.
cd worker
npx wrangler d1 migrations apply nczoning-data --remote

# --files-only is REQUIRED here. Without it the importer also fetches the live
# API for the auto-discovered records, which are already files in the snapshot,
# and the import dies on the primary key. In a real restore there may be no
# live API to fetch from, which is the point.
node scripts/import-locations.mjs \
  --files-only --data ../../snapshot/data --out .import/restore.sql

# Review it, then execute. Plain INSERTs: running it twice fails rather than
# quietly duplicating.
npx wrangler d1 execute nczoning-data --remote --file .import/restore.sql
```

The final `SELECT` in the generated file prints `locations`, `links` and
`untagged`. `links` must match the count in the file's header comment. If
`links` is 0 the `location_tags` join did not import and every location will
serve untagged, while `locations` looks perfectly correct.

The audit log is **not** restored by the importer. It is history, not registry
state, and re-inserting it would fabricate `id`s that no longer line up. Read it
from this branch.

## If a nightly run fails

The workflow raises an alert with `source: "export"`, which is recorded in D1
and shown in the admin dashboard's Alerts tab, as well as posted to the
map-alerts Discord channel. The Actions run also goes red.
