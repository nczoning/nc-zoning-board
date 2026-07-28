import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';
import worker from '../src/index.js';

// The review queue, exercised through the real HTTP surface so the collaborator
// gate is part of every case rather than something these tests bypass.
//
// Real SQLite on the real migrations, for the reason admin.test.js gives: the
// claims here are mostly about what the DATABASE ends up holding after a
// resolve, and a mock that answers by matching SQL fragments can only restate
// the belief it was written from.

const SECRET = 'review-test-secret';

const fakeKv = () => ({ async get() { return null; }, async put() {} });

const LOCATION = {
  id: 'loc-1', name: 'Existing Loft', nexus_id: '12345', category: 'new-location',
  x: 1, y: 2, z: 3, yaw: 90, description: 'a place', credits: null,
  authors: '["Spud"]', tags: '["apartment"]', source: 'manual', status: 'published',
  admin_notes: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

const FRESH_USER = (collab = 1) => ({
  id: 7, login: 'spuddeh', is_collaborator: collab,
  checked_at: new Date().toISOString(), first_seen_at: '2026-01-01T00:00:00Z',
});

/** A payload the shared validator accepts in full. */
const VALID = {
  name: 'Rooftop Bar', authors: ['Spud'], coordinates: [100, 200, 30],
  nexus_id: '54321', description: 'A bar on a roof.', category: 'new-location',
  tags: ['apartment'],
};

/** One queued submission. `id` is left to SQLite unless a test pins it. */
const submission = (over = {}) => ({
  kind: 'create',
  location_id: null,
  payload: JSON.stringify(VALID),
  status: 'pending',
  submitter_note: null,
  submitter_contact: null,
  submitter_ip_hash: 'deadbeef',
  created_at: '2026-07-27T00:00:00Z',
  ...over,
});

function envFor({ collab = 1, dataSource = 'mods', locations = [LOCATION], ...seed } = {}) {
  return {
    SESSION_SECRET: SECRET,
    DATA_SOURCE: dataSource,
    DATASET: fakeKv(),
    DB: sqliteD1({
      locations,
      locationTags: [['loc-1', 'apartment']],
      users: [FRESH_USER(collab)],
      ...seed,
    }),
  };
}

async function authed(url, init = {}) {
  const token = await signSession(SECRET, { sub: 7, login: 'spuddeh', collaborator: true });
  return new Request(url, {
    ...init,
    headers: { Cookie: `${SESSION_COOKIE}=${token}`, ...(init.headers || {}) },
  });
}

async function hit(env, method, path, body, ctx = {}) {
  return worker.fetch(
    await authed(`https://api.nczoning.net${path}`, {
      method,
      ...(body === undefined ? {} : {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
    }),
    env,
    ctx,
  );
}

const subRows = (env) => env.DB.rows('SELECT * FROM submissions ORDER BY id');
const locRows = (env) => env.DB.rows('SELECT * FROM locations ORDER BY created_at, id');
const auditRows = (env) => env.DB.rows('SELECT * FROM audit_log ORDER BY id');
const actions = (env) => auditRows(env).map((r) => r.action);
const firstId = (env) => subRows(env)[0].id;

// ------------------------------------------------------------------ gate ---

test('every review route is refused without a session', async () => {
  const env = envFor({ submissions: [submission()] });
  for (const [method, path] of [
    ['GET', '/admin/submissions'],
    ['GET', '/admin/submissions/1'],
    ['POST', '/admin/submissions/1/approve'],
    ['POST', '/admin/submissions/1/reject'],
    ['POST', '/admin/submissions/1/changes'],
    ['GET', '/admin/candidates'],
    ['POST', '/admin/candidates/999'],
    ['DELETE', '/admin/candidates/999'],
  ]) {
    const res = await worker.fetch(
      new Request(`https://api.nczoning.net${path}`, { method }), env, {},
    );
    assert.equal(res.status, 401, `${method} ${path} must require a session`);
  }
  assert.equal(locRows(env).length, 1, 'and nothing may have been written');
  assert.equal(subRows(env)[0].status, 'pending');
});

test('a signed-in non-collaborator is refused, and told apart from unauthenticated', async () => {
  const env = envFor({ collab: 0, submissions: [submission()] });
  const res = await hit(env, 'GET', '/admin/submissions');
  assert.equal(res.status, 403);
});

// ------------------------------------------------------------- the queue ---

test('the queue lists every submission, newest first', async () => {
  const env = envFor({
    submissions: [
      submission({ created_at: '2026-07-20T00:00:00Z' }),
      submission({ created_at: '2026-07-26T00:00:00Z', status: 'rejected' }),
      submission({ created_at: '2026-07-22T00:00:00Z' }),
    ],
  });
  const { submissions } = await (await hit(env, 'GET', '/admin/submissions')).json();
  assert.deepEqual(
    submissions.map((s) => s.created_at),
    ['2026-07-26T00:00:00Z', '2026-07-22T00:00:00Z', '2026-07-20T00:00:00Z'],
  );
  // Resolved rows stay in the list: a reviewer has to be able to see what they
  // decided ten minutes ago, and the panel derives its counts from these rows.
  assert.equal(submissions.filter((s) => s.status === 'rejected').length, 1);
});

test('the queue never returns the submitter IP hash', async () => {
  // It exists for the rate limit and abuse triage (docs/privacy.md). A reviewer
  // has no use for it, and a dashboard that rendered it would put a
  // pseudonymous identifier on screen for every queue item.
  const env = envFor({ submissions: [submission()] });
  const listBody = await (await hit(env, 'GET', '/admin/submissions')).text();
  assert.ok(!listBody.includes('deadbeef'), `the list leaked the hash: ${listBody}`);

  const oneBody = await (await hit(env, 'GET', `/admin/submissions/${firstId(env)}`)).text();
  assert.ok(!oneBody.includes('deadbeef'), `the detail route leaked the hash: ${oneBody}`);
});

test('a malformed payload still renders as a row rather than taking the queue down', async () => {
  const env = envFor({ submissions: [submission({ payload: 'not json at all' })] });
  const res = await hit(env, 'GET', '/admin/submissions');
  assert.equal(res.status, 200);
  const { submissions } = await res.json();
  assert.deepEqual(submissions[0].payload, {});
});

// --------------------------------------------------------------- approve ---

test('approving a create writes the location and resolves the submission', async () => {
  const env = envFor({ submissions: [submission()] });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.submission.status, 'approved');
  assert.equal(body.submission.reviewed_by, 'spuddeh');
  assert.ok(body.submission.reviewed_at, 'a resolved submission records when');
  assert.equal(body.location.name, 'Rooftop Bar');

  const created = locRows(env).find((r) => r.name === 'Rooftop Bar');
  assert.ok(created, 'the location must be in D1');
  assert.equal(created.status, 'published');
  assert.equal(created.source, 'manual');

  // The join, not just the column: resolveTags treats location_tags as
  // authoritative, so a record that only got the column materializes untagged.
  const joined = env.DB.rows(
    'SELECT tag_slug FROM location_tags WHERE location_id = ?', created.id,
  ).map((r) => r.tag_slug);
  assert.deepEqual(joined, ['apartment']);
});

test('an approval audits both the queue move and the registry write', async () => {
  const env = envFor({ submissions: [submission()] });
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`);
  assert.deepEqual(actions(env), ['location.create', 'submission.approve']);
  assert.ok(auditRows(env).every((r) => r.actor === 'spuddeh'),
    'the reviewer owns both rows, not the anonymous submitter');
});

test('approving twice does not create the location twice', async () => {
  // The failure this guards is a double-clicked Approve producing two pins with
  // two ids and nothing to say they came from one submission.
  const env = envFor({ submissions: [submission()] });
  const id = firstId(env);
  assert.equal((await hit(env, 'POST', `/admin/submissions/${id}/approve`)).status, 200);

  const second = await hit(env, 'POST', `/admin/submissions/${id}/approve`);
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error, 'already_resolved');
  assert.equal(locRows(env).filter((r) => r.name === 'Rooftop Bar').length, 1);
});

test('a rejected submission cannot then be approved', async () => {
  const env = envFor({ submissions: [submission()] });
  const id = firstId(env);
  await hit(env, 'POST', `/admin/submissions/${id}/reject`, { reason: 'duplicate' });
  const res = await hit(env, 'POST', `/admin/submissions/${id}/approve`);
  assert.equal(res.status, 409);
  assert.equal(locRows(env).length, 1, 'the map must be untouched');
});

test('approving an edit applies only the fields the submission names', async () => {
  const env = envFor({
    submissions: [submission({
      kind: 'edit', location_id: 'loc-1', payload: JSON.stringify({ yaw: 45 }),
    })],
  });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`);
  assert.equal(res.status, 200);

  const row = locRows(env).find((r) => r.id === 'loc-1');
  assert.equal(row.yaw, 45);
  assert.equal(row.name, 'Existing Loft', 'an unnamed field must not move');
  assert.notEqual(row.updated_at, '2026-01-01T00:00:00Z', 'but updated_at must');
  assert.deepEqual(actions(env), ['location.update', 'submission.approve']);
});

test('approving a removal hides the location and keeps the record', async () => {
  // `hidden` pulls the pin and keeps the row. DELETE is for records that should
  // never have existed, which is not a call a member of the public can make.
  const env = envFor({
    submissions: [submission({
      kind: 'remove', location_id: 'loc-1', payload: JSON.stringify({ reason: 'mod was pulled' }),
    })],
  });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`);
  assert.equal(res.status, 200);

  const rows = locRows(env);
  assert.equal(rows.length, 1, 'the record must survive');
  assert.equal(rows[0].status, 'hidden');
});

test('approval revalidates against the tag registry as it stands now', async () => {
  // A tag can be deleted between submission and review. Applying the payload
  // anyway would write a location whose join rows silently go missing.
  const env = envFor({
    submissions: [submission({ payload: JSON.stringify({ ...VALID, tags: ['ghost-tag'] }) })],
  });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.errors.some((e) => e.includes('ghost-tag')), body.errors?.join('; '));

  assert.equal(subRows(env)[0].status, 'pending',
    'a submission that could not be applied has not been reviewed');
  assert.equal(locRows(env).length, 1);
  assert.equal(auditRows(env).length, 0, 'the audit log records writes, not attempts');
});

test('approving an edit whose location has since been deleted refuses and stays pending', async () => {
  const env = envFor({
    submissions: [submission({
      kind: 'edit', location_id: 'gone', payload: JSON.stringify({ yaw: 10 }),
    })],
  });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'location_missing');
  assert.equal(subRows(env)[0].status, 'pending');
});

// ------------------------------------------- approving by restoring instead ---

/** The resubmission case: the mod's record exists, hidden by an earlier removal. */
const HIDDEN = {
  ...LOCATION, id: 'loc-hidden', name: 'Pulled Loft', nexus_id: '54321', status: 'hidden',
};

const resubmission = () => submission({ payload: JSON.stringify(VALID) });

test('a create for a mod that already has a hidden record can restore it instead', async () => {
  // Approving normally would leave two rows for one pin, one hidden and one
  // published. nexus_id is deliberately one-to-many, so this cannot be refused
  // outright; it is the reviewer's call, and this is the other option.
  const env = envFor({ locations: [LOCATION, HIDDEN], submissions: [resubmission()] });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`,
    { restore_location_id: 'loc-hidden' });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.restored, true, 'the caller has to be able to tell the two grants apart');
  assert.equal(body.submission.status, 'approved', 'the request was granted, so it is approved');

  const rows = locRows(env);
  assert.equal(rows.length, 2, 'no second record may be created');
  assert.equal(rows.find((r) => r.id === 'loc-hidden').status, 'published');
  assert.equal(rows.filter((r) => r.name === 'Rooftop Bar').length, 0);
});

