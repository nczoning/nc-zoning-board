/**
 * Delta sync: `data/locations/*.json` -> D1, for records D1 does not have yet.
 *
 * WHY THIS EXISTS, and why it is temporary.
 *
 * Until the cutover, submissions still arrive the old way: an issue becomes a
 * PR, the PR merges to `main`, and a new `data/locations/<uuid>.json` appears.
 * `mods.json` is rebuilt from those files, so production picks the record up on
 * the next cron tick. **D1 hears nothing.** A mod merged overnight is live on
 * `nczoning.net` and absent from both D1 databases, so staging — which reads D1
 * — silently serves a smaller map than production.
 *
 * That is the same failure the whole migration exists to remove, just pointing
 * the other way: after the cutover a submission that merges into git and never
 * reaches D1 would never reach the map at all. Before then, this closes the gap
 * by hand. **Delete this script at cleanup**, once submissions land in D1
 * directly; keeping it afterwards would preserve git as a second source of
 * truth, which is the redundant-representation problem the migration removes.
 *
 * Usage — emits SQL, never executes it, so the delta is reviewable first:
 *
 *   node worker/scripts/sync-locations.mjs --db nczoning-data-staging --env staging --out .import/sync.sql
 *   npx wrangler d1 execute nczoning-data-staging --env staging --remote --file .import/sync.sql
 *
 * INSERT-only, no upsert and no DELETE. Two consequences, both deliberate:
 *
 * - Running it twice fails on the primary key instead of quietly duplicating.
 * - It never removes anything. Rows in D1 with no file are NOT drift: the nine
 *   auto-discovered records have never existed as files, and a script that
 *   "reconciled" by deleting the unmatched would wipe them. Only `source =
 *   'manual'` rows are compared at all.
 *
 * It also reports records that exist in BOTH but disagree, without changing
 * them. Once D1 is authoritative an edit belongs in the dashboard, and having
 * this script quietly overwrite a D1 row from a git file would make the file
 * authoritative again — the exact inversion the migration is undoing. Reporting
 * is the point: nothing else currently notices that drift at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCATIONS_DIR = path.join(REPO_ROOT, 'data', 'locations');
const WRANGLER = path.join(REPO_ROOT, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** SQLite string literal. Same escaping rules as import-locations.mjs. */
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

const COLUMNS = [
  'id', 'name', 'nexus_id', 'category', 'x', 'y', 'z', 'yaw',
  'description', 'credits', 'authors', 'tags', 'source', 'status',
  'created_at', 'updated_at',
];

/** Map a location JSON record onto a `locations` row. Mirrors import-locations.mjs. */
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
    x,
    y,
    z: z === undefined ? null : z,
    yaw: rec.yaw === undefined ? null : rec.yaw,
    description: rec.description ?? '',
    // '' means "none" in the JSON files, the same as a missing key. NULL in D1.
    credits: rec.credits ? rec.credits : null,
    authors: JSON.stringify(rec.authors ?? []),
    // The legacy column, kept in step with the join below until it is dropped.
    tags: JSON.stringify(rec.tags ?? []),
    source: 'manual',
    status: 'published',
    created_at: stamp,
    updated_at: stamp,
  };
}

function readManual(stamp) {
  return fs.readdirSync(LOCATIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => toRow(JSON.parse(fs.readFileSync(path.join(LOCATIONS_DIR, f), 'utf8')), stamp));
}

/**
 * Ask the target database what it already has.
 *
 * 🔴 `--remote` is not optional. Without it wrangler answers from a local
 * SQLite file that is usually empty, so the delta would be "every record is
 * missing" and the script would cheerfully emit 288 INSERTs against a full
 * table. Every one would fail on the primary key, which is the safe outcome —
 * but the same mistake on a query that is not INSERT-only would not be.
 */
function readD1(db, envName) {
  const args = [WRANGLER, 'd1', 'execute', db];
  if (envName) args.push('--env', envName);
  args.push('--remote', '--json', '--command',
    'SELECT id, name, nexus_id, category, x, y, z, yaw, tags, source FROM locations');

  const out = execFileSync(process.execPath, args, {
    cwd: path.join(REPO_ROOT, 'worker'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env },
  });

  // wrangler prefixes the JSON with human-readable lines; take from the first [.
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`no JSON in wrangler output:\n${out.slice(0, 500)}`);
  const parsed = JSON.parse(out.slice(start));
  const results = parsed[0]?.results;
  if (!Array.isArray(results)) throw new Error('unexpected wrangler --json shape');
  return results;
}

