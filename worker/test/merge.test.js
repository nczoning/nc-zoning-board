import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDataset } from '../src/merge.js';

// One square district (0,0)-(1000,1000) with a subdistrict in its SW quarter.
const DISTRICTS = [
  {
    id: 50, name: 'Testville',
    polygon: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]],
    subdistricts: [
      { id: 54, name: 'Little Fixture', polygon: [[0, 0], [500, 0], [500, 500], [0, 500]] },
    ],
  },
];

const TAGS = { apartment: 'a place', corpo: 'suits' };

const MANUAL = [
  {
    id: 'aaaa-1111', name: 'Zeta Manual Loft', authors: ['Spud'],
    coordinates: [250, 250, 10], yaw: 90, nexus_id: '12345',
    description: 'A manual entry.', category: 'new-location', tags: ['apartment'],
  },
  {
    id: 'bbbb-2222', name: 'Alpha WIP Spot', authors: ['Spud'],
    coordinates: [750, 750], nexus_id: 'WIP',
    description: 'Not on Nexus yet.', category: 'other', tags: [],
  },
];

const NODES = [
  { // duplicate of the manual entry — must only contribute thumbs
    modId: 12345, name: 'Zeta Manual Loft (Nexus page)', summary: 'dup',
    description: 'NCZoning:\ncoords=1,1\ncategory=other',
    pictureUrl: 'pic-dup', thumbnailUrl: 'thumb-dup', updatedAt: '2026-07-01',
    uploader: { name: 'Spud' },
  },
  { // excluded — never appears even with a valid block
    modId: 777, name: 'Mistagged Mod', summary: 'oops',
    description: 'NCZoning:\ncoords=2,2\ncategory=other',
    uploader: { name: 'Someone' },
  },
  { // valid auto-discovered mod
    modId: 888, name: 'Mango Auto Bar', summary: 'An auto entry.',
    description: '[code]NCZoning:\ncoords=600,600,5\nyaw=45\ncategory=location-overhaul\ntags=corpo,bogus\ncredits=Team X\nauthors=Friend[/code]',
    pictureUrl: 'pic-888', thumbnailUrl: 'thumb-888', updatedAt: '2026-07-02',
    uploader: { name: 'Uploader888' },
  },
  { // tagged but no valid block — skipped, surfaced in meta
    modId: 999, name: 'Blockless Mod', summary: 'no block',
    description: 'Just prose.', uploader: { name: 'Nobody' },
  },
];

const dataset = buildDataset({
  manualMods: MANUAL,
  tagsDict: TAGS,
  excluded: { 777: 'tagged by mistake' },
  nexusNodes: NODES,
  districts: DISTRICTS,
});
// The list endpoint serves the values of `full` (one representation, sorted).
const LOCS = Object.values(dataset.full);

test('merges manual + auto with exclusions and duplicates handled', () => {
  assert.equal(LOCS.length, 3); // 2 manual + 1 auto
  const ids = LOCS.map((l) => l.id);
  assert.ok(ids.includes('nexus-888'), 'stable nexus-<id> for auto entries');
  assert.ok(!ids.some((id) => id.includes('777')), 'excluded mod absent');
});

