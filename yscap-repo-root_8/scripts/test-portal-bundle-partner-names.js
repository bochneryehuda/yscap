'use strict';
/**
 * A CAPITAL-PARTNER NAME MUST NOT BE TYPED INTO PORTAL SOURCE — because app-v2
 * builds ONE bundle and BOTH portals load it.
 *
 * The session rule says a staff surface may name a note buyer and a borrower
 * surface may not. That reads as a per-screen rule, and it is not one here:
 * `app-v2/` compiles to a SINGLE entry chunk served from `/portal/`, which the
 * borrower's browser downloads in full before it knows who is logged in. So a
 * name typed into ANY app-v2 source string — even on a screen only a
 * super-admin can reach — is delivered to every borrower, and no amount of
 * role-gating in React changes that. The server-side scrub
 * (`src/lib/borrower-safe.js`) cannot help either: it scrubs DATA on the way
 * out, and this is source text that was compiled in.
 *
 * An audit on 2026-08-03 found two, both the same shape — a live partner named
 * as a decorative EXAMPLE in a form placeholder, buying nothing the field's own
 * label did not already say:
 *   StaffDrawRules.jsx   placeholder="Note buyer (e.g. Fidelis)"
 *   PayoffCard.jsx       placeholder="e.g. Chase, Kiavi, a private lender"
 *
 * WHAT THIS TEST ACTUALLY ASKS. It reads the SHIPPED bundles — the bytes a
 * browser downloads, not the source — and finds every capital-partner name in
 * them using `borrower-safe`'s OWN pattern list (never a second copy: adding a
 * partner there must arm this guard in the same commit). Every hit is widened
 * to its surrounding code token and checked against the allowlist below. A
 * token that is not on the list FAILS.
 *
 * The allowlist is BY EXACT TOKEN and each entry carries a reason. It is not a
 * per-file or per-pattern exemption, because either of those would have let the
 * two findings above through — `Fidelis` sat in the same file as nothing else,
 * and the `kiavi` pattern had no other carrier. Counts are deliberately NOT
 * pinned (they churn on every unrelated build); the RESIDUAL IS PRINTED on
 * every run so what is being tolerated is never invisible.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { PARTNER_PATTERNS } = require(path.join(ROOT, 'src/lib/borrower-safe.js'));

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* The bundle directories a NON-STAFF browser downloads from. V2 is canonical
   (served at /portal/); V1 is frozen at /v1 but still served, so it is held to
   the same standard — it carries ZERO partner names today and must stay that
   way. */
const BUNDLE_DIRS = ['web/v2/portal/assets', 'web/portal/assets'];
const ASSET_EXT = /\.(js|mjs|css)$/;

/* EVERY partner-name token the shipped bundles are allowed to carry, with the
   reason it is tolerated. Anything else fails.

   These are all PRE-EXISTING and all of ONE kind: an integration's own name
   used as machinery — a workflow key, a submission type, a condition template
   code — rather than as prose describing who buys our loans. They are recorded
   here rather than quietly excluded so the residual is a decision somebody can
   revisit, not an accident:

     trinity / Trinity / trinity_orders / trinity_inspection_order
       The physical draw INSPECTOR (2026-07-24 draw workflow). Appears as a
       workflow submission type and a staff-facing "Trinity Inspection Order"
       label on the draws desk.
     trustpoint / TrustPoint / trustpoint_import / trustpointDrawReport
       The note buyer's draw ADMINISTRATOR. Same shape — a workflow key plus
       the "TrustPoint Draw Entry" staff label. `borrower-safe` scrubs it on
       every borrower surface precisely because naming it reveals the buyer
       relationship, which is why it is listed here rather than ignored.
     cond_emd_corrfirst / cond_ssn_verify_corrfirst
       CONDITION TEMPLATE CODES (db/191, db/398). The codes are stable
       identifiers the server keys on; the borrower-facing wording of those
       same conditions names nobody (guarded separately by
       test-condition-voice-guard-db.js).

   Renaming any of them is a real product change across the draw workflow and
   the condition templates — deliberately NOT done under an audit fix. */
const ALLOWED_TOKENS = new Set([
  'trinity', 'Trinity', 'trinity_orders', 'trinity_inspection_order',
  'trustpoint', 'TrustPoint', 'trustpoint_import', 'trustpointDrawReport',
  'cond_emd_corrfirst', 'cond_ssn_verify_corrfirst',
]);

/* The two strings the audit removed. Pinned by their EXACT text so a revert —
   or a copy-paste of the same example into another screen — fails loudly
   instead of merely re-arming the allowlist check. */
const REMOVED_STRINGS = ['(e.g. Fidelis)', 'Chase, Kiavi'];

// ---------------------------------------------------------------------------
// The scan. A hit is widened to its whole code token, so `cond_emd_corrfirst`
// is judged as one identifier rather than as a bare "corrfirst" that would read
// like prose.
// ---------------------------------------------------------------------------
function tokenAt(src, start, end) {
  let s = start; let e = end;
  while (s > 0 && /[A-Za-z0-9_]/.test(src[s - 1])) s--;
  while (e < src.length && /[A-Za-z0-9_]/.test(src[e])) e++;
  return src.slice(s, e);
}

