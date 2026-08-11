/**
 * Registry import: data/locations/*.json + the live auto-discovered records ->
 * D1 `locations`; data/excluded_mods.json -> `dismissed_candidates`.
 *
 * TWO CALLERS, and the difference between them is `--files-only`:
 *
 * 1. The Phase 1 migration (the default). Manual records come from the JSON
 *    files, auto-discovered ones from the live API, because at that moment the
 *    nine `nexus-` records exist only in the running system.
 * 2. DISASTER RECOVERY from the `data-snapshots` branch (`--files-only`), where
 *    all 297 are files. Fetching the live API there would re-add the nine and
 *    die on the primary key, and there may be no live API to fetch from: that
 *    is the situation a restore is for.
 *
 *   node worker/scripts/import-locations.mjs --files-only \
 *     --data ../snapshot/data --out worker/.import/restore.sql
 *
 * `--data <dir>` points at a snapshot checkout instead of the working tree.
 *
 * Emits SQL rather than executing it, for three reasons: the 296 rows are
 * reviewable before they land, `wrangler d1 execute --file` is the same command
 * in CI as by hand, and re-running the generator is free.
 *
 *   node worker/scripts/import-locations.mjs --out worker/.import/0001-seed.sql
 *   npx wrangler d1 execute nczoning-data --remote --file worker/.import/0001-seed.sql
 *
 * Deliberately plain INSERTs, no upsert and no leading DELETE: running this
 * twice must FAIL on the primary key rather than quietly duplicate or quietly
 * wipe. Re-importing means recreating the table via migrations.
 *
 * IDS ARE PRESERVED EXACTLY. `?mod=` deep links resolve to the numeric nexus_id
 * when there is one and the UUID otherwise (assets/js/utils.js, modLinkId), so
 * every link ever shared in Discord or on a Nexus page depends on these strings
 * surviving the move unchanged. There is no tidy-up step here, and
 * parity-check.mjs asserts the id set afterwards.
 *
 * The two source paths are deliberately different: manual records are read from
 * the JSON files (their source of truth), auto-discovered records from the live
 * API (theirs -- they have never existed as files). The live API is the
 * still-running reference system, which is exactly what makes it the right
 * thing to import from.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE_API = process.env.NCZ_API_ORIGIN || 'https://api.nczoning.net';

/** Resolved from `--data`; defaults to the working tree's own data directory. */
function dataPaths(dataDir) {
  return {
    locations: path.join(dataDir, 'locations'),
    excluded: path.join(dataDir, 'excluded_mods.json'),
    tags: path.join(dataDir, 'tags.json'),
  };
}

/**
 * SQLite string literal. Doubling the single quote is the whole escape --
 * embedded newlines and unicode are legal inside a literal. A NUL byte is not
 * representable and would truncate the statement silently, so it throws.
 */
