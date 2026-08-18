#!/usr/bin/env node
'use strict';
/**
 * LT — DOES LENDER PRICE ACTUALLY HEAR THE FIELD WE SET? (owner directive 2026-08-18)
 *
 * THE OWNER'S QUESTION, in their own words:
 *   "if you're pressing a cash-out, you see it for a purchase and stuff like that, then you know that
 *    your system … is not understanding it … If you put in a three-year prepayment penalty, you want
 *    the pricing for a 3[-year] penalty, just to make sure that the mirror is working correctly, that
 *    the scenario that they're entering is actually the system is reading it for the correct scenario,
 *    that the system understands your scenario exactly and it doesn't get any of your fields wrong."
 *
 * THE METHOD — A/B, ONE FIELD AT A TIME, MEASURED TWICE.
 * For each axis this takes a BASE scenario and a VARIANT differing in exactly ONE field, and asks two
 * independent questions:
 *
 *   (1) OFFLINE — did the outgoing request body actually change? `buildSearch` is pure, so this is
 *       free and needs no vendor call. A field that produces a BYTE-IDENTICAL body is a field Lender
 *       Price is never told about. That is the defect the owner is describing, and it is provable
 *       without spending a penny.
 *
 *   (2) LIVE — did the returned pricing change? Two real searches, compared rung for rung on the
 *       SAME lender+program. A body that changed but a price that did not means Lender Price heard
 *       the field and does not price it — a completely different (and acceptable) answer from
 *       "we never sent it".
 *
 * WHY BOTH. Either question alone is a trap. Offline-only cannot tell "sent and ignored" from "sent
 * and priced". Live-only cannot tell "we never sent it" from "they do not price it" — and those two
 * have opposite fixes. The 2x2 is the whole point:
 *
 *      body same  + price same  -> NOT SENT           (our bug — the field is dropped)
 *      body same  + price moved -> IMPOSSIBLE         (flagged loudly; means the run is not isolated)
 *      body moved + price same  -> SENT, NOT PRICED   (fine, but must be known)
 *      body moved + price moved -> HEARD AND PRICED   (what we want)
 *
 * EXPECTATIONS COME FROM THE RATE SHEET, NEVER FROM THE VENDOR. The owner: "Use your rate sheet for
 * the source of truth." Each axis declares whether our own sheet says the price SHOULD move. An axis
 * our sheet prices, where the live price does not move, is reported as a contradiction to chase — it
 * is never silently accepted as "the vendor knows best".
 *
 *   LP_USERNAME=… LP_PASSWORD=… LP_CLIENT_SECRET=… node scripts/test-lt-lp-field-fidelity.js
 *     [--axis purpose,prepay]   only these axes
 *     [--offline]               question (1) only — no vendor calls, no cost
 *     [--out report.json]       write the full per-axis report
 *
 * Live by design, so like `test-lt-lp-agreement-run.js` it is NOT in `npm test` and does NOT match the
 * `test-lt-ppe-*` aggregate glob. LT-only; no RTL imports; writes nothing anywhere.
 */
const fs = require('fs');
require('../src/config');
const client = require('../src/longterm/lenderprice/client');
const { buildSearch } = require('../src/longterm/lenderprice/search-model');

function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; }
const OFFLINE = process.argv.includes('--offline');

// A known-good, fully-specified investment DSCR deal. Every axis varies ONE field off this.
const BASE = {
  purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25,
  state: 'NY', zip: '11211', countyFps: '36047', county: 'Kings', city: 'Brooklyn',
  propertyType: 'SingleFamily', units: 1, prepayMonths: 60, borrowerType: 'LLC',
};

