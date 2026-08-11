/**
 * district_meta.js: the eight districts' CET footprints and box-cloud texture,
 * read off DISTRICT_META in assets/js/three-scene.js.
 *
 * Shared by the box-cloud rebuild scripts so the numbers cannot drift between
 * the stage that extracts placements and the stage that scores the result.
 * Not imported from three-scene.js because that is a browser module that pulls
 * in Three.js.
 *
 * A district's world bbox is transMin/transMax plus the offset in X and Y. Z is
 * unoffset. cubeSize is the scale-block denominator for decoding its texture.
 */
'use strict';

const DISTRICTS = {
  city_center:   { transMin: [-770.609192, -530.549133, -40.6581497], transMax: [1316.82483,   649.75531,  642.893127], offset: [-2116.637,   106.508], cubeSize: 168.289993, dds: 'city_center_data.dds' },
  watson:        { transMin: [-1254.46997, -1258.68469, -24.7028503], transMax: [1988.5448,   2032.52405,  475.268005], offset: [-1979.372,  1873.951], cubeSize: 237.175003, dds: 'watson_data.dds' },
  westbrook:     { transMin: [-1078.94739, -1148.69434, -18.4205875], transMax: [1155.12,     1562.87903,  507.894714], offset: [  -97.209,   590.849], cubeSize: 197.0,      dds: 'westbrook_data.dds' },
  heywood:       { transMin: [-1080.35107,  -418.153046, -38.4002304], transMax: [1136.94556, 1372.15979,  374.181305], offset: [-1576.732, -1002.811], cubeSize: 197.236832, dds: 'heywood_data.dds' },
  santo_domingo: { transMin: [-1328.95288, -1880.02502, -37.5960007], transMax: [1555.26318,  1369.01294,  332.348328], offset: [  -15.944, -1610.080], cubeSize: 139.342102, dds: 'santo_domingo_data.dds' },
  pacifica:      { transMin: [-4008.396,   -4575.14941, -51.9539986], transMax: [8258.31641,  7254.10059,  264.306946], offset: [-2422.441, -2368.156], cubeSize: 305.600006, dds: 'pacifica_data.dds' },
  ep1_dogtown:   { transMin: [-2650.0,     -3126.6084,   -0.750015974], transMax: [-1025.51855, -1803.58118, 493.576111], offset: [0.0, 0.0],            cubeSize: 198.020691, dds: 'dogtown_data.dds' },
  ep1_spaceport: { transMin: [-1168.5874,   -765.104614, -41.4592323], transMax: [1219.45483, 1018.70129,  296.498138], offset: [-4200.000,   200.000], cubeSize: 115.298218, dds: 'spaceport_data.dds', noFixed: true },
};

/** World (CET) bounding box of a district: min and max, xyz. */
function worldBounds(d) {
  return {
    min: [d.transMin[0] + d.offset[0], d.transMin[1] + d.offset[1], d.transMin[2]],
    max: [d.transMax[0] + d.offset[0], d.transMax[1] + d.offset[1], d.transMax[2]],
  };
}

module.exports = { DISTRICTS, worldBounds };
