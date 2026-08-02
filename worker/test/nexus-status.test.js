import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';
import { refreshNexusCache } from '../src/nexus-cache.js';
import { materializeFromD1 } from '../src/materialize.js';
import {
  sweepLooksUnreliable, isPublished, readModStatuses, readWithheld, setDismissed,
  CONFIRM_SWEEPS, ABSENT_STREAK, SWEEP_MIN_SUSPECT, MAX_WITHHELD,
  WASTEBINNED, ABSENT,
} from '../src/nexus-status.js';

// A pin whose mod is no longer published on Nexus (#900).
//
// Real SQLite on the real migrations, driven through the actual sweep rather
// than by calling recordSweep directly, because the interesting part is not the
// counter: it is which sweeps are allowed to move it, and what each verdict is
// permitted to do to the map.
//
// The premise, measured against the live API on 2026-08-02: `modsByUid` returns
// deleted and hidden mods like any other node, carrying a `status` that says
// so. The `mods` SEARCH query returns published mods only. So a deleted mod is
// PRESENT in the response, and absence is the weak, rare third case.

const T0 = Date.parse('2026-07-27T00:00:00.000Z');
const at = (ms) => new Date(T0 + ms).toISOString();
const HOUR = 3600_000;
const MIN = 60_000;

/**
 * A fetch answering the tagged query, then modsByUid from a per-id status map.
 * An id absent from `states` is absent from the response, which is the third
 * case; an id present with a status is RETURNED carrying it.
 */
function fakeNexus({ tagged = [], states = {} } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('NCZoningMods')) {
      return { ok: true, async json() { return { data: { mods: { nodes: tagged, totalCount: tagged.length } } }; } };
    }
    // The composite uid is (gameId << 32) + modId; recover the modId so the
    // stub can answer per-id rather than by count.
    const asked = body.variables.uids.map((uid) => String(BigInt(uid) & 0xffffffffn));
    const nodes = asked.filter((id) => id in states).map((id) => ({
      modId: id,
      name: `Mod ${id}`,
      status: states[id],
      pictureUrl: `p${id}`,
      thumbnailUrl: `t${id}`,
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

const envWith = (pins = [['l1', '100'], ['l2', '200']]) => (
  { DB: sqliteD1({ locations: pins.map(([id, nx]) => location(id, nx)) }) }
);

/** Both pinned mods published: the healthy baseline for every test. */
const ALL_OK = { 100: 'published', 200: 'published' };

const tracked = (env) => env.DB.rows('SELECT * FROM nexus_mod_status ORDER BY nexus_id');
const one = (env, id) => env.DB.one('SELECT * FROM nexus_mod_status WHERE nexus_id = ?', id);

/** Run n sweeps `gap` apart against the same states, starting at `from`. */
async function sweeps(env, { states, count, gap, from = 0 }) {
  let last;
  for (let i = 0; i < count; i += 1) {
    last = await refreshNexusCache(env, {
      fetchImpl: fakeNexus({ states }), nowIso: at(from + i * gap),
    });
  }
  return last;
}

// --------------------------------------------------------- reading a status ---

test('a null or unknown status reads as published, so no missing field can pull a pin', () => {
  assert.equal(isPublished('published'), true);
  assert.equal(isPublished(null), true, 'an absent field is not evidence of anything');
  assert.equal(isPublished(undefined), true);
  assert.equal(isPublished('hidden'), false);
  assert.equal(isPublished(WASTEBINNED), false);
  assert.equal(isPublished('some_new_word'), false,
    'an unrecognised status is tracked, not ignored');
});

test('a status Nexus has never sent before is stored verbatim', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'under_moderation' }, count: 1, gap: HOUR });
  assert.equal(one(env, '200').status, 'under_moderation',
    'flattening it to "hidden" would hide a vocabulary change from the one person who can act on it');
});

// ------------------------------------------------------------------ hidden ---

test('a hidden mod is flagged after three sweeps and the pin stays up', async () => {
  const env = envWith();
  const early = await sweeps(env, {
    states: { ...ALL_OK, 200: 'hidden' }, count: CONFIRM_SWEEPS - 1, gap: 5 * MIN,
  });
  assert.deepEqual(early.modStatus.flagged, [], 'one odd response is not a verdict');

  const crossing = await sweeps(env, {
    states: { ...ALL_OK, 200: 'hidden' }, count: 1, gap: 5 * MIN,
    from: (CONFIRM_SWEEPS - 1) * 5 * MIN,
  });
  assert.deepEqual(crossing.modStatus.flagged, ['200']);
  assert.equal(one(env, '200').status, 'hidden');

  const { withhold } = await readWithheld(env);
  assert.equal(withhold.size, 0,
    'hidden covers an author mid-upload and a moderation hold, and the API will not say which');
});

