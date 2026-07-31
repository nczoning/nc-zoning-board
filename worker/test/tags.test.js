import test from 'node:test';
import assert from 'node:assert/strict';
import { readTags, readLocationTags } from '../src/d1.js';
import { materializeFromD1 } from '../src/materialize.js';

const DISTRICTS = [{
  id: 't', name: 'Testville',
  polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
  subdistricts: [],
}];

function fakeDb({ tags = [], links = [] } = {}) {
  return {
    prepare(sql) {
      return {
        async all() {
          if (sql.includes('FROM location_tags')) return { results: links };
          if (sql.includes('FROM tags')) return { results: tags };
          throw new Error(`unexpected: ${sql}`);
        },
      };
    },
  };
}

const row = (over = {}) => ({
  id: 'a', name: 'Alpha', nexus_id: '1', category: 'other',
  x: 1, y: 2, z: 3, yaw: null, description: 'd', credits: null,
  authors: '["Spud"]', tags: '["legacy-column-value"]',
  source: 'manual', status: 'published',
  created_at: 'x', updated_at: 'x', ...over,
});

const build = (rows, locationTags) => materializeFromD1({
  rows, dismissed: [], tagsDict: {}, nexusNodes: [], districts: DISTRICTS,
  locationTags, nowMs: 0,
}).full;

test('readTags falls back to the slug when no display name is set', async () => {
  const env = {
    DB: fakeDb({
      tags: [
        { slug: 'corpo', name: null, description: 'suits', sort_order: 2 },
        { slug: 'apartment', name: 'Apartment', description: 'a place', sort_order: 1 },
      ],
    }),
  };
  const tags = await readTags(env);
  // The fallback is what lets this ship with no visual change: the site renders
  // the raw slug today, so name===slug reproduces it exactly.
  assert.equal(tags[0].name, 'corpo');
  assert.equal(tags[1].name, 'Apartment');
  assert.deepEqual(Object.keys(tags[0]), ['slug', 'name', 'description', 'sort_order']);
});

test('readLocationTags groups slugs by location', async () => {
  const env = {
    DB: fakeDb({
      links: [
        { location_id: 'a', tag_slug: 'apartment' },
        { location_id: 'a', tag_slug: 'corpo' },
        { location_id: 'b', tag_slug: 'house' },
      ],
    }),
  };
  const map = await readLocationTags(env);
  assert.deepEqual(map.get('a'), ['apartment', 'corpo']);
  assert.deepEqual(map.get('b'), ['house']);
  assert.equal(map.get('missing'), undefined);
});

test('the join is authoritative when supplied, not the legacy column', async () => {
  const full = build([row()], new Map([['a', ['apartment', 'corpo']]]));
  assert.deepEqual(full.a.tags, ['apartment', 'corpo']);
  assert.equal(full.a.tags.includes('legacy-column-value'), false);
});

test('without the join it falls back to the legacy column', async () => {
  // Migration 0002 keeps both in sync on purpose, so the fallback is a
  // transitional path rather than a silent inconsistency.
  const full = build([row()], null);
  assert.deepEqual(full.a.tags, ['legacy-column-value']);
});

test('nczoning is re-added for auto records, and only for those', async () => {
  const full = build(
    [row({ id: 'm', source: 'manual' }), row({ id: 'x', name: 'Zeta', source: 'auto' })],
    new Map([['m', ['apartment']], ['x', ['corpo']]]),
  );
  // It is not a registry row (not in the tags table), so the materializer
  // prepends it exactly as merge.js does for auto entries.
  assert.deepEqual(full.m.tags, ['apartment']);
  assert.deepEqual(full.x.tags, ['nczoning', 'corpo']);
});

test('an auto record whose only tag was nczoning still gets it back', async () => {
  const full = build([row({ id: 'x', source: 'auto' })], new Map()); // no links at all
  assert.deepEqual(full.x.tags, ['nczoning']);
});

test('a location with no tags yields an empty array, not undefined', async () => {
  const full = build([row()], new Map());
  assert.deepEqual(full.a.tags, []);
});
