/**
 * Admin CRUD over the location registry. Phase 4: direct writes, no submission
 * queue yet (that is Phase 5).
 *
 * Every route is gated on repository collaborator status, and every mutation
 * writes an audit row in the same request. The audit row is not optional
 * bookkeeping — once edits stop arriving as pull requests, it is the only
 * record of who changed what.
 */

import { resolveSession } from './auth.js';
import { adminCors } from './auth.js';
import { validateLocationInput } from './validate.js';
import { writeAudit, readAudit } from './audit.js';
import { runRefresh } from './refresh.js';
import {
  validateTagInput, readTagSlugs, readTagsWithUsage, readTagUsers, readTag,
  readTagsForLocations, syncLocationTags,
} from './tag-registry.js';
import { introspectDatasets, introspectType, readQuota } from './quota.js';

const json = (request, body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...adminCors(request),
  },
});

/**
 * Gate. Returns the session, or a Response to return immediately.
 *
 * 503 for an indeterminate check, never 403: "we cannot tell" is not "you are
 * not allowed", and an admin locked out by a transient GitHub blip should be
 * told which of those happened. See github-app.js.
 */
async function requireCollaborator(request, env) {
  const session = await resolveSession(request, env);
  if (!session) return { error: json(request, { error: 'unauthenticated' }, 401) };
  if (session.indeterminate) {
    return { error: json(request, { error: 'check_unavailable' }, 503) };
  }
  if (!session.collaborator) return { error: json(request, { error: 'forbidden' }, 403) };
  return { session };
}

/**
 * Row -> the admin representation (everything, including admin-only fields).
 *
 * `tags` comes from the `location_tags` join, passed in by the caller, NOT from
 * the legacy `locations.tags` column. The join is what the materializer reads,
 * so it is what the dashboard must show — rendering the column would let an
 * edit that never reached the join look like it had landed.
 *
 * The synthetic `nczoning` marker is absent here by construction (it is not a
 * registry row, so it has no join rows). That is correct for an editor: it is
 * not a tag an admin owns, and the materializer re-adds it for auto records.
 */
function rowToAdmin(row, tags = []) {
  return {
    id: row.id,
    name: row.name,
    nexus_id: row.nexus_id,
    category: row.category,
    coordinates: row.z === null || row.z === undefined ? [row.x, row.y] : [row.x, row.y, row.z],
    yaw: row.yaw,
    description: row.description ?? '',
    credits: row.credits,
    authors: JSON.parse(row.authors ?? '[]'),
    tags,
    source: row.source,
    status: row.status,
    admin_notes: row.admin_notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** One location, joined to its tags. */
async function loadAdminRecord(env, row) {
  const map = await readTagsForLocations(env, [row.id]);
  return rowToAdmin(row, map.get(row.id) ?? []);
}

/**
 * Rebuild the KV read path from D1 after a write, so an approved change appears
 * in seconds rather than at the next cron tick.
 *
 * 🔴 GATED ON DATA_SOURCE. If the cron is still sourcing from mods.json, a
 * write-through materialize would overwrite KV with D1-derived content and
 * silently perform the Phase 2 cutover as a side effect of an admin edit. So
 * when DATA_SOURCE is not 'd1' the write lands in D1 and the map keeps showing
 * mods.json — which is correct, and is what "nothing reads D1 yet" means.
 */
function materializeAfterWrite(env, ctx) {
  if (env.DATA_SOURCE !== 'd1') return;
  // Fire-and-forget: the admin gets their response immediately, and a failed
  // rebuild leaves last-known-good in place exactly as a failed cron does.
  ctx?.waitUntil?.(runRefresh(env).catch((err) => {
    console.error('write-through materialize failed:', String(err).slice(0, 200));
  }));
}

const COLUMN_FOR = {
  name: 'name', nexus_id: 'nexus_id', category: 'category', description: 'description',
  credits: 'credits', source: 'source', status: 'status', admin_notes: 'admin_notes',
  yaw: 'yaw',
};

/**
 * Build the SET clause for a validated patch.
 *
 * `tags` is deliberately NOT here: it lives in the join now, and
 * syncLocationTags owns both representations. Setting the column here as well
 * would write it twice with two different normalisations.
 */
function buildUpdate(payload) {
  const sets = [];
  const binds = [];
  for (const [field, column] of Object.entries(COLUMN_FOR)) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      sets.push(`${column} = ?`);
      binds.push(payload[field] === undefined ? null : payload[field]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'authors')) {
    sets.push('authors = ?'); binds.push(JSON.stringify(payload.authors));
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'coordinates')) {
    const [x, y, z] = payload.coordinates;
    sets.push('x = ?', 'y = ?', 'z = ?');
    binds.push(x, y, z === undefined ? null : z);
  }
  return { sets, binds };
}

