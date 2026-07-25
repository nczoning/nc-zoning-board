#!/usr/bin/env node
/**
 * Data API health monitor.
 *
 * Why this exists: /v1 is the website's SOLE data source (the client-side merge
 * fallback was removed in 1.4.1) and the API's primary consumer, in-game mods,
 * has no fallback either. Nothing degrades gracefully any more — an API outage
 * is a total outage, and the only in-app symptom is an empty map. This is the
 * independent alarm: it hits the live API on a schedule and pings Discord
 * (+ fails the workflow run, a second visible signal) when the API isn't
 * actually usable.
 *
 * What it checks per target:
 *   1. GET /v1/health   → 200 and data.status === "ok"   (the Worker is alive),
 *      AND data.refresh_age_seconds within MAX_REFRESH_AGE_S (the cron is not
 *      wedged). A frozen heartbeat pages: serving-but-stale is a real failure.
 *   2. GET /v1/locations → 200 and a non-empty array       (KV populated; not
 *      503 not_ready, not an empty/wiped dataset)
 *   3. GET /v1/meta      → discovery_stale is reported as CONTEXT only, not a
 *      hard fail: the cron already Discord-alerts on refresh failure, and it's
 *      still serving last-known-good, so it's a warning, not an outage.
 *
 * FRESHNESS vs LIVENESS: envelope.generated_at is NOT a liveness signal — the
 * cron only rewrites it when the dataset CONTENT changes (a few times a day), so
 * a healthy-but-idle API legitimately has an hours-old generated_at. The signal
 * we watch is /v1/health's last_refresh_at (→ refresh_age_seconds). If it stops
 * advancing, scheduled() has stopped executing and the API is silently serving
 * stale data (issue #849).
 *
 * The heartbeat is stamped on every changed or failed cycle, but at most every
 * HEARTBEAT_MIN_INTERVAL_MS on an unchanged one — an unchanged tick has no other
 * reason to write KV, and the free tier bills writes per account. So a HEALTHY
 * idle cron reports an age of up to that interval by design, which is why
 * MAX_REFRESH_AGE_S sits well above it. The two are one parameter pair.
 *
 * SELF-HEAL (#849 Phase 2): a redeploy re-registers the Cron Trigger and revives
 * a wedged cron, so on detected staleness the script dispatches deploy-api.yml on
 * the matching ref (main → prod, dev → staging), budget-guarded to
 * SELF_HEAL_MAX_PER_HOUR redeploys per env per rolling hour before it stops and
 * escalates for a human. Off unless API_HEALTH_SELF_HEAL=true with a GH token,
 * so local/detect-only runs are unaffected.
 *
 * Run: node scripts/monitor_api_health.js
 * Targets: API_HEALTH_TARGETS (comma-separated), default https://api.nczoning.net
 * Alerts:  NCZ_ALERTS_DISCORD_WEBHOOK_URL, the dedicated map-alerts channel,
 *          kept separate from the submissions webhook (prints a preview instead
 *          of sending if unset).
 * Self-heal env: API_HEALTH_SELF_HEAL=true + GH_TOKEN (+ GITHUB_REPOSITORY,
 *          GITHUB_API_URL — set by Actions). Absent → alert only.
 * Exit:    0 when every target is serving fresh data; 1 on any outage, a wedged
 *          cron, or an infra error (so the Actions run goes red too).
 */

const DEFAULT_TARGETS = ["https://api.nczoning.net"];
const RETRIES = 3;        // transient blips shouldn't page anyone
const RETRY_DELAY_MS = 4000;
const FETCH_TIMEOUT_MS = 15000;
// A cron heartbeat older than this means the 5-min refresh has wedged (#849).
//
// PAIRED CONSTANT: on an unchanged tick the Worker writes the heartbeat at most
// every HEARTBEAT_MIN_INTERVAL_MS (worker/src/config.js, currently 15 min), so a
// perfectly healthy idle cron reports an age of up to 15 min by design. This
// threshold must stay comfortably above that — 45 min = 3x — or a healthy cron
// pages the alerts channel AND trips the self-heal redeploy below. Never change
// one of the two without the other.
const MAX_REFRESH_AGE_S = 45 * 60;

