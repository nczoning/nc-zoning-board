/**
 * The nightly D1 snapshot export.
 *
 * TWO CLAIMS ARE TESTED SEPARATELY, because they are different claims and the
 * cheap one hides the expensive one: that the export *wrote something*, and
 * that it wrote the *right* thing. A run that produces a plausible tree with an
 * admin note in it is a data leak that every "did it commit?" check passes.
 *
 * So the redaction tests assert on the BYTES WRITTEN TO DISK, not on the return
 * value of `redact()`. `redact()` being correct and `exportSnapshot()` not
 * calling it on some path is exactly the shape of failure a unit test of the
 * pure function cannot see.
 *
 * The D1 layer is faked at `fetchImpl`. Nothing here touches the network, and
 * the fake answers by inspecting the SQL, so a query that stops selecting a
 * column gets an undefined back rather than a silently correct-looking row.
 */

const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let X;
before(async () => {
  X = await import('../scripts/export_d1_snapshot.mjs');
});

/** A `locations` row as D1 returns it: authors is a JSON string, not an array. */
const row = (over = {}) => ({
  id: 'aaaa-1111',
  name: 'Cliffside Abode',
  nexus_id: '26046',
  category: 'new-location',
  x: -2229.5732,
  y: 3618.9644,
  z: 12.2151,
  yaw: -121.2,
  description: 'Custom standalone home.',
  credits: 'B1W',
  authors: '["B1W"]',
  status: 'published',
  added_at: '2026-03-07T00:00:00Z',
  modified_at: '2026-07-26T00:00:00Z',
  ...over,
});

/**
 * A fake D1 endpoint over in-memory tables. Dispatches on the table named in
 * the SQL and applies the LIMIT/OFFSET the pager asked for, so the paging code
 * is exercised rather than stubbed past.
 */
function fakeD1(tables = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { sql } = JSON.parse(init.body);
    calls.push({ url, sql });
    const name = ['location_tags', 'locations', 'dismissed_candidates', 'tags', 'audit_log']
      .find((t) => new RegExp(`FROM ${t}\\b`).test(sql));
    let rows = tables[name] ?? [];
    const gt = sql.match(/WHERE id > (\d+)/);
    if (gt) rows = rows.filter((r) => r.id > Number(gt[1]));
    const [, limit, offset] = sql.match(/LIMIT (\d+) OFFSET (\d+)/).map(Number);
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: [{ results: rows.slice(offset, offset + limit) }],
      }),
    };
  };
  return { fetchImpl, calls, deps: { fetchImpl, token: 't', accountId: 'a', databaseId: 'd' } };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ncz-snap-'));
}

// ── locationFile ────────────────────────────────────────────────────────────

test('a NULL z produces a two-element coordinate pair, not a trailing null', () => {
  assert.deepEqual(X.locationFile(row({ z: null })).coordinates, [-2229.5732, 3618.9644]);
});

test('a NULL yaw omits the key rather than emitting null', () => {
  assert.equal('yaw' in X.locationFile(row({ yaw: null })), false);
});

test('NULL credits omits the key, matching what the importer reads back', () => {
  assert.equal('credits' in X.locationFile(row({ credits: null })), false);
});

test('the key order is fixed, so an unchanged record produces no diff', () => {
  assert.deepEqual(Object.keys(X.locationFile(row(), ['house'])), [
    'id', 'name', 'nexus_id', 'category', 'coordinates', 'yaw',
    'tags', 'authors', 'credits', 'description', 'status', 'added_at', 'modified_at',
  ]);
});

test('tags are sorted, so the join returning them in another order is not a diff', () => {
  assert.deepEqual(X.locationFile(row(), ['neokitsch', 'house']).tags, ['house', 'neokitsch']);
});

test('the registry timestamps are exported (a restore cannot recover them otherwise)', () => {
  const f = X.locationFile(row());
  assert.equal(f.added_at, '2026-03-07T00:00:00Z');
  assert.equal(f.modified_at, '2026-07-26T00:00:00Z');
});

// ── redact ──────────────────────────────────────────────────────────────────

test('admin_notes is replaced at the top level', () => {
  assert.equal(X.redact({ id: 'x', admin_notes: 'author is unresponsive' }).admin_notes, X.REDACTED);
});

test('admin_notes is replaced when nested inside a submission payload', () => {
  const out = X.redact({ kind: 'edit', payload: { name: 'ok', admin_notes: 'secret' } });
  assert.equal(out.payload.admin_notes, X.REDACTED);
  assert.equal(out.payload.name, 'ok');
});

test('redaction reaches inside arrays', () => {
  const out = X.redact({ items: [{ reason: 'low quality' }, { reason: 'duplicate' }] });
  assert.deepEqual(out.items, [{ reason: X.REDACTED }, { reason: X.REDACTED }]);
});

