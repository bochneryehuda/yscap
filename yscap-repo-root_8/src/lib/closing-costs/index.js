'use strict';
/* =====================================================================
   closing-costs — the government charges on an RTL closing, as line items.

   Owner-directed 2026-08-23: *"New York City mortgage tax needs to be a line
   item calculated separately. New York State mortgage tax is a little cheaper.
   Pennsylvania, Pittsburgh, and Philadelphia … have a transfer tax … Florida has
   some mortgage tax. There are a lot of other states that have this kind of stuff
   that the buyer needs to pay, either transfer tax or mortgage tax, which should
   all be implemented into our automatic calculator that is calculating the title
   fees. All those line items should also be able to be added to the manual
   section to be overwritten and should automatically fill based on: the unit
   count, the loan type, the county, the state."*

   ── WHY LINE ITEMS AND NOT ONE NUMBER ──────────────────────────────────────

   Because the owner asked for them by name, and because a single blended figure
   cannot be checked, cannot be overridden, and cannot be reconciled against a
   settlement statement — which is the only document that ever proves an estimate
   right or wrong. Every charge comes back as
   `{ key, label, amount, payer, basis, rate, authority, confidence }`, so the
   quote, the term sheet, the cash-to-close and the manual override screen all
   read the same objects and cannot drift from each other.

   ── THE THREE FACTS THAT DECIDE EVERYTHING ─────────────────────────────────

   1. A MORTGAGE TAX IS ON THE LOAN. A TRANSFER TAX IS ON THE SALE. So a
      refinance owes the first and none of the second — and a purchase owes both.
      Collapsing them into "closing taxes" gets every refinance wrong.
   2. WHO PAYS IS PART OF THE RATE. New York's 0.25% special additional tax is
      the LENDER's on a 1-6 family residence; Pennsylvania's is customarily split
      50/50; Florida's deed stamps are the seller's while the note stamps and the
      intangible tax are the buyer's. Attributing all of it to the borrower
      overstates cash to close; attributing none of it to us understates our cost.
   3. THE UNIT COUNT AND THE COUNTY MOVE THE RATE, not just the state. NYC taxes
      a 4-family at 2.80% and a 3-family at 2.175% on the same loan; Cortland
      County charges 1.25% where Chenango charges 1.00%. A per-state number
      cannot express either, which is why the inputs are what the owner listed.

   ── NOT FALLING SHORT ──────────────────────────────────────────────────────

   The owner's actual worry. Three deliberate choices, in the tables and here:
     · An unknown county resolves to the state's HIGH rate, never its low one and
       never zero, and the result says so in `warnings`.
     · Every tax rounds UP to its statutory increment ("or fraction thereof").
     · Anything we are unsure of is reported with `confidence`, so the quote can
       show "verify with the settlement agent" against the specific line rather
       than as boilerplate nobody reads.

   NOTHING HERE IS A QUOTE. `disclaimer` rides on every result.
   ===================================================================== */

const { MORTGAGE_TAX, TRANSFER_TAX, RECORDING, TAXABLE_UNIT } = require('./rate-tables');

const DISCLAIMER = 'Estimated government charges for planning cash to close. The settlement agent issues the binding figures at closing.';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const up2 = (v) => Math.ceil(num(v) * 100) / 100;         // round UP to the cent
/* ROUND UP TO THE DOLLAR — but settle the float FIRST.
   `0.028 - 0.0025` is `0.025500000000000002` in IEEE-754, and 600,000 of those is
   `15300.000000000002`. A bare `Math.ceil` turns that into $15,301: a phantom
   dollar that appears only for certain rate combinations, which is exactly the kind
   of unexplainable cent that makes a person stop trusting a number they cannot
   reconcile against a settlement statement. Rounding to the cent removes the noise
   BELOW a cent, and only then does the deliberate round-UP apply. */
