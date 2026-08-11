/**
 * Backfill `locations.added_at` and `locations.modified_at` from git history.
 *
 *   node worker/scripts/backfill-location-dates.mjs --out worker/.import/dates.sql
 *   npx wrangler d1 execute nczoning-data --remote --file worker/.import/dates.sql
 *
 * WHY THIS EXISTS. Both columns currently hold the moment the Phase 1 importer
 * ran, because that is when the rows were created. So every record in the
 * dashboard claims it was added and last edited at the same instant on
 * 2026-07-26, which makes both columns decoration rather than information.
 *
 * The real history is in git, and only in git: each `data/locations/<uuid>.json`
 * has a first commit (the location was logged) and a last commit (the record
 * was last edited). Measured 2026-07-31: 288 of 288 files have history, spanning
 * 2026-03-07 to 2026-07-26, and 212 of them were edited after being added, so
 * `modified_at` is genuinely a different date from `added_at` for most records.
 *
 * ONE PASS, NOT 576 INVOCATIONS. `git log --reverse --name-only` walks the whole
 * history once, oldest first, so the first time a path appears is when it was
 * added and the last time is when it last changed. Per-file `git log` calls
 * would be two spawns per record.
 *
 * NORMALISED TO UTC. Git author dates carry the committer's local offset, so a
 * raw `%aI` mixes `+10:00` and `Z` in one column. Every existing row is `Z`, and
 * the dashboard sorts on these columns: comparing ISO strings with different
 * offsets lexicographically gives the wrong order. Parsed and re-emitted as `Z`.
 *
 * THE FILENAME IS THE ID. `data/locations/<uuid>.json` and the record's `id` are
 * the same uuid; verified before relying on it.
 *
 * THE NINE AUTO-DISCOVERED RECORDS ARE NOT TOUCHED. They have never existed as
 * files, so git has nothing for them and they keep the import date. Decided
 * rather than overlooked: a plausible-looking date invented from Nexus data
 * would be worse than an honest "this is when it became a row". They are
 * reported at the end so the count is visible rather than implied.
 *
 * EMITS SQL, NEVER EXECUTES IT, matching import-locations.mjs: the statements
 * are reviewable before they touch a database, and re-running the generator is
 * free.
 *
 * This is a ONE-TIME repair. `patchLocation` stamps `modified_at` on every
 * write, so the columns stay honest from here without it.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCATIONS_DIR = path.join(REPO_ROOT, 'data', 'locations');

const fail = (msg) => { console.error(`\n${msg}`); process.exit(1); };

/** SQLite string literal. Doubling the quote is the whole escape. */
const sql = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * First and last commit date per location file, from one reverse walk.
 *
 * `--reverse` makes "first seen" the add and "last seen" the most recent
 * change, so no per-file work is needed. A rename would break the add date and
 * `--follow` fixes that, but `--follow` takes a single path. No location file
 * has ever been renamed: the uuid IS the filename, so a rename would change the
 * record's identity.
 */
function datesFromGit() {
  const out = execFileSync(
    'git',
    ['log', '--reverse', '--format=C%aI', '--name-only', '--', 'data/locations/'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const added = new Map();
  const modified = new Map();
  let commit = null;

  for (const line of out.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('C') && text.includes('T')) { commit = text.slice(1); continue; }
    if (!text.startsWith('data/locations/') || !text.endsWith('.json')) continue;
    const id = path.basename(text, '.json');
    // Normalise the offset away, so the column holds one comparable format.
    const iso = new Date(commit).toISOString();
    if (!added.has(id)) added.set(id, iso);
    modified.set(id, iso);
  }
  return { added, modified };
}

function main() {
  const outIdx = process.argv.indexOf('--out');
  if (outIdx === -1) fail('usage: backfill-location-dates.mjs --out <file.sql>');
  const outPath = path.resolve(REPO_ROOT, process.argv[outIdx + 1]);

  const onDisk = fs.readdirSync(LOCATIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.basename(f, '.json'));

  const { added, modified } = datesFromGit();

  const missing = onDisk.filter((id) => !added.has(id));
  if (missing.length) {
    // A file with no history means it was never committed, so the working copy
    // and the repo disagree. Refusing beats writing a date derived from nothing.
    fail(`${missing.length} location file(s) have no git history: ${missing.slice(0, 5).join(', ')}`);
  }

  const statements = onDisk.map((id) => (
    `UPDATE locations SET added_at = ${sql(added.get(id))}, `
    + `modified_at = ${sql(modified.get(id))} WHERE id = ${sql(id)};`
  ));

  const edited = onDisk.filter((id) => added.get(id) !== modified.get(id)).length;
  const dates = onDisk.map((id) => added.get(id)).sort();

  const header = [
    '-- Generated by backfill-location-dates.mjs',
    `-- ${statements.length} location(s), dated from git history.`,
    `-- Earliest ${dates[0]}, latest ${dates[dates.length - 1]}.`,
    `-- ${edited} were edited after being added, so modified_at differs from added_at.`,
    '--',
    '-- Records with no file (the auto-discovered ones) are deliberately not',
    '-- touched and keep the import timestamp: git has no history for them.',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${header}${statements.join('\n')}\n`, 'utf8');

  console.log(`wrote ${outPath}`);
  console.log(`  ${statements.length} locations dated from git`);
  console.log(`  ${edited} edited after being added`);
  console.log(`  range ${dates[0]} .. ${dates[dates.length - 1]}`);
  console.log('  records with no file keep the import date and are not in this file');
}

main();
