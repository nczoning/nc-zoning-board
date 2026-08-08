-- Splits a Nexus page's archive listing by download, so two locations sharing
-- one page can be served different file lists.
--
-- The old model was `nexus_cache.archives` keyed by nexus_id alone, attached to
-- every location with that nexus_id. That encodes "one Nexus page = one mod =
-- one location". Page 23896 (Watson Tattoo Shops) violates it: two separate
-- downloads, two registry records, and each record was served all six files
-- from both. Core reads that list to decide whether a location is installed, so
-- each record reported INSTALLED whenever the player had either download.
--
-- Measured before choosing the trigger: 229 of 294 pages have more than one
-- download (main plus updates and optional patches, all one location), but
-- exactly 1 page maps to more than one location. So the split is keyed off
-- "how many locations point at this page", which the board computes itself,
-- and NOT off "how many downloads does this page have", which would interrogate
-- 78% of the registry for no reason.

-- Archive names grouped by the download they came from:
--   {"Watson Little China Tattoo Shop": ["Watson Little China Tattoo Shop.archive", ...], ...}
--
-- `archives` (the flat union) stays and stays authoritative for every page that
-- maps to a single location, which is all but one of them. This column is the
-- breakdown that lets a contested page be split, not a replacement.
ALTER TABLE nexus_cache ADD COLUMN archives_by_file TEXT;

-- Which download(s) on the page this location is. JSON array of Nexus file
-- NAMES, e.g. ["Watson Little China Tattoo Shop"].
--
-- Names, not `uri`s: a uri embeds version and upload timestamp
-- (`Watson Little China Tattoo Shop-23896-1-2-1757287730.zip`) and changes on
-- every re-upload, so a stored uri would go stale the first time the author
-- posts an update. The display name repeats across versions and is what the
-- author actually names the download.
--
-- NULL means "not mapped", which is the correct state for the ~295 locations
-- that are the only record on their page: they take the whole union and this
-- column is never consulted.
ALTER TABLE locations ADD COLUMN nexus_files TEXT;