function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number: ${value}`);
    return String(value);
  }
  const str = String(value);
  if (str.includes('\0')) throw new Error(`NUL byte in value: ${str.slice(0, 60)}`);
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Map a location record (either source) onto a `locations` row.
 * `coordinates` may legally be [x, y] or [x, y, z]; a missing Z stays NULL
 * rather than becoming 0, so the materializer can rebuild the shorter array.
 */
function toRow(rec, stamp) {
  const [x, y, z] = rec.coordinates;
  if (typeof x !== 'number' || typeof y !== 'number') {
    throw new Error(`${rec.id}: coordinates must be numeric, got ${JSON.stringify(rec.coordinates)}`);
  }
  return {
    id: rec.id,
    name: rec.name,
    nexus_id: String(rec.nexus_id),
    category: rec.category,
    x, y,
    z: z === undefined ? null : z,
    yaw: rec.yaw === undefined ? null : rec.yaw,
    description: rec.description ?? '',
    // Empty-string credits mean "none" in the JSON files, the same thing a
    // missing key means. Stored as NULL so `credits IS NOT NULL` is a truthful
    // query in D1. Parity-neutral by construction: merge.js and materialize.js both
    // gate on truthiness, so '' and NULL alike omit the key from /v1.
    credits: rec.credits ? rec.credits : null,
    authors: JSON.stringify(rec.authors ?? []),
    // Not a column any more (migration 0007). Carried on the row because
    // insertLocationTags reads it to build the join.
    tags: JSON.stringify(rec.tags ?? []),
    // A snapshot file carries all three; a Phase 1 source file carries none.
    // `stamp` is honest for the second case ("this is when it became a row") and
    // wrong for the first: a restore that stamps every record with the restore
    // time discards the dates #906 recovered from git history.
    status: rec.status ?? 'published',
    added_at: rec.added_at ?? stamp,
    modified_at: rec.modified_at ?? stamp,
  };
}

const COLUMNS = [
  'id', 'name', 'nexus_id', 'category', 'x', 'y', 'z', 'yaw',
  'description', 'credits', 'authors', 'status',
  'added_at', 'modified_at',
];

function insertLocation(row) {
  const values = COLUMNS.map((c) => sql(row[c])).join(', ');
  return `INSERT INTO locations (${COLUMNS.join(', ')}) VALUES (${values});`;
}

/**
 * The tag links for one row. THE JOIN, NOT JUST THE COLUMN.
 *
 * `materialize.js` treats `location_tags` as authoritative, so a database built
 * without these rows serves every location with no tags at all. `locations`
 * looks correct and only the join is empty, which makes the failure silent.
 *
 * Reads the record's own tag array rather than `locations.tags`, so this keeps
 * working when that column is dropped (planned, #888 stage 7).
 *
 * `IN (SELECT slug FROM tags)` filters through the registry as it exists in the
 * target database at import time, which drops anything not curated without this
 * script needing to know the registry. Same rule migration 0002 used for its
 * backfill. Callers are warned about tags this will drop.
 */
function insertLocationTags(row) {
  const tags = JSON.parse(row.tags);
  if (!tags.length) return [];
  return [
    'INSERT INTO location_tags (location_id, tag_slug)\n'
    + `  SELECT ${sql(row.id)}, je.value FROM json_each(${sql(row.tags)}) je\n`
    + '  WHERE je.value IN (SELECT slug FROM tags);',
  ];
}

/** Records held as files: one JSON file each, `<id>.json`. */
function readFiles(dir, stamp) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    return toRow(rec, stamp);
  });
}

/** Auto-discovered records, from the live dataset they currently live in. */
async function readAuto(stamp) {
  const res = await fetch(`${LIVE_API}/v1/locations`);
  if (!res.ok) throw new Error(`GET /v1/locations -> HTTP ${res.status}`);
  const body = await res.json();
  const records = body.data;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('live /v1/locations returned no records');
  }
  // `source` is no longer served; the nexus-<id> primary key carries the same
  // provenance. Verified against production: 9 of 9 auto rows have it, 0 manual do.
  return records.filter((r) => r.id.startsWith('nexus-')).map((r) => toRow(r, stamp));
}

/**
 * The exclusion list. Each entry is a decision about a Nexus mod that was never
 * a location, so it becomes a dismissal, not a `locations` row with a special
 * status. `dismissed_by` is 'system': the repo records no author for these, and
 * inventing one would be a fabrication.
 *
 * TWO SHAPES, and getting this wrong corrupts rather than crashes. The repo file
 * is `{ "29860": "reason" }`; the snapshot branch's is a bare `["29860"]`,
 * because the reasons are admin-only and redacted out of the export. Running
 * Object.entries over the array form yields `["0", "29860"]`, which imports a
 * dismissal for nexus id `0` and loses the real one, silently.
 */
function readDismissed(file, stamp) {
  const excluded = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Array.isArray(excluded)
    ? excluded.map((id) => [String(id), null])
    : Object.entries(excluded);
  return entries.map(([nexusId, reason]) => (
    `INSERT INTO dismissed_candidates (nexus_id, reason, dismissed_by, dismissed_at) `
    + `VALUES (${sql(nexusId)}, ${sql(reason)}, ${sql('system')}, ${sql(stamp)});`
  ));
}

/**
 * The tag registry, in whichever shape the source file uses.
 *
 * Repo file:     `{ slug: description }`      (predates `name` and `sort_order`)
 * Snapshot file: `[{ slug, name, description, sort_order, ... }]`
 *
 * Returns `{ slugs, statements }`. `slugs` is what the unknown-tag warning
 * checks against. `statements` restores the registry itself and is emitted ONLY
 * for the full-row shape: migration 0002 seeds the tags as they stood on
 * 2026-07-26, so a restore from a later snapshot would otherwise silently drop
 * every tag curated in the dashboard since, and every location_tags link that
 * referenced one. The flat shape cannot carry `name`/`sort_order`, so importing
 * from it would overwrite curated values with nulls; it stays read-only.
 */
function readTags(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) {
    return { slugs: new Set(Object.keys(parsed)), statements: [] };
  }
  return {
    slugs: new Set(parsed.map((t) => t.slug)),
    statements: parsed.map((t) => (
      'INSERT OR REPLACE INTO tags (slug, name, description, sort_order, created_at, updated_at) '
      + `VALUES (${sql(t.slug)}, ${sql(t.name ?? null)}, ${sql(t.description)}, `
      + `${sql(t.sort_order ?? null)}, ${sql(t.created_at)}, ${sql(t.updated_at)});`
    )),
  };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

async function main() {
  const out = arg('--out');
  if (!out) {
    console.error('usage: import-locations.mjs --out <file.sql> [--files-only] [--data <dir>]');
    process.exit(1);
  }
  const outPath = path.resolve(out);
  const filesOnly = process.argv.includes('--files-only');
  const dataDir = path.resolve(arg('--data') ?? path.join(REPO_ROOT, 'data'));
  const paths = dataPaths(dataDir);
  const stamp = new Date().toISOString();

  const fromFiles = readFiles(paths.locations, stamp);
  const auto = filesOnly ? [] : await readAuto(stamp);
  const rows = [...fromFiles, ...auto];

  // Duplicate ids would be caught by the primary key on execute, but failing
  // here names both records instead of just the id.
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate id ${r.id}: "${seen.get(r.id)}" and "${r.name}"`);
    seen.set(r.id, r.name);
  }

  const dismissed = readDismissed(paths.excluded, stamp);

  // Tags the registry will drop. The filter runs in SQL against the target
  // database, so this script cannot refuse them, but a silent truncation would
  // leave a location quietly short a tag nobody asked to remove.
  const { slugs: known, statements: tagRows } = readTags(paths.tags);
  const unknown = new Map();
  for (const r of rows) {
    for (const t of JSON.parse(r.tags)) {
      if (!known.has(t)) unknown.set(t, (unknown.get(t) ?? 0) + 1);
    }
  }

  const tagLinks = rows.flatMap(insertLocationTags);
  const expectedLinks = rows.reduce(
    (n, r) => n + JSON.parse(r.tags).filter((t) => known.has(t)).length, 0,
  );

  const body = [
    `-- Generated ${stamp} by worker/scripts/import-locations.mjs`,
    `-- source: ${dataDir}${filesOnly ? ' (--files-only, no live API read)' : ` + ${LIVE_API}`}`,
    `-- ${fromFiles.length} file(s) + ${auto.length} auto = ${rows.length} locations,`,
    `-- ${dismissed.length} dismissed candidate(s). Plain INSERTs: re-running fails.`,
    `-- ${tagLinks.length} location(s) carry tags, ${expectedLinks} link(s) expected in`,
    '-- location_tags, assuming the target registry matches tags.json.',
    '',
    ...rows.map(insertLocation),
    '',
    // Before the join, so the `IN (SELECT slug FROM tags)` filter below sees the
    // registry as the snapshot recorded it rather than as migration 0002 seeded
    // it. Empty when the source file is the legacy flat map (see readTags).
    ...(tagRows.length
      ? ['-- The tag registry as at the snapshot. Overwrites migration 0002\'s seed.', ...tagRows, '']
      : []),
    '-- The join. Without these the materializer serves every location untagged.',
    ...tagLinks,
    '',
    ...dismissed,
    '',
    '-- Printed when this file is executed. `links` must match the header count,',
    '-- and `untagged` must be the number of locations that genuinely have none.',
    'SELECT (SELECT COUNT(*) FROM locations) AS locations,',
    '       (SELECT COUNT(*) FROM location_tags) AS links,',
    '       (SELECT COUNT(*) FROM locations l',
    '          WHERE NOT EXISTS (SELECT 1 FROM location_tags lt WHERE lt.location_id = l.id))',
    '         AS untagged;',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
  console.log(
    `wrote ${outPath}\n  ${fromFiles.length} file(s) + ${auto.length} auto = ${rows.length} locations`
    + `\n  ${dismissed.length} dismissed candidate(s)`
    + `\n  ${expectedLinks} tag link(s) across ${tagLinks.length} location(s)`
    + `\n  ${tagRows.length} tag registry row(s) restored`,
  );
  if (unknown.size) {
    console.warn(`\n  WARNING: ${unknown.size} tag(s) are not in ${paths.tags} and the`);
    console.warn('  registry filter will drop them, leaving those locations short a tag:');
    for (const [t, n] of unknown) console.warn(`    ${t} (on ${n} record(s))`);
  }
}

main().catch((err) => {
  console.error(String(err.stack || err));
  process.exit(1);
});
