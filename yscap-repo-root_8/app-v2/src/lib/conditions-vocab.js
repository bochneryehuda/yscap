/* ONE dictionary of the words and colours a CONDITION is described with.
 *
 * WHY THIS EXISTS. The same stored value was appearing under up to four
 * different names depending on where you stood. For `received` alone: the raw
 * database word in the staff status dropdown ("received"), a different word in
 * the borrower-conditions filter ("In review — not signed off"), a third in the
 * internal-conditions filter ("Submitted (in review)"), and a fourth on the
 * borrower's own screen ("Submitted"). A processor and a borrower could be
 * looking at one condition and describing it with two different words.
 *
 * This is the same pattern as lib/esign.js — which says in its own header that
 * it exists "so the two screens never drift" — applied to conditions. Import
 * the label; never print a raw status, and never write a fifth synonym inline.
 *
 * NOT to be confused with lib/conditionLabel.js, which is unrelated: that one
 * guards the add-a-condition box against a stray value (a ZIP, a phone number)
 * being saved as a condition title. Nothing here touches it.
 *
 * NOTE ON COLOUR: `dot` is for a dot/chip/border, never body text. Portal text
 * is dark on white; see the styles.css token trap (--ink* are LIGHT).
 */

/* ---------------------------------------------------------------------------
 * 1. checklist_items.status — the main conditions list, staff and borrower.
 *    The five values are the whole of the column (db/schema.sql).
 * ------------------------------------------------------------------------ */
export const CONDITION_STATE = {
  // Nothing submitted yet, and we have not asked for it.
  outstanding: { label: 'Not started',     cls: 'muted',  dot: '#4B585C' },
  // We have asked the borrower; the ball is with them.
  requested:   { label: 'Asked for',       cls: 'new',    dot: '#2F7F86' },
  // Something arrived and is waiting on a human to look at it.
  received:    { label: 'In review',       cls: 'gold',   dot: '#AE8746' },
  // Sent back — a document was rejected, or we need a corrected item.
  issue:       { label: 'Needs attention', cls: 'danger', dot: '#A32A2A' },
  // Complete: signed off, or waived. Terminal.
  satisfied:   { label: 'Done',            cls: 'ok',     dot: '#2E7A5E' },
};

/* The stored values, in the order a condition naturally travels through them.
   Replaces the hand-written arrays that used to be repeated per screen. */
export const CONDITION_STATUSES = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];

/* The word for a stored status. Unknown/blank never renders a raw database
   token or an empty chip — an unrecognised value degrades to the neutral
   "Not started", which is the honest reading of "no evidence this is underway". */
export function conditionStatusLabel(status) {
  const s = CONDITION_STATE[String(status || '').trim()];
  return s ? s.label : CONDITION_STATE.outstanding.label;
}

/* The dot/chip colour for a stored status. Same fallback rule as the label. */
export function conditionStatusDot(status) {
  const s = CONDITION_STATE[String(status || '').trim()];
  return s ? s.dot : CONDITION_STATE.outstanding.dot;
}

/* The CSS class for a status dot — `.dot.cond-*` in styles.css, which paints
   the five `dot` colours above from the brand tokens. Use this instead of an
   inline `style={{ background: ... }}`: before, five states shared two colours
   (gold "outstanding" / green "done") plus a red inline override, so "asked
   for" and "in review" were visually identical in a list of forty rows. */
export function conditionStatusClass(status) {
  const key = String(status || '').trim();
  return 'cond-' + (CONDITION_STATE[key] ? key : 'outstanding');
}

/* ---------------------------------------------------------------------------
 * 2. TIMING, not "severity".
 *
 * `conditions.severity` holds standard / prior_to_docs / prior_to_funding /
 * post_closing — a SCHEDULE (when it is due), not a danger level. Calling it
 * "severity" put it head-on with the findings vocabulary, where severity
 * genuinely means fatal/warning/info. Two different questions wearing one word
 * is the worst collision on the screen, so the reader is shown "Timing".
 *
 * The stored column keeps its name — this is what a human is shown, nothing more.
 * ------------------------------------------------------------------------ */
export const CONDITION_TIMING = {
  standard:          { label: 'Standard' },
  prior_to_docs:     { label: 'Before docs' },
  prior_to_funding:  { label: 'Before funding' },
  post_closing:      { label: 'After closing' },
};

export const CONDITION_TIMINGS = ['standard', 'prior_to_docs', 'prior_to_funding', 'post_closing'];

export function timingLabel(severity) {
  const t = CONDITION_TIMING[String(severity || '').trim()];
  return t ? t.label : CONDITION_TIMING.standard.label;
}

/* ---------------------------------------------------------------------------
 * 3. conditions.status — the separate underwriting-conditions table
 *    (db/022_conditions.sql). A different table with a different lifecycle, so
 *    it gets its own map rather than being forced into the five above.
 * ------------------------------------------------------------------------ */
export const LOAN_CONDITION_STATE = {
  open:               { label: 'Open',             cls: 'muted', dot: '#4B585C' },
  borrower_responded: { label: 'Borrower replied', cls: 'gold',  dot: '#AE8746' },
  cleared:            { label: 'Cleared',          cls: 'ok',    dot: '#2E7A5E' },
  waived:             { label: 'Waived',           cls: 'ok',    dot: '#2E7A5E' },
};

export function loanConditionStatusLabel(status) {
  const s = LOAN_CONDITION_STATE[String(status || '').trim()];
  return s ? s.label : LOAN_CONDITION_STATE.open.label;
}