test('restoring keeps the stored record, it does not apply the submitted payload', async () => {
  // The stored record is curated. Overwriting its name and coordinates from an
  // anonymous payload is not a restore.
  const env = envFor({ locations: [LOCATION, HIDDEN], submissions: [resubmission()] });
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`,
    { restore_location_id: 'loc-hidden' });

  const row = locRows(env).find((r) => r.id === 'loc-hidden');
  assert.equal(row.name, 'Pulled Loft', 'the curated name must survive');
  assert.equal(row.x, LOCATION.x, 'and so must the stored coordinates');
});

test('the audit says how the request was granted, not just that it was', async () => {
  const env = envFor({ locations: [LOCATION, HIDDEN], submissions: [resubmission()] });
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`,
    { restore_location_id: 'loc-hidden' });

  const log = auditRows(env);
  assert.deepEqual(log.map((r) => r.action), ['location.update', 'submission.approve']);
  const after = JSON.parse(log.at(-1).after);
  assert.equal(after.granted_by, 'restore');
  assert.equal(after.location_id, 'loc-hidden');
});

test('restoring a record that is not hidden is refused', async () => {
  // A published record needs no restoring, and calling it one would report a
  // grant that changed nothing.
  const env = envFor({ locations: [LOCATION], submissions: [resubmission()] });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`,
    { restore_location_id: 'loc-1' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'not_hidden');
  assert.equal(subRows(env)[0].status, 'pending');
});

test('restoring a record belonging to a different mod is refused', async () => {
  // Matching nexus_id does not prove the right RECORD (one mod, many
  // locations). A mismatch does prove the wrong mod, which is the mistake a
  // reviewer makes by clicking the row above the one they meant.
  const wrongMod = { ...HIDDEN, id: 'loc-other', name: 'Other Mod', nexus_id: '11111' };
  const env = envFor({ locations: [LOCATION, wrongMod], submissions: [resubmission()] });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`,
    { restore_location_id: 'loc-other' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'nexus_id_mismatch');
  assert.equal(locRows(env).find((r) => r.id === 'loc-other').status, 'hidden');
});