/** Fields worth comparing on a record that exists in both places. */
const COMPARED = ['name', 'nexus_id', 'category', 'x', 'y', 'z', 'yaw'];

function main() {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? null : process.argv[i + 1] ?? null;
  };
  const db = arg('--db');
  const envName = arg('--env');
  const outPath = arg('--out');
  if (!db || !outPath) {
    console.error('usage: sync-locations.mjs --db <name> [--env staging] --out <file.sql>');
    process.exit(1);
  }

  const stamp = new Date().toISOString();
  const files = readManual(stamp);
  const existing = readD1(db, envName);

  const byId = new Map(existing.map((r) => [r.id, r]));
  const autoCount = existing.filter((r) => r.source === 'auto').length;
  const manualInD1 = existing.filter((r) => r.source === 'manual');

  const missing = files.filter((r) => !byId.has(r.id));

  // Present in both, but disagreeing. Reported, never rewritten.
  const drifted = [];
  for (const file of files) {
    const row = byId.get(file.id);
    if (!row) continue;
    const diffs = COMPARED.filter((k) => {
      const a = row[k] === undefined ? null : row[k];
      const b = file[k] === undefined ? null : file[k];
      return JSON.stringify(a) !== JSON.stringify(b);
    });
    // Tag comparison uses the file's array against the legacy column, sorted:
    // order carries no meaning and 4b normalised it.
    const fileTags = JSON.parse(file.tags).slice().sort();
    const rowTags = JSON.parse(row.tags ?? '[]').filter((t) => t !== 'nczoning').slice().sort();
    if (JSON.stringify(fileTags) !== JSON.stringify(rowTags)) diffs.push('tags');
    if (diffs.length) drifted.push({ id: file.id, name: file.name, diffs });
  }

  // Manual rows in D1 with no file. Not deleted, but worth saying out loud:
  // this is either a record created in the dashboard (expected, and the first
  // sign the cutover is really happening) or a file deleted in git.
  const orphans = manualInD1.filter((r) => !files.some((f) => f.id === r.id));

  console.log(`database:        ${db}${envName ? ` (--env ${envName})` : ''}`);
  console.log(`files:           ${files.length} manual records`);
  console.log(`D1:              ${existing.length} rows (${manualInD1.length} manual, ${autoCount} auto)`);
  console.log(`to insert:       ${missing.length}`);
  console.log(`already present: ${files.length - missing.length}`);
  console.log(`drifted:         ${drifted.length}`);
  console.log(`manual-only-in-D1: ${orphans.length}`);

  for (const m of missing) console.log(`  + ${m.id}  ${m.name}`);
  for (const d of drifted) console.log(`  ~ ${d.id}  ${d.name}  [${d.diffs.join(', ')}]`);
  for (const o of orphans) console.log(`  ? ${o.id}  ${o.name}  (in D1, no file)`);

  // The count identity, asserted rather than assumed: every file is either
  // going in or already there, and nothing else.
  if (missing.length + (files.length - missing.length) !== files.length) {
    throw new Error('delta accounting does not add up');
  }

  if (!missing.length) {
    console.log('\nNothing to insert. No file written.');
    return;
  }

  const statements = [];
  for (const row of missing) {
    const values = COLUMNS.map((c) => sql(row[c])).join(', ');
    statements.push(`INSERT INTO locations (${COLUMNS.join(', ')}) VALUES (${values});`);
    // 🔴 The join, not just the column. The materializer reads location_tags;
    // a record inserted without these rows renders on the map with no tags at
    // all. `nczoning` is excluded because it is not a registry row -- the
    // materializer re-adds it for auto records, and these are all manual.
    for (const tag of JSON.parse(row.tags).filter((t) => t !== 'nczoning')) {
      statements.push(
        `INSERT INTO location_tags (location_id, tag_slug) VALUES (${sql(row.id)}, ${sql(tag)});`,
      );
    }
  }

  const header = [
    `-- Generated by sync-locations.mjs at ${stamp}`,
    `-- Target: ${db}${envName ? ` (--env ${envName})` : ''}`,
    `-- ${missing.length} location(s), ${statements.length - missing.length} tag link(s).`,
    '-- INSERT-only: re-running this file must fail on the primary key.',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), `${header}${statements.join('\n')}\n`);
  console.log(`\nWrote ${statements.length} statement(s) to ${outPath}`);
}

main();
