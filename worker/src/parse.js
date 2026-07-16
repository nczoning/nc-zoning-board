/**
 * NCZoning metadata-block parser: server-side port of
 * assets/js/utils.js NCZ.parseNcZoningBlock (keep the two in sync; the
 * client version's comment block documents the real-world breakage this
 * strategy survives).
 *
 * Strategy: strip all BBCode, then treat `NCZoning:` as a token that can
 * appear anywhere (not a whole line). Every occurrence is tried as a
 * candidate; the first one whose following lines yield valid coords +
 * category wins, so the coords/category validation (not the sentinel's
 * position) is what disambiguates the real block from prose.
 */

const RECOGNIZED = new Set(['coords', 'category', 'tags', 'yaw', 'credits', 'authors']);
const VALID_CATEGORIES = ['location-overhaul', 'new-location', 'other'];

/**
 * @param {string} description Raw Nexus mod description (BBCode).
 * @param {Set<string>} validTagNames Known tag ids; unknown tags are dropped.
 * @returns {{coordinates: number[], category: string, tags: string[],
 *   credits: string|null, additionalAuthors: string[], yaw: number|null}|null}
 */
export function parseNcZoningBlock(description, validTagNames) {
  if (!description) return null;

  const text = description
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\[\/?[a-z][^\]]*\]/gi, '');

  const finalize = (data) => {
    if (!data.coords) return null;
    // coords: two or three comma-separated numbers [X, Y] or [X, Y, Z].
    const coordParts = data.coords.split(',').map((s) => parseFloat(s.trim()));
    if (coordParts.length < 2 || coordParts.length > 3 || coordParts.some(Number.isNaN)) return null;
    if (!data.category || !VALID_CATEGORIES.includes(data.category)) return null;

    return {
      coordinates: coordParts,
      category: data.category,
      tags: data.tags
        ? data.tags.split(',').map((t) => t.trim()).filter((t) => validTagNames.has(t))
        : [],
      credits: data.credits || null,
      additionalAuthors: data.authors
        ? data.authors.split(',').map((a) => a.trim()).filter(Boolean)
        : [],
      yaw: data.yaw && !Number.isNaN(parseFloat(data.yaw)) ? parseFloat(data.yaw) : null,
    };
  };

  const sentinel = /NCZoning[ \t]*:/gi;
  let m;
  while ((m = sentinel.exec(text)) !== null) {
    const data = {};
    for (const raw of text.slice(m.index + m[0].length).split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const eqIdx = line.indexOf('=');
      const key = eqIdx === -1 ? '' : line.slice(0, eqIdx).trim().toLowerCase();
      if (!RECOGNIZED.has(key)) break;
      const value = line.slice(eqIdx + 1).trim();
      if (value && !(key in data)) data[key] = value;
    }
    const parsed = finalize(data);
    if (parsed) return parsed;
  }
  return null;
}
