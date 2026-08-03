'use strict';
/**
 * The term-sheet studio's quote, computed on the SERVER. (issue #7, phase 2)
 *
 * WHY THIS EXISTS. The pricing engines sit in the public web root because the
 * BROWSER runs them — that is the whole of finding #7. They can only come out
 * once the page can get its answer from here instead. Phase 1 built the answer
 * (src/lib/pricing-studio.js) and proved it identical to what the browser
 * computes, over 4.1M fields; this is the door onto it.
 *
 * WHY IT IS PUBLIC, AND WHY THAT IS NOT A STEP BACKWARDS. The marketing term
 * sheet is an anonymous page — a visitor prices a deal without an account — so
 * a login-gated route could not serve it. What matters is that this is STRICTLY
 * LESS exposure than today: right now the page downloads the entire guideline
 * book (the leverage MATRIX, the RA rate build-up, Silver's whole RATE_BLOCKS
 * grid) and anyone can read it at their leisure, offline, in full. This hands
 * back ONE priced deal per request and never the tables behind it. Rate limited
 * hard, and `no-store` so nothing about a visitor's deal is cached.
 *
 * WHAT IT DOES NOT ACCEPT. The admin-zone knobs. A quote asked for from an
 * unauthenticated page may not set the company markup, the origination, the
 * lender/credit/appraisal/title fees, or a manual LTV/rate basis — those are
 * staff-grade inputs and they belong to the authenticated staff pricing routes
 * (`/api/staff/applications/:id/pricing/*`), exactly as audit S1-04 decided for
 * the borrower. The company markup is applied here from pricing-settings, the
 * same source `/api/pricing-defaults` already publishes, so the note rate is the
 * rate the tool has always shown.
 */
const express = require('express');
const router = express.Router();

const studio = require('../lib/pricing-studio');
const pricingSettings = require('../lib/pricing-settings');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const str = (v) => (v == null ? '' : String(v).slice(0, 200));

/* Exactly the keys the browser's own gather() builds, and NOTHING else.
   Anything not on this list is dropped rather than passed through — an
   unauthenticated caller must not be able to reach an engine input just because
   the engine happens to read it. The admin knobs (ovrAcqLTV / ovrARLTV / ovrLTC
   / ovrRate / forcePrice / ovrEffPrice / manualPricing / oopRehab) are
   deliberately absent; see the header. */
function sanitizeDeal(body) {
  const b = body || {};
  const d = {
    loanType: /refi/i.test(str(b.loanType)) ? 'Refinance' : 'Purchase',
    cashOut: bool(b.cashOut),
    strategy: str(b.strategy),
    state: str(b.state).slice(0, 2).toUpperCase(),
    city: str(b.city),
    address: str(b.address),
    propertyType: str(b.propertyType),
    fico: num(b.fico) || 0,
    expFlips: Math.max(0, Math.min(999, num(b.expFlips) || 0)),
    expHolds: Math.max(0, Math.min(999, num(b.expHolds) || 0)),
    expGround: Math.max(0, Math.min(999, num(b.expGround) || 0)),
    purchasePrice: Math.max(0, num(b.purchasePrice) || 0),
    asIsValue: Math.max(0, num(b.asIsValue) || 0),
    arv: Math.max(0, num(b.arv) || 0),
    rehabBudget: Math.max(0, num(b.rehabBudget) || 0),
    term: Math.max(1, Math.min(36, num(b.term) || 12)),
    irMonths: Math.max(0, Math.min(24, num(b.irMonths) || 0)),
    // The studio's LEVERAGE SLIDER, and it belongs here: all three engines
    // apply it as `Math.min(maxLTC, targetLTC)`, so it can only ever LOWER the
    // cap — it is the borrower asking for less, not an override reaching past
    // one. src/lib/pricing.js already whitelists it for the same reason.
    // Dropping it (audit 2026-08-03) made every rung of the leverage ladder
    // answer with the maximum-leverage loan, so moving the slider changed
    // nothing on screen. 0 / absent means "no target", which is how the
    // engines' own `targetLTC > 0` guard reads it.
    targetLTC: Math.max(0, Math.min(1, num(b.targetLTC) || 0)),
    irAmount: Math.max(0, Math.min(100000000, num(b.irAmount) || 0)),
    accrual: 'Non-Dutch',                 // the frozen engine input, never client-set
    sqftAddition: bool(b.sqftAddition),
    heavyRehab: bool(b.heavyRehab),
    isAssignment: bool(b.isAssignment),
    sellerPrice: Math.max(0, num(b.sellerPrice) || 0),
  };
  // A refinance never carries a purchase price (deal-basis rule, 2026-08-02):
  // the engine sizes it on the as-is value, and the studio already sends it that
  // way. Re-assert it so a hand-made request cannot price a refinance off a
  // price the file would never hold.
  if (d.loanType === 'Refinance') d.purchasePrice = d.asIsValue;
  if (!d.isAssignment) d.sellerPrice = 0;
  return d;
}

/* The company markup, from the same place /api/pricing-defaults publishes it —
   so the rate this returns is the rate the tool has always displayed. Never
   client-set: a caller who could choose the markup could price at cost. */
