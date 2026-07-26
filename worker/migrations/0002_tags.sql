-- Phase 4b: tags become registry data in D1 instead of a JSON file in git.
--
-- Apply to BOTH databases (named environments inherit nothing):
--   npx wrangler d1 migrations apply nczoning-data --remote
--   npx wrangler d1 migrations apply nczoning-data-staging --env staging --remote
--
-- ADDITIVE ONLY. `locations.tags` is deliberately left in place: the
-- materializer switches to the join, the parity gate proves it produces
-- byte-identical output, and only then does a later migration drop the column.
-- Dropping it here would make the join simultaneously the new source of truth
-- and unverifiable.
--
-- The tag rows below are GENERATED from data/tags.json, not hand-transcribed,
-- so the descriptions cannot drift during the transition.

-- slug is the primary key rather than a surrogate integer, because it is
-- already the identifier everywhere else: location records carry
-- tags: ["entropism"]. An integer key would create a SECOND identifier for the
-- same thing, which is the redundant-representation problem this work removes.
CREATE TABLE tags (
  slug TEXT PRIMARY KEY,
  -- Display label. NULL falls back to the slug, which is exactly today's
  -- behaviour: utils.js renders the raw tag string as the badge, so the
  -- identifier and the label are currently the same string. Splitting them is
  -- the point of the move -- "neomilitarism" can be shown as "Neo-Militarism"
  -- without the identifier ever moving, which is what made renaming feel risky.
  name TEXT,
  description TEXT NOT NULL,
  sort_order INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

-- A join table rather than the JSON array, because referential integrity is the
-- main reason for the move: a typo'd tag is currently caught by
-- scripts/validate_tags.js in CI on a data PR, long after the edit.
--
-- ON UPDATE CASCADE covers the rare case where a slug genuinely must change (a
-- typo): one update propagates. That is a link-breaking event done
-- consciously; routine relabelling is what `name` is for.
CREATE TABLE location_tags (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  tag_slug    TEXT NOT NULL REFERENCES tags(slug) ON UPDATE CASCADE,
  PRIMARY KEY (location_id, tag_slug)
);

-- The materializer joins per location on every cron tick.
CREATE INDEX idx_location_tags_tag ON location_tags (tag_slug);

-- Seeded in data/tags.json order. `nczoning` is NOT here, deliberately: it is a
-- marker auto-discovery adds to every Nexus-sourced record, not a registry
-- entry an admin curates, and utils.js special-cases its description. Putting
-- it here would make it editable and deletable, and deleting it would break
-- every auto-discovered record's tag list.
INSERT INTO tags (slug, name, description, sort_order, created_at, updated_at) VALUES
  ('entropism', NULL, 'The look of poverty that derives from humans grappling with and struggling against technology and its unforgiving advance. It denotes a lack of design blending with a general poverty of means and ideas.', 1, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('kitsch', NULL, 'The look of a long lost golden age on people entirely unwilling or unable to forget it. It''s flashy, bold and usually cheap - filled with gold-plated cyberware, implants encased in brightly colored plastic and larger-than-life makeup.', 2, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('neomilitarism', NULL, 'The look of global conflict and corporations jockeying for power. Cold, sharp and modern. Making everyone look as if they are ready to drop out of an AV''s cargo door and head straight into combat.', 3, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('neokitsch', NULL, 'The look of infinite wealth and vanity. Synonymous with luxury, it has been blossoming among Night City''s wealthiest elites - those who can afford to buy anything, who can afford to be anything they want to be.', 4, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('shop', NULL, 'A retail location to purchase weapons, clothing, items, etc.', 5, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('infrastructure', NULL, 'Roads, bridges, parking structures, and public works.', 6, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('entertainment', NULL, 'Bars, clubs, casinos, and nightlife venues.', 7, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('apartment', NULL, 'A player housing unit, usually a smaller dwelling within a megabuilding or high-rise.', 8, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('house', NULL, 'A standalone player dwelling or safehouse structure.', 9, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('quest', NULL, 'A location closely tied to custom gigs, missions, or storylines.', 10, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('streetkid', NULL, 'Environments resonating with gang culture, neon lights, and urban survival.', 11, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('corpo', NULL, 'High-end corporate architecture, slick aesthetics, and security-focused areas.', 12, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('nomad', NULL, 'Off-the-grid, scrapyard, desert, or vehicular-based habitats.', 13, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'),
  ('photos', NULL, 'Scenic or atmospheric locations well-suited for virtual photography.', 14, '2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z');

-- Populate the join from the JSON column that is still present. json_each
-- unpacks the array; the IN clause drops anything not in the registry, which is
-- exactly how the synthetic 'nczoning' marker is excluded without naming it.
INSERT INTO location_tags (location_id, tag_slug)
SELECT l.id, je.value
FROM locations l, json_each(l.tags) je
WHERE je.value IN (SELECT slug FROM tags);
