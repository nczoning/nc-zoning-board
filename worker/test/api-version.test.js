// Drift guard for API_VERSION (issue #857).
//
// The marker sat at 0.1.0 across three additive API changes because nothing
// forced a bump. These tests are that force: change the shape of openapi.json
// without bumping the version and `npm test` — which gates every deploy
// (.github/workflows/deploy-api.yml) — fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeHash, readSpec, readLock, declaredVersions } from '../scripts/api-version.mjs';

const SEMVER = /^\d+\.\d+\.\d+$/;

test('API_VERSION agrees across every place it is declared', () => {
  const v = declaredVersions();

  assert.ok(v.wrangler.length > 0, 'no API_VERSION found in wrangler.jsonc');
  assert.equal(
    v.wrangler.length,
    v.wranglerVarsBlocks,
    `wrangler.jsonc has ${v.wranglerVarsBlocks} vars block(s) but ${v.wrangler.length} API_VERSION declaration(s) — ` +
      'named environments do not inherit vars, so every environment needs its own',
  );

  const all = [...v.wrangler, v.spec, v.pkg];
  assert.ok(all.every((x) => SEMVER.test(x)), `API_VERSION must be plain SemVer, got ${all.join(', ')}`);
  assert.equal(
    new Set(all).size,
    1,
    `API_VERSION disagrees: wrangler=[${v.wrangler.join(', ')}] openapi.json=${v.spec} package.json=${v.pkg}`,
  );
});

test('the API shape has not changed without an API_VERSION bump', () => {
  const lock = readLock();
  const current = shapeHash(readSpec());

  assert.equal(
    current,
    lock.shape_hash,
    `openapi.json's machine-readable shape changed since ${lock.version} was locked.\n` +
      `  locked  ${lock.shape_hash} (${lock.version})\n` +
      `  current ${current}\n` +
      '  → bump API_VERSION (MINOR for an additive field/route, MAJOR for a break),\n' +
      '    then run `npm run version:lock`.\n' +
      '  Prose-only edits (description/summary/example) do not move this hash.',
  );
});

test('the lock records the version currently declared', () => {
  assert.equal(
    readLock().version,
    declaredVersions().spec,
    'api-version.lock.json is stale — run `npm run version:lock` after bumping API_VERSION',
  );
});
