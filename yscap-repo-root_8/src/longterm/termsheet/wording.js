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

/* ──────────────────────────────────────────────────────────────────────────
   R6 — A DATE IS WRITTEN THE WAY A PERSON WRITES ONE.

   Owner-reported 2026-08-31: *"all three sheets are very ugly and very abrupt.
   It needs to be done a lot more cleanly, more user-friendly, and more
   modern."* The single most machine-like thing on the paper was the date:
   every page carried `Issued 2026-08-31T14:00:00.000Z` in the header band and
   again in the footer, and the expiry callout — the one line whose whole job is
   urgency — read *"Good through 2026-09-01T14:00:00.000Z."* That is a database
   value printed at a borrower.

   ⛔ THE ZONE IS OURS AND IT IS NAMED. An expiry is an INSTANT, so rendering it
   without a zone is not a formatting choice: a 24-hour window stamped at 14:00Z
   reads as 2:00 PM to a borrower whose day ends at 10:00 AM local. It is
   rendered in the company's own zone — the one the desk works in — and the zone
   is printed, so the deadline can be acted on rather than interpreted.

   ⛔ NOTHING IS EVER GUESSED. An absent or unreadable value answers `null` and
   the caller drops the line. It must never fall back to echoing the raw string,
   which is the bug, nor to "Invalid Date", which is worse.
   ────────────────────────────────────────────────────────────────────────── */

/** The company's own zone. A date on this paper is a New Jersey date. */
const ZONE = 'America/New_York';

/**
 * An ISO 8601 timestamp that STATES ITS OFFSET — `…Z` or `…+05:00`.
 *
 * ⛔ THAT IS THE ONLY THING WE MAY RE-CLOCK, and the reason is a silent-wrong-
 * answer, not pedantry. `2026-08-31` and `August 31, 2026 9:14 AM` carry no
 * zone: JavaScript resolves the first to UTC midnight (which renders as the 30th
 * in every US zone) and the second to whatever the server's clock happens to be
 * set to. Re-printing either in New York would move a date somebody wrote by
 * hours, on a document about a deadline. So a value with no offset is left
 * EXACTLY as it was given — it is already a human string — and only a real
 * instant is rendered in words.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function parseInstant(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const raw = String(v).trim();
  if (!ISO_INSTANT.test(raw)) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** What to print when the value is not an instant we may re-clock: the value
 *  itself when there is one to print, else nothing. */
function asGiven(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  return raw || null;
}

function fmt(d, opts) {
  // A build without the zone's data must not lose the date entirely: it falls
  // back to UTC, still in words, still unambiguous because the zone is printed.
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: ZONE, ...opts }).format(d);
  } catch {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(d);
    } catch { return null; }
  }
}

/** "August 31, 2026" — for a stamp, where the hour says nothing. */
function dateLong(v) {
  const d = parseInstant(v);
  if (!d) return asGiven(v);
  return fmt(d, { month: 'long', day: 'numeric', year: 'numeric' }) || asGiven(v);
}