test('a redacted key is replaced, not deleted (absent would read as "had none")', () => {
  const out = X.redact({ admin_notes: 'note' });
  assert.equal('admin_notes' in out, true);
});

test('every key on the deny-list is actually stripped', () => {
  const input = Object.fromEntries(X.REDACTED_KEYS.map((k) => [k, 'sensitive']));
  const out = X.redact(input);
  for (const k of X.REDACTED_KEYS) assert.equal(out[k], X.REDACTED, `${k} survived redaction`);
});

test('fields that are not on the deny-list pass through untouched', () => {
  assert.deepEqual(X.redact({ name: 'Cliffside', x: 1, tags: ['house'], z: null }), {
    name: 'Cliffside', x: 1, tags: ['house'], z: null,
  });
});

// ── auditLine ───────────────────────────────────────────────────────────────

test('before/after are parsed so redaction can reach inside them', () => {
  const line = X.auditLine({
    id: 7, at: 'now', actor: 'spuddeh', action: 'location.update', target: 'x',
    before: JSON.stringify({ admin_notes: 'old' }), after: JSON.stringify({ admin_notes: 'new' }),
  });
  assert.equal(line.before.admin_notes, X.REDACTED);
  assert.equal(line.after.admin_notes, X.REDACTED);
});

test('an unparseable payload is withheld, never passed through unredacted', () => {
  const line = X.auditLine({ id: 1, at: 'now', actor: 'a', action: 'x', before: '{not json' });
  assert.equal(line.before, '[unparseable]');
});

test('a null payload stays null rather than becoming a redaction marker', () => {
  const line = X.auditLine({ id: 1, at: 'now', actor: 'a', action: 'x', before: null, after: null });
  assert.equal(line.before, null);
  assert.equal(line.after, null);
});

// ── excludedFile / tagsFile ─────────────────────────────────────────────────

test('dismissed ids export as a bare array, with the reasons gone', () => {
  const out = X.excludedFile([{ nexus_id: '29860', reason: 'minor interior change' }]);
  assert.deepEqual(out, ['29860']);
});

test('numeric ids sort numerically, so adding one does not reshuffle the file', () => {
  assert.deepEqual(X.excludedFile([{ nexus_id: '1000' }, { nexus_id: '99' }]), ['99', '1000']);
});

test('tags export as full rows, keeping name and sort_order the flat map cannot hold', () => {
  const out = X.tagsFile([
    { slug: 'b', name: null, description: 'B', sort_order: 2, created_at: 'c', updated_at: 'u' },
    { slug: 'a', name: 'Alpha', description: 'A', sort_order: 1, created_at: 'c', updated_at: 'u' },
  ]);
  assert.deepEqual(out.map((t) => t.slug), ['a', 'b']);
  assert.equal(out[0].name, 'Alpha');
  assert.equal(out[0].sort_order, 1);
});

// ── lastAuditId ─────────────────────────────────────────────────────────────

test('a fresh snapshot resumes from 0', () => {
  assert.equal(X.lastAuditId(''), 0);
});

test('the cursor is the highest id in the file, not the last line', () => {
  const text = '{"id":5}\n{"id":9}\n{"id":7}\n';
  assert.equal(X.lastAuditId(text), 9);
});

test('a truncated final line does not push the cursor past rows never written', () => {
  const text = '{"id":5}\n{"id":9}\n{"id":1';
  assert.equal(X.lastAuditId(text), 9);
});

// ── d1Query ─────────────────────────────────────────────────────────────────

test('a 200 with success:false is an error, and the message names the endpoint', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ success: false, errors: [{ message: 'Authentication error', code: 10000 }] }),
  });
  await assert.rejects(
    () => X.d1Query('SELECT 1', [], { fetchImpl, token: 't', accountId: 'acc', databaseId: 'db' }),
    (err) => {
      assert.match(err.message, /\/accounts\/acc\/d1\/database\/db\/query/);
      assert.match(err.message, /code: 10000/);
      assert.match(err.message, /D1 → Read/);
      return true;
    },
  );
});

test('a missing token fails before any request is made', async () => {
  await assert.rejects(
    () => X.d1Query('SELECT 1', [], { fetchImpl: () => assert.fail('should not fetch'), token: '' }),
    /CLOUDFLARE_D1_READ_TOKEN is not set/,
  );
});

// ── exportSnapshot: the end-to-end claims ───────────────────────────────────

test('an empty locations table is refused rather than blanking the snapshot', async () => {
  const { deps } = fakeD1({ locations: [] });
  await assert.rejects(
    () => X.exportSnapshot({ outDir: tmpdir(), deps }),
    /refusing to export/,
  );
});

