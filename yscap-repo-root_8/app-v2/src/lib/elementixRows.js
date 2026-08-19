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

/**
 * THE ADDRESS UUID ON A ROW — what makes "open this property" possible.
 *
 * Every person tool spells the same thing differently, which is why this is one
 * reader and not three tests written at three call sites: a mortgage carries
 * `propertyAddresses[{id, addressFull}]` in camelCase, a deed carries
 * `property_addresses[{id, address_full}]` in SNAKE_CASE, and an ownership row
 * carries a bare `addressId`. A cell that guessed one spelling would render a
 * dead link on two thirds of the rows and nothing anywhere would say why.
 * Returns null rather than a guess.
 */
export function addressIdOf(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = txt(row.addressId || row.address_id);
  if (direct) return direct;
  for (const b of [row.propertyAddresses, row.property_addresses, row.addresses]) {
    if (!Array.isArray(b)) continue;
    for (const a of b) {
      if (a && typeof a === 'object' && txt(a.id)) return txt(a.id);
    }
  }
  if (Array.isArray(row.addressesIds) && row.addressesIds.length) return txt(row.addressesIds[0]) || null;
  return null;
}

/**
 * THE COMPANY THE DEAL WAS DONE IN — the person↔LLC link, which is the whole
 * reason Elementix is worth paying for. Again three spellings for one idea:
 * `entityBorrowers` on a mortgage, `entity_grantors`/`entity_grantees` on a
 * deed, `entityGrantees` on an ownership row.
 */
export function entityOf(row) {
  if (!row || typeof row !== 'object') return [];
  for (const k of ['entityBorrowers', 'entityGrantees', 'entity_grantees', 'entityGrantors', 'entity_grantors']) {
    const b = row[k];
    if (Array.isArray(b) && b.length) {
      return b.filter((e) => e && typeof e === 'object' && txt(e.name))
        .map((e) => ({ id: txt(e.id) || null, name: txt(e.name), state: txt(e.state) || null }));
    }
  }
  return [];
}

/** The vendor's own deep link for this record, when it sent one. */
export function urlOf(row) {
  const u = txt(row && (row._url || row._elementixUrl));
  return /^https?:\/\//i.test(u) ? u : null;
}

/** A yes / no / "the row does not say" — never a confident No for a missing flag. */
export const flag = (v, yes, no) => (v === true ? yes : v === false ? no : '—');