const ceilDollar = (v) => Math.ceil(Math.round(num(v) * 100) / 100);
/** Round an amount UP to the next whole taxable increment ("or fraction thereof"). */
function taxableAmount(amount, unit) {
  const u = num(unit) > 0 ? num(unit) : 1;
  return Math.ceil(num(amount) / u) * u;
}
function normState(s) { return String(s || '').trim().toUpperCase().slice(0, 2); }
/** County labels arrive as "Kings", "KINGS COUNTY", "kings co." — normalize once. */
function normCounty(c) {
  return String(c || '').trim().toUpperCase()
    .replace(/\bCOUNTY\b/g, '').replace(/\bCO\.?\b/g, '').replace(/[^A-Z' -]/g, '').replace(/\s+/g, ' ').trim();
}
function normCity(c) { return String(c || '').trim().toUpperCase().replace(/\s+/g, ' '); }

/* The five boroughs, however they are written on a file. A property in Brooklyn
   is in Kings County and is taxed as New York City — a lookup that only knew
   "NEW YORK" would tax a Brooklyn loan at the upstate rate and understate the
   borrower's cash by more than 1% of the loan. */
const NYC_COUNTIES = new Set(['NEW YORK', 'KINGS', 'QUEENS', 'BRONX', 'RICHMOND',
  'MANHATTAN', 'BROOKLYN', 'STATEN ISLAND']);
const NYC_COUNTY_ALIAS = { MANHATTAN: 'NEW YORK', BROOKLYN: 'KINGS', 'STATEN ISLAND': 'RICHMOND' };
function isNycCity(city) {
  const c = normCity(city);
  return c === 'NEW YORK' || c === 'NEW YORK CITY' || c === 'NYC' || c === 'BROOKLYN'
    || c === 'BRONX' || c === 'QUEENS' || c === 'STATEN ISLAND' || c === 'MANHATTAN';
}

function line(o) {
  return {
    key: o.key, label: o.label, amount: up2(o.amount),
    payer: o.payer || 'borrower',
    basis: o.basis || null, rate: o.rate == null ? null : o.rate,
    authority: o.authority || null, confidence: o.confidence || 'secondary',
    note: o.note || null, auto: true,
  };
}

/* ── MORTGAGE / RECORDATION / INTANGIBLE TAX ─────────────────────────────── */
function mortgageTaxLines(inp, out) {
  const st = inp.state;
  const cfg = MORTGAGE_TAX[st];
  const loan = num(inp.loanAmount);
  if (!cfg || loan <= 0) {
    if (!cfg && loan > 0) {
      out.notes.push(`${st || 'This state'} levies no mortgage recording or intangible tax on the loan.`);
    }
    return;
  }
  const unit = TAXABLE_UNIT[st] || TAXABLE_UNIT.DEFAULT;

  if (st === 'NY') return nyMortgageTax(inp, out, cfg, loan);

  if (st === 'FL') {
    // TWO taxes, and quoting only one understates by more than a third.
    const stampBase = taxableAmount(loan, 100);
    out.lines.push(line({
      key: 'mortgage_tax', label: 'Florida documentary stamp tax on the note',
      amount: (stampBase / 100) * cfg.docStampPer100,
      payer: 'borrower', basis: `$${stampBase.toLocaleString('en-US')} (note, rounded up to the next $100)`,
      rate: cfg.docStampPer100 / 100, authority: cfg.authority, confidence: cfg.confidence,
    }));
    out.lines.push(line({
      key: 'intangible_tax', label: 'Florida non-recurring intangible tax on the mortgage',
      amount: loan * cfg.intangibleRate,
      payer: 'borrower', basis: `$${Math.round(loan).toLocaleString('en-US')} (mortgage amount)`,
      rate: cfg.intangibleRate, authority: cfg.authority, confidence: cfg.confidence,
    }));
    return;
  }

  if (st === 'MD') {
    const county = normCounty(inp.county);
    const entry = cfg.byCounty[county] || cfg.byCounty[county.replace(/ /g, '_')];
    const per500 = entry ? entry.per500 : cfg.defaultPer500;
    if (!entry) out.warnings.push(`Maryland county "${inp.county || 'not set'}" is not in our table — using the highest county recordation rate we know of ($${cfg.defaultPer500.toFixed(2)} per $500) so the estimate does not fall short. Confirm the county rate.`);
    // On a purchase the recordation tax is on the CONSIDERATION; on a refinance
    // it is on the debt. Using the loan on a purchase would understate whenever
    // the price exceeds the loan, which on an RTL purchase it always does.
    const base = inp.isPurchase && num(inp.purchasePrice) > 0 ? num(inp.purchasePrice) : loan;
    const taxable = taxableAmount(base, 500);
    out.lines.push(line({
      key: 'mortgage_tax', label: 'Maryland county recordation tax',
      amount: (taxable / 500) * per500,
      payer: 'borrower', basis: `$${taxable.toLocaleString('en-US')} (${inp.isPurchase ? 'purchase price' : 'loan amount'}, rounded up to the next $500)`,
      rate: per500 / 500, authority: (entry && entry.authority) || cfg.authority,
      confidence: entry ? cfg.confidence : 'default',
    }));
    return;
  }

  // The flat-rate states.
  let taxable = taxableAmount(loan, unit);
  if (cfg.exemptFirst) taxable = Math.max(0, taxable - cfg.exemptFirst);
  let amount = taxable * cfg.rate;
  if (cfg.cap != null && amount > cfg.cap) {
    amount = cfg.cap;
    out.notes.push(`${st} caps this tax at $${cfg.cap.toLocaleString('en-US')}.`);
  }
  if (cfg.flatAdd) amount += cfg.flatAdd;
  out.lines.push(line({
    key: 'mortgage_tax',
    label: `${st} ${cfg.kind === 'intangible_recording_tax' ? 'intangible recording tax' : cfg.kind === 'mortgage_registry_tax' ? 'mortgage registry tax' : 'recordation / mortgage tax'}`,
    amount, payer: 'borrower',
    basis: `$${taxable.toLocaleString('en-US')} (loan amount${cfg.exemptFirst ? `, first $${cfg.exemptFirst.toLocaleString('en-US')} exempt` : ''})`,
    rate: cfg.rate, authority: cfg.authority, confidence: cfg.confidence,
  }));
}

/* NEW YORK, on its own, because it is the only one where the rate depends on the
   county AND the loan size AND the unit count AND who pays which slice. */
function nyMortgageTax(inp, out, cfg, loan) {
  const county = normCounty(inp.county);
  const canonical = NYC_COUNTY_ALIAS[county] || county;
  const inNyc = NYC_COUNTIES.has(county) || isNycCity(inp.city);
  const units = Math.max(1, Math.round(num(inp.units) || 1));

  let total; let label; let confidence; let authority = cfg.authority;

  if (inNyc) {
    const tier = cfg.nycTiers.find((t) => units <= t.maxUnits
      && (t.atLeast != null ? loan >= t.atLeast : loan < t.under));
    total = tier.total; label = tier.label; confidence = 'secondary';
  } else {
    const entry = cfg.byCounty[canonical];
    if (entry && entry.total != null) {
      total = entry.total; confidence = entry.confidence || 'secondary';
      if (entry.authority) authority = entry.authority;
      label = `New York State mortgage recording tax — ${canonical.charAt(0) + canonical.slice(1).toLowerCase()} County`;
    } else {
      total = cfg.defaultTotal; confidence = 'default';
      label = 'New York State mortgage recording tax';
      out.warnings.push(`New York county "${inp.county || 'not set'}" is not in our rate table — using ${(cfg.defaultTotal * 100).toFixed(2)}%, the highest non-NYC county rate we know of, so the estimate does not fall short. Confirm the county rate with the title company.`);
    }
  }

  /* THE SPECIAL ADDITIONAL 0.25% IS THE LENDER'S on a residence of six units or
     fewer (Tax Law § 253(1-a)(a)). Splitting it out is not bookkeeping: leaving
     it in overstates the borrower's cash to close by 0.25% of the loan — $1,500
     on a $600,000 loan — and leaving it out of OUR costs understates what the
     company pays on every New York residential closing it funds. */
  const lenderPays = cfg.lenderPaysSpecialAdditional && units <= cfg.lenderPaysUpToUnits;
  const borrowerRate = lenderPays ? Math.max(0, total - cfg.specialAdditionalRate) : total;

  let borrowerAmount = loan * borrowerRate;
  // The 1-2 family MCTD credit: the first $10,000 of principal is exempt from
  // the 0.30% additional tax. A real $30 line on a real closing statement.
  let creditNote = null;
  if (units <= 2 && (inNyc || cfg.byCounty[canonical]) && cfg.oneTwoFamilyCredit) {
    borrowerAmount = Math.max(0, borrowerAmount - cfg.oneTwoFamilyCredit);
    creditNote = `Includes the $${cfg.oneTwoFamilyCredit} one-or-two-family exemption (the first $10,000 of principal is exempt from the additional tax).`;
  }

  out.lines.push(line({
    key: 'mortgage_tax', label, amount: ceilDollar(borrowerAmount),
    payer: 'borrower',
    basis: `$${Math.round(loan).toLocaleString('en-US')} (mortgage amount), ${units} unit${units === 1 ? '' : 's'}`,
    rate: borrowerRate, authority, confidence, note: creditNote,
  }));

  if (lenderPays) {
    out.lines.push(line({
      key: 'mortgage_tax_lender', label: 'New York special additional mortgage tax (paid by the lender)',
      amount: ceilDollar(loan * cfg.specialAdditionalRate),
      payer: 'lender',
      basis: `$${Math.round(loan).toLocaleString('en-US')} (mortgage amount)`,
      rate: cfg.specialAdditionalRate,
      authority: 'NY Tax Law § 253(1-a)(a) — the 0.25% special additional tax is the mortgagee’s on a residence of six units or fewer',
      confidence: 'verified',
      note: 'Not part of the borrower’s cash to close — this is the company’s own cost on this loan.',
    }));
  }
}

/* ── TRANSFER / DEED TAX — purchases only ────────────────────────────────── */
function transferTaxLines(inp, out) {
  const st = inp.state;
  const cfg = TRANSFER_TAX[st];
  const price = num(inp.purchasePrice);

  if (!inp.isPurchase) {
    out.notes.push('No transfer tax on a refinance — there is no deed being recorded.');
    return;
  }
  if (!cfg || price <= 0) {
    if (!cfg && price > 0) out.notes.push(`${st || 'This state'} is not in our transfer-tax table — confirm with the title company.`);
    return;
  }
  if (cfg.none) { out.notes.push(cfg.authority); return; }

  // The contract governs, not custom; `buyerTransferShare` overrides the default.
  const share = inp.buyerTransferShare != null ? Math.min(1, Math.max(0, num(inp.buyerTransferShare)))
    : num(cfg.buyerShare);

  // --- the state's own rate -------------------------------------------------
  let stateRate = num(cfg.stateRate);
  const countyEntry = cfg.byCounty && cfg.byCounty[normCounty(inp.county)];
  if (countyEntry && countyEntry.stateRate != null) stateRate = countyEntry.stateRate;
  if (cfg.stateHighOver && price >= cfg.stateHighOver && cfg.stateHighRate) stateRate = cfg.stateHighRate;

  if (stateRate > 0 && share > 0) {
    out.lines.push(line({
      key: 'transfer_tax_state', label: `${st} state transfer tax — buyer’s share`,
      amount: price * stateRate * share, payer: 'borrower',
      basis: `$${Math.round(price).toLocaleString('en-US')} × ${(stateRate * 100).toFixed(3)}% × ${(share * 100).toFixed(0)}% buyer share`,
      rate: stateRate * share, authority: cfg.authority, confidence: cfg.confidence,
      note: share < 1 ? 'Split per local custom — the purchase contract governs. Override this if the contract says otherwise.' : null,
    }));
  } else if (stateRate > 0) {
    out.notes.push(`${st} transfer tax is customarily the seller’s — nothing in the buyer’s cash to close. Confirm against the contract.`);
  }

  // --- the local (city / school district) rate ------------------------------
  const cityEntry = (cfg.byCity && (cfg.byCity[normCity(inp.city)]
    || (st === 'NY' && isNycCity(inp.city) ? cfg.byCity['NEW YORK CITY'] : null))) || null;
  if (st === 'PA') {
    const localRate = cityEntry ? cityEntry.localRate : cfg.defaultLocalRate;
    if (!cityEntry) out.warnings.push(`Pennsylvania municipality "${inp.city || 'not set'}" is not in our table — using the typical 1% local rate. Philadelphia (3.578%) and Pittsburgh (4%) are far higher; confirm the municipality.`);
    if (localRate > 0 && share > 0) {
      out.lines.push(line({
        key: 'transfer_tax_local',
        label: `${cityEntry ? normCity(inp.city) : 'Local'} realty transfer tax — buyer’s share`,
        amount: price * localRate * share, payer: 'borrower',
        basis: `$${Math.round(price).toLocaleString('en-US')} × ${(localRate * 100).toFixed(3)}% × ${(share * 100).toFixed(0)}% buyer share`,
        rate: localRate * share,
        authority: (cityEntry && cityEntry.authority) || cfg.authority,
        confidence: cityEntry ? (cityEntry.confidence || cfg.confidence) : 'default',
      }));
    }
  } else if (cityEntry && Array.isArray(cityEntry.tiers)) {
    // NYC RPTT — residential vs commercial, by price.
    const residential = Math.max(1, Math.round(num(inp.units) || 1)) <= 3;
    const tier = cityEntry.tiers.find((t) => t.residential === residential
      && (t.atLeast != null ? price >= t.atLeast : price < t.under));
    if (tier && share > 0) {
      out.lines.push(line({
        key: 'transfer_tax_local', label: 'NYC Real Property Transfer Tax — buyer’s share',
        amount: price * tier.rate * share, payer: 'borrower',
        basis: `$${Math.round(price).toLocaleString('en-US')} × ${(tier.rate * 100).toFixed(3)}% × ${(share * 100).toFixed(0)}% buyer share`,
        rate: tier.rate * share, authority: cityEntry.authority, confidence: cityEntry.confidence,
      }));
    } else if (tier) {
      out.notes.push('The NYC Real Property Transfer Tax is customarily the seller’s — nothing in the buyer’s cash to close. Confirm against the contract.');
    }
  }

  // --- taxes that are the BUYER's by statute, whatever the custom ----------
  if (cfg.mansion && price >= (cfg.mansion.bands[0] || {}).atLeast) {
    // The band is chosen by the PRICE, and the rate applies to the whole price —
    // not marginally. Treating it as marginal understates it badly at every tier.
    const band = cfg.mansion.bands.filter((b) => price >= b.atLeast).pop();
    out.lines.push(line({
      key: 'mansion_tax', label: 'Mansion tax (buyer)',
      amount: price * band.rate, payer: 'borrower',
      basis: `$${Math.round(price).toLocaleString('en-US')} × ${(band.rate * 100).toFixed(2)}%`,
      rate: band.rate, authority: cfg.mansion.authority, confidence: cfg.mansion.confidence,
      note: 'The mansion tax is the buyer’s by statute, whatever the contract says about the transfer tax.',
    }));
  }
  if (cfg.buyerMansion && price > cfg.buyerMansion.over) {
    out.lines.push(line({
      key: 'mansion_tax', label: 'Mansion fee (buyer)',
      amount: price * cfg.buyerMansion.rate, payer: 'borrower',
      basis: `$${Math.round(price).toLocaleString('en-US')} × ${(cfg.buyerMansion.rate * 100).toFixed(2)}%`,
      rate: cfg.buyerMansion.rate, authority: cfg.authority, confidence: cfg.confidence,
    }));
  }
}

/* ── RECORDING FEES ──────────────────────────────────────────────────────── */
function recordingLines(inp, out) {
  const r = RECORDING[inp.state] || RECORDING.DEFAULT;
  const known = !!RECORDING[inp.state];
  if (inp.isPurchase) {
    out.lines.push(line({
      key: 'recording_deed', label: 'Deed recording fee',
      amount: r.deed, payer: 'borrower', basis: 'typical for a standard deed',
      authority: 'County clerk fee schedule (page-count driven)', confidence: known ? r.confidence : 'default',
    }));
  }
  out.lines.push(line({
    key: 'recording_mortgage', label: 'Mortgage recording fee',
    amount: r.mortgage, payer: 'borrower', basis: 'typical for a standard mortgage',
    authority: 'County clerk fee schedule (page-count driven)', confidence: known ? r.confidence : 'default',
  }));
}

/**
 * Every government charge on this closing, as line items.
 *
 * Inputs — exactly what the owner listed, plus the two amounts they are levied on:
 *   state, county, city      the jurisdiction (county and city genuinely move the rate)
 *   units                    dwelling units (NYC taxes a 4-family differently from a 3)
 *   loanAmount               the recorded mortgage amount
 *   purchasePrice            the deed consideration (a purchase only)
 *   transactionType          'purchase' | 'refinance' — decides whether transfer tax applies at all
 *   buyerTransferShare       0..1 override for the split the contract actually sets
 */
function governmentCharges(input = {}) {
  const inp = {
    state: normState(input.state),
    county: input.county || null,
    city: input.city || null,
    units: input.units,
    loanAmount: num(input.loanAmount),
    purchasePrice: num(input.purchasePrice),
    isPurchase: !/refi/i.test(String(input.transactionType || 'purchase')),
    buyerTransferShare: input.buyerTransferShare,
  };
  const out = { lines: [], warnings: [], notes: [] };

  if (!inp.state) {
    out.warnings.push('No property state on this file — government charges cannot be estimated. Set the property address first.');
    return finish(inp, out);
  }
  mortgageTaxLines(inp, out);
  transferTaxLines(inp, out);
  recordingLines(inp, out);
  return finish(inp, out);
}

function finish(inp, out) {
  const borrower = out.lines.filter((l) => l.payer === 'borrower');
  const lender = out.lines.filter((l) => l.payer === 'lender');
  const sum = (a) => up2(a.reduce((n, l) => n + l.amount, 0));
  // The weakest link decides how confident the whole estimate is: a total built
  // from one defaulted county rate is a defaulted total, and saying otherwise is
  // how an estimate gets trusted further than it has earned.
  const rank = { default: 0, secondary: 1, verified: 2 };
  const worst = out.lines.length
    ? out.lines.reduce((w, l) => (rank[l.confidence] < rank[w] ? l.confidence : w), 'verified')
    : 'default';
  return {
    lines: out.lines,
    borrowerLines: borrower,
    borrowerTotal: sum(borrower),
    lenderTotal: sum(lender),
    warnings: out.warnings,
    notes: out.notes,
    confidence: worst,
    jurisdiction: { state: inp.state, county: inp.county, city: inp.city, units: inp.units },
    disclaimer: DISCLAIMER,
  };
}

/** The keys this engine can produce — the closed list the override screen renders. */
const CHARGE_KEYS = Object.freeze([
  'mortgage_tax', 'intangible_tax', 'transfer_tax_state', 'transfer_tax_local',
  'mansion_tax', 'recording_deed', 'recording_mortgage',
]);

/** Plain-language labels for the override screen, so a blank line still reads. */
const CHARGE_LABELS = Object.freeze({
  mortgage_tax: 'Mortgage / recordation tax',
  intangible_tax: 'Intangible tax (FL)',
  transfer_tax_state: 'State transfer tax — buyer’s share',
  transfer_tax_local: 'City / local transfer tax — buyer’s share',
  mansion_tax: 'Mansion tax (buyer)',
  recording_deed: 'Deed recording fee',
  recording_mortgage: 'Mortgage recording fee',
});

/**
 * Apply per-file manual overrides to a computed set.
 *
 * Owner-directed: *"All those line items should also be able to be added to the
 * manual section to be overwritten and should automatically fill based on the
 * unit count, the loan type, the county, the state."*  So: the engine fills
 * automatically, a human may type over any single line, and the result records
 * WHICH lines were typed — an override that cannot be seen is indistinguishable
 * from a bad rate table, and the two need completely different fixes.
 *
 * A typed 0 is a real decision (this closing does not owe it) and is honoured;
 * a blank or absent key leaves the automatic figure alone.
 */
function applyOverrides(result, overrides) {
  const o = (overrides && typeof overrides === 'object') ? overrides : {};
  const byKey = new Map(result.lines.map((l) => [l.key, l]));
  const applied = [];
  for (const key of CHARGE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
    const raw = o[key];
    if (raw == null || raw === '') continue;                  // blank = use the automatic figure
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) continue;
    const existing = byKey.get(key);
    if (existing) {
      applied.push({ key, from: existing.amount, to: up2(v) });
      existing.amount = up2(v); existing.auto = false;
      existing.note = 'Typed by hand on this file — overrides the automatic figure.';
      existing.confidence = 'verified';                       // a human read the actual invoice
    } else {
      // A charge the table does not produce for this state but the settlement
      // agent says is owed. It has to be addable, or the manual section cannot
      // fix a table that is merely INCOMPLETE — only one that is wrong.
      const added = line({
        key, label: CHARGE_LABELS[key] || key, amount: v, payer: 'borrower',
        basis: 'entered by hand on this file', authority: null, confidence: 'verified',
        note: 'Added by hand on this file — our table does not compute this charge for this jurisdiction.',
      });
      added.auto = false;
      result.lines.push(added); byKey.set(key, added);
      applied.push({ key, from: 0, to: up2(v) });
    }
  }
  if (!applied.length) return result;
  const borrower = result.lines.filter((l) => l.payer === 'borrower');
  const lender = result.lines.filter((l) => l.payer === 'lender');
  const sum = (a) => up2(a.reduce((n, l) => n + l.amount, 0));
  return {
    ...result,
    borrowerLines: borrower,
    borrowerTotal: sum(borrower),
    lenderTotal: sum(lender),
    overridden: applied,
  };
}

module.exports = {
  governmentCharges, applyOverrides,
  CHARGE_KEYS, CHARGE_LABELS, DISCLAIMER,
  // exported for the unit test and for anything that needs the same normalization
  normState, normCounty, normCity, taxableAmount, isNycCity, NYC_COUNTIES,
};
