/**
 * Load the browser-side core files into a Node context and hand back NCZ.
 *
 * assets/js/ has no modules and no bundler: the files assign onto a global
 * `window.NCZ`, in a fixed order set by index.html. Reproducing that here is
 * what lets the pure parts be tested without a browser, and it is deliberately
 * the SAME files the site loads rather than a copy.
 *
 * Only the globals the top level of those files touch are provided. A file that
 * grows a new top-level dependency fails loudly here, which is the point: it
 * would also be a new dependency at page load.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

/** @param {string[]} [files] load order, defaulting to the pure core. */
function loadNCZ(files = ['assets/js/constants.js', 'assets/js/utils.js']) {
  const fakeWindow = {
    location: { search: '' },
    URLSearchParams,
    console,
  };
  fakeWindow.window = fakeWindow;

  // Run in THIS realm, with `with` standing in for the browser's global scope.
  // A vm context would be tidier, but every object the files build would then
  // come from another realm and deepStrictEqual would refuse to compare it
  // against a plain object here.
  //
  // `with` is what reproduces the one property of a browser that these files
  // depend on: `window.NCZ = {}` also defines a bare `NCZ`, which everything
  // after the first line reads.
  for (const file of files) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const wrapped = `(function (window) { with (window) {\n${source}\n} })`;
    vm.runInThisContext(wrapped, { filename: file })(fakeWindow);
  }

  return fakeWindow.NCZ;
}

module.exports = { loadNCZ };
