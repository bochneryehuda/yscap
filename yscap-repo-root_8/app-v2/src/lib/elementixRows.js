/**
 * THE ROWS BEHIND THE ELEMENTIX PROFILE — readers, columns, and the one
 * decision that says which rows a tab is showing and in what order.
 *
 * WHY THIS IS ITS OWN FILE AND NOT MORE OF `ElementixProfile.jsx`: the filter
 * bar is the part that can lie. A range that quietly drops every row whose date
 * the vendor never sent, a "still open" filter that folds an unanswerable row in
 * with the answered ones, a sort that treats a missing amount as zero — each of
 * those renders as a confident, wrong list, and none of them is visible in a
 * screenshot. So the whole decision is a PURE function of (rows, columns,
 * filters, sort) with no React in it, and `scripts/test-elementix-profile-
 * filters-pure.js` walks its truth table. The component only draws what this
 * file decides.
 *
 * THE THREE RULES IT KEEPS, which are the same three the screen around it keeps:
 *
 *  1. AN UNKNOWN IS ITS OWN ANSWER. A row that cannot answer a filter is never
 *     silently folded into either side of it. A range filter excludes it (a row
 *     with no date is not in any date range) and SAYS SO — `notes` carries the
 *     count, the screen prints it. The paid-off filter gives it a third option
 *     of its own.
 *  2. NOTHING MISSING SORTS AS SOMETHING. A null amount is not zero and a null
 *     date is not 1970, so unknowns sort LAST in both directions rather than
 *     bunching at whichever end the direction happens to point.
 *  3. AN EMPTY RESULT IS NOT AN EMPTY TAB. `emptyReason` distinguishes "these
 *     filters match nothing" from "this section holds nothing", because only one
 *     of those means Elementix has none.
 *
 * PURE: no React, no DOM, no network. Every export here is a function of its
 * arguments.
 */

// ---------------------------------------------------------------------------
// Readers — tolerant on purpose, and never inventive
// ---------------------------------------------------------------------------

export const txt = (v) => (v === null || v === undefined ? '' : String(v));

