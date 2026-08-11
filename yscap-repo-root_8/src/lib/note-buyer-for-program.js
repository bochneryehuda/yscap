'use strict';

/**
 * THE REGISTERED PROGRAM CHOOSES THE NOTE BUYER (owner-directed 2026-08-06).
 *
 * The owner, asked how the note buyer should travel when a file is started from
 * the Term Sheet Generator: *"You already have knowledge of which program is
 * which note buyer. Whenever it's a manual program, you leave it untouched and
 * don't select the note buyer — you'll leave that selection for later. If
 * somebody selects the standard program, then use the note buyer for the
 * standard. It shouldn't be visible to anyone other than the staff, but you can
 * know how to select that. Just populate in our system: Fidelis for the
 * standard, Blue Lake for the gold, EMCAP for the silver. Manual should be an
 * open selection."*
 *
 * WHY THIS EXISTS. The Term Sheet Generator has no note-buyer field and is not
 * getting one — the pairing is already knowledge the backend holds, so a picker
 * would be a second place for it to live and a chance for the two to disagree.
 * Instead the note buyer is DERIVED at registration, which is the one moment a
 * file's program becomes a fact.
 *
 * THE PAIRING IS NOT RESTATED HERE. It is read from
 * `tapes/program-provider.providerForProgram` — the SAME table the non-admin
 * tape-export gate enforces (gold↔Blue Lake, standard↔Fidelis, silver↔EMCAP).
 * Deriving the note buyer from any other list would let a file be stamped with a
 * buyer whose tape it is then refused permission to export. MANUAL is
 * deliberately absent from that table ("a manual loan's program is not locked to
 * any one provider"), which is exactly the owner's "leave it untouched" — so
 * this module needs no manual special-case of its own beyond honouring the null.
 *
 * THE LABEL IS THE BUYER'S OWN REAL SPELLING, not the internal key. The key
 * ('fidelis') is not a value `applications.lender` ever holds; the production
 * labels are the ones the rest of the system already recognises — enumerated in
 * each tape module's `buyerAliases` and matched by `field-registry`'s
 * `isFidelisNoteBuyer` / `isEmcapNoteBuyer` and `normNoteBuyer`. Writing the
 * real label is what makes the derived buyer behave like a human-typed one
 * everywhere downstream: the note-buyer conditions attach, Blue Lake's 5% SOW
 * contingency turns on, the bank-statement month count is raised, and the file
 * can export its own tape. A label this module cannot verify is never written.
 */

const { providerForProgram } = require('./tapes/program-provider');
const { normNoteBuyer, NOTE_BUYER_CANONICAL_LABEL } = require('./conditions/field-registry');

/**
 * The buyer-key → the REAL note-buyer label to write onto the file.
 *
 * Each label is the owner's own production spelling (the ClickUp dropdown value the
 * rest of the system records) — and it is the SAME canonical label the note-buyer
 * PICKER offers, sourced from `field-registry.NOTE_BUYER_CANONICAL_LABEL` so "the one
 * we keep is linked everywhere" (owner-directed 2026-08-11): a Silver file's derived
 * EMCAP and a hand-picked EMCAP are byte-identical strings. They are asserted against
 * the live tape registry at module load — see `verifyLabels()` — so a label that
 * drifts out of step with the export gate cannot ship silently. Only the three
 * program-paired providers carry a derived label (manual is an open selection).
 */
const LABEL_FOR_PROVIDER = Object.freeze({
  fidelis: NOTE_BUYER_CANONICAL_LABEL.fidelis,
  bluelake: NOTE_BUYER_CANONICAL_LABEL.bluelake,
  emcap: NOTE_BUYER_CANONICAL_LABEL.emcap,
});

/**
 * The note buyer a freshly-registered program implies, or NULL when the program
 * does not imply one (MANUAL — an open selection the team makes later — and any
 * program not in the pairing table).
 *
 * PURE. Never throws.
 */
function noteBuyerForProgram(program) {
  try {
    const key = providerForProgram(program);
    if (!key) return null;                       // manual / unknown → untouched
    return LABEL_FOR_PROVIDER[key] || null;
  } catch (_) { return null; }
}

/**
 * SELF-CHECK, run at load: every label this module would write must be a
 * spelling its own tape module already recognises, or the derived buyer would
 * stamp a file that then cannot export its tape. Returns the list of problems
 * (empty when sound) rather than throwing — a require() that can crash the
 * server is never worth a consistency check. `test-note-buyer-for-program-pure`
 * asserts the list is empty, so a drift fails CI instead of production.
 */
function verifyLabels() {
  const problems = [];
  let tapes;
  // The registry directly (not ./tapes, which exposes it as a sub-object) — this
  // check is about the tape MODULES' own alias lists, so read them at the source.
  try { tapes = require('./tapes/registry').TAPES || []; } catch (e) { return [`tape registry unreadable: ${e.message}`]; }
  for (const [key, label] of Object.entries(LABEL_FOR_PROVIDER)) {
    const tape = tapes.find((t) => t && t.buyerKey === key);
    if (!tape) { problems.push(`no tape module for provider '${key}'`); continue; }
    const aliases = Array.isArray(tape.buyerAliases) ? tape.buyerAliases : [];
    const norm = normNoteBuyer(label);
    if (norm !== key && !aliases.includes(norm)) {
      problems.push(`label '${label}' (→ '${norm}') is not recognised by the ${key} tape (aliases: ${aliases.join(', ') || 'none'})`);
    }
  }
  return problems;
}

module.exports = {
  noteBuyerForProgram, verifyLabels,
  LABEL_FOR_PROVIDER,
};
