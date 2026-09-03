/**
 * WHAT ONE SETTINGS ROW SENDS — the rule, on its own, where a test can RUN it.
 *
 * ── WHY THIS IS A MODULE AND NOT A CLOSURE IN THE SCREEN ────────────────────
 * It was a closure in `LtInvestorSources.jsx`, guarded by a regex over that
 * screen's source. The pre-merge audit of 2026-09-03 defeated that guard TWICE
 * — `source: (!e && r.source && false) ? …` and a hoisted `const _keep = !e &&
 * r.source;` beside the old expression — each fully restoring the defect with
 * the suite reporting all 88 checks passed. A regex over the caller can only
 * ever pin the SPELLING of a rule; it cannot pin what the rule ANSWERS.
 *
 * So the rule lives here, is pure and import-free, and its test hands it real
 * rows and reads the real answers back. Same reasoning as `priceBuild.js` and
 * `cobrowseZoom.js`: a `.jsx` module can only be loaded by bundling it, and no
 * CI job installs the front end's build tools.
 *
 * ── THE TWO RULES IT HOLDS ─────────────────────────────────────────────────
 * ⛔ ONLY A PRESS OF THE SOURCE BUTTONS MAY CHANGE THE SOURCE. `both` is a real
 * stored value — the COMBINED engine's settings screen offers it and writes the
 * same key (`pricing.combinedInvestors`) — and this screen deliberately does not
 * offer it. A screen that does not offer a value must PASS IT THROUGH, never
 * translate it into the nearest one it knows.
 *
 * ⛔ AND THE TEST IS THE SOURCE, NOT THE ROW. Asking whether the ROW was edited
 * is a different question, and it was wrong three ways out of four (measured):
 * renaming an investor, changing its holdback, or switching it off each
 * re-routed a stored `both` to Lender Price, because none of them says anything
 * whatever about which sheet to price on. Switching OFF is not an answer to it
 * either — remembering the sheet an investor had is what lets turning it back
 * on restore what was there.
 */

/**
 * WHICH OF THE THREE BUTTONS IS LIT for a row, given the edit in hand.
 *
 * A row stored as `both` reads as the sheet it would take first; pressing any
 * button stores a real one-sheet answer. This decides only what is SHOWN — what
 * is SENT is `sourcePatch`, which does not translate.
 */
export function choiceOf(row, edit) {
  const r = row || {};
  const e = edit || {};
  if (e.choice) return e.choice;
  if (r.enabled === false) return 'off';
  return r.source === 'loannex' ? 'loannex' : 'lenderprice';
}

/**
 * THE `{source, enabled}` THIS ROW SENDS. `row` is the row as the server
 * describes it; `edit` is what the person changed, or undefined.
 *
 * The white label and the holdback are the caller's to add — they carry their
 * own emptiness rules and are not part of the question this module answers.
 */
export function sourcePatch(row, edit) {
  const r = row || {};
  const e = edit || null;
  const choice = choiceOf(r, e);
  // `choice` is what the buttons write, so `e.choice` is the ONLY evidence that a
  // person answered the which-sheet question. `'off'` answers a different one.
  const sourceAnswered = !!(e && e.choice !== undefined && e.choice !== 'off');
  return {
    source: sourceAnswered ? choice : (r.source || (choice === 'off' ? 'lenderprice' : choice)),
    enabled: choice !== 'off',
  };
}
