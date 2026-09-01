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

/**
 * ⛔ THE SOFT-BREAK THRESHOLDS ARE CALIBRATED AGAINST THE TYPE SCALE, AND GO
 * STALE THE MOMENT IT MOVES.
 *
 * A soft break says *"start the next group on a fresh page if less than this
 * many points are left"*. Each number is a MEASUREMENT of how tall the group it
 * protects actually is, so it is only correct for the type it was measured at —
 * and when the sheet was re-set to the approved design (`pdf.js` `SZ`, roughly
 * a quarter smaller) all three became too LARGE, which is the failure that
 * costs a page: a group that now fits comfortably is pushed to the next sheet
 * and the reader is left looking at four inches of nothing.
 *
 * These were re-measured on real renders at the current scale, not scaled
 * arithmetically. **Re-measure them if `SZ` moves again** — `scripts/
 * test-lt-termsheet-render.mjs` reports the unused space at the foot of every
 * page for exactly this reason, so a stale threshold shows up as a page that
 * ends early with content still to come.
 */
/**
 * ⛔ THE WAIVED-FEE NOTE CARRIES NO POSITIONAL WORD, AND THAT IS DELIBERATE.
 * It read *"your cash to close BELOW already reflects that"*, which was true of
 * a page that ran down one column and false the moment the closing figures moved
 * into a column beside it. A sentence that describes where a figure sits on the
 * paper is a sentence that goes wrong every time the paper is re-set; this one
 * describes the figure instead, so it is true in either arrangement.
 */
const FEES_COVERED = 'The lender fees on this option are covered rather than charged to you. '
  + 'Your cash to close already reflects that.';

const SOFT_BREAK = {
  costStory: 150,    // origination + lender fees + what lands at the table
  comparison: 225,   // the options table, which must be seen in one view
  disclosures: 180,  // the disclosures block
  acceptance: 117,   // the acceptance heading, its sentence and its signature rows (RE-MEASURED 116.2 at the sketch's type)
};

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
  // The vendor's enum is not a word for a client (`SingleFamily`).
  const ptWords = wording.propertyTypeWords(s.propertyType);
  if (ptWords) bits.push(ptWords);
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
    out.push({ t: 'pagebreak', ifLessThan: SOFT_BREAK.costStory });
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
    out.push({ t: 'para', small: true, text: FEES_COVERED });
  }
  if (closing.length) {
    out.push({ t: 'subhead', text: 'At closing' });
    out.push({ t: 'figures', rows: closing });
  }
  out.push({ t: 'para', small: true, text: wording.THIRD_PARTY });
  return out;
}

/**
 * ⛔ A BLOCK CAN NOW CONTAIN BLOCKS, SO EVERY WALKER OF THE LIST COMES THROUGH
 * HERE.
 *
 * `{t:'columns'}` holds two stacks of ordinary blocks. Anything that scanned the
 * list for, say, every `figures` row — three separate places in the suites did
 * exactly that — goes BLIND the moment a row moves inside one, and goes blind
 * SILENTLY: the filter still returns rows, just not those ones, so a guard
 * reports a clean page while the fact it was written to protect has quietly
 * stopped being checked. That is the most expensive kind of test failure there
 * is, because it looks like a pass.
 *
 * So there is ONE flattener, exported, and the container type is handled in one
 * place rather than in each caller. Reading order is preserved — the children
 * appear where their container was — and the container itself is dropped, so a
 * caller asking "what is on the page" gets exactly the blocks that draw.
 */
