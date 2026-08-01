/**
 * Write-path validation for admin location mutations.
 *
 * This IS the gate. Writes arrive through the API rather than through pull
 * requests, so nothing in CI sees a location before it is stored;
 * `mods.schema.json` describes the stored shape but is read by no runtime code.
 *
 * Hand-rolled rather than ajv-in-the-Worker: ajv is heavy and its default mode
 * compiles with `new Function`, which Workers refuses. The link back to the
 * real schema is therefore a TEST, not an import. test/validate.test.js runs
 * ajv over `mods.schema.json` and asserts it agrees with this file across the
 * 297-record frozen corpus plus crafted invalid ones. If the schema changes and
 * this does not, that test fails. That is the whole mechanism, and it is the reason
 * the duplication is safe rather than a slow drift.
 *
 * Differences from the file schema, deliberately:
 * - `id` is NOT accepted from input. It is server-generated on create and
 *   immutable afterwards; letting a payload set it is how a deep link gets
 *   silently repointed at a different mod.
 * - `status` and `admin_notes` are admin-only fields that never existed in the
 *   file format.
 */

import {
  TERRAIN_MIN_X, TERRAIN_MAX_X, TERRAIN_MIN_Y, TERRAIN_MAX_Y, COORD_Z_MIN, COORD_Z_MAX,
} from './config.js';

export const CATEGORIES = ['location-overhaul', 'new-location', 'other'];
export const STATUSES = ['published', 'hidden', 'draft'];
export const DESCRIPTION_MAX = 500;
const NEXUS_ID_RE = /^(\d+|WIP|Dummy)$/;

/** Fields an admin may set. Anything else in the payload is rejected outright. */
const WRITABLE = new Set([
  'name', 'authors', 'credits', 'coordinates', 'yaw', 'nexus_id',
  'description', 'category', 'tags', 'status', 'admin_notes',
]);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {object} payload
 * @param {object} opts
 * @param {Set<string>} opts.tagNames  known tag ids; unknown tags are an error
 *   here rather than silently dropped as they are in auto-discovery. An admin
 *   typing a tag that does not exist has made a mistake worth surfacing; a
 *   third-party Nexus description has not.
 * @param {boolean} [opts.partial]  PATCH semantics: only validate present keys,
 *   and do not require the mandatory set.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateLocationInput(payload, { tagNames, partial = false } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!isPlainObject(payload)) return { ok: false, errors: ['body must be a JSON object'] };

  // Unknown keys are rejected rather than ignored. A typo'd field name that is
  // silently discarded looks exactly like a successful save.
  for (const key of Object.keys(payload)) {
    if (!WRITABLE.has(key)) {
      err(key === 'id'
        ? 'id cannot be set: it is server-generated and immutable'
        : `unknown field: ${key}`);
    }
  }

  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
  const required = ['name', 'authors', 'coordinates', 'nexus_id', 'description', 'category', 'tags'];
  if (!partial) {
    for (const k of required) if (!has(k)) err(`missing required field: ${k}`);
  }

  if (has('name')) {
    if (typeof payload.name !== 'string' || payload.name.length < 3) {
      err('name must be a string of at least 3 characters');
    }
  }

  if (has('authors')) {
    const a = payload.authors;
    if (!Array.isArray(a) || a.length < 1 || !a.every((x) => typeof x === 'string')) {
      err('authors must be a non-empty array of strings');
    }
  }

  if (has('credits') && payload.credits !== null && typeof payload.credits !== 'string') {
    err('credits must be a string or null');
  }

  if (has('coordinates')) {
    const c = payload.coordinates;
    if (!Array.isArray(c) || c.length < 2 || c.length > 3) {
      err('coordinates must be [X, Y] or [X, Y, Z]');
    } else if (!c.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      // Number.isFinite matters: JSON.parse yields NaN/Infinity for neither,
      // but a client can still send them as strings that coerce badly later.
      err('coordinates must all be finite numbers');
    } else {
      // Range is enforced here rather than only in the form, because
      // /submissions accepts anonymous writes and a browser-side rule sits
      // entirely in the layer the submitter controls. Bounds in config.js.
      const [x, y, z] = c;
      if (x < TERRAIN_MIN_X || x > TERRAIN_MAX_X) {
        err(`coordinate X must be between ${TERRAIN_MIN_X} and ${TERRAIN_MAX_X}`);
      }
      if (y < TERRAIN_MIN_Y || y > TERRAIN_MAX_Y) {
        err(`coordinate Y must be between ${TERRAIN_MIN_Y} and ${TERRAIN_MAX_Y}`);
      }
      if (c.length === 3 && (z < COORD_Z_MIN || z > COORD_Z_MAX)) {
        err(`coordinate Z must be between ${COORD_Z_MIN} and ${COORD_Z_MAX}`);
      }
    }
  }

  if (has('yaw') && payload.yaw !== null) {
    if (typeof payload.yaw !== 'number' || !Number.isFinite(payload.yaw)) {
      err('yaw must be a finite number or null');
    }
  }

  if (has('nexus_id')) {
    if (typeof payload.nexus_id !== 'string' || !NEXUS_ID_RE.test(payload.nexus_id)) {
      err('nexus_id must be a numeric string, or "WIP" / "Dummy"');
    }
  }

  if (has('description')) {
    if (typeof payload.description !== 'string') err('description must be a string');
    else if (payload.description.length > DESCRIPTION_MAX) {
      err(`description must be at most ${DESCRIPTION_MAX} characters`);
    }
  }

  if (has('category') && !CATEGORIES.includes(payload.category)) {
    err(`category must be one of: ${CATEGORIES.join(', ')}`);
  }

  if (has('tags')) {
    const t = payload.tags;
    if (!Array.isArray(t) || !t.every((x) => typeof x === 'string')) {
      err('tags must be an array of strings');
    } else if (tagNames) {
      const unknown = t.filter((x) => !tagNames.has(x));
      if (unknown.length) err(`unknown tag(s): ${unknown.join(', ')}`);
    }
  }

  if (has('status') && !STATUSES.includes(payload.status)) {
    err(`status must be one of: ${STATUSES.join(', ')}`);
  }

  if (has('admin_notes') && payload.admin_notes !== null && typeof payload.admin_notes !== 'string') {
    err('admin_notes must be a string or null');
  }

  return { ok: errors.length === 0, errors };
}