test('restoring an unknown location is refused and nothing is created', async () => {
  const env = envFor({ submissions: [resubmission()] });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`,
    { restore_location_id: 'nope' });
  assert.equal(res.status, 409);
  assert.equal(locRows(env).length, 1);
  assert.equal(subRows(env)[0].status, 'pending');
});

test('restore_location_id is refused on anything but approving a create', async () => {
  // An edit and a removal already name the record they act on. Honouring a
  // second id would let one submission resolve by changing another location.
  const env = envFor({
    locations: [LOCATION, HIDDEN],
    submissions: [
      submission({ kind: 'edit', location_id: 'loc-1', payload: JSON.stringify({ yaw: 45 }) }),
      resubmission(),
    ],
  });
  const [edit, create] = subRows(env);

  const onEdit = await hit(env, 'POST', `/admin/submissions/${edit.id}/approve`,
    { restore_location_id: 'loc-hidden' });
  assert.equal(onEdit.status, 400);

  const onReject = await hit(env, 'POST', `/admin/submissions/${create.id}/reject`,
    { reason: 'no', restore_location_id: 'loc-hidden' });
  assert.equal(onReject.status, 400);

  assert.equal(locRows(env).find((r) => r.id === 'loc-hidden').status, 'hidden');
  assert.equal(subRows(env).filter((r) => r.status === 'pending').length, 2);
});

test('a restore materializes, because a record did change', async () => {
  const env = envFor({
    dataSource: 'd1', locations: [LOCATION, HIDDEN], submissions: [resubmission()],
  });
  const waited = [];
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`,
    { restore_location_id: 'loc-hidden' }, { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 1);
});

