-- D1 schema, Phase 1. Source of truth for the location registry; the KV
-- dataset stays the read path (materialized from here, see docs/data-api-plan.md).
--
-- Applied to BOTH databases. Named Wrangler environments do not inherit
-- bindings, so staging has its own database and every migration runs twice:
--   npx wrangler d1 migrations apply nczoning-data         --remote
--   npx wrangler d1 migrations apply nczoning-data-staging --remote
--
-- Phase 1 populates `locations` and `dismissed_candidates` only. The remaining
-- tables are created now because they are one schema, not because anything
-- writes them yet.

-- Replaces data/locations/*.json. (excluded_mods.json is NOT a location state --
-- it becomes dismissed_candidates below.)
CREATE TABLE locations (
  id          TEXT PRIMARY KEY,   -- existing UUIDs preserved; nexus-<id> for imports
  name        TEXT NOT NULL,
  nexus_id    TEXT,
  category    TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, z REAL, yaw REAL,
  description TEXT, credits TEXT,
  authors     TEXT,               -- JSON array
  tags        TEXT,               -- JSON array at Phase 1 (imported as-is);
                                  -- normalised to location_tags at Phase 4
  -- How the record first reached the map. NOT in the plan's schema listing,
  -- added because `source` is a *served* field on every /v1 record
  -- (worker/src/merge.js) -- the source of truth has to hold it or the Phase 1
  -- parity gate cannot reproduce the output. Deriving it from an `id LIKE
  -- 'nexus-%'` prefix would work today and rot the first time an admin-created
  -- record is given a nexus id.
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  status      TEXT NOT NULL DEFAULT 'published'
              CHECK (status IN ('published', 'hidden', 'draft')),
                                  -- hidden = pulled from the map, record kept
                                  -- (e.g. mod deleted from Nexus)
  admin_notes TEXT,               -- admin-only, never served on /v1
  owner_id    INTEGER,            -- NULL for now; the author-self-service hook
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- The materializer filters on status and the candidates query anti-joins on
-- nexus_id; both run on every cron tick.
CREATE INDEX idx_locations_status ON locations (status);
CREATE INDEX idx_locations_nexus_id ON locations (nexus_id);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,             -- create | edit | remove
  location_id TEXT,               -- NULL for create
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitter_note TEXT, submitter_contact TEXT, submitter_ip_hash TEXT,
  reviewed_by TEXT, reviewed_at TEXT, review_note TEXT,
  created_at TEXT NOT NULL
);

-- Append-only. This is what replaces `git log` for data changes.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL,
  actor TEXT NOT NULL,            -- github login, or 'system' for cron
  action TEXT NOT NULL,           -- location.update | submission.approve | ...
  target TEXT, before TEXT, after TEXT
);

-- A Nexus mod we have looked at and decided not to put on the map. NOT a
-- location: it has no coordinates, no category, and never was one. Its only
-- job is to keep the mod out of the candidates list. Replaces excluded_mods.json.
CREATE TABLE dismissed_candidates (
  nexus_id TEXT PRIMARY KEY,
  reason   TEXT,                  -- admin-only, same handling as admin_notes
  dismissed_by TEXT NOT NULL, dismissed_at TEXT NOT NULL
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,         -- github user id
  login TEXT NOT NULL, is_collaborator INTEGER NOT NULL,
  checked_at TEXT NOT NULL, first_seen_at TEXT NOT NULL
);

-- Every alert that was posted to Discord, so the dashboard can show history
-- Discord buries. Written by the Worker as it fans out.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL,
  source TEXT NOT NULL,           -- api-health | refresh | submissions | quota
  severity TEXT NOT NULL,         -- info | warn | error | recovery
  title TEXT NOT NULL, body TEXT,
  acknowledged_by TEXT, acknowledged_at TEXT
);

-- Nexus-derived cache. Absorbs today's dataset:v1:archives KV blob,
-- removing a KV read+write per cron tick.
CREATE TABLE nexus_cache (
  nexus_id TEXT PRIMARY KEY, updated_at TEXT,
  thumbnail_url TEXT, picture_url TEXT, archives TEXT, fetched_at TEXT NOT NULL
);
