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
  borrower: { label: 'Borrower', field: 'borrower_name', sort: 'borrower' },
  property: { label: 'Property', field: 'property_address', sort: null },
  program: { label: 'Program', field: 'program_name', sort: null },
  loan_amount: { label: 'Amount', field: 'loan_amount', sort: 'loan_amount', align: 'right', kind: 'money' },
  note_rate: { label: 'Rate', field: 'note_rate_pct', sort: null, align: 'right', kind: 'pct' },
  dscr: { label: 'DSCR', field: 'dscr_ratio', sort: null, align: 'right', kind: 'ratio' },
  ltv: { label: 'LTV', field: 'ltv_pct', sort: null, align: 'right', kind: 'pct' },
  stage: { label: 'Stage', field: 'stage_key', sort: 'stage' },
  milestone: { label: 'Milestone', field: 'milestone_name', sort: 'milestone' },
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

  conditions: {
    label: 'Conditions',
    sort: null,
    available: false,
    why: 'The Condition Center is coming soon, so there is nothing to count yet.',
  },
};

/** The set shown when nobody has configured one. The plan's own list, minus what we cannot source. */
const DEFAULT_ORDER = [
  'loan_number', 'borrower', 'property', 'program', 'loan_amount', 'note_rate',
  'dscr', 'ltv', 'stage', 'milestone', 'days_in_stage', 'loan_officer',
  'processor', 'lock_status', 'expected_closing',
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
function resolveColumns(configured) {
  const asked = Array.isArray(configured) && configured.length
    ? configured.map((k) => String(k || '').trim()).filter(Boolean)
    : DEFAULT_ORDER;

  const columns = [];
  const unavailable = [];
  const unknown = [];

  for (const key of asked) {
    const def = COLUMNS[key];
    if (!def) { unknown.push(key); continue; }
    if (def.available === false) { unavailable.push({ key, label: def.label, why: def.why }); continue; }
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
    return { ...resolveColumns(DEFAULT_ORDER), unavailable, unknown, fellBack: true };
  }
  return { columns, unavailable, unknown, fellBack: false };
}

module.exports = { COLUMNS, DEFAULT_ORDER, resolveColumns };
