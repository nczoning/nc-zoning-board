/**
 * Refresh orchestrator — the body of the 15-minute cron. Fetches the CDN
 * source files + Nexus auto-discovery, rebuilds the dataset, and writes to
 * KV only when the content hash changes.
 *
 * Failure posture (the load-bearing rule): if Nexus (or any source) fails,
 * KEEP the last-known-good dataset, mark meta.discovery_stale, alert
 * Discord, and never serve an empty/partial dataset. A partial Nexus page
 * already throws in nexus.js, so a truncated tag population can't slip
 * through as "complete".
 *
 * Pure-ish: all I/O is injected (fetchImpl, env), so the whole thing is
 * unit-testable with a fake KV + fake fetch.
 */

import { fetchTaggedModNodes, fetchModsByUidThumbs } from './nexus.js';
import { buildDataset } from './merge.js';
import { districtsPayload } from './districts.js';
import { KEYS, contentHash, readMeta, writeDataset, writeMeta } from './store.js';

const SCHEMA_VERSION = 1;

/** Fetch a JSON file from the site origin; throws on non-200. */
async function fetchJson(fetchImpl, origin, path) {
  const res = await fetchImpl(`${origin}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Post a failure embed to Discord if a webhook is configured. Prefers the
 * dedicated map-alerts channel (NCZ_ALERTS_DISCORD_WEBHOOK_URL), falling back
 * to the legacy submissions webhook so there's no alerting gap until the new
 * Cloudflare Worker secret is set (`wrangler secret put
 * NCZ_ALERTS_DISCORD_WEBHOOK_URL` for BOTH the prod and staging Workers).
 */
async function alertDiscord(env, fetchImpl, reason) {
  const webhook = env.NCZ_ALERTS_DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '⚠️ Data API refresh failed',
          description: String(reason).slice(0, 1500),
          color: 0xffb300,
          footer: { text: 'Serving last-known-good dataset (discovery_stale=true)' },
        }],
      }),
    });
  } catch {
    // Alerting must never mask the original failure.
  }
}

/**
 * Post a recovery embed: the previous cycle marked the dataset discovery_stale
 * and this cycle rebuilt it cleanly, so this is the down→up edge. Fires once
 * (the next successful cycle sees discovery_stale=false and stays quiet).
 */
async function alertDiscordRecovered(env, fetchImpl) {
  const webhook = env.NCZ_ALERTS_DISCORD_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: '✅ Data API refresh recovered',
          description: 'A refresh succeeded after an earlier failure — the dataset is fresh again (discovery_stale=false).',
          color: 0x2ecc71,
          footer: { text: 'NC Zoning Board • Data API refresh' },
        }],
      }),
    });
  } catch {
    // A missed all-clear is not worth throwing over.
  }
}

/**
 * Run one refresh cycle.
 * @param {object} env  Worker env (DATASET KV binding, SITE_ORIGIN?, DISCORD_WEBHOOK_URL?)
 * @param {typeof fetch} fetchImpl  injectable
 * @returns {Promise<{changed:boolean, version:string|null, stale:boolean, error?:string}>}
 */
export async function runRefresh(env, fetchImpl = fetch) {
  const origin = env.SITE_ORIGIN || 'https://nczoning.net';
  const generatedAt = new Date().toISOString();

  try {
    const [manualMods, tagsDict, excluded, subdistricts] = await Promise.all([
      fetchJson(fetchImpl, origin, '/mods.json'),
      fetchJson(fetchImpl, origin, '/data/tags.json'),
      fetchJson(fetchImpl, origin, '/data/excluded_mods.json').catch(() => ({})),
      fetchJson(fetchImpl, origin, '/data/subdistricts.json'),
    ]);
    const districts = subdistricts.districts;
    const nexusNodes = await fetchTaggedModNodes(fetchImpl);

    // Manual-mod thumbnails: the tagged query only backfills manual mods that
    // are themselves NCZoning-tagged, so pull the rest via modsByUid. Cosmetic
    // and non-throwing — a failure here just leaves some images null this
    // cycle, it never marks the dataset stale.
    const manualNumericIds = manualMods
      .map((m) => String(m.nexus_id))
      .filter((id) => /^\d+$/.test(id));
    const manualThumbs = await fetchModsByUidThumbs(fetchImpl, manualNumericIds);

    const { locations, full, meta } = buildDataset({
      manualMods, tagsDict, excluded, nexusNodes, districts, manualThumbs,
    });
    const districtsOut = districtsPayload(districts);

    // Hash the content that actually varies (not generated_at). Tags are
    // included so a tags.json edit propagates through the ETag.
    const version = await contentHash(
      JSON.stringify({ locations, full, districts: districtsOut, tags: tagsDict }),
    );

    const prev = await readMeta(env);
    if (prev && prev.dataset_version === version && !prev.discovery_stale) {
      return { changed: false, version, stale: false };
    }

    // Recovery edge: last cycle failed (discovery_stale) and this one rebuilt
    // cleanly. Announce the all-clear after the write actually lands.
    const recovered = prev?.discovery_stale === true;

    await writeDataset(env, {
      slim: locations,
      full,
      districts: districtsOut,
      tags: tagsDict,
      meta: {
        schema: SCHEMA_VERSION,
        generated_at: generatedAt,
        dataset_version: version,
        counts: meta.counts,
        skipped: meta.skipped,
        discovery_stale: false,
      },
    });
    if (recovered) await alertDiscordRecovered(env, fetchImpl);
    return { changed: true, version, stale: false, recovered };
  } catch (err) {
    // Keep last-known-good; flag stale; alert. Never wipe the dataset.
    const prev = await readMeta(env);
    if (prev) {
      await writeMeta(env, {
        ...prev,
        discovery_stale: true,
        last_error: String(err).slice(0, 300),
        last_error_at: generatedAt,
      });
    }
    await alertDiscord(env, fetchImpl, err);
    return {
      changed: false,
      version: prev?.dataset_version ?? null,
      stale: true,
      error: String(err),
    };
  }
}

export { KEYS };
