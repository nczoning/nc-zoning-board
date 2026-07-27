-- nexus_cache becomes the Nexus mod INDEX, not just an image cache.
--
-- The table was declared at Phase 1 and never populated: 0 rows in both
-- databases, and nothing in the codebase wrote to it. Phase 1 deliberately left
-- the four Nexus-derived served fields (thumbnail_url, picture_url, updated_at,
-- archives) out of the parity gate and fed them in from the live record,
-- recording it as a blind spot to close once this table held something. This is
-- that change.
--
-- Adding `name` and `nczoning_tagged` is what lets the candidates list be a
-- query rather than a live Nexus call on a public unauthenticated route:
--
--   tagged, minus locations, minus dismissed_candidates
--
-- and lets the served Nexus fields come from a join on locations.nexus_id
-- instead of the two-path resolution in materialize.js, where auto-sourced
-- records carried their own images and manual ones were backfilled separately.

-- Mod title as Nexus reports it. Needed for the candidates list, which has to
-- name a mod that is not a location yet and therefore has no row to name it.
ALTER TABLE nexus_cache ADD COLUMN name TEXT;

-- Whether the mod currently carries the NCZoning tag. Recomputed every sweep
-- from the full tagged set, so untagging a mod removes it from candidates
-- rather than leaving it there forever.
--
-- NOT the same question as `source='auto'` on locations, which records how a
-- record first arrived and is being retired. This is a live property of the
-- Nexus page.
ALTER TABLE nexus_cache ADD COLUMN nczoning_tagged INTEGER NOT NULL DEFAULT 0;

-- The candidates query filters on this and nothing else selects by it.
CREATE INDEX idx_nexus_cache_tagged ON nexus_cache (nczoning_tagged);
