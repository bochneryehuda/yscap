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
 * 1b. THE DISPLAY STATE — a richer read than the raw status column, for the dot
 *     colour + the small status line (owner-directed 2026-08-05: "the small dot at
 *     the front should have better colors … at the bottom write the wording in very
 *     small text … you should be able to see from outside if this condition has
 *     documents in it, if it was rejected, if it was not accepted yet, pending
 *     acceptance, or pending sign-off after it was accepted").
 *
 *     The status column alone can't separate "a document is waiting to be reviewed"
 *     from "a document was accepted and now it just needs signing off" — both are
 *     `received` — and it can't fold in a rejected document. This computes, from the
 *     row PLUS its current documents, ONE state that decides the dot colour, a short
 *     status word, and the next step in plain language. Worst news first, so a
 *     rejected document is never hidden behind a later-arriving one.
 *
 *     Six colours (one more than the raw statuses): the extra one is `cond-accepted`
 *     (documents accepted, not yet signed off) — a distinct blue so it reads apart
 *     from "in review" (gold) and "signed off" (green).
 * ------------------------------------------------------------------------ */
export const CONDITION_DISPLAY = {
  outstanding: { cls: 'cond-outstanding', label: 'Not started',        next: 'Nothing submitted yet — this condition has not been started.' },
  requested:   { cls: 'cond-requested',   label: 'Asked the borrower',  next: 'We have asked the borrower; waiting on them to provide it.' },
  review:      { cls: 'cond-received',    label: 'To review',           next: 'A document is in and waiting for you to accept or reject it.' },
  accepted:    { cls: 'cond-accepted',    label: 'Accepted — sign off', next: 'The document is accepted; sign the condition off to complete it.' },
  rejected:    { cls: 'cond-issue',       label: 'Sent back',           next: 'A document was rejected — the borrower needs to send a corrected one.' },
  signed:      { cls: 'cond-satisfied',   label: 'Signed off',          next: 'Done — this condition is signed off.' },
  waived:      { cls: 'cond-satisfied',   label: 'Not required',        next: 'Cleared — this condition was marked not required.' },
};

/* Compute the display state from a condition row + its current documents.
   `docs` is the condition's documents (each with review_status + is_current). */
export function conditionDisplayState(it = {}, docs = []) {
  const list = Array.isArray(docs) ? docs.filter((d) => d && d.is_current !== false) : [];
  const awaiting = list.filter((d) => (d.review_status || 'pending') === 'pending');
  const accepted = list.filter((d) => d.review_status === 'accepted');
  const rejected = list.filter((d) => d.review_status === 'rejected');
  let key;
  if (it.waived_at) key = 'waived';
  else if (it.signed_off_at) key = 'signed';
  else if (it.status === 'issue' || rejected.length) key = 'rejected';   // worst news first
  else if (awaiting.length) key = 'review';
  else if (accepted.length) key = 'accepted';
  else if (it.status === 'requested') key = 'requested';
  else key = 'outstanding';
  const base = CONDITION_DISPLAY[key];
  const label = key === 'review' && awaiting.length > 1 ? `${awaiting.length} to review` : base.label;
  return { key, cls: base.cls, label, next: base.next, hasDocs: list.length > 0 };
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

/* ---------------------------------------------------------------------------
 * 4. WHO SEES IT — one stamp, replacing four raw-database chips.
 *
 * Owner-directed 2026-07-28, looking at a live condition: "you don't need to
 * have so much information, but maybe we can replace that into a nice modern
 * stamp saying if it's external, if it's external plus internal, or if it's
 * internal only — so we can track which condition is which. Externals would be
 * the borrower can also see it on their end; internal means only the staff
 * sees it."
 *
 * TWO answers, not three (owner-directed 2026-08-02, looking at the cash-out
 * letter stamped "External": "this condition says only external, but I don't
 * believe there is something like that. Because internal also sees it").
 * The owner is right: staff see EVERY condition on the staff side, so a stamp
 * reading plain "External" claims a visibility that does not exist. The stamp
 * answers exactly one question — can the borrower see it? — and that question
 * has two answers: "Internal + external" (stored audience borrower OR both;
 * identical label AND colour, because from the visibility standpoint they ARE
 * the same thing) and "Internal only" (audience staff). The borrower/both
 * difference is about who WORKS it, and lives in the authoring pickers and the
 * "borrower task" chips — never in this stamp.
 *
 * Every condition row used to carry up to four grey chips — Staff, Processor,
 * Document, Condition — which are the stored `audience`, `role_scope` and
 * `item_kind` columns printed verbatim. 46 of them across 24 conditions, none
 * of which changes what a person does next. This replaces the ONE that does
 * matter (can the borrower see this?) with a single stamp, and the other three
 * move into the condition's own detail where they cost nothing.
 *
 * Keyed on the stored `audience` values, which are unchanged — this is wording
 * and colour only.
 * ------------------------------------------------------------------------ */
export const CONDITION_AUDIENCE = {
  // Only the team. The borrower has no idea this condition exists.
  staff:    { label: 'Internal only', cls: 'aud-internal',
              title: 'Internal only — the borrower never sees this condition' },
  // The borrower's own list. This is what they are being asked for — and the
  // team always sees it here too, so it is never "external only".
  borrower: { label: 'Internal + external', cls: 'aud-external',
              title: 'Internal + external — the borrower sees this condition on their side, and the team sees it here too' },
  // Same visibility as `borrower` — the difference (the team also WORKS it) is
  // a workflow detail, so the stamp reads and looks identical on purpose.
  both:     { label: 'Internal + external', cls: 'aud-external',
              title: 'Internal + external — the borrower sees this condition on their side, and the team works it here too' },
};

export const CONDITION_AUDIENCES = ['staff', 'borrower', 'both'];

/* Unknown/blank falls back to INTERNAL — the safe direction. Claiming a
   condition is external when we are not sure would tell someone the borrower
   can see it when they cannot. */
export function audienceStamp(audience) {
  return CONDITION_AUDIENCE[String(audience || '').trim()] || CONDITION_AUDIENCE.staff;
}
export const audienceLabel = (a) => audienceStamp(a).label;
