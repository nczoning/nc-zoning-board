#!/usr/bin/env node
/**
 * Auto-discovery health monitor.
 *
 * Why this exists and not a unit test: auto-discovered pins are parsed
 * client-side from *live* Nexus descriptions that authors add at any
 * time, and a parse failure is silent (a console.log nobody reads). A
 * fixture test only catches us regressing a *known* case on a parser
 * edit; it cannot catch a new author pasting a format we've never seen.
 * So this runs on a schedule against live data, importing the **real
 * production parser** (`assets/js/utils.js` → `parseNcZoningBlock`) so
 * it can never drift from what users actually experience.
 *
 * Run: node scripts/monitor_auto_discovery.js
 * Posts a Discord embed (DISCORD_WEBHOOK_URL) only when ≥1 NCZoning-
 * tagged mod fails to parse and isn't covered by a manual registry
 * entry. Exit 0 on a clean run OR detected-bad-mods (it's a report,
 * not a gate); exit 1 only on an infrastructure error.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NEXUS_MOD_URL = (id) => `https://www.nexusmods.com/cyberpunk2077/mods/${id}`;

// --- Load the real production parser (drift-proof by construction) -----------
function loadParser() {
  const src = fs.readFileSync(path.join(ROOT, "assets/js/utils.js"), "utf8");
  const NCZ = {};
  // utils.js assigns onto a bare `NCZ`; parseNcZoningBlock is self-contained
  // (regex + the validTagNames Set), so no other NCZ members are needed.
  new Function("NCZ", src)(NCZ);
  if (typeof NCZ.parseNcZoningBlock !== "function") {
    throw new Error("parseNcZoningBlock not found after loading assets/js/utils.js");
  }
  return NCZ.parseNcZoningBlock;
}

// --- Pull stable Nexus constants from constants.js source (no eval) ----------
function loadNexusConstants() {
  const src = fs.readFileSync(path.join(ROOT, "assets/js/constants.js"), "utf8");
  const num = (name, fallback) => {
    const m = src.match(new RegExp(`NCZ\\.${name}\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : fallback;
  };
  const str = (name, fallback) => {
    const m = src.match(new RegExp(`NCZ\\.${name}\\s*=\\s*["']([^"']+)["']`));
    return m ? m[1] : fallback;
  };
  return {
    endpoint: str("NEXUS_GQL_ENDPOINT", "https://api.nexusmods.com/v2/graphql"),
    gameId: num("NEXUS_GAME_ID", 3333),
    batchSize: num("NEXUS_BATCH_SIZE", 50),
  };
}

// --- Valid tag names (data/tags.json is a flat { id: description } object) ---
function loadValidTagNames() {
  const tags = JSON.parse(fs.readFileSync(path.join(ROOT, "data/tags.json"), "utf8"));
  return new Set(Object.keys(tags));
}

// --- Manually-registered numeric nexus_ids (mirror services.js precedence) ---
// A tagged mod that's also in the manual registry intentionally may have no
// parseable block — manual data wins — so excluding it avoids false alarms.
function loadManualNexusIds() {
  const dir = path.join(ROOT, "data/locations");
  const ids = new Set();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const mod = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (/^\d+$/.test(String(mod.nexus_id))) ids.add(String(mod.nexus_id));
    } catch {
      /* a malformed location file is validate-mods.yml's problem, not ours */
    }
  }
  return ids;
}

