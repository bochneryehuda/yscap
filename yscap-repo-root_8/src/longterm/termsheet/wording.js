'use strict';
/**
 * LONG-TERM TERM SHEETS — THE WORDING.
 *
 * The spec is `docs/longterm/BORROWER-PRICING-LANGUAGE.md`, and its worked
 * examples are this module's test fixtures — so the document and the strings
 * cannot drift. A term sheet goes to a borrower, so every rule there applies
 * here whether the words land on a screen or on paper: a document is not a more
 * technical document because it is a document.
 *
 * The owner's calibration, in their own words: *"they're not going to understand
 * the professional PPE language, 101, 102, 99 … it needs to be more friendly …
 * but we don't want to overwhelm it, to make it too friendly and too much,
 * because at the end of the day our borrowers are experienced investors and we
 * don't want to babysit them."* So: name the thing, give the dollars, say what
 * it costs or pays, stop. No exclamation marks, no tutorials, no reassurance.
 *
 * THE FIVE RULES THIS MODULE ENFORCES
 *   R1 every points figure is followed by its dollars, in the same breath.
 *   R2 the DIRECTION of the money is a verb — "You pay" / "You receive" — never
 *      a bare signed number and never colour alone (a page is printed in black).
 *   R3 NEVER print a price. 101.750 is a wholesale price with no meaning to a
 *      borrower, and teaching them one is the babysitting the owner ruled out.
 *   R4 money to the nearest dollar; rates and points to a thousandth (that is
 *      how a rate sheet quotes and an experienced investor will check them). A
 *      FIXED FEE is exact — $1,595 is not an estimate.
 *   R5 say what is an estimate ONCE, where it is.
 *
 * PURE: no database, no network, no requires.
 */

const nn = (v) => Number.isFinite(v);

/** Whole dollars, grouped. R4. `null` renders as an em dash, never as $0. */
function money(v) {
  if (!nn(v)) return '—';
  const n = Math.round(Math.abs(v));
  const s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-$' : '$') + s;
}

/** A fixed fee, to the cent when it has one. R4's exception. */
function moneyExact(v) {
  if (!nn(v)) return '—';
  const neg = v < 0;
  const a = Math.abs(v);
  const whole = Math.floor(a);
  const cents = Math.round((a - whole) * 100);
  const s = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + s + (cents ? '.' + String(cents).padStart(2, '0') : '');
}

/** Points, to a thousandth, unsigned — the direction is carried by a verb. R2. */
function points(v) {
  if (!nn(v)) return '—';
  return Math.abs(v).toFixed(3);
}