test('hidden never reaches the map, however long it lasts', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: 20, gap: 6 * HOUR });
  const { withhold } = await readWithheld(env);
  assert.equal(withhold.size, 0, 'five days hidden is still a decision for a person');
  assert.equal(env.DB.one('SELECT status FROM locations WHERE id = ?', 'l2').status, 'published',
    'and the record is never written either');
});

// ------------------------------------------------------------- wastebinned ---

test('a deleted mod is confirmed in three sweeps and its pin is withheld', async () => {
  const env = envWith();
  const early = await sweeps(env, {
    states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS - 1, gap: 5 * MIN,
  });
  assert.deepEqual(early.modStatus.flagged, []);
  assert.equal((await readWithheld(env)).withhold.size, 0, 'not confirmed yet, so the pin stays');

  await sweeps(env, {
    states: { ...ALL_OK, 200: WASTEBINNED }, count: 1, gap: 5 * MIN,
    from: (CONFIRM_SWEEPS - 1) * 5 * MIN,
  });
  assert.deepEqual([...(await readWithheld(env)).withhold], ['200']);
});

test('the withheld pin is absent from the built dataset, and the row is untouched', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  const { withhold } = await readWithheld(env);

  const rows = env.DB.rows('SELECT * FROM locations');
  const built = materializeFromD1({
    rows, dismissed: [], nexusNodes: [], districts: [], withheld: withhold,
    locationTags: new Map(),
  });

  assert.deepEqual(Object.keys(built.full), ['l1'], "the deleted mod's pin is not served");
  assert.deepEqual(built.meta.withheld, [{ id: 'l2', nexus_id: '200' }],
    'and the build says which, so the dashboard can subtract exactly these');
  assert.equal(env.DB.one('SELECT status FROM locations WHERE id = ?', 'l2').status, 'published',
    'withheld at build time, NOT by writing the record: a reversal needs no human');
});

test('the pin comes back on its own if Nexus publishes the mod again', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  assert.equal((await readWithheld(env)).withhold.size, 1);

  await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN, from: HOUR });
  assert.equal(one(env, '200'), null, 'no row means fine');
  assert.equal((await readWithheld(env)).withhold.size, 0);
});

// ---------------------------------------------------------- the up edge ---
// Withholding reverses itself; a record an admin hid does not. The recovery
// report is the only moment anyone learns the second one can be undone.

test('a mod returning to published is reported, with the pins it affects', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: CONFIRM_SWEEPS, gap: 5 * MIN });

  const back = await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN, from: HOUR });
  assert.equal(back.modStatus.recovered.length, 1);
  assert.equal(back.modStatus.recovered[0].nexus_id, '200');
  assert.equal(back.modStatus.recovered[0].was, 'hidden');
  assert.equal(back.modStatus.recovered[0].wasWithheld, false, 'hidden never withheld it');
  assert.deepEqual(back.modStatus.recovered[0].locations.map((l) => l.name), ['Loc l2'],
    'captured before the row is deleted, or there is nothing left to name');
});

test('a deleted mod returning says its pin was withheld', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  assert.equal((await readWithheld(env)).withhold.size, 1, 'precondition: the pin is down');

  const back = await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN, from: HOUR });
  assert.equal(back.modStatus.recovered[0].wasWithheld, true);
  assert.equal((await readWithheld(env)).withhold.size, 0, 'and it is already restored');
});

test('a mod that was dismissed reports no withholding to undo', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  await setDismissed(env, '200', { actor: 'spuddeh', nowIso: at(HOUR) });

  const back = await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN, from: 2 * HOUR });
  assert.equal(back.modStatus.recovered[0].wasWithheld, false,
    'the admin already put the pin back by hand; there is nothing to restore');
});

test('a one-sweep blink is not a recovery', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: 1, gap: 5 * MIN });
  assert.equal(one(env, '200').flagged_at, null, 'precondition: never confirmed');

  const back = await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN, from: 10 * MIN });
  assert.deepEqual(back.modStatus.recovered, [],
    'announcing noise is how the recoveries that matter get skipped');
  assert.equal(one(env, '200'), null, 'the row still clears');
});

test('the recovery carries the pin an admin hid, so it can be put back', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  // What an admin does about a mod that has gone: pull the pin by hand.
  env.DB._db.prepare('UPDATE locations SET status = ? WHERE id = ?').run('hidden', 'l2');

  const back = await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN, from: HOUR });
  assert.deepEqual(back.modStatus.recovered[0].locations, [
    { id: 'l2', name: 'Loc l2', status: 'hidden' },
  ], 'no sweep will un-hide this, so the report has to say it is still hidden');
  assert.equal(env.DB.one('SELECT status FROM locations WHERE id = ?', 'l2').status, 'hidden',
    'and the recovery must not un-hide it either: that write was a decision');
});

