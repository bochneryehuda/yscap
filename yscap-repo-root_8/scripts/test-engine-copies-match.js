'use strict';
/**
 * The frozen pricing engines exist in TWO places, and they must stay identical.
 *
 * There used to be SIX copies of each engine — web/tools, web/v2/tools, and four
 * portal ones (web/portal/engines, web/v2/portal/engines and their build sources
 * app/public/engines, app-v2/public/engines). Nothing enforced that they agreed;
 * the only thing keeping them in step was somebody remembering to copy the file
 * five times, with hand-maintained `?v=` cache-busters per copy. A guideline
 * change applied to five of six would have priced two surfaces differently with
 * no error anywhere.
 *
 * The four portal copies were deleted on 2026-08-03 — the portal never used them
 * (see app-v2/src/lib/engines.js) — leaving the two that are genuinely
 * load-bearing:
 *
 *   web/v2/tools/   the V2 marketing tool + the Term Sheet Studio the portal
 *                   embeds; V2 serves at the root, so this is what the public
 *                   term-sheet generator runs on.
 *   web/tools/      the V1 tool at /v1 — AND the copy `src/lib/pricing.js`
 *                   require()s, so this one is what the SERVER prices with.
 *
 * That second point is what makes this test matter rather than being tidiness:
 * if the two drift, the browser quotes one number and the server registers a
 * different one, on the same deal.
 *
 * Pure — no DB, no network. If a third copy is ever deliberately reintroduced,
 * add it to ROOTS here AND to ENGINE_COPIES in scripts/emcap-regenerate-fixture.js.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const ROOTS = ['web/v2/tools', 'web/tools'];
const ENGINES = ['standard-program.js', 'gold-standard.js', 'silver-program.js', 'speed-program.js', 'title-cost.js'];

// Paths that must NOT carry an engine any more. A rebuild that resurrects one
// would quietly re-open both the drift risk and the pre-login download.
const RETIRED = ['web/portal/engines', 'web/v2/portal/engines', 'app/public/engines', 'app-v2/public/engines'];

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

console.log('A. every engine is byte-identical across the copies that remain');
for (const engine of ENGINES) {
  const seen = [];
  for (const root of ROOTS) {
    const p = path.join(REPO, root, engine);
    ok(fs.existsSync(p), `${root}/${engine} exists`);
    if (fs.existsSync(p)) seen.push({ root, hash: sha(p) });
  }
  const distinct = new Set(seen.map((s) => s.hash));
  ok(distinct.size === 1,
    `${engine}: all ${seen.length} copies identical` +
    (distinct.size === 1 ? '' : ` — DIVERGED: ${seen.map((s) => `${s.root}=${s.hash.slice(0, 12)}`).join(' vs ')}`));
}

console.log('\nB. the server prices off a copy that is actually there');
{
  // src/lib/pricing.js require()s these by relative path. A rename or a move
  // that missed it would leave enginesReady() false and every server quote dead.
  const src = fs.readFileSync(path.join(REPO, 'src/lib/pricing.js'), 'utf8');
  for (const engine of ENGINES) {
    const referenced = src.includes(`web/tools/${engine}`);
    ok(referenced, `src/lib/pricing.js still requires web/tools/${engine}`);
    if (referenced) ok(fs.existsSync(path.join(REPO, 'web/tools', engine)), `  …and that file exists`);
  }
  // Prove it in the strongest available way: actually load it.
  const pricing = require(path.join(REPO, 'src/lib/pricing.js'));
  ok(typeof pricing.enginesReady === 'function' && pricing.enginesReady() === true,
    'src/lib/pricing.js loads all four engines successfully');
}

console.log('\nC. the retired portal copies stay retired');
for (const root of RETIRED) {
  const dir = path.join(REPO, root);
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => ENGINES.includes(f)) : [];
  ok(present.length === 0, `${root}/ carries no engine${present.length ? ` — found ${present.join(', ')}` : ''}`);
}

console.log('\nD. no portal shell loads an engine before login');
for (const shell of ['app/index.html', 'app-v2/index.html', 'web/portal/index.html', 'web/v2/portal/index.html']) {
  const p = path.join(REPO, shell);
  if (!fs.existsSync(p)) { console.log(`SKIP ${shell} (not built)`); continue; }
  const html = fs.readFileSync(p, 'utf8');
  ok(!/<script[^>]+engines\//.test(html), `${shell} has no engine <script> tag`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll engine-copy checks passed');
process.exit(failures ? 1 : 0);
