import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNcZoningBlock } from '../src/parse.js';

const TAGS = new Set(['apartment', 'corpo', 'neokitsch']);

test('parses a clean [code]-wrapped block', () => {
  const desc = `My cool mod.
[code]
NCZoning:
coords=-1234.5,678.9,12.3
yaw=180.0
category=new-location
tags=apartment,neokitsch
credits=Team NC
authors=CoAuthor1,CoAuthor2
[/code]`;
  const p = parseNcZoningBlock(desc, TAGS);
  assert.deepEqual(p.coordinates, [-1234.5, 678.9, 12.3]);
  assert.equal(p.category, 'new-location');
  assert.deepEqual(p.tags, ['apartment', 'neokitsch']);
  assert.equal(p.credits, 'Team NC');
  assert.deepEqual(p.additionalAuthors, ['CoAuthor1', 'CoAuthor2']);
  assert.equal(p.yaw, 180.0);
});

test('survives lost [code] wrapper and per-line styling tags', () => {
  const desc = `[size=4]Great mod![/size]
NCZoning:
[b]coords=100,200[/b]
[color=red]category=other[/color]`;
  const p = parseNcZoningBlock(desc, TAGS);
  assert.deepEqual(p.coordinates, [100, 200]);
  assert.equal(p.category, 'other');
});

test('sentinel glued to prose still parses', () => {
  const desc = `Check it out — it's Preem, Making![code]NCZoning:
coords=1,2,3
category=location-overhaul[/code]`;
  const p = parseNcZoningBlock(desc, TAGS);
  assert.deepEqual(p.coordinates, [1, 2, 3]);
});

test('false-positive NCZoning mention earlier; real block later wins', () => {
  const desc = `I love NCZoning: it is a great map.

[code]
NCZoning:
coords=5,6
category=other
[/code]`;
  const p = parseNcZoningBlock(desc, TAGS);
  assert.deepEqual(p.coordinates, [5, 6]);
});

test('missing category → null', () => {
  const p = parseNcZoningBlock('NCZoning:\ncoords=1,2,3', TAGS);
  assert.equal(p, null);
});

test('bad coords rejected: too few, too many, NaN', () => {
  for (const coords of ['1', '1,2,3,4', '1,abc']) {
    assert.equal(parseNcZoningBlock(`NCZoning:\ncoords=${coords}\ncategory=other`, TAGS), null);
  }
});

test('unknown tags silently dropped, yaw optional', () => {
  const p = parseNcZoningBlock(
    'NCZoning:\ncoords=1,2\ncategory=other\ntags=apartment,unknowntag', TAGS);
  assert.deepEqual(p.tags, ['apartment']);
  assert.equal(p.yaw, null);
});

test('empty/absent description → null', () => {
  assert.equal(parseNcZoningBlock('', TAGS), null);
  assert.equal(parseNcZoningBlock(null, TAGS), null);
});

test('html <br> line breaks are normalised', () => {
  const p = parseNcZoningBlock('NCZoning:<br>coords=9,8,7<br/>category=other', TAGS);
  assert.deepEqual(p.coordinates, [9, 8, 7]);
});