test('sorted alphabetically by name', () => {
  const names = LOCS.map((l) => l.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('manual entry wins by nexus_id; node contributes thumbnail backfill', () => {
  const zeta = dataset.full['aaaa-1111'];
  assert.equal(zeta.name, 'Zeta Manual Loft'); // manual name, not the Nexus page name
  assert.equal(zeta.source, 'manual');
  assert.deepEqual(dataset.meta.nexus_thumbs['12345'], {
    pictureUrl: 'pic-dup', thumbnailUrl: 'thumb-dup', updatedAt: '2026-07-01',
  });
});

test('manual full entry carries images from the tagged-query backfill', () => {
  const full = dataset.full['aaaa-1111']; // nexus_id 12345, also a tagged node
  assert.equal(full.thumbnail_url, 'thumb-dup');
  assert.equal(full.picture_url, 'pic-dup');
  assert.equal(full.updated_at, '2026-07-01');
});

test('WIP manual entry resolves to null images (shape stays stable)', () => {
  const full = dataset.full['bbbb-2222']; // nexus_id WIP — no Nexus page
  assert.equal(full.thumbnail_url, null);
  assert.equal(full.picture_url, null);
  assert.equal(full.updated_at, null);
});

test('manualThumbs backfills manual mods that are not NCZoning-tagged (modsByUid path)', () => {
  const ds = buildDataset({
    manualMods: MANUAL, tagsDict: TAGS, excluded: { 777: 'x' },
    nexusNodes: [], districts: DISTRICTS, // no tagged nodes → images can only come from modsByUid
    manualThumbs: { 12345: { pictureUrl: 'p-mbu', thumbnailUrl: 't-mbu', updatedAt: '2026-07-09' } },
  });
  const full = ds.full['aaaa-1111'];
  assert.equal(full.thumbnail_url, 't-mbu');
  assert.equal(full.updated_at, '2026-07-09');
});

test('auto entry: authors, tags (nczoning + known only), yaw, images in full', () => {
  const auto = dataset.full['nexus-888'];
  assert.deepEqual(auto.authors, ['Uploader888', 'Friend']);
  assert.deepEqual(auto.tags, ['nczoning', 'corpo']); // 'bogus' dropped
  assert.equal(auto.yaw, 45);
  assert.equal(auto.source, 'auto');
  assert.equal(auto.credits, 'Team X');
  assert.equal(auto.thumbnail_url, 'thumb-888');
});

test('district enrichment: subdistrict wins inside it, district elsewhere', () => {
  const zeta = dataset.full['aaaa-1111']; // (250,250) in SW quarter
  assert.equal(zeta.district, 'Testville');
  assert.equal(zeta.subdistrict, 'Little Fixture');
  const auto = dataset.full['nexus-888']; // (600,600) outside sub
  assert.equal(auto.district, 'Testville');
  assert.equal(auto.subdistrict, null);
});

test('recently_updated: true inside the window, false outside, false when no date', () => {
  const near = buildDataset({
    manualMods: MANUAL, tagsDict: TAGS, excluded: { 777: 'x' },
    nexusNodes: NODES, districts: DISTRICTS,
    nowMs: Date.parse('2026-07-05T00:00:00Z'), // within 7d of the 2026-07-02 update
  });
  assert.equal(near.full['nexus-888'].recently_updated, true);
  assert.equal(near.full['aaaa-1111'].recently_updated, true); // updated 2026-07-01
  assert.equal(near.full['bbbb-2222'].recently_updated, false); // WIP → no updated_at

  const far = buildDataset({
    manualMods: MANUAL, tagsDict: TAGS, excluded: { 777: 'x' },
    nexusNodes: NODES, districts: DISTRICTS,
    nowMs: Date.parse('2026-09-01T00:00:00Z'), // well past the window
  });
  assert.equal(far.full['nexus-888'].recently_updated, false);
});

test('meta carries only the skipped monitoring list — no aggregate counts', () => {
  assert.ok(!('counts' in dataset.meta), 'aggregate counts removed');
  assert.deepEqual(dataset.meta.skipped, [{ nexus_id: '999', name: 'Blockless Mod' }]);
});

test('every record is the full shape (description present) — no slim variant', () => {
  for (const l of LOCS) assert.ok('description' in l, `${l.id} missing description`);
  assert.equal(dataset.full['aaaa-1111'].description, 'A manual entry.');
});

test('DTO contract: no arrays-of-arrays anywhere in the location payload', () => {
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) {
        assert.ok(!Array.isArray(item), `nested array at ${path}[${i}]`);
        walk(item, `${path}[${i}]`);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) walk(val, `${path}.${k}`);
    }
  };
  walk(LOCS, 'locations');
});