// ── Self-heal (#849 Phase 2) ────────────────────────────────────────────────
// A redeploy re-registers the Cron Trigger and reliably revives a wedged cron,
// so on detected staleness we dispatch deploy-api.yml on the matching ref. Off
// unless API_HEALTH_SELF_HEAL=true AND a GH token is present (so local runs and
// the Phase-1 detect-only posture are unaffected). Dispatch uses the workflow's
// GITHUB_TOKEN — workflow_dispatch is the one event GITHUB_TOKEN may fire that
// still creates a run, so no PAT is needed (it does need `actions: write`).
const SELF_HEAL_WORKFLOW = "deploy-api.yml";
// Each monitored target's hostname → the deploy ref that redeploys it.
// deploy-api.yml gates the env off the ref (main → production, dev → staging), so
// dispatching on the ref ships the CORRECT code to each env (a bare
// `wrangler deploy` from here would push main's code to staging). Overridable via
// API_HEALTH_SELF_HEAL_MAP (JSON) so the mapping can change without a code edit.
// Keyed by hostname, and only ever consulted for a target that came back stale —
// so the staging entry is inert while api-dev is off API_HEALTH_TARGETS. It is
// kept for the case where staging is temporarily monitored again (e.g. while
// testing a cron change); note that staging normally has NO cron, so a frozen
// heartbeat there is expected and redeploying would not "fix" it.
const DEFAULT_SELF_HEAL_TARGETS = {
  "api.nczoning.net": { env: "production", ref: "main" },
  "api-dev.nczoning.net": { env: "staging", ref: "dev" },
};
const SELF_HEAL_TARGETS = (() => {
  const raw = process.env.API_HEALTH_SELF_HEAL_MAP;
  if (!raw) return DEFAULT_SELF_HEAL_TARGETS;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`API_HEALTH_SELF_HEAL_MAP is not valid JSON (${err.message}) — using defaults`);
    return DEFAULT_SELF_HEAL_TARGETS;
  }
})();
// Redeploys per env per rolling hour before we stop and escalate to a human, so
// a redeploy that doesn't fix it can't loop and mask a real outage. A prior
// MANUAL deploy counts too (event=workflow_dispatch), so a hands-on fix pauses
// the auto-heal. Normal push-triggered deploys are event=push and don't count.
const SELF_HEAL_MAX_PER_HOUR = 2;
// Actions sets GITHUB_API_URL; the override also lets tests point at a mock.
const GH_API = process.env.GITHUB_API_URL || "https://api.github.com";

// Request headers for the probe.
//
// This monitor was once 403'd on every run: the zone ran Cloudflare's free Bot
// Fight Mode, which managed-challenges automated clients from datacentre IPs
// (the GitHub Actions runner, ASN 8075), a false "outage" for a fully-healthy
// API. It keyed on the request being non-interactive automation, NOT the UA
// string, so a browser-UA disguise did nothing (verified: BFM still challenged
// the Chrome UA). BFM is fundamentally incompatible with an Actions-based probe
// and its protective value on a public read-only API is nil, so it was disabled
// zone-wide (a /v1 rate-limit rule is the compensating control; DDoS + WAF stay
// on). With BFM off the UA is unchallenged, so keep the honest, self-describing
// one, and keep X-Health-Probe as a stable, spoof-resistant identifier for CF
// logs / a future rate-limit exception.
const PROBE_HEADERS = {
  "User-Agent": "nczoning-health-monitor",
  "X-Health-Probe": "nczoning-health-monitor",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: PROBE_HEADERS });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body; leave null */ }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// Retry a check until it passes or RETRIES is exhausted. `check` returns null
