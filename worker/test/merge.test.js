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

test('merges manual + auto with exclusions and duplicates handled', () => {
  assert.equal(dataset.locations.length, 3); // 2 manual + 1 auto
  const ids = dataset.locations.map((l) => l.id);
  assert.ok(ids.includes('nexus-888'), 'stable nexus-<id> for auto entries');
  assert.ok(!ids.some((id) => id.includes('777')), 'excluded mod absent');
});

test('sorted alphabetically by name', () => {
  const names = dataset.locations.map((l) => l.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('manual entry wins by nexus_id; node contributes thumbnail backfill', () => {
  const zeta = dataset.locations.find((l) => l.nexus_id === '12345');
  assert.equal(zeta.name, 'Zeta Manual Loft'); // manual name, not the Nexus page name
  assert.equal(zeta.source, 'manual');
  assert.deepEqual(dataset.meta.nexus_thumbs['12345'], {
    pictureUrl: 'pic-dup', thumbnailUrl: 'thumb-dup', updatedAt: '2026-07-01',
  });
});

test('auto entry: authors, tags (nczoning + known only), yaw, images in full', () => {
  const auto = dataset.locations.find((l) => l.id === 'nexus-888');
  assert.deepEqual(auto.authors, ['Uploader888', 'Friend']);
  assert.deepEqual(auto.tags, ['nczoning', 'corpo']); // 'bogus' dropped
  assert.equal(auto.yaw, 45);
  assert.equal(auto.source, 'auto');
  const fullAuto = dataset.full['nexus-888'];
  assert.equal(fullAuto.credits, 'Team X');
  assert.equal(fullAuto.thumbnail_url, 'thumb-888');
});

test('district enrichment: subdistrict wins inside it, district elsewhere', () => {
  const zeta = dataset.locations.find((l) => l.id === 'aaaa-1111'); // (250,250) in SW quarter
  assert.equal(zeta.district, 'Testville');
  assert.equal(zeta.subdistrict, 'Little Fixture');
  const auto = dataset.locations.find((l) => l.id === 'nexus-888'); // (600,600) outside sub
  assert.equal(auto.district, 'Testville');
  assert.equal(auto.subdistrict, null);
});

test('meta counts + skipped monitoring list', () => {
  assert.deepEqual(dataset.meta.counts, {
    manual: 2, auto: 1, total: 3,
    per_district: { Testville: 3 },
  });
  assert.deepEqual(dataset.meta.skipped, [{ nexus_id: '999', name: 'Blockless Mod' }]);
});

test('slim entries omit description; full carries it', () => {
  for (const l of dataset.locations) assert.ok(!('description' in l));
  assert.equal(dataset.full['aaaa-1111'].description, 'A manual entry.');
});

test('DTO contract: no arrays-of-arrays anywhere in the slim payload', () => {
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
  walk(dataset.locations, 'locations');
});
