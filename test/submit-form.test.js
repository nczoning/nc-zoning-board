/**
 * The submit form's field rules, as the browser applies them.
 *
 * These are a MIRROR, not the gate. worker/src/validate.js is the enforcement
 * point, because POST /submissions is an anonymous public write and everything
 * here runs in the layer the submitter controls. What this suite proves is that
 * the mirror agrees with it, so a submission the form accepts is one the server
 * accepts too, and a submitter is told inline rather than by a 400.
 *
 * Where a rule is deliberately STRICTER than the server, the test says so and
 * says why: the server also serves the admin editor, which may do things a
 * member of the public may not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNCZ } = require('./helpers/load-browser-globals.js');

const NCZ = loadNCZ();

/** A form filled in correctly. Each test spreads this and breaks one thing. */
const complete = () => ({
  name: 'Cliffside Abode Player Home',
  authors: 'Spuddeh, Akiway',
  description: 'A player home on the cliffs north of the city.',
  x: '-1234.56',
  y: '789.01',
  z: '42.5',
  yaw: '180',
  category: 'new-location',
  tags: ['player-home'],
  credits: 'Original texture by XYZ',
  nexusId: '12345',
  note: '',
  contact: '',
});

test('a complete form produces the payload POST /submissions accepts', () => {
  const { values, errors } = NCZ.collectLocationForm(complete());

  assert.deepEqual(errors, {});
  assert.deepEqual(values, {
    name: 'Cliffside Abode Player Home',
    authors: ['Spuddeh', 'Akiway'],
    description: 'A player home on the cliffs north of the city.',
    coordinates: [-1234.56, 789.01, 42.5],
    yaw: 180,
    category: 'new-location',
    tags: ['player-home'],
    nexus_id: '12345',
    credits: 'Original texture by XYZ',
  });
});

test('the payload carries no key outside the validator writable set', () => {
  // validateLocationInput refuses an unknown key outright rather than dropping
  // it, so one extra field here refuses the whole submission.
  const writable = [
    'name', 'authors', 'credits', 'coordinates', 'yaw', 'nexus_id',
    'description', 'category', 'tags',
  ];
  const { values } = NCZ.collectLocationForm(complete());
  for (const key of Object.keys(values)) {
    assert.ok(writable.includes(key), `payload key not writable server-side: ${key}`);
  }
});

test('the payload carries no admin-only field', () => {
  // status, admin_notes and source are refused by /submissions rather than
  // ignored, so the form must never emit one.
  const { values } = NCZ.collectLocationForm(complete());
  for (const key of ['status', 'admin_notes', 'source', 'id']) {
    assert.ok(!(key in values), `payload must not carry ${key}`);
  }
});

// ── name ──────────────────────────────────────────────────────────────────────

test('a name under three characters is refused, matching the server minimum', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), name: 'AB' });
  assert.match(errors.name, /3 characters/);
});

test('a name is trimmed before it is measured', () => {
  const { values, errors } = NCZ.collectLocationForm({ ...complete(), name: '  Afterlife  ' });
  assert.equal(errors.name, undefined);
  assert.equal(values.name, 'Afterlife');
});

test('whitespace alone is not a name', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), name: '     ' });
  assert.ok(errors.name);
});

// ── authors ───────────────────────────────────────────────────────────────────

test('authors split on commas, trimmed, with the empties dropped', () => {
  const { values } = NCZ.collectLocationForm({ ...complete(), authors: ' Kao , , Aki ,' });
  assert.deepEqual(values.authors, ['Kao', 'Aki']);
});

test('a submission with no author is refused', () => {
  // The server requires a non-empty array, so an empty one is a 400 rather
  // than an anonymous record.
  const { errors } = NCZ.collectLocationForm({ ...complete(), authors: ' , ' });
  assert.ok(errors.authors);
});

// ── description ───────────────────────────────────────────────────────────────

test('a description at the 500 character limit is accepted', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), description: 'x'.repeat(500) });
  assert.equal(errors.description, undefined);
});

test('a description over 500 characters is refused', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), description: 'x'.repeat(501) });
  assert.match(errors.description, /500/);
});

test('an empty description is refused, which the server would allow', () => {
  // Stricter than validateLocationInput on purpose: the server accepts an empty
  // string because an admin editing a record may clear one. A submission with
  // no description gives a reviewer nothing to review.
  const { errors } = NCZ.collectLocationForm({ ...complete(), description: '   ' });
  assert.ok(errors.description);
});

