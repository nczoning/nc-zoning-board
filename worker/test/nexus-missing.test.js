import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';
import { refreshNexusCache } from '../src/nexus-cache.js';
import {
  sweepLooksUnreliable, readMissing, setMissingDismissed,
  FLAG_STREAK, SWEEP_MIN_SUSPECT,
} from '../src/nexus-missing.js';

// A pin whose mod was deleted from Nexus (#900).
//
// Real SQLite on the real migrations, driven through the actual sweep rather
// than by calling recordSweep directly, because the interesting part is not the
// counter -- it is which sweeps are allowed to move it. `fetchModsByUidThumbs`
// returns {} on failure and cannot distinguish "gone" from "Nexus is down", so
// every test here is really about telling those two apart.

const T0 = Date.parse('2026-07-27T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const HOUR = 3600_000;
const MIN = 60_000;

/**
 * A fetch that answers the tagged query, then modsByUid with ONLY the ids in
 * `alive`. Unlike the helper in nexus-cache.test.js this respects WHICH uids
 * were asked for: the whole subject here is the difference between the ids
 * requested and the ids returned.
 */
function fakeNexus({ tagged = [], alive = [], byUidFails = false } = {}) {
  const liveSet = new Set(alive.map(String));
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('NCZoningMods')) {
      return { ok: true, async json() { return { data: { mods: { nodes: tagged, totalCount: tagged.length } } }; } };
    }
    if (byUidFails) return { ok: false, status: 503, async json() { return {}; } };
    // The composite uid Nexus wants is (gameId << 32) + modId; recover the
    // modId so the stub can answer per-id rather than by count.
    const asked = body.variables.uids.map((uid) => String(BigInt(uid) & 0xffffffffn));
    const nodes = asked.filter((id) => liveSet.has(id)).map((id) => ({
      modId: id, name: `Mod ${id}`, pictureUrl: `p${id}`, thumbnailUrl: `t${id}`,
      updatedAt: '2026-07-01T00:00:00.000Z',
    }));
    return { ok: true, async json() { return { data: { modsByUid: { nodes } } }; } };
  };
}

const location = (id, nexusId) => ({
  id, name: `Loc ${id}`, nexus_id: nexusId, category: 'new-location',
  x: 0, y: 0, z: 0, authors: '["a"]', description: '',
  status: 'published', added_at: at(0), modified_at: at(0),
});

/** Two pinned, untagged mods: one alive, one deleted. */
function envWith(pins = [['l1', '100'], ['l2', '200']]) {
  return { DB: sqliteD1({ locations: pins.map(([id, nx]) => location(id, nx)) }) };
}

const tracked = (env) => env.DB.rows('SELECT * FROM nexus_missing ORDER BY nexus_id');
const one = (env, id) => env.DB.one('SELECT * FROM nexus_missing WHERE nexus_id = ?', id);

/** Run n sweeps `gap` apart, all with the same alive set, starting at `from`. */
async function sweeps(env, { alive, count, gap, from = 0 }) {
  let last;
  for (let i = 0; i < count; i += 1) {
    last = await refreshNexusCache(env, {
      fetchImpl: fakeNexus({ alive }),
      nowIso: at(from + i * gap),
    });
  }
  return last;
}

// ------------------------------------------------------- the outage guard ---
// The partial case the existing `stale` flag cannot see: modsByUid is chunked
// and a chunk that fails after its retry returns {} for its whole share, which
// reads as a simultaneous mass deletion.

test('sweepLooksUnreliable: a small miss set is believed, a chunk-shaped one is not', () => {
  assert.equal(sweepLooksUnreliable({ missing: 1, requested: 3 }), false,
    'one deletion out of three pinned mods is 33% and must still count');
  assert.equal(sweepLooksUnreliable({ missing: SWEEP_MIN_SUSPECT - 1, requested: 5 }), false,
    'below the floor is always believed, whatever the ratio');
  assert.equal(sweepLooksUnreliable({ missing: 50, requested: 200 }), true,
    'a whole failed chunk is not fifty deletions');
  assert.equal(sweepLooksUnreliable({ missing: 5, requested: 200 }), false,
    'five of two hundred is a plausible set of deletions');
});

// ------------------------------------------------------------- the counter ---

test('a mod Nexus still returns is not tracked at all', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100', '200'], count: 3, gap: HOUR });
  assert.deepEqual(tracked(env), [], 'no row means healthy; a zeroed row would cost a write per sweep');
});