// `should` is what OUR RATE SHEET says: does this axis carry an LLPA or an eligibility cut?
//   'price'    — the sheet prices it; the live price SHOULD move
//   'eligible' — the sheet/matrix can DECLINE on it; the program set may change rather than the price
//   'maybe'    — informational or vendor-side only; no claim either way
const AXES = [
  // ---- the owner's two named examples, first ----
  { key: 'purpose_cashout', label: 'purpose: Purchase -> Cash-Out Refinance', should: 'price',
    // `cashoutAmount` — lower-case o. `cashOutAmount` is NOT a field, and the route 422s it rather
    // than dropping it, which is the behaviour that makes this whole harness trustworthy.
    patch: { purpose: 'CashOutRefinance', cashoutAmount: 50000 } },
  { key: 'purpose_ratterm', label: 'purpose: Purchase -> Rate/Term Refinance', should: 'price',
    patch: { purpose: 'RateTermRefinance' } },
  { key: 'prepay_36', label: 'prepay: 60 months -> 36 months (the 3-year penalty)', should: 'price',
    patch: { prepayMonths: 36 } },
  { key: 'prepay_12', label: 'prepay: 60 months -> 12 months', should: 'price', patch: { prepayMonths: 12 } },
  { key: 'prepay_0', label: 'prepay: 60 months -> none', should: 'price', patch: { prepayMonths: 0 } },
  // THE STRUCTURE, WITH NO TERM BESIDE IT. A '3,2,1' step-down IS a three-year penalty, but the
  // builder sends the structure and leaves the term at the five-year profile default — so the
  // request says 'a three-year step-down, over five years', which is not a product. Measured.
  { key: 'prepay_struct_321', label: 'prepay structure: Standard -> 3,2,1 (a THREE-year penalty)', should: 'price',
    patch: { prepayStructure: '3,2,1' } },
  { key: 'prepay_struct_21', label: 'prepay structure: Standard -> 2,1 (a TWO-year penalty)', should: 'price',
    patch: { prepayStructure: '2,1' } },

  // ---- the rest of the money axes ----
  { key: 'fico', label: 'fico: 760 -> 680', should: 'price', patch: { fico: 680 } },
  { key: 'ltv', label: 'ltv: 70% -> 80% (loan 350k -> 400k)', should: 'price', patch: { loan: 400000 } },
  { key: 'dscr', label: 'dscr: 1.25 -> 1.00', should: 'price', patch: { dscr: 1.00 } },
  { key: 'loansize', label: 'loan size: 350k -> 1.5M (value 500k -> 2M)', should: 'price', patch: { value: 2000000, loan: 1500000 } },
  { key: 'units', label: 'units: 1 -> 4 (2-4 unit LLPA)', should: 'price', patch: { units: 4, propertyType: 'Unit2_4' } },
  { key: 'proptype_condo', label: 'property type: SingleFamily -> Condominium', should: 'price', patch: { propertyType: 'Condominium' } },
  { key: 'lock', label: 'lock: default -> 45 days', should: 'price', patch: { lockDays: 45 } },
    // The term is in YEARS (`termYears`), and the base already IS 30 — so 30 would be a no-op that
  // reads as a dropped field. 40 is the real question, and it rides `termsCriteria` only:
  // `criteria.loanYear` deliberately stays 30 (the amortization), matching the captured frontend.
  { key: 'term', label: 'term: 30 -> 40 years', should: 'maybe', patch: { termYears: 40 } },
  { key: 'io', label: 'interest-only: off -> on', should: 'price', patch: { io: true } },
  { key: 'escrow', label: 'escrow waiver: off -> on', should: 'price', patch: { escrowWaive: true } },
  { key: 'state', label: 'state: NY -> TX (state adder)', should: 'price',
    patch: { state: 'TX', zip: '75201', countyFps: '48113', county: 'Dallas', city: 'Dallas' } },
  { key: 'borrower', label: 'borrower type: LLC -> Individual', should: 'eligible', patch: { borrowerType: 'Individual' } },
];

// ---- offline: did the request body change at all? ------------------------------------------------
// Compared as a canonical JSON string, and separately reported as the set of changed leaf PATHS, so a
// failure names the field rather than saying "something moved".
function flatten(o, prefix, out) {
  out = out || {}; prefix = prefix || '';
  if (o == null || typeof o !== 'object') { out[prefix] = o; return out; }
  if (Array.isArray(o)) { o.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out)); return out; }
  for (const k of Object.keys(o)) flatten(o[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}
function bodyDiff(a, b) {
  const fa = flatten(a), fb = flatten(b);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(fa[k]) !== JSON.stringify(fb[k])) changed.push({ path: k, from: fa[k], to: fb[k] });
  }
  // `date` moves on every build (it is a timestamp) and says nothing about the field under test.
  return changed.filter((c) => !/(^|\.)date($|\.)/.test(c.path));
}

// ---- live: did the PRICING change? --------------------------------------------------------------
// Compared on the ladder as a whole — the set of (lender, program, rate) -> price. Comparing only a
// "best rate" would miss a change that reshapes the ladder without moving its minimum, which is
// exactly what an LLPA does.
function ladderOf(parsed) {
  const out = {};
  for (const p of (parsed && parsed.programs) || []) {
    for (const r of p.rungs || []) {
      out[`${p.lender}|${p.program}|${r.rate}`] = r.price;
    }
  }
  return out;
}
function ladderDiff(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let moved = 0, appeared = 0, vanished = 0, maxDelta = 0;
  for (const k of keys) {
    const x = a[k], y = b[k];
    if (x == null && y != null) { appeared++; continue; }
    if (x != null && y == null) { vanished++; continue; }
    if (x !== y) { moved++; maxDelta = Math.max(maxDelta, Math.abs(y - x)); }
  }
  return { moved, appeared, vanished, maxDelta: Number(maxDelta.toFixed(4)), common: keys.size };
}

