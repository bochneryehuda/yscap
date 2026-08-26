'use strict';
/**
 * src/lib/lender-fees.js — OUR OWN FEE, SPLIT INTO ITS TWO REAL PARTS, PLUS THE NEW YORK LADDER.
 *
 * OWNER-DIRECTED 2026-08-26, and this is the written authorization the frozen-pricing HARD RULE
 * requires. Three quotes, in the owner's own words:
 *
 *   THE SPLIT — *"Right now, we have $2,195 for our total fees. I want to split it up for: general
 *   products: $1,200 underwriting, processing; $995 legal fee for general files … This should be
 *   split up in the structure screen of the products and pricing. You need to make sure you wire
 *   all these fees correctly into the liquidity, cash to close, and stuff like that. So the total
 *   stays the same for general loans."*
 *
 *   THE NEW YORK LEGAL LADDER — *"For any New York file, remove the extra settlement fee that we
 *   have now listed for New York files and replace it with higher legal fees instead of $995. Any
 *   New York file should populate a base fee of $2,000 legal fee … On heavier rehab in New York, or
 *   any New York City file, the base legal fee in New York instead of $2,000 should pre-populate as
 *   $2,500 … in New York, the base fee for a smaller construction (less than $100,000): If it's not
 *   in the New York City five boroughs, then it's a $2,000 base legal fee. If it's in the five
 *   boroughs or the construction's worth $100,000, then it's $2,500. For any ground-up, the
 *   standard price is $2,000 in general. If it's in New York, then it's $2,500."*
 *
 *   THE OPTIONAL SETTLEMENT AGENT FEE — *"Now, for New York files, pre-fill the settlement fee that
 *   I just told you to remove … Pre-fill an optional settlement fee of $500 to $750. A pre-filler
 *   that we should be able to change it … it should say on the term sheet everywhere that it's
 *   optional, but it should be included in calculating the cash to close. It should say that it's
 *   optional: New York settlement agent fee, which is a New York settlement agent fee on top of the
 *   regular 2,000."*
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE TOTAL IS A DERIVED FIGURE AND THE PARTS ARE THE TRUTH. `lenderFee` has been ONE number
 * ($2,195) read by the closing-cost block, the cash-to-close total, the liquidity to show, the
 * registered quote, the data tapes and every printed sheet. Splitting it by REPLACING that number
 * would have meant finding every reader; instead the two parts are authored and the total is their
 * SUM, so every existing reader keeps working and *"the total stays the same for general loans"* is
 * preserved BY CONSTRUCTION rather than by a test that has to remember to check it.
 *
 * A TYPED TOTAL STILL WINS, AND THEN NOTHING IS SPLIT. `opts.total` (the studio's `lenderFee` box)
 * predates this and rides on registered quotes already on file. When it is set we honour it as the
 * TOTAL and report `split:false`, so those files print the single "Underwriting / processing /
 * legal" line they always printed. Inventing a split for a number somebody typed as a whole would
 * be putting two figures on a term sheet that nobody chose.
 *
 * THE FIVE BOROUGHS ARE NOT DEFINED HERE, AND THAT IS DELIBERATE. `web/v2/tools/gov-charges.js`
 * already answers "is this property in New York City?" — it has to, because that question decides
 * the NYC mortgage recording tax, which is the largest single number on a New York City closing.
 * A second list here would be a second copy of one rule, and the copy that drifts is the one that
 * leaks: a file could be taxed as Brooklyn and billed as upstate on the same term sheet. So this
 * module DELEGATES (`nycFile`), and it inherits that module's own county-first, city-fallback
 * reading — which is what makes "Richmond County, NY" read as Staten Island while Richmond,
 * Virginia never does (the state is established first).
 *
 * PURE of database and config — no `db`, no `pricing-settings`, no environment. Its one require is
 * that shared rule module, which is itself pure. So every rule here is unit-testable and the
 * server, the studio and the admin screen read ONE definition.
 */

/* The ONE definition of "the five boroughs" — see the header. `closing-costs.js` is a two-line
   re-export of the browser/Node UMD rule module, so this is the same code the studio runs. */
const gov = require('./closing-costs');

/** The owner's numbers. OWNER-SET: changing one changes what a real borrower is charged. */
const SYSTEM_LENDER_FEES = Object.freeze({
  /* THE GENERAL FILE — and 1200 + 995 = 2195, the total that must not move. */
  underwriting: 1200,
  legal: 995,
  /* THE LEGAL LADDER. A ground-up carries its own base wherever it is; New York carries its own
     base and its own higher rung. See `legalFeeFor` for the order, which is load-bearing. */
  legalGroundUp: 2000,
  legalNy: 2000,
  legalNyHigh: 2500,
  /* THE OPTIONAL NEW YORK SETTLEMENT AGENT FEE. The owner gave a RANGE ($500 to $750) and this is
     a PRE-FILL, changeable per file — so it is set at the top of the range, which is the end that
     cannot leave a borrower short of what they are asked to bring to the table. */
  settlementNy: 750,
});

