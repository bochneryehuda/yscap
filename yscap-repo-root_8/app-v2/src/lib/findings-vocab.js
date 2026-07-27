/* ONE dictionary of the words and colours an AI FINDING is described with.
 *
 * WHY THIS EXISTS. Three screens each kept their own private copy of this map
 * and they had already drifted apart:
 *   UnderwritingPanel.jsx  fatal → "Fatal"        info → --teal-deep, alpha .14
 *   AppraisalPanel.jsx     fatal → "Fatal"        info → --teal-deep, alpha .14
 *   StaffFindingEscalations.jsx  fatal → "Dealbreaker"  info → --teal, alpha .12
 * So the same finding was a "Fatal" on the file and a "Dealbreaker" on the
 * escalations screen, in two slightly different shades of teal.
 *
 * "Dealbreaker" wins because it is the plain-English word, and because the body
 * copy on those very screens already says it ("clear this dealbreaker", "note-
 * buyer dealbreaker"). "Fatal" was the raw database word leaking to the reader.
 *
 * Same pattern as lib/esign.js and lib/conditions-vocab.js: label + colours in
 * one place, imported everywhere, so the screens cannot drift again.
 *
 * NOTE ON COLOUR: `fg` here is a deliberate exception to the dark-text rule —
 * these are chip foregrounds on their own tinted `bg`, which is how all three
 * screens already used them. Never use --ink* tokens for text (they are LIGHT).
 */

/* document_findings.severity — fatal | warning | info (db/200_document_underwriting.sql).
   Shape is kept exactly as the three local copies had it (bg / fg / label) so
   every existing `SEV.fatal.fg` call site keeps working untouched. */
export const FINDING_SEVERITY = {
  fatal:   { bg: 'var(--crit-bg,#F6E7E4)',    fg: 'var(--crit,#B4483C)',       label: 'Dealbreaker' },
  warning: { bg: 'var(--amber-bg,#F6EEDD)',   fg: 'var(--amber,#B7791F)',      label: 'Warning' },
  info:    { bg: 'rgba(47,127,134,.14)',      fg: 'var(--teal-deep,#256168)',  label: 'Info' },
};

/* Worst-first, for sorting and for "show me the worst one" reads. */
export const FINDING_SEVERITIES = ['fatal', 'warning', 'info'];

/* The word for a stored severity. An unrecognised value degrades to "Info" —
   the quietest reading, so a surprise value never shouts red at a processor. */
export function severityLabel(severity) {
  const s = FINDING_SEVERITY[String(severity || '').trim()];
  return s ? s.label : FINDING_SEVERITY.info.label;
}

/* Plural-safe count phrase: severityCount(3,'fatal') → "3 dealbreakers". */
export function severityCount(n, severity) {
  const word = severityLabel(severity).toLowerCase();
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* document_findings.status — open | resolved | dismissed | superseded. */
export const FINDING_STATE = {
  open:       { label: 'Open' },
  resolved:   { label: 'Resolved' },
  dismissed:  { label: 'Dismissed' },
  superseded: { label: 'Replaced' },
};

export function findingStatusLabel(status) {
  const s = FINDING_STATE[String(status || '').trim()];
  return s ? s.label : FINDING_STATE.open.label;
}
