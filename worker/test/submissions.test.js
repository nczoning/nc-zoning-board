import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';
import { handleSubmissions, purgeSubmitterIps, RETENTION_DAYS } from '../src/submissions.js';

// The first public write route, so the tests are mostly about what it REFUSES.
// Real SQLite on the real migrations: the rate limit is a COUNT over the table
// it writes to, so a mock that answers by matching SQL fragments would be
// asserting the belief the mock was written from.

const NOW = Date.parse('2026-07-28T00:00:00.000Z');
const IP = '203.0.113.7';

const LOCATION = {
  id: 'loc-1', name: 'Existing Loft', nexus_id: '12345', category: 'new-location',
  x: 1, y: 2, z: 3, yaw: 90, description: 'a place', credits: null,
  authors: '["Spud"]', tags: '["apartment"]', source: 'manual', status: 'published',
  admin_notes: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

/** A payload the shared validator accepts in full. */
const VALID = {
  name: 'Rooftop Bar',
  authors: ['Spud'],
  coordinates: [100, 200, 30],
  nexus_id: '12345',
  description: 'A bar on a roof.',
  category: 'new-location',
  tags: ['apartment'],
};

// `unset` rather than undefined for the two secrets: a default parameter treats
// an explicitly passed undefined as absent, so `envFor({ secret: undefined })`
// would quietly hand back a configured environment and the test would assert
// nothing.
const unset = Symbol('unset');

function envFor({ salt = 'pepper', secret = 'turnstile-secret', locations = [LOCATION] } = {}) {
  const env = { DB: sqliteD1({ locations }) };
  if (salt !== unset) env.SUBMISSION_IP_SALT = salt;
  if (secret !== unset) env.TURNSTILE_SECRET_KEY = secret;
  return env;
}

/** A siteverify stub. `calls` records each verification attempt. */
function turnstile({ success = true, codes = [], transport = 'ok', calls = [] } = {}) {
  const impl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (transport === 'throw') throw new Error('network down');
    if (transport === 'http-error') return { ok: false, status: 500, async json() { return {}; } };
    return { ok: true, async json() { return { success, 'error-codes': codes }; } };
  };
  impl.calls = calls;
  return impl;
}

function post(body, { ip = IP } = {}) {
  return new Request('https://api.nczoning.net/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

const submit = (env, body, opts = {}) => handleSubmissions(
  post(body, opts), env, { fetchImpl: opts.fetchImpl ?? turnstile(), nowMs: opts.nowMs ?? NOW },
);

const rows = (env) => env.DB.rows('SELECT * FROM submissions ORDER BY id');
const audits = (env) => env.DB.rows('SELECT * FROM audit_log ORDER BY id');

// ------------------------------------------------------------ the happy path ---

test('a valid create is queued as pending and nothing reaches the map', async () => {
  const env = envFor();
  const res = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  assert.equal(res.status, 201);

  const body = await res.json();
  assert.equal(body.status, 'pending');
  assert.ok(body.id, 'the submitter needs the id to be told about it later');

  const queued = rows(env);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, 'create');
  assert.equal(JSON.parse(queued[0].payload).name, 'Rooftop Bar');

  assert.equal(
    env.DB.one('SELECT COUNT(*) AS n FROM locations').n, 1,
    'a submission must not publish: the map still holds only the seeded location',
  );
});

test('every accepted submission produces an audit row', async () => {
  const env = envFor();
  await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  const log = audits(env);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'submission.create');
  assert.equal(log[0].actor, 'anonymous');
  assert.equal(log[0].target, String(rows(env)[0].id));
});

test('a refused submission writes neither a row nor an audit entry', async () => {
  const env = envFor();
  const res = await submit(env, { kind: 'create', payload: { name: 'x' }, turnstile_token: 't' });
  assert.equal(res.status, 400);
  assert.equal(rows(env).length, 0);
  assert.equal(audits(env).length, 0, 'the audit log records writes, not attempts');
});

// --------------------------------------------------------- admin-only fields ---

test('admin-only fields are refused rather than dropped', async () => {
  // Dropping them silently would leave an approve path applying a status the
  // submitter chose, and the submitter believing they had set it.
  const env = envFor();
  for (const field of [{ status: 'published' }, { admin_notes: 'let me in' }, { source: 'auto' }]) {
    const res = await submit(env, {
      kind: 'create', payload: { ...VALID, ...field }, turnstile_token: 't',
    });
    const key = Object.keys(field)[0];
    assert.equal(res.status, 400, `${key} must not be accepted`);
    const { errors } = await res.json();
    assert.ok(errors.some((e) => e.startsWith(key)), `the refusal must name ${key}: ${errors}`);
  }
  assert.equal(rows(env).length, 0);
});

// ------------------------------------------------------ the shared validator ---

test('a coordinate outside the terrain extent is refused', async () => {
  const env = envFor();
  const res = await submit(env, {
    kind: 'create', payload: { ...VALID, coordinates: [99999, 0, 0] }, turnstile_token: 't',
  });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => e.includes('coordinate X')), errors.join('; '));
});