test('a mod Nexus stops returning starts a streak, and the streak counts sweeps', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100'], count: 3, gap: HOUR });

  const row = one(env, '200');
  assert.equal(row.miss_streak, 3);
  assert.equal(row.missing_since, at(0), 'missing_since is the start of the streak, not the last sweep');
  assert.equal(row.last_missed_at, at(2 * HOUR));
  assert.equal(row.flagged_at, null, 'three hours is not evidence of anything');
  assert.equal(tracked(env).length, 1, 'the mod that answered must not be tracked');
});

test('the mod coming back deletes the row, and a later disappearance starts from one', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100'], count: 4, gap: HOUR });
  assert.equal(one(env, '200').miss_streak, 4);

  await sweeps(env, { alive: ['100', '200'], count: 1, gap: HOUR, from: 5 * HOUR });
  assert.equal(one(env, '200'), null, 'a mod that answered is not missing');

  await sweeps(env, { alive: ['100'], count: 1, gap: HOUR, from: 6 * HOUR });
  assert.equal(one(env, '200').miss_streak, 1, 'the streak restarts, it does not resume');
  assert.equal(one(env, '200').missing_since, at(6 * HOUR));
});

test('a mod that stops being pinned stops being tracked', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100'], count: 2, gap: HOUR });
  assert.ok(one(env, '200'));

  env.DB._db.prepare('DELETE FROM locations WHERE id = ?').run('l2');
  await sweeps(env, { alive: ['100'], count: 1, gap: HOUR, from: 3 * HOUR });
  assert.equal(one(env, '200'), null, 'nothing points at it, so there is nothing to review');
});

// ------------------------------------------------------------- the flagging ---
// Both conditions, because either alone is wrong: a streak alone flags on a
// short outage when the cron is fast, and a duration alone flags on two sweeps
// a day apart, which demonstrates nothing.

test('a mod missing for a day of consecutive sweeps is flagged, once', async () => {
  const env = envWith();
  const early = await sweeps(env, { alive: ['100'], count: FLAG_STREAK - 1, gap: 5 * HOUR });
  assert.deepEqual(early.missing.flagged, [], 'not yet: the streak is one sweep short');
  assert.equal(one(env, '200').flagged_at, null);

  const crossing = await sweeps(env, {
    alive: ['100'], count: 1, gap: HOUR, from: (FLAG_STREAK - 1) * 5 * HOUR,
  });
  assert.deepEqual(crossing.missing.flagged, ['200']);
  assert.equal(one(env, '200').flagged_at, at((FLAG_STREAK - 1) * 5 * HOUR));

  const after = await sweeps(env, {
    alive: ['100'], count: 1, gap: HOUR, from: (FLAG_STREAK * 5 + 1) * HOUR,
  });
  assert.deepEqual(after.missing.flagged, [], 'flagging twice would alert twice for one disappearance');
  assert.equal(one(env, '200').flagged_at, at((FLAG_STREAK - 1) * 5 * HOUR),
    'the flag keeps the time it was raised');
});

test('a long streak inside one day is not a flag', async () => {
  const env = envWith();
  const r = await sweeps(env, { alive: ['100'], count: FLAG_STREAK + 6, gap: 5 * MIN });
  assert.deepEqual(r.missing.flagged, [], 'an hour of Nexus being unhelpful is not a deleted mod');
  // The stored flag, not just the last sweep's return: a flag raised on an
  // earlier sweep is absent from the last one's list precisely because it has
  // already been raised, so the return value alone cannot prove this.
  assert.equal(one(env, '200').flagged_at, null);
  assert.equal(one(env, '200').miss_streak, FLAG_STREAK + 6);
});

test('two sweeps a day apart are not a flag either', async () => {
  const env = envWith();
  const r = await sweeps(env, { alive: ['100'], count: 2, gap: 25 * HOUR });
  assert.deepEqual(r.missing.flagged, [], 'a cron that ran twice has demonstrated nothing');
  assert.equal(one(env, '200').flagged_at, null);
  assert.equal(one(env, '200').miss_streak, 2);
});

test('flagging never touches the location', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100'], count: FLAG_STREAK, gap: 5 * HOUR });
  assert.equal(one(env, '200').flagged_at, at((FLAG_STREAK - 1) * 5 * HOUR), 'precondition: it flagged');
  assert.equal(env.DB.one('SELECT status FROM locations WHERE id = ?', 'l2').status, 'published',
    'no auto-hide: only a human writes locations.status');
});

