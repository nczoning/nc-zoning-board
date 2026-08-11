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
 * The live API is the still-running reference system. EVERY served field is now
 * rebuilt from D1 and compared; nothing is fed in from the live record:
 *
 *   FROM `locations`     id, name, nexus_id, coordinates, yaw, category, tags,
 *                        authors, description, credits
 *   FROM `nexus_cache`   thumbnail_url, picture_url, updated_at, archives
 *   RECOMPUTED           district, subdistrict   (from D1's OWN x/y/z, which is
 *                                                 what catches a mangled
 *                                                 coordinate)
 *
 * A field in NEITHER set fails the run (see assertKeyCoverage). That is what
 * stops a newly added /v1 field from silently slipping past the gate as
 * "not compared".
 *
 * Feeding a field in from the live record makes the gate agree with itself for
 * that field: an image the cron resolves wrongly still matches, because both
 * sides came from the same place. So a field belongs in FED_IN_KEYS only while
 * D1 genuinely cannot answer for it, and the set is empty.
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeFromD1, attachArchives } from '../src/materialize.js';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Wrangler's JS entrypoint, not `npx`: node >=20 refuses to spawn a .cmd shim
// without a shell (EINVAL), and a shell would re-split the SQL on its spaces.
const WRANGLER = path.join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const API = process.env.NCZ_API_ORIGIN || 'https://api.nczoning.net';
const SITE = process.env.NCZ_SITE_ORIGIN || 'https://nczoning.net';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'b9937d8d595fad7de8d1549b22390281';

const REBUILT_KEYS = new Set([
  'id', 'name', 'nexus_id', 'coordinates', 'yaw', 'category', 'tags', 'authors',
  'description', 'credits', 'district', 'subdistrict',
  'thumbnail_url', 'picture_url', 'updated_at', 'archives',
]);
// Empty on purpose, and kept rather than deleted: it is the list of fields this
// gate does not actually check, and it should stay visible and stay at zero.
const FED_IN_KEYS = new Set();

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
 * readNexusIndex()'s output, built from a `nexus_cache` dump rather than a live
 * binding. Deliberately a separate implementation of the same shape: importing
 * the Worker's version would need a D1 binding, and this script talks to
 * wrangler.
 */