// --- Fetch every NCZoning-tagged mod (same query/pagination as services.js) --
async function fetchTaggedMods({ endpoint, gameId, batchSize }) {
  const query = `
    query NCZoningMods($filter: ModsFilter!, $count: Int!, $offset: Int!) {
      mods(filter: $filter, count: $count, offset: $offset) {
        nodes { modId name description }
        totalCount
      }
    }`;
  const out = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: {
          filter: {
            gameId: [{ value: String(gameId) }],
            tag: [{ value: "NCZoning" }],
          },
          count: batchSize,
          offset,
        },
      }),
    });
    if (!res.ok) throw new Error(`Nexus API HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(`Nexus API errors: ${JSON.stringify(json.errors)}`);
    const page = json?.data?.mods;
    if (!page) throw new Error("Nexus API: no mods page in response");
    total = page.totalCount ?? 0;
    const nodes = page.nodes || [];
    out.push(...nodes);
    if (nodes.length === 0 || nodes.length < batchSize) break;
    offset += nodes.length;
  }
  return out;
}

async function postDiscord(failures, total) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.log("DISCORD_WEBHOOK_URL not set — skipping notification (local run).");
    return;
  }
  const MAX_PER_GROUP = 12;
  const fmt = (group) => {
    const lines = group
      .slice(0, MAX_PER_GROUP)
      .map((f) => `• [${f.name || "Unknown"}](${NEXUS_MOD_URL(f.modId)}) — \`${f.modId}\``);
    if (group.length > MAX_PER_GROUP) lines.push(`…and ${group.length - MAX_PER_GROUP} more.`);
    return lines.join("\n");
  };

  // Two distinct signals — keep them separate so the alert is actionable:
  // a broken block needs the author to fix it; a missing block may just be
  // a speculative/mistaken tag or an author who never finished setup.
  const malformed = failures.filter((f) => f.attemptedBlock);
  const noBlock = failures.filter((f) => !f.attemptedBlock);

  const fields = [];
  if (malformed.length) {
    fields.push({
      name: `🔧 Malformed block — ${malformed.length} (author tried, parse failed)`,
      value: fmt(malformed),
    });
  }
  if (noBlock.length) {
    fields.push({
      name: `🏷️ Tagged, no block — ${noBlock.length} (no NCZoning: in description)`,
      value: fmt(noBlock),
    });
  }

  const body = {
    embeds: [
      {
        title: `⚠️ Auto-discovery: ${failures.length} NCZoning mod(s) missing from the map`,
        description:
          `Tagged **NCZoning** on Nexus but not appearing as live pins. ` +
          `Malformed blocks need an author fix; no-block tags may be ` +
          `mistaken or incomplete.`,
        color: 15105570, // amber/orange — warning, not error
        fields,
        footer: { text: `NC Zoning Board • ${total} tagged mods scanned` },
      },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook HTTP ${res.status}: ${await res.text()}`);
  }
  console.log(`Posted Discord alert for ${failures.length} unparseable mod(s).`);
}

(async () => {
  try {
    const parse = loadParser();
    const consts = loadNexusConstants();
    const validTagNames = loadValidTagNames();
    const manualIds = loadManualNexusIds();

    const mods = await fetchTaggedMods(consts);
    console.log(`Scanned ${mods.length} NCZoning-tagged mods (${manualIds.size} manual ids excluded).`);

    const failures = [];
    for (const mod of mods) {
      const id = String(mod.modId);
      if (manualIds.has(id)) continue; // manual registry covers it
      if (!parse(mod.description, validTagNames)) {
        // A `NCZoning` mention means the author attempted a block that
        // failed to parse (actionable: fix it) vs. no block at all
        // (a bare/mistaken tag).
        const attemptedBlock = /NCZoning/i.test(mod.description || "");
        failures.push({ modId: id, name: mod.name, attemptedBlock });
      }
    }

    if (failures.length === 0) {
      console.log("✅ All non-manual tagged mods parse cleanly.");
    } else {
      const malformed = failures.filter((f) => f.attemptedBlock);
      const noBlock = failures.filter((f) => !f.attemptedBlock);
      console.log(
        `❌ ${failures.length} missing (${malformed.length} malformed block, ${noBlock.length} no block):`,
      );
      for (const f of failures) {
        console.log(`   - ${f.modId}  [${f.attemptedBlock ? "malformed" : "no-block "}]  ${f.name}`);
      }
      await postDiscord(failures, mods.length);
    }
    process.exit(0); // report, not a gate
  } catch (err) {
    console.error("Monitor failed (infrastructure error):", err.message);
    process.exit(1);
  }
})();
