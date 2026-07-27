import test from 'node:test';
import assert from 'node:assert/strict';
import { signSession, SESSION_COOKIE } from '../src/session.js';
import { _resetTokenCache } from '../src/github-app.js';
import { sqliteD1 } from '../test-support/d1-sqlite.mjs';
import worker from '../src/index.js';

const SECRET = 'admin-test-secret';

// Backed by real SQLite running the real migrations, not a SQL-shape-matching
// mock. The tag routes are mostly claims about CONSTRAINTS -- "delete in use is
// refused", "rename cascades" -- and a mock can only restate the belief it was
// written from. See test-support/d1-sqlite.mjs.

const fakeKv = () => ({ async get() { return null; }, async put() {} });

/**
 * A KV that actually stores, for the tests that run a real refresh through.
 *
 * The discarding KV above is fine for the CRUD tests, which never read back.
 * It is NOT fine for a refresh: runRefresh compares the new content hash
 * against the stored meta, so with a KV that forgets, every rebuild looks like
 * a first one.
 */
function storingKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

const SUBDISTRICTS = {
  districts: [{
    id: 'testville',
    name: 'Testville',
    polygon: [[-9000, -9000], [9000, -9000], [9000, 9000], [-9000, 9000]],
    subdistricts: [],
  }],
};

/**
 * Everything runRefresh reaches for. Mirrors the stub in refresh-d1.test.js.
 *
 * Installed as globalThis.fetch, because admin.js calls `runRefresh(env)`
 * without a fetchImpl. An earlier test in this file replaces globalThis.fetch
 * with a hard failure and does not restore it, so a refresh test that does not
 * set this inherits that and rebuilds "successfully" against nothing.
 */
function refreshFetch() {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/mods.json')) return { ok: true, json: async () => [] };
    if (u.includes('/tags.json')) return { ok: true, json: async () => ({ apartment: 'a place' }) };
    if (u.includes('/excluded_mods.json')) return { ok: true, json: async () => ({}) };
    if (u.includes('/subdistricts.json')) return { ok: true, json: async () => SUBDISTRICTS };
    // Non-fatal by construction in refresh.js: a miss leaves images null.
    if (u.includes('api-router.nexusmods.com')) return { ok: false, status: 503 };
    if (u.includes('file-metadata.nexusmods.com')) return { ok: false, status: 503 };
    if (u.includes('api.nexusmods.com')) {
      const query = init?.body ? JSON.parse(init.body).query : '';
      if (query.includes('modsByUid')) {
        // Answers for the fixture's own mod. An empty answer here would leave
        // nexus_cache with no rows at all, which the D1 build refuses rather
        // than serving every record image-less.
        return { ok: true, json: async () => ({ data: { modsByUid: { nodes: [
          { modId: 12345, name: 'Existing Loft', pictureUrl: 'p', thumbnailUrl: 't', updatedAt: '2026-01-02T00:00:00Z' },
        ] } } }) };
      }
      return { ok: true, json: async () => ({ data: { mods: { nodes: [], totalCount: 0 } } }) };
    }
    if (u.includes('discord')) return { ok: true };
    throw new Error(`unexpected fetch: ${u}`);
  };
}

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

function envFor({
  collab = 1, dataSource = 'mods', locations = [ROW],
  locationTags = [['loc-1', 'apartment']], checkedAt,
} = {}) {
  const user = FRESH_USER(collab);
  if (checkedAt) user.checked_at = checkedAt;
  return {
    SESSION_SECRET: SECRET,
    DATA_SOURCE: dataSource,
    DATASET: fakeKv(),
    DB: sqliteD1({ locations, locationTags, users: [user] }),
  };
}

const locCount = (env) => env.DB.one('SELECT COUNT(*) AS n FROM locations').n;
const auditRows = (env) => env.DB.rows('SELECT * FROM audit_log ORDER BY id');
const tagsOf = (env, id) => env.DB
  .rows('SELECT tag_slug FROM location_tags WHERE location_id = ? ORDER BY tag_slug', id)
  .map((r) => r.tag_slug);