test('an unknown tag is refused', async () => {
  const env = envFor();
  const res = await submit(env, {
    kind: 'create', payload: { ...VALID, tags: ['not-a-real-tag'] }, turnstile_token: 't',
  });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => e.includes('unknown tag')), errors.join('; '));
});

// ---------------------------------------------------------------- Turnstile ---

test('a failed Turnstile check is a 403 with a distinct code', async () => {
  const env = envFor();
  const res = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' }, {
    fetchImpl: turnstile({ success: false, codes: ['invalid-input-response'] }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'turnstile_failed');
  assert.equal(rows(env).length, 0);
});

test('an expired or reused token is distinguishable from a refusal', async () => {
  // Tokens are single-use and last five minutes, so a form left open produces
  // this and the modal should re-render the widget rather than accuse anyone.
  const env = envFor();
  const res = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' }, {
    fetchImpl: turnstile({ success: false, codes: ['timeout-or-duplicate'] }),
  });
  assert.equal((await res.json()).error, 'turnstile_expired');
});

test('a missing token never reaches siteverify', async () => {
  const env = envFor();
  const calls = [];
  const res = await submit(env, { kind: 'create', payload: VALID }, {
    fetchImpl: turnstile({ calls }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'turnstile_missing');
  assert.deepEqual(calls, []);
});

test('a siteverify outage fails closed, not open', async () => {
  // A bot check that passes on error is a bot check an attacker triggers on
  // purpose.
  const env = envFor();
  for (const transport of ['throw', 'http-error']) {
    const res = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' }, {
      fetchImpl: turnstile({ transport }),
    });
    assert.equal(res.status, 503, transport);
    assert.equal((await res.json()).error, 'verification_unavailable');
  }
  assert.equal(rows(env).length, 0);
});

test('an unset Turnstile secret closes the route instead of skipping the check', async () => {
  const env = envFor({ secret: unset });
  const res = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  assert.equal(res.status, 503);
  assert.equal(rows(env).length, 0);
});

// ------------------------------------------------------- the submitter's IP ---

test('the address is stored as a salted hash and never in the clear', async () => {
  const env = envFor();
  await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  const stored = rows(env)[0].submitter_ip_hash;
  assert.match(stored, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(rows(env)).includes(IP), false, 'the raw address must appear nowhere');

  // Same address, different salt: a different hash. Without the salt the digest
  // of an IPv4 is reversed by enumerating four billion inputs, so the salt is
  // what makes this a hash rather than a stored address.
  const other = envFor({ salt: 'a-different-salt' });
  await submit(other, { kind: 'create', payload: VALID, turnstile_token: 't' });
  assert.notEqual(rows(other)[0].submitter_ip_hash, stored);
});

test('an unset salt refuses the write rather than storing something weaker', async () => {
  const env = envFor({ salt: unset });
  const res = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'submissions_unavailable');
  assert.equal(rows(env).length, 0);
});

// --------------------------------------------------------------- rate limit ---

test('the rate limit trips, and only accepted submissions count towards it', async () => {
  const env = envFor();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
    assert.equal(res.status, 201, `submission ${i + 1} should be accepted`);
  }
  const blocked = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, 'rate_limited');
  assert.equal(rows(env).length, 5);

  // A different address is unaffected: the limit is per submitter, not global.
  const elsewhere = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' }, { ip: '198.51.100.4' });
  assert.equal(elsewhere.status, 201);
});

test('the window rolls forward', async () => {
  const env = envFor();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  }
  const later = await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' }, {
    nowMs: NOW + 61 * 60 * 1000,
  });
  assert.equal(later.status, 201, 'an hour later the earlier submissions are outside the window');
});

test('a rate-limited request costs no siteverify call', async () => {
  const env = envFor();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  }
  const calls = [];
  await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' }, { fetchImpl: turnstile({ calls }) });
  assert.deepEqual(calls, [], 'a flood must not become a flood of verification requests');
});

// ------------------------------------------------------------- edit / remove ---

test('an edit needs an existing location and at least one field', async () => {
  const env = envFor();
  const missing = await submit(env, {
    kind: 'edit', location_id: 'no-such-id', payload: { yaw: 45 }, turnstile_token: 't',
  });
  assert.equal(missing.status, 400);

  const empty = await submit(env, {
    kind: 'edit', location_id: 'loc-1', payload: {}, turnstile_token: 't',
  });
  assert.equal(empty.status, 400);

  const ok = await submit(env, {
    kind: 'edit', location_id: 'loc-1', payload: { yaw: 45 }, turnstile_token: 't',
  });
  assert.equal(ok.status, 201);
  assert.deepEqual(JSON.parse(rows(env)[0].payload), { yaw: 45 },
    'only the changed field is queued, so the reviewer sees a diff rather than a restatement');
});