test('a hidden mod that is then deleted starts its run again', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: 5, gap: 5 * MIN });
  assert.equal(one(env, '200').streak, 5);
  assert.ok(one(env, '200').flagged_at, 'precondition: the hidden run was flagged');

  const turn = await sweeps(env, {
    states: { ...ALL_OK, 200: WASTEBINNED }, count: 1, gap: 5 * MIN, from: HOUR,
  });
  const row = one(env, '200');
  assert.equal(row.status, WASTEBINNED);
  assert.equal(row.streak, 1, 'a different status is a different fact');
  assert.equal(row.flagged_at, null, 'and it has not been confirmed as deleted yet');
  assert.deepEqual(turn.modStatus.flagged, []);
  assert.equal((await readWithheld(env)).withhold.size, 0,
    'inheriting the hidden run would withhold a pin on a confirmation it never got');
});

test('no sweep may withhold more than the cap, and it withholds nothing rather than some', async () => {
  const pins = Array.from({ length: MAX_WITHHELD + 3 }, (_, i) => [`l${i}`, String(100 + i)]);
  const env = envWith(pins);
  const states = {};
  for (const [, nx] of pins) states[nx] = WASTEBINNED;

  await sweeps(env, { states, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  assert.equal(tracked(env).length, pins.length, 'all of them are flagged');

  const { withhold, refused } = await readWithheld(env);
  assert.equal(withhold.size, 0, 'a gutted map is worse than a stale pin');
  assert.equal(refused, pins.length, 'and the refusal is reported, not silent');

  const list = await readModStatuses(env);
  assert.ok(list.every((r) => r.withheld === false),
    'the review list must not claim pins are down while the cap is refusing to take them down');
});

// ------------------------------------------------------------------ absent ---
// The only one of the three a Nexus failure can manufacture, so it keeps the
// stricter rule: a streak AND a day.

test('an absent mod needs a day of sweeps, not three', async () => {
  const env = envWith();
  const short = await sweeps(env, {
    states: { 100: 'published' }, count: ABSENT_STREAK + 4, gap: 5 * MIN,
  });
  assert.deepEqual(short.modStatus.flagged, [], 'an hour of silence is not a deletion');
  assert.equal(one(env, '200').status, ABSENT);
  assert.equal(one(env, '200').flagged_at, null);

  const env2 = envWith();
  await sweeps(env2, { states: { 100: 'published' }, count: ABSENT_STREAK, gap: 5 * HOUR });
  assert.ok(one(env2, '200').flagged_at, 'a day of consecutive silence is');
  assert.equal((await readWithheld(env2)).withhold.size, 0, 'and it still does not touch the map');
});

test('two sweeps a day apart are not an absence verdict', async () => {
  const env = envWith();
  const r = await sweeps(env, { states: { 100: 'published' }, count: 2, gap: 25 * HOUR });
  assert.deepEqual(r.modStatus.flagged, [], 'a cron that ran twice has demonstrated nothing');
  assert.equal(one(env, '200').flagged_at, null);
});

// --------------------------------------------------------- untrusted sweeps ---

test('sweepLooksUnreliable: a small absent set is believed, a chunk-shaped one is not', () => {
  assert.equal(sweepLooksUnreliable({ missing: 1, requested: 3 }), false,
    'one deletion out of three pinned mods is 33% and must still count');
  assert.equal(sweepLooksUnreliable({ missing: SWEEP_MIN_SUSPECT - 1, requested: 5 }), false,
    'below the floor is always believed, whatever the ratio');
  assert.equal(sweepLooksUnreliable({ missing: 50, requested: 200 }), true,
    'a whole failed chunk is not fifty deletions');
});

test('a sweep where Nexus returned nothing at all records nothing', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: 2, gap: 5 * MIN });
  assert.equal(one(env, '200').streak, 2);

  const r = await refreshNexusCache(env, { fetchImpl: fakeNexus({ states: {} }), nowIso: at(HOUR) });
  assert.equal(r.stale, true, 'precondition: asked for two, got none');
  assert.equal(r.modStatus.skipped, 'stale');
  assert.equal(one(env, '200').streak, 2, 'a failed sweep must not advance a run');
  assert.equal(one(env, '100'), null, 'and must not invent one for the healthy mod');
});

