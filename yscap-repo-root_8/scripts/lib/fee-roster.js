'use strict';
/**
 * fee-roster — THE ONE INVENTORY OF EVERY FEE THIS SYSTEM CHARGES, AND THE PLACES EACH ONE
 * HAS TO BE NAMED.
 *
 * WHY IT EXISTS (owner-directed 2026-08-26: *"open up an audit engine to audit the entire fee
 * structure … make sure every single fee populates every place where fees can populate, which
 * means on all the term sheets, on the structure screen, on the cash to close, on the liquidity
 * requirement, everywhere"*).
 *
 * THE STANDING RULE THIS AUTOMATES. *"Folding an amount into a total is HALF a fee. Wire it into
 * the total AND name it on every surface that itemises — in the same commit."* That rule has been
 * broken three times in six days, each time the same way and each time found by a human rather
 * than by the build: the construction feasibility fee reached the total on 2026-08-21 and was
 * named on ONE spreadsheet column; the 2026-08-26 pass named it on the term sheet and missed the
 * borrower's own email; and this pass found it missing from the staff Products & Pricing panel and
 * found the TPO broker fee missing from the borrower email. A fee that is charged and not named is
 * a document whose fees do not add up to the total printed beneath them.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE HALF THAT IS DERIVED, AND WHY THAT IS THE WHOLE POINT. A hand-kept list of fees is a list
 * that goes stale the day somebody adds the eleventh one — which is exactly how this class keeps
 * recurring. So `serverClosingAddends()` READS THE CLOSING SUM OUT OF `src/lib/pricing.js` and
 * `studioClosingAddends()` reads the studio's browser mirror out of `web/v2/tools/termsheet.js`.
 * The audit then asserts the roster and those two expressions describe the SAME set of fees, in
 * both directions. Add a fee to the total and forget the roster: the build fails, and it fails
 * naming the fee. Add it to the roster and not to a surface: the build fails naming the surface.
 *
 * THE HALF THAT IS AUTHORED is the per-surface token — the source expression that PROVES a
 * surface prints that fee. There is no deriving that: nine surfaces draw their fee rows by hand
 * (a PDF row call, three spreadsheet arrays, two panels, an email table). Rewriting all nine to be
 * registry-driven would be a rewrite of the printing code on the one document that goes out for
 * signature, which this repo's own rules say to earn rather than assume. So the surfaces stay
 * hand-written and the audit proves they agree.
 *
 * EVERY TOKEN IS KEYED ON THE SURFACE'S OWN DATA VARIABLE. The three spreadsheet columns are
 * built from `d` / `gd` / `sd` — that is the only thing that tells them apart in source — and it
 * is load-bearing: the feasibility fee was "present" in the spreadsheet for five days while being
 * absent from Gold and Silver, because a search for the word found the Standard column and
 * stopped. Never loosen a token to something a neighbouring column could satisfy.
 *
 * PURE: no database, no network, no browser. Read by `scripts/test-fee-audit-pure.js` (which CI
 * runs) and by `scripts/render-fee-audit.js` (which renders the real PDF), so the two halves can
 * never disagree about what the fee list is.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const P = {
  pricing: path.join(REPO, 'src/lib/pricing.js'),
  studio: path.join(REPO, 'web/v2/tools/termsheet.js'),
  studioHtml: path.join(REPO, 'web/v2/tools/term-sheet.html'),
  staffPanel: path.join(REPO, 'app-v2/src/components/ProductStudioPanel.jsx'),
  borrowerEmail: path.join(REPO, 'src/lib/product-registration.js'),
  termOptions: path.join(REPO, 'src/lib/term-options.js'),
};
const read = (k) => fs.readFileSync(P[k], 'utf8');

/* COMMENTS ARE STRIPPED BEFORE EVERY SOURCE TEST. This file's own subject matter forces the
   production code to NAME each fee in a comment explaining why the row is there — so a guard that
   read comments would pass on a surface whose row had been deleted but whose explanation
   survived. That trap has bitten this repo four separate times; it is not hypothetical. */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
}

/** The source between two anchors, comments stripped. Throws rather than returning '' — an empty
 *  region silently passes every "must not contain" test and fails every "must contain" one, which
 *  reads as a broken feature instead of a broken guard. */
