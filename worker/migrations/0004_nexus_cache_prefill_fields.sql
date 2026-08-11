-- The two fields auto-discovery took straight from the Nexus mod, so the submit
-- form can offer the same prefill the tag used to publish on its own.
--
-- merge.js builds an auto-discovered record from the tagged node: `description`
-- from `summary`, truncated to DESCRIPTION_MAX (merge.js:83), and `authors`
-- from `uploader.name` plus any extra names in the block (merge.js:73). The
-- tagged query fetches both on every sweep and nexus_cache kept neither, so the
-- candidates list could name a mod and nothing else. Without these columns the
-- queue replacing auto-discovery would take that prefill away from submitters
-- rather than keep it.
--
-- Nullable, and backfilled by the next sweep rather than by this migration:
-- both join the tracked set, so the first sweep after deploy sees every tagged
-- row differ and writes it once. Rows that reach the table through the
-- modsByUid backfill (a location that is not tagged) carry neither and are not
-- candidates, so nulls there are correct rather than missing.

-- The mod's short description, shown under its title on the Nexus page.
ALTER TABLE nexus_cache ADD COLUMN summary TEXT;

-- The Nexus account that uploaded the mod, which is the first author on every
-- auto-discovered record. A submitter can edit it and add co-authors: the
-- uploader is not always the only person credited.
ALTER TABLE nexus_cache ADD COLUMN uploader TEXT;
