// API_VERSION tooling: the shape hash behind the drift guard, and the CLI that
// re-locks it.
//
// Why this exists: API_VERSION sat at 0.1.0 from its introduction through the
// site's 1.6.0 release, across three additive API changes, because nothing ever
// forced a bump (issue #857). The guard below makes forgetting a test failure.
//
//   node scripts/api-version.mjs          # print the current + locked hashes
//   npm run version:lock                  # rewrite api-version.lock.json
//
// Bump API_VERSION first, THEN re-lock — the lock records the version the
// current shape shipped under.
//
// Version lives in three places that must agree (see test/api-version.test.js):
//   wrangler.jsonc  vars.API_VERSION   — what /v1/health serves (per environment)
//   openapi.json    info.version       — what the published spec claims
//   package.json    version            — the npm-side marker
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  spec: join(WORKER_DIR, 'openapi.json'),
  lock: join(WORKER_DIR, 'api-version.lock.json'),
  wrangler: join(WORKER_DIR, 'wrangler.jsonc'),
  pkg: join(WORKER_DIR, 'package.json'),
};

// Prose keys carry no machine-readable shape: editing a description or an
// example is documentation work, not an API change, and must not demand a
// version bump. Everything else in `paths` + `components` does count.
const PROSE_KEYS = new Set(['description', 'summary', 'example', 'examples']);

// ...but ONLY outside a `properties` map, where the keys are field names rather
// than prose. LocationFull genuinely has a field called `description`; stripping
// it as prose would let a rename or removal of a real API field pass the guard.
const FIELD_NAME_MAPS = new Set(['properties', 'patternProperties']);

// Canonical form: prose stripped, object keys sorted, so the hash depends on the
// API's shape and not on JSON key order or formatting.
function canonicalise(value, isFieldNameMap = false) {
  if (Array.isArray(value)) return value.map((v) => canonicalise(v));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (!isFieldNameMap && PROSE_KEYS.has(key)) continue;
    out[key] = canonicalise(value[key], FIELD_NAME_MAPS.has(key));
  }
  return out;
}

/** sha256 over the machine-readable surface of an OpenAPI spec. */
export function shapeHash(spec) {
  const surface = canonicalise({ paths: spec.paths, components: spec.components ?? {} });
  return `sha256:${createHash('sha256').update(JSON.stringify(surface)).digest('hex')}`;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export const readSpec = () => readJson(PATHS.spec);
export const readLock = () => readJson(PATHS.lock);

/**
 * Every declared API_VERSION, by where it is declared. wrangler.jsonc is JSONC
 * (comments), so it is read by anchored regex rather than parsed — one entry per
 * `vars` block, plus the spec and package markers.
 */
export function declaredVersions() {
  const wrangler = readFileSync(PATHS.wrangler, 'utf8');
  const found = [...wrangler.matchAll(/"API_VERSION"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  return {
    wrangler: found,
    // How many `vars` blocks exist at all — a new environment that forgets
    // API_VERSION would otherwise deploy serving `undefined` at /v1/health.
    wranglerVarsBlocks: [...wrangler.matchAll(/"vars"\s*:/g)].length,
    spec: readSpec().info.version,
    pkg: readJson(PATHS.pkg).version,
  };
}

// CLI: `npm run version:lock` writes the lock to match the current spec +
// declared version. Bare invocation just reports, so it is safe to run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hash = shapeHash(readSpec());
  const versions = declaredVersions();
  const version = versions.spec;

  if (process.argv.includes('--write')) {
    writeFileSync(PATHS.lock, `${JSON.stringify({ version, shape_hash: hash }, null, 2)}\n`);
    console.log(`locked ${version} → ${hash}`);
  } else {
    const lock = readLock();
    console.log(`declared: wrangler=${versions.wrangler.join(',')} spec=${versions.spec} pkg=${versions.pkg}`);
    console.log(`locked:   ${lock.version} → ${lock.shape_hash}`);
    console.log(`current:  ${version} → ${hash}`);
    console.log(lock.shape_hash === hash && lock.version === version ? 'in sync' : 'DRIFT — bump API_VERSION, then `npm run version:lock`');
  }
}