function region(src, startRe, endRe, what) {
  const s = String(src);
  const a = s.search(startRe);
  if (a < 0) throw new Error(`fee-roster: cannot find the start of ${what}`);
  const rest = s.slice(a + 1);
  const b = rest.search(endRe);
  if (b < 0) throw new Error(`fee-roster: cannot find the end of ${what}`);
  return stripComments(rest.slice(0, b));
}

/* ── THE DERIVED HALF ───────────────────────────────────────────────────────────────────────── */

/** Split a `round2(a + b + c)` style sum into its addend names. */
function addendsOf(expr) {
  return String(expr).split('+').map((t) => t.trim().replace(/\(\)$/, '')).filter(Boolean);
}

/** The server's own closing-cost sum, read out of pricing.js. THE source of truth for "which fees
 *  are charged at the table" — everything else in this file is measured against it. */
function serverClosingAddends() {
  const src = stripComments(read('pricing'));
  const m = src.match(/const\s+closingDueAtClose\s*=\s*round2\(([^)]*)\)/);
  if (!m) throw new Error('fee-roster: the closing-cost sum has moved — find `closingDueAtClose` in src/lib/pricing.js');
  return addendsOf(m[1]);
}

/** The studio's BROWSER MIRROR of that sum. There are three copies (calc / calcGold / calcSilver)
 *  and they must all agree: a fee in one program's mirror and not another's means the printed
 *  sheet disagrees with the registered quote on that program alone. */
function studioClosingAddends() {
  const src = stripComments(read('studio'));
  const all = [...src.matchAll(/var\s+closing\s*=\s*([^;]*);/g)].map((m) => addendsOf(m[1]));
  if (all.length < 3) throw new Error(`fee-roster: expected three studio closing sums (calc/calcGold/calcSilver), found ${all.length}`);
  return all;
}

/* ── THE AUTHORED HALF ──────────────────────────────────────────────────────────────────────── */

/**
 * Every fee that lands in the closing sum, keyed by ITS OWN ADDEND NAME in that sum — so the
 * derivation above compares the two sets directly, with no translation table in between.
 *
 *   label       plain language, for the report a human reads
 *   quoteKey    where the amount lives on `quote.closingCosts` (null = several named lines)
 *   studio      the addend name in the studio's browser mirror
 *   fixture     which deal fixture is built to carry it (see FIXTURES)
 *   optional    true = only some deals carry it, so "absent" is a legitimate answer
 *   surfaces    the source token PROVING each surface names it
 */
