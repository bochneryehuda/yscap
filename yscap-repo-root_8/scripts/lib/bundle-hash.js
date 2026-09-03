'use strict';
/**
 * ONE definition of "what the portal bundle is built from", shared by the writer
 * (`scripts/write-bundle-manifest.js`) and the checker
 * (`scripts/check-bundle-fresh.js`) so the two can never drift apart — a stamp
 * and a check that disagree about the inputs is a guard that fails at random.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = 'app-v2';
const PORTAL = 'web/v2/portal';
const MANIFEST = `${PORTAL}/.bundle-manifest.json`;

/**
 * Everything that can change what `vite build` emits: the source tree, the static
 * `public/` tree it copies verbatim, the HTML entry, the build config, and the
 * dependency versions. NOT node_modules itself
 * — CI does not install app-v2's dependencies, and a check that needs them would
 * simply skip in the one place it matters.
 */
function inputs(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(path.join(root, APP, 'src'));
  // `public/**` IS PART OF WHAT THE DRIVE SERVES. Vite copies it verbatim into the
  // bundle, so `sw.js` — real caching behaviour — could change with the check still
  // green (pre-merge audit, 2026-09-02).
  const pub = path.join(root, APP, 'public');
  if (fs.existsSync(pub)) walk(pub);
  for (const f of ['index.html', 'vite.config.js', 'package.json']) {
    const p = path.join(root, APP, f);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

/** A stable hash of those inputs — path and content, in a fixed order. */
function sourceHash(root) {
  const h = crypto.createHash('sha256');
  for (const f of inputs(root)) {
    h.update(path.relative(root, f).split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

module.exports = { APP, PORTAL, MANIFEST, inputs, sourceHash };
