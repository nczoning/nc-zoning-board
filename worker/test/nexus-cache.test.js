import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';
import {
  refreshNexusCache, refreshArchives, readNexusCache, readNexusIndex,
  readCandidates, diffRows,
} from '../src/nexus-cache.js';

// Real SQLite running the real migrations, so 0003 is exercised here rather
// than asserted about. The harness also enforces D1's 100 bound parameter
// ceiling inside batch(), which is what makes the large-sweep test below a real
// check and not a restatement of the belief it was written from.
// See learnings/d1-refuses-more-than-100-bound-parameters.

const NOW = '2026-07-27T00:00:00.000Z';

/** A fetch that answers the tagged query, then modsByUid, from fixtures. */
function fakeNexus({ tagged = [], byUid = {}, taggedFails = false, byUidFails = false } = {}) {
  let calls = 0;
  const impl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const isTagged = body.query.includes('NCZoningMods');
    if (isTagged) {
      if (taggedFails) return { ok: false, status: 503, async json() { return {}; } };
      return {
        ok: true,
        async json() {
          return { data: { mods: { nodes: tagged, totalCount: tagged.length } } };
        },
      };
    }
    if (byUidFails) return { ok: false, status: 503, async json() { return {}; } };
    const wanted = body.variables.uids.length;
    const nodes = Object.entries(byUid).map(([modId, v]) => ({ modId, ...v })).slice(0, wanted);
    return { ok: true, async json() { return { data: { modsByUid: { nodes } } }; } };
  };
  impl.calls = () => calls;
  return impl;
}

const node = (modId, over = {}) => ({
  modId,
  name: `Mod ${modId}`,
  description: '',
  pictureUrl: `https://img/${modId}-p.jpg`,
  thumbnailUrl: `https://img/${modId}-t.jpg`,
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

const location = (id, nexusId) => ({
  id, name: `Loc ${id}`, nexus_id: nexusId, category: 'new-location',
  x: 0, y: 0, z: 0, authors: '["a"]', description: '',
  status: 'published', created_at: NOW, updated_at: NOW,
});

// --------------------------------------------------------------- write gate ---
// The whole design rests on this: ~300 mods on 288 daily ticks is 86,400
// row-writes against a 100k/day free-tier cap, so a sweep that finds nothing
// changed must cost zero writes.

test('a second identical sweep writes nothing', async () => {
  const env = { DB: sqliteD1({ locations: [location('l1', '100')] }) };
  const fetchImpl = fakeNexus({ tagged: [node('100'), node('200')] });

  const first = await refreshNexusCache(env, { fetchImpl, nowIso: NOW });
  assert.equal(first.written, 2, 'first sweep should write both rows');

  const second = await refreshNexusCache(env, { fetchImpl, nowIso: '2026-07-27T00:05:00.000Z' });
  assert.equal(second.written, 0, 'an unchanged sweep must not write, or the cron burns the D1 budget');
});

test('a changed field is written, an unchanged one is not', async () => {
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100'), node('200')] }), nowIso: NOW });

  const renamed = fakeNexus({ tagged: [node('100', { name: 'Renamed' }), node('200')] });
  const r = await refreshNexusCache(env, { fetchImpl: renamed, nowIso: NOW });
  assert.equal(r.written, 1, 'only the renamed mod should be written');

  const cache = await readNexusCache(env);
  assert.equal(cache.get('100').name, 'Renamed');
  assert.equal(cache.get('200').name, 'Mod 200');
});

test('diffRows treats undefined as "not resolved" and null as "cleared"', () => {
  const existing = new Map([['1', { nexus_id: '1', name: 'A', thumbnail_url: 'x', nczoning_tagged: 1 }]]);
  assert.equal(diffRows([{ nexus_id: '1', name: undefined }], existing).length, 0,
    'an unresolved field must not count as a change, or every sweep writes everything');
  assert.equal(diffRows([{ nexus_id: '1', thumbnail_url: null }], existing).length, 1,
    'an image removed on Nexus must clear here');
  assert.equal(diffRows([{ nexus_id: '2', name: 'New' }], existing).length, 1,
    'an unseen mod is always a write');
});

// ------------------------------------------------------------------ tagging ---

test('a mod that loses the NCZoning tag stops being a candidate', async () => {
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100'), node('200')] }), nowIso: NOW });
  assert.deepEqual((await readCandidates(env)).map((c) => c.nexus_id), ['100', '200']);

  const r = await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100')] }), nowIso: NOW });
  assert.equal(r.untagged, 1);
  assert.deepEqual((await readCandidates(env)).map((c) => c.nexus_id), ['100'],
    'an untagged mod left in candidates would sit there forever');

  // The row survives, so a location built from it keeps its images.
  assert.ok((await readNexusCache(env)).has('200'));
});

test('candidates exclude locations and dismissed mods', async () => {
  const env = { DB: sqliteD1({ locations: [location('l1', '100')] }) };
  env.DB._db.prepare(
    'INSERT INTO dismissed_candidates (nexus_id, reason, dismissed_by, dismissed_at) VALUES (?, ?, ?, ?)',
  ).run('200', 'not a location', 'tester', NOW);

  await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ tagged: [node('100'), node('200'), node('300')] }), nowIso: NOW,
  });

  assert.deepEqual((await readCandidates(env)).map((c) => c.nexus_id), ['300'],
    '100 is already a location, 200 was dismissed');
});