test('a sweep that reads as a failed chunk records nothing, and keeps the runs it has', async () => {
  const pins = Array.from({ length: 12 }, (_, i) => [`l${i}`, String(100 + i)]);
  const env = envWith(pins);
  const good = {};
  for (const [, nx] of pins) good[nx] = 'published';
  good['111'] = WASTEBINNED;

  await sweeps(env, { states: good, count: 2, gap: 5 * MIN });
  assert.equal(one(env, '111').streak, 2);

  // Nine of twelve ids simply absent: 75% of the request, so a Nexus problem.
  const partial = { 100: 'published', 101: 'published', 102: 'published' };
  const r = await refreshNexusCache(env, {
    fetchImpl: fakeNexus({ states: partial }), nowIso: at(HOUR),
  });
  assert.equal(r.stale, false, 'three came back, so the all-or-nothing guard does not fire');
  assert.equal(r.modStatus.skipped, 'unreliable');
  assert.equal(tracked(env).length, 1, 'nine mods did not vanish at once');
  assert.equal(one(env, '111').streak, 2, 'the real run is frozen, not reset');

  const back = await sweeps(env, { states: good, count: 1, gap: 5 * MIN, from: 2 * HOUR });
  assert.equal(back.modStatus.tracked, 1, 'and it picks up on the next believable sweep');
  assert.equal(one(env, '111').streak, 3);
});

// ---------------------------------------------------------- the review list ---

test('the review list names the pins, including two pins on one mod', async () => {
  const env = envWith([['l1', '100'], ['l2', '200'], ['l3', '200']]);
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: 2, gap: 5 * MIN });

  const list = await readModStatuses(env);
  assert.equal(list.length, 1);
  assert.equal(list[0].nexus_id, '200');
  assert.equal(list[0].mod_name, 'Mod 200', 'the cache keeps the name of a mod that went under');
  assert.deepEqual(list[0].locations.map((l) => l.name).sort(), ['Loc l2', 'Loc l3'],
    'one mod can supply two pins, and both are what the admin has to decide about');
});

test('the review list says outright whether the pin is down', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  const gone = (await readModStatuses(env)).find((r) => r.nexus_id === '200');
  assert.equal(gone.withheld, true);

  const env2 = envWith();
  await sweeps(env2, { states: { ...ALL_OK, 200: 'hidden' }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  const up = (await readModStatuses(env2)).find((r) => r.nexus_id === '200');
  assert.equal(up.withheld, false, 'hidden is flagged, and flagged is not withheld');
});

// -------------------------------------------------------------- dismissal ---

test('dismissing a deleted mod puts its pin back', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  assert.equal((await readWithheld(env)).withhold.size, 1, 'precondition: the pin is down');

  const after = await setDismissed(env, '200', { actor: 'spuddeh', nowIso: at(HOUR) });
  assert.equal(after.dismissed_by, 'spuddeh');
  assert.equal(after.withheld, false);
  assert.equal((await readWithheld(env)).withhold.size, 0,
    'the escape hatch for an admin who thinks Nexus is wrong, or wants the pin up while redirecting it');
});

test('dismissing survives later sweeps and does not stop the count', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  await setDismissed(env, '200', { actor: 'spuddeh', nowIso: at(HOUR) });

  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: 1, gap: 5 * MIN, from: 2 * HOUR });
  const row = one(env, '200');
  assert.equal(row.dismissed_by, 'spuddeh', 'the sweep must not clear a decision a person made');
  assert.equal(row.streak, CONFIRM_SWEEPS + 1, 'and the count keeps running underneath it');
  assert.equal((await readWithheld(env)).withhold.size, 0, 'the pin stays up');
});

test('dismissing an untracked mod is a miss, not a silent success', async () => {
  const env = envWith();
  assert.equal(await setDismissed(env, '999', { actor: 'spuddeh' }), null);
});

test('undismissing takes the pin down again', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: WASTEBINNED }, count: CONFIRM_SWEEPS, gap: 5 * MIN });
  await setDismissed(env, '200', { actor: 'spuddeh', nowIso: at(HOUR) });

  const back = await setDismissed(env, '200', { actor: 'spuddeh', dismissed: false });
  assert.equal(back.dismissed_at, null);
  assert.equal(back.withheld, true);
  assert.deepEqual([...(await readWithheld(env)).withhold], ['200']);
});

// -------------------------------------------------------------- the cache ---

test('the status is cached, so the dashboard and the build read one value', async () => {
  const env = envWith();
  await sweeps(env, { states: { ...ALL_OK, 200: 'hidden' }, count: 1, gap: 5 * MIN });
  assert.equal(env.DB.one('SELECT status FROM nexus_cache WHERE nexus_id = ?', '200').status, 'hidden');
  assert.equal(env.DB.one('SELECT status FROM nexus_cache WHERE nexus_id = ?', '100').status, 'published');
});

test('a status change is a write, and an unchanged sweep still costs nothing', async () => {
  const env = envWith();
  await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN });
  const quiet = await sweeps(env, { states: ALL_OK, count: 1, gap: 5 * MIN, from: 5 * MIN });
  assert.equal(quiet.written, 0, 'the write gate still holds: 288 ticks a day against a 100k cap');

  const changed = await sweeps(env, {
    states: { ...ALL_OK, 200: 'hidden' }, count: 1, gap: 5 * MIN, from: 10 * MIN,
  });
  assert.equal(changed.written, 1, 'a mod going hidden must reach the cache');
});
