import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { _resetTokenCache } from '../src/github-app.js';
import worker from '../src/index.js';

const SECRET = 'admin-test-secret';

// Minimal in-memory D1 covering the statements admin.js issues. Rows are kept
// as objects; SQL is matched by shape, which is enough because this file owns
// every statement it has to answer.
function fakeDb({ locations = [], users = [] } = {}) {
  const locs = new Map(locations.map((r) => [r.id, { ...r }]));
  const usersById = new Map(users.map((u) => [u.id, u]));
  const audit = [];
  let auditId = 0;

  return {
    _locations: locs,
    _audit: audit,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          if (sql.includes('FROM users')) return usersById.get(stmt._args[0]) ?? null;
          if (sql.includes('FROM locations WHERE id')) return locs.get(stmt._args[0]) ?? null;
          if (sql.includes('COUNT(*)')) return { n: locs.size };
          throw new Error(`unexpected first(): ${sql}`);
        },
        async all() {
          if (sql.includes('FROM audit_log')) {
            return { results: [...audit].reverse().slice(0, stmt._args[0] ?? 100) };
          }
          if (sql.includes('FROM locations')) return { results: [...locs.values()] };
          if (sql.includes('dismissed_candidates')) return { results: [] };
          throw new Error(`unexpected all(): ${sql}`);
        },
        async run() {
          if (sql.includes('INSERT INTO users')) return;
          if (sql.includes('INSERT INTO audit_log')) {
            const [at, actor, action, target, before, after] = stmt._args;
            auditId += 1;
            audit.push({ id: auditId, at, actor, action, target, before, after });
            return;
          }
          if (sql.includes('INSERT INTO locations')) {
            const c = ['id', 'name', 'nexus_id', 'category', 'x', 'y', 'z', 'yaw', 'description',
              'credits', 'authors', 'tags', 'source', 'status', 'admin_notes', 'created_at', 'updated_at'];
            const row = {};
            c.forEach((k, i) => { row[k] = stmt._args[i]; });
            locs.set(row.id, row);
            return;
          }
          if (sql.startsWith('UPDATE locations')) {
            const id = stmt._args[stmt._args.length - 1];
            const row = locs.get(id);
            const cols = [...sql.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            cols.forEach((col, i) => { row[col] = stmt._args[i]; });
            return;
          }
          if (sql.startsWith('DELETE FROM locations')) { locs.delete(stmt._args[0]); return; }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
}

const fakeKv = (tags = { apartment: 'a place', corpo: 'suits' }) => ({
  async get(key, type) {
    if (key.endsWith(':tags')) return type === 'json' ? tags : JSON.stringify(tags);
    return null;
  },
  async put() {},
});

const ROW = {
  id: 'loc-1', name: 'Existing Loft', nexus_id: '12345', category: 'new-location',
  x: 1, y: 2, z: 3, yaw: 90, description: 'a place', credits: null,
  authors: '["Spud"]', tags: '["apartment"]', source: 'manual', status: 'published',
  admin_notes: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

const FRESH_USER = (collab = 1) => ({
  id: 7, login: 'spuddeh', is_collaborator: collab,
  checked_at: new Date().toISOString(), first_seen_at: '2026-01-01T00:00:00Z',
});

async function envFor({ collab = 1, dataSource = 'mods', locations = [ROW] } = {}) {
  return {
    SESSION_SECRET: SECRET,
    DATA_SOURCE: dataSource,
    DATASET: fakeKv(),
    DB: fakeDb({ locations, users: [FRESH_USER(collab)] }),
  };
}

async function authed(url, init = {}) {
  const token = await signSession(SECRET, { sub: 7, login: 'spuddeh', collaborator: true });
  return new Request(url, {
    ...init,
    headers: { Cookie: `${SESSION_COOKIE}=${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

const VALID = {
  name: 'A New Location', authors: ['Spud'], coordinates: [10, 20, 30],
  nexus_id: '99999', description: 'Brand new.', category: 'other', tags: ['apartment'],
};

// ------------------------------------------------------------------ gate ---

test('every admin route is refused without a session', async () => {
  const env = await envFor();
  for (const [method, path] of [
    ['GET', '/admin/locations'], ['POST', '/admin/locations'],
    ['GET', '/admin/locations/loc-1'], ['PATCH', '/admin/locations/loc-1'],
    ['DELETE', '/admin/locations/loc-1'], ['GET', '/admin/audit'],
  ]) {
    const res = await worker.fetch(
      new Request(`https://api.nczoning.net${path}`, { method }), env, {},
    );
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('a signed-in NON-collaborator is refused, and writes nothing', async () => {
  const env = await envFor({ collab: 0 });
  const res = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify(VALID),
    }), env, {},
  );
  assert.equal(res.status, 403);
  assert.equal(env.DB._locations.size, 1, 'no row may be created');
  assert.equal(env.DB._audit.length, 0, 'no audit row either');
});

test('an indeterminate collaborator check is 503, not 403, and writes nothing', async () => {
  const env = await envFor();
  // Stale verdict forces a re-check; make GitHub unreachable.
  env.DB = fakeDb({
    locations: [ROW],
    users: [{ ...FRESH_USER(), checked_at: '2020-01-01T00:00:00Z' }],
  });
  _resetTokenCache();
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const res = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify(VALID),
    }), env, {},
  );
  assert.equal(res.status, 503);
  assert.equal(env.DB._audit.length, 0);
});

