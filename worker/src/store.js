/**
 * KV storage layer for the dataset. Keys under `dataset:v1*`:
 * - dataset:v1:full      { id: fullEntry } map — the one location
 *                        representation. /v1/locations serves its values;
 *                        /v1/locations/{id} reads full[id].
 * - dataset:v1:districts /v1/districts payload
 * - dataset:v1:tags      tag dictionary ({ tagId: description })
 * - dataset:v1:meta      { schema, generated_at, dataset_version,
 *                          discovery_stale, skipped }
 *
 * dataset_version is a content hash: the cron writes only when it changes,
 * and it doubles as the ETag for the read path.
 */

export const KEYS = {
  full: 'dataset:v1:full',
  districts: 'dataset:v1:districts',
  tags: 'dataset:v1:tags',
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
  return env.DATASET.get(KEYS.meta, 'json');
}

/**
 * Persist a freshly built dataset. Writes all keys; callers only reach here
 * when the hash changed, so the per-key 1 write/s limit is never a risk
 * (cron runs every 5 min).
 */
export async function writeDataset(env, { full, districts, tags, meta }) {
  await Promise.all([
    env.DATASET.put(KEYS.full, JSON.stringify(full)),
    env.DATASET.put(KEYS.districts, JSON.stringify(districts)),
    env.DATASET.put(KEYS.tags, JSON.stringify(tags)),
    env.DATASET.put(KEYS.meta, JSON.stringify(meta)),
  ]);
}

/** Update only the meta record (last-known-good touch on a failed refresh). */
export async function writeMeta(env, meta) {
  await env.DATASET.put(KEYS.meta, JSON.stringify(meta));
}