test('one mod supplying two locations is still one cache row and not a candidate', async () => {
  // Measured on the live data: mod 23896 supplies both Watson Tattoo Shops
  // pins. The join is one-to-many, so a NOT IN anti-join must still exclude it
  // rather than counting it twice or letting it back into candidates.
  const env = { DB: sqliteD1({ locations: [location('l1', '100'), location('l2', '100')] }) };
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100'), node('300')] }), nowIso: NOW });

  assert.equal((await readNexusCache(env)).size, 2, 'two locations share one cache row');
  assert.deepEqual((await readCandidates(env)).map((c) => c.nexus_id), ['300'],
    'a mod with two locations is still already on the map');
});

// ------------------------------------------------------------------ prefill ---
// The submit form prefills its description and author from these, the way
// merge.js builds those two fields of an auto-discovered record. The columns
// exist so that prefill survives auto-discovery being replaced by the queue.

test('a candidate carries the mod summary, so the form can prefill a description', async () => {
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ tagged: [node('100', { summary: 'A rooftop bar above Kabuki.' })] }),
    nowIso: NOW,
  });

  const [candidate] = await readCandidates(env);
  assert.equal(candidate.summary, 'A rooftop bar above Kabuki.');
});

test('a candidate carries the uploader, which is the first author on the record', async () => {
  // merge.js:73 builds authors as [uploader.name, ...names from the block], so
  // the uploader is the one author the mod page itself supplies.
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ tagged: [node('100', { uploader: { name: 'Spuddeh' } })] }),
    nowIso: NOW,
  });

  const [candidate] = await readCandidates(env);
  assert.equal(candidate.uploader, 'Spuddeh');
});

test('a changed uploader is written on a later sweep', async () => {
  // Mod ownership does move on Nexus. Without this the first write would be the
  // only one, and the form would prefill the previous owner forever.
  const env = { DB: sqliteD1() };
  const before = fakeNexus({ tagged: [node('100', { uploader: { name: 'Before' } })] });
  await refreshNexusCache(env, { fetchImpl: before, nowIso: NOW });

  const unchanged = await refreshNexusCache(env, { fetchImpl: before, nowIso: NOW });
  assert.equal(unchanged.written, 0, 'an unchanged uploader must not cost a write on every tick');

  const after = fakeNexus({ tagged: [node('100', { uploader: { name: 'After' } })] });
  const r = await refreshNexusCache(env, { fetchImpl: after, nowIso: NOW });
  assert.equal(r.written, 1);
  assert.equal((await readCandidates(env))[0].uploader, 'After');
});

test('a node with no uploader yields null rather than a broken read', async () => {
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100', { uploader: null })] }), nowIso: NOW });

  const [candidate] = await readCandidates(env);
  assert.ok('uploader' in candidate);
  assert.equal(candidate.uploader, null);
});

test('a mod with no summary is a candidate with a null one, not a missing key', async () => {
  // The form reads the field on every candidate. An absent key and an empty
  // summary must not be two different shapes to it.
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100', { summary: null })] }), nowIso: NOW });

  const [candidate] = await readCandidates(env);
  assert.ok('summary' in candidate);
  assert.equal(candidate.summary, null);
});