function companyMarkups() {
  try {
    const cd = pricingSettings.current() || {};
    const pick = (v) => (v == null || v === '' ? undefined : Number(v) / 100);
    return { standard: pick(cd.markupStdPct), gold: pick(cd.markupGoldPct), silver: pick(cd.markupSilverPct) };
  } catch (_) { return {}; }
}

/* WHAT LEAVES THIS DOOR — an ALLOWLIST, because the engines' own result is not
   a borrower-facing object.

   The header above claims this hands back "ONE priced deal per request and
   never the tables behind it". An audit (2026-08-03) proved that claim false:
   `evaluate` was passed through verbatim, so a single anonymous request also
   carried Silver's `overlays` — the note-buyer Underwriting Commentary, all 13
   items INCLUDING the ones that do not apply to the deal, one of which names a
   third-party vendor outright — plus `tierCaps`, the workbook Tier Grid row
   copied verbatim, and `rateKey`, the RATE_BLOCKS index of the cell just
   priced, which is a map for sweeping the grid.

   Those three are guideline TABLE data wearing a quote's clothing, and a
   capital-partner name on an anonymous surface breaks the standing rule that
   such a name never appears on anything borrower-facing.

   This is also what makes phase 4 worth doing. The text is downloadable from
   the engines in the public web root TODAY — that is finding #7 itself — so
   deleting those files is the fix. But delete them while this route still
   passes the same fields through and the leak has not been closed, only moved
   from a .js file to a JSON body. Narrowing here is a PREREQUISITE for phase 4,
   not a nicety.

   An ALLOWLIST rather than a denylist, deliberately: a denylist only covers the
   fields somebody thought of, and the engines gain fields. Anything new is
   withheld until a human classifies it — and `test-pricing-quote-route-db`
   fails on an unclassified key, so "withheld by default" can never quietly
   drop something the page needs. */
const PUBLIC_EVALUATE_FIELDS = new Set([
  // the verdict and why
  'status', 'eligible', 'reasons', 'pricingReady', 'available',
  // what the deal is
  'program', 'product', 'productLabel', 'kind', 'regime', 'loanType', 'strategyCode',
  'exit', 'cashOut', 'market', 'sizeBand', 'tier', 'tierLabel', 'projectCount',
  // the money the sheet prints
  'noteRate', 'sizing', 'caps', 'pricedCeiling', 'origination', 'origPct', 'drawFee',
  'liquidity', 'liquidityPct',
  // structure
  'reserveTermCapped', 'reserveTermMonths', 'reserveEligible', 'reserveInCost',
  'reserveCapIsConstruction', 'irRequired', 'irLocked', 'defaultTerm',
  // flags the page branches on
  'assignment', 'exitShortfall', 'escalations', 'cityReview', 'foreclosure',
  'heavy', 'heavyAuto', 'sqft', 'multiUnit', 'gcOnly', 'dscr',
]);

/* Withheld ON PURPOSE. Named rather than merely absent, so the guard test can
   tell "we decided against this" from "nobody has looked at this yet". */
const WITHHELD_EVALUATE_FIELDS = new Set([
  'overlays',   // the note-buyer Underwriting Commentary; names a third party
  'tierCaps',   // the workbook Tier Grid row verbatim — silver-program.js says
                // in its own comment this "is NOT what a borrower is shown",
                // and termsheet.js says "NEVER read tierCaps" for display
  'rateKey',    // the RATE_BLOCKS cell index; the page reads it zero times
]);

function publicEvaluate(e) {
  if (!e || typeof e !== 'object') return e;
  const out = {};
  for (const k of Object.keys(e)) if (PUBLIC_EVALUATE_FIELDS.has(k)) out[k] = e[k];
  return out;
}

function publicBlock(b) {
  if (!b || typeof b !== 'object') return b;
  const out = { ...b };
  if (b.evaluate) out.evaluate = publicEvaluate(b.evaluate);
  return out;
}

router.post('/studio', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  try {
    const deal = sanitizeDeal(req.body);
    const out = studio.studioQuote(deal, companyMarkups());
    if (!out || out.available === false) {
      return res.status(503).json({ available: false, reason: 'pricing is temporarily unavailable' });
    }
    // Echo the deal the server actually priced. The page needs it to tell a
    // stale answer from a current one when the visitor keeps typing.
    return res.json({
      ...out,
      standard: publicBlock(out.standard),
      gold: publicBlock(out.gold),
      silver: publicBlock(out.silver),
      deal,
    });
  } catch (e) {
    // Never leak an engine's internals through an error string on a public door.
    return res.status(500).json({ available: false, reason: 'pricing error' });
  }
});

module.exports = router;
// Exposed so the guard test can assert the classification is COMPLETE: every
// key the engines actually produce must be in one set or the other. A new
// engine field lands in neither and fails CI, which is the point — it is how a
// future `overlays` gets noticed before it ships rather than after.
module.exports._internals = { PUBLIC_EVALUATE_FIELDS, WITHHELD_EVALUATE_FIELDS, publicEvaluate, sanitizeDeal };
