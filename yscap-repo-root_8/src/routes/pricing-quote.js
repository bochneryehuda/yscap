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
    return res.json({ ...out, deal });
  } catch (e) {
    // Never leak an engine's internals through an error string on a public door.
    return res.status(500).json({ available: false, reason: 'pricing error' });
  }
});

module.exports = router;