/** A number from a number OR a decimal string (the vendor sends both). */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function money(v) {
  const n = num(v);
  if (n === null) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function count(v) {
  const n = num(v);
  // "—" NOT "0". A count we never read is not a count of none.
  return n === null ? '—' : n.toLocaleString('en-US');
}

export function day(v) {
  const s = txt(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : (s || '—');
}

/**
 * A SORTABLE, COMPARABLE DAY — 'YYYY-MM-DD' or null, never a guess.
 *
 * Deliberately NOT `new Date(...)`: parsing a bare 'YYYY-MM-DD' through Date
 * lands it at UTC midnight and reading it back in a New York browser gives the
 * PREVIOUS day, which on a range boundary silently moves a mortgage out of the
 * month it was recorded in. Strings in this format compare correctly with `<`
 * and `>`, so the comparison never leaves the calendar. Two spellings are
 * accepted because both have been seen; anything else is null — an unknown,
 * which this file then reports rather than hides.
 */
export function ymd(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return null;
}

/** One address out of a row, whichever way this particular tool spelled it. */
export function addressOf(row) {
  if (!row || typeof row !== 'object') return '';
  const buckets = [row.addresses, row.propertyAddresses, row.property_addresses];
  for (const b of buckets) {
    if (!Array.isArray(b) || !b.length) continue;
    const first = b[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') {
      const s = txt(first.addressFull || first.address_full || first.address || first.full);
      if (s) return s;
    }
  }
  for (const k of ['addressFull', 'address_full', 'address', 'granteeAddress', 'borrowerAddress']) {
    const s = txt(row[k]);
    if (s) return s;
  }
  // Nothing spelled as an address — build one from the parts the row does carry
  // rather than showing a dash next to a row that plainly knows where it is.
  const parts = [txt(row.city), txt(row.countyState || row.state), txt(row.zipCode)].filter(Boolean);
  return parts.join(', ');
}

export const names = (v) => (Array.isArray(v) ? v.filter(Boolean).map(txt).join(', ') : txt(v));

/** The state Elementix's own record for this row came from (the row pill). */
export function stateOf(row) {
  if (!row || typeof row !== 'object') return '';
  const s = row._source && row._source.state;
  return txt(s).toUpperCase();
}

/**
 * PAID OFF, STILL OPEN, OR UNANSWERABLE — three states, never two.
 *
 * A satisfaction is the signal: the recorded document that says the mortgage
 * went away. A row that CARRIES the field and has it empty is a mortgage with no
 * payoff on record — the honest reading of "still open", and the strongest one
 * available. A row that does not carry the field AT ALL (another shape entirely,
 * or a tool that spells it differently) cannot answer, and saying "open" about
 * it would be inventing a fact about somebody's loan.
 *
 * Note what is deliberately NOT used: `loanStatus`. The captured shape says in
 * as many words that it "can be null even on a live loan, so an absent status is
 * not evidence the loan is closed" — reading it here would turn a vendor gap
 * into a claim.
 */
export function payoffStatus(row) {
  if (!row || typeof row !== 'object') return 'unknown';
  const raw = row.satisfactionDate !== undefined ? row.satisfactionDate : row.satisfaction_date;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') return 'paid';
  if (row.satisfactionId) return 'paid';   // a payoff on record with no date is still a payoff
  const asked = ('satisfactionDate' in row) || ('satisfaction_date' in row) || ('satisfactionId' in row);
  return asked ? 'open' : 'unknown';
}

/** What the "Paid off" cell reads, from the same three-valued answer. */
export function payoffLabel(row) {
  const s = payoffStatus(row);
  if (s === 'paid') {
    const d = row && (row.satisfactionDate || row.satisfaction_date);
    return d ? day(d) : 'Paid off';
  }
  // '—' NOT 'Open': a row that cannot answer must not be printed as one that did.
  return s === 'open' ? 'Open' : '—';
}

export const PAYOFF_LABELS = {
  paid: 'Paid off',
  open: 'Still open',
  unknown: 'Not on record',
};

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

/* Every column is a function of the row, so an absent field is a dash rather
   than a crash, and a tool that renames a field degrades one cell.
   `kind` + `raw` are what the filter bar and the sort read: `get` is for the
   EYE (formatted, localised, dashed) and `raw` is for the MACHINE (a number, a
   'YYYY-MM-DD', or null for "this row does not say"). Sorting or filtering on
   the formatted string would order "$1,000,000" before "$90,000" and read a
   dash as a value. A column with no `kind` is text and sorts on what it shows. */
export const COLUMNS = {
  entities: [
    { h: 'Entity', w: '34%', get: (r) => txt(r.name), strong: true },
    { h: 'State', get: (r) => txt(r.state) },
    { h: 'Type', get: (r) => txt(r.entityType || r.type) },
    { h: 'Mortgages', get: (r) => count(r.mortgageCount), n: true, kind: 'num', raw: (r) => num(r.mortgageCount) },
    { h: 'Deeds', get: (r) => count(r.deedCount), n: true, kind: 'num', raw: (r) => num(r.deedCount) },
    { h: 'Owns now', get: (r) => count(r.currentOwnershipsCount), n: true, kind: 'num', raw: (r) => num(r.currentOwnershipsCount) },
    { h: 'Last seen', get: (r) => day(r.latestTransactionDate), kind: 'date', raw: (r) => ymd(r.latestTransactionDate) },
  ],
  properties: [
    { h: 'Property', w: '44%', get: (r) => addressOf(r), strong: true },
    { h: 'Bought', get: (r) => day(r.startDate || r.purchaseDate), kind: 'date', raw: (r) => ymd(r.startDate || r.purchaseDate) },
    { h: 'Sold', get: (r) => day(r.endDate || r.saleDate), kind: 'date', raw: (r) => ymd(r.endDate || r.saleDate) },
    { h: 'Paid', get: (r) => money(r.purchasePrice ?? r.totalConsideration), n: true, kind: 'money', raw: (r) => num(r.purchasePrice ?? r.totalConsideration) },
    { h: 'Sold for', get: (r) => money(r.salePrice), n: true, kind: 'money', raw: (r) => num(r.salePrice) },
  ],
  mortgages: [
    { h: 'Property', w: '32%', get: (r) => addressOf(r), strong: true },
    { h: 'Recorded', get: (r) => day(r.recordingDate), kind: 'date', raw: (r) => ymd(r.recordingDate) },
    { h: 'Amount', get: (r) => money(r.mortgageAmount), n: true, kind: 'money', raw: (r) => num(r.mortgageAmount) },
    { h: 'Lender', get: (r) => txt(r.lenderName || r.lenderAliasName) },
    { h: 'Kind', get: (r) => txt(r.lenderType) },
    { h: 'Term', get: (r) => (num(r.loanTermMonths) === null ? '—' : `${r.loanTermMonths} mo`), kind: 'num', raw: (r) => num(r.loanTermMonths) },
    { h: 'Matures', get: (r) => day(r.maturityDate), kind: 'date', raw: (r) => ymd(r.maturityDate) },
    { h: 'Paid off', get: (r) => payoffLabel(r), kind: 'payoff', raw: (r) => payoffStatus(r) },
  ],
  deeds: [
    { h: 'Property', w: '32%', get: (r) => addressOf(r), strong: true },
    { h: 'Recorded', get: (r) => day(r.recordingDate), kind: 'date', raw: (r) => ymd(r.recordingDate) },
    { h: 'Price', get: (r) => money(r.totalConsideration), n: true, kind: 'money', raw: (r) => num(r.totalConsideration) },
    { h: 'From', get: (r) => names(r.grantors) },
    { h: 'To', get: (r) => names(r.grantees) },
    { h: 'Cash', get: (r) => (r.isCashPurchase === true ? 'Cash' : r.isCashPurchase === false ? 'Financed' : '—') },
  ],
  associated_people: [
    { h: 'Person', w: '40%', get: (r) => txt(r.name), strong: true },
    { h: 'Shared mortgages', get: (r) => count(r.sharedMortgageCount), n: true, kind: 'num', raw: (r) => num(r.sharedMortgageCount) },
    { h: 'Shared deeds', get: (r) => count(r.sharedDeedCount), n: true, kind: 'num', raw: (r) => num(r.sharedDeedCount) },
    { h: 'Together on', get: (r) => count(r.sharedTotalCount), n: true, kind: 'num', raw: (r) => num(r.sharedTotalCount) },
  ],
  lender_network: [
    { h: 'Lender', w: '38%', get: (r) => txt(r.name), strong: true },
    { h: 'Kind', get: (r) => txt(r.lenderType) },
    { h: 'Loans', get: (r) => count(r.mortgageCount), n: true, kind: 'num', raw: (r) => num(r.mortgageCount) },
    { h: 'Total lent', get: (r) => money(r.totalVolume), n: true, kind: 'money', raw: (r) => num(r.totalVolume) },
  ],
  cross_state: [
    { h: 'Name', w: '38%', get: (r) => txt(r.name), strong: true },
    { h: 'State', get: (r) => txt(r.state) },
    { h: 'Mortgages', get: (r) => count(r.mortgageCount), n: true, kind: 'num', raw: (r) => num(r.mortgageCount) },
    { h: 'Deeds', get: (r) => count(r.deedCount), n: true, kind: 'num', raw: (r) => num(r.deedCount) },
    { h: 'Records', get: (r) => count(r.transactionCount), n: true, kind: 'num', raw: (r) => num(r.transactionCount) },
  ],
};
/* A foreclosure IS a mortgage row with a preforeclosure attached — same tool,
   same shape, so the same columns and therefore the same filters. */
COLUMNS.foreclosures = COLUMNS.mortgages;

/** A last resort for a shape we have no columns for: the row's own scalars. */
export function fallbackColumns(rows) {
  const first = (rows || []).find((r) => r && typeof r === 'object') || {};
  const keys = Object.keys(first)
    .filter((k) => !k.startsWith('_') && ['string', 'number', 'boolean'].includes(typeof first[k]))
    .slice(0, 6);
  return keys.map((k) => ({ h: k, get: (r) => txt(r[k]) }));
}

/** Everything on the row, flattened, so the search box searches what is shown
 *  AND what is not — a person hunting for a street name should find it even
 *  when the column showing it is off to the right. */
export function haystack(row) {
  try { return JSON.stringify(row).toLowerCase(); } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// The filters
// ---------------------------------------------------------------------------

/** Nothing set. Exported so "Clear" and a tab change mean exactly one thing. */
export const NO_FILTERS = Object.freeze({
  q: '', state: '', dateCol: '', from: '', to: '', amountCol: '', min: '', max: '', payoff: '',
});

const UNKNOWN_STATE = '__none';
export { UNKNOWN_STATE };

/** Is any of this actually narrowing anything? */
export function filtersActive(f) {
  const v = { ...NO_FILTERS, ...(f || {}) };
  if (txt(v.q).trim()) return true;
  if (v.state) return true;
  if (v.payoff) return true;
  if (v.dateCol && (ymd(v.from) || ymd(v.to))) return true;
  if (v.amountCol && (num(v.min) !== null || num(v.max) !== null)) return true;
  return false;
}

const colByHead = (cols, h) => (cols || []).find((c) => c.h === h) || null;

/**
 * WHICH CONTROLS THIS TAB CAN HONESTLY OFFER — derived from the columns and the
 * rows in hand, never hand-listed per tab. A tab with no date column gets no
 * date range; a tab whose rows all came from one state gets no state picker
 * (a control with one option is furniture); the paid-off filter appears only
 * where a column declares it, and its counts are shown so an officer can see
 * before clicking that 40 of the rows cannot answer.
 */
export function facetsFor(rows, cols) {
  const list = Array.isArray(rows) ? rows : [];
  const columns = Array.isArray(cols) ? cols : [];
  const states = [];
  let stateless = 0;
  for (const r of list) {
    const s = stateOf(r);
    if (!s) { stateless += 1; continue; }
    if (!states.includes(s)) states.push(s);
  }
  states.sort();

  const dateCols = columns.filter((c) => c.kind === 'date' && typeof c.raw === 'function').map((c) => c.h);
  const moneyCols = columns.filter((c) => c.kind === 'money' && typeof c.raw === 'function').map((c) => c.h);
  const payoffCol = columns.find((c) => c.kind === 'payoff') || null;

  let payoff = null;
  if (payoffCol) {
    payoff = { paid: 0, open: 0, unknown: 0 };
    for (const r of list) payoff[payoffStatus(r)] += 1;
  }
  return { states, stateless, dateCols, moneyCols, payoff };
}

/** The value a sort compares on: the machine's reading, never the printed one. */
export function sortValue(col, row) {
  if (!col) return null;
  if (typeof col.raw === 'function') {
    const v = col.raw(row);
    if (v === undefined || v === '') return null;
    if (col.kind === 'payoff') return v === 'paid' ? 0 : v === 'open' ? 1 : null;
    return v === null ? null : v;
  }
  const s = txt(col.get ? col.get(row) : '').trim().toLowerCase();
  // A dash is what this screen prints for "we do not know", so it sorts as one.
  return (!s || s === '—') ? null : s;
}

/** Biggest / newest first is what somebody asking for a sort usually means. */
export function defaultDir(col) {
  return col && (col.kind === 'money' || col.kind === 'num' || col.kind === 'date') ? 'desc' : 'asc';
}

/** Click a heading: sort it the useful way, then the other way, then stop. */
export function nextSort(sort, col) {
  if (!col) return null;
  if (!sort || sort.h !== col.h) return { h: col.h, dir: defaultDir(col) };
  const other = sort.dir === 'asc' ? 'desc' : 'asc';
  return sort.dir === defaultDir(col) ? { h: col.h, dir: other } : null;
}

/** "Amount, largest first" — in the words that match what the column holds. */
export function sortLabel(sort, cols) {
  if (!sort) return null;
  const col = colByHead(cols, sort.h);
  if (!col) return null;
  const asc = sort.dir === 'asc';
  const how = col.kind === 'date' ? (asc ? 'oldest first' : 'newest first')
    : (col.kind === 'money' || col.kind === 'num') ? (asc ? 'smallest first' : 'largest first')
      : col.kind === 'payoff' ? (asc ? 'paid off first' : 'still open first')
        : (asc ? 'A to Z' : 'Z to A');
  return `${col.h}, ${how}`;
}

/**
 * THE DECISION. Which rows this tab is showing, in which order, and what has to
 * be said out loud about the ones it is not showing.
 *
 * Every filter is evaluated per row INDEPENDENTLY rather than by chaining
 * `.filter()` calls, because the honest note ("17 more have no Recorded date")
 * is a count of rows that pass every OTHER filter and fail this one only for
 * want of a value. Chained filters cannot produce that number.
 */
export function applyRowView({ rows, cols, filters, sort, truncated, haystacks } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const columns = Array.isArray(cols) ? cols : [];
  const f = { ...NO_FILTERS, ...(filters || {}) };
  const held = list.length;

  const q = txt(f.q).trim().toLowerCase();
  const dateCol = f.dateCol ? colByHead(columns, f.dateCol) : null;
  const from = ymd(f.from);
  const to = ymd(f.to);
  const dateOn = !!(dateCol && (from || to));
  const amountCol = f.amountCol ? colByHead(columns, f.amountCol) : null;
  const min = num(f.min);
  const max = num(f.max);
  const amountOn = !!(amountCol && (min !== null || max !== null));
  const payoffOn = !!f.payoff;
  const stateOn = !!f.state;

  const kept = [];
  let dateUnknown = 0;
  let amountUnknown = 0;

  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const hay = haystacks && haystacks[i] !== undefined ? haystacks[i] : haystack(r);
    const qPass = !q || hay.includes(q);
    const st = stateOf(r);
    const statePass = !stateOn || (f.state === UNKNOWN_STATE ? !st : st === txt(f.state).toUpperCase());
    const payoffPass = !payoffOn || payoffStatus(r) === f.payoff;

    let dv = null; let datePass = true; let dateBlank = false;
    if (dateOn) {
      dv = dateCol.raw(r);
      dv = dv || null;
      if (!dv) { datePass = false; dateBlank = true; }
      else datePass = (!from || dv >= from) && (!to || dv <= to);
    }
    let av = null; let amountPass = true; let amountBlank = false;
    if (amountOn) {
      av = amountCol.raw(r);
      if (av === null || av === undefined || !Number.isFinite(Number(av))) { amountPass = false; amountBlank = true; }
      else {
        const n = Number(av);
        amountPass = (min === null || n >= min) && (max === null || n <= max);
      }
    }

    if (qPass && statePass && payoffPass && datePass && amountPass) { kept.push({ r, i }); continue; }
    // The rows this range CANNOT judge, counted only when nothing else excluded
    // them — otherwise the sentence would over-claim.
    if (dateBlank && qPass && statePass && payoffPass && amountPass) dateUnknown += 1;
    if (amountBlank && qPass && statePass && payoffPass && datePass) amountUnknown += 1;
  }

  const sortCol = sort && sort.h ? colByHead(columns, sort.h) : null;
  if (sortCol) {
    const dir = sort.dir === 'asc' ? 1 : -1;
    kept.sort((a, b) => {
      const va = sortValue(sortCol, a.r);
      const vb = sortValue(sortCol, b.r);
      // NOTHING MISSING SORTS AS SOMETHING — an unknown goes last whichever way
      // the arrow points, rather than pretending to be zero or 1970.
      if (va === null && vb === null) return a.i - b.i;
      if (va === null) return 1;
      if (vb === null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.i - b.i;                      // stable: the vendor's own order
    });
  }

  const shown = kept.map((x) => x.r);
  const active = filtersActive(f);
  const notes = {
    dateUnknown: dateOn && dateUnknown ? { column: dateCol.h, count: dateUnknown } : null,
    amountUnknown: amountOn && amountUnknown ? { column: amountCol.h, count: amountUnknown } : null,
  };
  return {
    rows: shown,
    held,
    shown: shown.length,
    active,
    sort: sortCol ? { h: sortCol.h, dir: sort.dir === 'asc' ? 'asc' : 'desc' } : null,
    truncated: !!truncated,
    notes,
    /* THREE DIFFERENT EMPTIES, AND ONLY ONE OF THEM MEANS "ELEMENTIX HAS NONE".
       Rendering a filtered-to-nothing tab as a blank table is the same lie the
       rest of this screen exists to refuse. */
    emptyReason: shown.length ? null : (held ? 'no-match' : 'no-rows'),
  };
}

/**
 * WHAT THE SCREEN SAYS ABOUT THAT DECISION — one sentence for the count, one
 * for the fact that the set itself is partial, and one per filter that could
 * not judge every row.
 *
 * THE TRUNCATED LINE IS NOT DECORATION. Filtering 500 of 829 rows that ARE the
 * whole record answers "how many of their loans are over $1m". Filtering 500 of
 * the first 829 rows of an unknown number answers nothing of the kind, and the
 * two look identical on screen unless it is said.
 */
export function viewSummary(view, labels) {
  if (!view) return { main: '', truncatedNote: null, unknownNotes: [] };
  const n = (x) => Number(x || 0).toLocaleString('en-US');
  const noun = labels && labels.noun ? labels.noun : 'rows';
  const main = view.active
    ? `Showing ${n(view.shown)} of ${n(view.held)} ${noun} held`
    : `${n(view.held)} ${noun} held`;
  const truncatedNote = view.truncated
    ? (view.active
      ? `These ${n(view.held)} are only the ones we pulled in — Elementix holds more, so this filter is narrowing part of the list, not all of it.`
      : `These ${n(view.held)} are only the ones we pulled in — Elementix holds more.`)
    : null;
  const unknownNotes = [];
  if (view.notes && view.notes.dateUnknown) {
    const u = view.notes.dateUnknown;
    unknownNotes.push(`${n(u.count)} more have no ${u.column} date on record, so this range cannot judge them — they are not counted either way.`);
  }
  if (view.notes && view.notes.amountUnknown) {
    const u = view.notes.amountUnknown;
    unknownNotes.push(`${n(u.count)} more carry no ${u.column} figure, so this range cannot judge them — they are not counted either way.`);
  }
  return { main, truncatedNote, unknownNotes };
}