// on success or a string describing the failure.
async function withRetry(label, check) {
  let last = "unknown";
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const problem = await check();
      if (!problem) return null;
      last = problem;
    } catch (err) {
      last = err.name === "AbortError" ? `timeout after ${FETCH_TIMEOUT_MS}ms` : err.message;
    }
    if (attempt < RETRIES) {
      console.log(`  ${label}: attempt ${attempt} failed (${last}) — retrying`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  return last;
}

async function checkTarget(base) {
  const issues = [];   // hard failures → outage (not serving)
  const warnings = []; // soft (informational) signals
  let stale = null;    // cron heartbeat frozen → page, but serving (see #849)

  // One /v1/health fetch gives BOTH liveness (status ok?) and the cron heartbeat
  // (refresh_age_seconds). Captured on success for the freshness check below.
  let health = null;
  const healthProblem = await withRetry("health", async () => {
    const { ok, status, json } = await fetchJson(`${base}/v1/health`);
    if (!ok) return `HTTP ${status}`;
    if (json?.data?.status !== "ok") return `status=${JSON.stringify(json?.data?.status)}`;
    health = json.data;
    return null;
  });
  if (healthProblem) issues.push(`/v1/health unreachable (${healthProblem})`);

  // Freshness / liveness — only meaningful when /v1/health answered. The
  // heartbeat advances every cron tick (unlike the content-driven generated_at),
  // so an old age means the cron has WEDGED and the API is silently serving a
  // frozen snapshot (issue #849). This pages: serving-but-stale is a real
  // failure for the fallback-less in-game consumer. A null/absent heartbeat
  // (pre-first-cron, or an API deployed before this field existed) is "unknown",
  // never stale — it must not page.
  const age = health?.refresh_age_seconds;
  if (typeof age === "number" && age > MAX_REFRESH_AGE_S) {
    // State the fact only — remediation (auto-redeploy vs manual) is context that
    // the alert description fills in, so it isn't stale/contradictory here.
    stale = `cron heartbeat frozen — last refresh ${Math.round(age / 60)} min ago (threshold ${MAX_REFRESH_AGE_S / 60} min)`;
  }

  const locationsProblem = await withRetry("locations", async () => {
    const { ok, status, json } = await fetchJson(`${base}/v1/locations`);
    if (!ok) return status === 503 ? "503 not_ready (dataset not built)" : `HTTP ${status}`;
    if (!Array.isArray(json?.data)) return "data is not an array";
    if (json.data.length === 0) return "dataset is empty";
    return null;
  });
  if (locationsProblem) issues.push(`/v1/locations not serving data (${locationsProblem})`);

  // discovery_stale is context, not an outage; the cron self-alerts on it.
  try {
    const { ok, json } = await fetchJson(`${base}/v1/meta`);
    if (ok && json?.data?.discovery_stale) {
      warnings.push("discovery_stale=true (last Nexus refresh failed; serving last-known-good)");
    }
  } catch { /* meta is best-effort context */ }

  return { base, issues, warnings, stale };
}

// ── Self-heal implementation ────────────────────────────────────────────────

/** True only when self-heal is enabled AND we have what we need to call the API. */
function selfHealEnabled() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return process.env.API_HEALTH_SELF_HEAL === "true" && !!token && !!process.env.GITHUB_REPOSITORY;
}

/** GitHub REST call against the current repo, authed with the workflow token. */
async function ghApi(path, init = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`${GH_API}/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nczoning-health-monitor",
      ...(init.headers || {}),
    },
  });
  return res;
}

/**
 * Count deploy-api.yml runs redeployed for `ref` via workflow_dispatch in the
 * last hour — the rolling budget the loop guard checks. Counts manual dispatches
 * too; excludes push-triggered deploys (event filter). Throws on an API error so
 * the caller escalates rather than redeploying blind.
 */
async function recentSelfHealCount(ref) {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const query = `event=workflow_dispatch&branch=${encodeURIComponent(ref)}` +
    `&created=${encodeURIComponent(`>=${sinceIso}`)}&per_page=100`;
  const res = await ghApi(`/actions/workflows/${SELF_HEAL_WORKFLOW}/runs?${query}`);
  if (!res.ok) throw new Error(`runs list HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return (json.workflow_runs || []).length;
}