// ── coordinates ───────────────────────────────────────────────────────────────

test('a missing coordinate is refused as one message for the row', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), z: '' });
  assert.ok(errors.coordinates);
});

test('text in a coordinate is refused', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), x: 'over there' });
  assert.ok(errors.coordinates);
});

test('X and Y are bounded by the terrain extent, not by the tile projection', () => {
  const inside = NCZ.collectLocationForm({ ...complete(), x: '-7999', y: '7999' });
  assert.equal(inside.errors.coordinates, undefined);

  const outside = NCZ.collectLocationForm({ ...complete(), x: '8001' });
  assert.match(outside.errors.coordinates, /8000/);
});

test('the four records live on the map today would all still be accepted', () => {
  // The pre-D1 form refused anything past 5000 on X/Y or 1000 on Z. Four
  // published records break that rule and arrived through the pull request
  // path, so the rule never rejected anything and would reject them now.
  const live = [
    { x: '-5782', y: '0', z: '10' },
    { x: '5321', y: '0', z: '10' },
    { x: '0', y: '0', z: '1524.6' },
    { x: '0', y: '-7684', z: '0' },
  ];
  for (const coords of live) {
    const { errors } = NCZ.collectLocationForm({ ...complete(), ...coords });
    assert.equal(errors.coordinates, undefined, `refused a live record at ${JSON.stringify(coords)}`);
  }
});

test('Z is bounded separately, from -1000 to 2000', () => {
  const ceiling = NCZ.collectLocationForm({ ...complete(), z: '2000' });
  assert.equal(ceiling.errors.coordinates, undefined);

  const tooHigh = NCZ.collectLocationForm({ ...complete(), z: '2001' });
  assert.match(tooHigh.errors.coordinates, /Z/);

  const tooLow = NCZ.collectLocationForm({ ...complete(), z: '-1001' });
  assert.match(tooLow.errors.coordinates, /Z/);
});

test('the browser bounds are the same numbers the Worker enforces', () => {
  // The two copies drifting is the failure this guards: the form would either
  // refuse a legal location or promise one the server then rejects.
  const config = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'worker', 'src', 'config.js'),
    'utf8',
  );
  const value = (name) => Number(config.match(new RegExp(`export const ${name} = (-?\\d+)`))[1]);

  assert.equal(NCZ.TERRAIN_MIN_X, value('TERRAIN_MIN_X'));
  assert.equal(NCZ.TERRAIN_MAX_X, value('TERRAIN_MAX_X'));
  assert.equal(NCZ.TERRAIN_MIN_Y, value('TERRAIN_MIN_Y'));
  assert.equal(NCZ.TERRAIN_MAX_Y, value('TERRAIN_MAX_Y'));
  assert.equal(NCZ.COORD_Z_MIN, value('COORD_Z_MIN'));
  assert.equal(NCZ.COORD_Z_MAX, value('COORD_Z_MAX'));
});

// ── yaw ───────────────────────────────────────────────────────────────────────

test('a blank yaw is null rather than an error', () => {
  const { values, errors } = NCZ.collectLocationForm({ ...complete(), yaw: '  ' });
  assert.equal(errors.yaw, undefined);
  assert.equal(values.yaw, null);
});

test('a yaw that is not a number is refused', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), yaw: 'north' });
  assert.ok(errors.yaw);
});

// ── category and tags ─────────────────────────────────────────────────────────

test('an unselected category is refused', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), category: '' });
  assert.ok(errors.category);
});

test('a category outside the three the map renders is refused', () => {
  const { errors } = NCZ.collectLocationForm({ ...complete(), category: 'quest' });
  assert.ok(errors.category);
});

test('tags are checked against the registry when one is supplied', () => {
  const known = { knownTags: ['player-home', 'interior'] };
  const ok = NCZ.collectLocationForm({ ...complete(), tags: ['interior'] }, known);
  assert.equal(ok.errors.tags, undefined);

  const bad = NCZ.collectLocationForm({ ...complete(), tags: ['interior', 'invented'] }, known);
  assert.match(bad.errors.tags, /invented/);
});

test('no tags at all is valid', () => {
  const { values, errors } = NCZ.collectLocationForm({ ...complete(), tags: [] }, { knownTags: [] });
  assert.equal(errors.tags, undefined);
  assert.deepEqual(values.tags, []);
});

// ── the Nexus reference ───────────────────────────────────────────────────────

