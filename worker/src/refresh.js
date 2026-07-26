/**
 * Refresh orchestrator: the body of the 5-minute cron. Fetches the CDN
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

import { fetchTaggedModNodes, fetchModsByUidThumbs, fetchModArchiveNames } from './nexus.js';
import { buildDataset } from './merge.js';
import { materializeFromD1 } from './materialize.js';
import { readLocationRows, readDismissedIds } from './d1.js';
import { districtsPayload } from './districts.js';
import { HEARTBEAT_MIN_INTERVAL_MS } from './config.js';
import {
  KEYS, contentHash, readMeta, writeDataset, writeMeta, readArchives, writeArchives,
} from './store.js';

const SCHEMA_VERSION = 1;

// Per-run limits on archive-name fetching. Archives are near-static (a mod's
// .archive filenames only change on a re-upload, which bumps its updatedAt), so
// steady state fetches nothing. These budgets cap the cold-start fill and any
// re-upload burst so archive work can never breach the Worker's 50-subrequest
// cap alongside the existing discovery + thumbnail calls. A cold cache fills
// over ~ceil(mods / ARCHIVE_MOD_BUDGET) cron ticks.
const ARCHIVE_MOD_BUDGET = 15; // max mods refreshed per run
const ARCHIVE_SUBREQUEST_BUDGET = 25; // max archive subrequests per run

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
 * Refresh the archive-name cache in place, budgeted. Mutates `cache`
 * ({ [nexus_id]: { updatedAt, archives } }) and returns { changed } so the
 * caller knows whether to persist it.
 *
 * A mod is refetched only when it's absent from the cache or its updatedAt moved
 * (the exact re-upload signal for its archive contents). Newest-updated mods are
 * refreshed first so a re-upload beats cold-fill for the budget. A transient
 * failure (ok:false) is left uncached so the next run retries, rather than
 * caching an empty/partial listing as final.
 */
async function refreshArchives(fetchImpl, full, cache) {
  const records = Object.values(full).filter((r) => /^\d+$/.test(r.nexus_id));

  const stale = records
    .filter((r) => {
      const c = cache[r.nexus_id];
      return !c || c.updatedAt !== (r.updated_at ?? null);
    })
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));

  let changed = false;
  let refreshed = 0;
  let okCount = 0;
  let subrequests = 0;
  for (const r of stale) {
    if (refreshed >= ARCHIVE_MOD_BUDGET || subrequests >= ARCHIVE_SUBREQUEST_BUDGET) break;
    const res = await fetchModArchiveNames(fetchImpl, r.nexus_id);
    refreshed += 1;
    subrequests += res.subrequests;
    if (!res.ok) continue; // transient failure: leave stale, retry next run
    okCount += 1;
    cache[r.nexus_id] = { updatedAt: r.updated_at ?? null, archives: res.archives };
    changed = true;
  }
  if (refreshed > 0) {
    // Ops visibility for the cold-fill / re-upload catch-up (cf. the thumbnail
    // warnings). Silent in steady state, when nothing is stale.
    console.log(
      `archives: refreshed ${okCount}/${refreshed} mods (${stale.length} stale, ${subrequests} subrequests), cache=${Object.keys(cache).length}`,
    );
  }

  // Evict entries for mods no longer in the dataset (deleted/hidden on Nexus) so
  // the cache can't grow without bound. No fetching, just set membership.
  const live = new Set(records.map((r) => r.nexus_id));
  for (const id of Object.keys(cache)) {
    if (!live.has(id)) {
      delete cache[id];
      changed = true;
    }
  }

  return { changed };
}

/**
 * Attach an `archives` string array to every full record (always present, `[]`
 * when unknown or not yet filled), refreshing the KV-backed cache first. Wrapped
 * so archive work can NEVER fail the refresh: on any error every record still
 * gets at least `[]`. Mutates `full` in place; run it before the content hash so
 * archive changes propagate to the ETag.
 */
async function attachArchives(env, fetchImpl, full) {
  let cache = {};
  try {
    cache = await readArchives(env);
    const { changed } = await refreshArchives(fetchImpl, full, cache);
    if (changed) await writeArchives(env, cache);
  } catch (err) {
    console.warn('archive refresh failed (non-fatal):', String(err).slice(0, 200));
  }
  for (const rec of Object.values(full)) {
    rec.archives = cache[rec.nexus_id]?.archives ?? [];
  }
}

/**
 * Build the dataset from whichever source this environment is pointed at.
 *
 * `DATA_SOURCE=d1` reads the registry from D1; anything else (including unset)
 * reads the compiled mods.json from the site origin. **Unset means mods.json on
 * purpose** — a missing var must not silently switch production onto a new
 * source, which is the same "absent config read as permissive" trap that
 * attached every MCP connection to a scheduled agent.
 *
 * It is a var rather than a code branch so the Phase 2 cutover, and more
 * importantly its rollback, is a config change on a known-good build instead of
 * a revert-and-redeploy under pressure.
 *
 * Both paths take the same Nexus inputs and the same clock, and both return the
 * same `{ full, meta }` shape, which is what lets parity-ab.mjs diff them
 * head-to-head. tags/subdistricts still come from the site origin in both —
 * they move to D1 at Phase 4.
 */
