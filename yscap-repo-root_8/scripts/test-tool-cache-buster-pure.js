'use strict';
/**
 * EVERY V2 TOOL ASSET IS CACHE-BUSTED, AND ITS BUSTER MOVES WHEN THE FILE DOES.
 *
 * Owner-directed 2026-09-01, after this exact bug shipped and was caught by CI on
 * the ONE asset that happened to be guarded: *"the check that catches a stale
 * cached file only watches one of the three tools … Fix this."*
 *
 * ⛔ WHY THIS IS A REAL BUG AND NOT BOOKKEEPING. These assets are served with a
 * long cache life, so the `?v=` in the page is the ONLY thing that tells a
 * returning browser to fetch the new copy. Edit `termsheet.js` and leave its
 * buster alone and the fix is live in the repository and INVISIBLE on every
 * screen that has opened the tool before — it looks shipped and is not. The
 * failure is silent by construction: nothing errors, nothing logs, and the
 * person who notices is a borrower looking at a stale term sheet.
 *
 * ⛔ THE LIST IS DERIVED FROM THE PAGES, WHICH IS THE WHOLE POINT. The guard this
 * replaces carried a hand-written list of two assets, so it was blind to the
 * other nineteen — and a hand-written list is blind to the twentieth the day
 * somebody adds a tool. This walks every `web/v2/tools/*.html` and takes the
 * assets they actually load, so a new tool is covered the moment it exists.
 *
 * ⛔ AND IT COVERS THE FAN-OUT, WHICH IS THE WORSE HALF. `../suite.js`,
 * `../suite.css`, `../theme.js`, `../brand.js` and `../float-actions.js` are each
 * loaded by ALL ELEVEN pages. Bump one page and forget the other ten and ten
 * tools serve the stale file — a bigger miss than the single-page one that
 * prompted this. So the pin records the SET of busters an asset is loaded under,
 * and the whole set has to move together.
 *
 * ⛔ THREE THINGS ARE ASSERTED, and each catches a different mistake:
 *   A. every local .js/.css a tool page loads carries a `?v=`   (it can be busted)
 *   B. the asset's content still hashes to its pin              (it was not edited silently)
 *   C. the busters in use are exactly the pinned set            (every page moved, not one)
 *
 * WHEN A TOOL LEGITIMATELY CHANGES: bump the `?v=` on EVERY page that loads it,
 * then run `node scripts/test-tool-cache-buster-pure.js --print-pins` and paste
 * the table it prints over PINS below. The table is generated, never hand-typed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const TOOLS = 'web/v2/tools';
const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Every local stylesheet/script a tool page loads, with the buster it loads it under. */
function scanReferences() {
  const refs = new Map(); // assetRepoPath -> { busters:Map<v, pages[]>, missing: pages[] }
  const pages = fs.readdirSync(path.join(ROOT, TOOLS)).filter((f) => f.endsWith('.html')).sort();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, TOOLS, page), 'utf8');
    /* Local only: an absolute URL or a protocol-relative one is somebody else's
       cache to manage, and this guard must not claim authority over it. */
    const re = /(?:src|href)="(?!https?:|\/\/)([A-Za-z0-9._/-]+\.(?:js|css))(\?v=([A-Za-z0-9_.-]+))?"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const rel = path.posix.normalize(path.posix.join(TOOLS, m[1]));
      if (!refs.has(rel)) refs.set(rel, { busters: new Map(), missing: [] });
      const entry = refs.get(rel);
      if (!m[3]) { entry.missing.push(page); continue; }
      if (!entry.busters.has(m[3])) entry.busters.set(m[3], []);
      entry.busters.get(m[3]).push(page);
    }
  }
  return refs;
}

/**
 * The pinned state. GENERATED — see `--print-pins`. `sha` is the asset's content;
 * `v` is every buster it is currently loaded under, sorted.
 */
const PINS = require('./fixtures/tool-cache-busters.json');

if (process.argv.includes('--print-pins')) {
  const out = {};
  for (const [rel, entry] of [...scanReferences()].sort()) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    out[rel] = { sha: sha16(fs.readFileSync(abs)), v: [...entry.busters.keys()].sort() };
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

let pass = 0; const fails = [];
const check = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok   ${msg}`); } else { fails.push(msg); console.log(`  FAIL ${msg}`); } };

const refs = scanReferences();

console.log('every tool asset can be invalidated at all');
{
  const missing = [...refs].filter(([, e]) => e.missing.length)
    .map(([rel, e]) => `${rel} on ${e.missing.join(', ')}`);
  check(refs.size >= 15, `${refs.size} distinct assets loaded across the tool pages — a handful would prove nothing`);
  check(missing.length === 0,
    `every local script and stylesheet is loaded with a ?v= — without one it can NEVER be invalidated (${missing.join(' | ') || 'none missing'})`);
}

console.log('\nand its buster moved when the file did');
{
  const unpinned = []; const edited = []; const drifted = []; const gone = [];
  for (const [rel, entry] of [...refs].sort()) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { gone.push(rel); continue; }
    const pin = PINS[rel];
    if (!pin) { unpinned.push(rel); continue; }
    const seen = sha16(fs.readFileSync(abs));
    if (seen !== pin.sha) {
      const pages = [...entry.busters.values()].flat().sort();
      edited.push(`${rel} (now ${seen}) — bump ?v= on ${pages.join(', ')}`);
      continue;
    }
    const now = [...entry.busters.keys()].sort().join(',');
    const was = [...(pin.v || [])].sort().join(',');
    if (now !== was) drifted.push(`${rel}: ${was || '(none)'} -> ${now || '(none)'}`);
  }
  check(gone.length === 0, `every referenced asset exists on disk (${gone.join(', ') || 'none missing'})`);
  check(unpinned.length === 0,
    `every referenced asset is pinned — a NEW tool asset is covered the moment it exists (${unpinned.join(', ') || 'none unpinned'})`);
  check(edited.length === 0,
    `no asset changed without its cache-buster moving${edited.length ? ` — ${edited.join(' | ')}` : ''}`);
  check(drifted.length === 0,
    `and the pinned busters are the ones in use — this is what catches bumping ONE page of eleven${drifted.length ? ` (${drifted.join(' | ')})` : ''}`);
}

console.log('\nthe pin table names nothing that no page loads');
{
  const stale = Object.keys(PINS).filter((rel) => !refs.has(rel));
  check(stale.length === 0, `no pin outlives its reference (${stale.join(', ') || 'none stale'})`);
}

if (fails.length) {
  console.log('\nTo fix: bump the ?v= on EVERY page that loads the asset, then run');
  console.log('  node scripts/test-tool-cache-buster-pure.js --print-pins');
  console.log('and paste the result over scripts/fixtures/tool-cache-busters.json');
}
console.log(`\n${fails.length ? `${fails.length} FAILED` : 'ALL PASSED'} (${pass} checks)`);
process.exit(fails.length ? 1 : 0);