/** What each part is CALLED on a term sheet. The owner's own words for each. */
const LENDER_FEE_LABEL = Object.freeze({
  underwriting: 'Underwriting & processing',
  legal: 'Legal fee',
  /* The pre-split wording, kept verbatim, for a file carrying a typed whole-number total. */
  combined: 'Underwriting / processing / legal',
  settlement: 'New York settlement agent fee (optional)',
});

/** The one-line explanations that ride with the parts, so nothing is charged unexplained. */
const LENDER_FEE_NOTE = Object.freeze({
  settlement: 'Optional — a New York settlement agent attends the closing on the lender’s behalf. '
    + 'It is included in the cash to close shown here so the figure is never short.',
});

/* The construction figure at which a New York file moves to the higher legal fee. The owner's own
   words are *"the construction's worth $100,000"*, and the boundary is INCLUSIVE of $100,000 —
   they described the LOWER fee as being for *"a smaller construction (less than $100,000)"*. */
const NY_CONSTRUCTION_STEP = 100000;

/** Every rung the legal ladder can land on, with the words a screen can explain the number with. */
const LEGAL_BASIS_TEXT = Object.freeze({
  general: 'the standard legal fee',
  ground_up: 'a ground-up construction file',
  ground_up_ny: 'a ground-up construction file in New York',
  ny_base: 'a New York file',
  ny_five_boroughs: 'a New York City file (the five boroughs)',
  ny_construction: 'a New York file with a construction budget of $100,000 or more',
  ny_heavy_rehab: 'a heavy-rehab file in New York',
  manual: 'typed on this file',
  typed_total: 'a total typed on this file',
});

const low = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** Clean a stored/typed amount. Junk and negatives state NOTHING rather than becoming a zero fee. */
function cleanFeeAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  // A four-figure fee is the shape of this product; past five figures is a decimal slip, and
  // quietly charging it would be worse than refusing to read it.
  if (n > 100000) return null;
  return Math.round(n * 100) / 100;
}

/** Is the subject property in New York State? Matched on the two-letter code or the full name. */
function isNewYork(state) {
  const s = low(state);
  return s === 'ny' || s === 'new york';
}

/**
 * Is this file in the five boroughs? DELEGATED — see the header. The county is asked first and the
 * city is the fallback, because a property address reliably carries a city while only some carry a
 * county, and a county is unambiguous ("Kings" is Brooklyn and nothing else).
 *
 * IT ANSWERS ONLY ABOUT NEW YORK: the caller has already established the state, and this is asked
 * only then — so Richmond, Virginia can never read as Staten Island.
 */
function isFiveBoroughs(deal) {
  const d = deal || {};
  try {
    if (gov.NYC_COUNTIES.has(gov.normCounty(d.county))) return true;
    return !!gov.isNycCity(d.city);
  } catch (_) {
    // An unreadable rule module must never claim a borough it cannot prove — the lower rung is the
    // one that cannot over-charge a borrower for a fee nobody could justify.
    return false;
  }
}

/**
 * THE LEGAL FEE FOR THIS DEAL — the ladder, in the owner's own order.
 *
 * GROUND-UP IS DECIDED FIRST, exactly as the feasibility fee decides it, and for the same reason:
 * a ground-up carries its OWN base ($2,000) that has nothing to do with the general $995, and its
 * New York step is the same $2,500. Deciding it after the New York test would price a non-New-York
 * ground-up at the general fee.
 *
 * A NON-NEW-YORK HEAVY REHAB IS DELIBERATELY NOT ON THE LADDER. The owner named heavy rehab only
 * inside New York (*"On heavier rehab in New York…"*), so it stays at the general fee everywhere
 * else — and it is a pre-fill either way, editable on the file.
 *
 * @returns {{ amount:number, basis:string }} — `basis` NAMES which rung was taken, so a screen can
 *          explain the number rather than just printing it.
 */
function legalFeeFor(deal, fees) {
  const f = fees || SYSTEM_LENDER_FEES;
  const d = deal || {};
  const ny = isNewYork(d.state);
  const groundUp = !!d.groundUp;
  const heavy = !!d.heavyRehab;
  const construction = Number(d.construction) || 0;

  if (groundUp) {
    return ny
      ? { amount: f.legalNyHigh, basis: 'ground_up_ny' }
      : { amount: f.legalGroundUp, basis: 'ground_up' };
  }
  if (ny) {
    // The higher New York rung: a city file, a real construction budget, or a heavy rehab.
    if (isFiveBoroughs(d)) return { amount: f.legalNyHigh, basis: 'ny_five_boroughs' };
    if (construction >= NY_CONSTRUCTION_STEP) return { amount: f.legalNyHigh, basis: 'ny_construction' };
    if (heavy) return { amount: f.legalNyHigh, basis: 'ny_heavy_rehab' };
    return { amount: f.legalNy, basis: 'ny_base' };
  }
  return { amount: f.legal, basis: 'general' };
}

