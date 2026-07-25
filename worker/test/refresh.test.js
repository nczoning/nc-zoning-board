import test from 'node:test';
import assert from 'node:assert/strict';
import { runRefresh } from '../src/refresh.js';
import { KEYS } from '../src/store.js';

// Minimal in-memory KV: get(key, 'json') + put(key, string). `_putCount` exists
// because KV writes are the scarce resource here (1,000/day per ACCOUNT), so
// "did this tick write anything at all" is a property worth asserting directly
// rather than inferring from values.
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  let puts = 0;
  return {
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { puts += 1; store.set(key, value); },
    _dump: () => Object.fromEntries(store),
    _putCount: () => puts,
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

// fetch stub keyed by URL substring; nexus POST returns the page. `archiveCalls`
// (optional) records each archive subrequest so tests can assert on budgeting
// and cache reuse; `failArchives` makes the modFiles call fail.
function fakeFetch({ failNexus = false, failMods = false, discordSink, archiveCalls, failArchives = false } = {}) {
  return async (url, init) => {
    if (url.includes('/mods.json')) {
      return failMods ? { ok: false, status: 500 } : { ok: true, json: async () => MODS };
    }
    if (url.includes('/tags.json')) return { ok: true, json: async () => TAGS };
    if (url.includes('/excluded_mods.json')) return { ok: true, json: async () => EXCLUDED };
    if (url.includes('/subdistricts.json')) return { ok: true, json: async () => SUBDISTRICTS };
    // Archive-name endpoints (installed-mod detection). Checked before the
    // generic api.nexusmods.com branch: "api-router.nexusmods.com" and
    // "file-metadata.nexusmods.com" are distinct hosts.
    if (url.includes('api-router.nexusmods.com')) {
      archiveCalls?.push('router');
      if (failArchives) return { ok: false, status: 503 };
      const modId = JSON.parse(init.body).variables.modId;
      return { ok: true, json: async () => ({ data: { modFiles: [{ uri: `mod-${modId}.7z`, category: 'MAIN' }] } }) };
    }
    if (url.includes('file-metadata.nexusmods.com')) {
      archiveCalls?.push('file');
      const modId = url.match(/nexus-files-s3-meta\/3333\/(\d+)\//)[1];
      return { ok: true, json: async () => ({ children: [{ name: 'archive', type: 'directory', children: [
        { name: 'pc', type: 'directory', children: [
          { name: 'mod', type: 'directory', children: [
            { name: `mod_${modId}.archive`, type: 'file', path: `archive/pc/mod/mod_${modId}.archive` },
          ] },
        ] },
      ] }] }) };
    }
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
  assert.ok(!('counts' in meta)); // aggregates removed; consumers derive their own
  assert.equal(meta.dataset_version, r.version);
});

test('manual-mod images are backfilled into full via modsByUid', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.equal(full.m1.thumbnail_url, 'tm'); // manual mod 12345, not NCZoning-tagged
  assert.equal(full.m1.updated_at, '2026-07-08');
});

test('unchanged content on the second run skips the content write (changed=false)', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());
  const before = (await env.DATASET.get(KEYS.meta, 'json')).generated_at;
  const r2 = await runRefresh(env, fakeFetch());
  assert.equal(r2.changed, false);
  // generated_at (content time) is preserved — the dataset wasn't rewritten. Only
  // the last_refresh_at heartbeat moves on an unchanged cycle (see next test).
  assert.equal((await env.DATASET.get(KEYS.meta, 'json')).generated_at, before);
});

test('an unchanged cycle advances the heartbeat once the interval has elapsed', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());
  const m1 = await env.DATASET.get(KEYS.meta, 'json');
  assert.ok(m1.last_refresh_at, 'first run stamps a heartbeat');

  // Pin the heartbeat far enough in the past to be due, then run an UNCHANGED
  // cycle: the content hash matches, so nothing is rewritten EXCEPT the
  // heartbeat, which must advance — proving the cron ran. generated_at (content
  // time) must NOT move. This is the #849 liveness signal: a running-but-idle
  // cron still proves life.
  await env.DATASET.put(KEYS.meta, JSON.stringify({ ...m1, last_refresh_at: '2000-01-01T00:00:00.000Z' }));
  const r2 = await runRefresh(env, fakeFetch());
  assert.equal(r2.changed, false);
  assert.equal(r2.heartbeat, true);
  const m2 = await env.DATASET.get(KEYS.meta, 'json');
  assert.notEqual(m2.last_refresh_at, '2000-01-01T00:00:00.000Z'); // heartbeat advanced
  assert.equal(m2.generated_at, m1.generated_at);                  // content time frozen
});

test('an unchanged cycle inside the heartbeat interval writes NOTHING', async () => {
  // The write that caused the free-tier alert: the heartbeat bypasses the
  // content-hash gate, so writing it every tick costs 288 writes/day/env against
  // a 1,000/day ACCOUNT cap. Rate-limiting it must make an idle tick cost zero.
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());          // seeds; stamps the heartbeat "now"
  const before = await env.DATASET.get(KEYS.meta, 'json');
  const writesAfterSeed = env.DATASET._putCount();

  const r2 = await runRefresh(env, fakeFetch()); // immediately after → inside the window

  assert.equal(r2.changed, false);
  assert.equal(r2.heartbeat, false, 'heartbeat suppressed inside the interval');
  assert.equal(env.DATASET._putCount(), writesAfterSeed, 'idle tick performed no KV write');
  const after = await env.DATASET.get(KEYS.meta, 'json');
  assert.equal(after.last_refresh_at, before.last_refresh_at);
});