test('an edited summary is written, and the write gate still holds when it is not', async () => {
  const env = { DB: sqliteD1() };
  const first = fakeNexus({ tagged: [node('100', { summary: 'Before' })] });
  await refreshNexusCache(env, { fetchImpl: first, nowIso: NOW });

  const unchanged = await refreshNexusCache(env, { fetchImpl: first, nowIso: NOW });
  assert.equal(unchanged.written, 0, 'an unchanged summary must not cost a write on every tick');

  const edited = fakeNexus({ tagged: [node('100', { summary: 'After' })] });
  const r = await refreshNexusCache(env, { fetchImpl: edited, nowIso: NOW });
  assert.equal(r.written, 1);
  assert.equal((await readCandidates(env))[0].summary, 'After');
});

test('an archives-only write leaves the summary alone', async () => {
  // refreshArchives builds rows with no summary key at all. Without the
  // COALESCE on the upsert, an archive refresh would blank it.
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ tagged: [node('100', { summary: 'Kept' })] }),
    nowIso: NOW,
  });

  const index = await readNexusIndex(env);
  await refreshArchives(env, fakeArchiveFetch(), {
    records: [record('100')], index, nowIso: NOW,
  });

  assert.equal((await readCandidates(env))[0].summary, 'Kept');
});

// ------------------------------------------------------------------- limits ---

test('a sweep of 300 mods stays inside D1 bound parameter limits', async () => {
  // The harness throws D1_ERROR above 100 binds per statement, exactly as D1
  // does. A single multi-row INSERT would fail here, which is the point.
  const env = { DB: sqliteD1() };
  const many = Array.from({ length: 300 }, (_, i) => node(String(1000 + i)));
  const r = await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: many }), nowIso: NOW });
  assert.equal(r.written, 300);
  assert.equal((await readNexusCache(env)).size, 300);
});

// ----------------------------------------------------------------- failures ---

test('a tagged-query failure leaves the cache untouched and reports stale', async () => {
  const env = { DB: sqliteD1() };
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100')] }), nowIso: NOW });

  const r = await refreshNexusCache(env, { fetchImpl: fakeNexus({ taggedFails: true }), nowIso: NOW });
  assert.equal(r.stale, true);
  assert.equal(r.written, 0);
  assert.equal((await readNexusCache(env)).get('100').name, 'Mod 100',
    'last known good must survive a Nexus outage');
});

test('a backfill that returns nothing is reported, not read as a clean sweep', async () => {
  // fetchModsByUidThumbs never throws: it swallows and returns {}. So a total
  // failure is byte-identical to "found nothing", and only the count against
  // what was requested can tell them apart.
  const env = { DB: sqliteD1({ locations: [location('l1', '900')] }) };
  const r = await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ tagged: [node('100')], byUidFails: true }), nowIso: NOW,
  });
  assert.equal(r.backfill_requested, 1);
  assert.equal(r.backfilled, 0);
  assert.equal(r.stale, true, 'a silent empty backfill must not report success');
});

// ------------------------------------------------------------- archives ---
// The file listing behind installed-mod detection. Its own pass, because the
// mods that need one are the records the dataset serves, which is not the
// `locations` table while production still builds from mods.json.

