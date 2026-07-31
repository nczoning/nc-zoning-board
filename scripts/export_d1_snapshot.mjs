#!/usr/bin/env node
/**
 * Nightly D1 → git snapshot (Part C).
 *
 * WHY THIS EXISTS, IN ONE LINE: since the cutover, `data/locations/*.json` is a
 * mirror of 288 of 297 records: the nine auto-discovered `nexus-<id>` rows have
 * never existed as files. The registry's only off-Cloudflare backup is already
 * incomplete, today, before Phase 6 deletes anything.
 *
 * Writes a *working tree*, not a commit. The workflow decides whether the diff
 * is worth committing (`git diff --quiet || commit`), so a quiet night produces
 * no commit and the script stays testable without git.
 *
 *   node scripts/export_d1_snapshot.mjs --out ../snapshot
 *   node scripts/export_d1_snapshot.mjs --out ../snapshot --dry-run
 *
 * Env:
 *   CLOUDFLARE_API_TOKEN   required. Needs **Account → D1 → Read** (or Edit).
 *                          A token scoped only for Workers deploys will 403 on
 *                          /d1/database/.../query with code 10000. The endpoint
 *                          named in the error is what tells you which permission
 *                          is missing (learnings/wrangler-ci-token-permissions).
 *   CLOUDFLARE_ACCOUNT_ID  defaults to the account in worker/wrangler.jsonc.
 *   D1_DATABASE_ID         defaults to production `nczoning-data`.
 *
 * ## Why the REST API and not `wrangler d1 execute`
 *
 * `wrangler d1 execute --remote --json` returns 7403. Dropping `--json` works
 * and prints JSON anyway, which means the working invocation is the one whose
 * output format is undocumented and unpinned. The REST endpoint returns a
 * declared envelope, needs no devDependency install, and its failures name the
 * endpoint. See `learnings/wrangler-json-flag-7403`.
 *
 * ## What is deliberately NOT exported
 *
 * `submissions` (carries submitter contact and an IP hash), `alerts`, `users`,
 * and `nexus_cache` (fully derived, rebuilt by the 5-minute cron). This is a
 * backup of the *registry*, not of the database.
 */

import fs from 'node:fs';
import path from 'node:path';

const CF_API = process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'b9937d8d595fad7de8d1549b22390281';
const DATABASE_ID = process.env.D1_DATABASE_ID || '4365740b-76be-4a99-b985-16641e68703a';

/** Page size for every table read. D1's REST response has a size cap and the
 *  audit log grows without bound, so nothing here reads a whole table at once. */
const PAGE = 500;

/**
 * Keys stripped from exported audit payloads, at every depth.
 *
 * `admin_notes` and dismissal `reason`s are admin-only and must never reach a
 * public branch. The plan states this as an accepted reduction in what the mirror
 * preserves, with D1 Time Travel's 30 days as their only backup.
 *
 * The list is wider than those two on purpose. `review_note` is an admin's
 * judgement about someone else's mod (the same class of thing as a dismissal
 * reason), and the `submitter_*` fields are contact details that are not in the
 * audit row today but would be published the moment somebody added them. A
 * deny-list that only covers what leaks *right now* is one refactor from being
 * wrong, and the failure mode is publishing, which cannot be undone.
 *
 * Applied recursively because `before`/`after` nest: a `submission.create` row
 * carries the payload under `after.payload`.
 */
export const REDACTED_KEYS = [
  'admin_notes',
  'reason',
  'review_note',
  'submitter_contact',
  'submitter_note',
  'submitter_ip_hash',
];

/** The marker left in place of a redacted value, so the shape of the payload
 *  survives and a restore can tell "was empty" from "was withheld". */
export const REDACTED = '[redacted]';

// ── shaping (pure; this is the part the tests exercise) ─────────────────────

/**
 * One `locations` row → the object written to `data/locations/<id>.json`.
 *
 * KEY ORDER IS FIXED HERE and nowhere else. JSON.stringify emits insertion
 * order, so a reshuffle would rewrite all 297 files in one commit and bury the
 * one mod that actually changed. Per-location files, rather than `mods.json`,
 * are what make a nightly diff readable.
 *
 * NULL handling mirrors `materializeFromD1`'s decoder exactly, because these
 * files feed the importer and the importer's `toRow` reads them back:
 * a NULL `z` produces a 2-element `[x, y]`, and NULL `yaw`/`credits` OMIT the
 * key rather than emitting null.
 *
 * `added_at` / `modified_at` are exported even though today's files carry
 * neither. They were recovered from git history by #906 and Phase 6 deletes
 * that history's future; a backup that cannot reconstruct the row is not one.
 * `owner_id` is omitted: it is NULL on every row and unused.
 */
