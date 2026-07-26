/**
 * The Phase 1 gate: materialize /v1/locations from D1 and diff it BYTE-FOR-BYTE
 * against what the live API serves right now.
 *
 *   node worker/scripts/parity-check.mjs                    # production DB vs live API
 *   node worker/scripts/parity-check.mjs --db nczoning-data-staging
 *
 * Exit 0 only if the bytes match AND the harness proved itself capable of
 * failing on the same run. Anything else exits non-zero.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CHECK CAN AND CANNOT CATCH -- read before trusting a green run.
 *
 * The live API is the still-running reference system. 13 of the 18 served
 * fields are rebuilt from D1 and compared; the other 5 are Nexus-derived and
 * are NOT D1's job until Phase 2, so they are fed in from the live record:
 *
 *   REBUILT FROM D1   id, name, nexus_id, coordinates, yaw, category, tags,
 *                     authors, source, description, credits  (D1 columns)
 *                     district, subdistrict                  (recomputed from
 *                                                             D1's OWN x/y/z,
 *                                                             which is what
 *                                                             catches a mangled
 *                                                             coordinate)
 *                     recently_updated                       (recomputed from
 *                                                             updated_at against
 *                                                             the envelope's
 *                                                             generated_at clock)
 *   FED IN FROM LIVE  thumbnail_url, picture_url, updated_at  (Nexus images,
 *                                                             via the same
 *                                                             manualThumbs
 *                                                             channel the cron
 *                                                             uses)
 *                     archives                                (KV-cached Nexus
 *                                                             file listing)
 *
 * A field in NEITHER set fails the run (see assertKeyCoverage). That is what
 * stops a newly added /v1 field from silently slipping past the gate as
 * "not compared".
 *
 * The 5 fed-in fields are therefore unverified BY THIS CHECK, by construction
 * and on purpose -- Phase 2 moves them into `nexus_cache` and they become
 * D1's problem then.
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeFromD1 } from '../src/materialize.js';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Wrangler's JS entrypoint, not `npx`: node >=20 refuses to spawn a .cmd shim
// without a shell (EINVAL), and a shell would re-split the SQL on its spaces.
const WRANGLER = path.join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const API = process.env.NCZ_API_ORIGIN || 'https://api.nczoning.net';
const SITE = process.env.NCZ_SITE_ORIGIN || 'https://nczoning.net';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'b9937d8d595fad7de8d1549b22390281';

const REBUILT_KEYS = new Set([
  'id', 'name', 'nexus_id', 'coordinates', 'yaw', 'category', 'tags', 'authors',
  'source', 'description', 'credits', 'district', 'subdistrict', 'recently_updated',
]);
const FED_IN_KEYS = new Set(['thumbnail_url', 'picture_url', 'updated_at', 'archives']);

const fail = (msg) => { console.error(`\n❌ ${msg}`); process.exit(1); };

// --local runs against the miniflare database in worker/.wrangler/. It proves
// the HARNESS works; it proves nothing about production data, because local and
// remote D1 are entirely separate stores that answer the same command.
const LOCAL = process.argv.includes('--local');

// Wrangler resolves database names from the TOP-LEVEL config only, so a staging
// database is invisible without `--env staging` and the command fails with
// "Couldn't find a D1 DB with the name or binding". Derived from the name so
// `--db nczoning-data-staging` just works.
const envArgs = (db) => (db.endsWith('-staging') ? ['--env', 'staging'] : []);

/** Run one SQL statement against the database and return its rows. */
function query(db, statement) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', db, ...envArgs(db), LOCAL ? '--local' : '--remote', '--json', '--command', statement],
    {
      cwd: WORKER_DIR,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // NOT shell:true -- the shell re-splits the SQL on its spaces and wrangler
      // sees "SELECT" plus a pile of unknown arguments.
    },
  );
  // wrangler prints a banner before the JSON even with --json.
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`no JSON in wrangler output:\n${out.slice(0, 400)}`);
  const parsed = JSON.parse(out.slice(start));
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result?.success) throw new Error(`query failed: ${statement}`);
  return result.results;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Rebuild the manualThumbs channel from the live records. Keyed by nexus_id,
 * which WIP/Dummy entries share -- so assert that colliding keys agree rather
 * than letting the last one win silently.
 */
function thumbsFromLive(records) {
  const thumbs = {};
  for (const r of records) {
    const key = String(r.nexus_id);
    const value = {
      thumbnailUrl: r.thumbnail_url,
      pictureUrl: r.picture_url,
      updatedAt: r.updated_at,
    };
    const prev = thumbs[key];
    if (prev && JSON.stringify(prev) !== JSON.stringify(value)) {
      throw new Error(`nexus_id ${key} appears twice with different images -- cannot key thumbs by it`);
    }
    thumbs[key] = value;
  }
  return thumbs;
}

/** Every served key must be classified, or the gate has a blind spot. */
function assertKeyCoverage(records) {
  const unclassified = new Set();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!REBUILT_KEYS.has(k) && !FED_IN_KEYS.has(k)) unclassified.add(k);
    }
  }
  if (unclassified.size) {
    fail(
      `/v1 serves field(s) this check neither rebuilds nor feeds in: ${[...unclassified].join(', ')}.\n`
      + '   Classify them in REBUILT_KEYS or FED_IN_KEYS before trusting a green run.',
    );
  }
}

/** Attach the fed-in Nexus fields, in the position refresh.js appends them. */
function withArchives(record, liveRecord) {
  return { ...record, archives: liveRecord.archives };
}

