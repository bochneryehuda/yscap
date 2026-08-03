'use strict';
/**
 * EVERY borrower-facing Term Sheet Studio strips the admin zone from the DOM.
 *
 * WHY THIS EXISTS. The first pass at "borrowers only have the admin panel
 * hidden, not removed" fixed ONE borrower screen — `PricingStudio` — and the
 * post-merge audit found TWO more that mount the same component and were still
 * shipping the admin zone (its markup, origination and fee inputs, and the
 * password box) into the borrower's own page, hidden by a single style rule:
 *
 *   • `Apply.jsx`      — the borrower's new-application wizard, step 4
 *   • `Application.jsx` -> `ProductStudioPanel mode="borrower"` — their loan file
 *
 * That is the repo's "every fix is all-sides" rule failing in the small: the
 * component grew a correct opt-out and only one of three call sites used it.
 * A list of screens I remembered is exactly what went wrong, so this test does
 * not carry one — it ENUMERATES every `<TermSheetStudio` mount in both portals
 * and requires each to be classifiable and correct. A new mount that neither
 * declares `adminCapable` nor is provably staff-only FAILS here, which is the
 * whole point: the next person cannot miss it the way I did.
 *
 * Pure — source text only. No DB, no network, no browser.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* The component itself must offer the opt-out, in BOTH portals — V1 shipped
   without it, so `adminCapable={false}` on a V1 screen was silently ignored. */
console.log('A. both portals\' TermSheetStudio support adminCapable');
const COMPONENTS = ['app-v2/src/components/TermSheetStudio.jsx', 'app/src/components/TermSheetStudio.jsx'];
for (const rel of COMPONENTS) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  ok(/adminCapable\s*=\s*true/.test(src), `${rel}: accepts adminCapable, DEFAULTING TO TRUE (every existing call site unchanged)`);
  ok(/function stripAdminZone\s*\(/.test(src), `${rel}: has stripAdminZone()`);
  ok(/if\s*\(\s*!adminCapable\s*\)\s*stripAdminZone\(\)/.test(src), `${rel}: strips the zone at mount when not admin-capable`);
  ok(/if\s*\(\s*show\s*&&\s*!adminCapable\s*\)\s*return/.test(src), `${rel}: a later show() cannot conjure the zone back`);
}

/* Every mount, found rather than remembered. */
console.log('\nB. every <TermSheetStudio> mount is accounted for');
const MOUNT_FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (!/\.jsx?$/.test(e.name)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (src.includes('<TermSheetStudio')) MOUNT_FILES.push({ rel: path.relative(REPO, p), src });
  }
})(path.join(REPO, 'app-v2', 'src'));
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (!/\.jsx?$/.test(e.name)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (src.includes('<TermSheetStudio')) MOUNT_FILES.push({ rel: path.relative(REPO, p), src });
  }
})(path.join(REPO, 'app', 'src'));

ok(MOUNT_FILES.length >= 5, `found ${MOUNT_FILES.length} file(s) mounting the studio`);

// Pull the whole JSX element text for each mount so the props can be read.
function mountsIn(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('<TermSheetStudio', i)) !== -1) {
    // to the matching '/>' or '>' at depth 0 of the braces
    let j = i, depth = 0;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(src.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

for (const f of MOUNT_FILES) {
  for (const m of mountsIn(f.src)) {
    const declares = /adminCapable\s*=\s*\{/.test(m);
    // A mount is allowed to omit the prop ONLY if this file is staff-only. The
    // two ProductStudioPanels serve BOTH audiences from one component, so they
    // are required to pass it (they compute it from `isStaff`).
    const staffOnly = /Staff[A-Za-z]*\.jsx$/.test(f.rel);
    if (declares) {
      const val = (m.match(/adminCapable\s*=\s*\{([^}]*)\}/) || [])[1] || '';
      ok(/false|isStaff/.test(val),
        `${f.rel}: adminCapable={${val.trim()}} — false on a borrower screen, or derived from isStaff`);
    } else {
      ok(staffOnly,
        `${f.rel}: omits adminCapable — only allowed on a staff-only screen`);
    }
  }
}

/* The three borrower surfaces, named, so a regression says WHICH one broke. */
console.log('\nC. the three borrower surfaces strip it');
const BORROWER = [
  ['app-v2/src/screens/PricingStudio.jsx', 'borrower — Price a loan'],
  ['app-v2/src/screens/Apply.jsx', 'borrower — new application wizard (V2)'],
  ['app/src/screens/Apply.jsx', 'borrower — new application wizard (V1)'],
];
for (const [rel, what] of BORROWER) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  ok(/adminCapable=\{false\}/.test(src), `${rel} (${what})`);
}
for (const rel of ['app-v2/src/components/ProductStudioPanel.jsx', 'app/src/components/ProductStudioPanel.jsx']) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  ok(/adminCapable=\{isStaff\}/.test(src),
    `${rel}: serves staff AND borrower from one component, so it derives the flag (mode="borrower" -> stripped)`);
}

/* The password gate must not exist in ANY portal source — the audit found a
   fifth copy inlined in Apply.jsx, which no `cyrb53` grep would have caught
   because the rounds were written out without the function name. */
console.log('\nD. no copy of the browser-side admin gate survives anywhere');
const HASH = String(6019969998889003);
const ROUNDS = /0xdeadbeef[\s\S]{0,400}?0x41c6ce57/;
for (const root of ['app-v2/src', 'app/src']) {
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.jsx?$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      // The explanatory comments naming the retired hash are fine; a live
      // COMPARISON against it is not.
      const live = src.split('\n').filter((l) => l.includes(HASH) && !/^\s*(\/\/|\*|\/\*)/.test(l));
      if (live.length || ROUNDS.test(src)) hits.push(path.relative(REPO, p));
    }
  })(path.join(REPO, root));
  ok(hits.length === 0, `${root}: no admin-hash comparison and no inlined cyrb53 rounds${hits.length ? ' — ' + hits.join(', ') : ''}`);
}

/* And it must not be in what actually ships. */
console.log('\nE. no built bundle carries it');
for (const dir of ['web/v2/portal/assets', 'web/portal/assets']) {
  const d = path.join(REPO, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d).filter((x) => /^index-.*\.js$/.test(x))) {
    const src = fs.readFileSync(path.join(d, f), 'utf8');
    ok(!src.includes(HASH) && !src.includes('Yscg@'), `${dir}/${f}: no password, no hash`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll studio admin-surface checks passed');
process.exit(failures ? 1 : 0);
