'use strict';
/**
 * LONG-TERM — which columns the pipeline shows, and in what order.
 *
 * The plan names the set (§4.1) and adds the rule that makes it sellable: "every one
 * of them settings-driven so a buyer can change the set". `pipeline.columns` has
 * existed as a declared setting since db/553 and NOTHING READ IT — the screen
 * hard-coded nine columns while the setting named fifteen. So a buyer could change
 * the columns and nothing would happen, which is worse than offering no control at
 * all: a dead switch teaches people the system ignores them.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * A COLUMN WE CANNOT SOURCE IS DROPPED AND REPORTED — NEVER RENDERED EMPTY.
 *
 * `expected_closing` is in the setting's own default and there is no closing date on
 * `lt_loans` to fill it. Rendering it anyway would put a column of dashes on every
 * row of every long-term loan forever, which reads as "we failed to fetch this"
 * rather than "we do not hold it" — the exact confident blank this side keeps
 * finding. So an unsourceable column is left OUT of the rendered set and named in
 * `unavailable`, with a reason a person can read.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE SETTING NEVER BECOMES SQL. The query selects the same fixed set of expressions
 * every time and the setting decides only what the SCREEN draws, in what order.
 * Building a SELECT list out of a stored setting would put a value an administrator
 * types into the query text, and would give the planner a different statement per
 * configuration; the rows here are small and the whole point is presentation.
 *
 * PURE — no database, no requires.
 */

/**
 * Every column the pipeline can draw.
 *
 * `available:false` means the data does not exist to fill it, with `why` in plain
 * words. `sort` names the key `SORTABLE` in pipeline.js accepts, or null when the
 * column cannot be ordered on.
 *
 * `field` NAMES THE KEY ON THE ROW the column reads — because the screen must not
 * carry its own map of column-to-column. A table repeated on both sides is a table
 * that eventually disagrees with itself, and the disagreement shows up as an "LTV"
 * heading over a rate. For a `contact` column the field is the CONTACT ROLE; for
 * `lock` and `milestone_days` the cell reads several fields together and the name is
 * the leading one.
 */
const COLUMNS = {
  loan_number: { label: 'Loan #', field: 'loan_number', sort: 'loan_number', emphasis: true },
  // `borrower`, not the default text cell: the value is the LINKED PILOT profile's
  // name when there is one and the name on the Encompass loan otherwise, and the
  // cell says which of the two it is drawing. An unconfirmed name must never pass
  // for a confirmed one — see the note on the SELECT in pipeline.js.
  borrower: { label: 'Borrower', field: 'borrower_name', sort: 'borrower', kind: 'borrower' },
  property: { label: 'Property', field: 'property_address', sort: null },
  program: { label: 'Program', field: 'program_name', sort: null },
  loan_amount: { label: 'Amount', field: 'loan_amount', sort: 'loan_amount', align: 'right', kind: 'money' },
  note_rate: { label: 'Rate', field: 'note_rate_pct', sort: null, align: 'right', kind: 'pct' },
  // `dscr`, not `ratio`: the figure is drawn beside which side of THIS COMPANY'S
  // own minimum and comfortable lines it fell on. A bare 1.28 down a column means
  // one thing to somebody who works these loans every day and nothing to anybody
  // else, and the thresholds have been a setting since the registry was written.
  // The verdict is computed on the SERVER by the one rule the file screen uses, so
  // the two surfaces can never call the same loan different things.
  dscr: { label: 'DSCR', field: 'dscr_ratio', sort: null, align: 'right', kind: 'dscr' },
  ltv: { label: 'LTV', field: 'ltv_pct', sort: null, align: 'right', kind: 'pct' },
  stage: { label: 'Stage', field: 'stage_key', sort: 'stage' },
  // The completed-form label (owner-directed 2026-08-24: "Funded", never
  // "Funding") — decorated onto every row by pipeline.js loadPipeline from
  // milestone_name, so `source:'route'`: the query does not SELECT it.
  milestone: { label: 'Milestone', field: 'milestone_label', sort: 'milestone', source: 'route' },
  // The plan calls this "Days in milestone". It is blank on a loan PILOT only ever
  // baselined — see milestones.js; the clock refuses to age a first sighting.
  days_in_stage: { label: 'At milestone', field: 'milestone_days', sort: 'milestone_since', align: 'right', kind: 'milestone_days' },
  loan_officer: { label: 'Loan officer', field: 'loan_officer', sort: null, kind: 'contact' },
  processor: { label: 'Processor', field: 'processor', sort: null, kind: 'contact' },
  lock_status: { label: 'Lock', field: 'lock_status', sort: 'lock_expiration', kind: 'lock' },
  updated: { label: 'Updated', field: 'encompass_last_modified', sort: 'last_modified', kind: 'day' },

  expected_closing: {
    label: 'Expected closing',
    sort: null,
    available: false,
    why: 'Encompass has not given us a closing date on the long-term loan yet, so this column has nothing to fill it.',
  },

  // WHAT IS OUTSTANDING ON THIS FILE — drawable only while the Condition Center is
  // SWITCHED ON. The mirror is empty until it is, so the column would print a zero
  // on every row, and a zero here reads as "this file is clear" — a claim, not a
  // blank. So its availability is a QUESTION asked of the settings at resolve time
  // rather than a constant, and the reason names the switch.
  conditions: {
    label: 'Conditions',
    field: 'outstanding',
    sort: null,
    align: 'right',
    kind: 'outstanding',
    needs: 'conditions',
    // The ONLY column whose field the pipeline query does not select: the counts
    // are attached to the rows by the ROUTE, because what "outstanding" means is a
    // rule that lives in the Condition Center and a SQL predicate here would be a
    // second copy of it. Declared rather than left implicit, so the guard that
    // catches a field naming a column the SELECT never returns — a dash on every
    // row for ever, with nothing failing anywhere — still has something to check.
    source: 'route',
    why: 'The Condition Center is switched off, so nothing has been read and there is nothing to count.',
  },
};