/** Title Case for a vendor enum like `SINGLE_FAMILY` or `purchase money`. */
export function pretty(v) {
  const s = txt(v).replace(/[_-]+/g, ' ').trim();
  if (!s) return '—';
  return s.split(/\s+/).map((w) => (w.length > 3 && w === w.toUpperCase()
    ? w[0] + w.slice(1).toLowerCase()
    : (w[0] || '').toUpperCase() + w.slice(1))).join(' ');
}

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
    { h: 'Entity', w: '26%', get: (r) => txt(r.name), strong: true },
    { h: 'State', get: (r) => txt(r.state) },
    { h: 'Type', get: (r) => pretty(r.entityType || r.type) },
    { h: 'Their role', get: (r) => (r.isPrincipal === true ? 'Principal' : txt(r.sosTitle) || txt(r.researchTitle) || (r.elementixSigner ? 'Signed for it' : '—')) },
    { h: 'Mortgages', get: (r) => count(r.mortgageCount), n: true, kind: 'num', raw: (r) => num(r.mortgageCount) },
    { h: 'Deeds', get: (r) => count(r.deedCount), n: true, kind: 'num', raw: (r) => num(r.deedCount) },
    { h: 'Payoffs', get: (r) => count(r.satisfactionCount), n: true, kind: 'num', raw: (r) => num(r.satisfactionCount) },
    { h: 'Owns now', get: (r) => count(r.currentOwnershipsCount), n: true, kind: 'num', raw: (r) => num(r.currentOwnershipsCount) },
    { h: 'Last seen', get: (r) => day(r.latestTransactionDate), kind: 'date', raw: (r) => ymd(r.latestTransactionDate) },
  ],
  properties: [
    { h: 'Property', w: '26%', get: (r) => addressOf(r), strong: true, subject: true },
    /* THE COMPANY IT SITS IN. An investor holds almost nothing in their own
       name, so without this column the portfolio reads as a list of addresses
       with no owner — and the person→LLC link is the thing Elementix is bought
       for. */
    { h: 'Held in', w: '16%', get: (r) => (entityOf(r).map((e) => e.name).join(', ') || '—') },
    { h: 'Bought', get: (r) => day(r.startDate || r.purchaseDate), kind: 'date', raw: (r) => ymd(r.startDate || r.purchaseDate) },
    { h: 'Paid', get: (r) => money(r.totalConsideration ?? r.purchasePrice), n: true, kind: 'money', raw: (r) => num(r.totalConsideration ?? r.purchasePrice) },
    { h: 'Sold', get: (r) => day(r.endDate || r.saleDate), kind: 'date', raw: (r) => ymd(r.endDate || r.saleDate) },
    /* `soldConsideration`, NOT `salePrice`. There is no `salePrice` on an
       ownership row — `purchasePrice`/`salePrice` are values of the tool's
       `sortBy` parameter, not fields on the row — so this column rendered a
       dash on every property ever shown. The old spelling is kept as a
       fallback rather than deleted: it costs nothing and a vendor that starts
       sending it will simply work. */
    { h: 'Sold for', get: (r) => money(r.soldConsideration ?? r.salePrice), n: true, kind: 'money', raw: (r) => num(r.soldConsideration ?? r.salePrice) },
    { h: 'Kind', get: (r) => pretty(r.propertyUseCategory) },
    { h: 'County', get: (r) => (txt(r.countyName) ? `${txt(r.countyName)}${txt(r.state) ? ', ' + txt(r.state) : ''}` : txt(r.city) || '—') },
  ],
  mortgages: [
    { h: 'Property', w: '24%', get: (r) => addressOf(r), strong: true, subject: true },
    { h: 'Held in', w: '14%', get: (r) => (entityOf(r).map((e) => e.name).join(', ') || names(r.borrowerNames) || '—') },
    { h: 'Recorded', get: (r) => day(r.recordingDate), kind: 'date', raw: (r) => ymd(r.recordingDate) },
    { h: 'Amount', get: (r) => money(r.mortgageAmount), n: true, kind: 'money', raw: (r) => num(r.mortgageAmount) },
    /* WHAT THEY PAID FOR IT, on the same row as what they borrowed on it —
       `deedConsideration` rides along on every mortgage, so the loan-to-price
       an officer is really asking about is answerable with no second call and
       no second tab. */
    { h: 'Price paid', get: (r) => money(r.deedConsideration), n: true, kind: 'money', raw: (r) => num(r.deedConsideration) },
    { h: 'Lender', w: '14%', get: (r) => txt(r.lenderName || r.lenderAliasName) },
    { h: 'Kind', get: (r) => pretty(r.lenderType) },
    { h: 'Purpose', get: (r) => (r.isRefinance === true ? 'Refinance' : r.isExtension === true ? 'Extension' : pretty(r.loanPurpose)) },
    { h: 'Term', get: (r) => (num(r.loanTermMonths) === null ? '—' : `${r.loanTermMonths} mo`), kind: 'num', raw: (r) => num(r.loanTermMonths) },
    { h: 'Matures', get: (r) => day(r.maturityDate), kind: 'date', raw: (r) => ymd(r.maturityDate) },
    { h: 'Paid off', get: (r) => payoffLabel(r), kind: 'payoff', raw: (r) => payoffStatus(r) },
  ],
  deeds: [
    { h: 'Property', w: '24%', get: (r) => addressOf(r), strong: true, subject: true },
    { h: 'Recorded', get: (r) => day(r.recordingDate), kind: 'date', raw: (r) => ymd(r.recordingDate) },
    { h: 'Price', get: (r) => money(r.totalConsideration), n: true, kind: 'money', raw: (r) => num(r.totalConsideration) },
    { h: 'From', w: '16%', get: (r) => names(r.grantors) },
    { h: 'To', w: '16%', get: (r) => names(r.grantees) },
    { h: 'Cash', get: (r) => flag(r.isCashPurchase, 'Cash', 'Financed') },
    { h: 'Business', get: (r) => flag(r.isBusinessPurpose, 'Business', 'Personal') },
    { h: 'County', get: (r) => (txt(r.countyName) ? `${txt(r.countyName)}${txt(r.countyState) ? ', ' + txt(r.countyState) : ''}` : txt(r.city) || '—') },
  ],
  associated_people: [
    { h: 'Person', w: '40%', get: (r) => txt(r.name), strong: true, subject: true },
    { h: 'Shared mortgages', get: (r) => count(r.sharedMortgageCount), n: true, kind: 'num', raw: (r) => num(r.sharedMortgageCount) },
    { h: 'Shared deeds', get: (r) => count(r.sharedDeedCount), n: true, kind: 'num', raw: (r) => num(r.sharedDeedCount) },
    { h: 'Together on', get: (r) => count(r.sharedTotalCount), n: true, kind: 'num', raw: (r) => num(r.sharedTotalCount) },
  ],
  lender_network: [
    { h: 'Lender', w: '34%', get: (r) => txt(r.name), strong: true, subject: true },
    { h: 'Kind', get: (r) => pretty(r.lenderType) },
    { h: 'Loans', get: (r) => count(r.mortgageCount), n: true, kind: 'num', raw: (r) => num(r.mortgageCount) },
    { h: 'Total lent', get: (r) => money(r.totalVolume), n: true, kind: 'money', raw: (r) => num(r.totalVolume) },
    { h: 'Website', get: (r) => txt(r.domainName) || '—' },
  ],
  cross_state: [
    { h: 'Name', w: '34%', get: (r) => txt(r.name), strong: true, subject: true },
    { h: 'State', get: (r) => txt(r.state) },
    { h: 'Mortgages', get: (r) => count(r.mortgageCount), n: true, kind: 'num', raw: (r) => num(r.mortgageCount) },
    { h: 'Deeds', get: (r) => count(r.deedCount), n: true, kind: 'num', raw: (r) => num(r.deedCount) },
    { h: 'Payoffs', get: (r) => count(r.satisfactionCount), n: true, kind: 'num', raw: (r) => num(r.satisfactionCount) },
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


// ---------------------------------------------------------------------------
// THE DRILL-IN — one record, and everything the cache already knows about it
//
// THE WHOLE POINT IS THAT THIS COSTS NOTHING. Elementix allows 1,000 requests
// an hour across the WHOLE organisation, so a screen that fetched on every
// click would spend the office's allowance on browsing. But the rows we already
// hold carry the ids that join them to each other: a mortgage carries `deedId`
// and `satisfactionId`, a deed carries `mortgageId`, and every one of them
// carries the property's own address uuid. So "click a mortgage and you get the
// property, click the property and you get the lender" is a LOCAL join over
// rows already paid for — no call, no spinner, no waiting.
//
// PURE, and never inventive: a link it cannot resolve is simply absent. It must
// never present the WRONG deed beside a mortgage — a fabricated purchase price
// next to a real loan amount is a number somebody would act on.
// ---------------------------------------------------------------------------

/** Every row of a section of the cached profile, or []. */
export function rowsOfSection(profile, key) {
  const sec = profile && profile.sections && profile.sections[key];
  return (sec && Array.isArray(sec.rows)) ? sec.rows : [];
}

const idEq = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/** Find one row of a section by its own `id`. */
export function findById(profile, key, id) {
  if (!id) return null;
  return rowsOfSection(profile, key).find((r) => r && idEq(r.id, id)) || null;
}

/** Every row of a section that is about a given address uuid. */
export function rowsAtAddress(profile, key, addressId) {
  if (!addressId) return [];
  return rowsOfSection(profile, key).filter((r) => {
    if (addressIdOf(r) && idEq(addressIdOf(r), addressId)) return true;
    const ids = Array.isArray(r && r.addressesIds) ? r.addressesIds : [];
    if (ids.some((x) => idEq(x, addressId))) return true;
    for (const b of [r && r.propertyAddresses, r && r.property_addresses]) {
      if (Array.isArray(b) && b.some((a) => a && idEq(a.id, addressId))) return true;
    }
    return false;
  });
}

const nameKey = (v) => txt(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
export function lenderNamesAgree(directoryName, recordedName, aliasName) {
  const a = nameKey(directoryName);
  if (!a) return false;
  for (const other of [recordedName, aliasName]) {
    const b = nameKey(other);
    if (!b) continue;
    if (a === b || a.includes(b) || b.includes(a)) return true;
  }
  // Neither side named a lender at all: nothing to contradict, so the id stands.
  return !nameKey(recordedName) && !nameKey(aliasName);
}

/** Where a row says the property is, in as much detail as it carries. */
export function placeOf(row) {
  const line = addressOf(row);
  const bits = [];
  if (txt(row && row.city)) bits.push(txt(row.city));
  const county = txt(row && row.countyName);
  if (county) bits.push(/county/i.test(county) ? county : `${county} County`);
  const st = txt(row && (row.state || row.countyState));
  if (st) bits.push(st);
  const zip = txt(row && row.zipCode);
  if (zip) bits.push(zip);
  return { line: line || null, area: bits.length ? bits.join(', ') : null,
    lat: num(row && row.latitude), lng: num(row && row.longitude) };
}

/**
 * THE RECORD BEHIND A ROW.
 *
 * `kind` is the section the row was clicked in. The return shape is deliberately
 * flat and display-ready: the component draws it, it does not re-derive it.
 */
export function recordDetail(row, kind, profile) {
  if (!row || typeof row !== 'object') return null;
  const addressId = addressIdOf(row);
  const place = placeOf(row);

  // The three sibling records, resolved LOCALLY. `mortgage`/`deed` are the
  // row itself when the row is one of them.
  const mortgage = kind === 'mortgages' || kind === 'foreclosures' ? row
    : (kind === 'deeds' ? findById(profile, 'mortgages', row.mortgageId) : null);
  const deed = kind === 'deeds' ? row
    : findById(profile, 'deeds', row.deedId || (mortgage && mortgage.deedId));

  // The ownership record tells us the hold period and who holds it NOW, which
  // neither the mortgage nor the deed carries.
  const ownership = kind === 'properties' ? row
    : rowsAtAddress(profile, 'properties', addressId)[0] || null;

  /* THE LENDER ROLL-UP IS ONLY SHOWN WHEN THE TWO SIDES AGREE ABOUT WHO IT IS.
     The join is by id, which should be exact — but if the cached lender network
     and the mortgage row ever disagree about the name, printing "39 loans from
     CoreVest" under a mortgage recorded by Alpha Funding is a sentence somebody
     would repeat to a borrower. Containment is allowed because both names come
     from the SAME vendor for the SAME loan (a county records "Roc Capital"
     where the directory says "Roc Capital / Roc360"); this is a sanity check on
     our own join, never an identity matcher. Disagreement REFUSES rather than
     picks a side. */
  const lenderId = txt((mortgage && mortgage.lenderId) || '');
  const lenderRow = lenderId ? findById(profile, 'lender_network', lenderId) : null;
  const lender = lenderRow && lenderNamesAgree(lenderRow.name,
    (mortgage && mortgage.lenderName) || '', (mortgage && mortgage.lenderAliasName) || '') ? lenderRow : null;

  // Everything else recorded at this address, so the drill-in is the property's
  // story rather than one row of it. The row itself is never listed twice.
  const alsoMortgages = rowsAtAddress(profile, 'mortgages', addressId)
    .filter((r) => !(mortgage && idEq(r.id, mortgage.id)));
  const alsoDeeds = rowsAtAddress(profile, 'deeds', addressId)
    .filter((r) => !(deed && idEq(r.id, deed.id)));

  const entities = entityOf(row).length ? entityOf(row)
    : (entityOf(mortgage || {}).length ? entityOf(mortgage) : entityOf(ownership || {}));

  return {
    kind,
    addressId,
    place,
    entities,
    row, mortgage, deed, ownership, lender,
    alsoMortgages, alsoDeeds,
    url: urlOf(row),
    // The vendor's own ids, so a recorded instrument can be looked up at the
    // county by the number that is actually on it.
    countyDocumentId: txt((mortgage && mortgage.countyDocumentId) || (deed && deed.countyDocumentId)) || null,
    preforeclosureId: txt(mortgage && mortgage.preforeclosureId) || null,
    assignmentId: txt(mortgage && mortgage.assignmentId) || null,
    satisfactionId: txt(mortgage && mortgage.satisfactionId) || null,
  };
}

/** How long they held it, in plain words, or null when the dates cannot say. */
export function holdPeriod(startDate, endDate) {
  const a = ymd(startDate); const b = ymd(endDate);
  if (!a) return null;
  const end = b || null;
  if (!end) return null;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const months = ms / (1000 * 60 * 60 * 24 * 30.4375);
  if (months < 1) return `${Math.max(1, Math.round(ms / 86400000))} days`;
  if (months < 24) return `${months.toFixed(1).replace(/\.0$/, '')} months`;
  return `${(months / 12).toFixed(1).replace(/\.0$/, '')} years`;
}
