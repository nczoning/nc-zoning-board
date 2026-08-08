/**
 * Admin CRUD over the location registry. Phase 4: direct writes, no submission
 * queue yet (that is Phase 5).
 *
 * Every route is gated on repository collaborator status, and every mutation
 * writes an audit row in the same request. The audit row is not optional
 * bookkeeping: once edits stop arriving as pull requests, it is the only
 * record of who changed what.
 */

import { resolveSession } from './auth.js';
import { adminCors } from './auth.js';
import { validateLocationInput } from './validate.js';
import { writeAudit, readAudit } from './audit.js';
import { readAlerts, countUnacknowledged, acknowledgeAlert } from './alerts.js';
import { readModStatuses, setDismissed } from './nexus-status.js';
import { runRefresh } from './refresh.js';
import {
  validateTagInput, readTagSlugs, readTagsWithUsage, readTagUsers, readTag,
  readTagsForLocations,
} from './tag-registry.js';
import { introspectDatasets, introspectType, readQuota } from './quota.js';
import {
  getRow, rowToAdmin, loadAdminRecord, materializeAfterWrite, insertLocation, patchLocation,
  readNexusModMap, archivesView,
} from './registry.js';
import { handleReview } from './review.js';
// The single definition of "what archives is this record served". Shared with
// the materializer on purpose: a second copy here is how the dashboard came to
// disagree with /v1 about a split page.
import { resolveArchives, parseNexusFiles } from './materialize.js';

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
 * 503 for an indeterminate check, never 403: "cannot tell" is not "you are
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

  // ---- alerts --------------------------------------------------------------
  //
  // Reading and acknowledging only. Alerts are WRITTEN at /internal/alerts,
  // which carries a shared secret because its callers are GitHub Actions rather
  // than a signed-in human. Keeping the write off this surface is what lets the
  // gate above stay uniform.
  if (url.pathname === '/admin/alerts' && method === 'GET') {
    return json(request, {
      alerts: await readAlerts(env, {
        limit: url.searchParams.get('limit'),
        unacknowledged: url.searchParams.get('unacknowledged') === '1',
      }),
      unacknowledged: await countUnacknowledged(env),
    });
  }

  const alertMatch = url.pathname.match(/^\/admin\/alerts\/([^/]+)$/);
  if (alertMatch && method === 'PATCH') {
    const alert = await acknowledgeAlert(env, alertMatch[1], actor);
    if (!alert) return json(request, { error: 'not_found' }, 404);
    // No audit row. The audit log records changes to the registry, and an
    // acknowledgement changes no data a visitor can see; the acknowledged_by
    // and acknowledged_at columns are already the record of who cleared it.
    return json(request, { alert });
  }
  if (alertMatch) return json(request, { error: 'method_not_allowed' }, 405);

  // ---- pinned mods Nexus no longer calls published (#900) ------------------
  //
  // Read plus a dismissal, and deliberately nothing else. The cron owns every
  // other column: an admin who decides a flagged mod is gone for good edits the
  // LOCATION, through the existing hidden/published control and the existing
  // audit trail. Nothing here writes `locations.status`.
  //
  // Its own route rather than a field on the location PATCH, because the flag
  // is per MOD and a mod can carry two pins (23896 supplies two tattoo shops).
  // Dismissing it from one of them would have to mean dismissing it for both,
  // which is a location endpoint quietly writing something that is not a
  // location.
  if (url.pathname === '/admin/nexus-status' && method === 'GET') {
    return json(request, { mods: await readModStatuses(env) });
  }

  const modStatusMatch = url.pathname.match(/^\/admin\/nexus-status\/([^/]+)$/);
  if (modStatusMatch && method === 'PATCH') {
    const nexusId = decodeURIComponent(modStatusMatch[1]);
    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }
    if (typeof payload?.dismissed !== 'boolean') {
      return json(request, { error: 'validation_failed', errors: ['dismissed must be a boolean'] }, 422);
    }

    const record = await setDismissed(env, nexusId, { actor, dismissed: payload.dismissed });
    if (!record) return json(request, { error: 'not_found' }, 404);

    // Audited, unlike an alert acknowledgement. For a deleted mod this decides
    // whether a pin is on the public map, and even for a hidden one it records
    // that a person looked at the author's reason and made a call.
    await writeAudit(env, {
      actor,
      action: payload.dismissed ? 'nexus_status.dismiss' : 'nexus_status.restore',
      target: nexusId,
      after: record,
    });
    // Dismissing a DELETED mod puts its pin back, so the served dataset has to
    // be rebuilt for that to be true anywhere but this response. Same
    // fire-and-forget as every other write on this surface.
    materializeAfterWrite(env, ctx);
    return json(request, { mod: record });
  }
  if (modStatusMatch) return json(request, { error: 'method_not_allowed' }, 405);

  // ---- quota: dataset introspection --------------------------------------
  //
  // Kept, not scaffolding. Cloudflare's analytics schema is 213 datasets whose
  // names follow a convention closely enough that a WRONG name looks right and
  // returns an EMPTY result rather than an error, and "no rows" reads exactly
  // like "no usage today". Every dataset this Worker queries was confirmed
  // here first, and the next one (R2, at cleanup) should be too.
  //
  //
  // Read-only, collaborator-gated, and it exposes only schema field names.
  //   GET /admin/quota/datasets            -> every dataset on the account type
  //   GET /admin/quota/datasets?type=NAME  -> one type's fields and inputFields
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
  // It exists because staging has NO CRON (removed to stay inside the 1,000
  // KV writes/day free-tier cap), so nothing there re-materializes on its own.
  // Staging has no cron, so its KV changes only when a rebuild is requested
  // here or an admin write triggers one.
  //
  // Awaited rather than fire-and-forget: the caller asked for a rebuild, so the
  // response has to say whether they got one.
  if (url.pathname === '/admin/refresh' && method === 'POST') {
    let result;
    try {
      result = await runRefresh(env);
    } catch (err) {
      // runRefresh does NOT throw on a failed rebuild -- it catches, keeps
      // last-known-good, flags discovery_stale and RETURNS {stale: true}. So
      // this catch is only for a failure of its own error path, and branching
      // on `stale` below is what actually detects a failed rebuild. Reporting
      // success on "it did not throw" would call every failed rebuild a win.
      return json(request, { error: 'refresh_failed', detail: String(err).slice(0, 300) }, 500);
    }

    if (result?.stale) {
      return json(request, {
        error: 'refresh_failed',
        detail: String(result.error ?? 'unknown').slice(0, 300),
      }, 500);
    }

    await writeAudit(env, { actor, action: 'dataset.refresh', target: 'd1' });
    // `changed: false` is a success: the content hash matched, so there was
    // nothing to write. Distinct from a failure, and the caller is told which.
    return json(request, {
      refreshed: true,
      // Constant since Phase 6 left one source. Kept in the response so the
      // dashboard's rebuild panel does not have to change shape.
      source: 'd1',
      changed: result?.changed === true,
      dataset_version: result?.version ?? null,
    });
  }

  // ---- tags --------------------------------------------------------------
  const tagResponse = await handleTags(
    { request, env, ctx, actor, method, tagListMatch, tagOneMatch },
  );
  if (tagResponse) return tagResponse;

  // ---- the review queue and the candidates list ---------------------------
  //
  // Its own module rather than another block here, for the reason handleTags is
  // split out: this file is the dispatcher plus the location editor, and the
  // queue is a second surface with its own rules about what a resolved
  // submission means. It routes only /admin/submissions* and /admin/candidates*
  // and returns null otherwise, so the gate above still runs first and there is
  // exactly one collaborator check.
  const reviewResponse = await handleReview({ request, env, ctx, actor, method, url });
  if (reviewResponse) return reviewResponse;

  // ---- list --------------------------------------------------------------
  if (listMatch && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM locations ORDER BY name').all();
    const rows = results ?? [];
    const tagMap = await readTagsForLocations(env, rows.map((r) => r.id));
    const nexusMap = await readNexusModMap(env);
    // Archives ride the list rather than a per-record fetch because the detail
    // pane reads the record straight out of the loaded list -- see
    // selectLocation in admin/admin.js. Attached here rather than inside
    // rowToAdmin so the audit log keeps carrying only editable fields.
    // Which pages more than one PUBLISHED record points at. Same definition the
    // materializer uses, so the panel shows what /v1 serves rather than what the
    // Nexus page holds; showing the page's whole listing against a split record
    // reads as "the download mapping did not work".
    const perPage = new Map();
    for (const r of rows) {
      if (r.status !== 'published') continue;
      const k = String(r.nexus_id);
      perPage.set(k, (perPage.get(k) ?? 0) + 1);
    }
    return json(request, {
      locations: rows.map((r) => {
        const nexus = nexusMap.get(String(r.nexus_id)) ?? null;
        return {
          ...rowToAdmin(r, tagMap.get(r.id) ?? [], nexus?.updated_at ?? null),
          archives: resolveArchives({
            pageArchives: nexus?.archives ?? [],
            archivesByFile: nexus?.archivesByFile ?? {},
            files: parseNexusFiles(r.nexus_files),
            contested: (perPage.get(String(r.nexus_id)) ?? 0) > 1,
          }),
          archives_state: nexus?.archives_state ?? 'unknown',
        };
      }),
    });
  }

  // ---- create ------------------------------------------------------------
  if (listMatch && method === 'POST') {
    let payload;
    try { payload = await request.json(); } catch { return json(request, { error: 'invalid_json' }, 400); }

    const v = validateLocationInput(payload, { tagNames: await readTagSlugs(env) });
    if (!v.ok) return json(request, { error: 'validation_failed', errors: v.errors }, 422);

    const id = await insertLocation(env, payload);

    const after = await loadAdminRecord(env, await getRow(env, id));
    await writeAudit(env, { actor, action: 'location.create', target: id, after });
    materializeAfterWrite(env, ctx);
    return json(request, { location: after }, 201);
  }

  // ---- read one ----------------------------------------------------------
  if (oneMatch && method === 'GET') {
    const row = await getRow(env, decodeURIComponent(oneMatch[1]));
    if (!row) return json(request, { error: 'not_found' }, 404);
    // Same two fields the list carries, so a single-record read is not a
    // narrower view than the list it came from. The write routes deliberately
    // do NOT: their bodies are the audit record.
    const nexus = await env.DB.prepare(
      `SELECT updated_at, archives, archives_by_file, archives_at
         FROM nexus_cache WHERE nexus_id = ?`,
    ).bind(String(row.nexus_id)).first();
    const { archives, archives_state } = archivesView(nexus);

    // Everything the download picker needs, and only for a record that needs
    // one. `contested` is "another location points at this Nexus page", which
    // is what makes a per-download mapping necessary; a page with several
    // downloads and a single location does not need one and gets no picker
    // (229 of 294 pages were that shape when this was measured). See migration 0011.
    const sharers = await env.DB.prepare(
      'SELECT id, name FROM locations WHERE nexus_id = ? AND id != ?',
    ).bind(String(row.nexus_id), row.id).all();
    const others = sharers.results ?? [];
    let downloads = [];
    try {
      const parsed = JSON.parse(nexus?.archives_by_file ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        downloads = Object.entries(parsed).map(([name, files]) => ({ name, files }));
      }
    } catch {
      // No breakdown reads as no picker, same posture as archivesView: one
      // mod's file listing is not worth failing the page load over.
    }

    // What this record is actually served, not what its page holds. The two
    // differ only on a shared page, which is exactly the record a reviewer
    // opens this panel to check.
    const resolved = resolveArchives({
      pageArchives: archives,
      archivesByFile: Object.fromEntries(downloads.map((d) => [d.name, d.files])),
      files: parseNexusFiles(row.nexus_files),
      contested: others.length > 0,
    });

    return json(request, {
      location: {
        ...await loadAdminRecord(env, row), archives: resolved, archives_state,
      },
      page: {
        contested: others.length > 0,
        shared_with: others.map((o) => ({ id: o.id, name: o.name })),
        downloads,
      },
    });
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

    // The version the editor was opened on. Absent means an unguarded write,
    // which keeps older clients and curl working; the dashboard always sends it.
    const ifMatch = (request.headers.get('If-Match') || '').replace(/^"|"$/g, '') || null;

    const patched = await patchLocation(env, id, payload, undefined, { ifMatch });
    if (patched.empty) return json(request, { error: 'empty_patch' }, 400);
    if (patched.conflict) {
      // The current record comes back so the dashboard can show what changed
      // rather than just refusing. Nothing was written.
      return json(request, {
        error: 'stale_write',
        current: await loadAdminRecord(env, await getRow(env, id)),
      }, 409);
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
 * locations: a tag's name and description are served on /v1/tags, so an edit
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

    // A slug change propagates to location_tags through ON UPDATE CASCADE,
    // which only fires with foreign keys enforced. D1 enforces them by default;
    // if that ever stops being true the rename silently orphans every link,
    // so the count is re-read below and compared.
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
    // records come back so the caller can decide.
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