// ----------------------------------------------------------------- CRUD ---

test('create: server generates the id and refuses a client-supplied one', async () => {
  const env = await envFor();
  const ok = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify(VALID),
    }), env, {},
  );
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.match(body.location.id, /^[0-9a-f-]{36}$/);

  const refused = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify({ ...VALID, id: 'attacker-chosen' }),
    }), env, {},
  );
  assert.equal(refused.status, 422);
});

test('create: invalid input is 422 and writes nothing', async () => {
  const env = await envFor();
  const res = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify({ ...VALID, category: 'nope' }),
    }), env, {},
  );
  assert.equal(res.status, 422);
  assert.equal(env.DB._locations.size, 1);
  assert.equal(env.DB._audit.length, 0, 'a rejected write must not be audited');
});

test('update: patches only what was sent', async () => {
  const env = await envFor();
  const res = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations/loc-1', {
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed Loft' }),
    }), env, {},
  );
  assert.equal(res.status, 200);
  const row = env.DB._locations.get('loc-1');
  assert.equal(row.name, 'Renamed Loft');
  assert.equal(row.category, 'new-location', 'untouched fields must survive');
  assert.notEqual(row.updated_at, '2026-01-01T00:00:00Z', 'updated_at must move');
});

test('update: an unknown id is 404, not a silent no-op', async () => {
  const env = await envFor();
  const res = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations/nope', {
      method: 'PATCH', body: JSON.stringify({ name: 'Whatever' }),
    }), env, {},
  );
  assert.equal(res.status, 404);
});

test('delete: removes the row and keeps the whole record in the audit entry', async () => {
  const env = await envFor();
  const res = await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations/loc-1', { method: 'DELETE' }), env, {},
  );
  assert.equal(res.status, 200);
  assert.equal(env.DB._locations.size, 0);
  const entry = env.DB._audit.at(-1);
  assert.equal(entry.action, 'location.delete');
  // Recoverable: the deleted record survives in `before`.
  assert.equal(JSON.parse(entry.before).name, 'Existing Loft');
});

// ---------------------------------------------------------------- audit ---

test('EVERY successful mutation produces exactly one audit row', async () => {
  // This is the Phase 4 gate, asserted directly.
  const env = await envFor();
  const calls = [
    ['POST', '/admin/locations', VALID, 'location.create'],
    ['PATCH', '/admin/locations/loc-1', { name: 'Renamed' }, 'location.update'],
    ['DELETE', '/admin/locations/loc-1', null, 'location.delete'],
  ];
  for (const [method, path, body, action] of calls) {
    const before = env.DB._audit.length;
    const res = await worker.fetch(
      await authed(`https://api.nczoning.net${path}`, {
        method, ...(body ? { body: JSON.stringify(body) } : {}),
      }), env, {},
    );
    assert.ok(res.status < 300, `${method} ${path} -> ${res.status}`);
    assert.equal(env.DB._audit.length, before + 1, `${action} must add exactly one row`);
    assert.equal(env.DB._audit.at(-1).action, action);
    assert.equal(env.DB._audit.at(-1).actor, 'spuddeh');
  }
});

test('the audit row records the actor, not a generic "admin"', async () => {
  const env = await envFor();
  await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify(VALID),
    }), env, {},
  );
  assert.equal(env.DB._audit.at(-1).actor, 'spuddeh');
});

// ------------------------------------------------- write-through gating ---

test('a write does NOT materialize while DATA_SOURCE is mods', async () => {
  // Otherwise an admin edit would silently overwrite KV with D1-derived data
  // and perform the Phase 2 cutover as a side effect.
  const env = await envFor({ dataSource: 'mods' });
  const waited = [];
  await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify(VALID),
    }), env, { waitUntil: (p) => waited.push(p) },
  );
  assert.equal(waited.length, 0, 'must not rebuild KV while mods.json is the source');
});

test('a write DOES materialize once DATA_SOURCE is d1', async () => {
  const env = await envFor({ dataSource: 'd1' });
  const waited = [];
  await worker.fetch(
    await authed('https://api.nczoning.net/admin/locations', {
      method: 'POST', body: JSON.stringify(VALID),
    }), env, { waitUntil: (p) => waited.push(p) },
  );
  assert.equal(waited.length, 1, 'the read path must be rebuilt write-through');
  await waited[0]; // must not reject
});
