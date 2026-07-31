import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeFromD1, rowToEntry } from '../src/materialize.js';

// These cover the shapes the Phase 1 parity diff structurally CANNOT reach:
// every record in production today is published, has a Z and (mostly) a yaw, so
// the legacy/edge branches never execute against real data. The parity gate
// proves the happy path on 296 real records; this proves the rest.

const DISTRICTS = [
  {
    id: 50, name: 'Testville',
    polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
    subdistricts: [
      { id: 54, name: 'Little Fixture', polygon: [[0, 0], [500, 0], [500, 500], [0, 500]] },
    ],
  },
];

const TAGS = { apartment: 'a place' };

/** A published row with everything set; override per test. */
const row = (over = {}) => ({
  id: 'aaaa-1111', name: 'Alpha', nexus_id: '12345', category: 'new-location',
  x: 250, y: 250, z: 10, yaw: 90,
  description: 'A record.', credits: 'Thanks',
  authors: '["Spud"]',
  status: 'published',
  admin_notes: null, owner_id: null,
  added_at: '2026-01-01T00:00:00Z', modified_at: '2026-01-01T00:00:00Z',
  ...over,
});

// locationTags is required: the join is the only representation since 0007.
// Defaulted to a map giving every fixture row the same tag, so tests that are
// not about tags do not have to care.
const build = (rows, over = {}) => materializeFromD1({
  rows,
  dismissed: [],
  tagsDict: TAGS,
  nexusNodes: [],
  districts: DISTRICTS,
  locationTags: new Map(rows.map((r) => [r.id, ['apartment']])),
  nowMs: Date.parse('2026-01-10T00:00:00Z'),
  ...over,
});

/** readNexusIndex()'s shape, for the four Nexus-derived fields. */
const index = (entries) => new Map(Object.entries(entries).map(([id, e]) => [id, {
  thumbnailUrl: null, pictureUrl: null, updatedAt: null, archives: [], ...e,
}]));

test('a NULL z rebuilds the legacy 2-element coordinate pair, not [x, y, null]', () => {
  const { full } = build([row({ z: null })]);
  assert.deepEqual(full['aaaa-1111'].coordinates, [250, 250]);
  // The serialised bytes are what the gate compares, so assert those too.
  assert.match(JSON.stringify(full['aaaa-1111']), /"coordinates":\[250,250\]/);
});

test('a NULL yaw omits the key entirely rather than serialising null', () => {
  const { full } = build([row({ yaw: null })]);
  assert.equal('yaw' in full['aaaa-1111'], false);
  assert.equal(JSON.stringify(full['aaaa-1111']).includes('yaw'), false);
});

test('NULL and empty-string credits both omit the key', () => {
  for (const credits of [null, '']) {
    const { full } = build([row({ credits })]);
    assert.equal('credits' in full['aaaa-1111'], false, `credits=${JSON.stringify(credits)}`);
  }
});

test('key order matches merge.js, because the gate compares bytes', () => {
  const { full } = build([row()]);
  assert.deepEqual(Object.keys(full['aaaa-1111']), [
    'id', 'name', 'nexus_id', 'coordinates', 'yaw', 'category', 'tags', 'authors',
    'district', 'subdistrict', 'recently_updated', 'description', 'credits',
    'thumbnail_url', 'picture_url', 'updated_at',
  ]);
});

test('only published rows are served; hidden and draft are withheld', () => {
  const { full } = build([
    row({ id: 'pub', status: 'published' }),
    row({ id: 'hid', status: 'hidden' }),
    row({ id: 'dft', status: 'draft' }),
  ]);
  assert.deepEqual(Object.keys(full), ['pub']);
});

test('records are ordered by name, matching the live array order', () => {
  const { full } = build([
    row({ id: 'c', name: 'Charlie' }),
    row({ id: 'a', name: 'alpha' }),
    row({ id: 'b', name: 'Bravo' }),
  ]);
  assert.deepEqual(Object.values(full).map((r) => r.name), ['alpha', 'Bravo', 'Charlie']);
});

test('nothing auto-publishes: a tagged mod with a valid block is not a location', () => {
  const nexusNodes = [{
    modId: 999, name: 'Brand New Mod', summary: 'shiny',
    description: 'NCZoning:\ncoords=100,100\ncategory=other',
    uploader: { name: 'Someone' },
  }];
  const { full, meta } = build([row()], { nexusNodes });
  assert.deepEqual(Object.keys(full), ['aaaa-1111'], 'must not create a record');
  // A valid block is a candidate, so it is not "skipped" either.
  assert.deepEqual(meta.skipped, []);
});

