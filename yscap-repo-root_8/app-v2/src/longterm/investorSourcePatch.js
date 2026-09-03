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

/**
 * DOES THIS ROW CARRY A SETTING SOMEBODY SAVED — the question the "use the
 * pre-fill" control turns on, and the same one that KEEPS the row on the list.
 *
 * ⛔ THE SERVER ANSWERS IT (`carriesSetting`, from `investorSettings.carriesOwnSetting`,
 * the one definition), and this reads that answer. The four-origin derivation below is
 * the DEPLOY-WINDOW FALLBACK ONLY — a cached bundle against a newer server, or the
 * reverse — never a second opinion: a browser that judged for itself could offer to
 * remove a setting the server does not think is there, or hide the control on a row
 * whose setting is the only reason it is on screen.
 */
export function carriesSetting(row) {
  const r = row || {};
  if (typeof r.carriesSetting === 'boolean') return r.carriesSetting;
  return r.sourceOrigin === 'setting' || r.enabledOrigin === 'setting'
    || r.whiteLabelOrigin === 'setting' || r.holdbackOrigin === 'setting';
}

/**
 * HAS SOMEBODY ASKED TO TAKE THIS ROW BACK TO THE PRE-FILL?
 *
 * ⛔ EXACTLY `true`, never merely truthy. The edit object is spread from whatever the
 * screen last wrote, so a stray string would otherwise silently drop a saved setting
 * nobody asked to drop — and a dropped setting is invisible until somebody notices the
 * investor pricing differently.
 */
export function resetRequested(edit) {
  return !!edit && edit.reset === true;
}

/**
 * THE WHOLE ROW: what this settings row sends on a save, or `null` for "send nothing,
 * so it answers to the standing pre-fill".
 *
 * ⛔ IT LIVES HERE, NOT IN THE SCREEN, FOR THE REASON AT THE TOP OF THIS FILE. The
 * pre-merge audit of 2026-09-03 defeated a regex over the screen TWICE while fully
 * restoring the defect. This can be HANDED REAL ROWS and read back, so its test pins
 * what the rule ANSWERS rather than how it is spelled — and the screen's own copy is
 * one delegating line, which a regex CAN hold honestly.
 *
 * The three answers, in the order they are asked and the order they must stay in:
 *
 *   1. SOMEBODY ASKED FOR THE PRE-FILL → send nothing. Asked FIRST because asking makes
 *      the row touched, so any later "was this touched?" test would re-state the very
 *      setting the person is removing. The door replaces the whole map on every save, so
 *      omitting the row IS the removal — that is what makes an investor removable at all
 *      (owner-reported 2026-09-03: the list *"still shows investors that were removed"*).
 *   2. NOBODY HAS TOUCHED IT AND IT CARRIES NO SETTING → send nothing, so today's
 *      pre-fill is never pinned onto it for ever.
 *   3. OTHERWISE → the source and on/off from `sourcePatch`, plus a white label and a
 *      holdback when there is one to send. An EMPTY name and an empty holdback are
 *      omitted, never sent as `''`/`NaN`: the door reads an absent key as "no setting of
 *      its own for this", which is exactly what an empty box means.
 */
export function rowPatch(row, edit) {
  const r = row || {};
  const e = edit || null;
  if (resetRequested(e)) return null;
  if (!e && !carriesSetting(r)) return null;
  const out = sourcePatch(r, e);
  const wl = e && e.whiteLabel !== undefined ? e.whiteLabel : r.whiteLabel;
  if (wl != null && String(wl).trim() !== '') out.whiteLabel = String(wl).trim();
  const hbv = e && e.holdback !== undefined ? e.holdback : r.holdback;
  if (hbv !== undefined && hbv !== null && String(hbv) !== '') {
    const n = Number(hbv);
    if (Number.isFinite(n)) out.holdback = n;
  }
  return out;
}

/**
 * THE WHOLE SAVE, AS A MAP — every row's answer, plus how many settings this save
 * actually removes.
 *
 * ⛔ IT LIVES HERE FOR THE REASON AT THE TOP OF THIS FILE, AND THE PRE-MERGE AUDIT OF
 * 2026-09-03 PROVED THE POINT A SECOND TIME. Moving `rowPatch` out of the screen made
 * the RULE testable; the screen's own LOOP was still guarded only by a regex over its
 * source, and the audit defeated that regex while fully restoring the owner's defect —
 * one added line beside an untouched `patchOf` call put a row that had asked for the
 * pre-fill straight back into the map, so "use the pre-fill" became a button that does
 * nothing, with all three screen suites green and the bundle rebuilt. A regex can pin
 * how a caller is SPELLED; only running the loop can pin what the SAVE SENDS.
 *
 * ⛔ THE COUNT IS TAKEN FROM THE SAME QUESTION THE SAVE TURNS ON, never from the edits:
 * a reset on a row that carried no setting removes nothing, and saying it did would be
 * a confident wrong answer about what just happened to the list.
 */
export function mapForSave(rows, edits) {
  const list = Array.isArray(rows) ? rows : [];
  const e = edits || {};
  const map = {};
  let reset = 0;
  for (const r of list) {
    if (!r || !r.key) continue;
    if (resetRequested(e[r.key]) && carriesSetting(r)) reset += 1;
    const p = rowPatch(r, e[r.key]);
    if (p) map[r.key] = p;
  }
  return { map, reset };
}

/**
 * WOULD THIS ROW STILL BE ON THE LIST WITH NO SETTING OF ITS OWN — the question the
 * "use the pre-fill" warning answers, and the one it used to guess at.
 *
 * ⛔ IT IS THE SERVER'S `belongsOnSettingsList` WITH THE SETTING TAKEN AWAY, and it was
 * a SECOND, INCOMPLETE COPY of that rule: the screen tested `r.whiteLabel`, which is the
 * name the row is showing NOW — the setting's own name when a setting supplied it — so
 * it was wrong in both directions at once (measured, pre-merge audit 2026-09-03). A row a
 * rate sheet has actually produced was promised it would leave and STAYED, which is the
 * expensive direction and reads as a button that does not work; a row whose only name
 * came from the setting was promised nothing and LEFT, taking the typed name with it,
 * unannounced.
 *
 * The three reasons a row is kept are the server's: a white label off the RATE SHEET
 * (`prefill.whiteLabel`, which is what survives the removal), a sheet having actually
 * produced it, or a setting of its own — and it is that third one this question removes.
 * A browser twin is unavoidable (a screen cannot require server code, the `lib/payoff.js`
 * arrangement), so `test-lt-investor-sources-pure` runs this and the server's rule over
 * one battery and fails the moment they disagree.
 */
export function staysWithoutSetting(row) {
  const r = row || {};
  const pf = r.prefill || {};
  if (pf.whiteLabel) return true;
  const a = r.availability || {};
  for (const k of Object.keys(a)) if (a[k] && a[k].state === 'seen') return true;
  return false;
}