function carriersIn(src, label) {
  const found = [];
  for (const re of PARTNER_PATTERNS) {
    re.lastIndex = 0;                       // the patterns are /g and shared
    let m;
    while ((m = re.exec(src)) !== null) {
      found.push({
        token: tokenAt(src, m.index, m.index + m[0].length),
        file: label,
        context: src.slice(Math.max(0, m.index - 70), m.index + 70).replace(/\s+/g, ' '),
      });
      if (m[0].length === 0) re.lastIndex++;  // a zero-width match would spin
    }
  }
  return found;
}

function assets() {
  const out = [];
  for (const dir of BUNDLE_DIRS) {
    const abs = path.join(ROOT, dir);
    let names = [];
    try { names = fs.readdirSync(abs); } catch (_) { continue; }
    // Filenames are content-hashed and change on every build — resolve them
    // from disk rather than pinning one, or this guard silently stops reading
    // the real bundle the first time anything is rebuilt.
    for (const n of names) if (ASSET_EXT.test(n)) out.push({ rel: path.join(dir, n), abs: path.join(abs, n) });
  }
  return out;
}

const files = assets();
console.log(`== scanning ${files.length} shipped asset(s) with ${PARTNER_PATTERNS.length} partner pattern(s) ==`);
ok(PARTNER_PATTERNS.length >= 10, `borrower-safe exports the partner list (${PARTNER_PATTERNS.length} patterns)`);
ok(files.length >= 2, `both portal bundles are on disk (${files.length} assets)`);

// A positive control FIRST: if the require broke or the patterns stopped
// matching, every assertion below would pass on an empty result set.
{
  const planted = carriersIn('const t = "call BlueLake and Fidelis about it";', 'planted');
  ok(planted.length >= 2, `the scan detects a planted partner name (found ${planted.length})`);
  ok(carriersIn('const t = "an ordinary sentence about a loan";', 'clean').length === 0,
    'and does not fire on ordinary text');
}

// ---------------------------------------------------------------------------
console.log('\n== no partner name ships except the reasoned allowlist ==');
// ---------------------------------------------------------------------------
const all = [];
for (const f of files) all.push(...carriersIn(fs.readFileSync(f.abs, 'utf8'), f.rel));

const unexpected = all.filter((h) => !ALLOWED_TOKENS.has(h.token));
ok(unexpected.length === 0, `no un-allowlisted partner name in any shipped bundle (${unexpected.length} found)`);
for (const h of unexpected.slice(0, 12)) {
  console.log(`     ${h.file}  ${JSON.stringify(h.token)}`);
  console.log(`       …${h.context}…`);
}
if (unexpected.length > 12) console.log(`     …and ${unexpected.length - 12} more`);

// The residual, ALWAYS printed — a tolerated carrier must never be invisible.
const residual = new Map();
for (const h of all) residual.set(h.token, (residual.get(h.token) || 0) + 1);
console.log('   partner names now shipping (◀ = not allowlisted, this is the failure):');
if (!residual.size) console.log('     (none)');
for (const [tok, n] of [...residual].sort()) {
  console.log(`     ${String(n).padStart(4)} ${tok}${ALLOWED_TOKENS.has(tok) ? '' : '   ◀'}`);
}

// An allowlist entry nobody carries any more is stale — say so, but do not fail
// (a bundle legitimately loses a screen between builds).
for (const tok of ALLOWED_TOKENS) {
  if (!residual.has(tok)) console.log(`   NOTE allowlist entry no longer present: ${tok} (safe to drop)`);
}

// ---------------------------------------------------------------------------
console.log('\n== the two removed examples stay removed ==');
// ---------------------------------------------------------------------------
for (const s of REMOVED_STRINGS) {
  const hit = files.filter((f) => fs.readFileSync(f.abs, 'utf8').includes(s));
  ok(hit.length === 0, `no shipped asset carries ${JSON.stringify(s)}${hit.length ? ` (${hit.map((h) => h.rel).join(', ')})` : ''}`);
}

// The V1 bundle is frozen but still served; it carries nothing today.
{
  const v1 = all.filter((h) => h.file.startsWith('web/portal/assets'));
  ok(v1.length === 0, `the V1 bundle carries no partner name at all (${v1.length})`);
}

// ---------------------------------------------------------------------------
console.log('\n== the bundle on disk is the one the page loads ==');
// ---------------------------------------------------------------------------
// A source fix that is not rebuilt, or a rebuild whose index.html was not
// committed, ships the OLD bundle — which is how a name like this survives a
// fix. Cheap to check, and it fails exactly when that happens.
for (const page of ['web/v2/portal/index.html', 'web/portal/index.html']) {
  const abs = path.join(ROOT, page);
  if (!fs.existsSync(abs)) { console.log(`   (skip ${page} — not present)`); continue; }
  const html = fs.readFileSync(abs, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((m) => m[1]);
  ok(refs.length > 0, `${page} references its assets (${refs.length})`);
  const dir = path.join(ROOT, path.dirname(page), 'assets');
  const missing = refs.filter((r) => !fs.existsSync(path.join(dir, path.basename(r))));
  ok(missing.length === 0, `every asset ${page} loads exists on disk${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
}

console.log(`\n${failures ? 'FAILED' : 'All'} portal-bundle partner-name checks ${failures ? `— ${failures} failure(s)` : 'passed'}`);
process.exit(failures ? 1 : 0);