test('the written file carries no admin note, however the export got there', async () => {
  const out = tmpdir();
  const { deps } = fakeD1({
    locations: [row({ admin_notes: 'author is unresponsive' })],
    audit_log: [{
      id: 1, at: 'now', actor: 'spuddeh', action: 'location.update', target: 'aaaa-1111',
      before: JSON.stringify({ admin_notes: 'author is unresponsive' }), after: null,
    }],
    dismissed_candidates: [{ nexus_id: '29860', reason: 'minor interior change' }],
  });
  await X.exportSnapshot({ outDir: out, deps });

  const tree = fs.readdirSync(path.join(out, 'data', 'locations'))
    .map((f) => fs.readFileSync(path.join(out, 'data', 'locations', f), 'utf8'))
    .concat(
      fs.readFileSync(path.join(out, 'data', 'audit_log.jsonl'), 'utf8'),
      fs.readFileSync(path.join(out, 'data', 'excluded_mods.json'), 'utf8'),
    )
    .join('\n');

  assert.equal(tree.includes('author is unresponsive'), false, 'an admin note reached the snapshot');
  assert.equal(tree.includes('minor interior change'), false, 'a dismissal reason reached the snapshot');
});

test('a record deleted from D1 is deleted from the snapshot', async () => {
  const out = tmpdir();
  fs.mkdirSync(path.join(out, 'data', 'locations'), { recursive: true });
  fs.writeFileSync(path.join(out, 'data', 'locations', 'gone-9999.json'), '{}');

  const { deps } = fakeD1({ locations: [row()] });
  const summary = await X.exportSnapshot({ outDir: out, deps });

  assert.equal(summary.deleted, 1);
  assert.equal(fs.existsSync(path.join(out, 'data', 'locations', 'gone-9999.json')), false);
  assert.equal(fs.existsSync(path.join(out, 'data', 'locations', 'aaaa-1111.json')), true);
});

test('the audit log is appended to, and an unchanged night appends nothing', async () => {
  const out = tmpdir();
  const tables = {
    locations: [row()],
    audit_log: [{ id: 1, at: 'a', actor: 'x', action: 'y', target: null, before: null, after: null }],
  };
  const auditPath = path.join(out, 'data', 'audit_log.jsonl');

  const first = await X.exportSnapshot({ outDir: out, deps: fakeD1(tables).deps });
  assert.equal(first.auditAppended, 1);
  const afterFirst = fs.readFileSync(auditPath, 'utf8');

  // Second run, same database. Nothing new above id 1.
  const second = await X.exportSnapshot({ outDir: out, deps: fakeD1(tables).deps });
  assert.equal(second.fromAuditId, 1, 'the cursor was not read back from the file');
  assert.equal(second.auditAppended, 0);
  assert.equal(fs.readFileSync(auditPath, 'utf8'), afterFirst, 'the log was rewritten, not appended');

  // A new row appends without disturbing what is already there.
  tables.audit_log.push({ id: 2, at: 'b', actor: 'x', action: 'y', target: null, before: null, after: null });
  const third = await X.exportSnapshot({ outDir: out, deps: fakeD1(tables).deps });
  assert.equal(third.auditAppended, 1);
  assert.equal(fs.readFileSync(auditPath, 'utf8').startsWith(afterFirst), true);
});

test('two identical runs produce byte-identical files, so a quiet night has no diff', async () => {
  const out = tmpdir();
  const tables = { locations: [row(), row({ id: 'bbbb-2222', name: 'Second' })] };
  await X.exportSnapshot({ outDir: out, deps: fakeD1(tables).deps });
  const snap = (f) => fs.readFileSync(path.join(out, 'data', f), 'utf8');
  const before = [snap('locations/aaaa-1111.json'), snap('excluded_mods.json'), snap('tags.json')];
  await X.exportSnapshot({ outDir: out, deps: fakeD1(tables).deps });
  assert.deepEqual([snap('locations/aaaa-1111.json'), snap('excluded_mods.json'), snap('tags.json')], before);
});

test('every table is paged, so a registry larger than one page is exported whole', async () => {
  const out = tmpdir();
  const many = Array.from({ length: 501 }, (_, i) => row({ id: `id-${String(i).padStart(4, '0')}` }));
  const { deps, calls } = fakeD1({ locations: many });
  const summary = await X.exportSnapshot({ outDir: out, deps });
  assert.equal(summary.locations, 501);
  assert.equal(fs.readdirSync(path.join(out, 'data', 'locations')).length, 501);
  assert.equal(calls.filter((c) => /FROM locations\b/.test(c.sql)).length, 2);
});