async function sourceAndBuild(env, fetchImpl, origin, nowMs) {
  const [tagsDict, subdistricts] = await Promise.all([
    fetchJson(fetchImpl, origin, '/data/tags.json'),
    fetchJson(fetchImpl, origin, '/data/subdistricts.json'),
  ]);
  const districts = subdistricts.districts;
  const nexusNodes = await fetchTaggedModNodes(fetchImpl);

  if (env.DATA_SOURCE === 'd1') {
    const [rows, dismissed] = await Promise.all([
      readLocationRows(env),
      readDismissedIds(env),
    ]);
    // Thumbnail backfill covers every published record with a numeric id, not
    // just the "manual" ones: under D1 the auto-discovered records are rows too.
    const numericIds = rows
      .filter((r) => r.status === 'published')
      .map((r) => String(r.nexus_id))
      .filter((id) => /^\d+$/.test(id));
    const manualThumbs = await fetchModsByUidThumbs(fetchImpl, numericIds);
    const built = materializeFromD1({
      rows, dismissed, tagsDict, nexusNodes, districts, manualThumbs, nowMs,
    });
    return { ...built, tagsDict, districts };
  }

  const [manualMods, excluded] = await Promise.all([
    fetchJson(fetchImpl, origin, '/mods.json'),
    fetchJson(fetchImpl, origin, '/data/excluded_mods.json').catch(() => ({})),
  ]);
  const manualNumericIds = manualMods
    .map((m) => String(m.nexus_id))
    .filter((id) => /^\d+$/.test(id));
  const manualThumbs = await fetchModsByUidThumbs(fetchImpl, manualNumericIds);
  const built = buildDataset({
    manualMods, tagsDict, excluded, nexusNodes, districts, manualThumbs, nowMs,
  });
  return { ...built, tagsDict, districts };
}

/**
 * Run one refresh cycle.
 * @param {object} env  Worker env (DATASET KV binding, SITE_ORIGIN?, DISCORD_WEBHOOK_URL?)
 * @param {typeof fetch} fetchImpl  injectable
 * @returns {Promise<{changed:boolean, version:string|null, stale:boolean, error?:string}>}
 */
export async function runRefresh(env, fetchImpl = fetch) {
  const origin = env.SITE_ORIGIN || 'https://nczoning.net';
  // This cron cycle's wall-clock instant. Serves two distinct roles: it's the
  // content `generated_at` on a cycle that actually rewrites the dataset, AND
  // the `last_refresh_at` liveness heartbeat. The heartbeat is the "when did the
  // cron last RUN" signal the freshness monitor watches — distinct from
  // generated_at, which only advances on content change and so can legitimately
  // be hours old. A frozen heartbeat means scheduled() has stopped executing
  // (issue #849).
  //
  // It is stamped unconditionally on a changed or failed cycle (both already
  // write KV for other reasons, so it is free), and at most every
  // HEARTBEAT_MIN_INTERVAL_MS on an unchanged one, where it would otherwise be
  // the only reason to write at all.
  const generatedAt = new Date().toISOString();

  try {
    // Thumbnails are cosmetic and non-throwing inside this: a failure there
    // leaves some images null for a cycle, it never marks the dataset stale.
    // A D1 read failure, by contrast, throws and lands in the catch below --
    // last-known-good, discovery_stale, alert. Never an empty map.
    const { full, meta, tagsDict, districts } = await sourceAndBuild(
      env, fetchImpl, origin, Date.parse(generatedAt),
    );
    const districtsOut = districtsPayload(districts);

    // Enrich every record with its shipped .archive file names (installed-mod
    // detection). Budgeted + updatedAt-gated, and non-fatal by construction, so
    // it slots in before the hash without touching the failure posture below.
    await attachArchives(env, fetchImpl, full);

    // Hash the content that actually varies (not generated_at). Tags are
    // included so a tags.json edit propagates through the ETag. `full` carries
    // the recently_updated bool, so its clock-driven flips move the ETag;
    // that is deliberate (a location aging past the window must invalidate
    // caches even though nothing on Nexus changed). This is why the cron
    // rebuilds every tick against a fresh clock, with no Nexus short-circuit.
    const version = await contentHash(
      JSON.stringify({ full, districts: districtsOut, tags: tagsDict }),
    );

    const prev = await readMeta(env);
    if (prev && prev.dataset_version === version && !prev.discovery_stale) {
      // Content unchanged, but the cron DID run: advance only the liveness
      // heartbeat so a wedged cron is distinguishable from a healthy idle one.
      // dataset_version/generated_at stay put, so the ETag and served envelope
      // are untouched (no cache bust). See #849.
      //
      // Rate-limited: this write bypasses the content-hash gate, so writing it
      // every tick costs 288 KV writes/day/env against a 1,000/day ACCOUNT cap.
      // Writing at most every HEARTBEAT_MIN_INTERVAL_MS keeps the signal (the
      // monitor's staleness threshold is 3x this) at a third of the cost.
      const lastRefreshMs = Date.parse(prev.last_refresh_at ?? '');
      const heartbeatDue = !Number.isFinite(lastRefreshMs)
        || Date.parse(generatedAt) - lastRefreshMs >= HEARTBEAT_MIN_INTERVAL_MS;
      if (heartbeatDue) await writeMeta(env, { ...prev, last_refresh_at: generatedAt });
      return { changed: false, version, stale: false, heartbeat: heartbeatDue };
    }

    // Recovery edge: last cycle failed (discovery_stale) and this one rebuilt
    // cleanly. Announce the all-clear after the write actually lands.
    const recovered = prev?.discovery_stale === true;

    await writeDataset(env, {
      full,
      districts: districtsOut,
      tags: tagsDict,
      meta: {
        schema: SCHEMA_VERSION,
        generated_at: generatedAt,
        dataset_version: version,
        skipped: meta.skipped,
        discovery_stale: false,
        last_refresh_at: generatedAt, // liveness heartbeat (see #849)
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
        // The cron still RAN (Nexus just didn't answer) — advance the heartbeat
        // so this reads as "stale data" (discovery_stale), not "wedged cron".
        last_refresh_at: generatedAt,
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
