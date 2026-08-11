/**
 * Write layer for the tag registry. The read side lives in d1.js (`readTags`,
 * `readLocationTags`); this is everything that mutates `tags` and the
 * `location_tags` join.
 *
 * Phase 4b moved tags into D1 but only wired up the read path. Phase 4a's admin
 * writes predate it and set a `locations.tags` JSON column the materializer had
 * stopped reading, so an admin editing tags got a 200 and no change on the map.
 * That is the gap this module closes, and it is why every location write goes
 * through `syncLocationTags` rather than a bare column update.
 *
 * ONE WRITE. `location_tags` is the only representation. The JSON column was
 * kept byte-compatible with the join while migration 0002's additive overlap
 * let the switch be proven byte-for-byte; migration 0007 drops it, so there is
 * no second copy to keep in step.
 */

/** Never a registry row: a marker auto-discovery prepends, not a curated tag. */
export const RESERVED_SLUGS = new Set(['nczoning']);

/**
 * Lowercase, hyphen-separated, no leading/trailing/doubled hyphens.
 *
 * Every existing slug is a bare lowercase word, so this is stricter than the
 * corpus requires. That is deliberate: the slug is a URL parameter and a
 * primary key, and the cost of tightening it later (after someone has deep
 * linked `?tag=Mixed_Case`) is much higher than the cost of tightening it now.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SLUG_MAX = 40;
export const TAG_NAME_MAX = 60;
export const TAG_DESCRIPTION_MAX = 500;

/** Fields an admin may set on a tag. Anything else is rejected, as for locations. */
const WRITABLE = new Set(['slug', 'name', 'description', 'sort_order']);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {object} payload
 * @param {object} [opts]
 * @param {boolean} [opts.partial]  PATCH semantics: validate only present keys.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTagInput(payload, { partial = false } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isPlainObject(payload)) return { ok: false, errors: ['body must be a JSON object'] };

  for (const key of Object.keys(payload)) {
    if (!WRITABLE.has(key)) err(`unknown field: ${key}`);
  }

  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);

  if (!partial) {
    for (const k of ['slug', 'description']) if (!has(k)) err(`missing required field: ${k}`);
  }

  if (has('slug')) {
    if (typeof payload.slug !== 'string' || !SLUG_RE.test(payload.slug)) {
      err('slug must be lowercase letters, digits and single hyphens');
    } else if (payload.slug.length > SLUG_MAX) {
      err(`slug must be at most ${SLUG_MAX} characters`);
    } else if (RESERVED_SLUGS.has(payload.slug)) {
      // `nczoning` is prepended by the materializer for every auto-sourced
      // record. A registry row with that slug would collide with the marker and
      // make it editable and deletable, and deleting it would strip the tag from
      // every auto-discovered location at once.
      err(`slug "${payload.slug}" is reserved and cannot be used`);
    }
  }

  if (has('name') && payload.name !== null) {
    if (typeof payload.name !== 'string' || payload.name.length < 1) {
      err('name must be a non-empty string or null');
    } else if (payload.name.length > TAG_NAME_MAX) {
      err(`name must be at most ${TAG_NAME_MAX} characters`);
    }
  }

  if (has('description')) {
    if (typeof payload.description !== 'string' || payload.description.length < 1) {
      err('description must be a non-empty string');
    } else if (payload.description.length > TAG_DESCRIPTION_MAX) {
      err(`description must be at most ${TAG_DESCRIPTION_MAX} characters`);
    }
  }

  if (has('sort_order') && payload.sort_order !== null) {
    if (!Number.isInteger(payload.sort_order)) err('sort_order must be an integer or null');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Known slugs, for validating a location's `tags`.
 *
 * Reads the `tags` TABLE, not the KV snapshot the cron maintains. Phase 4a read
 * KV, which was correct when tags came from a file in git and wrong the moment
 * tags became editable: a tag created through this API would not be valid on a
 * location until the next materialize, so the create would succeed and the very
 * next use of it would 422.
 */
export async function readTagSlugs(env) {
  const { results } = await env.DB.prepare('SELECT slug FROM tags').all();
  return new Set((results ?? []).map((r) => r.slug));
}

/**
 * Every tag with the number of locations carrying it.
 *
 * The count is what the admin view exists for: it turns "delete this
 * tag" from a guess into a decision, and it is what the 409 on delete reports.
 */
export async function readTagsWithUsage(env) {
  const { results } = await env.DB.prepare(`
    SELECT t.slug, t.name, t.description, t.sort_order, t.created_at, t.updated_at,
           COUNT(lt.location_id) AS usage_count
    FROM tags t
    LEFT JOIN location_tags lt ON lt.tag_slug = t.slug
    GROUP BY t.slug
    ORDER BY t.sort_order, t.slug
  `).all();
  return (results ?? []).map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    sort_order: r.sort_order,
    usage_count: Number(r.usage_count) || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/** The locations carrying a tag: `{id, name}`, name-ordered. Used by the 409 body. */
export async function readTagUsers(env, slug, limit = 50) {
  const { results } = await env.DB.prepare(`
    SELECT l.id, l.name FROM location_tags lt
    JOIN locations l ON l.id = lt.location_id
    WHERE lt.tag_slug = ?
    ORDER BY l.name
    LIMIT ?
  `).bind(slug, limit).all();
  return results ?? [];
}

/** One tag row, or null. */
export async function readTag(env, slug) {
  return env.DB.prepare(
    'SELECT slug, name, description, sort_order, created_at, updated_at FROM tags WHERE slug = ?',
  ).bind(slug).first();
}

/**
 * Slugs attached to each of `ids`, as Map(location_id -> string[]).
 *
 * NEVER `IN (?, ?, ...)` with one placeholder per id. **D1 refuses more than
 * 100 bound parameters in a single query**, measured rather than assumed: `SELECT`
 * with 100 placeholders is accepted and 101 fails with
 * `D1_ERROR: too many SQL variables`. The admin list route passes every
 * location, which is 297 today, so that query threw on every call and the
 * dashboard showed an empty table behind a misleading CORS error (a route that
 * throws returns a 500 from the error handler, without the CORS headers the
 * normal path adds).
 *
 * The whole-table read is what d1.js's readLocationTags already does for the
 * materializer, for the same reason. It binds nothing at all, so it does not
 * merely raise the ceiling: it removes it.
 */
export async function readTagsForLocations(env, ids) {
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;

  // One id is the editor's case: a targeted lookup, one bound parameter.
  if (ids.length === 1) {
    const { results } = await env.DB.prepare(
      'SELECT tag_slug FROM location_tags WHERE location_id = ? ORDER BY tag_slug',
    ).bind(ids[0]).all();
    map.set(ids[0], (results ?? []).map((r) => r.tag_slug));
    return map;
  }

  // Many ids: read the join whole and group in JS. 572 rows against 297
  // locations, so the transfer is cheaper than the round trips chunking needs.
  const { results } = await env.DB.prepare(
    'SELECT location_id, tag_slug FROM location_tags ORDER BY location_id, tag_slug',
  ).all();
  for (const r of results ?? []) map.get(r.location_id)?.push(r.tag_slug);
  return map;
}

/**
 * Point a location at exactly `slugs`, in both representations.
 *
 * Replace rather than diff: the join row carries no payload beyond its own
 * existence, so a delete-then-insert is the same end state as a computed diff
 * and has no partial-update case to get wrong.
 *
 * The synthetic `nczoning` marker is no longer written to either the join or
 * the legacy column. It was a marker auto-discovery added, and nothing
 * auto-publishes now, so it described nothing a consumer could act on. Dropping
 * it from the write path is half the removal; `materialize.js` stopping adding
 * it at serve time is the other half.
 */
export async function syncLocationTags(env, locationId, slugs) {
  const clean = [...new Set(slugs.filter((s) => !RESERVED_SLUGS.has(s)))].sort();

  const statements = [
    env.DB.prepare('DELETE FROM location_tags WHERE location_id = ?').bind(locationId),
    ...clean.map((slug) => env.DB.prepare(
      'INSERT INTO location_tags (location_id, tag_slug) VALUES (?, ?)',
    ).bind(locationId, slug)),
  ];

  // Batched so the join is never briefly empty for a location that has tags.
  // A cron tick landing between the DELETE and the INSERTs would otherwise
  // materialize that record with no tags at all.
  await env.DB.batch(statements);
  return clean;
}
