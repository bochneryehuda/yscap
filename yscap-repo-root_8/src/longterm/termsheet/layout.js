'use strict';
/**
 * LONG-TERM TERM SHEETS — THE LAYOUT, AS DATA.
 *
 * This module decides WHAT is on the page and in what order; `pdf.js` decides
 * how it is drawn. The split is deliberate and it is what makes the document
 * testable: a block list can be asserted in CI (does a comparison name its
 * anchor? does every page carry the disclosure? does a borrower-facing sheet
 * ever carry a lender's name?) without rendering a single pixel, and the page
 * can be changed without touching the drawing primitives.
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

const nn = (v) => Number.isFinite(v);

/** A figures row, dropped entirely when the value is unknown — a term sheet that
 *  says "Draw fee —" teaches the reader our numbers are unreliable. */
function row(label, value, opts) {
  if (value == null || value === '—' || value === '') return null;
  return [label, value, opts || {}];
}
const kept = (rows) => rows.filter(Boolean);

/** "Single family · Purchase · $500,000 value" — only the parts we actually know. */
function propertyLine(m) {
  const s = m.scenario || {};
  const bits = [];
  if (s.propertyType) bits.push(s.propertyType);
  if (s.purpose) bits.push(s.purpose);
  if (nn(s.propertyValue)) bits.push(`${wording.money(s.propertyValue)} value`);
  return bits.join(' · ') || null;
}

