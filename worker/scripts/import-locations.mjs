/**
 * One-time Phase 1 import: data/locations/*.json + the live auto-discovered
 * records -> D1 `locations`; data/excluded_mods.json -> `dismissed_candidates`.
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
const LOCATIONS_DIR = path.join(REPO_ROOT, 'data', 'locations');
const EXCLUDED_FILE = path.join(REPO_ROOT, 'data', 'excluded_mods.json');
const LIVE_API = process.env.NCZ_API_ORIGIN || 'https://api.nczoning.net';

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
function toRow(rec, source, stamp) {
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
    tags: JSON.stringify(rec.tags ?? []),
    source,
    status: 'published',
    created_at: stamp,
    updated_at: stamp,
  };
}

const COLUMNS = [
  'id', 'name', 'nexus_id', 'category', 'x', 'y', 'z', 'yaw',
  'description', 'credits', 'authors', 'tags', 'source', 'status',
  'created_at', 'updated_at',
];

function insertLocation(row) {
  const values = COLUMNS.map((c) => sql(row[c])).join(', ');
  return `INSERT INTO locations (${COLUMNS.join(', ')}) VALUES (${values});`;
}

/** Manual records: one JSON file each, UUID filenames. */
function readManual(stamp) {
  const files = fs.readdirSync(LOCATIONS_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const rec = JSON.parse(fs.readFileSync(path.join(LOCATIONS_DIR, f), 'utf8'));
    return toRow(rec, 'manual', stamp);
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
  return records.filter((r) => r.source === 'auto').map((r) => toRow(r, 'auto', stamp));
}

/**
 * The exclusion list. Each entry is a decision about a Nexus mod that was never
 * a location, so it becomes a dismissal, not a `locations` row with a special
 * status. `dismissed_by` is 'system': the repo records no author for these, and
 * inventing one would be a fabrication.
 */
function readDismissed(stamp) {
  const excluded = JSON.parse(fs.readFileSync(EXCLUDED_FILE, 'utf8'));
  return Object.entries(excluded).map(([nexusId, reason]) => (
    `INSERT INTO dismissed_candidates (nexus_id, reason, dismissed_by, dismissed_at) `
    + `VALUES (${sql(nexusId)}, ${sql(reason)}, ${sql('system')}, ${sql(stamp)});`
  ));
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  if (outIdx === -1 || !process.argv[outIdx + 1]) {
    console.error('usage: import-locations.mjs --out <file.sql>');
    process.exit(1);
  }
  const outPath = path.resolve(process.argv[outIdx + 1]);
  const stamp = new Date().toISOString();

  const manual = readManual(stamp);
  const auto = await readAuto(stamp);
  const rows = [...manual, ...auto];

  // Duplicate ids would be caught by the primary key on execute, but failing
  // here names both records instead of just the id.
  const seen = new Map();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate id ${r.id}: "${seen.get(r.id)}" and "${r.name}"`);
    seen.set(r.id, r.name);
  }

  const dismissed = readDismissed(stamp);

  const body = [
    `-- Phase 1 seed, generated ${stamp} by worker/scripts/import-locations.mjs`,
    `-- ${manual.length} manual + ${auto.length} auto = ${rows.length} locations,`,
    `-- ${dismissed.length} dismissed candidate(s). Plain INSERTs: re-running fails.`,
    '',
    ...rows.map(insertLocation),
    '',
    ...dismissed,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body);
  console.log(
    `wrote ${outPath}\n  ${manual.length} manual + ${auto.length} auto = ${rows.length} locations`
    + `\n  ${dismissed.length} dismissed candidate(s)`,
  );
}

main().catch((err) => {
  console.error(String(err.stack || err));
  process.exit(1);
});