async function getRow(env, id) {
  return env.DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first();
}

/**
 * Route the /admin/* surface.
 * @returns {Promise<Response|null>} null when the path is not an admin route.
 */
export async function handleAdmin(request, env, ctx) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/admin/')) return null;

  const gate = await requireCollaborator(request, env);
  if (gate.error) return gate.error;
  const actor = gate.session.login;

  const method = request.method;
  const listMatch = url.pathname === '/admin/locations';
  const oneMatch = url.pathname.match(/^\/admin\/locations\/([^/]+)$/);
  const tagListMatch = url.pathname === '/admin/tags';
  const tagOneMatch = url.pathname.match(/^\/admin\/tags\/([^/]+)$/);

  // ---- audit -------------------------------------------------------------
  if (url.pathname === '/admin/audit' && method === 'GET') {
    return json(request, { entries: await readAudit(env, url.searchParams.get('limit')) });
  }

  // ---- quota: dataset introspection --------------------------------------
  //
  // TEMPORARY. Confirms the GraphQL dataset field names for the real quota
  // query; removed once /admin/quota is built against them. Guessing the names
  // is the trap this avoids — the `*AdaptiveGroups` convention makes a wrong
  // guess look plausible and return an EMPTY result rather than an error, and
  // "no rows" reads exactly like "no usage today".
  if (url.pathname === '/admin/quota/datasets' && method === 'GET') {
    const typeName = url.searchParams.get('type');
    const result = typeName
      ? await introspectType(env, typeName)
      : await introspectDatasets(env);
    if (!result.ok) return json(request, { error: 'introspection_failed', errors: result.errors }, 502);
    return json(request, result.data);
  }

  // ---- quota burn-down ----------------------------------------------------
  //
  // 502, not 200-with-nulls, when the read fails: the dashboard must be able to
  // say "unknown" rather than draw an empty meter, which reads as "no usage".
  if (url.pathname === '/admin/quota' && method === 'GET') {
    const result = await readQuota(env);
    if (!result.ok) return json(request, { error: 'quota_unavailable', errors: result.errors }, 502);
    return json(request, result.data);
  }

  // ---- rebuild the read path ---------------------------------------------
  //
  // Deliberately NOT gated on DATA_SOURCE, unlike materializeAfterWrite. That
  // gate exists so an admin write does not spend a KV write rebuilding from a
  // source the write did not touch; this route is someone explicitly asking for
  // a rebuild, and runRefresh honours DATA_SOURCE either way — from mods.json in
  // production, from D1 on staging. It cannot flip the cutover.
  //
  // It exists because staging has NO CRON (removed to stay inside the 1,000
  // KV writes/day free-tier cap), so nothing there re-materializes on its own.
  // Staging's KV sat 14 hours stale and served the pre-4b /v1/tags shape, and
  // there was no way to notice or fix it short of an admin write.
  //
  // Awaited rather than fire-and-forget: the caller asked for a rebuild, so the
  // response has to say whether they got one.
  if (url.pathname === '/admin/refresh' && method === 'POST') {
    const source = env.DATA_SOURCE ?? 'mods';
    let result;
    try {
      result = await runRefresh(env);
    } catch (err) {
      // 🔴 runRefresh does NOT throw on a failed rebuild -- it catches, keeps
      // last-known-good, flags discovery_stale and RETURNS {stale: true}. So
      // this catch is only for a failure of its own error path, and branching
      // on `stale` below is what actually detects a failed rebuild. Reporting
      // success off "it did not throw" would have called every failure a win.
      return json(request, { error: 'refresh_failed', detail: String(err).slice(0, 300) }, 500);
    }

    if (result?.stale) {
      return json(request, {
        error: 'refresh_failed',
        detail: String(result.error ?? 'unknown').slice(0, 300),
      }, 500);
    }

    await writeAudit(env, { actor, action: 'dataset.refresh', target: source });
    // `changed: false` is a success: the content hash matched, so there was
    // nothing to write. Distinct from a failure, and the caller is told which.
    return json(request, {
      refreshed: true,
      source,
      changed: result?.changed === true,
      dataset_version: result?.version ?? null,
    });
  }

  // ---- tags --------------------------------------------------------------
  const tagResponse = await handleTags(
    { request, env, ctx, actor, method, tagListMatch, tagOneMatch },
  );
  if (tagResponse) return tagResponse;

  // ---- list --------------------------------------------------------------
  if (listMatch && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM locations ORDER BY name').all();
    const rows = results ?? [];
    const tagMap = await readTagsForLocations(env, rows.map((r) => r.id));
    return json(request, { locations: rows.map((r) => rowToAdmin(r, tagMap.get(r.id) ?? [])) });
  }

  // ---- create ------------------------------------------------------------
  if (listMatch && method === 'POST') {
    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }

    const v = validateLocationInput(payload, { tagNames: await readTagSlugs(env) });
    if (!v.ok) return json(request, { error: 'validation_failed', errors: v.errors }, 422);

    // Server-generated, never client-supplied: a caller-chosen id is how a deep
    // link gets silently repointed at a different mod.
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const [x, y, z] = payload.coordinates;

    await env.DB.prepare(`
      INSERT INTO locations (id, name, nexus_id, category, x, y, z, yaw, description,
        credits, authors, tags, source, status, admin_notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, payload.name, payload.nexus_id, payload.category,
      x, y, z === undefined ? null : z,
      payload.yaw ?? null,
      payload.description ?? '',
      payload.credits || null,
      JSON.stringify(payload.authors), JSON.stringify(payload.tags),
      payload.source ?? 'manual', payload.status ?? 'published',
      payload.admin_notes ?? null, now, now,
    ).run();

    // The join, not just the column. Without this the record materializes with
    // no tags at all, because resolveTags treats the join as authoritative.
    await syncLocationTags(env, id, payload.tags, payload.source ?? 'manual');

    const after = await loadAdminRecord(env, await getRow(env, id));
    await writeAudit(env, { actor, action: 'location.create', target: id, after });
    materializeAfterWrite(env, ctx);
    return json(request, { location: after }, 201);
  }

  // ---- read one ----------------------------------------------------------
  if (oneMatch && method === 'GET') {
    const row = await getRow(env, decodeURIComponent(oneMatch[1]));
    if (!row) return json(request, { error: 'not_found' }, 404);
    return json(request, { location: await loadAdminRecord(env, row) });
  }

  // ---- update ------------------------------------------------------------
  if (oneMatch && method === 'PATCH') {
    const id = decodeURIComponent(oneMatch[1]);
    const beforeRow = await getRow(env, id);
    if (!beforeRow) return json(request, { error: 'not_found' }, 404);
    const before = await loadAdminRecord(env, beforeRow);

    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }

    const v = validateLocationInput(payload, { tagNames: await readTagSlugs(env), partial: true });
    if (!v.ok) return json(request, { error: 'validation_failed', errors: v.errors }, 422);

    const patchesTags = Object.prototype.hasOwnProperty.call(payload, 'tags');
    const { sets, binds } = buildUpdate(payload);
    if (!sets.length && !patchesTags) return json(request, { error: 'empty_patch' }, 400);

    // A tags-only patch still has to move updated_at, so the column write is
    // unconditional rather than gated on `sets`.
    sets.push('updated_at = ?');
    binds.push(new Date().toISOString(), id);
    await env.DB.prepare(`UPDATE locations SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();

    if (patchesTags) {
      // Re-read rather than reusing `beforeRow`: the same PATCH may have just
      // changed `source`, which decides whether the legacy column keeps the
      // nczoning marker.
      const { source } = await getRow(env, id);
      await syncLocationTags(env, id, payload.tags, source);
    }

    const after = await loadAdminRecord(env, await getRow(env, id));
    await writeAudit(env, { actor, action: 'location.update', target: id, before, after });
    materializeAfterWrite(env, ctx);
    return json(request, { location: after });
  }

  // ---- delete ------------------------------------------------------------
  if (oneMatch && method === 'DELETE') {
    const id = decodeURIComponent(oneMatch[1]);
    const beforeRow = await getRow(env, id);
    if (!beforeRow) return json(request, { error: 'not_found' }, 404);
    // Snapshot the tags BEFORE the delete: location_tags cascades on
    // location_id, so reading them afterwards returns an empty list and the
    // audit row would claim the record had no tags.
    const before = await loadAdminRecord(env, beforeRow);

    await env.DB.prepare('DELETE FROM locations WHERE id = ?').bind(id).run();
    // The full record goes into `before`, so a delete is recoverable from the
    // audit log. `status: 'hidden'` remains the right move for a mod pulled
    // from the map; this is for records that should never have existed.
    await writeAudit(env, { actor, action: 'location.delete', target: id, before });
    materializeAfterWrite(env, ctx);
    return json(request, { deleted: id });
  }

  return json(request, { error: 'not_found' }, 404);
}