export function locationFile(row, tags = []) {
  const z = row.z === null || row.z === undefined ? undefined : row.z;
  return {
    id: row.id,
    name: row.name,
    nexus_id: row.nexus_id === null || row.nexus_id === undefined ? null : String(row.nexus_id),
    category: row.category,
    coordinates: z === undefined ? [row.x, row.y] : [row.x, row.y, z],
    ...(row.yaw === null || row.yaw === undefined ? {} : { yaw: row.yaw }),
    tags: [...tags].sort(),
    authors: JSON.parse(row.authors ?? '[]'),
    ...(row.credits ? { credits: row.credits } : {}),
    description: row.description ?? '',
    status: row.status,
    added_at: row.added_at,
    modified_at: row.modified_at,
  };
}

/**
 * Recursively drop REDACTED_KEYS. Arrays are walked; scalars pass through.
 *
 * Replaces rather than deletes: a missing key reads as "this record had no
 * admin note", which is a different and misleading claim.
 */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_KEYS.includes(k) ? REDACTED : redact(v);
  }
  return out;
}

/**
 * One `audit_log` row → one JSONL line's object.
 *
 * `before`/`after` are stored as JSON strings and are parsed here so redaction
 * can reach inside them. A payload that will not parse is kept as the literal
 * string `"[unparseable]"` rather than passed through: an unparseable blob
 * cannot be redacted, and publishing it unredacted is the one outcome this
 * function exists to prevent.
 */
export function auditLine(row) {
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    target: row.target ?? null,
    before: redactJsonString(row.before),
    after: redactJsonString(row.after),
  };
}

function redactJsonString(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return redact(JSON.parse(raw));
  } catch {
    return '[unparseable]';
  }
}

/**
 * `dismissed_candidates` → a bare, sorted ID array.
 *
 * NOT the `{id: reason}` map the repo file uses: the reasons are admin-only.
 * The IDs alone are enough to keep every already-rejected candidate off the
 * candidates list after a restore.
 *
 * Sorted numerically-when-numeric so the file does not reshuffle as IDs are
 * added. Under a plain string sort `["1000","99"]` is a diff nobody caused.
 */
export function excludedFile(rows) {
  return rows
    .map((r) => String(r.nexus_id))
    .sort((a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)));
}

/**
 * The `tags` table → `data/tags.json`, as an ARRAY OF ROWS, not the legacy
 * `{slug: description}` map.
 *
 * The flat map cannot hold `name` or `sort_order`, both of which are curated in
 * the dashboard and would be silently dropped by a "same file format" export.
 * The repo's own `data/tags.json` predates those columns and is stale (last
 * touched 13 March); it is not the format to preserve. `import-locations.mjs`
 * accepts both shapes so a restore works either way.
 */
export function tagsFile(rows) {
  return rows
    .map((r) => ({
      slug: r.slug,
      name: r.name ?? null,
      description: r.description,
      sort_order: r.sort_order ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))
    .sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9) || a.slug.localeCompare(b.slug));
}

/**
 * Highest audit id already in the snapshot, or 0 for a fresh branch.
 *
 * Read from the file rather than tracked in state, so the file IS the cursor:
 * a restored or hand-edited snapshot resumes from what it actually contains.
 * Scans every line because the last line of a partially-written file may be
 * truncated; a max over the parseable ones cannot resume too far ahead, and
 * resuming too far ahead is the failure that loses rows silently.
 */
export function lastAuditId(text) {
  let max = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const id = Number(JSON.parse(line).id);
      if (Number.isInteger(id) && id > max) max = id;
    } catch { /* truncated or corrupt line: the ids around it still bound us */ }
  }
  return max;
}

/** 4-space indent + trailing newline, matching every file in data/locations/. */
export function serialize(value) {
  return `${JSON.stringify(value, null, 4)}\n`;
}

// ── D1 access ───────────────────────────────────────────────────────────────

/**
 * One statement against the D1 HTTP API.
 *
 * Cloudflare answers 200 with `success: false` for application errors, so the
 * HTTP status alone is not the check. The thrown message names the endpoint and
 * the CF error code, because both past token failures in this repo were
 * `Authentication error [code: 10000]` on *different* endpoints and the endpoint
 * is what identified the missing permission.
 */
export async function d1Query(sql, params = [], deps = {}) {
  const {
    fetchImpl = fetch,
    token = process.env.CLOUDFLARE_API_TOKEN,
    accountId = ACCOUNT_ID,
    databaseId = DATABASE_ID,
  } = deps;
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');

  const endpoint = `${CF_API}/accounts/${accountId}/d1/database/${databaseId}/query`;
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok || !body?.success) {
    const detail = (body?.errors || [])
      .map((e) => `${e.message} [code: ${e.code}]`)
      .join('; ') || `HTTP ${res.status}`;
    throw new Error(
      `D1 query failed on ${endpoint}: ${detail}\n`
      + '  If this is code 10000, the API token is missing Account → D1 → Read.',
    );
  }
  return body.result?.[0]?.results ?? [];
}

/** Page through a query with a stable ORDER BY. `sqlFor(limit, offset)`. */
async function paged(sqlFor, deps) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const batch = await d1Query(sqlFor(PAGE, offset), [], deps);
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

// ── the export ──────────────────────────────────────────────────────────────

