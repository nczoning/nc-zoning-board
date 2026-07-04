/**
 * KV storage layer for the dataset. Keys under `dataset:v1*`:
 * - dataset:v1           slim locations array (the workhorse read)
 * - dataset:v1:full      { id: fullEntry } map for /v1/locations/{id}
 * - dataset:v1:districts /v1/districts payload
 * - dataset:v1:meta      { schema, generated_at, dataset_version, counts,
 *                          discovery_stale, skipped }
 *
 * dataset_version is a content hash: the cron writes only when it changes,
 * and it doubles as the ETag for the read path (B4).
 */

export const KEYS = {
  slim: 'dataset:v1',
  full: 'dataset:v1:full',
  districts: 'dataset:v1:districts',
  meta: 'dataset:v1:meta',
};

/** SHA-256 hex of a string, via Web Crypto (Workers + Node 24). */
export async function contentHash(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Read the current meta record (or null before the first successful cron). */
export async function readMeta(env) {
  return env.DATA.get(KEYS.meta, 'json');
}

/**
 * Persist a freshly built dataset. Writes all four keys; callers only reach
 * here when the hash changed, so the per-key 1 write/s limit is never a risk
 * (cron runs every 15 min).
 */
export async function writeDataset(env, { slim, full, districts, meta }) {
  await Promise.all([
    env.DATA.put(KEYS.slim, JSON.stringify(slim)),
    env.DATA.put(KEYS.full, JSON.stringify(full)),
    env.DATA.put(KEYS.districts, JSON.stringify(districts)),
    env.DATA.put(KEYS.meta, JSON.stringify(meta)),
  ]);
}

/** Update only the meta record (last-known-good touch on a failed refresh). */
export async function writeMeta(env, meta) {
  await env.DATA.put(KEYS.meta, JSON.stringify(meta));
}
