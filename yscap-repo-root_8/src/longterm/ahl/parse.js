'use strict';
/**
 * LONG-TERM — normalise an American Heritage Lending Quick Pricer answer into
 * the Pricing Engine's common program shape.
 *
 * WHAT AHL RETURNS. Not JSON — a 150 KB server-rendered HTML page. That sounds
 * like the weak vendor of the three and it is not: the page carries MORE than a
 * typical pricing JSON, because it was built to render a screen a human reads.
 * Measured on the captured pages in `capture/`:
 *
 *   • every eligible rate row calls `selectPrice(...)` with THIRTEEN positional
 *     arguments — AHL's own internal payload, in the clear: rate, buy price,
 *     target price, program id, program name, PROGRAM CODE, base rate, base
 *     price, P&I, MI, rebate in DOLLARS, lock days, amortization;
 *   • every program carries its ITEMIZED ADJUSTMENT STACK as rule text with the
 *     price hit on each — the thing LoanNEX charges a second call for;
 *   • every INELIGIBLE program carries the exact rules that failed.
 *
 * So AHL answers layers 1 AND 2 of the quote (`../pricing/quote-shape.js`) in
 * ONE call. `parseEvidence` here reads the same response the board came from
 * rather than fetching anything, which is why `client.js` has no evidence call.
 *
 * ── THE ONE REAL TRAP, AND IT IS SILENT ────────────────────────────────────
 * AHL's escaping is INCONSISTENT. The ineligible tooltips escape correctly
 * (`&lt;= $1.0M`), but the eligible programs' adjustment table emits RAW
 * comparison operators:
 *
 *     <td>… Max of LTV/CLTV/HCLTV is <=70, And DSCR is >= 1.25</td>
 *
 * A strict DOM parser reads `<=70, And DSCR is >` as a bogus tag and silently
 * EATS the LTV band and the DSCR threshold — the two numbers that make the line
 * worth reading. It does not error; it returns a shorter sentence. So this
 * module never hands the document to a DOM parser: it repairs the stray
 * operators FIRST (`repairOperators`) and then reads. `test-lt-ahl-parse-pure.js`
 * asserts on a known adjustment string containing both operators, so the day
 * this regresses a test fails rather than a borrower seeing a thinner reason.
 *
 * ── WHAT IS DERIVED AND SAID TO BE ─────────────────────────────────────────
 * AHL quotes PRICE; Lender Price quotes POINTS. `points = 100 - price` is the
 * identity between them, computed here so one board shows one column, and
 * flagged `pointsDerived: true` so nobody mistakes it for a vendor number.
 *
 * ── ONE REQUEST IS ONE PRODUCT AT ONE LOCK ─────────────────────────────────
 * Unlike LoanNEX, which prices every product and every lock in one answer, AHL
 * prices exactly the (loan term, interest-only, lock term) combination it was
 * asked for. `scenario.js` names the legs and `client.js` fans out; this module
 * parses ONE leg. `mergeLegs` puts them back together into one board, which is
 * where the several lock days of one program become several rungs — the same
 * shape LoanNEX's parser produces from a single call.
 *
 * PURE: no network, no database, no RTL import.
 */

const SOURCE = 'ahl';