test('a bare mod id is accepted', () => {
  assert.deepEqual(NCZ.parseNexusRef('  12345 '), { id: '12345' });
});

test('both Nexus URL shapes yield the mod id', () => {
  assert.equal(NCZ.parseNexusRef('https://www.nexusmods.com/games/cyberpunk2077/mods/12345').id, '12345');
  assert.equal(NCZ.parseNexusRef('https://www.nexusmods.com/cyberpunk2077/mods/12345?tab=files').id, '12345');
  assert.equal(NCZ.parseNexusRef('nexusmods.com/cyberpunk2077/mods/12345/').id, '12345');
});

test('a link to another game is an error rather than a plausible id', () => {
  // The number is real. It just points at a different game's mod, and nothing
  // downstream could tell.
  const result = NCZ.parseNexusRef('https://www.nexusmods.com/games/starfield/mods/12345');
  assert.equal(result.id, undefined);
  assert.match(result.error, /different game/);
});

test('a Nexus link with no mod id in it is an error', () => {
  const result = NCZ.parseNexusRef('https://www.nexusmods.com/games/cyberpunk2077');
  assert.ok(result.error);
});

test('a blank reference is refused', () => {
  assert.ok(NCZ.parseNexusRef('').error);
  assert.ok(NCZ.collectLocationForm({ ...complete(), nexusId: '' }).errors.nexus_id);
});

test('WIP is refused from the form, though the server allows it', () => {
  // Stricter on purpose: "WIP" and "Dummy" are reviewer calls. A submitter
  // cannot evidence a mod that has no page.
  assert.ok(NCZ.parseNexusRef('WIP').error);
  assert.ok(NCZ.parseNexusRef('Dummy').error);
});

// ── credits ───────────────────────────────────────────────────────────────────

test('blank credits are null, not an empty string', () => {
  // validateLocationInput accepts a string or null, and null is what "none"
  // means in the stored record.
  const { values } = NCZ.collectLocationForm({ ...complete(), credits: '   ' });
  assert.equal(values.credits, null);
});

// ── the submission envelope ───────────────────────────────────────────────────

test('a blank note and contact are null, so nothing is stored about the submitter', () => {
  const { values, errors } = NCZ.collectSubmissionMeta({ note: '', contact: '  ' });
  assert.deepEqual(errors, {});
  assert.deepEqual(values, { submitter_note: null, submitter_contact: null });
});

test('the note limit matches the Worker NOTE_MAX', () => {
  const ok = NCZ.collectSubmissionMeta({ note: 'x'.repeat(1000), contact: '' });
  assert.equal(ok.errors.note, undefined);

  const over = NCZ.collectSubmissionMeta({ note: 'x'.repeat(1001), contact: '' });
  assert.match(over.errors.note, /1000/);
});

test('the contact limit matches the Worker CONTACT_MAX', () => {
  const ok = NCZ.collectSubmissionMeta({ note: '', contact: 'x'.repeat(200) });
  assert.equal(ok.errors.contact, undefined);

  const over = NCZ.collectSubmissionMeta({ note: '', contact: 'x'.repeat(201) });
  assert.match(over.errors.contact, /200/);
});

test('the envelope limits are the same numbers the Worker enforces', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'worker', 'src', 'submissions.js'),
    'utf8',
  );
  const value = (name) => Number(source.match(new RegExp(`const ${name} = (\\d+)`))[1]);

  assert.equal(NCZ.SUBMISSION_NOTE_MAX, value('NOTE_MAX'));
  assert.equal(NCZ.SUBMISSION_CONTACT_MAX, value('CONTACT_MAX'));
});

test('the description limit is the same number the Worker enforces', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'worker', 'src', 'validate.js'),
    'utf8',
  );
  const max = Number(source.match(/export const DESCRIPTION_MAX = (\d+)/)[1]);
  assert.equal(NCZ.DESCRIPTION_MAX_LENGTH, max);
});

// ── every field at once ───────────────────────────────────────────────────────

test('an empty form reports every field, not the first one', () => {
  // The old form alerted once per rule and returned, so a submitter fixed one
  // thing per attempt. Inline errors are only an improvement if they all
  // arrive together.
  const { errors } = NCZ.collectLocationForm({ tags: [] });
  for (const field of ['name', 'authors', 'description', 'coordinates', 'category', 'nexus_id']) {
    assert.ok(errors[field], `expected an error for ${field}`);
  }
});