/** A fetch answering the two archive endpoints for any mod. */
function fakeArchiveFetch({ fail = false, files = 1, calls = [] } = {}) {
  const impl = async (url, init) => {
    if (String(url).includes('api-router.nexusmods.com')) {
      calls.push(`router:${JSON.parse(init.body).variables.modId}`);
      if (fail) return { ok: false, status: 503 };
      return {
        ok: true,
        async json() {
          return { data: { modFiles: Array.from({ length: files }, (_, i) => ({ uri: `f${i}.7z`, category: 'MAIN' })) } };
        },
      };
    }
    if (String(url).includes('file-metadata.nexusmods.com')) {
      // Deliberately not restricted to numeric ids: if this only answered for
      // real mods, a test that a placeholder id is refused would pass because
      // the stub declined it rather than because the code did.
      const modId = String(url).match(/\/3333\/([^/]+)\//)[1];
      calls.push(`file:${modId}`);
      return {
        ok: true,
        async json() {
          return { children: [{ name: 'archive', type: 'directory', children: [
            { name: 'pc', type: 'directory', children: [
              { name: 'mod', type: 'directory', children: [
                { name: `mod_${modId}.archive`, type: 'file', path: `archive/pc/mod/mod_${modId}.archive` },
              ] },
            ] },
          ] }] };
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

const record = (nexusId, updatedAt = '2026-07-01T00:00:00.000Z') => ({
  nexus_id: nexusId, updated_at: updatedAt,
});

test('a listing is fetched once and then reused until the mod re-uploads', async () => {
  const env = { DB: sqliteD1(), DATASET: null };
  const index = await readNexusIndex(env);
  const calls = [];

  const first = await refreshArchives(env, fakeArchiveFetch({ calls }), {
    records: [record('100')], index, nowIso: NOW,
  });
  assert.equal(first.fetched, 1);
  assert.equal(first.written, 1);
  assert.deepEqual(index.get('100').archives, ['mod_100.archive']);

  // Same updated_at: nothing due, so no subrequest and no row write. This is
  // the whole reason archives are affordable on a 5-minute cron.
  const stored = await readNexusIndex(env);
  const second = await refreshArchives(env, fakeArchiveFetch({ calls: [] }), {
    records: [record('100')], index: stored, nowIso: NOW,
  });
  assert.equal(second.fetched, 0);
  assert.equal(second.written, 0);
  assert.deepEqual(stored.get('100').archives, ['mod_100.archive']);

  // A re-upload moves updated_at, which is the refetch signal.
  const third = await refreshArchives(env, fakeArchiveFetch({ calls: [] }), {
    records: [record('100', '2026-07-20T00:00:00.000Z')], index: stored, nowIso: NOW,
  });
  assert.equal(third.fetched, 1, 'a re-upload must refetch, or the listing goes stale forever');
  assert.equal(
    env.DB.one('SELECT archives_at FROM nexus_cache WHERE nexus_id = ?', '100').archives_at,
    '2026-07-20T00:00:00.000Z',
  );
});

test('a mod that ships no .archive is not refetched every tick', async () => {
  // `archives: []` is a real answer, so the array alone cannot say whether the
  // listing has ever been read. Without archives_known this mod would be due on
  // every single tick, at two subrequests a time, forever.
  const env = { DB: sqliteD1(), DATASET: null };
  const empty = fakeArchiveFetch({ files: 0 });
  const index = await readNexusIndex(env);
  await refreshArchives(env, empty, { records: [record('100')], index, nowIso: NOW });
  assert.deepEqual(index.get('100').archives, []);

  const calls = [];
  const again = await refreshArchives(env, fakeArchiveFetch({ calls }), {
    records: [record('100')], index: await readNexusIndex(env), nowIso: NOW,
  });
  assert.equal(again.fetched, 0);
  assert.equal(calls.length, 0);
});

test('a transient failure stores nothing, so the next tick retries', async () => {
  const env = { DB: sqliteD1(), DATASET: null };
  const index = await readNexusIndex(env);
  const failed = await refreshArchives(env, fakeArchiveFetch({ fail: true }), {
    records: [record('100')], index, nowIso: NOW,
  });
  assert.equal(failed.fetched, 0);
  assert.equal(failed.written, 0, 'caching a failed read would make it permanent');
  assert.equal(failed.pending, 1);

  const ok = await refreshArchives(env, fakeArchiveFetch(), {
    records: [record('100')], index: await readNexusIndex(env), nowIso: NOW,
  });
  assert.equal(ok.fetched, 1);
});

test('the KV blob is carried over instead of refetched, and only while it is current', async () => {
  // scripts/archive-seeds.json holds hand-built listings for mods whose Nexus
  // file preview is broken. A refetch replaces those with nothing, so the
  // carry-over is not just a cold-start optimisation.
  const env = {
    DB: sqliteD1(),
    DATASET: {
      async get() {
        return {
          100: { updatedAt: '2026-07-01T00:00:00.000Z', archives: ['hand_built.archive'] },
          200: { updatedAt: '2020-01-01T00:00:00.000Z', archives: ['ancient.archive'] },
        };
      },
    },
  };
  const calls = [];
  const r = await refreshArchives(env, fakeArchiveFetch({ calls }), {
    records: [record('100'), record('200')], index: await readNexusIndex(env), nowIso: NOW,
  });

  assert.equal(r.seeded, 1);
  assert.equal(calls.some((c) => c.startsWith('router:100')), false,
    'a current seed must not be refetched, or the hand-built listing is lost');
  assert.equal(r.fetched, 1, 'the stale seed is refetched rather than trusted');
  assert.deepEqual(
    JSON.parse(env.DB.one('SELECT archives FROM nexus_cache WHERE nexus_id = ?', '100').archives),
    ['hand_built.archive'],
  );
  assert.deepEqual(
    JSON.parse(env.DB.one('SELECT archives FROM nexus_cache WHERE nexus_id = ?', '200').archives),
    ['mod_200.archive'],
  );
});

test('archive work is budgeted per tick and cold-fills across ticks', async () => {
  const env = { DB: sqliteD1(), DATASET: null };
  const records = Array.from({ length: 40 }, (_, i) => record(String(1000 + i)));

  const first = await refreshArchives(env, fakeArchiveFetch(), {
    records, index: await readNexusIndex(env), nowIso: NOW,
  });
  assert.ok(first.fetched < 40, `fetched ${first.fetched}: the budget must cap a cold fill`);
  assert.equal(first.pending, 40 - first.fetched);

  let done = first.fetched;
  for (let tick = 0; tick < 6 && done < 40; tick += 1) {
    // eslint-disable-next-line no-await-in-loop
    done += (await refreshArchives(env, fakeArchiveFetch(), {
      records, index: await readNexusIndex(env), nowIso: NOW,
    })).fetched;
  }
  assert.equal(done, 40, 'the fill must complete, one budget at a time');

  const settled = await refreshArchives(env, fakeArchiveFetch(), {
    records, index: await readNexusIndex(env), nowIso: NOW,
  });
  assert.equal(settled.fetched, 0);
  assert.equal(settled.written, 0, 'steady state costs no D1 write at all');
});

test('an archives-only write leaves the NCZoning tag flag alone', async () => {
  // writeRows sets nczoning_tagged unconditionally, so an archive write that
  // did not carry the flag would silently drop the mod out of candidates.
  const env = { DB: sqliteD1(), DATASET: null };
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [node('100')] }), nowIso: NOW });
  assert.deepEqual((await readCandidates(env)).map((c) => c.nexus_id), ['100']);

  await refreshArchives(env, fakeArchiveFetch(), {
    records: [record('100')], index: await readNexusIndex(env), nowIso: NOW,
  });
  assert.deepEqual((await readCandidates(env)).map((c) => c.nexus_id), ['100'],
    'the mod is still tagged, and still not a location');
});

test('placeholder nexus ids are never written as rows', async () => {
  // Nexus is stubbed to answer for these ids, so the only thing that can keep
  // them out of the table is the code refusing to ask.
  const env = { DB: sqliteD1({ locations: [location('l1', 'WIP'), location('l2', 'Dummy')] }) };
  const calls = [];
  await refreshNexusCache(env, { fetchImpl: fakeNexus({ tagged: [] }), nowIso: NOW });
  await refreshArchives(env, fakeArchiveFetch({ calls }), {
    records: [record('WIP'), record('Dummy')], index: await readNexusIndex(env), nowIso: NOW,
  });
  assert.deepEqual(calls, [], 'a placeholder is not a mod id and must not be looked up');
  assert.equal((await readNexusCache(env)).size, 0,
    'WIP and Dummy are placeholders, not mods; a row for one could be joined to');
});

test('readNexusIndex survives a malformed archives cell', async () => {
  const env = { DB: sqliteD1() };
  env.DB._db.prepare(
    'INSERT INTO nexus_cache (nexus_id, archives, fetched_at) VALUES (?, ?, ?)',
  ).run('100', 'not json', NOW);
  const index = await readNexusIndex(env);
  assert.deepEqual(index.get('100').archives, [],
    'one unreadable cell must not take the whole refresh into last-known-good');
});

test('a location that is not tagged still gets its images backfilled', async () => {
  const env = { DB: sqliteD1({ locations: [location('l1', '900')] }) };
  const r = await refreshNexusCache(env, {
    fetchImpl: fakeNexus({
      tagged: [node('100')],
      byUid: { 900: { name: 'Manual Mod', pictureUrl: 'p', thumbnailUrl: 't', updatedAt: NOW } },
    }),
    nowIso: NOW,
  });
  assert.equal(r.backfilled, 1);
  assert.equal(r.stale, false);

  const row = (await readNexusCache(env)).get('900');
  assert.equal(row.name, 'Manual Mod');
  assert.equal(row.nczoning_tagged, 0, 'backfilled locations are not candidates');
});