test('an edit is validated partially, but still validated', async () => {
  const env = envFor();
  const res = await submit(env, {
    kind: 'edit', location_id: 'loc-1', payload: { coordinates: [0, 0, 99999] }, turnstile_token: 't',
  });
  assert.equal(res.status, 400);
  const { errors } = await res.json();
  assert.ok(errors.some((e) => e.includes('coordinate Z')), errors.join('; '));
});

test('a removal needs a reason and carries no payload', async () => {
  const env = envFor();
  const noReason = await submit(env, { kind: 'remove', location_id: 'loc-1', turnstile_token: 't' });
  assert.equal(noReason.status, 400);

  const withPayload = await submit(env, {
    kind: 'remove', location_id: 'loc-1', payload: VALID, reason: 'gone from Nexus', turnstile_token: 't',
  });
  assert.equal(withPayload.status, 400, 'there is nothing for a reviewer to apply from a removal payload');

  const ok = await submit(env, {
    kind: 'remove', location_id: 'loc-1', reason: 'gone from Nexus', turnstile_token: 't',
  });
  assert.equal(ok.status, 201);
  assert.equal(JSON.parse(rows(env)[0].payload).reason, 'gone from Nexus');
});

test('an unknown kind is refused before anything else happens', async () => {
  const env = envFor();
  const calls = [];
  const res = await submit(env, { kind: 'publish', payload: VALID, turnstile_token: 't' }, {
    fetchImpl: turnstile({ calls }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_kind');
  assert.deepEqual(calls, []);
});

// ------------------------------------------------------------------- limits ---

test('a large payload binds a constant number of parameters', async () => {
  // D1 refuses more than 100 bound parameters, and the harness enforces it. The
  // payload is bound as ONE json string rather than a placeholder per field, so
  // a submission with many fields cannot approach the ceiling; a future change
  // that spreads the payload across columns would fail here.
  const env = envFor();
  const wide = {
    ...VALID,
    authors: Array.from({ length: 60 }, (_, i) => `Author ${i}`),
    description: 'x'.repeat(500),
  };
  const res = await submit(env, { kind: 'create', payload: wide, turnstile_token: 't' });
  assert.equal(res.status, 201);
  assert.equal(JSON.parse(rows(env)[0].payload).authors.length, 60);
});

// --------------------------------------------------------------- candidates ---

test('candidates come from nexus_cache, not from a live Nexus call', async () => {
  const env = envFor();
  env.DB._db.prepare(
    `INSERT INTO nexus_cache (nexus_id, name, thumbnail_url, nczoning_tagged, fetched_at)
     VALUES (?, ?, ?, 1, ?)`,
  ).run('900', 'Tagged Not Mapped', 'thumb', '2026-07-27T00:00:00Z');
  env.DB._db.prepare(
    `INSERT INTO nexus_cache (nexus_id, name, nczoning_tagged, fetched_at)
     VALUES (?, ?, 1, ?)`,
  ).run('12345', 'Already A Location', '2026-07-27T00:00:00Z');

  const res = await handleSubmissions(
    new Request('https://api.nczoning.net/submissions/candidates'), env, {},
  );
  assert.equal(res.status, 200);
  const { candidates } = await res.json();
  assert.deepEqual(candidates.map((c) => c.nexus_id), ['900'],
    '12345 is already on the map, so it is not a candidate');
});

test('the candidates route refuses a write, and the submit route refuses a read', async () => {
  const env = envFor();
  const written = await handleSubmissions(
    new Request('https://api.nczoning.net/submissions/candidates', { method: 'POST' }), env, {},
  );
  assert.equal(written.status, 405);

  const read = await handleSubmissions(
    new Request('https://api.nczoning.net/submissions'), env, {},
  );
  assert.equal(read.status, 405);
});

test('an unknown path under the prefix is a 404, not a fall-through', async () => {
  const env = envFor();
  const res = await handleSubmissions(
    new Request('https://api.nczoning.net/submissions/approve', { method: 'POST' }), env, {},
  );
  assert.equal(res.status, 404);
});

test('a path outside the prefix is left alone', async () => {
  const env = envFor();
  assert.equal(
    await handleSubmissions(new Request('https://api.nczoning.net/v1/locations'), env, {}),
    null,
    'returning a response here would swallow every other route',
  );
});

// ---------------------------------------------------------------- retention ---

test('hashed addresses are cleared after the retention window, and the row is kept', async () => {
  const env = envFor();
  await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  const old = NOW - (RETENTION_DAYS + 1) * 86400000;
  await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' }, { nowMs: old, ip: '198.51.100.9' });

  const cleared = await purgeSubmitterIps(env, NOW);
  assert.equal(cleared, 1);

  const after = rows(env);
  assert.equal(after.length, 2, 'the queue itself is untouched');
  assert.equal(after.filter((r) => r.submitter_ip_hash === null).length, 1);
  assert.ok(after.find((r) => r.submitter_ip_hash !== null), 'a recent submission keeps its hash');
});

test('a purge with nothing to clear writes nothing', async () => {
  const env = envFor();
  await submit(env, { kind: 'create', payload: VALID, turnstile_token: 't' });
  assert.equal(await purgeSubmitterIps(env, NOW), 0);
});