async function authed(url, init = {}) {
  const token = await signSession(SECRET, { sub: 7, login: 'spuddeh', collaborator: true });
  return new Request(url, {
    ...init,
    headers: { Cookie: `${SESSION_COOKIE}=${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

/** Authenticated request helper: `await hit(env, 'POST', '/admin/tags', {...})`. */
async function hit(env, method, path, body, ctx = {}) {
  return worker.fetch(
    await authed(`https://api.nczoning.net${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
}

// `apartment` and `corpo` are real rows from migration 0002's seed.
const VALID = {
  name: 'A New Location', authors: ['Spud'], coordinates: [10, 20, 30],
  nexus_id: '99999', description: 'Brand new.', category: 'other', tags: ['apartment'],
};

// ------------------------------------------------------------------ gate ---

test('every admin route is refused without a session', async () => {
  const env = envFor();
  for (const [method, path] of [
    ['GET', '/admin/locations'], ['POST', '/admin/locations'],
    ['GET', '/admin/locations/loc-1'], ['PATCH', '/admin/locations/loc-1'],
    ['DELETE', '/admin/locations/loc-1'], ['GET', '/admin/audit'],
    ['GET', '/admin/tags'], ['POST', '/admin/tags'],
    ['GET', '/admin/tags/corpo'], ['PATCH', '/admin/tags/corpo'],
    ['DELETE', '/admin/tags/corpo'], ['POST', '/admin/refresh'],
  ]) {
    const res = await worker.fetch(
      new Request(`https://api.nczoning.net${path}`, { method }), env, {},
    );
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('a signed-in NON-collaborator is refused, and writes nothing', async () => {
  const env = envFor({ collab: 0 });
  const res = await hit(env, 'POST', '/admin/locations', VALID);
  assert.equal(res.status, 403);
  assert.equal(locCount(env), 1, 'no row may be created');
  assert.equal(auditRows(env).length, 0, 'no audit row either');
});

test('a non-collaborator cannot mutate tags either', async () => {
  const env = envFor({ collab: 0 });
  const res = await hit(env, 'DELETE', '/admin/tags/photos');
  assert.equal(res.status, 403);
  assert.ok(env.DB.one('SELECT slug FROM tags WHERE slug = ?', 'photos'));
});

test('an indeterminate collaborator check is 503, not 403, and writes nothing', async () => {
  // Stale verdict forces a re-check; make GitHub unreachable.
  const env = envFor({ checkedAt: '2020-01-01T00:00:00Z' });
  _resetTokenCache();
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const res = await hit(env, 'POST', '/admin/locations', VALID);
  assert.equal(res.status, 503);
  assert.equal(auditRows(env).length, 0);
});

// ----------------------------------------------------------------- CRUD ---

test('create: server generates the id and refuses a client-supplied one', async () => {
  const env = envFor();
  const ok = await hit(env, 'POST', '/admin/locations', VALID);
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.match(body.location.id, /^[0-9a-f-]{36}$/);

  const refused = await hit(env, 'POST', '/admin/locations', { ...VALID, id: 'attacker-chosen' });
  assert.equal(refused.status, 422);
});

test('create: invalid input is 422 and writes nothing', async () => {
  const env = envFor();
  const res = await hit(env, 'POST', '/admin/locations', { ...VALID, category: 'nope' });
  assert.equal(res.status, 422);
  assert.equal(locCount(env), 1);
  assert.equal(auditRows(env).length, 0, 'a rejected write must not be audited');
});

test('update: patches only what was sent', async () => {
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/locations/loc-1', { name: 'Renamed Loft' });
  assert.equal(res.status, 200);
  const row = env.DB.one('SELECT * FROM locations WHERE id = ?', 'loc-1');
  assert.equal(row.name, 'Renamed Loft');
  assert.equal(row.category, 'new-location', 'untouched fields must survive');
  assert.notEqual(row.updated_at, '2026-01-01T00:00:00Z', 'updated_at must move');
  assert.deepEqual(tagsOf(env, 'loc-1'), ['apartment'], 'a patch that omits tags must not clear them');
});

test('update: an unknown id is 404, not a silent no-op', async () => {
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/locations/nope', { name: 'Whatever' });
  assert.equal(res.status, 404);
});

test('delete: removes the row and keeps the whole record in the audit entry', async () => {
  const env = envFor();
  const res = await hit(env, 'DELETE', '/admin/locations/loc-1');
  assert.equal(res.status, 200);
  assert.equal(locCount(env), 0);
  const entry = auditRows(env).at(-1);
  assert.equal(entry.action, 'location.delete');
  const before = JSON.parse(entry.before);
  assert.equal(before.name, 'Existing Loft');
  // Snapshotted before the cascade, or the audit row would claim it had none.
  assert.deepEqual(before.tags, ['apartment']);
});

test('delete: the join rows cascade away with the location', async () => {
  const env = envFor();
  await hit(env, 'DELETE', '/admin/locations/loc-1');
  assert.deepEqual(tagsOf(env, 'loc-1'), [], 'ON DELETE CASCADE must clear the join');
});

// ------------------------------------------------------------ at scale ---

test('the list route works at production scale, not just with one record', async () => {
  // This is the bug the whole suite missed. Every other test seeds ONE
  // location, so `IN (?, ?, ...)` never grows past a single placeholder. At
  // the real 297 that exceeds D1's 100-parameter ceiling on every call, and the
  // dashboard renders an empty table behind a misleading CORS error.
  //
  // 150 is enough: the limit is 100, and the point is to cross it, not to
  // reproduce the exact corpus size.
  const many = Array.from({ length: 150 }, (_, i) => ({
    ...ROW,
    id: `loc-${i}`,
    name: `Location ${String(i).padStart(3, '0')}`,
    nexus_id: String(10000 + i),
  }));
  const env = envFor({
    locations: many,
    locationTags: many.map((l) => [l.id, 'apartment']),
  });

  const res = await hit(env, 'GET', '/admin/locations');
  assert.equal(res.status, 200, 'must not throw on a full-size registry');
  const { locations } = await res.json();
  assert.equal(locations.length, 150);
  // And the tags must still be joined correctly for every one of them, not
  // dropped in the name of staying under the limit.
  assert.ok(locations.every((l) => l.tags.length === 1 && l.tags[0] === 'apartment'));
});

test('the single-record route still uses a targeted lookup', async () => {
  const env = envFor();
  const res = await hit(env, 'GET', '/admin/locations/loc-1');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).location.tags, ['apartment']);
});

// ------------------------------------------------- tags on the write path ---

test('a tag edit reaches location_tags, not just the legacy column', async () => {
  // The 4a/4b gap: admin writes set locations.tags, the materializer reads the
  // join. A PATCH that only moved the column returned 200 and changed nothing
  // on the map.
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/locations/loc-1', { tags: ['corpo', 'photos'] });
  assert.equal(res.status, 200);
  assert.deepEqual(tagsOf(env, 'loc-1'), ['corpo', 'photos']);
  assert.deepEqual((await res.json()).location.tags, ['corpo', 'photos']);
});

test('the legacy column is kept byte-compatible with the join', async () => {
  // Migration 0002 is additive so parity can be proven before the column drops.
  // Writing only one of the two would make the gate compare a live column
  // against a frozen one and call the difference a regression.
  const env = envFor();
  await hit(env, 'PATCH', '/admin/locations/loc-1', { tags: ['photos', 'corpo'] });
  const row = env.DB.one('SELECT tags FROM locations WHERE id = ?', 'loc-1');
  assert.deepEqual(JSON.parse(row.tags), ['corpo', 'photos'], 'sorted, matching the join');
});

test('an auto-sourced record keeps the nczoning marker in the legacy column only', async () => {
  const env = envFor({
    locations: [{ ...ROW, id: 'auto-1', source: 'auto', tags: '["nczoning","apartment"]' }],
    locationTags: [['auto-1', 'apartment']],
  });
  await hit(env, 'PATCH', '/admin/locations/auto-1', { tags: ['corpo'] });
  assert.deepEqual(tagsOf(env, 'auto-1'), ['corpo'], 'the marker is not a registry row');
  assert.deepEqual(
    JSON.parse(env.DB.one('SELECT tags FROM locations WHERE id = ?', 'auto-1').tags),
    ['nczoning', 'corpo'],
    'the stored column keeps the shape existing auto rows have',
  );
});

test('a tags-only patch still moves updated_at', async () => {
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/locations/loc-1', { tags: ['corpo'] });
  assert.equal(res.status, 200);
  assert.notEqual(
    env.DB.one('SELECT updated_at FROM locations WHERE id = ?', 'loc-1').updated_at,
    '2026-01-01T00:00:00Z',
  );
});

test('an empty patch is 400, and an empty tag list is not an empty patch', async () => {
  const env = envFor();
  assert.equal((await hit(env, 'PATCH', '/admin/locations/loc-1', {})).status, 400);
  assert.equal((await hit(env, 'PATCH', '/admin/locations/loc-1', { tags: [] })).status, 200);
  assert.deepEqual(tagsOf(env, 'loc-1'), []);
});

test('create attaches the join rows too', async () => {
  const env = envFor();
  const res = await hit(env, 'POST', '/admin/locations', { ...VALID, tags: ['corpo', 'apartment'] });
  const { location } = await res.json();
  assert.deepEqual(tagsOf(env, location.id), ['apartment', 'corpo']);
});

test('tag validation reads the tags TABLE, so a just-created tag is usable at once', async () => {
  // Phase 4a validated against the KV snapshot the cron maintains. Once tags
  // became editable that was wrong: creating a tag then using it would 422
  // until the next materialize.
  const env = envFor();
  const created = await hit(env, 'POST', '/admin/tags', {
    slug: 'rooftop', description: 'Up top.',
  });
  assert.equal(created.status, 201);
  const used = await hit(env, 'PATCH', '/admin/locations/loc-1', { tags: ['rooftop'] });
  assert.equal(used.status, 200, 'a tag created a moment ago must be valid immediately');
  assert.deepEqual(tagsOf(env, 'loc-1'), ['rooftop']);
});

test('an unknown tag is 422 and leaves the existing tags alone', async () => {
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/locations/loc-1', { tags: ['not-a-real-tag'] });
  assert.equal(res.status, 422);
  assert.deepEqual(tagsOf(env, 'loc-1'), ['apartment']);
});

// ------------------------------------------------------------- tag CRUD ---

test('list: every tag comes back with its usage count', async () => {
  const env = envFor();
  const res = await hit(env, 'GET', '/admin/tags');
  assert.equal(res.status, 200);
  const { tags } = await res.json();
  assert.equal(tags.length, 14, 'migration 0002 seeds 14');
  assert.equal(tags.find((t) => t.slug === 'apartment').usage_count, 1);
  assert.equal(tags.find((t) => t.slug === 'corpo').usage_count, 0);
});

test('nczoning is not a tag row and cannot be created', async () => {
  const env = envFor();
  assert.equal(env.DB.one('SELECT slug FROM tags WHERE slug = ?', 'nczoning'), null);
  const res = await hit(env, 'POST', '/admin/tags', {
    slug: 'nczoning', description: 'Trying it on.',
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).errors.join(' '), /reserved/);
  assert.equal(env.DB.one('SELECT slug FROM tags WHERE slug = ?', 'nczoning'), null);
});

test('a tag cannot be renamed INTO the reserved slug either', async () => {
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/tags/corpo', { slug: 'nczoning' });
  assert.equal(res.status, 422);
  assert.ok(env.DB.one('SELECT slug FROM tags WHERE slug = ?', 'corpo'));
});

test('create: a duplicate slug is 409, not a silent overwrite', async () => {
  const env = envFor();
  const res = await hit(env, 'POST', '/admin/tags', {
    slug: 'corpo', description: 'A second one.',
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'tag_exists');
  assert.match(env.DB.one('SELECT description FROM tags WHERE slug = ?', 'corpo').description, /corporate/);
});

test('create: malformed slugs are refused', async () => {
  const env = envFor();
  for (const slug of ['Mixed Case', 'trailing-', '-leading', 'double--hyphen', 'under_score', '']) {
    const res = await hit(env, 'POST', '/admin/tags', { slug, description: 'x' });
    assert.equal(res.status, 422, `slug ${JSON.stringify(slug)} must be refused`);
  }
});

test('update: editing name and description leaves the slug and the links alone', async () => {
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/tags/apartment', {
    name: 'Apartment', description: 'A player housing unit.',
  });
  assert.equal(res.status, 200);
  const tag = env.DB.one('SELECT * FROM tags WHERE slug = ?', 'apartment');
  assert.equal(tag.name, 'Apartment');
  assert.deepEqual(tagsOf(env, 'loc-1'), ['apartment']);
  assert.equal(auditRows(env).at(-1).action, 'tag.update');
});

test('renaming a slug cascades to location_tags', async () => {
  // Proven against SQLite with foreign keys on, which is D1's default. With
  // them off the UPDATE succeeds and every link silently orphans -- the exact
  // failure the cascade_failed guard in admin.js exists to catch.
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/tags/apartment', { slug: 'flat' });
  assert.equal(res.status, 200);
  assert.equal(env.DB.one('SELECT slug FROM tags WHERE slug = ?', 'apartment'), null);
  assert.deepEqual(tagsOf(env, 'loc-1'), ['flat'], 'the link must follow the rename');
  assert.equal(auditRows(env).at(-1).action, 'tag.rename', 'a rename is audited as its own action');
});

test('renaming onto an existing slug is 409, not a merge', async () => {
  const env = envFor();
  const res = await hit(env, 'PATCH', '/admin/tags/apartment', { slug: 'corpo' });
  assert.equal(res.status, 409);
  assert.deepEqual(tagsOf(env, 'loc-1'), ['apartment']);
});

test('deleting a tag that is in use is refused, with the count and the records', async () => {
  const env = envFor();
  const res = await hit(env, 'DELETE', '/admin/tags/apartment');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'tag_in_use');
  assert.equal(body.usage_count, 1);
  assert.deepEqual(body.locations, [{ id: 'loc-1', name: 'Existing Loft' }]);
  assert.ok(env.DB.one('SELECT slug FROM tags WHERE slug = ?', 'apartment'), 'still there');
  assert.deepEqual(tagsOf(env, 'loc-1'), ['apartment'], 'and still attached');
});

test('deleting an unused tag succeeds and is audited', async () => {
  const env = envFor();
  const res = await hit(env, 'DELETE', '/admin/tags/photos');
  assert.equal(res.status, 200);
  assert.equal(env.DB.one('SELECT slug FROM tags WHERE slug = ?', 'photos'), null);
  const entry = auditRows(env).at(-1);
  assert.equal(entry.action, 'tag.delete');
  assert.equal(JSON.parse(entry.before).slug, 'photos');
});

test('detaching then deleting is the two-step path out', async () => {
  const env = envFor();
  assert.equal((await hit(env, 'DELETE', '/admin/tags/apartment')).status, 409);
  assert.equal((await hit(env, 'PATCH', '/admin/locations/loc-1', { tags: [] })).status, 200);
  assert.equal((await hit(env, 'DELETE', '/admin/tags/apartment')).status, 200);
});

test('an unknown tag slug is 404 on read, update and delete', async () => {
  const env = envFor();
  for (const method of ['GET', 'PATCH', 'DELETE']) {
    const res = await hit(env, method, '/admin/tags/nope', method === 'PATCH' ? { name: 'x' } : undefined);
    assert.equal(res.status, 404, method);
  }
});

// ---------------------------------------------------------------- audit ---

test('EVERY successful mutation produces exactly one audit row', async () => {
  // This is the Phase 4 gate, asserted directly -- now including tags.
  const env = envFor();
  const calls = [
    ['POST', '/admin/locations', VALID, 'location.create'],
    ['PATCH', '/admin/locations/loc-1', { name: 'Renamed' }, 'location.update'],
    ['POST', '/admin/tags', { slug: 'rooftop', description: 'Up top.' }, 'tag.create'],
    ['PATCH', '/admin/tags/rooftop', { name: 'Rooftop' }, 'tag.update'],
    ['PATCH', '/admin/tags/rooftop', { slug: 'roofs' }, 'tag.rename'],
    ['DELETE', '/admin/tags/roofs', undefined, 'tag.delete'],
    ['DELETE', '/admin/locations/loc-1', undefined, 'location.delete'],
  ];
  for (const [method, path, body, action] of calls) {
    const before = auditRows(env).length;
    const res = await hit(env, method, path, body);
    assert.ok(res.status < 300, `${method} ${path} -> ${res.status}`);
    const rows = auditRows(env);
    assert.equal(rows.length, before + 1, `${action} must add exactly one row`);
    assert.equal(rows.at(-1).action, action);
    assert.equal(rows.at(-1).actor, 'spuddeh');
  }
});

test('a refused tag delete is NOT audited', async () => {
  const env = envFor();
  await hit(env, 'DELETE', '/admin/tags/apartment');
  assert.equal(auditRows(env).length, 0);
});

test('the audit row records the actor, not a generic "admin"', async () => {
  const env = envFor();
  await hit(env, 'POST', '/admin/locations', VALID);
  assert.equal(auditRows(env).at(-1).actor, 'spuddeh');
});

test('the audit feed comes back newest first', async () => {
  const env = envFor();
  await hit(env, 'POST', '/admin/tags', { slug: 'first-one', description: 'a' });
  await hit(env, 'POST', '/admin/tags', { slug: 'second-one', description: 'b' });
  const { entries } = await (await hit(env, 'GET', '/admin/audit')).json();
  assert.equal(entries[0].target, 'second-one');
});

// ------------------------------------------------- write-through gating ---

test('a write does NOT materialize while DATA_SOURCE is mods', async () => {
  // Otherwise an admin edit would silently overwrite KV with D1-derived data
  // and perform the Phase 2 cutover as a side effect.
  const env = envFor({ dataSource: 'mods' });
  const waited = [];
  await hit(env, 'POST', '/admin/locations', VALID, { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 0, 'must not rebuild KV while mods.json is the source');
});

test('a tag write does NOT materialize while DATA_SOURCE is mods either', async () => {
  const env = envFor({ dataSource: 'mods' });
  const waited = [];
  await hit(env, 'POST', '/admin/tags', { slug: 'rooftop', description: 'Up top.' },
    { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 0);
});

test('a write DOES materialize once DATA_SOURCE is d1', async () => {
  // Asserts KV actually gained the dataset, not merely that waitUntil was
  // handed a promise. materializeAfterWrite catches its own errors, so the
  // bare `await waited[0]` cannot fail: a rebuild that fails on every record
  // satisfies it as readily as one that works.
  const env = refreshableEnv({ dataSource: 'd1' });
  const waited = [];
  await hit(env, 'POST', '/admin/locations', VALID, { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 1, 'the read path must be rebuilt write-through');
  await waited[0];
  assert.ok(env.DATASET._store.size > 0, 'the rebuild must reach KV, not just be scheduled');
});

// ------------------------------------------------------ manual rebuild ---

/** An env whose refresh can actually succeed: storing KV, working fetch. */
function refreshableEnv(opts = {}) {
  const env = envFor(opts);
  env.DATASET = storingKv();
  globalThis.fetch = refreshFetch();
  return env;
}

test('POST /admin/refresh rebuilds and says which source it used', async () => {
  const env = refreshableEnv({ dataSource: 'd1' });
  const res = await hit(env, 'POST', '/admin/refresh');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.refreshed, true);
  assert.equal(body.source, 'd1');
  assert.equal(body.changed, true, 'a first rebuild into an empty KV must write');
  assert.ok(env.DATASET._store.size > 0, 'and the dataset must actually be in KV');
  assert.equal(auditRows(env).at(-1).action, 'dataset.refresh');
});

test('a manual refresh runs even while DATA_SOURCE is mods', async () => {
  // Unlike the write-through materialize, which is skipped there. The gate on
  // that one avoids spending a KV write rebuilding from a source the write did
  // not touch; this route is someone explicitly asking, and runRefresh honours
  // DATA_SOURCE either way, so it cannot flip the cutover.
  const env = refreshableEnv({ dataSource: 'mods' });
  const res = await hit(env, 'POST', '/admin/refresh');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).source, 'mods');
});

test('an unchanged rebuild reports changed:false, which is still a success', async () => {
  const env = refreshableEnv({ dataSource: 'd1' });
  assert.equal((await (await hit(env, 'POST', '/admin/refresh')).json()).changed, true);
  const second = await (await hit(env, 'POST', '/admin/refresh')).json();
  assert.equal(second.refreshed, true);
  assert.equal(second.changed, false, 'the content hash matched, so nothing was rewritten');
});

test('a failed rebuild is a 500 that says so, not a reported success', async () => {
  // runRefresh does NOT throw on failure -- it catches, keeps last-known-good
  // and returns {stale: true}. Reporting success on "it did not throw" would
  // call every failed rebuild a win. An empty registry is the trigger
  // here (readLocationRows refuses to materialize an empty map); the shape of
  // the failure is what matters, not its cause.
  const env = refreshableEnv({ dataSource: 'd1', locations: [], locationTags: [] });
  const res = await hit(env, 'POST', '/admin/refresh');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'refresh_failed');
  assert.match(body.detail, /empty/);
  assert.equal(auditRows(env).length, 0, 'a rebuild that did not happen is not audited');
});

test('a tag write rebuilds the read path too, since /v1/tags serves it', async () => {
  const env = envFor({ dataSource: 'd1' });
  const waited = [];
  await hit(env, 'PATCH', '/admin/tags/corpo', { name: 'Corpo' },
    { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 1);
  await waited[0];
});