// --------------------------------------------------------- untrusted sweeps ---

test('a sweep where Nexus returned nothing at all counts nothing', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100'], count: 2, gap: HOUR });
  assert.equal(one(env, '200').miss_streak, 2);

  const r = await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ alive: [] }), nowIso: at(3 * HOUR),
  });
  assert.equal(r.stale, true, 'precondition: asked for two, got none');
  assert.equal(r.missing.skipped, 'stale');
  assert.equal(one(env, '200').miss_streak, 2, 'a failed sweep must not increment');
  assert.equal(one(env, '100'), null, 'and must not invent a streak for the healthy mod');
});

test('a sweep that reads as a failed chunk counts nothing, and keeps the streaks it has', async () => {
  // Twelve pinned mods, one genuinely gone. Then a sweep where nine come back
  // empty: that is 75% of the request, which is a Nexus problem.
  const pins = Array.from({ length: 12 }, (_, i) => [`l${i}`, String(100 + i)]);
  const env = envWith(pins);
  const allIds = pins.map(([, nx]) => nx);
  const alive = allIds.filter((id) => id !== '111');

  await sweeps(env, { alive, count: 3, gap: HOUR });
  assert.equal(one(env, '111').miss_streak, 3);

  const r = await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ alive: allIds.slice(0, 3) }), nowIso: at(4 * HOUR),
  });
  assert.equal(r.stale, false, 'three ids came back, so the all-or-nothing guard does not fire');
  assert.equal(r.missing.skipped, 'unreliable');
  assert.equal(tracked(env).length, 1, 'nine mods did not vanish at once');
  assert.equal(one(env, '111').miss_streak, 3, 'the real streak is frozen, not reset');

  const back = await sweeps(env, { alive, count: 1, gap: HOUR, from: 5 * HOUR });
  assert.equal(back.missing.tracked, 1, 'and it picks up again on the next believable sweep');
  assert.equal(one(env, '111').miss_streak, 4);
});

// ------------------------------------------------------------ the review list ---

test('the review list names the pins, including two pins on one mod', async () => {
  const env = envWith([['l1', '100'], ['l2', '200'], ['l3', '200']]);
  await sweeps(env, { alive: ['100'], count: 2, gap: HOUR });

  const list = await readMissing(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].nexus_id, '200');
  assert.deepEqual(list[0].locations.map((l) => l.name).sort(), ['Loc l2', 'Loc l3'],
    'one mod can supply two pins, and both are what the admin has to decide about');
  assert.equal(list[0].mod_name, null, 'Nexus never answered, so there is no name to show');
});

test('the review list carries the name when the cache has one', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100', '200'], count: 1, gap: HOUR });
  await sweeps(env, { alive: ['100'], count: 1, gap: HOUR, from: HOUR });

  const list = await readMissing(env);
  assert.equal(list[0].mod_name, 'Mod 200', 'it was cached before it disappeared');
});

// -------------------------------------------------------------- dismissal ---

test('dismissing keeps the row and survives later sweeps', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100'], count: 2, gap: HOUR });

  const after = await setMissingDismissed(env, '200', { actor: 'spuddeh', nowIso: at(3 * HOUR) });
  assert.equal(after.dismissed_by, 'spuddeh');
  assert.equal(after.dismissed_at, at(3 * HOUR));

  await sweeps(env, { alive: ['100'], count: 1, gap: HOUR, from: 4 * HOUR });
  const row = one(env, '200');
  assert.equal(row.dismissed_by, 'spuddeh', 'the sweep must not clear a decision a person made');
  assert.equal(row.miss_streak, 3, 'and the count keeps running underneath it');
});

test('dismissing an untracked mod is a miss, not a silent success', async () => {
  const env = envWith();
  assert.equal(await setMissingDismissed(env, '999', { actor: 'spuddeh' }), null);
});

test('undismissing puts it back in front of the admin', async () => {
  const env = envWith();
  await sweeps(env, { alive: ['100'], count: 2, gap: HOUR });
  await setMissingDismissed(env, '200', { actor: 'spuddeh', nowIso: at(3 * HOUR) });

  const back = await setMissingDismissed(env, '200', { actor: 'spuddeh', dismissed: false });
  assert.equal(back.dismissed_at, null);
  assert.equal(back.dismissed_by, null);
});
