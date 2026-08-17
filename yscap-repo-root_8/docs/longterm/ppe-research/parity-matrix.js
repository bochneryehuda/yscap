#!/usr/bin/env node
'use strict';
/**
 * THE PARITY MATRIX — a repeatable live measurement of what our request actually returns.
 *
 * Run it from a shell that has LP_USERNAME / LP_PASSWORD / LP_CLIENT_SECRET. It is NOT part of
 * `npm test`: it makes real, slow, rate-limited calls to the vendor and needs credentials that do
 * not exist in CI. It is committed because the numbers it produces are the only evidence that
 * pricing works across more than the one scenario we happen to have a capture for.
 *
 *   node docs/longterm/ppe-research/parity-matrix.js            # the whole matrix
 *   node docs/longterm/ppe-research/parity-matrix.js --anchor   # just the exact-parity anchor
 *
 * WHAT IT CAN AND CANNOT PROVE, stated up front because the difference matters:
 *
 *   · THE ANCHOR is real parity. We hold exactly one captured frontend request that is proven to
 *     return HTTP 200. The scenario is read back OUT of that capture, our builder is asked for the
 *     same deal, and the two are posted in the same run. Equal counts is parity; anything else is a
 *     defect with a known-good body sitting beside it to bisect against.
 *
 *   · EVERY OTHER ROW IS A BASELINE, NOT A COMPARISON. We have no captured frontend body for a
 *     700-FICO purchase, so there is nothing to be "equal to". What those rows establish is what we
 *     return today, so that a future change which silently drops a lender is visible as a diff
 *     rather than discovered by a borrower. A row returning 0 programs or a non-200 is a real
 *     finding on its own — the vendor prices these deals for the website.
 *
 * Prints no token, no password, no secret.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..', '..');
const lp = require(path.join(ROOT, 'src', 'longterm', 'lenderprice', 'client.js'));
const sm = require(path.join(ROOT, 'src', 'longterm', 'lenderprice', 'search-model.js'));

const CAPTURE = process.env.LP_CAPTURE_REQUEST || '';   // optional path to a captured frontend body
const ANCHOR_ONLY = process.argv.includes('--anchor');
const L = (s) => console.log(s);

const AUTH = process.env.LP_AUTH_BASE || 'https://auth.digitallending.com';
const API = process.env.LP_API_BASE || 'https://api.digitallending.com';
const ORIGIN = process.env.LP_ORIGIN || 'https://yscapgroup.digitallending.com';
const ID = process.env.LP_CLIENT_ID || 'acme2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0';

let SESS = null;
async function login() {
  const basic = 'Basic ' + Buffer.from(`${ID}:${process.env.LP_CLIENT_SECRET}`, 'utf8').toString('base64');
  const r = await fetch(`${AUTH}/oauth/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json', 'User-Agent': UA, Origin: ORIGIN, Referer: ORIGIN + '/', Authorization: basic },
    body: new URLSearchParams({ grant_type: 'password', username: process.env.LP_USERNAME, password: process.env.LP_PASSWORD, client_id: ID }).toString() });
  SESS = await r.json();
  if (!SESS || !SESS.access_token) throw new Error('login failed');
}
async function post(body) {
  const r = await fetch(`${API}/rest/v1/lp-ppe-integration/pricing/searchRaw/${SESS.companyId}/${SESS.userId}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${SESS.access_token}`, Origin: ORIGIN, Referer: ORIGIN + '/', 'User-Agent': UA },
    body: JSON.stringify(body), redirect: 'manual' });
  const t = await r.text().catch(() => '');
  if (r.status !== 200) return { status: r.status };
  let j = null; try { j = JSON.parse(t); } catch {}
  let f = null; try { f = lp.parseFull(j); } catch {}
  return {
    status: 200,
    programs: f && f.programCount, options: f && f.optionCount, lenders: f && f.lenderCount,
    names: f && Array.isArray(f.programs) ? f.programs.map((p) => (p.lender || p.investor || '?') + ' / ' + (p.program || p.product || '?')).sort() : [],
    minRate: f && Array.isArray(f.programs) && f.programs.length
      ? Math.min(...f.programs.map((p) => (typeof p.minRate === 'number' ? p.minRate : Infinity))) : null,
  };
}

// The matrix the owner's developer asked for: one axis moved at a time off a common baseline, so a
// row that misbehaves names its own cause instead of needing a second bisection.
const BASE = {
  purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.5,
  state: 'NY', zip: '11211', countyFps: '36047', county: 'Kings',
  propertyType: 'SingleFamily', units: 1, attachmentType: 'Detached',
  borrowerType: 'LLC', incomeDocType: 'DSCR', termYears: 30, lockDays: 30, prepayMonths: 60,
};
const MATRIX = [
  ['baseline — purchase, 80% LTV, FICO 760', {}],
  ['FICO 700', { fico: 700 }],
  ['FICO 680', { fico: 680 }],
  ['75% LTV (loan 375k)', { loan: 375000 }],
  ['65% LTV (loan 325k)', { loan: 325000 }],
  ['rate-and-term refinance', { purpose: 'Refinance' }],
  ['cash-out refinance', { purpose: 'Cash out', cashoutAmount: 50000 }],
  ['15-day lock', { lockDays: 15 }],
  ['45-day lock', { lockDays: 45 }],
  ['15-year term', { termYears: 15 }],
  ['no prepay', { prepayMonths: 0 }],
  ['36-month prepay', { prepayMonths: 36 }],
  ['DSCR 1.10 (a different band)', { dscr: 1.10 }],
  ['DSCR 0.90 (a different band)', { dscr: 0.90 }],
  ['2-4 unit', { propertyType: '2-4 Unit', units: 3 }],
  ['larger deal — 1.2M value / 840k loan', { value: 1200000, loan: 840000 }],
];

(async () => {
  await login();
  L('login OK — company ' + SESS.companyId + '\n');

  // ---- the anchor: exact parity against the one body we know prices --------------------------
  let anchorOk = null;
  if (CAPTURE && fs.existsSync(CAPTURE)) {
    const front = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
    const c = front.criteria, a = front.property.address, d = front.dynamicPropertiesMap || {};
    const scenario = {
      purpose: c.loanPurpose === 'Refinance' ? 'Refinance' : c.loanPurpose === 'Purchase' ? 'Purchase' : 'Cash out',
      value: c.purchasePrice, loan: c.loanAmount, fico: c.fico, dscr: c.dscr,
      state: a.state, zip: a.zip, countyFps: a.county, county: a.countyName, city: a.city,
      propertyType: front.property.propertyType, units: front.property.numberOfUnit,
      attachmentType: front.property.attachmentType, io: !!c.interestOnly, termYears: c.loanYear,
      prepayMonths: (() => { const m = /(\d+)/.exec(String((d.PrepayTerm || {}).value || '')); return m ? Number(m[1]) : undefined; })(),
      borrowerType: (d.GLOBAL_BorrowerType || {}).value, incomeDocType: (d.IncomeDocType || {}).value,
    };
    L('=== ANCHOR — exact parity against the captured frontend request ===');
    const theirs = await post(front);
    const built = sm.validateScenario(scenario);
    const ours = built.ok ? await post(built.request) : { status: 'refused: ' + built.error };
    L('  frontend capture : ' + fmt(theirs));
    L('  our builder      : ' + fmt(ours));
    anchorOk = theirs.status === 200 && ours.status === 200 &&
      theirs.programs === ours.programs && theirs.options === ours.options && theirs.lenders === ours.lenders;
    L('  parity           : ' + (anchorOk ? 'EXACT' : 'MISMATCH'));
    if (theirs.status === 200 && ours.status === 200 && !anchorOk) {
      const only = (x, y) => x.names.filter((n) => !y.names.includes(n));
      L('    only theirs: ' + (only(theirs, ours).join(', ') || '(none)'));
      L('    only ours  : ' + (only(ours, theirs).join(', ') || '(none)'));
    }
  } else {
    L('=== ANCHOR SKIPPED — set LP_CAPTURE_REQUEST to a captured frontend request body ===');
    L('    Without it this run measures only what WE return; it cannot prove parity with anything.');
  }
  if (ANCHOR_ONLY) return;

  // ---- the matrix: a recorded baseline per scenario --------------------------------------------
  L('\n=== MATRIX — what our request returns (a baseline to regress against, not a comparison) ===');
  L('  ' + 'scenario'.padEnd(44) + 'result');
  L('  ' + '-'.repeat(84));
  const out = [];
  for (const [name, patch] of MATRIX) {
    const v = sm.validateScenario({ ...BASE, ...patch });
    let r;
    if (!v.ok) r = { status: 'refused locally: ' + (v.error || '') + (v.field ? ' [' + v.field + ']' : '') };
    else r = await post(v.request);
    L('  ' + name.padEnd(44) + fmt(r));
    out.push({ name, ...r, names: undefined });
    await new Promise((s) => setTimeout(s, 600));
  }

  const priced = out.filter((r) => r.status === 200 && r.programs > 0).length;
  const empty = out.filter((r) => r.status === 200 && !r.programs);
  const failed = out.filter((r) => r.status !== 200);
  L('\n================ SUMMARY ================');
  L('  anchor parity : ' + (anchorOk === null ? 'not run' : anchorOk ? 'EXACT' : 'MISMATCH'));
  L('  priced        : ' + priced + '/' + out.length);
  if (empty.length) L('  200 but ZERO programs (investigate — the vendor prices these on the website):\n    ' + empty.map((r) => r.name).join('\n    '));
  if (failed.length) L('  did NOT return 200:\n    ' + failed.map((r) => r.name + ' → ' + r.status).join('\n    '));
})().catch((e) => L('THREW: ' + (e && e.message ? e.message : String(e))));

function fmt(r) {
  if (r.status !== 200) return String(r.status);
  return String(r.programs).padStart(3) + ' programs, ' + String(r.options).padStart(4) + ' options, ' +
    String(r.lenders).padStart(2) + ' lenders' + (r.minRate != null && isFinite(r.minRate) ? ', best ' + r.minRate + '%' : '');
}
