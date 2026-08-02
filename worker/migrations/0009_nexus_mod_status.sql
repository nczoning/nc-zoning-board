-- What Nexus says about a pinned mod, when it stops saying "published".
--
-- WHY. A location whose mod is deleted or hidden on Nexus keeps its pin: with
-- D1 as the registry it is a row, and rows persist. Before D1 an
-- auto-discovered mod that vanished simply stopped appearing in the tag query
-- and fell off the map on its own. Nothing replaced that (#900).
--
-- NEXUS ANSWERS THIS DIRECTLY, and we were not asking. The `Mod` type carries a
-- `status` field. Measured 2026-08-02 against the live API:
--
--   * `modsByUid` returns deleted and hidden mods like any other. Mod 17513
--     (Starfield) comes back with `status: "wastebinned"`; two mods pinned on
--     our own map come back `hidden` today.
--   * The `mods` SEARCH query returns only published mods. That asymmetry is
--     exactly why auto-discovery used to self-heal and the by-uid backfill does
--     not: the tag query silently dropped a pulled mod, the uid lookup keeps
--     handing it back.
--
-- So absence is the WEAK signal and the rare one. The strong signal is a status
-- string, and this table records how long we have been seeing it.
--
-- THREE STATES, THREE RULES, because they are not the same event:
--
--   * `wastebinned` -- deleted. Unambiguous, so the pin is withheld from the
--     served dataset after a few sweeps confirm it. The ROW IS NOT TOUCHED:
--     the materializer stops building it, `locations.status` still says
--     whatever the admin last set, and a reversal on Nexus restores it with no
--     human involved.
--   * `hidden` -- could be an author mid-upload, could be a DMCA
--     investigation, and THE API WILL NOT SAY WHICH. `Mod` has no moderation
--     field, `moderationWarnings` needs a login, and the mod page 403s. Only a
--     person reading the author's stated reason can decide, so this never
--     changes what is served. It goes on the review list and waits.
--   * absent -- the mod is not in the response at all. Weakest of the three:
--     `fetchModsByUidThumbs` returns {} on failure and cannot distinguish
--     "purged" from "Nexus is down", so this one needs a streak AND a day
--     before it counts as anything.
--
-- NO ROW MEANS FINE. A sweep that sees the mod published again deletes the row
-- rather than zeroing it, so the table holds only the mods currently in
-- trouble. Same for a mod that stops being pinned. That is also why there is no
-- index: a full scan of a table this size costs less than maintaining one.
--
-- `first_seen_at` IS THE START OF THE CURRENT RUN, not the first time the mod
-- was ever seen this way, and NOT Nexus's own `updatedAt`. That field means
-- different things per status (for 17513 it is the deletion; for a hidden mod
-- it can be the last real file update, months earlier), so the only honest
-- answer to "how long has this been wrong" is when we first saw it.
--
-- `status` CHANGING RESETS THE RUN. hidden -> wastebinned is a new fact about
-- the mod, and inheriting the hidden run's clock would let it act on a
-- confirmation it never got.

CREATE TABLE nexus_mod_status (
  nexus_id      TEXT PRIMARY KEY,
  status        TEXT NOT NULL,     -- hidden | wastebinned | absent | any future non-published string
  streak        INTEGER NOT NULL,  -- consecutive sweeps that saw THIS status
  first_seen_at TEXT NOT NULL,     -- first sweep of the current run
  last_seen_at  TEXT NOT NULL,     -- most recent sweep of the current run
  flagged_at    TEXT,              -- crossed its threshold; NULL = still counting
  dismissed_by  TEXT,              -- admin who said "I know, leave it"
  dismissed_at  TEXT
);

-- The status as of the last successful fetch, so the materializer and the
-- dashboard read one value rather than re-deriving it. NULL means never
-- resolved, which is the state of every row until the next sweep runs, and it
-- MUST read as published: a pin may never come down because a field was
-- missing.
ALTER TABLE nexus_cache ADD COLUMN status TEXT;