function locationLine(s) {
  const bits = [];
  if (s.city) bits.push(s.city);
  if (s.state) bits.push(s.state);
  if (s.zip) bits.push(s.zip);
  const tail = bits.join(' ');
  return tail || null;
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

/** The qualifying figures, and the ratio they produce. */
function qualifyingRows(m) {
  const s = m.scenario || {};
  const out = kept([
    row('Monthly rent', nn(s.rentMonthly) ? wording.moneyExact(s.rentMonthly) : null),
    row('Property taxes', nn(s.taxMonthly) ? wording.moneyExact(s.taxMonthly) : null),
    row('Insurance', nn(s.insuranceMonthly) ? wording.moneyExact(s.insuranceMonthly) : null),
    row('HOA dues', nn(s.hoaMonthly) && s.hoaMonthly > 0 ? wording.moneyExact(s.hoaMonthly) : null),
  ]);
  if (nn(m.monthlyPI) && out.length) {
    const housing = m.monthlyPI + (s.taxMonthly || 0) + (s.insuranceMonthly || 0) + (s.hoaMonthly || 0);
    out.push(['Total monthly housing cost', wording.moneyExact(Math.round(housing * 100) / 100), { strong: true }]);
  }
  if (nn(s.dscr)) out.push(['DSCR', s.dscr.toFixed(2), { strong: true, note: 'rent ÷ monthly housing cost' }]);
  return out;
}

/** The charge list + the closing totals for one option. */
function chargeBlocks(m) {
  const rows = [];
  for (const line of (m.charges && m.charges.lines) || []) {
    const r = wording.chargeRow(line);
    if (r) rows.push([r[0], r[1], {}]);
  }
  const credit = m.charges && m.charges.credit;
  if (credit && nn(credit.dollars) && credit.dollars > 0) {
    rows.push(['Credit toward closing', `-${wording.moneyExact(credit.dollars)}`, { credit: true }]);
  }
  const c = m.closing || {};
  if (nn(c.closingCostDollars)) {
    rows.push(['Lender costs, net', wording.moneyExact(c.closingCostDollars), { strong: true }]);
  }
  if (nn(c.downPaymentDollars)) {
    const pctText = nn(c.downPaymentPct) ? ` (${wording.pct(c.downPaymentPct)})` : '';
    rows.push([`Down payment${pctText}`, wording.moneyExact(c.downPaymentDollars), {}]);
  }
  if (nn(c.cashToCloseDollars)) {
    rows.push(['Estimated cash to close', wording.moneyExact(c.cashToCloseDollars), { strong: true, total: true }]);
  }
  return rows;
}

/** The full detail block for one option. */
function memberBlocks(m, { heading } = {}) {
  const out = [];
  out.push({ t: 'section', title: heading || `${m.consumerLabel}${m.product ? ' — ' + m.product : ''}` });
  const head = kept([
    row('Rate', wording.rate(m.ratePct), { big: true }),
    row('Monthly principal & interest', nn(m.monthlyPI) ? wording.moneyExact(m.monthlyPI) : null, { big: true }),
  ]);
  const cc = wording.costOrCredit(m.charges);
  head.push(['At closing', cc.text, { big: true }]);
  out.push({ t: 'figures', rows: head });
  out.push({ t: 'rule' });
  out.push({ t: 'figures', rows: chargeBlocks(m) });
  if (m.waiveLenderFees) {
    out.push({ t: 'para', text: 'The lender fees are covered from your closing credit rather than paid at the table. '
      + 'Your cash to close already reflects that.' });
  }
  const prepay = m.prepayLabel;
  if (prepay) out.push({ t: 'para', text: `Prepayment terms: ${prepay}. Applies if you sell or refinance during the term.` });
  out.push({ t: 'para', text: wording.THIRD_PARTY, small: true });
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
  push('Rate', (m) => wording.rate(m.ratePct));
  push('Loan amount', (m) => (nn(m.loanAmount) ? wording.money(m.loanAmount) : null));
  push('LTV', (m) => (nn(m.ltv) ? wording.pct(m.ltv) : null));
  push('Term', (m) => (nn(m.termYears) ? `${Math.round(m.termYears)} yr${m.interestOnly ? ' I/O' : ''}` : null));
  push('Prepayment', (m) => m.prepayLabel);
  push('Monthly principal & interest', (m) => (nn(m.monthlyPI) ? wording.moneyExact(m.monthlyPI) : null));
  push('At closing', (m) => wording.costOrCredit(m.charges).text);
  push('Estimated cash to close', (m) => (m.closing && nn(m.closing.cashToCloseDollars)
    ? wording.moneyExact(m.closing.cashToCloseDollars) : null));
  push('DSCR', (m) => (nn(m.dscr) ? m.dscr.toFixed(2) : null));
  if (cmp.workflow === 'A') {
    push('Break-even', (m, r) => (r && nn(r.breakEvenMonths) ? wording.monthsWords(r.breakEvenMonths) : null));
  } else {
    push('Cost of the extra borrowing', (m, r) => (r && nn(r.incrementalCostPct) ? `${wording.pct(r.incrementalCostPct)} a year` : null));
  }
  return { t: 'table', head, rows: body, anchorColumn: 1 };
}

/**
 * The whole document, as blocks.
 *
 * `pages` are HARD breaks only: one detail page per option on a comparison,
 * which is the owner's *"it's just adding pages to it"*, literally. Everything
 * else the renderer flows and breaks where it must.
 */
function buildLayout(snapshot, opts = {}) {
  const s = snapshot;
  const code = opts.code || null;
  const blocks = [];
  const p = s.prepared || {};

  blocks.push({ t: 'header', code, preparedAt: p.preparedAt, expiresAt: p.expiresAt,
    companyName: p.companyName, companyNmls: p.companyNmls });

  const parties = kept([
    row('Prepared for', p.borrowerName),
    row('Prepared by', p.officerName),
    row('', [p.officerPhone, p.officerEmail].filter(Boolean).join(' · ') || null),
    row('', p.officerNmls ? `NMLS #${p.officerNmls}` : null),
  ]);
  if (parties.length) blocks.push({ t: 'figures', rows: parties, tight: true });

  const first = s.members[0];
  const deal = kept([
    row('The property', p.propertyAddress || locationLine(first.scenario || {})),
    row('', propertyLine(first)),
    row('The loan', s.kind === 'single' ? loanLine(first) : 'See the options below'),
  ]);
  if (deal.length) {
    blocks.push({ t: 'rule' });
    blocks.push({ t: 'figures', rows: deal, tight: true });
  }
  const qual = qualifyingRows(first);
  if (qual.length && s.kind === 'single') {
    blocks.push({ t: 'section', title: 'Qualifying' });
    blocks.push({ t: 'figures', rows: qual });
  }

  if (s.kind === 'single') {
    blocks.push(...memberBlocks(first));
  } else {
    const cmp = s.comparison;
    blocks.push({ t: 'section', title: 'Your options' });
    if (cmp.differs && cmp.differs.length) {
      blocks.push({ t: 'para', small: true,
        text: `These options differ in: ${cmp.differs.map(differLabel).join(', ')}.` });
    }
    blocks.push(comparisonTable(s));
    const anchor = s.members[cmp.anchorIndex];
    blocks.push({ t: 'para', small: true,
      text: `Every comparison below is against ${anchor.label}.` });
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
        text: 'These options were priced at different times, so they reflect the market as it stood at each of those moments.' });
    }
    for (const m of s.members) {
      blocks.push({ t: 'pagebreak' });
      blocks.push(...memberBlocks(m, { heading: `${m.label} — ${m.consumerLabel}${m.product ? ' · ' + m.product : ''}` }));
    }
  }

  blocks.push({ t: 'rule' });
  blocks.push({ t: 'para', text: s.disclosure || wording.DISCLOSURE, small: true });
  blocks.push({ t: 'footer', code });
  return { blocks, code };
}

const DIFFER_LABELS = {
  loanAmount: 'loan amount', ltv: 'LTV', termYears: 'term',
  prepay: 'prepayment terms', interestOnly: 'interest only', propertyValue: 'property value',
};
function differLabel(k) { return DIFFER_LABELS[k] || k; }

module.exports = { buildLayout, memberBlocks, comparisonTable, qualifyingRows, propertyLine, loanLine, DIFFER_LABELS };
