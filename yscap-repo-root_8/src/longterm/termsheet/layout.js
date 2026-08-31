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
  const push = (label, fn) => {
    const vals = order.map((i) => cell(i, fn));
    if (vals.some((v) => v != null && v !== '—')) body.push([label, ...vals.map((v) => (v == null ? '—' : v))]);
  };
  const pitiOf = (m) => wording.housingCost({
    monthlyPI: m.monthlyPI,
    taxMonthly: m.scenario && m.scenario.taxMonthly,
    insuranceMonthly: m.scenario && m.scenario.insuranceMonthly,
    hoaMonthly: m.scenario && m.scenario.hoaMonthly,
  });
  push('Program', (m) => m.consumerLabel);
  push('Rate', (m) => wording.rate(m.ratePct));
  push('Loan amount', (m) => (nn(m.loanAmount) ? wording.money(m.loanAmount) : null));
  push('LTV', (m) => (nn(m.ltv) ? wording.pct(m.ltv) : null));
  push('Term', (m) => (nn(m.termYears) ? `${Math.round(m.termYears)} yr${m.interestOnly ? ' I/O' : ''}` : null));
  push('Prepayment', (m) => m.prepayLabel);
  push('Principal & interest', (m) => (nn(m.monthlyPI) ? wording.moneyExact(m.monthlyPI) : null));
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
  push('Lender fees', (m) => {
    const lines = (m.charges || {}).lines || [];
    const fees = wording.LENDER_FEE_KEYS.map((k) => lines.find((l) => l && l.key === k)).filter(Boolean);
    if (!fees.length) return null;
    if (fees.every((l) => l.waived === true)) {
      const t = fees.reduce((s, l) => s + (nn(l.fullDollars) ? l.fullDollars : 0), 0);
      return `Waived (${wording.moneyExact(t)})`;
    }
    return wording.moneyExact(fees.reduce((s, l) => s + (nn(l.dollars) ? l.dollars : 0), 0));
  });
  push('Cost to get this rate', (m) => {
    const cc = wording.costOrCredit(m.charges);
    return cc.kind === 'none' ? 'None' : cc.text;
  });
  push('Lender charges, net', (m) => wording.closingPosition(m.charges).text);
  push('Estimated cash to close', (m) => (m.closing && nn(m.closing.cashToCloseDollars)
    ? wording.moneyExact(m.closing.cashToCloseDollars) : null));
  push('DSCR', (m) => {
    const d = shownDscr(m, pitiOf(m));
    return nn(d.value) ? d.value.toFixed(2) : null;
  });
  if (cmp.workflow === 'A') {
    push('Break-even', (m, r) => (r && nn(r.breakEvenMonths) ? wording.monthsWords(r.breakEvenMonths) : null));
  } else {
    push('Cost of the extra borrowing', (m, r) => (r && nn(r.incrementalCostPct) ? `${wording.pct(r.incrementalCostPct)} a year` : null));
  }
  return { t: 'table', head, rows: body, anchorColumn: 1 };
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
      ? null : propertyFacts(first),
    officer,
  };
}

/** "Single family · 2 units · valued at $500,000" — or null when we know none. */
function propertyFacts(m) {
  const sc = (m && m.scenario) || {};
  return kept([
    sc.propertyType || null,
    nn(sc.units) && sc.units > 1 ? `${Math.round(sc.units)} units` : null,
    nn(m && m.propertyValue) ? `valued at ${wording.money(m.propertyValue)}` : null,
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

  /* ⛔ THE CLOCK STAYS ON THE TERM SHEET ALONE, and that is a RECORDED decision
     rather than an omission: a term sheet is an offer with a deadline, a
     comparison is a working document you talk through. Widening it was tried
     during the 2026-08-31 redesign and reverted — the owner asked for the three
     documents to read better, not for a comparison to grow a deadline, and a
     recorded design decision is not something a tidying pass reverses on its
     own. (The record DOES carry an expiry on every kind — the store stamps one
     and the lookup screen marks a stale sheet — so putting it on the paper is a
     live question for the owner, not a bug.) */
  if (isTermSheet) {
    const exp = expiryBlock(s, opts);
    if (exp) blocks.push(exp);
  }

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
    blocks.push(comparisonTable(s));
    const anchor = s.members[cmp.anchorIndex];
    blocks.push({ t: 'para', small: true, text: `Every comparison below is against ${anchor.label}.` });
    for (const r of cmp.rows) {
      if (r.isAnchor) continue;
      const m = s.members[r.index];
      const sentence = cmp.workflow === 'A'
        ? wording.breakEvenSentence(r, m, anchor)
        : wording.incrementalSentence(r, m, anchor);
      if (sentence) blocks.push({ t: 'para', text: sentence });
    }
    if (cmp.spreadMinutes > (opts.pricedApartMinutes || 60)) {
      blocks.push({ t: 'para', small: true,
        text: 'These options were priced at different times, so they reflect the market as it stood at each of '
          + 'those moments.' });
    }
    for (const m of s.members) {
      blocks.push({ t: 'pagebreak' });
      blocks.push({ t: 'band', title: `${m.label} — ${m.consumerLabel}` });
      blocks.push({ t: 'figures', rows: loanRows(m) });
      blocks.push(...optionBlocks(m));
    }
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