function flattenBlocks(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b || typeof b !== 'object') continue;
    if (b.t === 'columns') {
      out.push(...flattenBlocks(b.left), ...flattenBlocks(b.right));
      continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * THE TERM SHEET'S BODY, IN TWO COLUMNS — the approved design's page one.
 *
 * ⛔ IT COMPOSES THE SAME ROW BUILDERS `optionBlocks` DOES, AND NEVER A SECOND
 * SET. `loanRows`, `paymentRows`, `qualifyingRows`, `chargeRows`,
 * `lenderFeeRows` and `closingRows` are the one definition of WHAT a term sheet
 * states; this and `optionBlocks` are two ARRANGEMENTS of them. A second row
 * builder here is how a term sheet comes to state a fact its own comparison
 * does not, so `scripts/test-lt-sheet-nothing-lost-pure.js` proves — against a
 * real built layout — that every label `optionBlocks` would print still reaches
 * the page.
 *
 * ⛔ AND EVERY PAIRING IS A READING ORDER, NOT A SPACE-SAVING. The loan sits
 * beside its own monthly payment because *"what am I borrowing"* and *"what do I
 * pay"* are one question asked twice; what the rate costs sits beside what lands
 * at the table because the second is the first plus the borrower's own money.
 * The design's own rule for a comparison is *"show only what differs"*, and its
 * rule for a single sheet is the same instinct: the whole argument in one view,
 * answered in the first three seconds and rewarding a second, slower reading.
 * MEASURED: this is what takes a term sheet from three sheets to two.
 *
 * ⛔ THE COLUMNS ARE A REQUEST, NOT A GUARANTEE. `pdf.js` falls back to one
 * column whenever the pair could not be drawn safely, and either way is a
 * correct document — which is what makes it safe to ask for.
 */
function termSheetBody(m) {
  const s = m.scenario || {};
  const out = [];

  const piti = paymentRows(m);
  const qual = qualifyingRows(m, piti);

  /* ⛔ THERE IS NO "THE PROPERTY" SECTION, AND THE FACTS ARE NOT LOST — they
     moved to the sub-line under the address, which is where the approved sketch
     puts them: *"Single family · Ocean County · valued at $500,000"*. That is a
     better home for them than a section of their own, and the reason is the
     document's own argument: the property is the SUBJECT, not one of the things
     being decided, so stating it beside its address says it once in the place a
     reader is already looking. `propertyFacts` composes exactly those three
     facts and is now built for a term sheet as well as a comparison. */
  const left = [];
  left.push({ t: 'band', title: 'The loan' }, { t: 'figures', rows: loanRows(m) });

  const right = [];
  if (piti.rows.length) {
    right.push({ t: 'band', title: 'Monthly payment' }, { t: 'figures', rows: piti.rows });
  }
  if (qual.length) right.push({ t: 'figures', rows: qual });

  if (right.length) out.push({ t: 'columns', left, right });
  else out.push(...left);

  // ── what it costs to close ───────────────────────────────────────────────
  const charges = chargeRows(m);
  const fees = lenderFeeRows(m);
  const closing = closingRows(m);
  if (charges.length || fees.rows.length || closing.length) {
    /* The cost story is ONE story and does not split — see `optionBlocks`, whose
       comment records the render on which it split four rows adrift from what
       they belong to. In two columns it is roughly half as tall, which is why
       `SOFT_BREAK.costStory` is measured rather than carried over. */
    out.push({ t: 'pagebreak', ifLessThan: SOFT_BREAK.costStory });
    out.push({ t: 'band', title: 'What it costs to close' });
    const cl = [];
    if (charges.length) cl.push({ t: 'subhead', text: 'What this rate costs' }, { t: 'figures', rows: charges });
    if (fees.rows.length) cl.push({ t: 'subhead', text: 'Lender fees' }, { t: 'figures', rows: fees.rows });
    if (fees.waived) cl.push({ t: 'para', small: true, text: FEES_COVERED });
    const cr = [];
    if (closing.length) cr.push({ t: 'subhead', text: 'At closing' }, { t: 'figures', rows: closing });
    if (cl.length && cr.length) out.push({ t: 'columns', left: cl, right: cr });
    else out.push(...cl, ...cr);
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
  /* ⛔ A COLUMN IS HEADED THE WAY THE APPROVED SKETCH HEADS IT: a small gold
     tracked eyebrow naming the column ("OPTION B"), a grey tag on the one every
     other column is measured against ("THE ANCHOR"), then the option's own name
     in bold over as many lines as it needs. The grey header BAND it replaces
     put a programme name and the parenthetical "(compared against)" into one
     wrapped run of small type, which is the thing the owner read as a
     spreadsheet rather than a document.

     ⛔ THE LETTER IS THE MEMBER'S OWN INDEX, NEVER ITS POSITION ON THE PAGE.
     The anchor is drawn first, so a letter taken from the column position would
     rename every option the moment the anchor changed — and the sentences under
     the table name options by that letter. Members[0] is always A. */
  const noun = snapshot.docKind === DOC_KINDS.SCENARIO ? 'SCENARIO' : 'OPTION';
  const head = ['', ...order.map((i) => {
    const m = members[i];
    /* THE PRODUCT RIDES THE HEAD AS ITS SECOND LINE, exactly as the sketch sets
       it ("Platinum" over "30-Year Fixed") — and only when the officer's own
       label does not already say it, so a column headed "Platinum 30-Year
       Fixed" is never followed by "30-Year Fixed" again. */
    const label = String(m.label || '');
    const product = m.product && !label.toLowerCase().includes(String(m.product).toLowerCase())
      ? m.product : null;
    return {
      eyebrow: `${noun} ${String.fromCharCode(65 + i)}`,
      tag: i === cmp.anchorIndex ? 'THE ANCHOR' : null,
      title: label,
      sub: product,
      /* ⛔ THE COLUMN'S IDENTITY IS A FIELD, NOT ITS PROSE. The head used to be
         one string ("Platinum (compared against)") and everything that needed to
         know which column belonged to which option — including the guards that
         prove the sentences under the table agree with the columns above it —
         read it back out with a regex. Prose is what a designer changes; an
         option's identity is not. */
      label, anchor: i === cmp.anchorIndex, memberIndex: i,
    };
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
  /* ⛔ THE SCENARIO SHEET GROUPS ITS ROWS, AND THE COMPARISON DELIBERATELY DOES
     NOT. The approved sketch splits a scenario's table into what the officer
     MOVED, what that PRODUCED, and what the extra borrowing costs — because on
     a scenario sheet the reader's question is causal, and a flat list of
     thirteen rows does not answer it. A comparison sheet's rows are three
     prices for one loan: there is no cause and effect to separate, and its
     sketch shows one unbroken table. The grouping is therefore keyed on the
     document, never on a hand-kept list of which labels look like inputs. */
  const grouped = snapshot.docKind === DOC_KINDS.SCENARIO;
  const GROUPS = {
    input: { title: 'What you changed', tone: 'gold' },
    produced: { title: 'What it produced', tone: 'teal' },
    compare: { title: 'What the extra borrowing actually costs you', tone: 'teal' },
  };
  const staged = [];
  const push = (label, fn, opts) => {
    const vals = order.map((i) => cell(i, fn));
    if (!vals.some((v) => v != null && v !== '—')) return;
    const filled = vals.map((v) => (v == null ? '—' : v));
    const same = members.length > 1 && filled.every((v) => v === filled[0]);
    /* ⛔ THE COMPARISON ROWS ARE NEVER LIFTED, however identical they look.
       Break-even and the cost of the extra borrowing are answers ABOUT a column
       rather than facts of it, and three equal answers is a coincidence of the
       arithmetic, not a shared term of the loan.

       `Program` USED to be on that list, because it was the only thing naming
       each column. It is not any more: the approved sketch heads every column
       with the option's own name over its product, so an identical programme
       folds into the shared box like any other agreed fact and stops being
       printed three times. */
    if (same && !(opts && opts.never)) { shared.push([label, filled[0]]); return; }
    /* ⛔ A ROW MAY SAY THAT IT RESOLVES THE ARITHMETIC, and the renderer bands it
       in ivory. The approved sketch highlights exactly two rows on a comparison
       — the full monthly payment and the cash to close — because those are the
       two figures a reader is choosing between; everything above them is the
       working. Striping every other row instead (which is what shipped) makes
       the table read as a spreadsheet and gives the two answers no more weight
       than the rent. */
    staged.push({
      group: (opts && opts.group) || 'produced',
      row: opts && opts.accent ? [label, ...filled, { accent: true }] : [label, ...filled],
    });
  };
  /* ⛔ THE ROWS ARE ORDERED BY WHAT THEY ARE, NOT BY THE ORDER THEY WERE
     WRITTEN IN. Both approved sketches read inputs first, then what those
     inputs produced, then the comparison against the anchor — and the pushes
     below interleave the three (the rate is written before the loan amount, the
     tax and insurance split sits in the middle of the payment rows, the rent
     and the credit score at the very end). Sorting here rather than shuffling
     the pushes keeps each row beside the comment that explains it, and makes
     the group headers the scenario sheet draws impossible to interleave — a
     header per flip-flop is worse than no header at all. */
  const emit = () => {
    for (const key of ['input', 'produced', 'compare']) {
      const rows = staged.filter((x) => x.group === key);
      if (!rows.length) continue;
      const g = GROUPS[key];
      if (grouped && g) body.push({ group: g.title, tone: g.tone });
      for (const r of rows) body.push(r.row);
    }
  };
  const pitiOf = pitiFor;
  const sc = (m) => (m && m.scenario) || {};
  push('Program', (m) => m.consumerLabel, { group: 'input' });
  push('Loan purpose', (m) => sc(m).purpose || null, { group: 'input' });
  push('Rate', (m) => wording.rate(m.ratePct));
  push('Loan amount', (m) => (nn(m.loanAmount) ? wording.money(m.loanAmount) : null), { group: 'input' });
  push('LTV', (m) => (nn(m.ltv) ? wording.pct(m.ltv) : null), { group: 'input' });
  push('Term', (m) => (nn(m.termYears) ? `${Math.round(m.termYears)} yr${m.interestOnly ? ' I/O' : ''}` : null), { group: 'input' });
  push('Prepayment', (m) => m.prepayLabel, { group: 'input' });
  push('Escrows', (m) => (sc(m).escrowWaive ? 'Waived — you pay taxes and insurance directly' : null), { group: 'input' });
  push('Principal & interest', (m) => (nn(m.monthlyPI) ? wording.moneyExact(m.monthlyPI) : null));
  /* The three parts of the payment, so the total below can be CHECKED. They are
     properties of the property rather than of the price, so on a same-loan
     comparison all three fold into the shared block and cost the table nothing —
     and on a scenario sheet where one option waives escrows they correctly
     become their own columns. */
  push('Property taxes', (m) => {
    const hc = pitiOf(m);
    return nn(hc.taxMonthly) ? wording.moneyExact(hc.taxMonthly) : null;
  }, { group: 'input' });
  push('Insurance', (m) => {
    const hc = pitiOf(m);
    return nn(hc.insuranceMonthly) ? wording.moneyExact(hc.insuranceMonthly) : null;
  }, { group: 'input' });
  push('Association dues', (m) => {
    const hc = pitiOf(m);
    return nn(hc.hoaMonthly) && hc.hoaMonthly > 0 ? wording.moneyExact(hc.hoaMonthly) : null;
  }, { group: 'input' });
  // ⛔ THE TOTAL PAYMENT COLUMN APPEARS ONLY WHERE IT IS A REAL PITI. A column
  // that carried a total for one option and a dash for the next would invite a
  // comparison between a full payment and a partial one.
  push('Total monthly payment', (m) => {
    const hc = pitiOf(m);
    return hc.complete ? wording.moneyExact(hc.total) : null;
  }, { accent: true });
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
    ? wording.moneyExact(m.closing.cashToCloseDollars) : null), { accent: true });
  // The DSCR's own numerator. Without it the ratio beneath is unverifiable —
  // and a reader who cannot check a figure has to take it on trust.
  push('Monthly rent', (m) => (nn(sc(m).rentMonthly) ? wording.moneyExact(sc(m).rentMonthly) : null), { group: 'input' });
  push('DSCR', (m) => {
    const d = shownDscr(m, pitiOf(m));
    return nn(d.value) ? d.value.toFixed(2) : null;
  });
  /* THE CREDIT SCORE THE PRICE WAS BUILT ON (owner-directed 2026-08-31). It
     reached the snapshot and appeared on no sheet — while `Rate and pricing` in
     the disclosures says in terms that the price moves with "the final verified
     credit score". A document that names a figure as governing and never states
     it leaves the reader unable to tell whether the assumption matches them. */
  push('Credit score used', (m) => (nn(sc(m).fico) ? String(Math.round(sc(m).fico)) : null), { group: 'input' });
  push('Property type', (m) => wording.propertyTypeWords(sc(m).propertyType), { group: 'input' });
  push('Estimated value', (m) => (nn(m.propertyValue) ? wording.money(m.propertyValue) : null), { group: 'input' });
  if (cmp.workflow === 'A') {
    push('Break-even', (m, r) => (r && nn(r.breakEvenMonths) ? wording.monthsWords(r.breakEvenMonths) : null), { never: true, group: 'compare' });
  } else {
    push('Cost of the extra borrowing', (m, r) => (r && nn(r.incrementalCostPct) ? `${wording.pct(r.incrementalCostPct)} a year` : null), { never: true, group: 'compare' });
  }
  emit();
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
  // ⛔ THE ENTITY IS THE ADDRESSEE WHEN THERE IS ONE. It is the party that
  // borrows and the party that signs on the first line, and the person beside it
  // is its guarantor — a distinction the approved sketch makes by setting them
  // on two lines and which "Entity · Person" on one line does not make at all.
  // `preparedForRole` carries the second half, and the two are read together by
  // exactly one place (`pdf.compileRecipient`) so they cannot disagree.
  return entity || person || null;
}

/** The second line of the addressee — who the person beside the entity IS. Null
 *  when there is no entity, because then the person on the line above is the
 *  borrower and calling them a guarantor would name the wrong party on a
 *  document they sign. Kept in step with `signatureParties` by being the same
 *  two fields read the same way. */
function preparedForRole(p) {
  const person = (p && p.borrowerName) || null;
  const entity = (p && p.entityName) || null;
  return (entity && person) ? `${person}, guarantor` : null;
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
  /* ⛔ THE ROLE NEVER LEADS WITH AN EM DASH, because the renderer joins the name
     to it with one — "Oak Street Holdings LLC — borrower and authorized
     signatory", as the approved sketch sets it. A role that carried its own dash
     printed "Oak Street Holdings LLC — Borrower — authorized signatory". */
  if (entity && person) {
    return [
      { role: 'borrower and authorized signatory', name: entity },
      { role: 'guarantor', name: person },
      { role: 'Date' },
      { role: 'Date' },
    ];
  }
  if (entity) return [{ role: 'borrower and authorized signatory', name: entity }, { role: 'Date' }];
  return [{ role: 'borrower and guarantor', name: person }, { role: 'Date' }];
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
    preparedForRole: preparedForRole(p),
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
    // ON EVERY DOCUMENT NOW, term sheet included. It used to be suppressed here
    // because the term sheet carried a section of its own for these three facts;
    // the approved design states them under the address instead, so this is the
    // one place they are printed and suppressing it would genuinely lose them.
    propertyFacts: propertyFacts(s.members || []),
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

  const type = agreed((m) => wording.propertyTypeWords(((m && m.scenario) || {}).propertyType));
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
  /* ⛔ IT IS DRAWN AFTER THE BODY, NOT BEFORE IT — the approved sketch's own
     position, and the reason is the same one that turned it from a panel into a
     sentence: set at the TOP it competes with the headline figures for the eye
     it is not the answer to. The shortest-lived fact on the page belongs at the
     end of the argument it qualifies, immediately above the signature it
     governs. */
  const exp = expiryBlock(s, opts);

  const first = s.members[0];

  // ── the property, and (on a term sheet) the loan ─────────────────────────
  if (isTermSheet) {
    blocks.push(...termSheetBody(first));
  } else {
    const cmp = s.comparison;
    const isScenario = kind === DOC_KINDS.SCENARIO;
    const word = isScenario ? 'scenarios' : 'options';
    /* WHAT IS THE SAME GOES ABOVE THE TABLE, ONCE, AND IS STRUCK FROM IT.
       The table then carries only what the reader is actually choosing between,
       which is the whole job of the page. `comparisonTable` computes the split
       from the printed values, so a term that DIFFERS — a 3-year prepayment
       beside two 5-years — never appears here and always keeps its own row. */
    const table = comparisonTable(s);

    const anchor = s.members[cmp.anchorIndex];
    /* ⛔ WHAT THEY AGREE ABOUT COMES FIRST, AS A GRID — and that reverses a
       decision recorded here, on the strength of the SHAPE rather than the
       order. The shared facts were moved BELOW the table because as a
       fifteen-row list they cost ~260pt and pushed the table's last four rows —
       the cash to close, the DSCR, the answer — onto a second page. The
       approved sketch does not carry a list: it carries a bordered ivory box of
       four-across cells, which states the same fifteen facts in ~150pt. So the
       reason for moving it does not apply to the thing the sketch actually
       draws, and the sketch's own order (agree, then differ) is the order a
       reader wants. Never restore this as a `figures` list above the table. */
    /* ⛔ WHAT THEY DIFFER IN IS SAID INSIDE THE BOX, NOT IN A PARAGRAPH BETWEEN
       THE HEADING AND THE TABLE. As its own line it sat 8pt above the column
       heads and read as part of them — and it is the same sentence the box's
       footnote is already making, from the other side. One place, one reading. */
    const differs = cmp.differs && cmp.differs.length
      ? `They differ in: ${cmp.differs.map(differLabel).join(', ')}.` : '';
    if (table.shared && table.shared.length) {
      blocks.push({ t: 'factgrid',
        title: `Identical in all ${s.members.length} ${word}`,
        note: 'stated once here rather than repeated in every column',
        cells: table.shared,
        footnote: `Anything that differed between the ${word} would leave this box and take its own `
          + `column in the table below.${differs ? ` ${differs}` : ''}` });
    } else if (differs) {
      blocks.push({ t: 'para', small: true, text: differs });
    }
    blocks.push({ t: 'band',
      title: isScenario ? `The ${s.members.length} scenarios` : 'What differs',
      note: `every figure below is compared against ${anchor.label}` });
    blocks.push({ t: 'pagebreak', ifLessThan: SOFT_BREAK.comparison });
    blocks.push(table);
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

  if (exp) blocks.push(exp);

  // ── the acceptance block — TERM SHEET ONLY ───────────────────────────────
  // ⛔ NEVER ON A COMPARISON. A signature under three columns records agreement
  // to nothing in particular, and the one thing a signed page must be is
  // unambiguous about what was signed.
  /* ⛔ THE ACCEPTANCE COMES BEFORE THE DISCLOSURES, which is the approved
     sketch's own order: its page one ends with the expiry and the signature
     lines, and its disclosures are page two.

     ⛔ AND EXACTLY ONE WORD OF THE SENTENCE CHANGED WITH IT — "above" became
     "overleaf" — because moving the block made the old wording FALSE, and a
     false sentence on the line somebody signs is not a layout detail. What the
     signer attests to is untouched: they confirm they have read the term sheet
     INCLUDING the disclosures. The sketch's own acceptance sentence says
     something different again (it adds an authorisation to order third-party
     reports), and that is a legal question rather than a design one, so it is
     NOT adopted here — it is raised with the owner. */
  if (isTermSheet) {
    /* ⛔ THE ACCEPTANCE IS ONE ACT AND DOES NOT SPLIT. A heading and "sign below"
       at the foot of one sheet with the rules on the next is a page nobody can
       sign from, and `keepNext` binds a heading to its first LINE, not to the
       block it introduces. A soft break moves the whole thing when there is not
       enough left of the page and does nothing at all when there is. */
    blocks.push({ t: 'pagebreak', ifLessThan: SOFT_BREAK.acceptance });
    blocks.push({ t: 'band', title: 'Acceptance' });
    blocks.push({ t: 'para',
      text: 'Signing below confirms you have read this term sheet, including the disclosures overleaf, and wish to '
        + 'proceed on these terms. It is not a loan commitment.' });
    /* ⛔ EVERY PARTY KEEPS ITS OWN DATE LINE, and the order is what makes three
       across readable: the parties fill the row, and their dates sit in the row
       beneath, each under the name it belongs to. Two signers sharing one date
       line — which is what a naive "party, date, party" ordering produces once
       it wraps — is a page that cannot record two people signing on two days. */
    const parties = signatureParties(p);
    const signers = parties.filter((l) => l.name);
    const dates = parties.filter((l) => !l.name);
    blocks.push({ t: 'signature', lines: [
      ...signers,
      { role: 'authorized signatory', name: p.companyName || 'YS Capital Group' },
      ...dates,
      { role: 'Date' },
    ] });
  }
  // ── the disclosures ─────────────────────────────────────────────────────
  // A SOFT break: they get their own page when there is not enough left of this
  // one to be worth starting on, and simply continue when there is. A hard break
  // here is what produced a page carrying five rows and ten inches of nothing.
  blocks.push({ t: 'pagebreak', ifLessThan: SOFT_BREAK.disclosures });
  blocks.push({ t: 'band', title: 'Disclosures & conditions' });
  blocks.push({ t: 'para', small: true,
    text: 'The following supplements the terms above and forms part of this document.' });
  blocks.push({ t: 'disclosures', items: disclosureItems(s) });

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
  flattenBlocks,
  buildLayout, optionBlocks, comparisonTable, qualifyingRows, shownDscr, paymentRows, chargeRows, lenderFeeRows,
  closingRows, loanRows, propertyLine, loanLine, disclosureItems, metaBlock, expiryBlock,
  DIFFER_LABELS, PRODUCT_LINE,
  // Exported for the suites only: the headline band's rule, so "a band with one
  // figure is not a band" can be asserted rather than described.
  _internals: { heroCells, propertyFacts },
};