function indexFromRows(rows) {
  const index = new Map();
  for (const r of rows) {
    let archives = [];
    if (typeof r.archives === 'string') {
      try {
        const parsed = JSON.parse(r.archives);
        if (Array.isArray(parsed)) archives = parsed;
      } catch { /* a malformed cell reads as no listing, exactly as the Worker does */ }
    }
    index.set(String(r.nexus_id), {
      thumbnailUrl: r.thumbnail_url ?? null,
      pictureUrl: r.picture_url ?? null,
      updatedAt: r.updated_at ?? null,
      archives,
    });
  }
  return index;
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

function buildFromRows(rows, dismissedIds, tagsDict, districts, nexusIndex, locationTags) {
  const { full } = materializeFromD1({
    rows,
    dismissed: dismissedIds,
    tagsDict,
    nexusNodes: [], // nothing auto-publishes; images arrive via nexusIndex
    districts,
    nexusIndex,
    // The join. Without it materializeFromD1 falls back to the legacy
    // locations.tags column, so the gate would pass while testing the path
    // production no longer takes.
    locationTags,
  });
  // Appended last, in the position the cron appends it, because the comparison
  // below is on bytes and JSON.stringify emits insertion order.
  return Object.values(attachArchives(full, nexusIndex));
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

  assertKeyCoverage(liveRecords);

  const rows = query(db, 'SELECT * FROM locations ORDER BY id');
  const dismissedRows = query(db, 'SELECT nexus_id FROM dismissed_candidates');
  const nexusRows = query(
    db,
    'SELECT nexus_id, updated_at, thumbnail_url, picture_url, archives FROM nexus_cache',
  );

  // A truncated result set is the failure mode that looks like success, so
  // compare the rows returned against a count the database computed itself.
  const [{ n }] = query(db, 'SELECT COUNT(*) AS n FROM locations');
  if (rows.length !== n) {
    fail(`D1 returned ${rows.length} rows but COUNT(*) is ${n} -- the result set was truncated`);
  }
  console.log(`D1: ${rows.length} locations (COUNT(*) agrees), ${dismissedRows.length} dismissed`);
  console.log(`live: ${liveRecords.length} records, generated_at ${envelope.generated_at}`);

  // An unswept nexus_cache would rebuild every image as null and every listing
  // as [], which is a difference in ~300 records reported as ~300 mismatches.
  // Say what it is instead: this database has not been swept yet.
  const withArchivesCount = nexusRows.filter((r) => r.archives != null).length;
  console.log(`nexus_cache: ${nexusRows.length} mods, ${withArchivesCount} with a file listing\n`);
  if (nexusRows.length === 0) {
    fail('nexus_cache is empty -- deploy the sweep and let one cron tick run before comparing.');
  }

  const dismissedIds = new Set(dismissedRows.map((r) => String(r.nexus_id)));

  const locationTags = new Map();
  for (const r of query(db, 'SELECT location_id, tag_slug FROM location_tags ORDER BY location_id, tag_slug')) {
    if (!locationTags.has(r.location_id)) locationTags.set(r.location_id, []);
    locationTags.get(r.location_id).push(r.tag_slug);
  }

  const nexusIndex = indexFromRows(nexusRows);
  const candidate = buildFromRows(rows, dismissedIds, tagsDict, subdistricts.districts, nexusIndex, locationTags);

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
  // Two families: the location columns, and the Nexus-derived fields. The
  // second family only detects anything while those fields are rebuilt rather
  // than fed in, so these four controls are what keeps FED_IN_KEYS empty.
  const controls = [
    ['id changed', (r) => ({ ...r, id: `${r.id}-x` }), null],
    ['name changed', (r) => ({ ...r, name: `${r.name} ` }), null],
    ['coordinate nudged', (r) => ({ ...r, x: r.x + 0.0001 }), null],
    ['z dropped to NULL', (r) => ({ ...r, z: null }), null],
    // Mutates the JOIN, not `locations.tags`. Migration 0002 made location_tags
    // authoritative and resolveTags ignores the JSON column whenever the join is
    // supplied, which it always is here -- so the original column mutation landed
    // on a field nothing reads and the control could not fail. Do not move it back.
    ['tag removed', null, null, (m) => {
      const key = rows[0].id;
      const slugs = m.get(key);
      if (!slugs || !slugs.length) fail(`negative control cannot run: no location_tags rows for ${key}`);
      return new Map(m).set(key, slugs.slice(1));
    }],
    ['thumbnail_url changed', null, (e) => ({ ...e, thumbnailUrl: `${e.thumbnailUrl}?x` })],
    ['picture_url dropped', null, (e) => ({ ...e, pictureUrl: null })],
    ['updated_at moved', null, (e) => ({ ...e, updatedAt: '2020-01-01T00:00:00.000Z' })],
    ['archive name changed', null, (e) => ({ ...e, archives: [...e.archives, 'ghost.archive'] })],
  ];
  let controlsPassed = 0;
  for (const [label, mutateRow, mutateIndex, mutateTags] of controls) {
    const mutatedRows = mutateRow ? rows.map((r, i) => (i === 0 ? mutateRow(r) : r)) : rows;
    let mutatedIndex = nexusIndex;
    if (mutateIndex) {
      // The first record's mod, so a one-record mutation stays a one-record
      // difference even though the index is keyed by mod rather than location.
      const key = String(rows[0].nexus_id);
      mutatedIndex = new Map(nexusIndex);
      const entry = mutatedIndex.get(key);
      if (!entry) fail(`negative control cannot run: no nexus_cache row for ${key}`);
      mutatedIndex.set(key, mutateIndex(entry));
    }
    const mutatedTags = mutateTags ? mutateTags(locationTags) : locationTags;
    let differs;
    try {
      const out = buildFromRows(mutatedRows, dismissedIds, tagsDict, subdistricts.districts, mutatedIndex, mutatedTags);
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
