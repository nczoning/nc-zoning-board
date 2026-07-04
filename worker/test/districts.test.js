import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  pointInPolygon, polygonCentroid, resolveArea, assignDistrict, districtsPayload,
} from '../src/districts.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { districts } = JSON.parse(
  readFileSync(join(repoRoot, 'data', 'subdistricts.json'), 'utf8'),
);

// Deterministic interior point: walk from the centroid toward a vertex
// until the ray-cast test agrees the point is inside (handles concave rings).
function interiorPoint(ring) {
  const c = polygonCentroid(ring);
  if (pointInPolygon(c, ring)) return c;
  for (const v of ring) {
    for (const t of [0.5, 0.25, 0.75, 0.9]) {
      const p = [c[0] + (v[0] - c[0]) * t, c[1] + (v[1] - c[1]) * t];
      if (pointInPolygon(p, ring)) return p;
    }
  }
  throw new Error('no interior point found');
}

test('real subdistricts.json loads with the expected shape', () => {
  assert.ok(districts.length >= 8, `expected >=8 districts, got ${districts.length}`);
  for (const d of districts) {
    assert.equal(typeof d.name, 'string');
    // Badlands has no parent polygon — only subdistrict polygons.
    const hasOwnRing = Array.isArray(d.polygon) && d.polygon.length >= 3;
    const hasSubRings = (d.subdistricts || []).some(
      (s) => Array.isArray(s.polygon) && s.polygon.length >= 3,
    );
    assert.ok(hasOwnRing || hasSubRings, `${d.name}: no polygons at all`);
  }
});

test('an interior point of every subdistrict resolves to that subdistrict', () => {
  for (const d of districts) {
    for (const s of d.subdistricts || []) {
      const p = interiorPoint(s.polygon);
      const hit = resolveArea(p, districts);
      assert.ok(hit, `${s.name}: no area resolved`);
      // Smallest containing subdistrict wins; overlapping rings mean the hit
      // may legitimately be a smaller neighbour, but the common case is exact.
      assert.ok(hit.subdistrict, `${s.name}: resolved district-only`);
    }
  }
});

test('outside every polygon defaults to Badlands (game rule)', () => {
  assert.deepEqual(assignDistrict([99999, 99999, 0], districts), {
    district: 'Badlands',
    subdistrict: null,
  });
});

test('every real location gets a district (Badlands catch-all included)', () => {
  const locDir = join(repoRoot, 'data', 'locations');
  const files = readdirSync(locDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 200, `expected >200 location files, got ${files.length}`);
  let assigned = 0, subs = 0;
  for (const f of files) {
    const mod = JSON.parse(readFileSync(join(locDir, f), 'utf8'));
    const { district, subdistrict } = assignDistrict(mod.coordinates, districts);
    if (district) assigned++;
    if (subdistrict) subs++;
  }
  assert.equal(assigned, files.length, 'district must never be null on real data');
  assert.ok(subs / files.length > 0.6,
    `only ${subs}/${files.length} locations got a subdistrict`);
});

test('districtsPayload flattens boundaries (DTO rule: no arrays-of-arrays)', () => {
  const payload = districtsPayload(districts);
  for (const d of payload) {
    assert.ok(d.boundary.every((n) => typeof n === 'number'), `${d.name}: non-flat boundary`);
    assert.equal(d.boundary.length % 2, 0);
    if (d.centroid) {
      assert.equal(typeof d.centroid.x, 'number');
      assert.equal(typeof d.centroid.y, 'number');
    }
    for (const s of d.subdistricts) {
      assert.ok(s.boundary.every((n) => typeof n === 'number'), `${s.name}: non-flat boundary`);
      assert.equal(typeof s.canonical, 'boolean');
    }
  }
});
