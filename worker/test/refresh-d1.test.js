import test from 'node:test';
import assert from 'node:assert/strict';
import { runRefresh } from '../src/refresh.js';
import { KEYS } from '../src/store.js';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';

// Where the dataset comes FROM, and what the cron refuses to serve. The cron
// mechanics (heartbeat, stale/recovery, archive budgeting) are in
// refresh.test.js. D1 is the only source, so the negative cases here carry the
// weight the two-source parity gate used to: a build that cannot be compared
// against a second implementation has to be pinned by what it rejects.

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

const SUBDISTRICTS = {
  districts: [
    {
      id: 'testville', name: 'Testville',
      polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
      subdistricts: [
        { id: 'little', name: 'Little Fixture', polygon: [[0, 0], [500, 0], [500, 500], [0, 500]] },
      ],
    },
    { id: 'badlands', name: 'Badlands', subdistricts: [] },
  ],
};

// `nexus-888` arrived through auto-discovery before the cutover and is a row
// like any other now. Nothing auto-publishes, so a tagged node cannot add one.
const ROWS = [
  {
    id: 'm1', name: 'Manual Loft', nexus_id: '12345', category: 'new-location',
    x: 250, y: 250, z: 10, yaw: null, description: 'x', credits: null,
    authors: '["Spud"]', status: 'published',
    admin_notes: null, owner_id: null,
    added_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'nexus-888', name: 'Auto Bar', nexus_id: '888', category: 'other',
    x: 600, y: 600, z: null, yaw: null, description: 'auto', credits: null,
    authors: '["Up888"]', status: 'published',
    admin_notes: null, owner_id: null,
    added_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z',
  },
];

const NEXUS_PAGE = {
  data: {
    mods: {
      nodes: [
        {
          modId: 888, name: 'Auto Bar', summary: 'auto',
          description: 'NCZoning:\ncoords=600,600\ncategory=other',
          uploader: { name: 'Up888' },
        },
        {
          modId: 777, name: 'Mistagged', summary: 'no',
          description: 'NCZoning:\ncoords=1,1\ncategory=other',
          uploader: { name: 'X' },
        },
      ],
      totalCount: 2,
    },
  },
};

/**
 * Subdistricts are the only source file the cron still fetches. mods.json,
 * tags.json and excluded_mods.json have no branch, so a request for one hits
 * the throw at the bottom and fails the test by name.
 *
 * @param {object} opts
 * @param {boolean} opts.nexusKnowsNothing  Nexus answers both queries with an
 *   empty node list, so nothing lands in nexus_cache.
 */
function fakeFetch({ nexusKnowsNothing = false } = {}) {
  return async (url, init) => {
    if (url.includes('/subdistricts.json')) return { ok: true, json: async () => SUBDISTRICTS };
    if (url.includes('api-router.nexusmods.com')) return { ok: false, status: 503 };
    if (url.includes('file-metadata.nexusmods.com')) return { ok: false, status: 503 };
    if (url.includes('api.nexusmods.com')) {
      if (JSON.parse(init.body).query.includes('modsByUid')) {
        return { ok: true, json: async () => ({
          data: { modsByUid: { nodes: nexusKnowsNothing ? [] : [
            { modId: 12345, pictureUrl: 'pm', thumbnailUrl: 'tm', updatedAt: '2026-07-08' },
          ] } },
        }) };
      }
      if (nexusKnowsNothing) {
        return { ok: true, json: async () => ({ data: { mods: { nodes: [], totalCount: 0 } } }) };
      }
      return { ok: true, json: async () => NEXUS_PAGE };
    }
    if (url.includes('discord')) return { ok: true };
    throw new Error(`unexpected fetch: ${url}`);
  };
}

// Real SQLite on the real migrations, not a substring-matching mock. The cron
// now sweeps `nexus_cache` as well as reading the registry, and a mock that
// answers by matching SQL fragments can only restate the belief it was written
// from -- it cannot show that an upsert, a foreign key or a bound-parameter
// count behaves as D1 does.
//
// `apartment` is a real registry slug, so migration 0002 already seeds it and
// location_tags.tag_slug (a real foreign key here) resolves.
function fakeD1({
  rows = ROWS, dismissed = [{ nexus_id: '777' }], count, fail = false,
} = {}) {
  const db = sqliteD1({
    locations: rows,
    locationTags: rows.some((r) => r.id === 'm1') ? [['m1', 'apartment']] : [],
  });
  for (const d of dismissed) {
    db._db.prepare(
      'INSERT INTO dismissed_candidates (nexus_id, reason, dismissed_by, dismissed_at) VALUES (?, ?, ?, ?)',
    ).run(String(d.nexus_id), null, 'test', '2026-01-01T00:00:00Z');
  }
  return {
    ...db,
    prepare(sql) {
      if (fail) throw new Error('D1 unavailable');
      // The truncation fault: a result set that disagrees with the database's
      // own COUNT(*), which is the failure that otherwise looks like success.
      if (count !== undefined && sql.includes('COUNT(*)')) {
        return { ...db.prepare(sql), async first() { return { n: count }; } };
      }
      return db.prepare(sql);
    },
  };
}