/** "September 1, 2026 at 10:00 AM EDT" — for a DEADLINE, where it says everything. */
function dateTimeLong(v) {
  const d = parseInstant(v);
  if (!d) return asGiven(v);
  const day = fmt(d, { month: 'long', day: 'numeric', year: 'numeric' });
  const time = fmt(d, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  if (!day) return asGiven(v);
  return time ? `${day} at ${time}` : day;
}

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

/**
 * THE WHOLE CLOSING POSITION — every lender charge on the sheet, net of any
 * credit. This is what `charges.netDollars` already is; what this adds is the
 * VERB and the wording, so the figure can be a headline.
 *
 * ⛔ THIS EXISTS BECAUSE A LABEL LIED, AND THE OWNER CAUGHT IT ON A RENDERED
 * SHEET. Owner-reported 2026-08-30, quoting their own document verbatim:
 *
 *     At closing                       No points either way
 *     Origination fee (2.000 points)   $7,500
 *
 * *"It says 'no point either way', and then it says 'origination fees'. It needs
 * to understand the logic."* Both lines were arithmetically correct and the
 * document was still wrong: `costOrCredit` answers ONE question — what the RATE
 * costs or pays, the buydown or the credit — and it was printed under a label
 * ("At closing") that promises the answer to a DIFFERENT and much bigger one.
 * At par the rate costs nothing, so the sheet announced "no points either way"
 * directly above $7,500 of points.
 *
 * ⛔ THE CLASS, and it is worth more than the fix: a figure is only ever as true
 * as its label. When a value answers a narrower question than its label implies,
 * the value is right and the DOCUMENT is wrong — and no test that checks
 * arithmetic can see it. Narrow the label ("Cost to get this rate") and give the
 * broad label its own real figure; never leave one standing in for the other.
 */
function closingPosition(charges) {
  if (!charges || typeof charges !== 'object' || !nn(charges.netDollars)) {
    return { kind: 'none', dollars: null, text: '—' };
  }
  const net = charges.netDollars;
  if (net > 0.005) return { kind: 'pay', dollars: net, text: `You pay ${money(net)}` };
  if (net < -0.005) return { kind: 'receive', dollars: -net, text: `You receive ${money(-net)}` };
  return { kind: 'none', dollars: 0, text: 'Nothing either way' };
}

/**
 * THE MONTHLY HOUSING COST, and whether it is a real PITI.
 *
 * ⛔ NEVER A PARTIAL PITI. Owner-directed 2026-08-30: *"only if the taxes and
 * insurance were entered in the scenario … only if the principal, interest,
 * tax, and insurance were entered, the monthly tax, and monthly insurance."*
 * With a tax figure and no insurance figure the sum is NOT the borrower's
 * monthly cost — it is a number that looks like one and is short by an insurance
 * premium, which is exactly the shape of an under-quote somebody acts on. So the
 * total is `complete: false` and the caller prints the parts and no total.
 *
 * HOA is DIFFERENT and is deliberately not required: most properties have none,
 * and "no association dues" is a fact, not a missing figure. It is added when it
 * is there and contributes nothing when it is not.
 */
function housingCost({ monthlyPI, taxMonthly, insuranceMonthly, hoaMonthly } = {}) {
  const pi = nn(monthlyPI) ? monthlyPI : null;
  const tax = nn(taxMonthly) ? taxMonthly : null;
  const ins = nn(insuranceMonthly) ? insuranceMonthly : null;
  const hoa = nn(hoaMonthly) ? hoaMonthly : 0;
  const complete = pi != null && tax != null && ins != null;
  return {
    complete,
    monthlyPI: pi, taxMonthly: tax, insuranceMonthly: ins,
    hoaMonthly: nn(hoaMonthly) ? hoaMonthly : null,
    total: complete ? Math.round((pi + tax + ins + hoa) * 100) / 100 : null,
    label: hoa > 0
      ? 'Total monthly payment (principal, interest, taxes, insurance & dues)'
      : 'Total monthly payment (principal, interest, taxes & insurance)',
  };
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
function breakEvenSentence(row, member, anchor) {
  if (!row || row.isAnchor) return null;
  const label = (member && member.label) || 'This option';
  // ⛔ EVERY FIGURE IN THIS SENTENCE IS A DIFFERENCE, SO IT SAYS SO AND NAMES
  // WHAT IT IS A DIFFERENCE FROM.
  //
  // It used to read "costs $8,438 today", which is true and reads as absolute.
  // On the documented ladder that was harmless — the anchor was at par, so each
  // option's own cost happened to EQUAL its difference from the anchor. The
  // owner's three offers break that: borrower-paid beside lender-paid on one
  // sheet, where the table says "You receive $1,655" one line above and the
  // sentence said "pays you $11,250 today". Both figures were right and they
  // answer different questions, and nothing on the page said which was which.
  // Found by reading a rendered sample, not by reading this function.
  const against = (anchor && anchor.label) ? ` than ${anchor.label}` : ' than the option above';
  const w = monthsWords(row.breakEvenMonths);
  const dCost = row.deltaCostDollars;
  const dMonthly = row.deltaMonthlyDollars;
  if (!nn(dCost) || !nn(dMonthly)) return null;

  if (!w) {
    // No break-even exists. Say which way it goes rather than going silent — a
    // row with no sentence reads as a row nobody checked.
    if (dCost > 0 && dMonthly >= 0) {
      return `${label} costs ${money(dCost)} more at closing${against} and ${money(dMonthly)} more a month. It does not pay back.`;
    }
    if (dCost < 0 && dMonthly <= 0) {
      return `${label} costs ${money(-dCost)} less at closing${against} and ${money(-dMonthly)} less a month.`;
    }
    return null;
  }
  /* ⛔ "AHEAD" IS EXPLAINED, IN BOTH DIRECTIONS, BECAUSE IT IS THE WHOLE POINT
     OF THE SENTENCE (owner-directed 2026-08-31: *"you need to explain a little
     bit more what your head means, and the same thing for the opposite of your
     head."*). The old wording named the month and left the reader to work out
     what happened at it. A break-even is one idea said two ways — money paid
     today against money saved monthly — and which side of it a borrower lands
     on is decided by something only they know: how long they intend to hold the
     loan. So each sentence says what the month MEANS, and then says what happens
     on the other side of it, in the borrower's own terms (selling, refinancing,
     holding on). */
  if (dCost > 0) {
    return `${label} costs ${money(dCost)} more at closing${against} and saves ${money(-dMonthly)} a month. `
      + `The monthly saving pays that back after ${w} — from then on you are ahead, `
      + `and every month after that is ${money(-dMonthly)} you keep. `
      + 'Sell or refinance before then and you do not get it back: you would have paid the '
      + `${money(dCost)} and collected only part of the saving.`;
  }
  return `${label} costs ${money(-dCost)} less at closing${against} and ${money(dMonthly)} more a month. `
    + `You keep the ${money(-dCost)} today, and the higher payment eats it back over ${w}. `
    + 'Pay this loan off before then and you are ahead; hold it longer and the cheaper closing '
    + 'has cost you more than it saved.';
}

/**
 * Workflow B's sentence: the cash freed up, what it costs a month, and what that
 * works out to a year on the extra borrowing — the number that makes the choice
 * actionable against the borrower's own next deal.
 */
function incrementalSentence(row, member, anchor, shownDscr) {
  if (!row || row.isAnchor) return null;
  const label = (member && member.label) || 'This option';
  const dLoan = row.deltaLoanDollars;
  const dMonthly = row.deltaMonthlyDollars;
  if (!nn(dLoan) || !nn(dMonthly) || dLoan === 0) return null;

  /* ⛔ THE DSCR THIS SENTENCE QUOTES IS THE ONE THE PAGE PRINTS, AND IT IS
     HANDED IN RATHER THAN READ OFF THE MEMBER. Found by rendering, not by
     reading: the table derives the ratio from the total payment it prints
     beside it (`layout.shownDscr`), while this sentence read `member.dscr` —
     the single figure the board priced on. MEASURED on a real scenario sheet,
     the same page said `DSCR 1.09` in the column and *"moves from 1.24 to
     1.15"* in the sentence directly beneath it. Both were honestly computed and
     one of them had to go, because a reader can divide the two numbers printed
     above and only one answer matches.

     A caller that hands in nothing falls back to the member's own figure, which
     is what a page with no printed total shows anyway — so the two can still
     never disagree. */
  const ds = shownDscr || {};
  const a = nn(ds.anchor) ? ds.anchor : (anchor && anchor.dscr);
  const b = nn(ds.member) ? ds.member : (member && member.dscr);
  const dscrBit = (nn(a) && nn(b) && Math.abs(a - b) >= 0.005)
    ? `Your DSCR moves from ${a.toFixed(2)} to ${b.toFixed(2)}.` : null;

  if (dLoan > 0) {
    const bits = [`${label} keeps ${money(dLoan)} in your pocket and costs ${money(dMonthly)} a month more.`];
    if (nn(row.incrementalCostPct)) {
      bits.push(`That extra ${money(dLoan)} of borrowing is costing you about ${pct(row.incrementalCostPct)} a year `
        + '— compare that against what it earns in your next deal.');
    }
    if (dscrBit) bits.push(dscrBit);
    return bits.join(' ');
  }

  /* ⛔ THE SMALLER OPTION GETS THE SAME NUMBER, SAID FROM THE OTHER SIDE. The
     cost of the extra borrowing is a fact about the GAP between two options, so
     it is equally true of both of them; it was simply unstated on whichever one
     happened to borrow less than the officer's chosen anchor, which left the
     reader with a dash on a row and no way to ask the question the row exists to
     answer. It is the same arithmetic with the two loans swapped — never a
     second formula — so the two rows can never disagree about one gap. */
  const bits = [`${label} borrows ${money(-dLoan)} less and costs ${money(-dMonthly)} a month less.`];
  if (nn(row.incrementalCostPct)) {
    bits.push(`Going the other way — taking that extra ${money(-dLoan)} — would cost you about `
      + `${pct(row.incrementalCostPct)} a year on it.`);
  }
  if (dscrBit) bits.push(dscrBit);
  return bits.join(' ');
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

/**
 * THE PROPERTY, IN ENGLISH — the vendor's enum is not a word for a client.
 *
 * Owner-reported 2026-08-31, off a REAL export: the sheet printed
 * `Property type  SingleFamily`. That is Lender Price's wire value, carried
 * verbatim from `lenderprice/field-registry.js` through the scenario onto a
 * document that goes to a borrower for signature. Every fixture in every suite
 * had been written with a human spelling ("Single family"), so nothing ever saw
 * it — the defect lived exactly in the gap between our test data and the real
 * board's vocabulary.
 *
 * ⛔ IT NEVER GUESSES. An enum this table does not carry is passed through
 * UNCHANGED rather than prettified by a regex: a vendor word a reader can look
 * up is recoverable, and a wrong one invented by splitting on capitals is not
 * ("CondoTel" is a condo-hotel, not "Condo Tel"). A value that is already a
 * human spelling passes through for the same reason.
 *
 * The keys are the vendor's `propertyType` OUTPUTS — what actually lands on the
 * scenario — not the input aliases that resolve to them.
 */
const PROPERTY_TYPE_WORDS = {
  SingleFamily: 'Single family',
  PlannedUnitDevelopment: 'Planned unit development (PUD)',
  UnitDwelling_2_4: '2-4 unit',
  Modular: 'Modular home',
  Townhouse: 'Townhouse',
  Condos: 'Condominium',
  DetachedCondominium: 'Detached condominium',
  HighRiseCondo: 'High-rise condominium',
  MidRiseCondo: 'Mid-rise condominium',
  SiteCondo: 'Site condominium',
  CondoGarden: 'Garden condominium',
  CondoTel: 'Condo-hotel',
  Cooperative: 'Co-op',
  MultiFamily: 'Multifamily',
  ManufacturedHousing: 'Manufactured home',
  ManufacturedHousingSingleWide: 'Manufactured home (single-wide)',
  ManufacturedHousingDoubleWide: 'Manufactured home (double-wide)',
};

function propertyTypeWords(raw) {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return null;
  return PROPERTY_TYPE_WORDS[v] || v;
}

/** The fee list's labels, borrower-side. The engine's own keys are internal. */
const CHARGE_LABELS = {
  origination: 'Origination fee',
  buydown: 'Cost to get this rate',
  applicationFee: 'Application fee',
  commitmentFee: 'Commitment fee',
};

/** The lender's OWN fees — the two the waive switch turns off. Named here so a
 *  sheet can group and total them without a screen re-deciding what counts as
 *  one; add a fee to the plan and it belongs on this list in the same commit. */
const LENDER_FEE_KEYS = ['applicationFee', 'commitmentFee'];

/**
 * One charge line, ready to print: `["Cost to get this rate", "$4,688", {note}]`.
 *
 * ⛔ A POINTS FIGURE IS BROKEN DOWN, NOT ASSERTED. Owner-directed 2026-08-30:
 * *"for the ones that are actually paying the origination fee, you also need to
 * break down the origination fee they're paying."* The points and the dollars
 * used to be crushed into the label — "Origination fee (2.000 points) $7,500" —
 * which states two numbers and shows no arithmetic, so a reader who wants to
 * check it has to know the loan amount, find it elsewhere on the sheet and
 * multiply. The basis now rides underneath in words: *2.000 points of the
 * $375,000 loan amount.* Same figures; the reader can verify them.
 *
 * ⛔ A WAIVED FEE PRINTS ITS OWN SAVING. It is on the sheet at $0 with what it
 * would have been said out loud, because the option beside it is charging that
 * exact amount and the difference IS the offer.
 */
function chargeRow(line) {
  if (!line || typeof line !== 'object') return null;
  const label = CHARGE_LABELS[line.key] || line.label || line.key || '';
  if (line.waived === true) {
    return [label, 'Waived', {
      credit: true,
      note: nn(line.fullDollars) && line.fullDollars > 0
        ? `${moneyExact(line.fullDollars)} — covered by the lender, not paid by you`
        : null,
    }];
  }
  const note = nn(line.points) && line.points > 0 && nn(line.basis) && line.basis > 0
    ? `${points(line.points)} points of the ${money(line.basis)} loan amount`
    : (nn(line.points) && line.points > 0 ? `${points(line.points)} points` : null);
  return [label, moneyExact(line.dollars), { note }];
}

/**
 * THE LENDER'S OWN FEES ARE ONE PACKAGE, NOT TWO LINES (owner-directed
 * 2026-09-01, REVERSING the 2026-08-30 "listed one by one, never as a lump").
 *
 * The earlier rule existed to answer *"which of these fees is this option
 * actually charging?"* — a real question when the two could move independently.
 * The owner has now stated that they cannot: *"They are identical … it's one
 * package. You waive lender fees, so it's zero lender fee, and they don't
 * charge the $2,095. You have the $2,095, so it can be in one box."* Both are
 * flat company-wide amounts (application $1,595 + commitment $500) and the
 * waive switch turns BOTH off together, so a per-fee row was answering a
 * question the data cannot ask: two cells that are the same on every option,
 * every time, which is the repetition the shared box exists to remove.
 *
 * ⛔ SO THE BREAKDOWN IS KEPT, NOT DROPPED. The total is the figure a reader
 * compares; the two named amounts are what makes it checkable. Combining the
 * rows without carrying the parts would trade one problem for the older one
 * this file already warns about — an amount folded into a total and named
 * nowhere.
 *
 * ⛔ AND A HALF-WAIVED PACKAGE IS REPORTED HONESTLY RATHER THAN ASSUMED AWAY.
 * The owner says it never happens, and the waive switch agrees. But "never
 * happens" is a statement about today's switch, not a property of the data, and
 * both of the tidy answers would be WRONG if it ever did: "$2,095" would charge
 * for a fee that was waived, and "Waived ($2,095)" would waive one that is
 * being charged. `partial` says so, and the caller prints what is actually
 * charged with the parts named.
 */
function lenderFeePackage(charges) {
  const lines = (charges && charges.lines) || [];
  const fees = LENDER_FEE_KEYS.map((k) => lines.find((l) => l && l.key === k)).filter(Boolean);
  if (!fees.length) return { present: false };
  const full = (l) => (nn(l.fullDollars) ? l.fullDollars : (nn(l.dollars) ? l.dollars : 0));
  const total = fees.reduce((s, l) => s + full(l), 0);
  const charged = fees.reduce((s, l) => s + (l.waived === true ? 0 : (nn(l.dollars) ? l.dollars : 0)), 0);
  const waivedCount = fees.filter((l) => l.waived === true).length;
  const waived = waivedCount === fees.length;
  const partial = waivedCount > 0 && !waived;
  // Each part, named with its own amount — and a part that is waived says so,
  // which is the only thing that makes the half-waived case readable.
  const parts = fees.map((l) => {
    const label = CHARGE_LABELS[l.key] || l.label || l.key || '';
    if (l.waived === true) return `${label} waived (${moneyExact(full(l))})`;
    return `${label} ${moneyExact(nn(l.dollars) ? l.dollars : full(l))}`;
  });
  /* ⛔ THE CELL SAYS ONE THING AND THE LINE UNDER IT SAYS THE REST (owner-directed
     2026-09-01): *"it says 'Waived' and is circled around 2,095, which would just
     say 'Waived' … it should just say, in small on the bottom … you saved on this
     one 2,095 instead of just circled around, because it's not clear to
     understand."* A parenthetical inside the figure had to carry two facts at
     once — that nothing is charged, and what that is worth — and read as neither.
     So the figure is the figure, and the amount rides underneath in the same
     small line the charged column uses for its breakdown. */
  let text;
  if (waived) text = 'Waived';
  else if (partial) text = moneyExact(charged);
  else text = moneyExact(total);
  // WHAT THE PACKAGE IS MADE OF, at face value and without a word about who is
  // paying it. This is the line that rides under the label, where the columns
  // beside it already say per option whether it is charged or waived — so a
  // composition that repeated the waiver would contradict the column next to it.
  const composition = fees
    .map((l) => `${CHARGE_LABELS[l.key] || l.label || l.key || ''} ${moneyExact(full(l))}`)
    .join('  \u00b7  ');
  // What rides UNDER this option's own figure. The waived column states what the
  // waiver is worth — the figure above it no longer can — and every other column
  // states what its total is made of.
  const cellNote = waived
    ? (total > 0 ? `You save ${moneyExact(total)}` : null)
    // A half-waived package states which half, at face value — the composition
    // alone would name two amounts while the figure above it charged for one.
    : (partial ? parts.join('  \u00b7  ') : composition);
  return {
    present: true,
    total,
    charged,
    cellNote,
    waived,
    partial,
    parts,
    text,
    composition,
    breakdown: parts.join('  \u00b7  '),
  };
}

module.exports = {
  money, moneyExact, points, rate, pct,
  costOrCredit, closingPosition, housingCost,
  monthsWords, breakEvenSentence, incrementalSentence,
  prepaySentence, chargeRow, lenderFeePackage, dateLong, dateTimeLong, ZONE,
  DISCLOSURE, THIRD_PARTY, CHARGE_LABELS, LENDER_FEE_KEYS, PREPAY_SENTENCES,
  propertyTypeWords, PROPERTY_TYPE_WORDS,
};
