import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateLocationInput, CATEGORIES } from '../src/validate.js';
import {
  TERRAIN_MIN_X, TERRAIN_MAX_X, TERRAIN_MIN_Y, TERRAIN_MAX_Y, COORD_Z_MIN, COORD_Z_MAX,
} from '../src/config.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(fs.readFileSync(path.join(REPO, 'mods.schema.json'), 'utf8'));
const tagsDict = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'tags.json'), 'utf8'));
const TAG_NAMES = new Set(Object.keys(tagsDict));

// The file schema describes an ARRAY of locations; the write path validates one.
const ajv = new Ajv({ allErrors: true });
const ajvValidateOne = ajv.compile(schema.items);

const RECORDS = fs.readdirSync(path.join(REPO, 'data', 'locations'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'locations', f), 'utf8')));

/** The write path never accepts `id`; strip it before comparing. */
const asInput = (rec) => { const { id, ...rest } = rec; return rest; };

// ---------------------------------------------------------------------------
// This is the link between validate.js and mods.schema.json. validate.js is
// hand-rolled because ajv cannot run in a Worker, so nothing *imports* the
// schema at runtime. These tests are what stop the two drifting apart: change
// the schema without changing validate.js and they fail.
// ---------------------------------------------------------------------------

test('every live record is accepted by BOTH ajv and validate.js', () => {
  assert.ok(RECORDS.length > 200, `expected the real corpus, got ${RECORDS.length}`);
  for (const rec of RECORDS) {
    assert.equal(ajvValidateOne(rec), true, `ajv rejected ${rec.id}: ${ajv.errorsText(ajvValidateOne.errors)}`);
    const mine = validateLocationInput(asInput(rec), { tagNames: TAG_NAMES });
    assert.equal(mine.ok, true, `validate.js rejected ${rec.id}: ${mine.errors.join('; ')}`);
  }
});

// Each mutation must be rejected by both. If ajv accepts one, the mutation is
// not actually invalid and the case is wrong — asserted explicitly so a
// mis-written test cannot pass by accident.
const MUTATIONS = [
  ['name too short', (r) => ({ ...r, name: 'ab' })],
  ['name not a string', (r) => ({ ...r, name: 42 })],
  ['authors empty', (r) => ({ ...r, authors: [] })],
  ['authors not strings', (r) => ({ ...r, authors: [1, 2] })],
  ['category unknown', (r) => ({ ...r, category: 'not-a-category' })],
  ['coordinates too long', (r) => ({ ...r, coordinates: [1, 2, 3, 4] })],
  ['coordinates too short', (r) => ({ ...r, coordinates: [1] })],
  ['coordinates not numbers', (r) => ({ ...r, coordinates: ['1', '2', '3'] })],
  ['nexus_id malformed', (r) => ({ ...r, nexus_id: 'not-an-id' })],
  ['description over 500', (r) => ({ ...r, description: 'x'.repeat(501) })],
  ['tags not an array', (r) => ({ ...r, tags: 'apartment' })],
  ['missing category', (r) => { const { category, ...rest } = r; return rest; }],
  ['missing name', (r) => { const { name, ...rest } = r; return rest; }],
];

for (const [label, mutate] of MUTATIONS) {
  test(`both reject: ${label}`, () => {
    const bad = mutate(RECORDS[0]);
    assert.equal(ajvValidateOne(bad), false, `ajv ACCEPTED "${label}" — the case is not actually invalid`);
    const mine = validateLocationInput(asInput(bad), { tagNames: TAG_NAMES });
    assert.equal(mine.ok, false, `validate.js accepted "${label}"`);
    assert.ok(mine.errors.length > 0);
  });
}

test('the category list matches the schema exactly', () => {
  // Catches a category added to one and not the other, which the corpus above
  // would not notice until a record actually used it.
  assert.deepEqual(CATEGORIES, schema.items.properties.category.enum);
});

test('the required field list matches the schema, minus the server-generated id', () => {
  const schemaRequired = schema.items.required.filter((f) => f !== 'id');
  for (const field of schemaRequired) {
    const { [field]: _, ...without } = asInput(RECORDS[0]);
    const mine = validateLocationInput(without, { tagNames: TAG_NAMES });
    assert.equal(mine.ok, false, `validate.js allowed a record with no ${field}`);
  }
});

// ------------------------------------------- write-path-only rules (no ajv) ---

test('id is refused rather than ignored', () => {
  const r = validateLocationInput({ ...asInput(RECORDS[0]), id: 'attacker-chosen' }, { tagNames: TAG_NAMES });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /id cannot be set/);
});

test('an unknown field is an error, not silently dropped', () => {
  // A typo'd field name that is discarded looks exactly like a successful save.
  const r = validateLocationInput({ ...asInput(RECORDS[0]), coordinats: [1, 2, 3] }, { tagNames: TAG_NAMES });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /unknown field: coordinats/);
});

