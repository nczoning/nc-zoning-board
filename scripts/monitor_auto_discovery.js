#!/usr/bin/env node
/**
 * Auto-discovery health monitor.
 *
 * Purpose: catch NCZoning-tagged mods that AREN'T showing on the map because
 * their metadata block is missing or unparseable, so a broken block is caught
 * within a day instead of when an author complains.
 *
 * Since B7 the block parsing + merge runs SERVER-SIDE (the Data API cron), and
 * the API exposes the result at `/v1/meta.skipped`: every mod tagged NCZoning
 * that isn't excluded, isn't a manual entry, and whose block didn't parse:
 * exactly the "tagged but not on the map" set. Reading that instead of
 * re-parsing client-side means ONE source of truth (no client/server parser
 * drift) and no live Nexus fetch. Before B7 this script ran the client-side
 * `assets/js/utils.js` parser directly; that parser is now only the site's
 * fallback, so testing it here would drift from what actually builds the map.
 *
 * Run: node scripts/monitor_auto_discovery.js
 * Target: API_META_URL (default https://api.nczoning.net/v1/meta)
 * Alerts: NCZ_ALERTS_DISCORD_WEBHOOK_URL, the dedicated map-alerts channel,
 *         separate from submissions (prints a preview instead if unset).
 * Exit 0 on a clean run OR flagged mods (it's a report, not a gate); exit 1
 * only on an infrastructure error.
 */

const API_META_URL = process.env.API_META_URL || "https://api.nczoning.net/v1/meta";
const NEXUS_MOD_URL = (id) => `https://www.nexusmods.com/cyberpunk2077/mods/${id}`;

async function postDiscord(skipped) {
  const url = process.env.NCZ_ALERTS_DISCORD_WEBHOOK_URL;
  const MAX = 12;
  const n = skipped.length;
  const lines = skipped
    .slice(0, MAX)
    .map((m) => `• [${m.name || "Unknown"}](${NEXUS_MOD_URL(m.nexus_id)}) — \`${m.nexus_id}\``);
  if (n > MAX) lines.push(`…and ${n - MAX} more.`);

  const body = {
    embeds: [
      {
        title: `⚠️ Auto-discovery: ${n} NCZoning mod${n === 1 ? "" : "s"} tagged but not on the map`,
        description:
          `${n} mod${n === 1 ? " is" : "s are"} tagged **NCZoning** on Nexus but the ` +
          `Data API skipped ${n === 1 ? "it" : "them"}: the metadata block is missing or ` +
          `didn't parse. **Action:** ask the author to submit the location through the form ` +
          `on the site, add a registry entry if it belongs on the map, or add the id to ` +
          `\`data/excluded_mods.json\` to stop this alert.\n\n` +
          lines.join("\n"),
        color: 15105570, // amber/orange: warning, not error
        footer: { text: "NC Zoning Board • source: /v1/meta.skipped" },
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
  console.log(`Posted Discord alert for ${n} skipped mod(s).`);
}

(async () => {
  try {
    const res = await fetch(API_META_URL, { headers: { "User-Agent": "nczoning-auto-discovery-monitor" } });
    if (!res.ok) throw new Error(`GET ${API_META_URL} → HTTP ${res.status}`);
    const json = await res.json();

    const skipped = json?.data?.skipped;
    if (!Array.isArray(skipped)) throw new Error("meta.skipped missing or not an array");

    if (json.data.discovery_stale) {
      // Still worth reporting: the last-known-good skipped list is what the map reflects.
      console.log("Note: discovery_stale=true — the API is serving last-known-good data.");
    }

    if (skipped.length === 0) {
      console.log("✅ No NCZoning-tagged mods skipped — all parse cleanly.");
      return; // exitCode stays 0
    }

    console.log(`❌ ${skipped.length} tagged mod(s) skipped by the API:`);
    for (const m of skipped) console.log(`   - ${m.nexus_id}  ${m.name}`);
    await postDiscord(skipped);
    // exitCode stays 0: this is a report, not a gate.
  } catch (err) {
    console.error("Monitor failed (infrastructure error):", err.message);
    process.exitCode = 1;
  }
})();
// NOTE: we set process.exitCode and let the event loop drain rather than calling
// process.exit(), which can trip a libuv assertion on Windows when fetch's
// keep-alive sockets are still closing.
