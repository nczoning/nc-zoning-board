import test from 'node:test';
import assert from 'node:assert/strict';
import { runRefresh } from '../src/refresh.js';
import { readAlerts } from '../src/alerts.js';
import { KEYS } from '../src/store.js';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';

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

// This file covers the CRON MECHANICS: the content-hash gate, the heartbeat,
// stale/recovery, alerts and archive budgeting. What the dataset is built FROM
// is covered in refresh-d1.test.js. Both run against real SQLite on the real
// migrations, because D1 is the only source.
//
// `apartment` is a real registry slug seeded by migration 0002, so the
// location_tags foreign key resolves.
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

// 777 is dismissed rather than absent, so it stays off the map and out of
// `skipped`, which is what excluded_mods.json used to do on the static path.
function seededD1() {
  const db = sqliteD1({ locations: ROWS, locationTags: [['m1', 'apartment']] });
  db._db.prepare(
    'INSERT INTO dismissed_candidates (nexus_id, reason, dismissed_by, dismissed_at) VALUES (?, ?, ?, ?)',
  ).run('777', null, 'test', '2026-01-01T00:00:00Z');
  return db;
}

const newEnv = (over = {}) => ({
  DATASET: fakeKV(), DB: seededD1(), SITE_ORIGIN: 'https://x', ...over,
});

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
// GraphQL response with the tagged mod already on the map (888) and the
// dismissed 777.
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
function fakeFetch({ failNexus = false, discordSink, archiveCalls, failArchives = false } = {}) {
  return async (url, init) => {
    // Subdistricts are the only source file left. mods.json, tags.json and
    // excluded_mods.json have no branch here on purpose: a request for one
    // falls through to the throw at the bottom and fails the test loudly.
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
  const env = newEnv();
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
  const env = newEnv();
  await runRefresh(env, fakeFetch());
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.equal(full.m1.thumbnail_url, 'tm'); // manual mod 12345, not NCZoning-tagged
  assert.equal(full.m1.updated_at, '2026-07-08');
});

test('the tagged query is fetched once per tick, not once per consumer', async () => {
  // The sweep and the dataset build both need the NCZoning tag set. Fetching it
  // twice would double the tick's most expensive Nexus call for nothing, and
  // would let the two see different answers if a mod were tagged in between.
  const env = newEnv();
  let tagged = 0;
  const counting = (inner) => async (url, init) => {
    if (String(url).includes('api.nexusmods.com')
      && !JSON.parse(init.body).query.includes('modsByUid')) tagged += 1;
    return inner(url, init);
  };
  await runRefresh(env, counting(fakeFetch()));
  assert.equal(tagged, 1);
});

test('unchanged content on the second run skips the content write (changed=false)', async () => {
  const env = newEnv();
  await runRefresh(env, fakeFetch());
  const before = (await env.DATASET.get(KEYS.meta, 'json')).generated_at;
  const r2 = await runRefresh(env, fakeFetch());
  assert.equal(r2.changed, false);
  // generated_at (content time) is preserved — the dataset wasn't rewritten. Only
  // the last_refresh_at heartbeat moves on an unchanged cycle (see next test).
  assert.equal((await env.DATASET.get(KEYS.meta, 'json')).generated_at, before);
});

test('an unchanged cycle advances the heartbeat once the interval has elapsed', async () => {
  const env = newEnv();
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
  const env = newEnv();
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
  const env = newEnv();
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
  const env = newEnv();
  await runRefresh(env, fakeFetch()); // seed good
  const seeded = await env.DATASET.get(KEYS.meta, 'json');
  await env.DATASET.put(KEYS.meta, JSON.stringify({ ...seeded, last_refresh_at: '2000-01-01T00:00:00.000Z' }));
  await runRefresh(env, fakeFetch({ failNexus: true }));
  const meta = await env.DATASET.get(KEYS.meta, 'json');
  assert.equal(meta.discovery_stale, true);                          // data is stale…
  assert.notEqual(meta.last_refresh_at, '2000-01-01T00:00:00.000Z'); // …but the cron is alive
});