test('unknown tags are rejected for an admin, unlike auto-discovery', () => {
  const r = validateLocationInput(
    { ...asInput(RECORDS[0]), tags: ['apartment', 'not-a-real-tag'] },
    { tagNames: TAG_NAMES },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /unknown tag\(s\): not-a-real-tag/);
});

test('admin-only fields are accepted, and validated', () => {
  const base = asInput(RECORDS[0]);
  assert.equal(validateLocationInput({ ...base, status: 'hidden', admin_notes: 'note' }, { tagNames: TAG_NAMES }).ok, true);
  assert.equal(validateLocationInput({ ...base, status: 'deleted' }, { tagNames: TAG_NAMES }).ok, false);
});

test('partial mode skips the required set but still validates what is present', () => {
  assert.equal(validateLocationInput({ name: 'A new name' }, { tagNames: TAG_NAMES, partial: true }).ok, true);
  assert.equal(validateLocationInput({ name: 'ab' }, { tagNames: TAG_NAMES, partial: true }).ok, false);
  // ...and an empty patch is not an error, just a no-op the route rejects.
  assert.equal(validateLocationInput({}, { tagNames: TAG_NAMES, partial: true }).ok, true);
});

test('non-finite coordinates are rejected', () => {
  for (const bad of [[1, 2, NaN], [Infinity, 2, 3]]) {
    const r = validateLocationInput({ ...asInput(RECORDS[0]), coordinates: bad }, { tagNames: TAG_NAMES });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
});

// ------------------------------------------------------- coordinate range ---
// ajv has no opinion here: `mods.schema.json` never carried a range, so these
// are write-path-only. The rule lived in the browser until Phase 5, which was
// survivable while every writer was an authenticated collaborator and stops
// being so the moment /submissions accepts anonymous writes.

test('coordinates outside the world bounds are rejected', () => {
  const base = asInput(RECORDS[0]);
  const cases = [
    ['X below min', [TERRAIN_MIN_X - 1, 0, 0], /coordinate X/],
    ['X above max', [TERRAIN_MAX_X + 1, 0, 0], /coordinate X/],
    ['Y below min', [0, TERRAIN_MIN_Y - 1, 0], /coordinate Y/],
    ['Y above max', [0, TERRAIN_MAX_Y + 1, 0], /coordinate Y/],
    ['Z below min', [0, 0, COORD_Z_MIN - 1], /coordinate Z/],
    ['Z above max', [0, 0, COORD_Z_MAX + 1], /coordinate Z/],
    ['a pasted nonsense value', [999999, 999999, 999999], /coordinate/],
  ];
  for (const [label, coordinates, pattern] of cases) {
    const r = validateLocationInput({ ...base, coordinates }, { tagNames: TAG_NAMES });
    assert.equal(r.ok, false, `accepted ${label}: ${JSON.stringify(coordinates)}`);
    assert.match(r.errors.join(' '), pattern, label);
  }
});

test('the bounds admit the real corpus, including its four extremes', () => {
  // These four sit outside the browser form's +/-5000 X/Y and +/-1000 Z, so
  // they are what stops those numbers being adopted here. Named individually
  // rather than left to the corpus-wide loop, which would still pass if it
  // silently stopped covering them.
  const extremes = [
    ['Sea Wall Towers Detailed', -5782.011, 1781.279, 195.898],
    ['Outdoor V - Canyon Forest', 5321.252, -226.151, 99.817],
    ['Forest Canyon Campsite', 5320.874, -240.78528, 97.97386],
    ['Crystal Palace Resort', 322.9296, -1017.5965, 1524.5823],
  ];
  for (const [name, x, y, z] of extremes) {
    const inCorpus = RECORDS.find((r) => r.name === name);
    assert.ok(inCorpus, `${name} has left data/locations, so this test no longer guards anything`);
    assert.deepEqual(
      inCorpus.coordinates.map(Number), [x, y, z],
      `${name} moved; re-measure the bounds rather than editing this expectation`,
    );
    const r = validateLocationInput({ ...asInput(inCorpus) }, { tagNames: TAG_NAMES });
    assert.equal(r.ok, true, `bounds reject the live record ${name}: ${r.errors.join('; ')}`);
  }
});

test('partial mode still range-checks coordinates that are present', () => {
  const ok = validateLocationInput({ coordinates: [0, 0, 0] }, { tagNames: TAG_NAMES, partial: true });
  assert.equal(ok.ok, true);
  const bad = validateLocationInput({ coordinates: [999999, 0, 0] }, { tagNames: TAG_NAMES, partial: true });
  assert.equal(bad.ok, false, 'a PATCH could smuggle an out-of-range coordinate past the check');
});

test('a two-element coordinate skips the Z check rather than reading undefined', () => {
  // [X, Y] is still valid input. Reading c[2] as a number here would compare
  // undefined against the bounds and quietly pass, or throw, depending on order.
  const r = validateLocationInput(
    { ...asInput(RECORDS[0]), coordinates: [0, 0] }, { tagNames: TAG_NAMES },
  );
  assert.equal(r.ok, true, r.errors.join('; '));
});
