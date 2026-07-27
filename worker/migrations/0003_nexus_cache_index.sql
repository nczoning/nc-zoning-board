-- Makes nexus_cache the Nexus mod index rather than only an image cache, so
-- the candidates list can be a query (tagged, minus locations, minus
-- dismissed_candidates) and the four Nexus-derived /v1 fields can come from a
-- join on locations.nexus_id.
--
-- Safe to ALTER in place: the table held 0 rows in both databases and nothing
-- read or wrote it.

-- Mod title as Nexus reports it. The candidates list has to name a mod that is
-- not a location yet, so no locations row can supply the name.
--
-- Stored for comparison, not display. See the header note in src/nexus-cache.js.
ALTER TABLE nexus_cache ADD COLUMN name TEXT;

-- Whether the mod currently carries the NCZoning tag, recomputed each sweep
-- from the full tagged set so an untagged mod leaves the candidate pool.
--
-- A live property of the Nexus page, unlike locations.source, which records how
-- a record first arrived and is being retired.
ALTER TABLE nexus_cache ADD COLUMN nczoning_tagged INTEGER NOT NULL DEFAULT 0;

-- Only the candidates query selects by this.
CREATE INDEX idx_nexus_cache_tagged ON nexus_cache (nczoning_tagged);