// ------------------------------------------------- reject / request changes ---

test('a rejection without a reason is refused, and changes nothing', async () => {
  const env = envFor({ submissions: [submission()] });
  for (const body of [undefined, {}, { reason: '   ' }]) {
    const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/reject`, body);
    assert.equal(res.status, 400, `reason ${JSON.stringify(body)} must be refused`);
  }
  assert.equal(subRows(env)[0].status, 'pending');
  assert.equal(auditRows(env).length, 0);
});

test('a rejection records who, when and why', async () => {
  const env = envFor({ submissions: [submission()] });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/reject`,
    { reason: 'the coordinates are inside a building' });
  assert.equal(res.status, 200);

  const row = subRows(env)[0];
  assert.equal(row.status, 'rejected');
  assert.equal(row.reviewed_by, 'spuddeh');
  assert.equal(row.review_note, 'the coordinates are inside a building');
  assert.ok(row.reviewed_at);
  assert.equal(locRows(env).length, 1, 'a rejection touches no location');
  assert.deepEqual(actions(env), ['submission.reject']);
});

test('requesting changes is its own status, not a rejection', async () => {
  const env = envFor({ submissions: [submission()] });
  const res = await hit(env, 'POST', `/admin/submissions/${firstId(env)}/changes`,
    { reason: 'please add a description' });
  assert.equal(res.status, 200);
  assert.equal(subRows(env)[0].status, 'changes_requested');
  assert.deepEqual(actions(env), ['submission.changes_requested']);
});

