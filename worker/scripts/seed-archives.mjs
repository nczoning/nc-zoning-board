#!/usr/bin/env node
/**
 * Merge manual archive/xl seeds (archive-seeds.json) into a dump of the KV
 * archive cache, for mods whose Nexus "Preview file contents" is bugged (404 /
 * "Content could not be loaded at this time") so the cron can't read them.
 *
 * This is a PURE merge (reads files + fetches the dataset for updated_at, writes
 * the merged cache). It deliberately does NOT call wrangler itself — run it
 * between a `kv key get` and a `kv key put` (below). Each seed is stamped with
 * the mod's CURRENT updated_at, so the cron treats it as fresh and won't
 * overwrite it; when the mod re-uploads, updated_at changes and the cron
 * refetches (by then the file is usually on the readable UUID path). One-off per
 * environment — re-run on production after a dev -> main promotion.
 *
 * STAGING (ns ac85bf5c0b6f47afac35085408857d4b):
 *   npx wrangler kv key get --remote --namespace-id ac85bf5c0b6f47afac35085408857d4b dataset:v1:archives > cache.json
 *   node scripts/seed-archives.mjs https://api-dev.nczoning.net cache.json merged.json
 *   npx wrangler kv key put --remote --namespace-id ac85bf5c0b6f47afac35085408857d4b dataset:v1:archives --path merged.json
 *
 * PRODUCTION (ns d86735e00790417e948e423c3df01d68): same three steps, swapping
 *   the namespace id and https://api.nczoning.net for the api base.
 *
 * The next cron tick republishes the dataset with the seeded values attached.
 * Idempotent: safe to re-run.
 *
 * Usage: node scripts/seed-archives.mjs <api-base> <cache-in.json> <merged-out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [apiBase, cacheIn, mergedOut] = process.argv.slice(2);
if (!apiBase || !cacheIn || !mergedOut) {
  console.error('Usage: node scripts/seed-archives.mjs <api-base> <cache-in.json> <merged-out.json>');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const seeds = JSON.parse(readFileSync(join(here, 'archive-seeds.json'), 'utf8'));
const ids = Object.keys(seeds).filter((k) => /^\d+$/.test(k));
const cache = JSON.parse(readFileSync(cacheIn, 'utf8').trim() || '{}');

// Current updated_at per mod, so the seed is fresh (not-stale) and self-heals.
const locs = await fetch(`${apiBase}/v1/locations`, { headers: { 'User-Agent': 'Mozilla/5.0' } }).then((r) => r.json());
const updatedAt = Object.fromEntries(locs.data.map((r) => [r.nexus_id, r.updated_at ?? null]));

for (const id of ids) {
  if (!(id in updatedAt)) console.warn(`  warning: ${id} not in the dataset — seeding anyway`);
  cache[id] = { updatedAt: updatedAt[id] ?? cache[id]?.updatedAt ?? null, archives: seeds[id] };
  console.log(`  seed ${id}: ${seeds[id].length} files`);
}

writeFileSync(mergedOut, JSON.stringify(cache));
console.log(`Merged ${ids.length} seeds; cache now ${Object.keys(cache).length} entries -> ${mergedOut}`);
