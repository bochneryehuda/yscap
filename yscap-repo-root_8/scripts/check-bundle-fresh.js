'use strict';
/**
 * THE COMMITTED BUNDLE MUST BE A BUILD OF THE COMMITTED SOURCE.
 *
 * =============================================================================
 * WHY THIS EXISTS — it is what makes the browser drive mean anything
 * =============================================================================
 *
 * `render-cobrowse-e2e.js` is the best guard this feature has: two real browsers,
 * a real consent, a real mouse moving ~192 real pixels. The pre-merge audit
 * proved it catches BOTH of the defects that walked past the source guards — the
 * take-back drift release and the re-seeded live baseline — with 7 failures.
 *
 * And it was toothless, because it serves `web/v2/portal`, which is a COMMITTED
 * BUILD ARTEFACT, and nothing in `npm test` ever rebuilt it. So a change to
 * `app-v2/src/**` that nobody rebuilt gave a fully green suite while the drive
 * quietly exercised yesterday's JavaScript. Every source guard in
 * `test-cobrowse-pure` is bypassable by somebody determined; the drive is not —
 * but only if it is looking at the code under review.
 *
 * =============================================================================
 * WHY A HASH AND NOT A REBUILD
 * =============================================================================
 *
 * The obvious check is "run `vite build` and diff". It cannot run where it
 * matters: CI installs dependencies for the repo root only, and `vite` lives in
 * `app-v2/node_modules`, which is never installed there. (The `render-*` harnesses
 * skip in CI for a different reason — Playwright is not a dependency of this repo
 * at all; an earlier draft of this paragraph gave that as the same reason.) A check
 * that skips in CI is not a check.
 *
 * So the BUILD stamps what it consumed (`scripts/write-bundle-manifest.js`, run
 * by app-v2's own `npm run build`) and this recomputes it from the same
 * definition (`scripts/lib/bundle-hash.js`). Pure: a directory walk and a
 * SHA-256. No node_modules, no browser, no database, ~30ms.
 *
 * WHAT IT CANNOT PROVE, said plainly: that the asset BYTES are a correct build.
 * Filenames and `index.html` are compared; the hashed asset contents are not, so a
 * hand-patched `index-*.js` passes. Nor can it stop somebody re-running
 * `write-bundle-manifest.js` on its own to re-stamp a stale bundle — a stamp is a
 * record of intent, not a proof. What it does prove is that the source has not
 * moved since the build that was stamped. That is the failure this is for: not a
 * malicious bundle, but the ordinary Tuesday one where somebody edits a screen,
 * runs the suite, sees green, and ships the old bundle.
 *
 * WHEN IT FAILS: `cd app-v2 && npm run build`, then commit `web/v2/portal/`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sourceHash, MANIFEST, PORTAL } = require('./lib/bundle-hash');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, MANIFEST);

let fail = 0;
const bad = (m) => { fail++; console.log(`FAIL ${m}`); };
const ok = (m) => console.log(`  ok - ${m}`);

if (!fs.existsSync(manifestPath)) {
  bad(`${MANIFEST} is missing — run \`cd app-v2 && npm run build\` and commit web/v2/portal/`);
} else {
  let man = null;
  try { man = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { bad(`${MANIFEST} is not readable JSON: ${e.message}`); }
  if (man) {
    const now = sourceHash(root);
    if (man.sourceHash !== now) {
      bad(`app-v2 source or public/ has changed since the committed bundle was built (stamped ${man.sourceHash}, source is now ${now}).\n`
        + '     The browser drive serves web/v2/portal, so it would be testing the OLD code.\n'
        + '     Fix: cd app-v2 && npm run build   — then commit web/v2/portal/');
    } else {
      ok(`the committed bundle was built from this source (${now})`);
    }
    // The stamped assets must still be the ones on disk, and the ones index.html
    // asks for — a hand-deleted or hand-added asset is the other half of "stale".
    const dir = path.join(root, PORTAL, 'assets');
    const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    if (JSON.stringify(onDisk) !== JSON.stringify(man.assets || [])) {
      bad(`web/v2/portal/assets does not match the stamp (on disk ${JSON.stringify(onDisk)}, stamped ${JSON.stringify(man.assets)})`);
    } else {
      ok(`the ${onDisk.length} committed asset FILENAMES are the ones that build produced`);
    }
    const html = fs.readFileSync(path.join(root, PORTAL, 'index.html'), 'utf8');
    // index.html IS COMPARED, not merely stamped. It was written into the manifest
    // and never checked, so a hand-injected <script> passed (pre-merge audit).
    const indexHash = crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
    if (man.indexHash && man.indexHash !== indexHash) {
      bad(`web/v2/portal/index.html has been edited since the build (stamped ${man.indexHash}, now ${indexHash})`);
    } else if (man.indexHash) {
      ok('index.html is byte-for-byte the one that build produced');
    } else {
      // NEVER SILENTLY. Deleting one key from the manifest used to turn this check off
      // with an exit 0 and no line saying anything had been skipped — which is not the
      // "a stamp is a record of intent" caveat in the header, it is a check that
      // evaporates on request (pre-merge audit, 2026-09-02).
      bad(`${MANIFEST} carries no indexHash — re-run \`cd app-v2 && npm run build\` so index.html can be checked`);
    }
    const referenced = [...html.matchAll(/assets\/([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
    const missing = referenced.filter((f) => !onDisk.includes(f));
    if (missing.length) bad(`index.html asks for assets that are not committed: ${JSON.stringify(missing)}`);
    else ok(`index.html references ${referenced.length} asset(s), all present`);
  }
}

console.log(fail ? `\n${fail} problem(s) with the committed bundle` : '\nThe committed bundle was built from this source (see this file\'s header for what that does and does not prove).');
process.exit(fail ? 1 : 0);