const CLOSING_FEES = {
  origination: {
    label: 'Origination fee', quoteKey: 'origination', studio: 'origFee', fixture: 'general',
    surfaces: {
      pdf: /rowIn\(xR, colW, "Origination fee \("/,
      xlsxStd: /\["Origination \(" \+ origPctStr\(\(d\.origPct/,
      xlsxGold: /\["Origination \(" \+ origPctStr\(\(gd\.origPct/,
      xlsxSilver: /\["Origination \(" \+ origPctStr\(\(sd\.origPct/,
      studioPanel: /YS\.put\("rOrig"/,
      staffPanel: /k=\{`Origination \(/,
      borrowerEmail: /feeRow\(`Origination fee/,
      derivation: /\["Origination", origPctStr/,
    },
  },
  brokerFee: {
    label: 'TPO broker origination fee', quoteKey: 'brokerFee', studio: 'brokerFee', fixture: 'general',
    optional: true, tpoOnly: true,
    surfaces: {
      pdf: /d\.brokerFee > 0\) yR = rowIn\(xR, colW, "Broker origination fee/,
      xlsxStd: /rows\.splice\(i, 0, \["Broker origination fee/,
      xlsxGold: /rows\.splice\(i, 0, \["Broker origination fee/,
      xlsxSilver: /rows\.splice\(i, 0, \["Broker origination fee/,
      studioPanel: /YS\.put\("rBrokerLbl", "Broker origination fee/,
      staffPanel: /Broker origination fee\$\{cc\.brokerFeePct/,
      borrowerEmail: /feeRow\(`Broker origination fee/,
      derivation: /\["Broker origination fee", origPctStr\(d\.brokerFeePct/,
    },
  },
  lenderFee: {
    label: 'Our own fee — underwriting & processing plus legal', quoteKey: 'lenderFee',
    studio: 'lenderFee', fixture: 'general', parts: ['underwriting', 'legal'],
    surfaces: {
      pdf: /rowIn\(xR, colW, "Underwriting & processing", money2\(d\.uwFee\)[\s\S]{0,200}rowIn\(xR, colW, "Legal fee", money2\(d\.legalFee\)/,
      xlsxStd: /d\.feeSplit\) \? \["Underwriting & processing", money2\(d\.uwFee\)[\s\S]{0,200}d\.feeSplit\) \? \["Legal fee", money2\(d\.legalFee\)/,
      xlsxGold: /gd\.feeSplit\) \? \["Underwriting & processing", money2\(gd\.uwFee\)[\s\S]{0,200}gd\.feeSplit\) \? \["Legal fee", money2\(gd\.legalFee\)/,
      xlsxSilver: /sd\.feeSplit\) \? \["Underwriting & processing", money2\(sd\.uwFee\)[\s\S]{0,200}sd\.feeSplit\) \? \["Legal fee", money2\(sd\.legalFee\)/,
      studioPanel: /underwriting & processing " \+ YS\.fmtUSD2\(d\.uwFee\) \+ " \+ legal " \+ YS\.fmtUSD2\(d\.legalFee\)/,
      staffPanel: /cc\.lenderFeeParts\.underwritingLabel[\s\S]{0,300}cc\.lenderFeeParts\.legalLabel/,
      borrowerEmail: /lp\.underwritingLabel[\s\S]{0,200}lp\.legalLabel/,
      derivation: null,   // the derivation page records HOW a number was reached, not the fee roster
    },
  },
  creditFee: {
    label: 'Credit report', quoteKey: 'creditFee', studio: 'creditFee', fixture: 'general',
    surfaces: {
      pdf: /rowIn\(xR, colW, "Credit report \(avg\)", sized \? money2\(d\.creditFee\)/,
      xlsxStd: /\["Credit report", stdOk \? money2\(d\.creditFee\)/,
      xlsxGold: /\["Credit report", gOk \? money2\(gd\.creditFee\)/,
      xlsxSilver: /\["Credit report", sOk \? money2\(sd\.creditFee\)/,
      studioPanel: /YS\.put\("rCredit", sized \? YS\.fmtUSD2\(d\.creditFee\)/,
      staffPanel: /k="Credit report" v=\{money2\(cc\.creditFee\)\}/,
      borrowerEmail: /feeRow\('Credit report', cc\.creditFee\)/,
      derivation: null,
    },
  },
  titleTotal: {
    label: 'Title / escrow / settlement', quoteKey: 'titleAndSettlement', studio: 'titleCost', fixture: 'general',
    surfaces: {
      pdf: /rowIn\(xR, colW, "Title \/ escrow \/ settlement \(est\.\)"/,
      xlsxStd: /\["Title \/ escrow \(est\.\)", \(stdOk && d\.titleCost > 0\)/,
      xlsxGold: /\["Title \/ escrow \(est\.\)", \(gOk && gd\.titleCost > 0\)/,
      xlsxSilver: /\["Title \/ escrow \(est\.\)", \(sOk && sd\.titleCost > 0\)/,
      studioPanel: /YS\.put\("rTitle", \(sized && d\.titleCost > 0\)/,
      staffPanel: /k="Title \/ escrow \(est\.\)" v=\{money2\(cc\.titleAndSettlement\)\}/,
      borrowerEmail: /feeRow\('Title & settlement \(estimated\)', cc\.titleAndSettlement\)/,
      derivation: null,
    },
  },
  extraFeesTotal: {
    label: 'Company extra fees (admin-managed, per state)', quoteKey: 'extraFees', studio: 'extraFeesTotal',
    fixture: 'general', optional: true, adminOnly: true,
    surfaces: {
      pdf: /d\.extraFees\) d\.extraFees\.forEach\(function \(f\) \{ yR = rowIn\(xR, colW, f\.name/,
      xlsxStd: /d\.extraFees\.map\(function \(f\) \{ return \[f\.name, money2\(f\.amount\)\]/,
      xlsxGold: /gd\.extraFees\.map\(function \(f\) \{ return \[f\.name, money2\(f\.amount\)\]/,
      xlsxSilver: /sd\.extraFees\.map\(function \(f\) \{ return \[f\.name, money2\(f\.amount\)\]/,
      studioPanel: /YS\.put\("rExtraLbl"/,
      staffPanel: /cc\.extraFees\) && cc\.extraFees\.map/,
      borrowerEmail: /Array\.isArray\(cc\.extraFees\)[\s\S]{0,160}feeRow\(f\.name, f\.amount\)/,
      derivation: null,
    },
  },
  feasibilityFee: {
    label: 'Construction feasibility / project review fee', quoteKey: 'feasibilityFee',
    studio: 'feasFeeAmount', fixture: 'groundUp', optional: true,
    surfaces: {
      pdf: /d\.feasFee > 0\) yR = rowIn\(xR, colW, d\.feasLabel, money2\(d\.feasFee\)/,
      xlsxStd: /\(stdOk && d\.feasFee > 0\) \? \[d\.feasLabel, money2\(d\.feasFee\)\]/,
      xlsxGold: /\(gOk && gd\.feasFee > 0\) \? \[gd\.feasLabel, money2\(gd\.feasFee\)\]/,
      xlsxSilver: /\(sOk && sd\.feasFee > 0\) \? \[sd\.feasLabel, money2\(sd\.feasFee\)\]/,
      studioPanel: /YS\.put\("rFeas", YS\.fmtUSD2\(d\.feasFee\)\)/,
      staffPanel: /cc\.feasibility && Number\(cc\.feasibility\.amount\) > 0/,
      borrowerEmail: /cc\.feasibility && num\(cc\.feasibility\.amount\) > 0\) feeRow\(cc\.feasibility\.label/,
      derivation: null,
    },
  },
  settlementFee: {
    label: 'New York settlement agent fee (optional)', quoteKey: 'settlementFee',
    studio: 'settleFee', fixture: 'nycFlip', optional: true,
    surfaces: {
      pdf: /d\.settleFee > 0\) yR = rowIn\(xR, colW, d\.settleLabel, money2\(d\.settleFee\)/,
      xlsxStd: /\(stdOk && d\.settleFee > 0\) \? \[d\.settleLabel, money2\(d\.settleFee\)\]/,
      xlsxGold: /\(gOk && gd\.settleFee > 0\) \? \[gd\.settleLabel, money2\(gd\.settleFee\)\]/,
      xlsxSilver: /\(sOk && sd\.settleFee > 0\) \? \[sd\.settleLabel, money2\(sd\.settleFee\)\]/,
      studioPanel: /YS\.put\("rSettle", \(sized && d\.settleFee > 0\)/,
      staffPanel: /cc\.settlement && Number\(cc\.settlement\.amount\) > 0/,
      borrowerEmail: /cc\.settlement && num\(cc\.settlement\.amount\) > 0\) feeRow\(cc\.settlement\.label/,
      derivation: null,
    },
  },
  cemaFee: {
    label: 'New York CEMA fee', quoteKey: 'cemaFee', studio: 'cemaAmt', fixture: 'nyCema', optional: true,
    surfaces: {
      pdf: /d\.cemaFee > 0\) yR = rowIn\(xR, colW, d\.cemaLabel, money2\(d\.cemaFee\)/,
      xlsxStd: /\(stdOk && d\.cemaFee > 0\) \? \[d\.cemaLabel, money2\(d\.cemaFee\)\]/,
      xlsxGold: /\(gOk && gd\.cemaFee > 0\) \? \[gd\.cemaLabel, money2\(gd\.cemaFee\)\]/,
      xlsxSilver: /\(sOk && sd\.cemaFee > 0\) \? \[sd\.cemaLabel, money2\(sd\.cemaFee\)\]/,
      studioPanel: /YS\.put\("rCema", \(sized && d\.cemaFee > 0\)/,
      staffPanel: /cc\.cema && Number\(cc\.cema\.amount\) > 0/,
      borrowerEmail: /cc\.cema && num\(cc\.cema\.amount\) > 0\) feeRow\(cc\.cema\.label/,
      derivation: null,
    },
  },
  govChargesTotal: {
    label: 'Government charges (mortgage / transfer / mansion tax, recording)',
    quoteKey: 'governmentCharges', studio: 'gov.borrowerTotal', fixture: 'nycFlip', optional: true,
    surfaces: {
      pdf: /d\.gov\.borrowerLines\.forEach\(function \(L\) \{[\s\S]{0,160}rowIn\(xR, colW, L\.label/,
      xlsxStd: /\.\.\.govXlsxRows\(stdOk \? d : null\)/,
      xlsxGold: /\.\.\.govXlsxRows\(gOk \? gd : null\)/,
      xlsxSilver: /\.\.\.govXlsxRows\(sOk \? sd : null\)/,
      studioPanel: /el\("rGovWrap"\)/,
      staffPanel: /cc\.governmentChargeLines\) && cc\.governmentChargeLines\.map/,
      borrowerEmail: /Array\.isArray\(cc\.governmentChargeLines\)[\s\S]{0,160}feeRow\(g\.label, g\.amount\)/,
      derivation: /section\("Government charges \(estimated\)", rows\)/,
    },
  },
};

/**
 * FEES THAT ARE DELIBERATELY NOT IN THE CLOSING SUM. Each is here so the audit can state WHY —
 * "we checked, and it is out on purpose" is a different answer from "nobody looked", and the first
 * is the only one worth trusting. Every one of these placements was an owner decision.
 */
const OUTSIDE_CLOSING = {
  appraisalFee: {
    label: 'Appraisal', placement: 'poc', quoteKey: 'appraisalPoc',
    why: 'Paid outside closing — the card on file is charged when the appraisal is ordered, so '
      + 'folding it into what is due at the table would overstate what the borrower brings.',
    surfaces: {
      pdf: /rowIn\(xR, colW, "Appraisal \(est\., POC\)"/,
      xlsxStd: /\["Appraisal \(est\., POC\)", stdOk \? money2\(d\.apprFee\)/,
      studioPanel: /YS\.put\("rAppr", sized \? \(YS\.fmtUSD2\(d\.apprFee\)/,
      staffPanel: /Appraisal \(est\., paid outside closing\)/,
      borrowerEmail: /Appraisal \(paid when ordered, not at closing\)/,
    },
  },
  deferredOrigination: {
    label: 'Deferred origination fee (exit fee)', placement: 'exit', quoteKey: null,
    why: 'Paid at payoff, not at the table — an exit fee. Never part of cash to close or of the '
      + 'liquidity the borrower must show.',
    surfaces: {
      pdf: /rowFull\("Deferred origination fee \\u2014 paid at payoff \(exit fee\)"/,
      staffPanel: null,
      borrowerEmail: /Deferred origination fee \(\$\{Number\(to\.deferredOrigPct\)\}% \u2014 paid at payoff, not at closing\)/,
    },
  },
  drawFee: {
    label: 'Construction draw / inspection fee', placement: 'event', quoteKey: null,
    why: 'Charged per draw, as the construction is inspected — an event fee that a bridge deal '
      + 'never incurs at all, so quoting it at the table would overstate cash to close.',
    surfaces: {
      pdf: /rowFull\("Construction draw fee", _dfLines\.join\(" · "\)\)/,
      xlsxStd: /\["Draw fee", drawFeeLines\("standard"\)\.join\("; "\)\]/,
      derivation: /\["Construction draw fee", drawFeeLines\(_dpProg\)\.join\("; "\)\]/,
    },
  },
  closingRescheduleFee: {
    label: 'Closing reschedule fee', placement: 'event', quoteKey: null,
    why: 'Charged only if a set closing is actually postponed. Quoting it in cash to close would '
      + 'charge every borrower $500 for a reschedule that has not happened.',
    surfaces: {
      pdf: /rowFull\("Closing reschedule fee", CLOSING_RESCHEDULE_ROW\)/,
    },
  },
};

/* ── THE SURFACES ───────────────────────────────────────────────────────────────────────────── */

/** Every place a fee can populate, and how to cut that place out of its file.
 *  `cashToClose` and `liquidity` are NOT here — they are TOTALS, proven by arithmetic against a
 *  real priced quote rather than by a source token. */
const SURFACES = {
  pdf: { what: 'the term sheet PDF',
    src: () => region(read('studio'), /async function exportPdf\(/, /\n  function pctp\(/, 'exportPdf') },
  xlsxStd: { what: 'the spreadsheet — Standard column',
    src: () => region(read('studio'), /\n    var std = \[/, /\n    var gold;/, 'the xlsx Standard column')
      + region(read('studio'), /\n    if \(stdOk && d\.extraFees/, /\n    var silver;/, 'the xlsx extra-fee splices')
      + region(read('studio'), /brokerFee is 0 on every retail sheet/, /\n  function /, 'the xlsx broker-fee splice') },
  xlsxGold: { what: 'the spreadsheet — Gold column',
    src: () => region(read('studio'), /\n    var gold;/, /\n    var silver;/, 'the xlsx Gold column')
      + region(read('studio'), /brokerFee is 0 on every retail sheet/, /\n  function /, 'the xlsx broker-fee splice') },
  xlsxSilver: { what: 'the spreadsheet — Silver column',
    src: () => region(read('studio'), /\n    var silver;/, /\n  function /, 'the xlsx Silver column') },
  studioPanel: { what: 'the Term Sheet Studio structure screen',
    src: () => region(read('studio'), /\n  function recompute\(\) \{/, /\n  function validateAssign\(/, 'the studio panel') },
  staffPanel: { what: 'the staff Products & Pricing panel',
    src: () => stripComments(read('staffPanel')) },
  borrowerEmail: { what: "the borrower's \u201cyour terms are ready\u201d email",
    src: () => stripComments(read('borrowerEmail')) },
  derivation: { what: 'the term sheet\u2019s Inputs & Loan Derivation page',
    src: () => region(read('studio'), /\n  function drawDerivationPage\(/, /\n  \/\* ===================== wiring/, 'the derivation page') },
};

/* ── THE DEAL FIXTURES ──────────────────────────────────────────────────────────────────────── */

/** A priced deal shaped to CARRY a given fee, in the shape `pricing.buildInputs` takes.
 *  Every fixture is a real, eligible deal — a fee proven on a deal that does not price proves
 *  nothing, which is why each one is asserted to size before it is asserted to charge. */
const FIXTURES = {
  general: {
    what: 'an ordinary New Jersey fix & flip',
    app: {
      purchase_price: 400000, as_is_value: 400000, arv: 700000, rehab_budget: 60000,
      fico: 740, term: 12, program: 'Fix & Flip', rehab_type: 'Light rehab', loan_type: 'Purchase',
      property_type: 'Single Family', units: 1, property_address: { state: 'NJ', city: 'Newark' },
    },
  },
  groundUp: {
    what: 'a New Jersey ground-up construction loan',
    app: {
      purchase_price: 400000, as_is_value: 400000, arv: 1400000, rehab_budget: 600000,
      fico: 750, term: 18, program: 'Ground-up Construction', rehab_type: 'Ground-up construction',
      loan_type: 'Purchase', property_type: 'Single Family', units: 1,
      property_address: { state: 'NJ', city: 'Newark' },
    },
  },
  nycFlip: {
    what: 'a Brooklyn fix & flip',
    app: {
      purchase_price: 900000, as_is_value: 900000, arv: 1600000, rehab_budget: 150000,
      fico: 750, term: 12, program: 'Fix & Flip', rehab_type: 'Light rehab', loan_type: 'Purchase',
      property_type: 'Single Family', units: 3,
      property_address: { state: 'NY', city: 'Brooklyn', county: 'Kings' },
    },
  },
  nyCema: {
    what: 'a Brooklyn rate-and-term refinance marked as a CEMA',
    app: {
      as_is_value: 1200000, arv: 1200000, rehab_budget: 0, payoff_amount: 900000,
      fico: 750, term: 12, program: 'Bridge / Stabilized', rehab_type: '', loan_type: 'Refinance — Rate & Term',
      property_type: 'Single Family', units: 2, ny_cema: true,
      property_address: { state: 'NY', city: 'Brooklyn', county: 'Kings' },
    },
  },
};

const EXPERIENCE = { flips: 5, holds: 2, ground: 3 };

module.exports = {
  REPO, P, read, stripComments, region,
  serverClosingAddends, studioClosingAddends,
  CLOSING_FEES, OUTSIDE_CLOSING, SURFACES, FIXTURES, EXPERIENCE,
};
