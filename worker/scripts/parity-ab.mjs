/**
 * A/B the two materializers head-to-head, locally, across a swept clock.
 *
 *   node worker/scripts/parity-ab.mjs
 *   node worker/scripts/parity-ab.mjs --db nczoning-data-staging --local
 *
 * WHY THIS EXISTS, given parity-check.mjs already passes.
 *
 * parity-check compares D1 against the LIVE API, so it can only ever test the
 * one dataset the world is currently producing. The cron writes KV only when
 * the content hash changes, so on a quiet day `generated_at` does not move for
 * hours and re-running it compares the same bytes over and over -- a check that
 * cannot fail, dressed up as a soak.
 *
 * The Phase 2 gate is really asking: *do the two code paths agree?* That does
 * not need the world to change, because both sides can be driven locally with
 * identical inputs. So this script runs `buildDataset` (mods.json) and
 * `materializeFromD1` (D1 rows) against the SAME Nexus data and the SAME clock,
 * and diffs them -- then sweeps the clock across the recently_updated boundary,
 * which is the only genuinely time-varying field either path computes.
 *
 * Sweeping is the point. Waiting is not a test.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset } from '../src/merge.js';
import { materializeFromD1 } from '../src/materialize.js';
import { RECENTLY_UPDATED_DAYS } from '../src/config.js';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(WORKER_DIR, '..');
const WRANGLER = path.join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'b9937d8d595fad7de8d1549b22390281';
const SITE = process.env.NCZ_SITE_ORIGIN || 'https://nczoning.net';
const LOCAL = process.argv.includes('--local');

// See parity-check.mjs: a staging database is invisible without --env staging.
const envArgs = (db) => (db.endsWith('-staging') ? ['--env', 'staging'] : []);

function query(db, statement) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', db, ...envArgs(db), LOCAL ? '--local' : '--remote', '--json', '--command', statement],
    {
      cwd: WORKER_DIR,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result?.success) throw new Error(`query failed: ${statement}`);
  return result.results;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/** mods.json, rebuilt from the JSON files so this never depends on a stale artifact. */
function readManualMods() {
  const dir = path.join(REPO_ROOT, 'data', 'locations');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Nexus images, taken from the live dataset rather than refetched. Both sides
 * get the identical object, so this isolates the variable under test (do the
 * two paths agree?) instead of adding a second moving part.
 */
function thumbsFromLive(records) {
  const thumbs = {};
  for (const r of records) {
    thumbs[String(r.nexus_id)] = {
      thumbnailUrl: r.thumbnail_url, pictureUrl: r.picture_url, updatedAt: r.updated_at,
    };
  }
  return thumbs;
}

function diff(a, b) {
  const A = Object.values(a);
  const B = Object.values(b);
  if (JSON.stringify(A) === JSON.stringify(B)) return null;
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    if (JSON.stringify(A[i]) !== JSON.stringify(B[i])) {
      return { index: i, id: A[i]?.id ?? B[i]?.id, mods: JSON.stringify(A[i]), d1: JSON.stringify(B[i]) };
    }
  }
  return { index: -1, id: '(length)', mods: `${A.length} records`, d1: `${B.length} records` };
}