/** Dispatch deploy-api.yml on `ref` (main → prod, dev → staging). Throws on error. */
async function dispatchRedeploy(ref) {
  const res = await ghApi(`/actions/workflows/${SELF_HEAL_WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref }),
  });
  if (!res.ok) throw new Error(`dispatch HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * For each stale target, redeploy its Worker (revives the cron) unless the
 * rolling-hour budget is spent, in which case escalate for a human. Returns
 * { healed:[{env,ref,attempt}], escalated:[{env,ref,reason}] } for the alert.
 * Any per-env API failure escalates that env rather than silently doing nothing.
 */
async function selfHeal(results) {
  const healed = [];
  const escalated = [];
  for (const r of results.filter((t) => t.stale)) {
    const host = new URL(r.base).hostname;
    const cfg = SELF_HEAL_TARGETS[host];
    if (!cfg) {
      console.log(`  self-heal: no deploy mapping for ${host} — cannot redeploy`);
      escalated.push({ env: host, ref: null, reason: "no deploy mapping for this target" });
      continue;
    }
    try {
      const count = await recentSelfHealCount(cfg.ref);
      if (count >= SELF_HEAL_MAX_PER_HOUR) {
        console.log(`  self-heal: ${cfg.env} budget spent (${count}/${SELF_HEAL_MAX_PER_HOUR} this hour) — escalating`);
        escalated.push({ ...cfg, reason: `${count} redeploy(s) in the last hour did not clear it` });
        continue;
      }
      await dispatchRedeploy(cfg.ref);
      console.log(`  self-heal: redeployed ${cfg.env} (attempt ${count + 1}/${SELF_HEAL_MAX_PER_HOUR})`);
      healed.push({ ...cfg, attempt: count + 1 });
    } catch (err) {
      console.error(`  self-heal: ${cfg.env} failed — ${err.message}`);
      escalated.push({ ...cfg, reason: `redeploy could not be dispatched (${err.message})` });
    }
  }
  return { healed, escalated };
}

// `recovered` = the previous run reported an outage and this one is clean, so
// this post is the down→up edge (a green all-clear) rather than a page.
// `selfHeal` = { healed, escalated } from an auto-redeploy attempt this run.
async function postDiscord(results, { recovered = false, selfHeal: heal = null } = {}) {
  const url = process.env.NCZ_ALERTS_DISCORD_WEBHOOK_URL;
  const down = results.filter((r) => r.issues.length);
  const frozen = results.filter((r) => r.stale);
  const anyWarning = results.some((r) => r.warnings.length);

  // Self-heal outcome lines, folded into whichever alert fires this run so it's
  // one post: what we redeployed, and what needs a human.
  const healLines = [
    ...(heal?.healed || []).map(
      (h) => `🔧 **Self-heal:** redeployed **${h.env}** to revive the cron (attempt ${h.attempt}/${SELF_HEAL_MAX_PER_HOUR}) — should recover next tick.`,
    ),
    ...(heal?.escalated || []).map(
      (e) => `⛔ **Manual fix needed (${e.env}):** ${e.reason}. Redeploy: \`wrangler deploy${e.ref === "dev" ? " --env staging" : ""}\`.`,
    ),
  ];
  const escalatedAny = (heal?.escalated || []).length > 0;

  const fields = results
    .filter((r) => r.issues.length || r.stale || r.warnings.length)
    .map((r) => ({
      name: `${r.issues.length ? "🔴" : r.stale ? "🟠" : "🟡"} ${r.base}`,
      value: [
        ...r.issues.map((i) => `• **OUTAGE:** ${i}`),
        ...(r.stale ? [`• **STALE:** ${r.stale}`] : []),
        ...r.warnings.map((w) => `• ${w}`),
      ].join("\n"),
    }));

  // Headlines in severity order: outage (not serving, page), escalated self-heal
  // (auto-redeploy exhausted/failed — a human must act, page RED), stale (cron
  // wedged but auto-heal dispatched, page ORANGE), recovery (all-clear edge),
  // warning (soft). Outage wins if anything is down; recovery only applies when
  // this run is fully clean (no outage AND no staleness).
  let title, description, color;
  if (down.length) {
    title = `🔴 Data API outage — ${down.length} environment${down.length === 1 ? "" : "s"} not serving`;
    description =
      "The API is not usable by consumers (in-game mods have no fallback). " +
      "The website may look fine via its client-side fallback — this is that hidden failure surfacing.";
    color = 15158332; /* red */
  } else if (frozen.length && escalatedAny) {
    const n = heal.escalated.length;
    title = `🔴 Data API stale — self-heal exhausted on ${n} environment${n === 1 ? "" : "s"}`;
    description =
      "The refresh cron is wedged and automatic redeploys have not cleared it — " +
      "manual intervention is needed (see below). Consumers are being served a frozen snapshot.";
    color = 15158332; /* red */
  } else if (frozen.length) {
    title = `🟠 Data API stale — refresh cron wedged on ${frozen.length} environment${frozen.length === 1 ? "" : "s"}`;
    description =
      "The API is still serving, but its 5-minute refresh cron has stopped advancing, " +
      "so consumers (in-game mods have no fallback) are getting a frozen snapshot. See issue #849." +
      (heal ? "" : " Interim fix: redeploy the Worker to revive the cron.");
    color = 16753920; /* orange */
  } else if (recovered) {
    title = `✅ Data API recovered — serving normally again`;
    description =
      "The earlier outage has cleared: every target is serving again." +
      (anyWarning ? " One soft signal is still active (see below)." : "");
    color = 3066993; /* green */
  } else {
    title = `🟠 Data API warning`;
    description = "The API is serving but a soft signal fired (see below).";
    color = 15105570; /* amber */
  }

  // Fold the self-heal outcome into the alert body (one post per run).
  if (healLines.length) description += `\n\n${healLines.join("\n")}`;

  const body = {
    embeds: [
      {
        title,
        description,
        color,
        fields,
        footer: { text: "NC Zoning Board • Data API health monitor" },
      },
    ],
  };

  if (!url) {
    console.log("\n--- NCZ_ALERTS_DISCORD_WEBHOOK_URL not set — preview of payload that would be sent ---");
    console.log(JSON.stringify(body, null, 2));
    console.log("--- end preview (nothing was sent) ---");
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Discord webhook HTTP ${res.status}: ${await res.text()}`);
  console.log("Posted Discord health alert.");
}

(async () => {
  try {
    const targets = (process.env.API_HEALTH_TARGETS || DEFAULT_TARGETS.join(","))
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean);

    console.log(`Checking ${targets.length} target(s): ${targets.join(", ")}`);
    const results = [];
    for (const base of targets) {
      console.log(`\n${base}`);
      const r = await checkTarget(base);
      results.push(r);
      if (r.issues.length) console.log(`  ❌ OUTAGE: ${r.issues.join("; ")}`);
      else if (r.stale) console.log(`  🟠 STALE: ${r.stale}`);
      else console.log("  ✅ serving");
      for (const w of r.warnings) console.log(`  ⚠️  ${w}`);
    }

    const anyOutage = results.some((r) => r.issues.length);
    const anyStale = results.some((r) => r.stale);
    const anyWarning = results.some((r) => r.warnings.length);

    // Self-heal: a wedged cron is revived by a redeploy (#849 Phase 2). Only
    // acts on staleness (not a not-serving outage — a redeploy won't fix that),
    // and only when enabled with a usable GH token. Budget-guarded per env.
    let heal = null;
    if (anyStale) {
      if (selfHealEnabled()) {
        console.log("\nSelf-heal: attempting to revive wedged cron(s) via redeploy…");
        heal = await selfHeal(results);
      } else if (process.env.API_HEALTH_SELF_HEAL === "true") {
        console.log("\nSelf-heal enabled but no GH token / repo in env — skipping (alert only).");
      }
    }

    // The previous run's conclusion IS the last health state: this script
    // exits 1 on an outage (Actions run → failure) and 0 when serving
    // (→ success). The workflow reads that conclusion and passes it in, so a
    // clean run that follows a failed one is the recovery edge: announce the
    // all-clear ONCE (next run sees success and stays quiet). A prior infra
    // error also lands here as "was down"; a reassuring green after it is
    // harmless. Absent the flag (local run, first ever run) → no false edge.
    // A prior run that exited 1 for EITHER a not-serving outage or a wedged cron
    // counts as "was down"; a fully clean run after it is the recovery edge.
    const prevOutage = process.env.API_HEALTH_PREV_OUTAGE === "true";
    const recovered = prevOutage && !anyOutage && !anyStale;

    if (anyOutage || anyStale || anyWarning || recovered) await postDiscord(results, { recovered, selfHeal: heal });

    if (anyOutage || anyStale) {
      console.error(
        anyOutage
          ? "\nHealth check FAILED — at least one target is not serving."
          : "\nHealth check FAILED — at least one target's refresh cron is wedged (stale data).",
      );
      process.exitCode = 1;
    } else {
      console.log(recovered ? "\nAll targets healthy — recovered from prior outage." : "\nAll targets healthy.");
    }
  } catch (err) {
    console.error("Health monitor failed (infrastructure error):", err.message);
    process.exitCode = 1;
  }
})();
// NOTE: we set process.exitCode and let the event loop drain rather than calling
// process.exit(), which can trip a libuv assertion on Windows when fetch's
// keep-alive sockets are still closing.
