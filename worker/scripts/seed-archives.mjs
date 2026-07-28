#!/usr/bin/env node
/**
 * Write the hand-built archive listings (archive-seeds.json) into
 * `nexus_cache.archives`, for mods whose Nexus "Preview file contents" is
 * bugged (404 / "Content could not be loaded at this time") so the cron cannot
 * read them.
 *
 *   node worker/scripts/seed-archives.mjs --out worker/.import/seed-archives.sql
 *   npx wrangler d1 execute nczoning-data-staging --env staging --remote --file worker/.import/seed-archives.sql
 *   npx wrangler d1 execute nczoning-data --remote --file worker/.import/seed-archives.sql
 *
 * Emits SQL rather than executing it, matching import-locations.mjs: the rows
 * are reviewable before they land and re-running the generator is free.
 *
 * ## The KV mode, until the cutover
 *
 * An environment still on `DATA_SOURCE=mods` reads archives from the KV blob,
 * not from D1, so seeding its database changes nothing it serves. `--kv` emits
 * the merged blob for that path instead:
 *
 *   npx wrangler kv key get --remote --namespace-id <ns> dataset:v1:archives > cache.json
 *   node worker/scripts/seed-archives.mjs --kv cache.json --out merged.json
 *   npx wrangler kv key put --remote --namespace-id <ns> dataset:v1:archives --path merged.json
 *
 * The seeds carry themselves into `nexus_cache` at the flip, because the sweep
 * reads this blob once as its carry-over source. **Delete this mode with the
 * blob**, once every environment is on D1.
 *
 * ## Why D1 is the destination
 *
 * This wrote only to `dataset:v1:archives` until the sweep moved archives into
 * D1. That store is documented as fully derived and recreatable at any time,
 * and on 2026-07-26 it was: the Cloudflare account migration repointed both
 * namespaces and every seeded listing went with them, silently. Hand-built data
 * that cannot be re-derived does not belong in a cache. `nexus_cache` is backed
 * by Time Travel and by the parity gate.
 *
 * ## Two rules that make this safe to re-run
 *
 * `archives_at = updated_at` sets the stamp from the row itself rather than
 * from a clock, so the seed is fresh BY CONSTRUCTION: the sweep refetches when
 * those two disagree, and they cannot disagree the moment this runs. When the
 * mod re-uploads, Nexus reports a new `updated_at`, the two diverge, the sweep
 * refetches, and a real listing replaces the seed. That is the intended end of
 * a seed's life and needs no cleanup.
 *
 * The WHERE clause refuses to overwrite a listing that is already populated, so
 * a real fetch always beats a hand-built one and running this twice changes
 * nothing.
 *
 * ## Run it AFTER the first sweep
 *
 * A mod has no `nexus_cache` row until the sweep creates one, and this only
 * UPDATEs. On a database that has never swept, every statement matches zero
 * rows: the verification query at the end of the file is what catches that.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEEDS_FILE = path.join(HERE, 'archive-seeds.json');

/** SQLite string literal; doubling the single quote is the whole escape. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const outPath = arg('--out');
const kvIn = arg('--kv');
if (!outPath) {
  console.error('Usage: node worker/scripts/seed-archives.mjs [--kv <cache-in.json>] --out <file>');
  process.exit(1);
}

const seeds = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf8'));
const ids = Object.keys(seeds).filter((k) => /^\d+$/.test(k));
if (!ids.length) {
  console.error('archive-seeds.json holds no numeric keys -- nothing to seed.');
  process.exit(1);
}

if (kvIn) {
  // The pre-cutover path. Each seed is stamped with the mod's CURRENT
  // updated_at, taken from the live API, so the cron reads it as fresh and
  // leaves it alone; when the mod re-uploads that value moves and a real
  // listing replaces the seed.
  const api = process.env.NCZ_API_ORIGIN || 'https://api.nczoning.net';
  const cache = JSON.parse(fs.readFileSync(kvIn, 'utf8').trim() || '{}');
  const before = Object.keys(cache).length;
  const live = await fetch(`${api}/v1/locations`, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    .then((r) => r.json());
  const updatedAt = Object.fromEntries(live.data.map((r) => [String(r.nexus_id), r.updated_at ?? null]));

  let applied = 0;
  for (const id of ids) {
    if (!(id in updatedAt)) {
      console.warn(`  warning: ${id} is not in the dataset -- seeding anyway`);
    }
    // A populated listing came from a real fetch and outranks a hand-built one,
    // matching the D1 path's WHERE clause.
    if (cache[id]?.archives?.length) {
      console.log(`  skip ${id}: already holds ${cache[id].archives.length} file(s)`);
      continue;
    }
    cache[id] = { updatedAt: updatedAt[id] ?? cache[id]?.updatedAt ?? null, archives: seeds[id] };
    console.log(`  seed ${id}: ${seeds[id].length} file(s) @ ${cache[id].updatedAt}`);
    applied += 1;
  }

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cache));
  console.log(`\n${applied} seed(s) applied; cache ${before} -> ${Object.keys(cache).length} entries -> ${outPath}`);
  console.log('Put it back with: npx wrangler kv key put --remote --namespace-id <ns> dataset:v1:archives --path ' + outPath);
  process.exit(0);
}

const lines = [
  '-- Generated by worker/scripts/seed-archives.mjs. Do not edit by hand.',
  '--',
  '-- Hand-built archive listings for mods with a bugged Nexus file preview.',
  '-- Only fills a listing that is absent or empty: a real fetch always wins.',
  "-- Stamps archives_at from each row's own updated_at, so the sweep treats the",
  '-- seed as current until the mod re-uploads and a real listing replaces it.',
  '',
];

for (const id of ids) {
  const files = seeds[id];
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
    console.error(`seed ${id} is not an array of strings -- refusing to emit it.`);
    process.exit(1);
  }
  lines.push(`-- mod ${id}: ${files.length} file(s)`);
  lines.push(
    'UPDATE nexus_cache SET '
    + `archives = ${q(JSON.stringify(files))}, `
    + 'archives_at = updated_at '
    + `WHERE nexus_id = ${q(id)} AND (archives IS NULL OR archives = '[]');`,
  );
  lines.push('');
}

// A count, not a spot check: a statement that matched nothing is silent, and an
// unswept database would produce a file that runs cleanly and changes nothing.
lines.push('-- Expect seeded = the mod count above. Anything less means those rows');
lines.push('-- were absent (sweep has not run) or already carried a real listing.');
lines.push(
  'SELECT COUNT(*) AS seeded FROM nexus_cache WHERE nexus_id IN ('
  + ids.map(q).join(', ')
  + ") AND archives IS NOT NULL AND archives != '[]';",
);
lines.push('');

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'));

console.log(`Wrote ${ids.length} seed statement(s) to ${outPath}`);
for (const id of ids) console.log(`  ${id}: ${seeds[id].length} file(s)`);
console.log('\nApply to BOTH databases, after each has swept at least once:');
console.log(`  npx wrangler d1 execute nczoning-data-staging --env staging --remote --file ${outPath}`);
console.log(`  npx wrangler d1 execute nczoning-data --remote --file ${outPath}`);
