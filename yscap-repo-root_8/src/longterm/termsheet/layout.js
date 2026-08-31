'use strict';
/**
 * LONG-TERM TERM SHEETS — THE LAYOUT, AS DATA.
 *
 * This module decides WHAT is on the page and in what order; `pdf.js` decides
 * how it is drawn. The split is deliberate and it is what makes the document
 * testable: a block list can be asserted in CI (does a comparison name its
 * anchor? does a term sheet carry its acceptance block? does a sheet with no
 * insurance figure ever print a total monthly payment?) without rendering a
 * single pixel, and the page can be changed without touching the primitives.
 *
 * ⛔ THREE DOCUMENTS, NOT ONE WITH SETTINGS. Owner-directed 2026-08-30:
 *   *"A term sheet should only have one option. It should be a comparison
 *   sheet, which should be the same scenario, different options. There should
 *   be a scenario sheet, which is different scenarios and different options
 *   broken down."*
 * They are not three skins on one page. A TERM SHEET is an offer: it states one
 * program in full, it expires, and it has somewhere to sign. A COMPARISON is a
 * working document: it puts options beside each other and must NOT be signable,
 * because a signature under three columns says nothing about which one was
 * accepted. A SCENARIO COMPARISON additionally has to say what CHANGED between
 * the scenarios, or the reader is comparing two numbers with no idea why they
 * differ. `documentKind()` in `snapshot.js` decides which of the three this is,
 * from the members, so a document can never disagree with its own table.
 *
 * ⛔ NO PAGE MAY DRAW PAST ITS OWN MARGIN, so the renderer FLOWS these blocks
 * and breaks a page when the next one will not fit. `{t:'pagebreak'}` is a HARD
 * break we ask for; a soft break is the renderer's own and can happen anywhere.
 * The RTL side learned this the expensive way — a page that grew silently drew
 * its rows through the footnote and off the sheet, and the missing rows were on
 * a document that had already gone out.
 *
 * ⛔ EVERY RULE IN `docs/longterm/BORROWER-PRICING-LANGUAGE.md` APPLIES HERE. A
 * term sheet is not a more technical document because it is a document: no
 * price, no par, no points without their dollars, no compensation, no investor,
 * no vendor.
 *
 * PURE: no database, no network, no PDF library.
 */

const wording = require('./wording');
const brand = require('./brand');
// `snapshot.js` decides which of the three documents this is; it requires
// nothing from here, so this is not a cycle.
const { DOC_KINDS, KIND_WORDS } = require('./snapshot');

const nn = (v) => Number.isFinite(v);

/** A figures row, dropped entirely when the value is unknown — a term sheet that
 *  says "Draw fee —" teaches the reader our numbers are unreliable. */
function row(label, value, opts) {
  if (value == null || value === '—' || value === '') return null;
  return [label, value, opts || {}];
}
const kept = (rows) => rows.filter(Boolean);

