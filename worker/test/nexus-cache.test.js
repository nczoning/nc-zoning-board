import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';
import { refreshNexusCache, readNexusCache, readCandidates, diffRows } from '../src/nexus-cache.js';

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
  x: 0, y: 0, z: 0, authors: '["a"]', description: '', source: 'manual',
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
