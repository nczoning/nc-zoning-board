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

import { fetchTaggedModNodes, fetchModsByUidThumbs } from './nexus.js';
import { buildDataset } from './merge.js';
import { materializeFromD1, attachArchives } from './materialize.js';
import { refreshNexusCache, refreshArchives, readNexusIndex } from './nexus-cache.js';
import {
  readLocationRows, readDismissedIds, readTags, readLocationTags,
} from './d1.js';
import { districtsPayload } from './districts.js';
import { HEARTBEAT_MIN_INTERVAL_MS } from './config.js';
import {
  KEYS, contentHash, readMeta, writeDataset, writeMeta,
} from './store.js';
import { raiseAlert } from './alerts.js';
import { checkQuotaThresholds } from './quota.js';

const SCHEMA_VERSION = 1;

/** Fetch a JSON file from the site origin; throws on non-200. */
async function fetchJson(fetchImpl, origin, path) {
  const res = await fetchImpl(`${origin}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Refresh failed: keep serving last-known-good and say so.
 *
 * Goes through `raiseAlert` rather than posting to the webhook directly, so the
 * dashboard gets a history row as well as the channel getting a message. That
 * call never throws, which preserves the rule this function has always had:
 * alerting must never mask the original failure.
 */
async function alertRefreshFailed(env, fetchImpl, reason) {
  await raiseAlert(env, {
    source: 'refresh',
    // warn, not error: the dataset is still being served. A failed refresh
    // degrades freshness (discovery_stale=true) and takes nothing down, which
    // is why this embed has always been amber. `error` is for not serving.
    severity: 'warn',
    title: 'Data API refresh failed',
    body: `${String(reason).slice(0, 1200)}\n\nServing last-known-good dataset (discovery_stale=true).`,
  }, { fetchImpl });
}

/**
 * The previous cycle marked the dataset discovery_stale and this cycle rebuilt
 * it cleanly, so this is the down to up edge. Fires once (the next successful
 * cycle sees discovery_stale=false and stays quiet).
 */
async function alertRefreshRecovered(env, fetchImpl) {
  await raiseAlert(env, {
    source: 'refresh',
    severity: 'recovery',
    title: 'Data API refresh recovered',
    body: 'A refresh succeeded after an earlier failure. The dataset is fresh again (discovery_stale=false).',
  }, { fetchImpl });
}

/**
 * Sweep `nexus_cache` and return the index the dataset is built against.
 *
 * The sweep never throws (a Nexus outage must leave last-known-good in place),
 * so the only signal that it produced nothing usable is the index itself. What
 * an empty one means depends on the source, so the caller judges it: see the
 * guard in sourceAndBuild.
 */
async function sweepNexusCache(env, fetchImpl, nexusNodes, nowIso) {
  try {
    const sweep = await refreshNexusCache(env, { fetchImpl, taggedNodes: nexusNodes, nowIso });
    if (sweep.written) {
      console.log(
        `nexus_cache: ${sweep.written} rows written (${sweep.tagged} tagged, `
        + `${sweep.backfilled} backfilled, ${sweep.untagged} untagged)`,
      );
    }
    return await readNexusIndex(env);
  } catch (err) {
    // While production still builds from mods.json, D1 is not on its critical
    // path and must not become so ahead of the cutover: a database problem may
    // cost that environment its archives, never its freshness. Under
    // DATA_SOURCE=d1 the registry read throws on its own account anyway.
    if (env.DATA_SOURCE === 'd1') throw err;
    console.warn('nexus_cache sweep failed (non-fatal on mods.json):', String(err).slice(0, 200));
    return new Map();
  }
}

/**
 * Resolve and attach every record's `.archive` file names.
 *
 * Wrapped so archive work can NEVER fail the refresh, which is the posture the
 * KV-backed version had: on any error every record still gets at least `[]`.
 * Runs after the build because the served record set is what decides which mods
 * need a listing, and before the content hash so a re-upload that changes only
 * the file list still moves the ETag.
 */
async function fillArchives(env, fetchImpl, full, index, nowIso) {
  try {
    const r = await refreshArchives(env, fetchImpl, {
      records: Object.values(full), index, nowIso,
    });
    if (r.fetched || r.seeded || r.pending) {
      console.log(
        `archives: +${r.fetched} fetched, +${r.seeded} carried over from KV, `
        + `${r.pending} still due, ${r.written} rows written`,
      );
    }
  } catch (err) {
    console.warn('archive refresh failed (non-fatal):', String(err).slice(0, 200));
  }
  attachArchives(full, index);
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
 *
 * `nexusNodes` and `nexusIndex` are passed in rather than fetched here: the
 * sweep needs both before this runs, and the tagged query is one of the two
 * expensive calls in the tick.
 */
async function sourceAndBuild(env, fetchImpl, origin, nowMs, { nexusNodes, nexusIndex }) {
  const useD1 = env.DATA_SOURCE === 'd1';
  const subdistricts = await fetchJson(fetchImpl, origin, '/data/subdistricts.json');
  const districts = subdistricts.districts;

  // The tag registry. From D1 once it owns tags, from the file otherwise — but
  // EITHER WAY the served payload is the array shape. The public contract must
  // not depend on an internal source flag, or /v1/tags would silently change
  // shape when DATA_SOURCE flips. `tagsDict` stays a slug->description map for
  // block validation, which is all the parsers need.
  const tagsList = useD1
    ? await readTags(env)
    : Object.entries(await fetchJson(fetchImpl, origin, '/data/tags.json'))
      .map(([slug, description], i) => ({
        slug, name: slug, description, sort_order: i + 1,
      }));
  const tagsDict = Object.fromEntries(tagsList.map((t) => [t.slug, t.description]));

  if (useD1) {
    const [rows, dismissed, locationTags] = await Promise.all([
      readLocationRows(env),
      readDismissedIds(env),
      readLocationTags(env),
    ]);
    // Checked here rather than at the sweep, so an empty registry reports
    // itself first and this reads as what it is: there are records to serve and
    // no images for any of them. Serving them anyway would pass the content
    // hash and replace a good dataset with a stripped one. On the mods.json
    // path this cannot arise, because merge.js images from its own modsByUid
    // channel and an empty index costs only archives, which have always been
    // allowed to degrade to `[]`.
    if (nexusIndex.size === 0) {
      throw new Error('nexus_cache is empty -- refusing to serve a dataset with no images');
    }
    // No modsByUid call here any more: the sweep has already resolved every
    // published record's images into nexus_cache, including the auto-discovered
    // ones, which are rows like any other under D1.
    const built = materializeFromD1({
      rows, dismissed, tagsDict, nexusNodes, districts, nexusIndex, locationTags, nowMs,
    });
    return { ...built, tagsList, districts };
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
  return { ...built, tagsList, districts };
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
    // One tagged query per tick, shared by the sweep and the build. It throws
    // on failure, which is the existing posture: the catch below keeps
    // last-known-good, flags discovery_stale and alerts.
    const nexusNodes = await fetchTaggedModNodes(fetchImpl);
    const nexusIndex = await sweepNexusCache(env, fetchImpl, nexusNodes, generatedAt);

    // Thumbnails are cosmetic and non-throwing inside this: a failure there
    // leaves some images null for a cycle, it never marks the dataset stale.
    // A D1 read failure, by contrast, throws and lands in the catch below --
    // last-known-good, discovery_stale, alert. Never an empty map.
    const { full, meta, tagsList, districts } = await sourceAndBuild(
      env, fetchImpl, origin, Date.parse(generatedAt), { nexusNodes, nexusIndex },
    );
    const districtsOut = districtsPayload(districts);

    // Each record's shipped .archive file names (installed-mod detection).
    await fillArchives(env, fetchImpl, full, nexusIndex, generatedAt);

    // Hash the content that actually varies (not generated_at). Tags are
    // included so a tags.json edit propagates through the ETag. `full` carries
    // the recently_updated bool, so its clock-driven flips move the ETag;
    // that is deliberate (a location aging past the window must invalidate
    // caches even though nothing on Nexus changed). This is why the cron
    // rebuilds every tick against a fresh clock, with no Nexus short-circuit.
    const version = await contentHash(
      JSON.stringify({ full, districts: districtsOut, tags: tagsList }),
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
      tags: tagsList,
      meta: {
        schema: SCHEMA_VERSION,
        generated_at: generatedAt,
        dataset_version: version,
        skipped: meta.skipped,
        discovery_stale: false,
        last_refresh_at: generatedAt, // liveness heartbeat (see #849)
      },
    });
    if (recovered) await alertRefreshRecovered(env, fetchImpl);
    await checkQuotaThresholds(env, fetchImpl, Date.parse(generatedAt));
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
    await alertRefreshFailed(env, fetchImpl, err);
    return {
      changed: false,
      version: prev?.dataset_version ?? null,
      stale: true,
      error: String(err),
    };
  }
}

export { KEYS };