function buildFromRows(rows, dismissedIds, tagsDict, districts, liveRecords, nowMs) {
  const { full } = materializeFromD1({
    rows,
    dismissed: dismissedIds,
    tagsDict,
    nexusNodes: [], // nothing auto-publishes; images arrive via manualThumbs
    districts,
    manualThumbs: thumbsFromLive(liveRecords),
    nowMs,
  });
  const byId = new Map(liveRecords.map((r) => [r.id, r]));
  return Object.values(full).map((rec) => withArchives(rec, byId.get(rec.id) ?? {}));
}

async function main() {
  const dbIdx = process.argv.indexOf('--db');
  const db = dbIdx === -1 ? 'nczoning-data' : process.argv[dbIdx + 1];

  console.log(`reference: ${API}/v1/locations`);
  console.log(`candidate: D1 ${db} (${LOCAL ? 'LOCAL miniflare -- proves the harness, not production' : 'remote'})\n`);

  const [envelope, subdistricts, tagsDict] = await Promise.all([
    getJson(`${API}/v1/locations`),
    getJson(`${SITE}/data/subdistricts.json`),
    getJson(`${SITE}/data/tags.json`),
  ]);
  const liveRecords = envelope.data;
  const nowMs = Date.parse(envelope.generated_at);
  if (!Number.isFinite(nowMs)) fail('envelope.generated_at is not a date -- cannot reproduce recently_updated');

  assertKeyCoverage(liveRecords);

  const rows = query(db, 'SELECT * FROM locations ORDER BY id');
  const dismissedRows = query(db, 'SELECT nexus_id FROM dismissed_candidates');

  // A truncated result set is the failure mode that looks like success, so
  // compare the rows returned against a count the database computed itself.
  const [{ n }] = query(db, 'SELECT COUNT(*) AS n FROM locations');
  if (rows.length !== n) {
    fail(`D1 returned ${rows.length} rows but COUNT(*) is ${n} -- the result set was truncated`);
  }
  console.log(`D1: ${rows.length} locations (COUNT(*) agrees), ${dismissedRows.length} dismissed`);
  console.log(`live: ${liveRecords.length} records, generated_at ${envelope.generated_at}\n`);

  const dismissedIds = new Set(dismissedRows.map((r) => String(r.nexus_id)));
  const candidate = buildFromRows(rows, dismissedIds, tagsDict, subdistricts.districts, liveRecords, nowMs);

  // --- ID assertion (the deep-link contract) ----------------------------
  const liveIds = new Set(liveRecords.map((r) => r.id));
  const candIds = new Set(candidate.map((r) => r.id));
  const missing = [...liveIds].filter((id) => !candIds.has(id));
  const extra = [...candIds].filter((id) => !liveIds.has(id));
  if (missing.length || extra.length) {
    console.error('\n❌ ID SET MISMATCH -- every shared ?mod= link depends on these strings.');
    if (missing.length) {
      console.error(`   in live but not D1 (${missing.length}): ${missing.slice(0, 10).join(', ')}`);
      console.error('   if these are newly auto-discovered mods, the import is stale -- re-import, do not wave this through.');
    }
    if (extra.length) console.error(`   in D1 but not live (${extra.length}): ${extra.slice(0, 10).join(', ')}`);
    process.exit(1);
  }

  // --- the byte-for-byte diff -------------------------------------------
  const compare = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!compare(candidate, liveRecords)) {
    console.error('\n❌ BYTE MISMATCH. First differing records:\n');
    let shown = 0;
    for (let i = 0; i < Math.max(candidate.length, liveRecords.length) && shown < 5; i += 1) {
      const c = JSON.stringify(candidate[i]);
      const l = JSON.stringify(liveRecords[i]);
      if (c !== l) {
        console.error(`  [${i}] ${liveRecords[i]?.id ?? candidate[i]?.id}`);
        console.error(`    live: ${l}`);
        console.error(`    D1  : ${c}\n`);
        shown += 1;
      }
    }
    process.exit(1);
  }
  const bytes = JSON.stringify(liveRecords).length;
  console.log(`✅ byte-for-byte identical: ${candidate.length} records, ${bytes} bytes`);

  // --- negative control -------------------------------------------------
  // A green result above is worthless unless this comparison can go red. Prove
  // it on the same run, against the same code path, with the same data.
  console.log('\nnegative control (the check must FAIL on each of these):');
  const controls = [
    ['id changed', (r) => ({ ...r, id: `${r.id}-x` })],
    ['name changed', (r) => ({ ...r, name: `${r.name} ` })],
    ['coordinate nudged', (r) => ({ ...r, x: r.x + 0.0001 })],
    ['z dropped to NULL', (r) => ({ ...r, z: null })],
    ['tag removed', (r) => ({ ...r, tags: JSON.stringify(JSON.parse(r.tags).slice(1)) })],
  ];
  let controlsPassed = 0;
  for (const [label, mutate] of controls) {
    const mutated = rows.map((r, i) => (i === 0 ? mutate(r) : r));
    let differs;
    try {
      const out = buildFromRows(mutated, dismissedIds, tagsDict, subdistricts.districts, liveRecords, nowMs);
      differs = !compare(out, liveRecords);
    } catch {
      differs = true; // a throw is also a detection
    }
    console.log(`  ${differs ? '✓' : '✗'} ${label}${differs ? ' -> detected' : ' -> NOT DETECTED'}`);
    if (differs) controlsPassed += 1;
  }
  if (controlsPassed !== controls.length) {
    fail(`${controls.length - controlsPassed} negative control(s) went undetected -- this gate cannot fail, so its green result means nothing.`);
  }

  console.log(`\n✅ PARITY GATE PASSED (${controls.length}/${controls.length} negative controls detected)`);
}

main().catch((err) => {
  console.error(String(err.stack || err));
  process.exit(1);
});
