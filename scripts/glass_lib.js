#!/usr/bin/env node
/**
 * scripts/glass_lib.js
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT COUNTS AS GLASS — one definition, in one file.
 *
 * This regex was copy-pasted into eight scripts, which is how a classifier quietly drifts
 * apart from itself. It lives here now; import it, do not re-type it.
 *
 * THE MATERIALS, and why each is in or out (counts = material definitions in the game):
 *
 *   window_parallax_interior.mt   118   IN. The fake-lit-room shader. This was the ONLY one
 *                                       we matched, and matching only this is why the city
 *                                       measured a scarcely-credible 996k m2 of glass.
 *   window_interior_uv.mt               IN. Same family, UV-mapped variant.
 *   glass_onesided.mt              85   IN. Real glass. Ignored until now.
 *   glass.mt                       60   IN. Real glass. Ignored until now.
 *
 *   multilayered.mt              1339   NOT MATCHABLE BY NAME. The most-used material in the
 *                                       game, and where the BESPOKE facades (Corpo Plaza's
 *                                       towers) keep their glass — as a masked LAYER, whose
 *                                       position on the panel lives in a mask TEXTURE.
 *                                       Reaching it means decoding the mlsetup (Route B).
 *                                       A mesh using it is not glass-bearing as far as any
 *                                       name-based test can tell.
 *
 * A NOTE ON FALSE POSITIVES. `glass.mt` is also on car windows, bottles and shop displays.
 * Every consumer of this filters to ARCHITECTURE meshes first (see ARCH), so those never
 * reach it. If you use GLASS_MT without ARCH, you will count a beer bottle as a building.
 */
'use strict';

// Architecture only. A vending machine has a glowing screen; it is not a building.
const ARCH = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]/i;

// ── AND THE PROXIES, WHICH ARE ALSO BUILDINGS ───────────────────────────────
// A proxy is the low-detail, whole-building stand-in the game streams when you are too far away
// for the panel-by-panel version to matter. It lives at
//
//     worlds\03_night_city\sectors\_external\proxy\<hash>\<name>.mesh
//
// so it contains no `architecture`, and ARCH throws it away. Which means every building that
// ships ONLY as a proxy has been invisible to this pipeline.
//
// That is not a corner case. Arasaka Waterfront has TWELVE identical towers; nine are built from
// ~2,400 kit pieces and three are a single GenericProxyMesh, because you cannot get close enough
// to them for the difference to show. The game is right. Our idea of "a building" was too narrow.
// City-wide: 22,984 placed proxy copies carry window materials, and 7,016 of them are over 20 m
// tall — Corpo Plaza towers, Japantown, Arasaka Waterfront. Every one of them renders DARK.
//
//   cct_cpz_building_a_v2_uf_v2.mesh   353 m   Windows_1|Windows_10|Windows_6|Windows_2
//   wnid_03.mesh                       339 m   Windows_1|Windows_17|Windows_19|Windows_16
//   wbr_jpn_construct_a.mesh           323 m   Windows_0|Windows_1
//
// ─── AND THE TRAP, WHICH IS WORSE THAN THE BUG ──────────────────────────────
// MOST BUILDINGS HAVE BOTH. `v38_005` is placed as 2,136 instanced meshes AND 72 proxy meshes;
// the game streams one or the other, but the SECTOR DATA CONTAINS BOTH. Simply widening ARCH to
// include proxies therefore counts every detailed building's windows TWICE — a 2x overcount
// wearing the costume of a fix, which is the exact shape of the bug this pipeline spent a day
// removing.
//
// So a proxy is only ever used where there is NO detailed geometry for it. That test is spatial
// and it belongs at the PLACEMENT level (a proxy's bbox either does or does not contain real
// architecture) — see makeProxyFilter() in the consumers. This regex only says "this could be a
// building"; it does not say "count it".
const PROXY = /[\\/]proxy[\\/]/i;

// "Could this mesh be part of a building?" — architecture OR a building proxy. Use this to decide
// what to EXPORT and what to LOOK AT. Use ARCH alone when you specifically mean detailed
// geometry, and do the proxy-vs-detail dedup at the placement level.
const BUILDING = /[\\/]architecture[\\/]|[\\/]megabuilding[\\/]|[\\/]proxy[\\/]/i;

// The root .mt templates that ARE glass. Names, not paths — a glass panel's material path is
// `..._h400_w300_mlt.mi` and contains no window name at all, so the .mi -> .mt chain has to
// be resolved before this is applied. That is what isGlass() below does.
// `_proxy` VARIANTS COUNT. A proxy building's windows resolve to
// `base\materials\window_parallax_interior_proxy.mt` — a different template file, and one that
// `window_parallax_interior.mt` does not match. Without the suffix, every proxy building's glass
// is invisible.
//
// And the proxy templates are worth more than the detailed ones: the game BAKES THE LIT PATTERN
// INTO THEM. `wat_nid_building_a_v38`'s proxy carries four window chunks —
//
//     Windows_0  EV 0  turnOffAtNight 1   <- OFF
//     Windows_4  EV 0  turnOffAtNight 1   <- OFF
//     Windows_1  EV 3  turnOffAtNight 0   <- LIT
//     Windows_5  EV 5  turnOffAtNight 0   <- LIT, brighter
//
// — each its own submesh with its own geometry. That is the game telling us WHICH windows are on,
// WHICH are off, and HOW BRIGHT, as placed geometry. It is the ground truth for the thing the
// shader currently decides with a hash.
const GLASS_MT = /window_parallax_interior|window_interior_uv|^glass\.mt$|^glass_onesided\.mt$|glass_onesided|(^|[\\/])glass\.mt/i;

/**
 * Build a glass test from the dump's material table.
 * @param {Array} materials rows of ncz_materials.csv ({ path, root_mt })
 * @returns {(names: string[], paths: string[]) => boolean}
 */
function makeGlassTest(materials) {
  const SEP = /[\\/]/;
  const root = {};
  for (const m of materials) root[m.path.toLowerCase()] = (m.root_mt || '').split(SEP).pop();
  return (names, paths) =>
    names.some((n) => GLASS_MT.test(n))
    || paths.some((p) => GLASS_MT.test(p) || GLASS_MT.test(root[p.toLowerCase()] || ''));
}

module.exports = { ARCH, PROXY, BUILDING, GLASS_MT, makeGlassTest };