test('the dataset is built from D1, and mods.json is never fetched', async () => {
  const env = { DATASET: fakeKV(), DB: fakeD1(), SITE_ORIGIN: 'https://x' };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.changed, true);
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.deepEqual(Object.keys(full).sort(), ['m1', 'nexus-888']);
});

test('a row change moves the content hash (the build is not a fixed payload)', async () => {
  // What the two-source parity gate used to prove, minus the second source.
  // Without this, every "unchanged content" assertion elsewhere could hold for
  // the wrong reason: a build that always emits the same bytes.
  const base = { DATASET: fakeKV(), DB: fakeD1(), SITE_ORIGIN: 'https://x' };
  await runRefresh(base, fakeFetch());
  const a = await base.DATASET.get(KEYS.full, 'json');
  assert.ok(Object.keys(a).length > 0, 'an empty dataset would compare equal for free');

  const mutated = {
    DATASET: fakeKV(),
    DB: fakeD1({ rows: [{ ...ROWS[0], name: 'Manual Loft ' }, ROWS[1]] }),
    SITE_ORIGIN: 'https://x',
  };
  await runRefresh(mutated, fakeFetch());
  const c = await mutated.DATASET.get(KEYS.full, 'json');
  assert.notEqual(JSON.stringify(c), JSON.stringify(a), 'a changed name must be detected');
});

test('no DB binding fails the refresh rather than serving a locationless map', async () => {
  // There is no static file to degrade to, so the failure must be loud.
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.stale, true);
  assert.equal(r.version, null);
});

test('a D1 failure keeps last-known-good and flags stale, never an empty map', async () => {
  const env = {
    DATASET: fakeKV(), DB: fakeD1(), SITE_ORIGIN: 'https://x',
  };
  await runRefresh(env, fakeFetch());                 // seed a good dataset
  const before = await env.DATASET.get(KEYS.full, 'json');

  env.DB = fakeD1({ fail: true });
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.stale, true);

  const after = await env.DATASET.get(KEYS.full, 'json');
  assert.deepEqual(after, before, 'last-known-good must survive');
  const meta = await env.DATASET.get(KEYS.meta, 'json');
  assert.equal(meta.discovery_stale, true);
});

test('a failed nexus_cache sweep is reported as itself, not as an empty cache', async () => {
  // The sweep rethrows rather than degrading to an empty index. Both spellings
  // end in `stale`, so the assertion that distinguishes them is the REPORTED
  // ERROR: swallowing the sweep failure makes the refresh blame
  // "nexus_cache is empty", which sends the next reader to the wrong table.
  const db = fakeD1();
  const env = {
    DATASET: fakeKV(),
    DB: {
      ...db,
      prepare(sql) {
        if (sql.includes('nexus_cache')) throw new Error('nexus_cache write refused');
        return db.prepare(sql);
      },
    },
    SITE_ORIGIN: 'https://x',
  };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.stale, true);
  assert.match(r.error, /nexus_cache write refused/);
  assert.doesNotMatch(r.error, /nexus_cache is empty/, 'the symptom must not replace the cause');
});

test('a truncated result set fails the refresh rather than shrinking the map', async () => {
  const env = {
    DATASET: fakeKV(),
    DB: fakeD1({ rows: [ROWS[0]], count: 2 }), // returned 1, COUNT(*) says 2
    SITE_ORIGIN: 'https://x',
  };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.stale, true);
  assert.match(r.error, /COUNT\(\*\)/);
});

test('an empty nexus_cache is refused rather than served image-less', async () => {
  // Cold table plus a Nexus that answers nothing: every record would serve with
  // thumbnail_url, picture_url and updated_at all null. That hashes cleanly and
  // would replace a good dataset with a stripped one, so it must fail into
  // last-known-good instead.
  const env = {
    DATASET: fakeKV(), DB: fakeD1(), SITE_ORIGIN: 'https://x',
  };
  const r = await runRefresh(env, fakeFetch({ nexusKnowsNothing: true }));
  assert.equal(r.stale, true);
  assert.match(r.error, /nexus_cache is empty/);
});

test('an empty locations table is refused, not materialized', async () => {
  const env = {
    DATASET: fakeKV(), DB: fakeD1({ rows: [] }), SITE_ORIGIN: 'https://x',
  };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.stale, true);
  assert.match(r.error, /empty/i);
});

test('dismissed candidates keep a mod off the map under D1', async () => {
  const env = {
    DATASET: fakeKV(),
    DB: fakeD1({ dismissed: [] }), // 777 no longer dismissed
    SITE_ORIGIN: 'https://x',
  };
  await runRefresh(env, fakeFetch());
  const full = await env.DATASET.get(KEYS.full, 'json');
  // Still must not appear: nothing auto-publishes any more, dismissal only
  // controls whether it is reported as a candidate.
  assert.equal('nexus-777' in full, false);
});
