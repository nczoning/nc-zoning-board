import test from 'node:test';
import assert from 'node:assert/strict';
import { runRefresh } from '../src/refresh.js';
import { KEYS } from '../src/store.js';

// Phase 2: the cron sourcing from D1 instead of mods.json. The load-bearing
// test here is `both sources produce an identical dataset` -- the unit-scale
// version of what parity-check.mjs does against production.

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

const TAGS = { apartment: 'a place', corpo: 'suits' };
const EXCLUDED = { 777: 'mistagged' };
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

const MODS = [
  {
    id: 'm1', name: 'Manual Loft', authors: ['Spud'], coordinates: [250, 250, 10],
    nexus_id: '12345', description: 'x', category: 'new-location', tags: ['apartment'],
  },
];

// The D1 equivalent of MODS *plus* the auto entry the mods.json path derives
// from Nexus node 888 -- because under D1 nothing auto-publishes and that
// record is a row like any other.
const ROWS = [
  {
    id: 'm1', name: 'Manual Loft', nexus_id: '12345', category: 'new-location',
    x: 250, y: 250, z: 10, yaw: null, description: 'x', credits: null,
    authors: '["Spud"]', tags: '["apartment"]', source: 'manual', status: 'published',
    admin_notes: null, owner_id: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'nexus-888', name: 'Auto Bar', nexus_id: '888', category: 'other',
    x: 600, y: 600, z: null, yaw: null, description: 'auto', credits: null,
    authors: '["Up888"]', tags: '["nczoning"]', source: 'auto', status: 'published',
    admin_notes: null, owner_id: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
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
 * @param {object} opts
 * @param {boolean} opts.banModsJson  throw if /mods.json is fetched -- proves
 *   the D1 path does not quietly keep reading the file it replaced.
 */
function fakeFetch({ banModsJson = false } = {}) {
  return async (url, init) => {
    if (url.includes('/mods.json')) {
      if (banModsJson) throw new Error('D1 mode must not fetch mods.json');
      return { ok: true, json: async () => MODS };
    }
    if (url.includes('/tags.json')) return { ok: true, json: async () => TAGS };
    if (url.includes('/excluded_mods.json')) return { ok: true, json: async () => EXCLUDED };
    if (url.includes('/subdistricts.json')) return { ok: true, json: async () => SUBDISTRICTS };
    if (url.includes('api-router.nexusmods.com')) return { ok: false, status: 503 };
    if (url.includes('file-metadata.nexusmods.com')) return { ok: false, status: 503 };
    if (url.includes('api.nexusmods.com')) {
      if (JSON.parse(init.body).query.includes('modsByUid')) {
        return { ok: true, json: async () => ({
          data: { modsByUid: { nodes: [
            { modId: 12345, pictureUrl: 'pm', thumbnailUrl: 'tm', updatedAt: '2026-07-08' },
          ] } },
        }) };
      }
      return { ok: true, json: async () => NEXUS_PAGE };
    }
    if (url.includes('discord')) return { ok: true };
    throw new Error(`unexpected fetch: ${url}`);
  };
}

// The tag registry and the join, mirroring migration 0002. `nczoning` is
// absent from both, exactly as in the real schema — the materializer re-adds it
// for auto-sourced records.
const TAG_ROWS = [
  { slug: 'apartment', name: null, description: 'a place', sort_order: 1 },
  { slug: 'corpo', name: null, description: 'suits', sort_order: 2 },
];
const LOCATION_TAG_ROWS = [{ location_id: 'm1', tag_slug: 'apartment' }];

function fakeD1({
  rows = ROWS, dismissed = [{ nexus_id: '777' }], count, fail = false,
  tagRows = TAG_ROWS, locationTagRows = LOCATION_TAG_ROWS,
} = {}) {
  return {
    prepare(sql) {
      return {
        async all() {
          if (fail) throw new Error('D1 unavailable');
          if (sql.includes('dismissed_candidates')) return { results: dismissed };
          // Checked before `FROM locations`: "FROM location_tags" contains it.
          if (sql.includes('FROM location_tags')) return { results: locationTagRows };
          if (sql.includes('FROM tags')) return { results: tagRows };
          return { results: rows };
        },
        async first() {
          if (fail) throw new Error('D1 unavailable');
          return { n: count ?? rows.length };
        },
      };
    },
  };
}

test('DATA_SOURCE=d1 builds the dataset from D1, not mods.json', async () => {
  const env = {
    DATASET: fakeKV(), DB: fakeD1(), SITE_ORIGIN: 'https://x', DATA_SOURCE: 'd1',
  };
  const r = await runRefresh(env, fakeFetch({ banModsJson: true }));
  assert.equal(r.changed, true);
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.deepEqual(Object.keys(full).sort(), ['m1', 'nexus-888']);
});

test('both sources produce an IDENTICAL dataset (the parity gate, in miniature)', async () => {
  const fromMods = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  const fromD1 = {
    DATASET: fakeKV(), DB: fakeD1(), SITE_ORIGIN: 'https://x', DATA_SOURCE: 'd1',
  };
  await runRefresh(fromMods, fakeFetch());
  await runRefresh(fromD1, fakeFetch());

  const a = await fromMods.DATASET.get(KEYS.full, 'json');
  const b = await fromD1.DATASET.get(KEYS.full, 'json');
  // Byte comparison, exactly as the real gate does -- key order included.
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  assert.ok(Object.keys(a).length > 0, 'two empty datasets would compare equal for free');

  // Negative control: the comparison above is worth nothing unless it can go
  // red. Same reasoning as parity-check.mjs, at unit scale.
  const mutated = {
    DATASET: fakeKV(),
    DB: fakeD1({ rows: [{ ...ROWS[0], name: 'Manual Loft ' }, ROWS[1]] }),
    SITE_ORIGIN: 'https://x',
    DATA_SOURCE: 'd1',
  };
  await runRefresh(mutated, fakeFetch());
  const c = await mutated.DATASET.get(KEYS.full, 'json');
  assert.notEqual(JSON.stringify(c), JSON.stringify(a), 'a changed name must be detected');
});

test('an unset DATA_SOURCE stays on mods.json (absent config is never permissive)', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  // No DB binding at all: if the default silently switched to D1 this throws.
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.changed, true);
  assert.equal(r.stale, false);
});

test('a D1 failure keeps last-known-good and flags stale, never an empty map', async () => {
  const env = {
    DATASET: fakeKV(), DB: fakeD1(), SITE_ORIGIN: 'https://x', DATA_SOURCE: 'd1',
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

test('a truncated result set fails the refresh rather than shrinking the map', async () => {
  const env = {
    DATASET: fakeKV(),
    DB: fakeD1({ rows: [ROWS[0]], count: 2 }), // returned 1, COUNT(*) says 2
    SITE_ORIGIN: 'https://x',
    DATA_SOURCE: 'd1',
  };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.stale, true);
  assert.match(r.error, /COUNT\(\*\)/);
});

test('an empty locations table is refused, not materialized', async () => {
  const env = {
    DATASET: fakeKV(), DB: fakeD1({ rows: [] }), SITE_ORIGIN: 'https://x', DATA_SOURCE: 'd1',
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
    DATA_SOURCE: 'd1',
  };
  await runRefresh(env, fakeFetch());
  const full = await env.DATASET.get(KEYS.full, 'json');
  // Still must not appear: nothing auto-publishes any more, dismissal only
  // controls whether it is reported as a candidate.
  assert.equal('nexus-777' in full, false);
});