/** Normalize the company's configured amounts. Any absent key falls back to the owner's number. */
function cleanLenderFees(v) {
  const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const out = {};
  for (const k of Object.keys(SYSTEM_LENDER_FEES)) {
    const n = cleanFeeAmount(o[k]);
    out[k] = n == null ? SYSTEM_LENDER_FEES[k] : n;
  }
  return Object.freeze(out);
}

/**
 * THE TWO PARTS AND THEIR TOTAL — the one function every surface calls.
 *
 * Precedence, mirroring every other fee here: a per-file MANUAL amount wins for its own part;
 * otherwise the company's number (underwriting) or this deal's own rung (legal). An explicit
 * manual **0** is honoured as "waived on this file" — it is a number somebody typed, and reading
 * it as "unset" would make the part impossible to remove from one deal.
 *
 * @returns {{ underwriting:number, legal:number, total:number, legalBasis:string, split:boolean,
 *             manualUnderwriting:boolean, manualLegal:boolean }}
 */
function lenderFeesFor(deal, settings, opts) {
  const o = opts || {};
  const fees = cleanLenderFees(settings && settings.lenderFees);

  /* THE LEGACY WHOLE-NUMBER KNOB. It predates the split and rides on quotes already registered,
     so it stays authoritative — and when it is used nothing is split, because two figures nobody
     chose have no business on a term sheet. */
  const typedTotal = cleanFeeAmount(o.total);
  if (typedTotal != null) {
    return {
      underwriting: typedTotal, legal: 0, total: typedTotal,
      legalBasis: 'typed_total', split: false, manualUnderwriting: true, manualLegal: false,
    };
  }

  const typedUw = cleanFeeAmount(o.underwriting);
  const typedLegal = cleanFeeAmount(o.legal);
  const rung = legalFeeFor(deal, fees);
  const underwriting = typedUw == null ? fees.underwriting : typedUw;
  const legal = typedLegal == null ? rung.amount : typedLegal;
  return {
    underwriting,
    legal,
    total: Math.round((underwriting + legal) * 100) / 100,
    legalBasis: typedLegal == null ? rung.basis : 'manual',
    split: true,
    manualUnderwriting: typedUw != null,
    manualLegal: typedLegal != null,
  };
}

/**
 * THE OPTIONAL NEW YORK SETTLEMENT AGENT FEE — *"on top of the regular 2,000"*.
 *
 * IT REPLACES THE OLD MANDATORY ONE, WHICH IS THE HALF THAT IS EASY TO MISS. Until today a New
 * York file carried a $2,000 "Settlement agent fee" as a company EXTRA FEE (`extraFees`), and the
 * owner asked for that to be removed and folded into the higher legal fee. Leaving it in place
 * beside this would charge a New York borrower twice — so the migration that adds this REMOVES
 * that row, and `pricing-settings.SYSTEM_DEFAULTS` no longer carries it either (a cold cache would
 * otherwise re-apply it).
 *
 * OPTIONAL, AND STILL IN THE CASH TO CLOSE. The owner asked for both, and they are not in tension:
 * a fee the borrower may decline is still a fee we must not leave them short of, so it is quoted
 * and it is LABELLED optional on every surface that prints it. A typed **0** declines it.
 *
 * @returns {{ amount:number, label:string, note:string, optional:true, manual:boolean }|null}
 */
function settlementFeeFor(deal, settings, opts) {
  const o = opts || {};
  const fees = cleanLenderFees(settings && settings.lenderFees);
  const typed = cleanFeeAmount(o.settlement);
  if (typed != null) {
    if (typed === 0) return null;      // declined on this file
    return {
      amount: typed, label: LENDER_FEE_LABEL.settlement, note: LENDER_FEE_NOTE.settlement,
      optional: true, manual: true,
    };
  }
  if (!isNewYork(deal && deal.state)) return null;
  const amount = fees.settlementNy;
  if (!(amount > 0)) return null;      // a company that set it to zero offers nothing
  return {
    amount, label: LENDER_FEE_LABEL.settlement, note: LENDER_FEE_NOTE.settlement,
    optional: true, manual: false,
  };
}

/** Plain words for a rung, so a screen explains the number instead of only printing it. */
function legalBasisText(basis) {
  return LEGAL_BASIS_TEXT[basis] || LEGAL_BASIS_TEXT.general;
}

module.exports = {
  SYSTEM_LENDER_FEES, LENDER_FEE_LABEL, LENDER_FEE_NOTE, NY_CONSTRUCTION_STEP, LEGAL_BASIS_TEXT,
  isNewYork, isFiveBoroughs, legalFeeFor, legalBasisText,
  cleanFeeAmount, cleanLenderFees, lenderFeesFor, settlementFeeFor,
};