test('a missing last_refresh_at is treated as due (no permanent suppression)', async () => {
  // Meta written before #849 has no heartbeat field. Date.parse(undefined) is
  // NaN, and every comparison against NaN is false — so a naive `elapsed >= X`
  // guard would suppress the heartbeat forever and the monitor would read the
  // Worker as wedged. It must fall through to "write it".
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch());
  const seeded = await env.DATASET.get(KEYS.meta, 'json');
  delete seeded.last_refresh_at;
  await env.DATASET.put(KEYS.meta, JSON.stringify(seeded));

  const r2 = await runRefresh(env, fakeFetch());
  assert.equal(r2.changed, false);
  assert.equal(r2.heartbeat, true);
  assert.ok((await env.DATASET.get(KEYS.meta, 'json')).last_refresh_at);
});

test('a failed refresh still advances the heartbeat (cron ran; Nexus did not answer)', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch()); // seed good
  const seeded = await env.DATASET.get(KEYS.meta, 'json');
  await env.DATASET.put(KEYS.meta, JSON.stringify({ ...seeded, last_refresh_at: '2000-01-01T00:00:00.000Z' }));
  await runRefresh(env, fakeFetch({ failNexus: true }));
  const meta = await env.DATASET.get(KEYS.meta, 'json');
  assert.equal(meta.discovery_stale, true);                          // data is stale…
  assert.notEqual(meta.last_refresh_at, '2000-01-01T00:00:00.000Z'); // …but the cron is alive
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

// ── Archive names (installed-mod detection) ─────────────────────────────────

test('archive names are fetched and attached to every record', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  const archiveCalls = [];
  await runRefresh(env, fakeFetch({ archiveCalls }));
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.deepEqual(full.m1.archives, ['mod_12345.archive']); // manual mod
  const auto = Object.values(full).find((r) => r.id === 'nexus-888');
  assert.deepEqual(auto.archives, ['mod_888.archive']); // auto-discovered mod
  // One modFiles call per numeric-nexus_id mod (both here).
  assert.equal(archiveCalls.filter((c) => c === 'router').length, 2);
});

test('archive cache is reused when updatedAt is unchanged (no refetch)', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  await runRefresh(env, fakeFetch()); // fills the cache
  const archiveCalls = [];
  await runRefresh(env, fakeFetch({ archiveCalls }));
  assert.equal(archiveCalls.length, 0); // nothing stale → zero archive subrequests
});

test('archive fetch failure degrades to [] and never marks the dataset stale', async () => {
  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  const r = await runRefresh(env, fakeFetch({ failArchives: true }));
  assert.equal(r.stale, false); // archives are supplementary, not load-bearing
  assert.equal(r.changed, true);
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.deepEqual(full.m1.archives, []); // failed → empty, and not cached
  assert.equal((await env.DATASET.get(KEYS.meta, 'json')).discovery_stale, false);
});

test('archive refresh is budgeted per run and cold-fills over multiple runs', async () => {
  // 20 manual mods, all numeric nexus_ids, cold cache → all stale at once.
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`, name: `Mod ${String(i).padStart(2, '0')}`, authors: ['A'],
    coordinates: [250, 250, 10], nexus_id: String(1000 + i), description: 'x',
    category: 'other', tags: [],
  }));
  const impl = (archiveCalls) => async (url, init) => {
    if (url.includes('/mods.json')) return { ok: true, json: async () => many };
    if (url.includes('/tags.json')) return { ok: true, json: async () => TAGS };
    if (url.includes('/excluded_mods.json')) return { ok: true, json: async () => ({}) };
    if (url.includes('/subdistricts.json')) return { ok: true, json: async () => SUBDISTRICTS };
    if (url.includes('api-router.nexusmods.com')) {
      archiveCalls.push('router');
      return { ok: true, json: async () => ({ data: { modFiles: [{ uri: 'a.7z', category: 'MAIN' }] } }) };
    }
    if (url.includes('file-metadata.nexusmods.com')) {
      archiveCalls.push('file');
      return { ok: true, json: async () => ({ children: [] }) };
    }
    if (url.includes('api.nexusmods.com')) {
      if (JSON.parse(init.body).query.includes('modsByUid')) {
        return { ok: true, json: async () => ({ data: { modsByUid: { nodes: [] } } }) };
      }
      return { ok: true, json: async () => ({ data: { mods: { nodes: [], totalCount: 0 } } }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const env = { DATASET: fakeKV(), SITE_ORIGIN: 'https://x' };
  const run1 = [];
  await runRefresh(env, impl(run1));
  const refreshed1 = run1.filter((c) => c === 'router').length;
  assert.ok(refreshed1 < 20, `run 1 refreshed ${refreshed1}: must be budgeted, not all 20`);

  const run2 = [];
  await runRefresh(env, impl(run2));
  const refreshed2 = run2.filter((c) => c === 'router').length;
  // Cold-fill completes: the two runs together cover exactly the 20 mods once.
  assert.equal(refreshed1 + refreshed2, 20);

  const run3 = [];
  await runRefresh(env, impl(run3));
  assert.equal(run3.length, 0, 'once filled, steady state fetches nothing');
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