async function priceOnce(sc) {
  const raw = await client.price(sc);
  if (!raw || raw.ok === false) return { ok: false, why: (raw && (raw.message || raw.error || raw.reason)) || 'no answer' };
  const parsed = client.parse(raw.raw != null ? raw.raw : raw);
  return { ok: true, parsed, ladder: ladderOf(parsed), programCount: parsed.programCount, rungCount: parsed.rungCount };
}

async function main() {
  const only = arg('--axis');
  const axes = only ? AXES.filter((a) => only.split(',').includes(a.key)) : AXES;
  console.log(`Field fidelity: ${axes.length} axes, ${OFFLINE ? 'OFFLINE only (no vendor calls)' : 'offline + LIVE'}`);
  console.log(`Base scenario: ${JSON.stringify(BASE)}\n`);

  const baseBody = buildSearch(BASE);
  let baseLive = null;
  if (!OFFLINE) {
    if (!client.configured()) { console.error('LP_USERNAME / LP_PASSWORD / LP_CLIENT_SECRET are not set.'); process.exit(2); }
    baseLive = await priceOnce(BASE);
    if (!baseLive.ok) { console.error(`The BASE scenario would not price: ${baseLive.why}`); process.exit(3); }
    console.log(`Base priced: ${baseLive.programCount} programs, ${baseLive.rungCount} rungs, ${Object.keys(baseLive.ladder).length} ladder points\n`);
  }

  const report = [];
  let notSent = 0, impossible = 0, contradictions = 0;
  for (const ax of axes) {
    const sc = { ...BASE, ...ax.patch };
    let body, buildErr = null;
    try { body = buildSearch(sc); } catch (e) { buildErr = String(e && e.message || e); }
    const changed = buildErr ? [] : bodyDiff(baseBody, body);
    const bodyMoved = changed.length > 0;

    let live = null, ld = null;
    if (!OFFLINE && !buildErr) {
      live = await priceOnce(sc);
      if (live.ok) ld = ladderDiff(baseLive.ladder, live.ladder);
    }
    const priceMoved = ld ? (ld.moved > 0 || ld.appeared > 0 || ld.vanished > 0) : null;

    let verdict;
    if (buildErr) verdict = 'BUILD ERROR';
    else if (!bodyMoved && priceMoved === true) { verdict = 'IMPOSSIBLE'; impossible++; }
    else if (!bodyMoved) { verdict = 'NOT SENT'; notSent++; }
    else if (priceMoved === false) verdict = 'SENT, NOT PRICED';
    else if (priceMoved === true) verdict = 'HEARD AND PRICED';
    else verdict = 'SENT (live not run)';

    // Our own rate sheet said this axis carries money. If the vendor did not move, that is a
    // contradiction worth a human — never silently accepted.
    const contradiction = ax.should === 'price' && priceMoved === false;
    if (contradiction) contradictions++;

    const mark = verdict === 'HEARD AND PRICED' ? ' ok ' : (verdict === 'SENT, NOT PRICED' && ax.should !== 'price') ? ' ok ' : 'FLAG';
    console.log(`${mark}  ${ax.label}`);
    console.log(`        verdict: ${verdict}${contradiction ? '  <-- our sheet prices this axis and the vendor did not move' : ''}`);
    if (buildErr) console.log(`        build refused: ${buildErr}`);
    else console.log(`        request: ${changed.length} field(s) changed${changed.length ? ` -> ${changed.slice(0, 4).map((c) => c.path).join(', ')}${changed.length > 4 ? ` (+${changed.length - 4})` : ''}` : ''}`);
    if (ld) console.log(`        pricing: ${ld.moved} moved, ${ld.appeared} appeared, ${ld.vanished} vanished, max delta ${ld.maxDelta} (of ${ld.common})`);
    else if (live && !live.ok) console.log(`        pricing: would not price — ${live.why}`);

    report.push({ ...ax, verdict, contradiction, changed, ladder: ld, liveOk: live ? live.ok : null, liveWhy: live && !live.ok ? live.why : null });
  }

  console.log(`\n${axes.length} axes: ${notSent} NOT SENT, ${contradictions} contradiction(s) against our own rate sheet, ${impossible} impossible.`);
  if (impossible) console.log('An IMPOSSIBLE row means an identical request produced different pricing — the run is not isolated (vendor-side state, or a moving rate sheet). Re-run before believing any row.');
  const out = arg('--out');
  if (out) { fs.writeFileSync(out, JSON.stringify({ base: BASE, axes: report }, null, 2)); console.log(`report -> ${out}`); }
  // Exit non-zero on a DROPPED FIELD only. "Sent and not priced" is information, not a failure.
  process.exit(notSent || impossible ? 1 : 0);
}
main().catch((e) => { console.error('FIELD FIDELITY CRASHED:', e); process.exit(1); });
