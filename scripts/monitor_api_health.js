#!/usr/bin/env node
/**
 * Data API health monitor.
 *
 * Why this exists: the website consumes /v1 with a graceful fallback to the
 * client-side merge (B7), and the API's PRIMARY consumer (in-game mods) has
 * NO fallback at all. So a silent website fallback would MASK an API outage:
 * the map looks fine while the mods are broken. This is the independent alarm
 * that closes that gap. It hits the live API on a schedule and pings Discord
 * (+ fails the workflow run, a second visible signal) when the API isn't
 * actually usable.
 *
 * What it checks per target:
 *   1. GET /v1/health   → 200 and data.status === "ok"   (the Worker is alive)
 *   2. GET /v1/locations → 200 and a non-empty array       (KV populated; not
 *      503 not_ready, not an empty/wiped dataset)
 *   3. GET /v1/meta      → discovery_stale is reported as CONTEXT only, not a
 *      hard fail: the cron already Discord-alerts on refresh failure, and it's
 *      still serving last-known-good, so it's a warning, not an outage.
 *
 * NOTE: envelope.generated_at is deliberately NOT used as a freshness/liveness
 * signal: the cron only rewrites it when the dataset CONTENT changes (a few
 * times a day), so a healthy-but-idle API legitimately has an hours-old
 * generated_at. There is no served "last cron ran" timestamp to check.
 *
 * Run: node scripts/monitor_api_health.js
 * Targets: API_HEALTH_TARGETS (comma-separated), default https://api.nczoning.net
 * Alerts:  NCZ_ALERTS_DISCORD_WEBHOOK_URL, the dedicated map-alerts channel,
 *          kept separate from the submissions webhook (prints a preview instead
 *          of sending if unset).
 * Exit:    0 when every target is serving; 1 on any outage or infra error
 *          (so the Actions run goes red, a second signal beside Discord).
 */

const DEFAULT_TARGETS = ["https://api.nczoning.net"];
const RETRIES = 3;        // transient blips shouldn't page anyone
const RETRY_DELAY_MS = 4000;
const FETCH_TIMEOUT_MS = 15000;

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
  const issues = [];   // hard failures → outage
  const warnings = []; // soft (informational) signals

  const healthProblem = await withRetry("health", async () => {
    const { ok, status, json } = await fetchJson(`${base}/v1/health`);
    if (!ok) return `HTTP ${status}`;
    if (json?.data?.status !== "ok") return `status=${JSON.stringify(json?.data?.status)}`;
    return null;
  });
  if (healthProblem) issues.push(`/v1/health unreachable (${healthProblem})`);

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

  return { base, issues, warnings };
}

// `recovered` = the previous run reported an outage and this one is clean, so
// this post is the down→up edge (a green all-clear) rather than a page.
async function postDiscord(results, { recovered = false } = {}) {
  const url = process.env.NCZ_ALERTS_DISCORD_WEBHOOK_URL;
  const down = results.filter((r) => r.issues.length);
  const anyWarning = results.some((r) => r.warnings.length);

  const fields = results
    .filter((r) => r.issues.length || r.warnings.length)
    .map((r) => ({
      name: `${r.issues.length ? "🔴" : "🟠"} ${r.base}`,
      value: [
        ...r.issues.map((i) => `• **OUTAGE:** ${i}`),
        ...r.warnings.map((w) => `• ${w}`),
      ].join("\n"),
    }));

  // Three headlines: outage (page), recovery (all-clear edge), warning (soft).
  // Outage wins if anything is currently down; recovery only applies when
  // this run is fully clean.
  let title, description, color;
  if (down.length) {
    title = `🔴 Data API outage — ${down.length} environment${down.length === 1 ? "" : "s"} not serving`;
    description =
      "The API is not usable by consumers (in-game mods have no fallback). " +
      "The website may look fine via its client-side fallback — this is that hidden failure surfacing.";
    color = 15158332; /* red */
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
      else console.log("  ✅ serving");
      for (const w of r.warnings) console.log(`  ⚠️  ${w}`);
    }

    const anyOutage = results.some((r) => r.issues.length);
    const anyWarning = results.some((r) => r.warnings.length);

    // The previous run's conclusion IS the last health state: this script
    // exits 1 on an outage (Actions run → failure) and 0 when serving
    // (→ success). The workflow reads that conclusion and passes it in, so a
    // clean run that follows a failed one is the recovery edge: announce the
    // all-clear ONCE (next run sees success and stays quiet). A prior infra
    // error also lands here as "was down"; a reassuring green after it is
    // harmless. Absent the flag (local run, first ever run) → no false edge.
    const prevOutage = process.env.API_HEALTH_PREV_OUTAGE === "true";
    const recovered = prevOutage && !anyOutage;

    if (anyOutage || anyWarning || recovered) await postDiscord(results, { recovered });

    if (anyOutage) {
      console.error("\nHealth check FAILED — at least one target is not serving.");
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