test('Nexus failure keeps last-known-good, flags stale, and records the alert', async () => {
  // Dedicated alerts channel (preferred over the legacy DISCORD_WEBHOOK_URL).
  const env = newEnv({ NCZ_ALERTS_DISCORD_WEBHOOK_URL: 'https://discord/webhook' });
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

  // Recorded, and NOT posted. One failed tick is a blip that the next tick
  // usually clears, and the dataset never stopped being served. The row is what
  // makes it reviewable; the Discord post is what is being withheld until the
  // failure has persisted (see the streak test below).
  const rows = await readAlerts(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Data API refresh failed');
  assert.equal(rows[0].notify, 0);
  assert.equal(discordSink.length, 0);
});

test('the third consecutive failure is the one that reaches Discord', async () => {
  // The threshold is the whole point of routing this alert: below it a person
  // is not told, at it they are. Asserting only the quiet case would pass on a
  // build that never notifies at all.
  const env = newEnv({ NCZ_ALERTS_DISCORD_WEBHOOK_URL: 'https://discord/webhook' });
  const discordSink = [];
  await runRefresh(env, fakeFetch({ discordSink })); // seed good

  await runRefresh(env, fakeFetch({ failNexus: true, discordSink }));
  await runRefresh(env, fakeFetch({ failNexus: true, discordSink }));
  assert.equal(discordSink.length, 0, 'two failures is still a blip');

  await runRefresh(env, fakeFetch({ failNexus: true, discordSink }));
  assert.equal(discordSink.length, 1, 'the third is not');
  assert.match(discordSink[0].embeds[0].title, /refresh failed/);
  assert.match(discordSink[0].embeds[0].description, /Consecutive failed cycles: 3/);

  // Every failure is recorded either way, which is what the streak counts.
  const failures = (await readAlerts(env)).filter((a) => a.title === 'Data API refresh failed');
  assert.equal(failures.length, 3);
});

test('a recovery resets the streak, so the next blip is quiet again', async () => {
  // Without the reset the count would keep climbing across unrelated outages
  // and the fourth blip of the week would page for no reason.
  const env = newEnv({ NCZ_ALERTS_DISCORD_WEBHOOK_URL: 'https://discord/webhook' });
  const discordSink = [];
  await runRefresh(env, fakeFetch({ discordSink }));
  for (let i = 0; i < 3; i += 1) {
    await runRefresh(env, fakeFetch({ failNexus: true, discordSink }));
  }
  assert.equal(discordSink.length, 1, 'the third failure posted');

  await runRefresh(env, fakeFetch({ discordSink }));                  // recover
  await runRefresh(env, fakeFetch({ failNexus: true, discordSink })); // a fresh blip
  assert.equal(discordSink.length, 1, 'the count restarted at the recovery');
});

test('failure with no prior dataset returns stale with null version, no crash', async () => {
  // An empty registry is the trigger: readLocationRows refuses to materialize
  // an empty map. What matters is the shape of the failure, not its cause.
  const env = { DATASET: fakeKV(), DB: sqliteD1(), SITE_ORIGIN: 'https://x' };
  const r = await runRefresh(env, fakeFetch());
  assert.equal(r.stale, true);
  assert.equal(r.version, null);
  assert.equal(await env.DATASET.get(KEYS.full, 'json'), null);
});

test('recovery after a stale cycle rewrites and clears the stale flag', async () => {
  const env = newEnv();
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
  const env = newEnv();
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
  const env = newEnv();
  await runRefresh(env, fakeFetch()); // fills the cache
  const archiveCalls = [];
  await runRefresh(env, fakeFetch({ archiveCalls }));
  assert.equal(archiveCalls.length, 0); // nothing stale → zero archive subrequests
});

test('archive fetch failure degrades to [] and never marks the dataset stale', async () => {
  const env = newEnv();
  const r = await runRefresh(env, fakeFetch({ failArchives: true }));
  assert.equal(r.stale, false); // archives are supplementary, not load-bearing
  assert.equal(r.changed, true);
  const full = await env.DATASET.get(KEYS.full, 'json');
  assert.deepEqual(full.m1.archives, []); // failed → empty, and not cached
  assert.equal((await env.DATASET.get(KEYS.meta, 'json')).discovery_stale, false);
});

test('archive refresh is budgeted per run and cold-fills over multiple runs', async () => {
  // 20 published rows, all numeric nexus_ids, cold cache → all stale at once.
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `m${i}`, name: `Mod ${String(i).padStart(2, '0')}`, nexus_id: String(1000 + i),
    category: 'other', x: 250, y: 250, z: 10, yaw: null, description: 'x', credits: null,
    authors: '["A"]', status: 'published', admin_notes: null, owner_id: null,
    added_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z',
  }));
  // modsByUid must answer for all 20: an empty nexus_cache is refused outright,
  // so a stub that returns nothing would fail the refresh before the archive
  // pass this test is about ever runs.
  const thumbs = many.map((r) => ({
    modId: Number(r.nexus_id), pictureUrl: 'p', thumbnailUrl: 't', updatedAt: '2026-07-08',
  }));
  const impl = (archiveCalls) => async (url, init) => {
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
        return { ok: true, json: async () => ({ data: { modsByUid: { nodes: thumbs } } }) };
      }
      return { ok: true, json: async () => ({ data: { mods: { nodes: [], totalCount: 0 } } }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const env = { DATASET: fakeKV(), DB: sqliteD1({ locations: many }), SITE_ORIGIN: 'https://x' };
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

test('recovery records a recovery alert exactly once (edge, not every cycle)', async () => {
  // The edge behaviour is unchanged; only the destination is. Both halves of a
  // blip-and-recover are recorded and neither is posted, so the channel does
  // not carry a problem and its resolution five minutes apart.
  const env = newEnv({ NCZ_ALERTS_DISCORD_WEBHOOK_URL: 'https://discord/webhook' });
  const discordSink = [];
  await runRefresh(env, fakeFetch({ discordSink }));                  // seed good
  await runRefresh(env, fakeFetch({ failNexus: true, discordSink })); // fail → stale + alert
  const r = await runRefresh(env, fakeFetch({ discordSink }));        // recover → all-clear
  assert.equal(r.recovered, true);

  const rows = (await readAlerts(env)).map((a) => [a.title, a.notify]);
  assert.deepEqual(rows, [
    ['Data API refresh recovered', 0],
    ['Data API refresh failed', 0],
  ], 'newest first, both recorded, neither posted');
  assert.equal(discordSink.length, 0);

  // A subsequent healthy cycle must NOT re-announce recovery.
  const r2 = await runRefresh(env, fakeFetch({ discordSink }));
  assert.equal(r2.recovered ?? false, false);
  assert.equal((await readAlerts(env)).length, 2); // still just the fail + the one recovery
});
