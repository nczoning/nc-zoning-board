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

import { fetchTaggedModNodes, modPageUrl } from './nexus.js';
import { materializeFromD1, attachArchives } from './materialize.js';
import { refreshNexusCache, refreshArchives, readNexusIndex } from './nexus-cache.js';
import {
  readModStatuses, readWithheld, WASTEBINNED, ABSENT, MAX_WITHHELD,
} from './nexus-status.js';
import {
  readLocationRows, readDismissedIds, readTags, readLocationTags,
} from './d1.js';
import { districtsPayload } from './districts.js';
import { HEARTBEAT_MIN_INTERVAL_MS } from './config.js';
import {
  KEYS, contentHash, readMeta, writeDataset, writeMeta,
} from './store.js';
import { raiseAlert, alertedSinceUtcMidnight, alertStreak } from './alerts.js';
import { jsonOrThrow } from './json.js';
import { checkQuotaThresholds } from './quota.js';

const SCHEMA_VERSION = 1;

/**
 * Fetch a JSON file from the site origin; throws on non-200, and throws
 * something diagnosable when a 200 turns out not to be JSON.
 *
 * The origin is a Cloudflare Pages site, so "200 with an HTML body" is a real
 * answer it can give: a fallback for a missing asset, or a challenge page. See
 * jsonOrThrow.
 */
