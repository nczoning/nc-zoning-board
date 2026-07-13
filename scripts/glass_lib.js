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

// The root .mt templates that ARE glass. Names, not paths — a glass panel's material path is
// `..._h400_w300_mlt.mi` and contains no window name at all, so the .mi -> .mt chain has to
// be resolved before this is applied. That is what isGlass() below does.
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

module.exports = { ARCH, GLASS_MT, makeGlassTest };