/** A note rate, as a rate sheet quotes it. */
function rate(v) {
  if (!nn(v)) return '—';
  return `${Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** A percentage to one decimal, trailing zero trimmed (an LTV, a down payment). */
function pct(v) {
  if (!nn(v)) return '—';
  return `${(Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '')}%`;
}

/**
 * What this option costs or pays AT CLOSING for the RATE alone — the buydown or
 * the credit, never the fees.
 *
 * `{kind:'pay'|'receive'|'none', dollars, points, text}`; `text` obeys R1 and R2
 * in one phrase. "No points either way" is the honest reading of par — never
 * "par", which is a wholesale word (R3).
 */
function costOrCredit(charges) {
  if (!charges || typeof charges !== 'object') return { kind: 'none', dollars: null, points: null, text: '—' };
  const buy = (charges.lines || []).find((l) => l && l.key === 'buydown');
  if (buy && nn(buy.dollars) && buy.dollars > 0) {
    return { kind: 'pay', dollars: buy.dollars, points: buy.points,
      text: `You pay ${money(buy.dollars)}${nn(buy.points) ? ` (${points(buy.points)} pts)` : ''}` };
  }
  const cr = charges.credit;
  if (cr && nn(cr.dollars) && cr.dollars > 0) {
    return { kind: 'receive', dollars: cr.dollars, points: cr.points,
      text: `You receive ${money(cr.dollars)}${nn(cr.points) ? ` (${points(cr.points)} pts)` : ''}` };
  }
  return { kind: 'none', dollars: 0, points: 0, text: 'No points either way' };
}

/** "67 months (5 years 7 months)" — both, because one answers a different question. */
function monthsWords(m) {
  if (!nn(m) || m <= 0) return null;
  const whole = Math.round(m);
  const y = Math.floor(whole / 12);
  const mo = whole % 12;
  const parts = [];
  if (y) parts.push(`${y} year${y === 1 ? '' : 's'}`);
  if (mo) parts.push(`${mo} month${mo === 1 ? '' : 's'}`);
  const inner = parts.length ? parts.join(' ') : 'under a month';
  return `${whole} month${whole === 1 ? '' : 's'} (${inner})`;
}

/**
 * ONE sentence per comparison row — never two.
 *
 * The two readings are the Investor Suite tool's own, and they are opposites:
 * money put up today has to be HELD long enough to earn back; money taken today
 * is only ahead until the dearer rate eats it. Getting them the wrong way round
 * tells a borrower to hold a loan they should refinance.
 */
function breakEvenSentence(row, member) {
  if (!row || row.isAnchor) return null;
  const label = (member && member.label) || 'This option';
  const w = monthsWords(row.breakEvenMonths);
  const dCost = row.deltaCostDollars;
  const dMonthly = row.deltaMonthlyDollars;
  if (!nn(dCost) || !nn(dMonthly)) return null;

  if (!w) {
    // No break-even exists. Say which way it goes rather than going silent — a
    // row with no sentence reads as a row nobody checked.
    if (dCost > 0 && dMonthly >= 0) {
      return `${label} costs ${money(dCost)} more at closing and ${money(dMonthly)} more a month. It does not pay back.`;
    }
    if (dCost < 0 && dMonthly <= 0) {
      return `${label} pays you ${money(-dCost)} at closing and costs ${money(-dMonthly)} less a month.`;
    }
    return null;
  }
  if (dCost > 0) {
    return `${label} costs ${money(dCost)} today and saves ${money(-dMonthly)} a month. You are ahead after ${w}. `
      + 'If you expect to sell or refinance before then, it costs you money.';
  }
  return `${label} pays you ${money(-dCost)} today and costs ${money(dMonthly)} a month. `
    + `You stay ahead until month ${Math.round(row.breakEvenMonths)} — ${w.replace(/^\d+ months? \(/, '').replace(/\)$/, '')}. `
    + 'Past that, the higher rate has eaten the credit.';
}

/**
 * Workflow B's sentence: the cash freed up, what it costs a month, and what that
 * works out to a year on the extra borrowing — the number that makes the choice
 * actionable against the borrower's own next deal.
 */
function incrementalSentence(row, member, anchor) {
  if (!row || row.isAnchor) return null;
  const label = (member && member.label) || 'This option';
  const dLoan = row.deltaLoanDollars;
  const dMonthly = row.deltaMonthlyDollars;
  if (!nn(dLoan) || !nn(dMonthly) || dLoan === 0) return null;
  if (dLoan > 0) {
    const bits = [`${label} keeps ${money(dLoan)} in your pocket and costs ${money(dMonthly)} a month more.`];
    if (nn(row.incrementalCostPct)) {
      bits.push(`That extra ${money(dLoan)} of borrowing is costing you about ${pct(row.incrementalCostPct)} a year `
        + '— compare that against what it earns in your next deal.');
    }
    const a = anchor && anchor.dscr;
    const b = member && member.dscr;
    if (nn(a) && nn(b) && Math.abs(a - b) >= 0.005) {
      bits.push(`Your DSCR moves from ${a.toFixed(2)} to ${b.toFixed(2)}.`);
    }
    return bits.join(' ');
  }
  return `${label} borrows ${money(-dLoan)} less and costs ${money(-dMonthly)} a month less.`;
}

/**
 * A prepayment term in a sentence. NEVER the vendor's token — `54321`, `5433`,
 * `6MosInt` and `StepDown` are wire values.
 *
 * ⛔ IT NEVER GUESSES. A structure this table does not carry falls back to the
 * plain term ("5-year prepayment"), which is true, rather than describing a
 * schedule we did not verify. What is offered here is settled by
 * `docs/longterm/PREPAY-PENALTY-MAPPING.md`; until that lands, an officer's
 * sheet says the term and no more.
 */
const PREPAY_SENTENCES = {
  '54321': ['5-year step-down', '5% in year 1, then 4%, 3%, 2%, 1%'],
  '54333': ['5-year step-down', '5%, 4%, then 3% for years 3–5'],
  '5433': ['4-year step-down', '5%, 4%, then 3% for years 3–4'],
  '5432': ['4-year step-down', '5%, 4%, 3%, 2%'],
  '4321': ['4-year step-down', '4% in year 1, then 3%, 2%, 1%'],
  '543': ['3-year step-down', '5% in year 1, then 4%, 3%'],
  '321': ['3-year step-down', '3% in year 1, then 2%, 1%'],
  '54': ['2-year step-down', '5% in year 1, then 4%'],
  '21': ['2-year step-down', '2% in year 1, then 1%'],
  Fixed5: ['5% fixed', '5% of the balance if you pay off during the term'],
  Fixed4: ['4% fixed', '4% of the balance if you pay off during the term'],
  Fixed3: ['3% fixed', '3% of the balance if you pay off during the term'],
  Fixed2: ['2% fixed', '2% of the balance if you pay off during the term'],
  Fixed1: ['1% fixed', '1% of the balance if you pay off during the term'],
  '6MosInt': ["Six months' interest", "six months' interest if you pay off during the term"],
};

function prepaySentence(months, structure) {
  const m = nn(months) ? Math.round(months) : null;
  if (m === 0) return 'No prepayment penalty';
  const known = structure != null && PREPAY_SENTENCES[String(structure)];
  const years = m != null && m % 12 === 0 ? m / 12 : null;
  const term = m == null ? null
    : years != null ? `${years}-year prepayment`
      : `${m}-month prepayment`;
  if (known) {
    const [name, detail] = known;
    return term ? `${name} — ${detail}` : `${name} — ${detail}`;
  }
  return term || null;
}

/** Fixed strings. One place, so every surface says them identically. */
const DISCLOSURE = 'Pricing is indicative and subject to change until locked. This is not a commitment to lend.';
const THIRD_PARTY = 'Third-party costs — title, escrow, recording, appraisal — are not included.';

/** The fee list's labels, borrower-side. The engine's own keys are internal. */
const CHARGE_LABELS = {
  origination: 'Origination fee',
  buydown: 'Cost to get this rate',
  applicationFee: 'Application fee',
  commitmentFee: 'Commitment fee',
};

/** One charge line, ready to print: `["Cost to get this rate (1.250 points)", "$4,688"]`. */
function chargeRow(line) {
  if (!line || typeof line !== 'object') return null;
  const base = CHARGE_LABELS[line.key] || line.label || line.key || '';
  const withPoints = nn(line.points) && line.points > 0 ? `${base} (${points(line.points)} points)` : base;
  return [withPoints, moneyExact(line.dollars)];
}

module.exports = {
  money, moneyExact, points, rate, pct,
  costOrCredit, monthsWords, breakEvenSentence, incrementalSentence,
  prepaySentence, chargeRow,
  DISCLOSURE, THIRD_PARTY, CHARGE_LABELS, PREPAY_SENTENCES,
};