/** "A", "A and B", "A, B and C" — a list a person reads, not an array joined. */
function namesList(names) {
  const list = (names || []).filter(Boolean).map(String);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** The sub-title that rides in the brand band, under the document's name. */
const PRODUCT_LINE = 'business-purpose rental financing';

/** "Single family · Purchase · $500,000 value" — only the parts we actually know. */
function propertyLine(m) {
  const s = m.scenario || {};
  const bits = [];
  if (s.propertyType) bits.push(s.propertyType);
  if (s.units && s.units > 1) bits.push(`${Math.round(s.units)} units`);
  if (s.purpose) bits.push(s.purpose);
  if (nn(s.propertyValue)) bits.push(`${wording.money(s.propertyValue)} value`);
  return bits.join(' · ') || null;
}

function locationLine(s) {
  /* ⛔ THE COUNTY IS PRINTED WHEN THERE IS NO TOWN (owner-reported 2026-08-31: a sheet with no
     typed address showed nothing but the ZIP). It is filled from the ZIP upstream in
     `snapshot.projectScenario`, and only when that ZIP determines it — so a county printed here is
     one we can stand behind.

     ⛔ THE TOWN WINS WHEN THERE IS ONE. "Lakewood Ocean County NJ 08701" reads as three different
     places; the county is the FALLBACK for the case the owner reported, not an extra line item.
     Written "Ocean County" rather than "Ocean", because a bare county name reads as a town. */
  const where = s.city
    || (s.county ? (/county|parish|borough/i.test(s.county) ? s.county : `${s.county} County`) : null);
  const tail = [s.state, s.zip].filter(Boolean).join(' ');
  return [where, tail].filter(Boolean).join(', ') || null;
}

/** "$375,000 · 75% LTV · 30-year fixed" */
function loanLine(m) {
  const s = m.scenario || {};
  const bits = [];
  if (nn(s.loanAmount)) bits.push(wording.money(s.loanAmount));
  if (nn(s.ltv)) bits.push(`${wording.pct(s.ltv)} LTV`);
  if (nn(s.termYears)) bits.push(`${Math.round(s.termYears)}-year${s.interestOnly ? ' interest only' : ' fixed'}`);
  return bits.join(' · ') || null;
}

/** The loan, stated as figures rather than as a run-on line. */
function loanRows(m) {
  const s = m.scenario || {};
  return kept([
    row('Program', m.consumerLabel),
    row('Loan purpose', s.purpose),
    row('Loan amount', nn(s.loanAmount) ? wording.money(s.loanAmount) : null, { strong: true }),
    row('Loan to value', nn(s.ltv) ? wording.pct(s.ltv) : null),
    row('Term', nn(s.termYears)
      ? `${Math.round(s.termYears)} years${s.interestOnly ? ', interest only' : ', fixed'}` : null),
    row('Interest rate', wording.rate(m.ratePct), { strong: true }),
    row('Prepayment', m.prepayLabel),
    row('Escrows', s.escrowWaive ? 'Waived — taxes and insurance paid by you directly' : null),
  ]);
}

/**
 * THE MONTHLY PAYMENT — and the PITI, only when it is a real one.
 *
 * ⛔ THE TOTAL APPEARS ONLY WITH BOTH TAXES AND INSURANCE. Owner-directed
 * 2026-08-30: *"only if the taxes and insurance were entered in the scenario …
 * only if the principal, interest, tax, and insurance were entered, the monthly
 * tax, and monthly insurance."* `wording.housingCost` is the ONE place that
 * decides completeness, so the export gate and this page can never disagree
 * about whether a sheet has a PITI on it.
 */
function paymentRows(m) {
  const s = m.scenario || {};
  const hc = wording.housingCost({
    monthlyPI: m.monthlyPI,
    taxMonthly: s.taxMonthly,
    insuranceMonthly: s.insuranceMonthly,
    hoaMonthly: s.hoaMonthly,
  });
  const out = kept([
    row('Principal & interest', nn(m.monthlyPI) ? wording.moneyExact(m.monthlyPI) : null,
      { strong: !hc.complete }),
    row('Property taxes', nn(hc.taxMonthly) ? wording.moneyExact(hc.taxMonthly) : null),
    row('Insurance', nn(hc.insuranceMonthly) ? wording.moneyExact(hc.insuranceMonthly) : null),
    row('Association dues', nn(hc.hoaMonthly) && hc.hoaMonthly > 0 ? wording.moneyExact(hc.hoaMonthly) : null),
  ]);
  if (hc.complete) out.push([hc.label, wording.moneyExact(hc.total), { big: true, accent: true }]);
  return { rows: out, complete: hc.complete, total: hc.total };
}

/**
 * THE DSCR THE SHEET PRINTS — derived from the figures the sheet itself prints,
 * whenever it can be.
 *
 * ⛔ A PAGE MAY NOT CONTRADICT ITSELF, and this one could. The DSCR arrives on
 * the scenario as ONE number, worked out when the board priced it; a comparison
 * puts three options side by side whose total monthly payments genuinely differ
 * — MEASURED on a real render: $3,176.44, $3,304.23 and $3,369.01 — and printing
 * the scenario's single ratio against all three showed 1.24, 1.24, 1.24 under
 * three different payments. Every one of those is a division a reader can do in
 * their head off this very page, and two of the three would have come out wrong.
 *
 * So with a complete PITI the ratio is `rent ÷ the total printed above`, which
 * is exactly what the note under it says it is. Without one there is no total to
 * divide by, so the scenario's own figure stands and the note says what it is a
 * ratio OF rather than pointing at a line that is not there.
 *
 * ⛔ IT NEVER INVENTS ONE. No rent, or no total, and the derived reading is not
 * available — the scenario's value is used or nothing is printed at all.
 */
function shownDscr(m, piti) {
  const s = m.scenario || {};
  const rent = nn(s.rentMonthly) && s.rentMonthly > 0 ? s.rentMonthly : null;
  const total = piti && piti.complete && nn(piti.total) && piti.total > 0 ? piti.total : null;
  if (rent != null && total != null) {
    return { value: Math.round((rent / total) * 100) / 100, derived: true };
  }
  return { value: nn(s.dscr) ? s.dscr : null, derived: false };
}

/** What the loan qualified on: the rent, and the ratio it produces. */
function qualifyingRows(m, piti) {
  const s = m.scenario || {};
  const out = kept([
    row('Monthly rent', nn(s.rentMonthly) ? wording.moneyExact(s.rentMonthly) : null),
  ]);
  /* THE CREDIT SCORE THE PRICE WAS BUILT ON (owner-directed 2026-08-31). The
     disclosures say in terms that the rate moves with "the final verified credit
     score"; naming a figure as governing and never printing it leaves a reader
     unable to tell whether the assumption is theirs. */
  if (nn(s.fico)) out.push(row('Credit score used', String(Math.round(s.fico))));
  const d = shownDscr(m, piti);
  if (nn(d.value)) {
    out.push(['DSCR', d.value.toFixed(2), {
      strong: true, accent: true,
      note: d.derived
        ? 'monthly rent divided by the total monthly payment above'
        : 'monthly rent divided by the monthly housing cost',
    }]);
  }
  return out;
}

/**
 * THE CHARGES, BROKEN DOWN — and the one label that used to lie.
 *
 * ⛔ EVERY GROUP IS NAMED AND EVERY POINTS FIGURE SHOWS ITS ARITHMETIC. The
 * owner asked for both, in one breath: *"you need to list out the lender fees,
 * because the next one, you're waiving the lender fees. You need to be able to
 * see the difference … And for the ones that are actually paying the origination
 * fee, you also need to break down the origination fee they're paying."*
 * `wording.chargeRow` carries the breakdown as a note under each line, and the
 * waived lender fees are LISTED at zero with what they would have been.
 *
 * ⛔ "AT CLOSING" IS NOW THE WHOLE POSITION, NOT THE RATE. The owner read a sheet
 * that said `At closing — No points either way` directly above
 * `Origination fee (2.000 points) $7,500`. Both were true; the label was the
 * bug. The rate's own cost or credit is a line in this list, labelled as such,
 * and the closing figure is the NET of everything (`wording.closingPosition`).
 */
function chargeRows(m) {
  const charges = m.charges || {};
  const lines = charges.lines || [];
  const byKey = (k) => lines.find((l) => l && l.key === k);
  const out = [];

  const push = (line) => {
    const r = wording.chargeRow(line);
    if (r) out.push([r[0], r[1], r[2] || {}]);
  };

  const orig = byKey('origination');
  if (orig) push(orig);
  const buy = byKey('buydown');
  if (buy) push(buy);

  const credit = charges.credit;
  if (credit && nn(credit.dollars) && credit.dollars > 0) {
    out.push(['Credit toward your closing costs', `-${wording.moneyExact(credit.dollars)}`, {
      credit: true,
      note: nn(credit.points) && nn(m.loanAmount)
        ? `${wording.points(credit.points)} points of the ${wording.money(m.loanAmount)} loan amount`
        : null,
    }]);
  }
  return out;
}

/** The lender's own two fees, as their own named group. */
function lenderFeeRows(m) {
  const lines = (m.charges && m.charges.lines) || [];
  const fees = wording.LENDER_FEE_KEYS.map((k) => lines.find((l) => l && l.key === k)).filter(Boolean);
  if (!fees.length) return { rows: [], waived: false, total: 0 };
  const waived = fees.every((l) => l.waived === true);
  const rows = [];
  for (const f of fees) {
    const r = wording.chargeRow(f);
    if (r) rows.push([r[0], r[1], r[2] || {}]);
  }
  const total = fees.reduce((s, l) => s + (nn(l.fullDollars) ? l.fullDollars : 0), 0);
  if (fees.length > 1 && total > 0) {
    rows.push(waived
      ? ['Lender fees you are not paying', wording.moneyExact(total), { strong: true, credit: true, accent: true }]
      : ['Lender fees, total', wording.moneyExact(total), { strong: true }]);
  }
  return { rows, waived, total };
}

/** The closing totals — what this actually costs at the table. */
function closingRows(m) {
  const c = m.closing || {};
  const pos = wording.closingPosition(m.charges);
  const out = [];
  if (nn(c.closingCostDollars)) {
    out.push([pos.kind === 'receive' ? 'Lender credit at closing, net' : 'Lender charges at closing, net',
      wording.moneyExact(Math.abs(c.closingCostDollars)),
      { strong: true, credit: pos.kind === 'receive' }]);
  }
  if (nn(c.downPaymentDollars)) {
    const pctText = nn(c.downPaymentPct) ? ` (${wording.pct(c.downPaymentPct)})` : '';
    out.push([`Down payment${pctText}`, wording.moneyExact(c.downPaymentDollars), {}]);
  }
  if (nn(c.cashToCloseDollars)) {
    out.push(['Estimated cash to close', wording.moneyExact(c.cashToCloseDollars),
      { big: true, accent: true, total: true }]);
  }
  return out;
}

/** The whole money story for ONE option, as blocks. */
function optionBlocks(m, { heading } = {}) {
  const out = [];
  if (heading) out.push({ t: 'band', title: heading });

  const piti = paymentRows(m);
  if (piti.rows.length) {
    out.push({ t: 'subhead', text: 'Monthly payment' });
    out.push({ t: 'figures', rows: piti.rows });
  }
  const qual = qualifyingRows(m, piti);
  if (qual.length) out.push({ t: 'figures', rows: qual });

  const charges = chargeRows(m);
  const fees = lenderFeeRows(m);
  const closing = closingRows(m);
  /* ⛔ THE COST STORY IS ONE STORY AND DOES NOT SPLIT. What the rate costs, the
     lender's own fees and what lands at the table are one argument that ends in
     the cash to close — the figure a borrower opens the sheet for. MEASURED on a
     real render, it split mid-way: page one ended after the application fee and
     page two carried the commitment fee, the total and the whole closing block,
     four rows adrift from what they belong to. A SOFT break moves the lot to the
     next page when there is not enough left of this one to hold it, and does
     nothing at all when there is — so a sheet that fits is unchanged. */
  if (charges.length || fees.rows.length || closing.length) {
    out.push({ t: 'pagebreak', ifLessThan: 200 });
  }
  if (charges.length) {
    out.push({ t: 'subhead', text: 'What this rate costs' });
    out.push({ t: 'figures', rows: charges });
  }
  if (fees.rows.length) {
    out.push({ t: 'subhead', text: 'Lender fees' });
    out.push({ t: 'figures', rows: fees.rows });
  }
  if (fees.waived) {
    out.push({ t: 'para', small: true,
      text: 'The lender fees on this option are covered rather than charged to you. Your cash to close below '
        + 'already reflects that.' });
  }
  if (closing.length) {
    out.push({ t: 'subhead', text: 'At closing' });
    out.push({ t: 'figures', rows: closing });
  }
  out.push({ t: 'para', small: true, text: wording.THIRD_PARTY });
  return out;
}

/** The comparison table: one column per option, the anchor first and marked. */
/**
 * ONE member's housing cost — the ONE place a member becomes a PITI.
 *
 * The comparison table, the DSCR it prints and the sentence beneath it all divide
 * by this same total, so they cannot disagree about what the payment is. It was
 * a closure inside the table until the sentence needed it too, and a second copy
 * there is exactly how a paragraph comes to quote a ratio the column above it
 * does not show.
 */
function pitiFor(m) {
  return wording.housingCost({
    monthlyPI: m && m.monthlyPI,
    taxMonthly: m && m.scenario && m.scenario.taxMonthly,
    insuranceMonthly: m && m.scenario && m.scenario.insuranceMonthly,
    hoaMonthly: m && m.scenario && m.scenario.hoaMonthly,
  });
}

function comparisonTable(snapshot) {
  const cmp = snapshot.comparison;
  const members = snapshot.members;
  const order = [cmp.anchorIndex, ...members.map((_, i) => i).filter((i) => i !== cmp.anchorIndex)];
  const head = ['', ...order.map((i) => {
    const m = members[i];
    return `${m.label}${i === cmp.anchorIndex ? ' (compared against)' : ''}`;
  })];
  const cell = (i, fn) => fn(members[i], cmp.rows[i]);
  const body = [];
  /* WHAT EVERY OPTION AGREES ABOUT, LIFTED OUT OF THE TABLE AND STATED ONCE.
     Owner-reported 2026-08-31: *"the same on all three is just a line. It's not
     laid out nicely."* — and, earlier, the observation that made this necessary
     at all: a comparison of three prices on ONE loan carried the loan amount,
     the LTV, the term, the prepayment, the origination and the lender fees in
     three identical columns. MEASURED on a real render: six of fifteen rows
     said the same thing three times, which is not a comparison, it is
     repetition wearing a comparison's clothes — and it buries the two or three
     rows that actually decide anything.

     ⛔ IT IS COMPUTED FROM THE VALUES, NEVER FROM A LIST OF FIELDS. A hand-kept
     list of "things that are usually the same" is exactly how a sheet comes to
     claim a 5-year prepayment across three scenarios that do not share one. A
     row is lifted only when every column PRINTS the same string. */
  const shared = [];
  const push = (label, fn, opts) => {
    const vals = order.map((i) => cell(i, fn));
    if (!vals.some((v) => v != null && v !== '—')) return;
    const filled = vals.map((v) => (v == null ? '—' : v));
    const same = members.length > 1 && filled.every((v) => v === filled[0]);
    /* ⛔ TWO ROWS ARE NEVER LIFTED, however identical they look.
       `Program` NAMES each column — fold it and the reader loses what they are
       choosing between. The per-column comparison rows (break-even, the cost of
       the extra borrowing) are answers ABOUT a column rather than facts of it,
       and three equal answers is a coincidence of the arithmetic, not a shared
       term of the loan. */
    if (same && !(opts && opts.never)) { shared.push([label, filled[0]]); return; }
    body.push([label, ...filled]);
  };
  const pitiOf = pitiFor;
  const sc = (m) => (m && m.scenario) || {};
  push('Program', (m) => m.consumerLabel, { never: true });
  push('Loan purpose', (m) => sc(m).purpose || null);
  push('Rate', (m) => wording.rate(m.ratePct));
  push('Loan amount', (m) => (nn(m.loanAmount) ? wording.money(m.loanAmount) : null));
  push('LTV', (m) => (nn(m.ltv) ? wording.pct(m.ltv) : null));
  push('Term', (m) => (nn(m.termYears) ? `${Math.round(m.termYears)} yr${m.interestOnly ? ' I/O' : ''}` : null));
  push('Prepayment', (m) => m.prepayLabel);
  push('Escrows', (m) => (sc(m).escrowWaive ? 'Waived — you pay taxes and insurance directly' : null));
  push('Principal & interest', (m) => (nn(m.monthlyPI) ? wording.moneyExact(m.monthlyPI) : null));
  /* The three parts of the payment, so the total below can be CHECKED. They are
     properties of the property rather than of the price, so on a same-loan
     comparison all three fold into the shared block and cost the table nothing —
     and on a scenario sheet where one option waives escrows they correctly
     become their own columns. */
  push('Property taxes', (m) => {
    const hc = pitiOf(m);
    return nn(hc.taxMonthly) ? wording.moneyExact(hc.taxMonthly) : null;
  });
  push('Insurance', (m) => {
    const hc = pitiOf(m);
    return nn(hc.insuranceMonthly) ? wording.moneyExact(hc.insuranceMonthly) : null;
  });
  push('Association dues', (m) => {
    const hc = pitiOf(m);
    return nn(hc.hoaMonthly) && hc.hoaMonthly > 0 ? wording.moneyExact(hc.hoaMonthly) : null;
  });
  // ⛔ THE TOTAL PAYMENT COLUMN APPEARS ONLY WHERE IT IS A REAL PITI. A column
  // that carried a total for one option and a dash for the next would invite a
  // comparison between a full payment and a partial one.
  push('Total monthly payment', (m) => {
    const hc = pitiOf(m);
    return hc.complete ? wording.moneyExact(hc.total) : null;
  });
  push('Origination fee', (m) => {
    const l = ((m.charges || {}).lines || []).find((x) => x && x.key === 'origination');
    return l && nn(l.dollars) && l.dollars > 0 ? wording.moneyExact(l.dollars) : 'None';
  });
  /* ⛔ THE LENDER'S FEES ARE LISTED ONE BY ONE, NEVER AS A LUMP. Owner-directed:
     *"you need to list out the lender fees, because the next one, you're waiving
     the lender fees. You need to be able to see the difference."* A single
     "Lender fees $2,095" cell answers neither question a reader has — which fees,
     and which of them this option is actually charging. Each fee gets its own
     row, so an option that waives ONE of two says exactly that, and a fee that is
     the same on every option folds into the shared block on its own. A waived fee
     is LISTED at what it would have been rather than dropped: a fee you are not
     paying is a thing of value, and a missing row reads as a fee nobody charges. */
  for (const key of wording.LENDER_FEE_KEYS) {
    const label = wording.CHARGE_LABELS[key];
    if (!label) continue;
    push(label, (m) => {
      const l = ((m.charges || {}).lines || []).find((x) => x && x.key === key);
      if (!l) return null;
      if (l.waived === true) {
        return nn(l.fullDollars) && l.fullDollars > 0
          ? `Waived (${wording.moneyExact(l.fullDollars)})` : 'Waived';
      }
      return nn(l.dollars) ? wording.moneyExact(l.dollars) : null;
    });
  }
  /* ⛔ WHAT A WAIVE IS WORTH, TOTALLED — the one place a total of two visible
     rows earns its line. Each fee above already says "Waived ($500)", so the sum
     is arithmetic; but on the option that waives them it is not a subtotal, it
     is the reason to choose that option, and it was stated on the per-option
     page this table replaced. It appears only where a waive exists, so an
     ordinary comparison never carries a row of dashes. */
  push('Lender fees you are not paying', (m) => {
    const lines = (m.charges || {}).lines || [];
    const fees = wording.LENDER_FEE_KEYS.map((k) => lines.find((l) => l && l.key === k)).filter(Boolean);
    if (!fees.length || !fees.some((l) => l.waived === true)) return null;
    const t = fees.filter((l) => l.waived === true)
      .reduce((sum, l) => sum + (nn(l.fullDollars) ? l.fullDollars : 0), 0);
    return t > 0 ? wording.moneyExact(t) : null;
  });
  push('Cost to get this rate', (m) => {
    const cc = wording.costOrCredit(m.charges);
    return cc.kind === 'none' ? 'None' : cc.text;
  });
  /* ⛔ THE CREDIT IS ITS OWN ROW, and it was the one genuine loss when the
     per-option pages went — found by the guard that computes what those pages
     printed, not by reading the diff. On a lender-paid option, or one whose
     lender fees are waived, the rebate comes back as a CREDIT toward closing
     costs, and it is the single line that explains why that option's cash to
     close is lower than the one beside it. Rolled into the net position it is
     arithmetic the reader cannot see; on the pages that carried it, it was
     stated. */
  push('Credit toward your closing costs', (m) => {
    const c = (m.charges || {}).credit;
    return c && nn(c.dollars) && c.dollars > 0 ? `-${wording.moneyExact(c.dollars)}` : null;
  });
  push('Lender charges, net', (m) => wording.closingPosition(m.charges).text);
  // The other half of the cash to close, so the total beneath is arithmetic a
  // reader can follow rather than a figure they have to accept.
  push('Down payment', (m) => {
    const c = m.closing || {};
    if (!nn(c.downPaymentDollars)) return null;
    return nn(c.downPaymentPct)
      ? `${wording.moneyExact(c.downPaymentDollars)} (${wording.pct(c.downPaymentPct)})`
      : wording.moneyExact(c.downPaymentDollars);
  });
  push('Estimated cash to close', (m) => (m.closing && nn(m.closing.cashToCloseDollars)
    ? wording.moneyExact(m.closing.cashToCloseDollars) : null));
  // The DSCR's own numerator. Without it the ratio beneath is unverifiable —
  // and a reader who cannot check a figure has to take it on trust.
  push('Monthly rent', (m) => (nn(sc(m).rentMonthly) ? wording.moneyExact(sc(m).rentMonthly) : null));
  push('DSCR', (m) => {
    const d = shownDscr(m, pitiOf(m));
    return nn(d.value) ? d.value.toFixed(2) : null;
  });
  /* THE CREDIT SCORE THE PRICE WAS BUILT ON (owner-directed 2026-08-31). It
     reached the snapshot and appeared on no sheet — while `Rate and pricing` in
     the disclosures says in terms that the price moves with "the final verified
     credit score". A document that names a figure as governing and never states
     it leaves the reader unable to tell whether the assumption matches them. */
  push('Credit score used', (m) => (nn(sc(m).fico) ? String(Math.round(sc(m).fico)) : null));
  push('Property type', (m) => sc(m).propertyType || null);
  push('Estimated value', (m) => (nn(m.propertyValue) ? wording.money(m.propertyValue) : null));
  if (cmp.workflow === 'A') {
    push('Break-even', (m, r) => (r && nn(r.breakEvenMonths) ? wording.monthsWords(r.breakEvenMonths) : null), { never: true });
  } else {
    push('Cost of the extra borrowing', (m, r) => (r && nn(r.incrementalCostPct) ? `${wording.pct(r.incrementalCostPct)} a year` : null), { never: true });
  }
  return { t: 'table', head, rows: body, anchorColumn: 1, shared };
}

const DIFFER_LABELS = {
  loanAmount: 'loan amount', ltv: 'LTV', termYears: 'term',
  prepay: 'prepayment terms', interestOnly: 'interest only', propertyValue: 'property value',
};
function differLabel(k) { return DIFFER_LABELS[k] || k; }

/** The band's own three lines, and the footer's. */
/**
 * THE DOCUMENT AT A GLANCE — the two or three figures a reader looks for first.
 *
 * Owner-reported 2026-08-31: all three sheets read as *"very ugly and very
 * abrupt"*. Part of that is what they OPEN with. Every one of them began with
 * the parties, then a callout, then a two-column table of small type — so the
 * loan amount, the rate and the payment, which are the whole point, were four
 * inches down in the same size as the property type.
 *
 * ⛔ IT RESTATES, IT NEVER COMPUTES. Every figure here is read straight off the
 * member the tables below are built from — no arithmetic of its own — so the
 * headline can never disagree with the body. That is the only thing that makes
 * a summary safe to put on a document somebody signs.
 *
 * ⛔ AND IT NEVER INVENTS ONE. A cell whose figure is missing is DROPPED, and
 * with fewer than two left the band is omitted entirely: two numbers are a
 * summary, one is an orphan sitting where a summary should be.
 */
function heroCells(s, kind) {
  const members = s.members || [];
  const first = members[0] || {};
  const cells = [];
  const add = (label, value, note) => { if (value) cells.push({ label, value, note: note || null }); };

  if (kind === DOC_KINDS.TERM_SHEET) {
    add('Loan amount', nn(first.loanAmount) ? wording.money(first.loanAmount) : null);
    add('Interest rate', nn(first.ratePct) ? wording.rate(first.ratePct) : null,
      nn(first.termYears) ? `${Math.round(first.termYears)}-year${first.interestOnly ? ' interest-only' : ' fixed'}` : null);
    // The PAYMENT a borrower budgets for is the whole housing cost when the sheet
    // carries the taxes and insurance, and the note payment when it does not —
    // the same rule `paymentRows` draws the table on, asked once here.
    const piti = wording.housingCost(Object.assign({ monthlyPI: first.monthlyPI }, first.scenario || {}));
    add('Monthly payment', piti && nn(piti.total) ? wording.moneyExact(piti.total) : (nn(first.monthlyPI) ? wording.moneyExact(first.monthlyPI) : null),
      // The note is DERIVED from the table's own label, so "& dues" appears in
      // the headline exactly when it appears in the body, from one definition.
      piti && nn(piti.total)
        ? String(piti.label).replace(/^Total monthly payment \(/, '').replace(/\)$/, '')
        : 'principal & interest');
    const cash = (first.closing || {}).cashToCloseDollars;
    add('Cash to close', nn(cash) ? wording.money(cash) : null, 'estimated');
  } else {
    const rates = members.map((m) => m.ratePct).filter(nn);
    const loans = members.map((m) => m.loanAmount).filter(nn);
    const span = (list, fmt) => {
      if (!list.length) return null;
      const lo = Math.min(...list); const hi = Math.max(...list);
      return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
    };
    add(kind === DOC_KINDS.SCENARIO ? 'Scenarios' : 'Options', members.length ? String(members.length) : null,
      'side by side');
    add('Loan amount', span(loans, wording.money));
    add('Interest rate', span(rates, wording.rate));
  }
  return cells.length >= 2 ? cells : null;
}

function metaBlock(s, opts, code) {
  const p = s.prepared || {};
  const kind = s.docKind || DOC_KINDS.TERM_SHEET;
  const n = (s.members || []).length;
  const title = kind === DOC_KINDS.TERM_SHEET ? 'Term Sheet'
    : kind === DOC_KINDS.SCENARIO ? 'Scenario Comparison' : 'Comparison Sheet';
  const first = (s.members || [])[0] || {};
  const subtitle = kind === DOC_KINDS.TERM_SHEET
    ? [first.consumerLabel, PRODUCT_LINE].filter(Boolean).join(' · ')
    : `${n} ${kind === DOC_KINDS.SCENARIO ? 'scenarios' : 'options'} · ${PRODUCT_LINE}`;
  /* ⛔ A DATE IS WRITTEN THE WAY A PERSON WRITES ONE (owner-reported 2026-08-31,
     on all three documents being *"very ugly and very abrupt"*). This band and
     the footer both carried the raw stored instant — `Issued
     2026-08-31T14:00:00.000Z` — on every page of every sheet we have ever sent.
     `wording.dateLong` answers null on anything it cannot read, so an unreadable
     value drops the words rather than printing the machine's. */
  const issuedOn = wording.dateLong(p.preparedAt);
  const identity = [
    p.companyName || null,
    p.companyNmls ? `NMLS ${p.companyNmls}` : null,
    issuedOn ? `Issued ${issuedOn}` : null,
  ].filter(Boolean).join(' · ');
  const contactBits = [p.officerName, p.officerTitle, p.officerPhone, p.officerEmail].filter(Boolean);
  return {
    t: 'meta',
    code,
    title,
    subtitle,
    identity,
    docLabel: title,
    stamp: issuedOn,
    contact: contactBits.length ? `Your ${p.companyName || 'YS Capital'} contact: ${contactBits.join('  ·  ')}` : null,
    disclaimer: `${s.disclosure || wording.DISCLOSURE} Subject to underwriting, appraisal, title and final `
      + `credit approval. Not valid until countersigned by ${p.companyName || 'YS Capital Group'}.`,
  };
}

/**
 * WHO THE DOCUMENT IS ADDRESSED TO, in one line, from two fields.
 *
 * ⛔ THE ENTITY IS THE BORROWER AND THE PERSON IS THE GUARANTOR — that is not a
 * house style, it is what the two words mean on a DSCR loan: the loan is made
 * to the entity that will hold title, and the individual behind it guarantees
 * it. So when both are given the entity leads and the person is named as the
 * guarantor behind it; when only one is given, that one is simply the party.
 * Getting this backwards would print a person's name where a company must sign.
 *
 * Neither → null. The export gate refuses a term sheet with no party at all, so
 * a null here can only ever reach a COMPARISON, which needs no addressee.
 */
function preparedFor(p) {
  const person = (p && p.borrowerName) || null;
  const entity = (p && p.entityName) || null;
  if (entity && person) return `${entity} · ${person}`;
  return entity || person || null;
}

/**
 * The signature lines, with each party under the role it actually signs in.
 *
 * ⛔ A ROLE LABEL IS NOT DECORATION ON A PAGE SOMEBODY SIGNS. "Borrower /
 * guarantor" over a company name reads as the company guaranteeing itself;
 * "Borrower" over a person's name on an entity deal names the wrong borrower.
 * So the labels follow `preparedFor`'s reading: both given → two lines, the
 * entity as borrower and the person as guarantor; one given → the one combined
 * line this document has always printed.
 */
function signatureParties(p) {
  const person = (p && p.borrowerName) || null;
  const entity = (p && p.entityName) || null;
  if (entity && person) {
    return [
      { role: 'Borrower — authorized signatory', name: entity },
      { role: 'Date' },
      { role: 'Guarantor', name: person },
      { role: 'Date' },
    ];
  }
  if (entity) return [{ role: 'Borrower — authorized signatory', name: entity }, { role: 'Date' }];
  return [{ role: 'Borrower / guarantor', name: person }, { role: 'Date' }];
}

/** The recipient block, and the property it is about. */
function recipientBlock(s) {
  const p = s.prepared || {};
  const first = (s.members || [])[0] || {};
  const officer = [
    p.officerName,
    p.officerTitle || null,
    [p.officerPhone, p.officerEmail].filter(Boolean).join(' · ') || null,
    p.officerNmls ? `NMLS #${p.officerNmls}` : null,
  ].filter(Boolean);
  return {
    t: 'recipient',
    borrowerName: p.borrowerName || null,
    // The vesting entity, when there is one. Carried BESIDE the person rather
    // than instead of them — `preparedFor` decides how the two read together,
    // in one place, so the recipient block and the signature lines can never
    // disagree about who this document is addressed to.
    entityName: p.entityName || null,
    preparedFor: preparedFor(p),
    propertyAddress: p.propertyAddress || locationLine(first.scenario || {}),
    /* ⛔ ON A COMPARISON THE PROPERTY FACTS RIDE HERE, NOT IN A BAND OF THEIR OWN.
       Page one of a comparison is the comparison: the whole value of the document
       is the options standing side by side where a reader can run an eye down
       them, and a table that spills onto a second page has stopped being one.
       The two facts are the same two facts, printed under the address they are
       about — one line instead of a heading and a two-row table, which reads
       better AND leaves the table its page. A term sheet has the room and keeps
       the band, where the structure earns its space. */
    // Only where the band is not drawn, or the same two facts would appear
    // twice on one page.
    propertyFacts: (s.docKind || DOC_KINDS.TERM_SHEET) === DOC_KINDS.TERM_SHEET
      ? null : propertyFacts(s.members || []),
    officer,
  };
}

/**
 * "Single family · 2 units · valued at $500,000" — the property facts, and ONLY
 * the ones every option on this document agrees about.
 *
 * ⛔ IT TAKES THE WHOLE LIST, NOT THE FIRST MEMBER (owner-reported 2026-08-31,
 * who named the class before the instance: *"when it's saying that this and this
 * amount is the same on all scenarios ... when in truth there can be different
 * scenarios with different amounts."*).
 *
 * This line sits in the HEADER, under the address, where it reads as a fact
 * about the document rather than about one column. It was built from
 * `members[0]`, so a scenario comparison of the same property at two valuations
 * printed *"valued at $500,000"* over a table whose second column was priced on
 * $650,000 — one property stated, two priced. `comparison.buildComparison`
 * already reports `propertyValue` in its `differs` list, so the document knew;
 * the header simply never asked.
 *
 * ⛔ A FACT THE OPTIONS DISAGREE ABOUT IS DROPPED, NOT AVERAGED AND NOT RANGED.
 * A range in the header ("valued at $500,000–$650,000") reads as one property
 * somebody could not price, and the honest home for a figure that differs is the
 * comparison table, which already carries it per column. Silence here is a
 * smaller claim than a wrong one.
 *
 * Found by `test-lt-sheet-fuzz-pure`, which builds the documents across a
 * combinatorial space and refuses any single stated fact the options contradict.
 */
function propertyFacts(members) {
  const list = (Array.isArray(members) ? members : [members]).filter(Boolean);
  if (!list.length) return null;

  /* Unanimous, or nothing. `read` returns the comparable value; a member that
     cannot answer counts as its own answer, so two options where only one
     states a type still disagree — which is exactly right, because printing the
     one we have would attribute it to both. */
  const agreed = (read) => {
    const seen = new Set(list.map((m) => JSON.stringify(read(m) === undefined ? null : read(m))));
    return seen.size === 1 ? read(list[0]) : null;
  };

  const type = agreed((m) => ((m && m.scenario) || {}).propertyType || null);
  const units = agreed((m) => {
    const u = ((m && m.scenario) || {}).units;
    return nn(u) && u > 1 ? Math.round(u) : null;
  });
  const value = agreed((m) => (nn(m && m.propertyValue) ? Math.round(m.propertyValue) : null));

  return kept([
    type || null,
    units ? `${units} units` : null,
    value != null ? `valued at ${wording.money(value)}` : null,
  ]).join(' · ') || null;
}

/**
 * THE EXPIRY, SAID OUT LOUD — on the term sheet, in its own panel.
 *
 * Owner-directed 2026-08-30: *"it should also say that it's expiring in 24
 * hours."* It is a callout rather than a figures row because a reader skims
 * rows; the whole point of this one is that it must not be skimmed.
 *
 * ⛔ IT STATES WHAT WE ACTUALLY SET. `expiresAt` comes from the issuing route
 * and the window is a company setting, so the panel reads the window off the
 * snapshot rather than restating "24 hours" as a literal that would go on saying
 * 24 after somebody changed the setting to 48.
 */
function expiryBlock(s, opts) {
  const p = s.prepared || {};
  if (!p.expiresAt) return null;
  /* ⛔ EVERY DOCUMENT SAYS WHEN ITS PRICING DIES, NOT ONLY THE TERM SHEET
     (owner-reported 2026-08-31). The store has always stamped `expires_at` on a
     comparison too, and the lookup screen has always marked one expired — the
     PAPER was the only place that did not say so, so a borrower holding a
     week-old comparison had nothing on it telling them the rates had moved.
     The wording names WHICH document it is, from the same table the filename
     and the title come from, so the three can never disagree. */
  const kindWord = KIND_WORDS[s.docKind || DOC_KINDS.TERM_SHEET] || KIND_WORDS[DOC_KINDS.TERM_SHEET];
  const hours = nn(opts.expiryHours) ? Math.round(opts.expiryHours) : null;
  // ⛔ SAY IT THE WAY THE OWNER SAID IT. A 24-hour window rendered as "1 day" is
  // arithmetically identical and reads as a looser promise; the owner's words
  // were *"it should also say that it's expiring in 24 hours"*, and on a document
  // whose whole purpose is urgency the unit is the message. Hours up to two days,
  // days beyond that, where "3 days" genuinely is the clearer reading.
  const window = hours == null ? null
    : hours <= 48
      ? `${hours} hour${hours === 1 ? '' : 's'}`
      : hours % 24 === 0
        ? `${hours / 24} days`
        : `${hours} hours`;
  const through = wording.dateTimeLong(p.expiresAt);
  return {
    t: 'callout',
    title: window ? `This ${kindWord} expires in ${window}.` : `This ${kindWord} expires.`,
    // The deadline is an INSTANT, so it is printed with its hour AND its zone —
    // a borrower cannot act on a moment they have to interpret. An unreadable
    // one drops the sentence rather than printing the stored value at them.
    text: `${through ? `Good through ${through}. ` : ''}Pricing moves with the market, so after that it has to `
      + 'be re-quoted. Nothing here is locked until we lock it in writing.',
  };
}

/**
 * The whole document, as blocks.
 *
 * `pages` are HARD breaks only: the disclosures page, and one detail page per
 * option on a comparison — which is the owner's *"it's just adding pages to
 * it"*, literally. Everything else the renderer flows and breaks where it must.
 */
function buildLayout(snapshot, opts = {}) {
  const s = snapshot;
  const code = opts.code || null;
  const kind = s.docKind || DOC_KINDS.TERM_SHEET;
  const isTermSheet = kind === DOC_KINDS.TERM_SHEET;
  const p = s.prepared || {};
  const blocks = [];

  blocks.push(metaBlock(s, opts, code));
  blocks.push(recipientBlock(s));
  // The headline sits ABOVE the expiry callout: what the loan IS comes before
  // how long the price holds, which is the order a person reads them in.
  const hero = heroCells(s, kind);
  if (hero) blocks.push({ t: 'hero', cells: hero });

  /* ⛔ EVERY DOCUMENT SAYS WHEN ITS PRICING DIES (owner-directed 2026-08-31).
     This was a RECORDED decision the other way — "a comparison is a working
     document, not an offer with a clock on it" — so it was put to the owner
     rather than reversed by a tidying pass, and they chose to add it.

     The reasoning they were shown: the store has always stamped `expires_at` on
     a comparison too, and the lookup screen has always marked one expired. The
     PAPER was the only place that did not say so, so a borrower holding a
     week-old comparison had nothing on it telling them the rates had moved.

     The wording names WHICH document it is, from the same `KIND_WORDS` table the
     filename and the title come from, so the three can never disagree. */
  const exp = expiryBlock(s, opts);
  if (exp) blocks.push(exp);

  const first = s.members[0];

  // ── the property, and (on a term sheet) the loan ─────────────────────────
  const fs0 = first.scenario || {};
  if (isTermSheet) {
    blocks.push({ t: 'band', title: 'The property' });
    blocks.push({ t: 'figures', rows: kept([
      row('Property type', fs0.propertyType),
      row('Units', nn(fs0.units) && fs0.units > 1 ? String(Math.round(fs0.units)) : null),
      row('Estimated value', nn(first.propertyValue) ? wording.money(first.propertyValue) : null),
    ]) });
  }

  if (isTermSheet) {
    blocks.push({ t: 'band', title: 'The loan' });
    blocks.push({ t: 'figures', rows: loanRows(first) });
    blocks.push(...optionBlocks(first));
  } else {
    const cmp = s.comparison;
    blocks.push({ t: 'band', title: kind === DOC_KINDS.SCENARIO ? 'The scenarios' : 'Your options' });
    if (kind === DOC_KINDS.SCENARIO && cmp.differs && cmp.differs.length) {
      blocks.push({ t: 'para',
        text: `These scenarios differ in: ${cmp.differs.map(differLabel).join(', ')}. Everything else about the `
          + 'property and the program is the same.' });
    } else if (cmp.differs && cmp.differs.length) {
      blocks.push({ t: 'para', small: true,
        text: `These options differ in: ${cmp.differs.map(differLabel).join(', ')}.` });
    } else {
      blocks.push({ t: 'para', small: true,
        text: 'These options are the same loan on the same property, priced three ways.' });
    }
    /* WHAT IS THE SAME GOES ABOVE THE TABLE, ONCE, AND IS STRUCK FROM IT.
       The table then carries only what the reader is actually choosing between,
       which is the whole job of the page. `comparisonTable` computes the split
       from the printed values, so a term that DIFFERS — a 3-year prepayment
       beside two 5-years — never appears here and always keeps its own row.

       ⛔ IT IS DRAWN AS A FIGURES BLOCK, NOT AS A NEW PRIMITIVE. `pdf.js`
       already knows how to draw a labelled two-column list and how to break one
       across a page; a fourth kind of table would be a second thing to keep
       correct for no gain the reader can see. */
    const table = comparisonTable(s);

    /* ⛔ THE COMPARISON GOES FIRST, AND THE SHARED FACTS FOLLOW IT. The shared
       block was above the table when it was written, which reads well and cost
       the sheet the one thing it exists for: fifteen lifted facts pushed the
       table's last four rows — the cash to close, the DSCR and the cost of the
       extra borrowing, which is to say the answer — onto a second page, so the
       columns a reader is choosing between could not be seen at once. MEASURED:
       the table broke 9 rows on page one and 4 on page two.

       The table is the argument; what every option agrees about is reference a
       reader consults second, and a reference list is the one thing here that
       breaks across a page harmlessly. So the order follows what the reader is
       doing, not what reads tidily in the source. */
    blocks.push({ t: 'pagebreak', ifLessThan: 300 });
    blocks.push(table);
    const anchor = s.members[cmp.anchorIndex];
    blocks.push({ t: 'para', small: true, text: `Every comparison below is against ${anchor.label}.` });
    for (const r of cmp.rows) {
      if (r.isAnchor) continue;
      const m = s.members[r.index];
      /* THE SENTENCE IS HANDED THE RATIO THE TABLE PRINTS. Both are computed by
         `shownDscr` from the same members, so the paragraph can never quote a
         DSCR a reader cannot find in the column above it. */
      const sentence = cmp.workflow === 'A'
        ? wording.breakEvenSentence(r, m, anchor)
        : wording.incrementalSentence(r, m, anchor, {
          member: shownDscr(m, pitiFor(m)).value,
          anchor: shownDscr(anchor, pitiFor(anchor)).value,
        });
      if (sentence) blocks.push({ t: 'para', text: sentence });
    }
    /* ⛔ A WAIVE IS EXPLAINED IN WORDS, NOT ONLY PRICED. The table says
       "Waived ($500)" per fee and totals what it saves, which is the arithmetic;
       what it does not say is WHO is paying instead, and that is the part a
       borrower reads a term sheet to learn. The per-option page this table
       replaced carried that sentence, so it moves here rather than being lost —
       once for the sheet, naming the options it applies to, because on a
       comparison the answer differs column by column. */
    const waivers = s.members.filter((m) => {
      const lines = (m.charges || {}).lines || [];
      const fees = wording.LENDER_FEE_KEYS.map((k) => lines.find((l) => l && l.key === k)).filter(Boolean);
      return fees.length > 0 && fees.some((l) => l.waived === true);
    });
    if (waivers.length) {
      const who = waivers.length === s.members.length
        ? 'On every option above'
        : `On ${namesList(waivers.map((m) => m.label))}`;
      blocks.push({ t: 'para', small: true,
        text: `${who}, the lender fees are covered by the lender, not paid by you. The cash to close on `
          + `${waivers.length > 1 ? 'those options' : 'that option'} already reflects that.` });
    }
    if (table.shared && table.shared.length) {
      blocks.push({ t: 'subhead', text: `The same in all ${s.members.length} — stated once` });
      blocks.push({ t: 'para', small: true,
        text: 'These are the same on every option above, so they are stated here once rather than repeated in each column.' });
      // TIGHT: this block carries most of the sheet's facts now, and at the
      // ordinary rhythm (a divider and 5pt under every row) fifteen of them fill
      // half a page. They are a reference list, not the argument.
      blocks.push({ t: 'figures', tight: true, rows: table.shared.map(([k, v]) => [k, v, {}]) });
    }
    if (cmp.spreadMinutes > (opts.pricedApartMinutes || 60)) {
      blocks.push({ t: 'para', small: true,
        text: 'These options were priced at different times, so they reflect the market as it stood at each of '
          + 'those moments.' });
    }
    /* ⛔ THE PER-OPTION PAGES ARE GONE, AND NOTHING WENT WITH THEM.
       Owner-reported 2026-08-31: *"everything is way too big … it's not laid
       out nicely, just thrown on the sheet without an order."* MEASURED on a
       real render, that was mostly ONE thing: after the comparison table, this
       sheet restated every option IN FULL, on a page each — programme, purpose,
       loan amount, LTV, term, rate, prepayment, the payment breakdown, the rent,
       the DSCR, the charges and the closing totals. Three options, three pages,
       and every figure on them already sat in the table or in the shared block
       directly above. A comparison sheet was seven pages of which three were
       repetition.

       ⛔ THE TABLE HAD TO GROW BEFORE THIS LOOP COULD GO, and it did: loan
       purpose, the tax / insurance / dues split, the rent, the credit score, the
       property type and value, each lender fee ON ITS OWN ROW, and the down
       payment are all rows now. Whatever every option agrees about folds into
       the shared block and is stated once; whatever they differ on keeps its own
       column. So a fact is stated once instead of four times, and never zero
       times — which is the part that needed proving rather than asserting.
       `test-lt-sheet-nothing-lost-pure.js` computes what these blocks WOULD have
       printed and fails the build on a label the table and the shared block
       between them do not carry. */
  }

  // ── the disclosures ─────────────────────────────────────────────────────
  // A SOFT break: they get their own page when there is not enough left of this
  // one to be worth starting on, and simply continue when there is. A hard break
  // here is what produced a page carrying five rows and ten inches of nothing.
  blocks.push({ t: 'pagebreak', ifLessThan: 240 });
  blocks.push({ t: 'band', title: 'Disclosures & conditions' });
  blocks.push({ t: 'para', small: true,
    text: 'The following supplements the terms above and forms part of this document.' });
  blocks.push({ t: 'disclosures', items: disclosureItems(s) });

  // ── the acceptance block — TERM SHEET ONLY ───────────────────────────────
  // ⛔ NEVER ON A COMPARISON. A signature under three columns records agreement
  // to nothing in particular, and the one thing a signed page must be is
  // unambiguous about what was signed.
  if (isTermSheet) {
    blocks.push({ t: 'band', title: 'Acceptance' });
    blocks.push({ t: 'para',
      text: 'Signing below confirms you have read this term sheet, including the disclosures above, and wish to '
        + 'proceed on these terms. It is not a loan commitment.' });
    blocks.push({ t: 'signature', lines: [
      ...signatureParties(p),
      { role: `${p.companyName || 'YS Capital Group'} — authorized signatory` },
      { role: 'Date' },
    ] });
  }
  return { blocks, code, docKind: kind };
}

/**
 * The disclosure list for THIS sheet — the brand's standing items, minus any
 * whose fact the sheet does not carry.
 *
 * ⛔ A DISCLOSURE ABOUT SOMETHING THIS LOAN HAS NOT GOT IS WORSE THAN NO
 * DISCLOSURE: it puts a term on the document that is not a term of the loan.
 * The prepayment item is gated on the sheet actually stating a prepayment.
 */
function disclosureItems(s) {
  const members = s.members || [];
  // ⛔ THE FACT, NOT THE RENDERED STRING. `prepayLabel` is truthy on a loan with
  // NO penalty too — it reads "No prepayment penalty" — so gating on it would
  // print "the prepayment terms shown apply if the loan is paid off" on the one
  // loan where nothing applies. The months are the fact.
  const hasPrepay = members.some((m) => Number.isFinite((m.scenario || {}).prepayMonths)
    && (m.scenario || {}).prepayMonths > 0);
  return brand.DISCLOSURES
    .filter(([, , gate]) => (gate === 'prepay' ? hasPrepay : true))
    .map(([h, b]) => [h, b]);
}

module.exports = {
  buildLayout, optionBlocks, comparisonTable, qualifyingRows, shownDscr, paymentRows, chargeRows, lenderFeeRows,
  closingRows, loanRows, propertyLine, loanLine, disclosureItems, metaBlock, expiryBlock,
  DIFFER_LABELS, PRODUCT_LINE,
  // Exported for the suites only: the headline band's rule, so "a band with one
  // figure is not a band" can be asserted rather than described.
  _internals: { heroCells, propertyFacts },
};
