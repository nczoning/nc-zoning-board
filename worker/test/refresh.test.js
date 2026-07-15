import test from 'node:test';
import assert from 'node:assert/strict';
import { runRefresh } from '../src/refresh.js';
import { KEYS } from '../src/store.js';

// Minimal in-memory KV: get(key, 'json') + put(key, string).
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
    _dump: () => Object.fromEntries(store),
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

// GraphQL response with one valid auto mod (888) and the excluded 777.
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

// fetch stub keyed by URL substring; nexus POST returns the page.
function fakeFetch({ failNexus = false, failMods = false, discordSink } = {}) {
  return async (url, init) => {
    if (url.includes('/mods.json')) {
      return failMods ? { ok: false, status: 500 } : { ok: true, json: async () => MODS };
    }
    if (url.includes('/tags.json')) return { ok: true, json: async () => TAGS };
    if (url.includes('/excluded_mods.json')) return { ok: true, json: async () => EXCLUDED };
    if (url.includes('/subdistricts.json')) return { ok: true, json: async () => SUBDISTRICTS };
    if (url.includes('api.nexusmods.com')) {
      if (failNexus) return { ok: false, status: 503 };
      // Two POST shapes hit the same endpoint: the tagged-mods query and the
      // modsByUid image backfill. Route by the query body.
      if (JSON.parse(init.body).query.includes('modsByUid')) {
        return { ok: true, json: async () => ({
          data: { modsByUid: { nodes: [
            { modId: 12345, pictureUrl: 'pm', thumbnailUrl: 'tm', updatedAt: '2026-07-08' },
          ] } },
        }) };
      }
      return { ok: true, json: async () => NEXUS_PAGE };
    }
    if (url.includes('discord')) { discordSink?.push(JSON.parse(init.body)); return { ok: true }; }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('first run writes the full dataset (changed=true)', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.changed, true);
  assert.ok(r.version);
  const full = await env.DATASET.get(KEYS.full, 'json');
  const locs = Object.values(full);
  assert.equal(locs.length, 2); // 1 manual + 1 auto (777 excluded)
  assert.ok(locs.every((l) => l.district));
  assert.ok(locs.every((l) => typeof l.recently_updated === 'boolean'));
  const meta = await env.DATASET.get(KEYS.meta, 'json');
  assert.equal(meta.discovery_stale, false);
  assert.ok(!('counts' in meta)); // aggregates removed — consumers derive their own
  assert.equal(meta.dataset_version, r.version);
});

test('manual-mod images are backfilled into full via modsByUid', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.equal(full.m1.thumbnail_url, 'tm'); // manual mod 12345, not NCZoning-tagged
  assert.equal(full.m1.updated_at, '2026-07-08');
});

test('unchanged content on the second run skips the write (changed=false)', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());
  const before = (await env.DATASET.get(KEYS.meta, 'json')).generated_at;
  const r2 = await runRefresh(env, fakeFetch());
  assert.equal(r2.changed, false);
  // generated_at unchanged because we didn't rewrite.
  assert.equal((await env.DATASET.get(KEYS.meta, 'json')).generated_at, before);
});

test('Nexus failure keeps last-known-good and flags stale + alerts Discord', async () => {
  const env = {
    DATASET: fakeKV(), SITE_ORIGIN: 'https://x',
    // Dedicated alerts channel (preferred over the legacy DISCORD_WEBHOOK_URL).
    NCZ_ALERTS_DISCORD_WEBHOOK_URL: 'https://discord/webhook',
  };
  await runRefresh(env, fakeFetch()); // seed good data
  const goodFull = await env.DATASET.get(KEYS.full, 'json');

  const discordSink = [];
  const r = await runRefresh(env, fakeFetch({ failNexus: true, discordSink }));
  assert.equal(r.stale, true);
  assert.match(r.error, /503/);
  // Dataset preserved (not wiped).
  assert.deepEqual(await env.DATASET.get(KEYS.full, 'json'), goodFull);
  const meta = await env.DATASET.get(KEYS.meta, 'json');
  assert.equal(meta.discovery_stale, true);
  assert.match(meta.last_error, /503/);
  assert.equal(discordSink.length, 1);
  assert.match(discordSink[0].embeds[0].title, /refresh failed/);
});

test('failure with no prior dataset returns stale with null version, no crash', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  const r = await runRefresh(env, fakeFetch({ failMods: true }));
  assert.equal(r.stale, true);
  assert.equal(r.version, null);
  assert.equal(await env.DATASET.get(KEYS.full, 'json'), null);
});

test('recovery after a stale cycle rewrites and clears the stale flag', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());
  await runRefresh(env, fakeFetch({ failNexus: true }));
  assert.equal((await env.DATASET.get(KEYS.meta, 'json')).discovery_stale, true);
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.changed, true); // stale flag forces a rewrite even if hash matches
  assert.equal(r.recovered, true);
  assert.equal((await env.DATASET.get(KEYS.meta, 'json')).discovery_stale, false);
});

test('recovery posts a recovery alert exactly once (edge, not every cycle)', async () => {
  const env = {
    DATASET: fakeKV(), SITE_ORIGIN: 'https://x',
    NCZ_ALERTS_DISCORD_WEBHOOK_URL: 'https://discord/webhook',
  };
  const discordSink = [];
  await runRefresh(env, fakeFetch({ discordSink }));                  // seed good
  await runRefresh(env, fakeFetch({ failNexus: true, discordSink })); // fail → stale + alert
  const r = await runRefresh(env, fakeFetch({ discordSink }));        // recover → all-clear
  assert.equal(r.recovered, true);
  const titles = discordSink.map((m) => m.embeds[0].title);
  assert.deepEqual(titles, ['⚠️ Data API refresh failed', '✅ Data API refresh recovered']);

  // A subsequent healthy cycle must NOT re-announce recovery.
  const r2 = await runRefresh(env, fakeFetch({ discordSink }));
  assert.equal(r2.recovered ?? false, false);
  assert.equal(discordSink.length, 2); // still just the fail + the one recovery
});
