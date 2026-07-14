// probe_api.wscript — WolvenKit
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS ACTUALLY ON `wkit`?
//
// `wkit.ExportFiles([path])` was GUESSED. It ran 721 times in 50 milliseconds, threw nothing,
// reported "uncooked 721/721, none failed" — AND WROTE NO FILES. A silent no-op that reports
// success is the worst failure a tool can have, and the guard was wrong too: it caught THROWS,
// when the only honest check is "did a file appear".
//
// So stop guessing. Ask the object what it can do, then verify the one we pick by looking for
// the file on disk — not by trusting a return value.
import * as Logger from 'Logger.wscript';

// Every callable on wkit, and its arity. The arity matters: an export that takes 1 arg and one
// that takes (path, outDir) are different calls, and calling the second with one arg is exactly
// how you get a silent no-op.
const names = [];
for (const k in wkit) {
    let kind = typeof wkit[k];
    let arity = '';
    try { if (kind === 'function') arity = `(${wkit[k].length})`; } catch { /* host object */ }
    names.push(`${k}${arity}`);
}
names.sort();
Logger.Info(`[ncz] wkit has ${names.length} members:`);
// Chunked, because a single 100-name line gets truncated in the log window.
for (let i = 0; i < names.length; i += 8) {
    Logger.Info('[ncz]   ' + names.slice(i, i + 8).join('  '));
}

// The ones we care about, called out.
const EXPORTY = /export|uncook|convert|extract|save|glb|mesh/i;
const hits = names.filter((n) => EXPORTY.test(n));
Logger.Success(`[ncz] EXPORT-LOOKING MEMBERS: ${hits.join('  ') || '(none — that is the finding)'}`);

// Try the leading candidate on ONE mesh, and then CHECK THE DISK, because a return value is
// not evidence. `cct_cpz_building_a_b_6m_window` is a known-good mesh: it has a window submesh.
const TEST = 'base\\environment\\architecture\\city_center\\corporate_plaza\\cct_cpz_building_a_b_6m_window.mesh';
for (const fn of ['ExportFiles', 'Export', 'UncookFile', 'Uncook', 'ExportFile']) {
    if (typeof wkit[fn] !== 'function') continue;
    try {
        const r = wkit[fn]([TEST]);
        Logger.Info(`[ncz] wkit.${fn}([path]) returned: ${JSON.stringify(r)}`);
    } catch (e) {
        Logger.Info(`[ncz] wkit.${fn}([path]) threw: ${e}`);
    }
    try {
        const r2 = wkit[fn](TEST);
        Logger.Info(`[ncz] wkit.${fn}(path)   returned: ${JSON.stringify(r2)}`);
    } catch (e) {
        Logger.Info(`[ncz] wkit.${fn}(path)   threw: ${e}`);
    }
}

Logger.Success('[ncz] Now LOOK ON DISK for cct_cpz_building_a_b_6m_window.glb. A return value is not evidence.');