/**
 * Read the registry and write the snapshot tree under `outDir`.
 *
 * Location files are written as a REPLACEMENT SET: every `.json` in
 * `data/locations/` that this run did not write is deleted. A deleted record
 * must disappear from the mirror, and an export that only ever adds files turns
 * the backup into an accumulation of every record that ever existed, and
 * restoring from it resurrects them.
 *
 * @returns {Promise<{locations:number, deleted:number, dismissed:number, tags:number, auditAppended:number, fromAuditId:number}>}
 */
export async function exportSnapshot({ outDir, dryRun = false, deps = {} }) {
  const dataDir = path.join(outDir, 'data');
  const locDir = path.join(dataDir, 'locations');

  const rows = await paged(
    (l, o) => `SELECT id, name, nexus_id, category, x, y, z, yaw, description, credits,
                      authors, status, added_at, modified_at
                 FROM locations ORDER BY id LIMIT ${l} OFFSET ${o}`,
    deps,
  );
  if (rows.length === 0) {
    // An empty registry is a catastrophe upstream, not a quiet night. Writing
    // it would replace a good snapshot with 297 deletions in one commit.
    throw new Error('locations is empty: refusing to export (this would blank the snapshot)');
  }

  const links = await paged(
    (l, o) => `SELECT location_id, tag_slug FROM location_tags
                 ORDER BY location_id, tag_slug LIMIT ${l} OFFSET ${o}`,
    deps,
  );
  const tagsByLocation = new Map();
  for (const { location_id: id, tag_slug: slug } of links) {
    if (!tagsByLocation.has(id)) tagsByLocation.set(id, []);
    tagsByLocation.get(id).push(slug);
  }

  const dismissed = await paged(
    (l, o) => `SELECT nexus_id FROM dismissed_candidates ORDER BY nexus_id LIMIT ${l} OFFSET ${o}`,
    deps,
  );
  const tags = await paged(
    (l, o) => `SELECT slug, name, description, sort_order, created_at, updated_at
                 FROM tags ORDER BY slug LIMIT ${l} OFFSET ${o}`,
    deps,
  );

  const auditPath = path.join(dataDir, 'audit_log.jsonl');
  const existingAudit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8') : '';
  const fromAuditId = lastAuditId(existingAudit);
  const auditRows = await paged(
    (l, o) => `SELECT id, at, actor, action, target, before, after FROM audit_log
                 WHERE id > ${fromAuditId} ORDER BY id LIMIT ${l} OFFSET ${o}`,
    deps,
  );

  const wanted = new Map(rows.map((r) => [`${r.id}.json`, locationFile(r, tagsByLocation.get(r.id) ?? [])]));
  const present = fs.existsSync(locDir)
    ? fs.readdirSync(locDir).filter((f) => f.endsWith('.json'))
    : [];
  const stale = present.filter((f) => !wanted.has(f));

  const summary = {
    locations: wanted.size,
    deleted: stale.length,
    dismissed: dismissed.length,
    tags: tags.length,
    auditAppended: auditRows.length,
    fromAuditId,
  };
  if (dryRun) return summary;

  fs.mkdirSync(locDir, { recursive: true });
  for (const [file, record] of wanted) {
    fs.writeFileSync(path.join(locDir, file), serialize(record));
  }
  for (const file of stale) fs.rmSync(path.join(locDir, file));

  fs.writeFileSync(path.join(dataDir, 'excluded_mods.json'), serialize(excludedFile(dismissed)));
  fs.writeFileSync(path.join(dataDir, 'tags.json'), serialize(tagsFile(tags)));

  if (auditRows.length) {
    // Append. Rewriting would let a redaction bug or a schema change silently
    // rewrite history, and history is the thing this file is.
    const needsNewline = existingAudit.length > 0 && !existingAudit.endsWith('\n');
    const lines = auditRows.map((r) => JSON.stringify(auditLine(r))).join('\n');
    fs.appendFileSync(auditPath, `${needsNewline ? '\n' : ''}${lines}\n`);
  } else if (!fs.existsSync(auditPath)) {
    fs.writeFileSync(auditPath, '');
  }

  return summary;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1]
  && import.meta.url.endsWith(path.basename(process.argv[1]));

if (invokedDirectly) {
  const outIdx = process.argv.indexOf('--out');
  if (outIdx === -1 || !process.argv[outIdx + 1]) {
    console.error('usage: export_d1_snapshot.mjs --out <dir> [--dry-run]');
    process.exit(1);
  }
  const outDir = path.resolve(process.argv[outIdx + 1]);
  const dryRun = process.argv.includes('--dry-run');

  exportSnapshot({ outDir, dryRun })
    .then((s) => {
      console.log(
        `${dryRun ? '[dry run] ' : ''}${s.locations} location(s)`
        + `${s.deleted ? `, ${s.deleted} removed` : ''}`
        + `\n  ${s.dismissed} dismissed candidate id(s), ${s.tags} tag(s)`
        + `\n  ${s.auditAppended} audit row(s) appended (resumed after id ${s.fromAuditId})`,
      );
    })
    .catch((err) => {
      console.error(String(err.stack || err));
      process.exitCode = 1;
    });
}