async function main() {
  const dbIdx = process.argv.indexOf('--db');
  const db = dbIdx === -1 ? 'nczoning-data' : process.argv[dbIdx + 1];

  const [envelope, subdistricts, tagsDict, excluded] = await Promise.all([
    getJson('https://api.nczoning.net/v1/locations'),
    getJson(`${SITE}/data/subdistricts.json`),
    getJson(`${SITE}/data/tags.json`),
    getJson(`${SITE}/data/excluded_mods.json`).catch(() => ({})),
  ]);
  const live = envelope.data;
  const districts = subdistricts.districts;
  const manualThumbs = thumbsFromLive(live);
  // The D1 builder reads images from the nexus_cache index rather than the
  // modsByUid channel. Deriving it from the same thumbs keeps this an A/B of
  // the two BUILDERS: feeding them different image data would make every
  // difference ambiguous between "the builders disagree" and "the inputs did".
  const nexusIndex = new Map(Object.entries(manualThumbs).map(([id, t]) => [id, {
    thumbnailUrl: t.thumbnailUrl ?? null,
    pictureUrl: t.pictureUrl ?? null,
    updatedAt: t.updatedAt ?? null,
    archives: [],
  }]));
  const manualMods = readManualMods();
  const rows = query(db, 'SELECT * FROM locations ORDER BY id');
  const dismissed = new Set(query(db, 'SELECT nexus_id FROM dismissed_candidates').map((r) => String(r.nexus_id)));

  // The join, not the legacy locations.tags column. Passing this is what makes
  // the comparison test the path production will actually take; without it
  // materializeFromD1 silently falls back to the JSON column and the sweep
  // proves nothing about the migration.
  const locationTags = new Map();
  for (const r of query(db, 'SELECT location_id, tag_slug FROM location_tags ORDER BY location_id, tag_slug')) {
    if (!locationTags.has(r.location_id)) locationTags.set(r.location_id, []);
    locationTags.get(r.location_id).push(r.tag_slug);
  }

  // The tagged-mod nodes both paths consume. Reconstructed from the live auto
  // records so the two sides are fed byte-identical Nexus input; a real fetch
  // would introduce a second variable and could change mid-run.
  // Reconstructing this block is lossy if any recognised key is forgotten, and
  // the loss shows up as a false MISMATCH blamed on D1. parse.js recognises
  // coords, category, tags, yaw, credits and authors -- all six are emitted
  // here, and `authors` is the *additional* authors only, because merge.js
  // prepends the uploader itself.
  // `source` is no longer served. The nexus-<id> primary key records the same
  // provenance, which is why Stage 7 keeps those keys rather than tidying them.
  const nexusNodes = live.filter((r) => r.id.startsWith('nexus-')).map((r) => {
    const extraTags = r.tags.filter((t) => t !== 'nczoning');
    const extraAuthors = r.authors.slice(1);
    const block = [
      'NCZoning:',
      `coords=${r.coordinates.join(',')}`,
      `category=${r.category}`,
      ...(extraTags.length ? [`tags=${extraTags.join(',')}`] : []),
      ...(r.yaw !== undefined && r.yaw !== null ? [`yaw=${r.yaw}`] : []),
      ...(r.credits ? [`credits=${r.credits}`] : []),
      ...(extraAuthors.length ? [`authors=${extraAuthors.join(',')}`] : []),
    ].join('\n');
    return {
      modId: Number(r.nexus_id),
      name: r.name,
      summary: r.description,
      description: block,
      pictureUrl: r.picture_url,
      thumbnailUrl: r.thumbnail_url,
      updatedAt: r.updated_at,
      uploader: { name: r.authors[0] },
    };
  });

  console.log(`A: buildDataset  (${manualMods.length} manual mods + ${nexusNodes.length} tagged nodes)`);
  console.log(`B: materializeFromD1 (${rows.length} rows, ${dismissed.size} dismissed)  db=${db}${LOCAL ? ' [local]' : ''}\n`);

  // Sweep the clock across the recently_updated boundary. Every mod's
  // updated_at sits somewhere on this line, so stepping the clock forward flips
  // records from recent to not-recent a few at a time -- which is exactly the
  // drift a multi-day soak was hoping to stumble into.
  const base = Date.parse(envelope.generated_at);
  const day = 86400000;
  const offsets = [-90, -30, -RECENTLY_UPDATED_DAYS, -1, 0, 1, RECENTLY_UPDATED_DAYS, 30, 90, 365];

  let failures = 0;
  for (const days of offsets) {
    const nowMs = base + days * day;
    const a = buildDataset({ manualMods, tagsDict, excluded, nexusNodes, districts, manualThumbs, nowMs }).full;
    const b = materializeFromD1({ rows, dismissed, tagsDict, nexusNodes, districts, nexusIndex, locationTags, nowMs }).full;
    const d = diff(a, b);
    const recent = Object.values(a).filter((r) => r.recently_updated).length;
    const label = `clock ${days >= 0 ? '+' : ''}${days}d`.padEnd(12);
    if (d) {
      failures += 1;
      console.log(`  ✗ ${label} MISMATCH at [${d.index}] ${d.id}`);
      console.log(`      mods: ${d.mods?.slice(0, 200)}`);
      console.log(`      d1  : ${d.d1?.slice(0, 200)}`);
    } else {
      console.log(`  ✓ ${label} identical (${Object.keys(a).length} records, ${recent} recently_updated)`);
    }
  }

  // The sweep is only meaningful if recently_updated actually moved across it.
  // A sweep where every clock yields the same value proves nothing about the
  // one time-varying field it exists to exercise.
  const counts = offsets.map((days) => Object.values(
    buildDataset({ manualMods, tagsDict, excluded, nexusNodes, districts, manualThumbs, nowMs: base + days * day }).full,
  ).filter((r) => r.recently_updated).length);
  const varied = new Set(counts).size > 1;
  console.log(`\nrecently_updated across the sweep: ${counts.join(' -> ')}`);
  if (!varied) {
    console.error('❌ the swept field never changed -- this sweep exercised nothing');
    process.exit(1);
  }

  if (failures) {
    console.error(`\n❌ ${failures}/${offsets.length} clocks mismatched`);
    process.exit(1);
  }
  console.log(`\n✅ both paths agree at all ${offsets.length} clocks, and the swept field did vary`);
}

main().catch((err) => {
  console.error(String(err.stack || err));
  process.exit(1);
});
