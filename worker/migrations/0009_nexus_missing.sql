-- Pinned mods Nexus has stopped returning, and for how long.
--
-- WHY. A location whose mod is deleted or hidden on Nexus keeps its pin: with
-- D1 as the registry it is a row, and rows persist. Before D1 an
-- auto-discovered mod that vanished simply stopped appearing in the tag query
-- and fell off the map on its own. Nothing replaced that (#900).
--
-- THE SIGNAL ALREADY EXISTS AND WAS BEING DISCARDED. Every sweep asks Nexus
-- about every pinned mod that carries no NCZoning tag (`needBackfill` in
-- nexus-cache.js) and keeps only the ones it got back. The ids it asked for and
-- did not get are exactly the set this table tracks. No new query, no new fetch.
--
-- WHY A TABLE AND NOT COLUMNS ON `nexus_cache`. Two reasons, both load-bearing:
--
--   * A pinned mod can be in `needBackfill` with NO `nexus_cache` row at all --
--     a location submitted with the id of a mod that was already gone has never
--     had a successful fetch, so nothing ever inserted it. Columns on the cache
--     would need a skeleton row of nulls per missing mod, inserted through the
--     write gate that exists to avoid exactly that kind of write.
--   * `nexus_cache` is a cache: every column in it is a value Nexus gave us, and
--     it is safe to drop and refill. A dismissal is an admin's decision and is
--     not recoverable from Nexus. Storing the two together would make the cache
--     un-droppable.
--
-- NO ROW MEANS HEALTHY. A sweep that gets the mod back deletes the row rather
-- than zeroing it, so the table holds only the mods currently in trouble (a
-- handful, usually none). That is also why there is no index: a full scan of a
-- table this size costs less than maintaining one.
--
-- IT NEVER TOUCHES `locations.status`. The issue is explicit: no auto-hide. The
-- only writers of `status` are the admin editor and an approved removal, both
-- human-driven. This table feeds a review list and an alert; a person decides.
--
-- `miss_streak` COUNTS CONSECUTIVE SWEEPS, not total misses. `fetchModsByUidThumbs`
-- returns {} on failure and cannot distinguish "these mods are gone" from
-- "Nexus is down", so a single sweep proves nothing and only persistence does.
-- Any successful fetch deletes the row and the count starts again from one.
--
-- `missing_since` IS THE START OF THE CURRENT STREAK, not the first time the
-- mod was ever missed. The flag threshold reads it as a duration, which is what
-- makes the rule independent of how often the cron happens to run.

CREATE TABLE nexus_missing (
  nexus_id       TEXT PRIMARY KEY,
  miss_streak    INTEGER NOT NULL,  -- consecutive sweeps that asked and got nothing
  missing_since  TEXT NOT NULL,     -- first sweep of the current streak
  last_missed_at TEXT NOT NULL,     -- most recent sweep of the current streak
  flagged_at     TEXT,              -- crossed the threshold; NULL = still just counting
  dismissed_by   TEXT,              -- admin who said "not a problem"
  dismissed_at   TEXT
);