const round3 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);
const numOrNull = (v) => {
  if (v == null) return null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * Put the stray `<` and `>` back before anything reads tags.
 *
 * A `<` that is NOT the start of a real tag (`<td`, `</tr`, `<!--`) is AHL's
 * unescaped comparison operator, so it is turned back into an entity. Doing it
 * this way round — repair, then read — is what makes the read safe for both the
 * correctly-escaped half of the page and the unescaped half, with no rule about
 * which half a given string came from.
 */
function repairOperators(html) {
  return String(html == null ? '' : html)
    .replace(/<(?![a-zA-Z/!?])/g, '&lt;')
    // A `>` immediately after `=` or a space-delimited operator is arithmetic,
    // never markup — `is >= 1.25`, `HCLTV > 0`.
    .replace(/([=\s])>(?=[=\s])/g, '$1&gt;');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };
function unescapeHtml(s) {
  return String(s == null ? '' : s).replace(/&(#?\w+);/g, (m, e) => (e in ENTITIES ? ENTITIES[e] : m));
}
/** Tags out, entities back, whitespace collapsed. Never run on an unrepaired string. */
function text(html) {
  return unescapeHtml(String(html == null ? '' : html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The thirteen arguments of one `selectPrice(...)` call, in AHL's own order.
 *
 * NAMED HERE AND NOWHERE ELSE. Reading a positional argument list by index at
 * the call site is how the eleventh and twelfth get swapped by somebody counting
 * commas, and a swapped lock term and rebate would both look plausible on a
 * screen. The order is quoted from the page's own `function selectPrice(obj,
 * rate, price, tprice, programID, programName, programCode, brate, bprice,
 * pipayment, mipayment, discount, term, amort)`.
 */
const SELECT_PRICE_ARGS = [
  'rate', 'price', 'targetPrice', 'programId', 'programName', 'programCode',
  'baseRate', 'basePrice', 'piPayment', 'miPayment', 'discount', 'lockDays', 'amortization',
];

const RE_SELECT_PRICE = /selectPrice\(this\s*,\s*((?:'(?:[^'\\]|\\.)*'\s*,\s*){12}'(?:[^'\\]|\\.)*')\s*\)/g;
const RE_ARG = /'((?:[^'\\]|\\.)*)'/g;

function readSelectPriceCalls(doc) {
  const out = [];
  RE_SELECT_PRICE.lastIndex = 0;
  let m;
  while ((m = RE_SELECT_PRICE.exec(doc)) !== null) {
    const args = [];
    RE_ARG.lastIndex = 0;
    let a;
    while ((a = RE_ARG.exec(m[1])) !== null) args.push(a[1].replace(/\\(.)/g, '$1'));
    if (args.length !== SELECT_PRICE_ARGS.length) continue;
    const row = {};
    SELECT_PRICE_ARGS.forEach((name, i) => { row[name] = args[i]; });
    out.push(row);
  }
  return out;
}

/**
 * One `<div id="{prefix}_{id}">…</div>` block, bounded at the NEXT such block.
 *
 * ⛔ NOT A GREEDY MATCH TO THE NEXT `</div>`, AND NOT ONE TO THE END OF THE
 * DOCUMENT EITHER. These blocks nest one `<div>` inside another, so stopping at
 * the first `</div>` truncates the content, and running to the last one swallows
 * the whole rest of the page — an early cut of this parser did exactly that and
 * attached 90 KB of unrelated script to the final program's name. The blocks are
 * emitted consecutively, so the honest boundary is the start of the next one.
 */
function blocksById(doc, prefix) {
  const out = new Map();
  const re = new RegExp(`<div id="${prefix}_(\\d+)"`, 'g');
  let m;
  while ((m = re.exec(doc)) !== null) out.set(m[1], doc.slice(m.index, closeOf(doc, m.index)));
  return out;
}

/**
 * The index just past the `</div>` that closes the `<div>` starting at `from`.
 *
 * ⛔ COUNTED, NOT GUESSED — and the two lazy versions of this both SHIP A BUG.
 * These blocks nest a `<div>` inside a `<div>`, so stopping at the first
 * `</div>` truncates the content and loses half the adjustments. Running to the
 * next block's start instead looks right and is right for every block but the
 * LAST one, which then swallows the remaining 90 KB of the page — and the tell
 * is a program NAME seven thousand characters long, which is what
 * `test-lt-ahl-parse-pure.js` NAME-1 caught when this function took that
 * shortcut. So the tags are counted.
 *
 * An unbalanced document (their bug, not ours) returns the end of the document
 * rather than throwing: a long name is a visible defect, and a parser that
 * refuses the whole board over one stray tag is a worse outcome than a board
 * with one ugly label on it.
 */
function closeOf(doc, from) {
  const re = /<div\b|<\/div>/gi;
  re.lastIndex = from;
  let depth = 0;
  let m;
  while ((m = re.exec(doc)) !== null) {
    if (m[0].toLowerCase() === '</div>') {
      depth -= 1;
      if (depth === 0) return m.index + m[0].length;
    } else depth += 1;
  }
  return doc.length;
}

/** Every `<tr>`'s cells, as repaired text. */
function rows(block) {
  return (block.match(/<tr\b[\s\S]*?<\/tr>/gi) || [])
    .map((tr) => (tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []).map(text));
}

/**
 * Split one program's `content_` block into the priced adjustments and the
 * reasons it was refused.
 *
 * AHL marks a refusal with a literal `X` in the value column and an adjustment
 * with a number. That is the vendor's own distinction, not ours — a row whose
 * value is neither is DROPPED rather than guessed at, because an adjustment we
 * cannot read the size of is not an adjustment we may show beside a price.
 */
function splitContent(block) {
  const adjustments = [];
  const reasons = [];
  const unreadable = [];
  for (const cells of rows(block)) {
    if (cells.length < 2) continue;
    const rule = cells[0];
    if (!rule || /^adjustments?$/i.test(rule)) continue;
    const value = cells[cells.length - 1];
    if (value === 'X' || value === 'x') { reasons.push({ rule }); continue; }
    const n = numOrNull(value);
    if (n == null) { unreadable.push({ rule, value }); continue; }
    // AHL's stack is stated in PRICE points. The rate column is present and is
    // blank on every captured row; it is read rather than assumed to be blank,
    // so a rate adjustment would surface instead of being silently priced as 0.
    const rateCell = cells.length >= 3 ? numOrNull(cells[cells.length - 2]) : null;
    adjustments.push({ type: null, name: null, description: rule, priceAdjustment: n, rateAdjustment: rateCell });
  }
  return { adjustments, reasons, unreadable };
}

/** The program's display name, and whether AHL called it ineligible. */
function readTitle(block) {
  const t = text(block);
  const eligible = !/\bIneligible\b/i.test(t);
  const name = t
    .replace(/\(Expand to View Rates\)/i, '')
    .replace(/\bIneligible\b/i, '')
    .trim();
  return { name: name || null, eligible };
}

/**
 * @param html one Quick Pricer response page.
 * @param leg  which product leg produced it — `{ termYears, interestOnly, lockDays }`
 *             from `scenario.js`. Carried onto every program so `mergeLegs` can
 *             put the legs back together without re-deriving anything.
 * @returns the common board shape, identical in shape to the LoanNEX parser's.
 */
function parse(html, leg = {}) {
  const doc = repairOperators(html);
  const titles = blocksById(doc, 'title');
  const contents = blocksById(doc, 'content');
  const calls = readSelectPriceCalls(doc);

  if (!titles.size && !calls.length) {
    return { source: SOURCE, programCount: 0, lenderCount: 0, rungCount: 0, programs: [], notes: ['no_programs_in_answer'] };
  }

  const byId = new Map();
  const ensure = (id) => {
    let p = byId.get(id);
    if (p) return p;
    const title = titles.has(id) ? readTitle(titles.get(id)) : { name: null, eligible: true };
    const split = contents.has(id) ? splitContent(contents.get(id)) : { adjustments: [], reasons: [], unreadable: [] };
    p = {
      source: SOURCE,
      // ONE counterparty. AHL's Quick Pricer prices AHL's own sheet and nobody
      // else's, so both name fields carry the same company — the same thing the
      // LoanNEX parser does with its single investor name. Identity is resolved
      // downstream from the canonical registry, never from this string.
      lender: 'American Heritage Lending', investor: 'American Heritage Lending',
      lenderId: null, investorOrganizationGuid: null,
      program: title.name, programId: Number(id), programCode: null,
      product: null, productId: null,
      rateSheetName: null,
      amortizationType: null,
      termInMonths: leg.termYears != null ? Math.round(Number(leg.termYears) * 12) : null,
      isInterestOnly: leg.interestOnly === true,
      interestOnlyTerm: null,
      hasQuestions: false, questionsAnswered: false,
      // AHL states its refusals and its adjustments in the SAME answer as the
      // price, so both are filled here. A program with neither carries `[]`
      // because it was asked and there were none — not `null`, which in the
      // common shape means nobody asked.
      eligible: title.eligible,
      adjustments: split.adjustments,
      ineligibleReasons: split.reasons,
      unreadableRows: split.unreadable,
      leg: { termYears: leg.termYears == null ? null : Number(leg.termYears), interestOnly: leg.interestOnly === true, lockDays: leg.lockDays == null ? null : Number(leg.lockDays) },
      rungs: [],
    };
    byId.set(id, p);
    return p;
  };

  for (const id of titles.keys()) ensure(id);

  for (const c of calls) {
    const p = ensure(String(c.programId));
    if (!p.program) p.program = c.programName || null;
    if (!p.programCode) p.programCode = c.programCode || null;
    if (!p.amortizationType) p.amortizationType = c.amortization || null;
    const price = numOrNull(c.price);
    const rate = numOrNull(c.rate);
    if (price == null || rate == null) continue;
    p.rungs.push({
      rate,
      price: round3(price),
      points: round3(100 - price),
      pointsDerived: true,
      lockDays: numOrNull(c.lockDays),
      cushionedLockDays: null,
      payment: numOrNull(c.piPayment),
      dscr: null,
      priceHashKey: null,
      isException: false,
      hasSoftStopViolation: false,
      // AHL's own build of this price, straight off the row. `basePrice` is what
      // the adjustment stack starts from, so a screen can show base → stack →
      // final without a second call.
      baseRate: numOrNull(c.baseRate),
      basePrice: numOrNull(c.basePrice),
      targetPrice: numOrNull(c.targetPrice),
      // Dollars, not points — AHL's own column. Named for what it is so nobody
      // adds it to a price.
      rebateDollars: numOrNull(c.discount),
      miPayment: numOrNull(c.miPayment),
    });
  }

  const board = finish([...byId.values()]);
  /**
   * WHICH CHANNEL AHL PRICED, TAKEN FROM AHL'S OWN ANSWER.
   *
   * Not from the request. Measured 2026-08-30, same scenario, same minute, only
   * `Channel` varying: Wholesale 6.375@97.000, Correspondent 6.625@98.000,
   * CorrNonDel 6.750@98.375 — three different sets of economics. A board that
   * reported the channel we INTENDED would still say "CorrNonDel" on the day
   * AHL ignored the field and priced Wholesale, and every number on it would be
   * from a channel nobody chose. The page echoes the channel it used, so that is
   * what is read.
   */
  const echo = echoedScenario(doc);
  board.channel = echo.Channel || null;
  board.echoed = echo;
  return board;
}

function finish(list) {
  for (const p of list) {
    p.rungs.sort((a, b) => (a.rate - b.rate) || ((a.lockDays || 0) - (b.lockDays || 0)));
    p.rungCount = p.rungs.length;
    p.minRate = p.rungs.length ? p.rungs[0].rate : null;
    p.minPoints = p.rungs.reduce((m, r) => (r && r.points != null && (m == null || r.points < m) ? r.points : m), null);
    p.maxPrice = p.rungs.reduce((m, r) => (r && r.price != null && (m == null || r.price > m) ? r.price : m), null);
    p.lockDaysOffered = [...new Set(p.rungs.map((r) => r.lockDays).filter((d) => d != null))].sort((a, b) => a - b);
  }
  list.sort((a, b) => String(a.program || '').localeCompare(String(b.program || '')));
  const priced = list.filter((p) => p.rungCount > 0);
  return {
    source: SOURCE,
    programCount: list.length,
    lenderCount: list.length ? 1 : 0,
    rungCount: list.reduce((n, p) => n + p.rungCount, 0),
    hasIneligiblePrograms: list.some((p) => !p.eligible),
    pricedProgramCount: priced.length,
    transactionId: null,
    executionTimeMs: null,
    programs: list,
  };
}

/**
 * WHAT AHL SAYS IT RECEIVED — read back off the answer's own form.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS THE STRONGEST CHECK AVAILABLE ───────────
 * A form post is silent about everything it did not like. A field name we
 * misspell is DROPPED; a value the page does not offer is IGNORED and the
 * control falls back to its own default. Neither shows up in the response
 * status, and neither shows up in the price except as a price for a different
 * loan. So "the request succeeded" proves nothing about what was priced.
 *
 * The Quick Pricer re-renders its whole form with the submitted scenario marked
 * `selected` / `checked`. That is AHL stating, in its own answer, which loan it
 * just priced. Comparing our request against it is a genuine round-trip against
 * the vendor rather than an assertion of ours checked against another assertion
 * of ours — which is exactly what `test-lt-ahl-scenario-pure.js` does with it.
 *
 * Returns `{ field: value }` for every select and radio group the page echoed.
 */
function echoedScenario(html) {
  const doc = repairOperators(html);
  const out = {};
  const reSel = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  let m;
  while ((m = reSel.exec(doc)) !== null) {
    const nm = /name="([^"]+)"/.exec(m[1]);
    if (!nm) continue;
    const reOpt = /<option\b([^>]*)>/g;
    let o, picked = null;
    while ((o = reOpt.exec(m[2])) !== null) {
      if (!/\bselected\b/.test(o[1])) continue;
      const v = /value="([^"]*)"/.exec(o[1]);
      picked = v ? v[1] : '';
    }
    if (picked != null) out[nm[1]] = picked;
  }
  const reRadio = /<input\b([^>]*type="radio"[^>]*)>/g;
  let r;
  while ((r = reRadio.exec(doc)) !== null) {
    if (!/\bchecked\b/.test(r[1])) continue;
    const nm = /name="([^"]+)"/.exec(r[1]);
    const v = /value="([^"]*)"/.exec(r[1]);
    if (nm) out[nm[1]] = v ? v[1] : '';
  }
  const reText = /<input\b([^>]*type="text"[^>]*)>/g;
  let t;
  while ((t = reText.exec(doc)) !== null) {
    const nm = /name="([^"]+)"/.exec(t[1]);
    const v = /value="([^"]*)"/.exec(t[1]);
    if (nm && v && v[1] !== '') out[nm[1]] = v[1];
  }
  return out;
}

/**
 * Put the legs back into ONE board.
 *
 * A program that appears in two legs is ONE program with the rungs of both —
 * that is how a 30-day and a 45-day quote for the same product become two rungs
 * of one program, which is the shape the merge layer and the quote shape already
 * expect from LoanNEX's single call.
 *
 * ⛔ A RUNG IS KEYED BY (rate, lockDays), AND THE DUPLICATE IS DROPPED RATHER
 * THAN APPENDED. Without that, re-running one leg — or a fan-out that repeated a
 * leg through a retry — would put the same rate on the ladder twice and a
 * "cheapest rung" read would still be right while the ladder shown to a human
 * had a doubled row in it.
 */
function mergeLegs(boards) {
  const list = (boards || []).filter(Boolean);
  if (!list.length) return { source: SOURCE, programCount: 0, lenderCount: 0, rungCount: 0, programs: [], notes: ['no_legs'] };
  const byId = new Map();
  const notes = [];
  for (const b of list) {
    for (const n of b.notes || []) if (!notes.includes(n)) notes.push(n);
    for (const p of b.programs || []) {
      const key = String(p.programId);
      let existing = byId.get(key);
      if (!existing) {
        existing = { ...p, rungs: [...p.rungs], legs: [p.leg], adjustments: [...(p.adjustments || [])], ineligibleReasons: [...(p.ineligibleReasons || [])] };
        delete existing.leg;
        byId.set(key, existing);
        continue;
      }
      existing.legs.push(p.leg);
      const seen = new Set(existing.rungs.map((r) => `${r.rate}|${r.lockDays}`));
      for (const r of p.rungs) {
        const k = `${r.rate}|${r.lockDays}`;
        if (seen.has(k)) continue;
        seen.add(k);
        existing.rungs.push(r);
      }
      // A program priced in ANY leg is priced. Its adjustment stack is stated per
      // leg and the stacks are kept apart only when they differ, because two
      // identical stacks listed twice would read as a doubled price hit.
      for (const a of p.adjustments || []) {
        if (!existing.adjustments.some((x) => x.description === a.description && x.priceAdjustment === a.priceAdjustment)) existing.adjustments.push(a);
      }
      for (const r of p.ineligibleReasons || []) {
        if (!existing.ineligibleReasons.some((x) => x.rule === r.rule)) existing.ineligibleReasons.push(r);
      }
      existing.eligible = existing.eligible || p.eligible;
    }
  }
  const out = finish([...byId.values()]);
  if (notes.length) out.notes = notes;
  out.legCount = list.length;
  /**
   * ⛔ EVERY LEG MUST HAVE BEEN PRICED ON THE SAME CHANNEL, and a board whose
   * legs disagree is REFUSED rather than merged. The three channels price
   * differently, so a 30-year leg from Correspondent merged with a 40-year leg
   * from Wholesale would put two different sets of economics on one investor's
   * board and present the gap between them as a product difference.
   */
  const channels = [...new Set(list.map((b) => b.channel).filter(Boolean))];
  if (channels.length > 1) {
    const err = new Error(`These legs were priced on different AHL channels (${channels.join(', ')}). They price differently, so merging them would present a channel difference as a product difference.`);
    err.code = 'mixed_channels';
    throw err;
  }
  out.channel = channels[0] || null;
  return out;
}

/**
 * The refusals, in the same `{ lenders: [{ lender, items: [{ program, reasons }] }] }`
 * shape the LoanNEX and Lender Price disqualify parsers produce.
 *
 * Read off the board rather than fetched: AHL states its refusals in the same
 * answer as its prices, so there is no second call to make and nothing to poll.
 */
function parseFails(board) {
  const programs = (board && board.programs) || [];
  const refused = programs.filter((p) => !p.eligible || !p.rungCount);
  const items = refused.map((p) => ({
    program: p.program || null,
    screen: null,
    status: p.eligible ? 'NoPrice' : 'Fail',
    reasons: (p.ineligibleReasons || []).map((r) => r.rule),
    failingAttributes: [],
  }));
  return {
    source: SOURCE,
    lenderCount: items.length ? 1 : 0,
    itemCount: items.length,
    transactionId: null,
    lenders: items.length ? [{ lender: 'American Heritage Lending', lenderId: null, organizationGuid: null, items }] : [],
  };
}

/**
 * The LLPA breakdown behind ONE quote, in the shape `quote-shape.attachEvidence`
 * already reads — built from the board, because AHL sent it with the price.
 *
 * ⛔ THE RECONCILIATION IS CHECKED, NOT ASSERTED. `basePrice + Σ adjustments`
 * is compared against the rung's own price and the answer carries
 * `reconciles` plus the residual. A breakdown that does not add up is still
 * SHOWN — it is the vendor's own arithmetic and hiding it would hide the
 * problem — but it is shown carrying the fact that it does not add up, so a
 * screen can say so instead of implying a total nobody computed.
 */
function evidenceFor(board, opts = {}) {
  const programs = (board && board.programs) || [];
  const wantId = opts.programId == null ? null : String(opts.programId);
  const p = wantId ? programs.find((x) => String(x.programId) === wantId) : programs.find((x) => x.rungCount > 0);
  if (!p) return null;
  const rate = opts.rate == null ? null : Number(opts.rate);
  const lock = opts.lockDays == null ? null : Number(opts.lockDays);
  const rung = p.rungs.find((r) => (rate == null || r.rate === rate) && (lock == null || r.lockDays === lock)) || p.rungs[0] || null;
  if (!rung) return null;
  const adjustments = p.adjustments || [];
  const sum = adjustments.reduce((n, a) => n + (Number(a.priceAdjustment) || 0), 0);
  const base = rung.basePrice;
  const expected = base == null ? null : round3(base + sum);
  const residual = expected == null || rung.price == null ? null : round3(rung.price - expected);
  return {
    source: SOURCE,
    program: p.program || null,
    product: p.programCode || null,
    rate: rung.rate,
    price: rung.price,
    basePrice: base,
    baseRate: rung.baseRate,
    priceFloor: null,
    priceCeiling: null,
    isPriceRounded: null,
    lockPeriod: rung.lockDays,
    rateSheetLastUpdated: null,
    adjustments: adjustments.map((a) => ({ type: a.type, name: a.name, description: a.description, priceAdjustment: a.priceAdjustment })),
    addOns: [],
    adjustmentTotal: round3(sum),
    expectedPrice: expected,
    residual,
    reconciles: residual != null && Math.abs(residual) < 0.0005,
    eligibility: {
      screen: null, screenedAt: null,
      status: p.eligible ? 'Pass' : 'Fail',
      isException: null, actual: null, qualifying: null,
      criteria: (p.ineligibleReasons || []).map((r) => ({ name: null, requirement: r.rule, status: 'Fail' })),
      notices: [],
    },
    ltv: null, cltv: null, dscr: null, monthsReserves: null,
  };
}

/** WHY there is no breakdown — never "we didn't ask" when the answer simply had none. */
function explainAbsence(board) {
  if (board == null) return { reason: 'no_answer', message: 'The Quick Pricer was asked and nothing came back.' };
  if (!board.programs || !board.programs.length) {
    return { reason: 'vendor_returned_no_programs', message: 'The Quick Pricer accepted the scenario and returned no programs at all for it.' };
  }
  if (!board.pricedProgramCount) {
    return { reason: 'no_eligible_program', message: 'The Quick Pricer returned programs but priced none of them for this scenario; each one carries the rules it failed.' };
  }
  return { reason: 'unknown', message: 'No breakdown could be read from the answer.' };
}

module.exports = {
  SOURCE, parse, mergeLegs, parseFails, evidenceFor, explainAbsence, echoedScenario,
  _internals: { repairOperators, text, unescapeHtml, blocksById, closeOf, rows, splitContent, readTitle, readSelectPriceCalls, numOrNull, round3, SELECT_PRICE_ARGS },
};