test('an approval note is optional but is kept when given', async () => {
  const env = envFor({ submissions: [submission()] });
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`, { reason: 'looks right' });
  assert.equal(subRows(env)[0].review_note, 'looks right');
});

test('an unknown submission is a 404, not a silent success', async () => {
  const env = envFor();
  for (const action of ['approve', 'reject', 'changes']) {
    const res = await hit(env, 'POST', `/admin/submissions/999/${action}`, { reason: 'x' });
    assert.equal(res.status, 404, action);
  }
});

// ------------------------------------------------------ write-through gating ---

test('an approval does NOT materialize while DATA_SOURCE is mods', async () => {
  // Same rule as every other admin write: a rebuild here would overwrite KV
  // with D1-derived content and perform the Phase 2 cutover as a side effect.
  const env = envFor({ dataSource: 'mods', submissions: [submission()] });
  const waited = [];
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`, undefined,
    { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 0);
});

test('an approval DOES materialize once DATA_SOURCE is d1', async () => {
  const env = envFor({ dataSource: 'd1', submissions: [submission()] });
  const waited = [];
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/approve`, undefined,
    { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 1, 'an approved change must reach the map write-through');
});

test('a rejection materializes nothing even on d1: no record changed', async () => {
  const env = envFor({ dataSource: 'd1', submissions: [submission()] });
  const waited = [];
  await hit(env, 'POST', `/admin/submissions/${firstId(env)}/reject`, { reason: 'no' },
    { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 0, 'a KV write with nothing to write is a wasted daily quota unit');
});

// ------------------------------------------------------------- candidates ---

const CACHE = [
  { nexus_id: '54321', name: 'Rooftop Bar', thumbnail_url: 't1', nczoning_tagged: 1, fetched_at: 'x' },
  { nexus_id: '77777', name: 'Ghost Tower', thumbnail_url: 't2', nczoning_tagged: 1, fetched_at: 'x' },
  { nexus_id: '12345', name: 'Existing Loft', thumbnail_url: 't3', nczoning_tagged: 1, fetched_at: 'x' },
  { nexus_id: '99999', name: 'Untagged Mod', thumbnail_url: 't4', nczoning_tagged: 0, fetched_at: 'x' },
];

test('candidates are the tagged mods that are neither a location nor dismissed', async () => {
  const env = envFor({
    nexusCache: CACHE,
    dismissed: [{
      nexus_id: '77777', reason: 'not a location mod',
      dismissed_by: 'spuddeh', dismissed_at: '2026-07-01T00:00:00Z',
    }],
  });
  const res = await hit(env, 'GET', '/admin/candidates');
  assert.equal(res.status, 200);
  const body = await res.json();

  // 4 tagged-or-not rows = 3 tagged, minus 1 already a location, minus 1
  // dismissed. The arithmetic has to close, or an empty panel is unreadable.
  assert.deepEqual(body.candidates.map((c) => c.nexus_id), ['54321']);
  assert.deepEqual(body.dismissed.map((d) => d.nexus_id), ['77777']);
  assert.equal(body.dismissed[0].name, 'Ghost Tower', 'the join must name the mod');
});

test('dismissing a candidate removes it from the list and audits who and why', async () => {
  const env = envFor({ nexusCache: CACHE });
  const res = await hit(env, 'POST', '/admin/candidates/54321', { reason: 'texture mod, no pin' });
  assert.equal(res.status, 201);

  // 77777 stays: it is tagged, is not a location, and was not dismissed here.
  const after = await (await hit(env, 'GET', '/admin/candidates')).json();
  assert.deepEqual(after.candidates.map((c) => c.nexus_id), ['77777']);
  assert.equal(after.dismissed[0].reason, 'texture mod, no pin');
  assert.equal(after.dismissed[0].dismissed_by, 'spuddeh');
  assert.deepEqual(actions(env), ['candidate.dismiss']);
});

test('dismissing the same candidate twice is a conflict, not a second row', async () => {
  const env = envFor({ nexusCache: CACHE });
  await hit(env, 'POST', '/admin/candidates/54321', { reason: 'first' });
  const res = await hit(env, 'POST', '/admin/candidates/54321', { reason: 'second' });
  assert.equal(res.status, 409);
  assert.equal(env.DB.one('SELECT COUNT(*) AS n FROM dismissed_candidates').n, 1);
  assert.equal(env.DB.one('SELECT reason FROM dismissed_candidates').reason, 'first',
    'the stored reason must not be overwritten by a refused call');
});

test('a dismissal is reversible, which the Discord alert it replaces was not', async () => {
  const env = envFor({ nexusCache: CACHE });
  await hit(env, 'POST', '/admin/candidates/54321', { reason: 'mistake' });
  const res = await hit(env, 'DELETE', '/admin/candidates/54321');
  assert.equal(res.status, 200);

  // Back in the list, and ordered by name: Ghost Tower before Rooftop Bar.
  const after = await (await hit(env, 'GET', '/admin/candidates')).json();
  assert.deepEqual(after.candidates.map((c) => c.nexus_id), ['77777', '54321']);
  assert.equal(after.dismissed.length, 0);
  assert.deepEqual(actions(env), ['candidate.dismiss', 'candidate.restore']);
});

test('restoring a candidate that was never dismissed is a 404', async () => {
  const env = envFor({ nexusCache: CACHE });
  const res = await hit(env, 'DELETE', '/admin/candidates/54321');
  assert.equal(res.status, 404);
  assert.equal(auditRows(env).length, 0);
});

test('an empty candidates list is a real answer, not a broken query', async () => {
  // Measured on staging: 41 tagged mods = 40 already locations + 1 dismissed, so
  // zero candidates is correct there. This asserts the shape a caller can
  // distinguish, since {"candidates":[]} alone reads the same as "never swept".
  const env = envFor({ nexusCache: [] });
  const body = await (await hit(env, 'GET', '/admin/candidates')).json();
  assert.deepEqual(body, { candidates: [], dismissed: [] });
});

// ------------------------------------------------------------------ shape ---

test('the wrong method on a review route is a 405, never a fall-through', async () => {
  const env = envFor({ submissions: [submission()] });
  for (const [method, path] of [
    ['POST', '/admin/submissions'],
    ['DELETE', '/admin/submissions'],
    ['GET', `/admin/submissions/${firstId(env)}/approve`],
    ['PATCH', '/admin/candidates'],
  ]) {
    const res = await hit(env, method, path);
    assert.equal(res.status, 405, `${method} ${path}`);
  }
});