test('a tagged mod with NO valid block is still surfaced as skipped', () => {
  const nexusNodes = [{ modId: 888, name: 'Mistagged', summary: '', description: 'no block here' }];
  const { meta } = build([row()], { nexusNodes });
  assert.deepEqual(meta.skipped, [{ nexus_id: '888', name: 'Mistagged' }]);
});

test('a dismissed candidate is not even reported as skipped', () => {
  const nexusNodes = [{ modId: 888, name: 'Mistagged', summary: '', description: 'no block' }];
  const { meta } = build([row()], { nexusNodes, dismissed: ['888'] });
  assert.deepEqual(meta.skipped, []);
});

test('an existing record suppresses its own re-creation, and is imaged from the index', () => {
  // The tagged node still names a mod already on the map, and must not create a
  // second record. What it no longer does is supply the images: those come from
  // nexus_cache for every record, tagged or not, so there is one channel and no
  // way for the two to disagree.
  const nexusNodes = [{
    modId: 12345, name: 'Alpha (Nexus page)', summary: 'dup',
    description: 'NCZoning:\ncoords=1,1\ncategory=other',
    pictureUrl: 'node-pic', thumbnailUrl: 'node-thumb', updatedAt: '2026-01-08T00:00:00Z',
    uploader: { name: 'Spud' },
  }];
  const nexusIndex = index({
    12345: { thumbnailUrl: 'thumb', pictureUrl: 'pic', updatedAt: '2026-01-08T00:00:00Z' },
  });
  const { full } = build([row()], { nexusNodes, nexusIndex });
  assert.equal(Object.keys(full).length, 1);
  assert.equal(full['aaaa-1111'].thumbnail_url, 'thumb');
  assert.equal(full['aaaa-1111'].picture_url, 'pic');
  // 2026-01-08 is 2 days before the 2026-01-10 clock, inside the 7-day window.
  assert.equal(full['aaaa-1111'].recently_updated, true);
});

test('a tagged node cannot image a record on its own', () => {
  // Negative control for the test above: the same node, no index entry. If the
  // node channel were still wired up this would leak 'node-thumb'.
  const nexusNodes = [{
    modId: 12345, name: 'Alpha (Nexus page)', summary: '', description: '',
    pictureUrl: 'node-pic', thumbnailUrl: 'node-thumb', uploader: { name: 'Spud' },
  }];
  const { full } = build([row()], { nexusNodes });
  assert.equal(full['aaaa-1111'].thumbnail_url, null);
});

test('recently_updated is false outside the window and for an unknown date', () => {
  const stale = index({ 12345: { updatedAt: '2025-01-01T00:00:00Z' } });
  assert.equal(build([row()], { nexusIndex: stale }).full['aaaa-1111'].recently_updated, false);
  // No index entry at all: updated_at null, so the bool is false rather than
  // NaN-ish.
  assert.equal(build([row()]).full['aaaa-1111'].recently_updated, false);
});

test('a WIP record stays image-less rather than borrowing another mod images', () => {
  // The index is keyed by real mod id and never carries a placeholder (the
  // sweep refuses to write one -- asserted in nexus-cache.test.js), so a WIP
  // record simply misses. The populated 12345 entry is here so a miss is
  // distinguishable from a lookup that finds nothing for anyone.
  const nexusIndex = index({ 12345: { thumbnailUrl: 'thumb' } });
  const nexusNodes = [{
    modId: 'WIP', name: 'nope', summary: '', description: '',
    thumbnailUrl: 'leaked', uploader: { name: 'x' },
  }];
  const { full } = build([row({ nexus_id: 'WIP' })], { nexusNodes, nexusIndex });
  assert.equal(full['aaaa-1111'].thumbnail_url, null);
});

test('rowToEntry parses authors from JSON and takes tags from the join', () => {
  const r = row({ authors: '["A","B"]' });
  const entry = rowToEntry(r, new Map([[r.id, ['x']]]));
  assert.deepEqual(entry.authors, ['A', 'B']);
  assert.deepEqual(entry.tags, ['x'], 'tags come from the join, never from the row');
});

test('rowToEntry tolerates a NULL authors column and a record with no tag links', () => {
  const entry = rowToEntry(row({ authors: null }), new Map());
  assert.deepEqual(entry.authors, []);
  assert.deepEqual(entry.tags, [], 'no join rows is an empty array, not undefined');
});