/**
 * The /admin/tags surface. Split out so handleAdmin stays readable; returns
 * null when the path is not a tag route, exactly as handleAdmin does for
 * non-admin paths.
 *
 * Every mutation writes an audit row and rebuilds the read path, same as
 * locations — a tag's name and description are served on /v1/tags, so an edit
 * that skipped the materialize would sit invisible until the next cron tick.
 */
async function handleTags({ request, env, ctx, actor, method, tagListMatch, tagOneMatch }) {
  // ---- list --------------------------------------------------------------
  if (tagListMatch && method === 'GET') {
    return json(request, { tags: await readTagsWithUsage(env) });
  }

  // ---- create ------------------------------------------------------------
  if (tagListMatch && method === 'POST') {
    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }

    const v = validateTagInput(payload);
    if (!v.ok) return json(request, { error: 'validation_failed', errors: v.errors }, 422);

    if (await readTag(env, payload.slug)) {
      return json(request, { error: 'tag_exists', slug: payload.slug }, 409);
    }

    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO tags (slug, name, description, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      payload.slug, payload.name ?? null, payload.description,
      payload.sort_order ?? null, now, now,
    ).run();

    const after = await readTag(env, payload.slug);
    await writeAudit(env, { actor, action: 'tag.create', target: payload.slug, after });
    materializeAfterWrite(env, ctx);
    return json(request, { tag: { ...after, usage_count: 0 } }, 201);
  }

  if (!tagOneMatch) return null;
  const slug = decodeURIComponent(tagOneMatch[1]);

  // ---- read one ----------------------------------------------------------
  if (method === 'GET') {
    const tag = await readTag(env, slug);
    if (!tag) return json(request, { error: 'not_found' }, 404);
    return json(request, { tag, locations: await readTagUsers(env, slug) });
  }

  // ---- update ------------------------------------------------------------
  if (method === 'PATCH') {
    const before = await readTag(env, slug);
    if (!before) return json(request, { error: 'not_found' }, 404);

    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }

    const v = validateTagInput(payload, { partial: true });
    if (!v.ok) return json(request, { error: 'validation_failed', errors: v.errors }, 422);

    const renaming = Object.prototype.hasOwnProperty.call(payload, 'slug')
      && payload.slug !== slug;
    if (renaming && await readTag(env, payload.slug)) {
      return json(request, { error: 'tag_exists', slug: payload.slug }, 409);
    }

    const sets = [];
    const binds = [];
    for (const field of ['slug', 'name', 'description', 'sort_order']) {
      if (Object.prototype.hasOwnProperty.call(payload, field)) {
        sets.push(`${field} = ?`);
        binds.push(payload[field] ?? null);
      }
    }
    if (!sets.length) return json(request, { error: 'empty_patch' }, 400);

    sets.push('updated_at = ?');
    binds.push(new Date().toISOString(), slug);

    // 🔴 A slug change propagates to location_tags through ON UPDATE CASCADE,
    // which only fires with foreign keys enforced. D1 enforces them by default;
    // if that ever stops being true the rename silently orphans every link,
    // which is why the count is re-read below and compared.
    const usedBefore = (await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM location_tags WHERE tag_slug = ?',
    ).bind(slug).first())?.n ?? 0;

    await env.DB.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE slug = ?`).bind(...binds).run();

    const newSlug = renaming ? payload.slug : slug;
    if (renaming) {
      const usedAfter = (await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM location_tags WHERE tag_slug = ?',
      ).bind(newSlug).first())?.n ?? 0;
      if (usedAfter !== usedBefore) {
        // Loud, not silent: the tag now exists under the new slug but the
        // locations no longer point at it. Reporting 200 here would hand back a
        // renamed tag and quietly untag every location that carried it.
        return json(request, {
          error: 'cascade_failed',
          detail: `rename left ${usedAfter} of ${usedBefore} location links intact`,
        }, 500);
      }
    }

    const after = await readTag(env, newSlug);
    await writeAudit(env, {
      actor,
      action: renaming ? 'tag.rename' : 'tag.update',
      target: newSlug,
      before,
      after,
    });
    materializeAfterWrite(env, ctx);
    return json(request, { tag: { ...after, usage_count: usedBefore } });
  }

  // ---- delete ------------------------------------------------------------
  if (method === 'DELETE') {
    const before = await readTag(env, slug);
    if (!before) return json(request, { error: 'not_found' }, 404);

    // Refuse rather than cascade. location_tags has no ON DELETE for tag_slug,
    // so a bare delete would fail on the foreign key with an opaque error; and
    // a cascade would strip the tag from every record as a side effect of one
    // click, with a single audit row to show for it. The count and the affected
    // records come back so the caller can decide, which is the whole point.
    const users = await readTagUsers(env, slug);
    if (users.length) {
      const total = (await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM location_tags WHERE tag_slug = ?',
      ).bind(slug).first())?.n ?? users.length;
      return json(request, {
        error: 'tag_in_use', slug, usage_count: total, locations: users,
      }, 409);
    }

    await env.DB.prepare('DELETE FROM tags WHERE slug = ?').bind(slug).run();
    await writeAudit(env, { actor, action: 'tag.delete', target: slug, before });
    materializeAfterWrite(env, ctx);
    return json(request, { deleted: slug });
  }

  return null;
}