async function fetchJson(fetchImpl, origin, path) {
  const url = `${origin}${path}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return jsonOrThrow(res, url);
}

const REFRESH_FAILED_TITLE = 'Data API refresh failed';
const REFRESH_RECOVERED_TITLE = 'Data API refresh recovered';

/**
 * How many consecutive failures before a person is told, and how often after.
 *
 * A single failed tick is almost always an upstream blip that the next tick
 * clears by itself: the dataset never stopped being served, nothing is asked of
 * anyone, and posting it trained everyone to scroll past the channel. Three
 * ticks (~15 min) is long enough that it is not a blip.
 *
 * The repeat matters as much as the threshold. Notifying ONLY on the third
 * would mean an outage lasting all afternoon gets one message at the start and
 * silence after, which reads exactly like a problem that resolved. So it
 * repeats every 36th failure afterwards -- 3 hours at 5-minute ticks.
 */
const REFRESH_FAILURE_NOTIFY_AT = 3;
const REFRESH_FAILURE_NOTIFY_EVERY = 36;

const notifyOnFailureStreak = (n) => n >= REFRESH_FAILURE_NOTIFY_AT
  && (n - REFRESH_FAILURE_NOTIFY_AT) % REFRESH_FAILURE_NOTIFY_EVERY === 0;

/**
 * Refresh failed: keep serving last-known-good and say so.
 *
 * Goes through `raiseAlert` rather than posting to the webhook directly, so the
 * dashboard gets a history row as well as the channel getting a message. That
 * call never throws, which preserves the rule this function has always had:
 * alerting must never mask the original failure.
 *
 * Recorded every time, forwarded to Discord only once the failure has persisted
 * (see the constants above). The row is written either way, so the dashboard
 * and `wrangler tail` still show every single failed tick -- what changes is
 * only whether it interrupts anyone.
 */
async function alertRefreshFailed(env, fetchImpl, reason) {
  // +1 counts THIS failure: the streak is read before the row is written.
  // A D1 failure answering it lands in the catch as `notify: true` -- if the
  // database cannot say whether this is a blip, it is not a blip.
  let streak = null;
  try {
    streak = await alertStreak(env, {
      source: 'refresh', title: REFRESH_FAILED_TITLE, resetTitle: REFRESH_RECOVERED_TITLE,
    }) + 1;
  } catch {
    streak = null;
  }

  await raiseAlert(env, {
    source: 'refresh',
    // warn, not error: the dataset is still being served. A failed refresh
    // degrades freshness (discovery_stale=true) and takes nothing down, which
    // is why this embed has always been amber. `error` is for not serving.
    severity: 'warn',
    title: REFRESH_FAILED_TITLE,
    body: `${String(reason).slice(0, 1200)}\n\nServing last-known-good dataset (discovery_stale=true).`
      + (streak === null ? '' : `\n\nConsecutive failed cycles: ${streak}.`),
    notify: streak === null || notifyOnFailureStreak(streak),
  }, { fetchImpl });
}

/**
 * The previous cycle marked the dataset discovery_stale and this cycle rebuilt
 * it cleanly, so this is the down to up edge. Fires once (the next successful
 * cycle sees discovery_stale=false and stays quiet).
 *
 * Log-only. Nobody is asked to do anything by an all-clear, and the pair of
 * posts ("failed", then "recovered" five minutes later) was the single largest
 * source of channel noise that resolved itself before anyone read it. The row
 * still lands, which is what makes the streak above countable.
 */
async function alertRefreshRecovered(env, fetchImpl) {
  await raiseAlert(env, {
    source: 'refresh',
    severity: 'recovery',
    title: REFRESH_RECOVERED_TITLE,
    body: 'A refresh succeeded after an earlier failure. The dataset is fresh again (discovery_stale=false).',
    notify: false,
  }, { fetchImpl });
}

/**
 * Beyond this many mods flagged on one sweep, say it once instead of once each.
 *
 * Twenty separate embeds is a channel nobody reads afterwards, and a flag this
 * broad is a different story anyway: mods do not go under in batches, so the
 * batch itself is the thing worth looking at.
 */
const STATUS_ALERT_MAX = 5;

/** "Deleted Mod (12345)", or just the id when Nexus never supplied a name. */
const describeMod = (row, id) => (row?.mod_name ? `${row.mod_name} (${id})` : `mod ${id}`);

/** "Cliffside Abode, Kabuki Ripper" -- the pins pointing at the mod. */
const describePins = (row) => (row?.locations?.length
  ? row.locations.map((l) => l.name).join(', ')
  : 'no pins (the location was removed since it was flagged)');

/**
 * What each status means, and what has already happened about it.
 *
 * The three read differently on purpose. A reviewer opening the channel needs
 * to know within one line whether the map has already changed, because that
 * decides whether this is urgent or merely due.
 */
const STATUS_STORY = {
  [WASTEBINNED]: {
    headline: 'deleted from Nexus',
    detail: 'Nexus reports this mod as deleted. Its pin has been WITHHELD from '
      + 'the map automatically, and the record itself is untouched: nothing has '
      + 'edited the location, so nothing needs undoing if this turns out to be '
      + 'wrong. Dismissing the flag in the dashboard puts the pin back.',
  },
  [ABSENT]: {
    headline: 'no longer returned by Nexus',
    detail: 'Nexus has stopped answering about this mod at all, for a day of '
      + 'consecutive sweeps. That is not the same as a deletion, which Nexus '
      + 'states outright, so nothing has changed on the map. It usually means '
      + 'the mod was purged rather than binned.',
  },
  default: {
    headline: 'hidden on Nexus',
    detail: 'The pin is still on the map and nothing here will take it down. '
      + 'Hidden covers an author mid-upload and a moderation hold equally, and '
      + 'the API does not say which: only the reason the author left on the mod '
      + 'page does. Read it, then either hide the record, point it at a '
      + 'successor mod, or dismiss the flag and leave it up.',
  },
};

const storyFor = (status) => STATUS_STORY[status] ?? STATUS_STORY.default;

/**
 * Pinned mods Nexus no longer calls published (#900).
 *
 * Raised here rather than in the sweep for the reason every other alert is:
 * nexus-cache.js does D1 and Nexus, this file does the fan-out. The sweep hands
 * back the ids that crossed their threshold ON THIS TICK, so a mod alerts once
 * and then lives in the dashboard's review list until a person deals with it.
 *
 * `alertedSinceUtcMidnight` is still checked on top of that. The stored
 * `flagged_at` already makes this once-per-run, but two overlapping cron runs
 * would each see the same crossing before either had written, and the alerts
 * table is the only thing that can see across them.
 *
 * Notifies. This is the archetype of an alert that needs a person: nothing here
 * can tell a deletion from a moderation hold from an author mid-upload, only
 * the reason on the mod page can, and until someone reads it the flag sits in
 * the dashboard unresolved.
 *
 * Never throws: an alert about a deleted mod must not cost the dataset a cycle.
 */
async function alertModStatus(env, fetchImpl, flagged, nowMs) {
  const tracked = await readModStatuses(env);
  const byId = new Map(tracked.map((r) => [r.nexus_id, r]));

  if (flagged.length > STATUS_ALERT_MAX) {
    const title = `${flagged.length} pinned mods are no longer published on Nexus`;
    if (await alertedSinceUtcMidnight(env, { source: 'refresh', title }, nowMs)) return;
    await raiseAlert(env, {
      source: 'refresh',
      severity: 'warn',
      title,
      body: `${flagged.map((id) => {
        const row = byId.get(id);
        return `${describeMod(row, id)}: ${storyFor(row?.status).headline}\n${modPageUrl(id)}`;
      }).join('\n\n')}\n\n`
        + `A batch this size is more likely a Nexus change than ${flagged.length} `
        + `separate events, so no more than ${MAX_WITHHELD} pins are ever withheld `
        + 'at once: past that the map is left exactly as it is and this alert is '
        + 'the whole of the response. Check the dashboard.',
      // The cap declining to act means the response IS this alert. Nothing else
      // happens until a person looks.
      notify: true,
    }, { fetchImpl, nowMs });
    return;
  }

  for (const id of flagged) {
    const row = byId.get(id);
    const story = storyFor(row?.status);
    // The title is the dedup key, so it carries the id and the status and
    // nothing that moves between sweeps. The streak belongs in the body:
    // putting it in the title would make every tick a new alert.
    const title = `Pinned mod ${story.headline}: ${id}`;
    if (await alertedSinceUtcMidnight(env, { source: 'refresh', title }, nowMs)) continue;
    await raiseAlert(env, {
      source: 'refresh',
      // `warn` throughout: the dataset is being served either way. A withheld
      // pin is a correct outcome, not a failure, and `error` is for not serving.
      severity: 'warn',
      title,
      body: `${describeMod(row, id)} has been ${story.headline} since `
        + `${row?.first_seen_at ?? 'this sweep'} (${row?.streak ?? 1} consecutive sweeps).\n\n`
        + `${modPageUrl(id)}\n\n`
        + `Pins affected: ${describePins(row)}.\n\n${story.detail}`,
      // Only the reason on the mod page distinguishes these three cases, and
      // the flag stays open until someone reads it.
      notify: true,
    }, { fetchImpl, nowMs });
  }
}

/**
 * A pinned mod is published on Nexus again (#900).
 *
 * The down edge is handled, the up edge was not, and the two are not
 * symmetrical. Withholding reverses itself: the row goes, `readWithheld` stops
 * naming the mod, and the next build serves the pin again with nobody involved.
 * A HIDDEN RECORD DOES NOT. If an admin set `status: hidden` on the location
 * while the mod was down, that is a human write, no sweep will undo it, and
 * this alert is the only moment anyone finds out it can be undone.
 *
 * So the body is written around what is left to do, which is nothing at all in
 * the common case and one edit in the case that would otherwise go unnoticed
 * for as long as nobody happened to look.
 *
 * What is left to do also decides the routing, which severity cannot: this is a
 * `recovery` exactly as `alertRefreshRecovered` is, and sometimes the only
 * notice anyone gets of a hidden record that can now be republished.
 * `hiddenByHand` is the test. Nothing left to do is log-only; a record still
 * hidden notifies, because nothing else raises it again.
 *
 * Mirrors alertRefreshRecovered: same `recovery` severity, same fires-once-on-
 * the-edge shape. Never throws.
 */

/** Pins a person still has to deal with: hidden by hand while the mod was down. */
const hiddenByHand = (r) => (r.locations ?? []).filter((l) => l.status !== 'published');

async function alertModRecovered(env, fetchImpl, recovered, nowMs) {
  if (recovered.length > STATUS_ALERT_MAX) {
    const title = `${recovered.length} pinned mods are published on Nexus again`;
    if (await alertedSinceUtcMidnight(env, { source: 'refresh', title }, nowMs)) return;
    const stillHidden = recovered.filter((r) => hiddenByHand(r).length);
    await raiseAlert(env, {
      source: 'refresh',
      severity: 'recovery',
      title,
      body: `${recovered.map((r) => `${r.nexus_id}: was ${r.was}`).join('\n')}\n\n`
        + 'Any withheld pins are served again from this build. Records that were '
        + 'hidden by hand stay hidden: the registry does not un-hide anything on '
        + 'its own. Check the dashboard.'
        + (stillHidden.length
          ? `\n\n${stillHidden.length} of these still have a record hidden in the `
            + 'registry that only a person can republish.'
          : ''),
      // Same rule as the single case: silent unless a hand-hidden record is
      // waiting, which in a batch means any one of them.
      notify: stillHidden.length > 0,
    }, { fetchImpl, nowMs });
    return;
  }

  for (const r of recovered) {
    const title = `Pinned mod is back on Nexus: ${r.nexus_id}`;
    if (await alertedSinceUtcMidnight(env, { source: 'refresh', title }, nowMs)) continue;

    // The pins a person still has to deal with. `published` needs nothing; a
    // record someone hid while the mod was down is the whole reason this alert
    // exists, and naming it is the difference between a notification and a task.
    const needsAHand = hiddenByHand(r);
    const todo = needsAHand.length
      ? `Still hidden in the registry: ${needsAHand.map((l) => `${l.name} (${l.status})`).join(', ')}.\n`
        + 'Nothing here changes a location\'s status, so that stays as it is until '
        + 'someone republishes the record in the dashboard.'
      : 'Nothing to do. The pin is served again from this build.';

    await raiseAlert(env, {
      source: 'refresh',
      severity: 'recovery',
      title,
      body: `Nexus reports mod ${r.nexus_id} as published again, after `
        + `${storyFor(r.was).headline}.\n\n${modPageUrl(r.nexus_id)}\n\n`
        + `${r.wasWithheld ? 'Its pin was withheld and is restored automatically. ' : ''}`
        + todo,
      // The withheld pin restored itself; a hand-hidden record does not.
      notify: needsAHand.length > 0,
    }, { fetchImpl, nowMs });
  }
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
    // Its own try/catch, INSIDE the one that rethrows: a D1 failure reading the
    // cache must keep last-known-good, and a Discord failure telling someone
    // about a deleted mod must not. Different severities, so they cannot share
    // a catch.
    if (sweep.modStatus?.flagged?.length || sweep.modStatus?.recovered?.length) {
      const parsed = Date.parse(nowIso);
      const nowMs = Number.isFinite(parsed) ? parsed : Date.now();
      try {
        if (sweep.modStatus.flagged?.length) {
          await alertModStatus(env, fetchImpl, sweep.modStatus.flagged, nowMs);
        }
        if (sweep.modStatus.recovered?.length) {
          await alertModRecovered(env, fetchImpl, sweep.modStatus.recovered, nowMs);
        }
      } catch (err) {
        console.warn('mod-status alert failed (non-fatal):', String(err).slice(0, 200));
      }
    }
    return await readNexusIndex(env);
  } catch (err) {
    // D1 is on the critical path: it holds the registry AND the image cache,
    // so a database problem costs freshness, not just archives. Rethrow and
    // let runRefresh keep last-known-good. Swallowing this would serve a
    // dataset with no images, which materializeFromD1 refuses to build anyway.
    throw err;
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
      // `unlisted` is the one to watch: a mod counted here answered without a
      // readable file preview, so it is being retried rather than recorded. A
      // count that does not fall within a day means Nexus stopped publishing
      // manifests for it, and the grace window will store `[]` instead.
      console.log(
        `archives: +${r.fetched} fetched, +${r.seeded} carried over from KV, `
        + `${r.unlisted} awaiting a file listing, ${r.pending} still due, `
        + `${r.written} rows written`,
      );
    }
  } catch (err) {
    console.warn('archive refresh failed (non-fatal):', String(err).slice(0, 200));
  }
  attachArchives(full, index);
}

/**
 * Build the dataset from D1.
 *
 * There is one source. `DATA_SOURCE` is gone: the `mods.json` path, its
 * `buildDataset` merge and the `parity-ab` harness that diffed the two were
 * deleted at Phase 6, once the nightly `data-snapshots` export replaced
 * `data/locations/` as the registry's backup. A config var that could still
 * select the removed path would only be able to select a 404.
 *
 * Subdistricts still come from the site origin; tags come from D1.
 *
 * `nexusNodes` and `nexusIndex` are passed in rather than fetched here: the
 * sweep needs both before this runs, and the tagged query is one of the two
 * expensive calls in the tick.
 */
async function sourceAndBuild(env, fetchImpl, origin, { nexusNodes, nexusIndex }) {
  const subdistricts = await fetchJson(fetchImpl, origin, '/data/subdistricts.json');
  const districts = subdistricts.districts;

  const tagsList = await readTags(env);

  const [rows, dismissed, locationTags] = await Promise.all([
    readLocationRows(env),
    readDismissedIds(env),
    readLocationTags(env),
  ]);
  // Checked here rather than at the sweep, so an empty registry reports itself
  // first and this reads as what it is: there are records to serve and no
  // images for any of them. Serving them anyway would pass the content hash
  // and replace a good dataset with a stripped one.
  if (nexusIndex.size === 0) {
    throw new Error('nexus_cache is empty -- refusing to serve a dataset with no images');
  }
  // Pins whose mod Nexus has confirmed deleted. Read here rather than inside
  // the materializer, which is pure: it is handed the verdict, it does not go
  // and ask. `refused` is the cap having declined to act on an implausible
  // batch, which is a thing to say out loud rather than a quiet no-op.
  const { withhold, refused } = await readWithheld(env);
  if (refused) {
    console.warn(
      `nexus_mod_status: ${refused} pins are flagged as deleted, above the cap of `
      + `${MAX_WITHHELD}. Withholding none of them; the map is unchanged.`,
    );
  }

  // No modsByUid call here: the sweep has already resolved every published
  // record's images into nexus_cache, including the auto-discovered ones,
  // which are rows like any other.
  const built = materializeFromD1({
    rows, dismissed, nexusNodes, districts, nexusIndex, locationTags,
    withheld: withhold,
  });
  if (built.meta.withheld.length) {
    console.log(
      `withheld ${built.meta.withheld.length} pin(s) whose mod is deleted on Nexus: `
      + built.meta.withheld.map((w) => `${w.id} (mod ${w.nexus_id})`).join(', '),
    );
  }
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
  // cron last RUN" signal the freshness monitor watches, distinct from
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
      env, fetchImpl, origin, { nexusNodes, nexusIndex },
    );
    const districtsOut = districtsPayload(districts);

    // Each record's shipped .archive file names (installed-mod detection).
    await fillArchives(env, fetchImpl, full, nexusIndex, generatedAt);

    // Hash the content that actually varies (not generated_at). Tags are
    // included so a tags.json edit propagates through the ETag.
    //
    // `full` is a pure function of the stored data: no field in it depends on
    // what time it is. So an idle tick reproduces the same hash and writes
    // nothing, and the ETag moves only when the data does. Adding a
    // time-derived field back would make every tick a write.
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
    //
    // Logged as well as alerted. A cycle that fails here is invisible in
    // `wrangler tail` otherwise: runRefresh does not rethrow, so the scheduled
    // handler reports the tick as Ok and Discord is the only place the failure
    // appears. That is the wrong way round for anything being debugged.
    console.error('refresh failed, serving last-known-good:', String(err).slice(0, 300));

    let prev = null;
    try {
      prev = await readMeta(env);
    } catch (readErr) {
      console.error('could not read meta:', String(readErr).slice(0, 200));
    }

    // `prev` is null before the first successful cron, and ALSO whenever the
    // KV read comes back empty or unparseable (`get(key, 'json')` answers null
    // for both). Skipping the write in that case is what let three consecutive
    // failures on 2026-08-02 leave `discovery_stale: false` and a frozen
    // `last_refresh_at` behind them: the API reported itself healthy while
    // alerting every five minutes, so the freshness pill and the wedged-cron
    // monitor both stayed quiet. A failure has to be recorded even when there
    // is nothing to merge it into.
    const base = prev ?? {
      schema: SCHEMA_VERSION,
      generated_at: null,
      dataset_version: null,
      skipped: [],
    };

    // Its own try/catch, and BEFORE the alert stays after it: a KV write that
    // throws here must not be able to swallow the notification. The alert is
    // the last line of defence and nothing may run ahead of it that can fail.
    try {
      await writeMeta(env, {
        ...base,
        discovery_stale: true,
        last_error: String(err).slice(0, 300),
        last_error_at: generatedAt,
        // The cron still RAN (an upstream just did not answer), so advance the
        // heartbeat: this reads as "stale data", not as "wedged cron".
        last_refresh_at: generatedAt,
      });
    } catch (metaErr) {
      console.error('could not record the failure in meta:', String(metaErr).slice(0, 200));
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