/** The set shown when nobody has configured one. The plan's own list, minus what we cannot source. */
const DEFAULT_ORDER = [
  'loan_number', 'borrower', 'property', 'program', 'loan_amount', 'note_rate',
  'dscr', 'ltv', 'stage', 'milestone', 'days_in_stage', 'loan_officer',
  'processor', 'conditions', 'lock_status', 'expected_closing',
];

/**
 * Turn the setting into the columns a screen should draw.
 *
 * Returns `{ columns, unavailable, unknown }`:
 *   · `columns`     — in the configured order, each with everything the screen needs.
 *   · `unavailable` — configured, real, but with no data behind it, and WHY.
 *   · `unknown`     — a key nobody declared. Named rather than ignored, because a
 *                     typo that silently disappears looks exactly like a saved
 *                     setting that did not save.
 *
 * A configuration that leaves NOTHING drawable falls back to the default rather than
 * rendering a table with no columns — an empty grid is not a thing anybody chose.
 */
function resolveColumns(configured, opts = {}) {
  const asked = Array.isArray(configured) && configured.length
    ? configured.map((k) => String(k || '').trim()).filter(Boolean)
    : DEFAULT_ORDER;

  const columns = [];
  const unavailable = [];
  const unknown = [];

  // A column whose data exists only when a feature is on. `true` is required, not
  // merely "not false": with the flag unread — a settings load that failed, an
  // older caller that passes nothing — the answer is OFF, which draws one column
  // fewer rather than a column of confident zeros.
  const have = (need) => (need === 'conditions' ? opts.conditionsEnabled === true : true);

  for (const key of asked) {
    const def = COLUMNS[key];
    if (!def) { unknown.push(key); continue; }
    if (def.available === false || !have(def.needs)) {
      unavailable.push({ key, label: def.label, why: def.why });
      continue;
    }
    if (columns.some((c) => c.key === key)) continue;   // a list naming one column twice draws it once
    columns.push({
      key,
      label: def.label,
      field: def.field || key,
      sort: def.sort || null,
      align: def.align || 'left',
      kind: def.kind || 'text',
      emphasis: def.emphasis === true,
    });
  }

  if (!columns.length) {
    return { ...resolveColumns(DEFAULT_ORDER, opts), unavailable, unknown, fellBack: true };
  }
  return { columns, unavailable, unknown, fellBack: false };
}

module.exports = { COLUMNS, DEFAULT_ORDER, resolveColumns };
