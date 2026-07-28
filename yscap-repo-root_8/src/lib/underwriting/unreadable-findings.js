'use strict';
/**
 * "IF PILOT CAN'T READ IT, IT SHOULDN'T GIVE A FINDING" (owner-directed 2026-07-28; HARD RULE).
 *
 * THE DIRECTION, in the owner's words: "Rather want them to look deeper and if they can't read it
 * they should not give a finding — they should only give findings for stuff they KNOW that is wrong,
 * not for stuff that they can't read." The owner pointed at two real cards on the Coretex desk: a
 * "couldn't read this statement" note (a whole document PILOT couldn't read) and a "no seller name"
 * note (a document PILOT read fine, but one value it couldn't extract).
 *
 * THE CLASS. A "can't-read" finding is one whose entire content is "I could not read this document"
 * or "I could not find this value" — it asserts NOTHING is wrong, only that PILOT itself came up
 * empty. That is noise on the desk: the human underwriter reviews the actual document anyway, and a
 * value PILOT couldn't extract is not evidence of a problem. The owner wants those gone; only
 * findings that name a REAL discrepancy (a mismatch, a math error, a fraud signal) stay.
 *
 * WHAT STILL HAPPENS (the "look deeper" half is not lost). Suppressing the finding does NOT close the
 * document out. An unreadable document sets `document_extractions.confidence='unreadable'`, which
 * `completeness.statusFor` turns into `'insufficient'` — so the document keeps showing as
 * NOT-YET-READ in the "documents to read" queue and keeps getting chased for a clearer copy, entirely
 * INDEPENDENTLY of any finding. This module never touches that signal (it only ever removes
 * warning/info findings, never the extraction's confidence/status), so the document is still pursued;
 * PILOT just stops nagging with a finding about what it couldn't read.
 *
 * SAFETY. The predicate is purely on the finding's CODE, and it NEVER suppresses a DEALBREAKER —
 * neither a `fatal` finding nor one that explicitly blocks clear-to-close (`blocks_ctc`) — so if a
 * read-failure code is ever promoted to a dealbreaker, or a higher-bar can't-read finding from another
 * desk is ever routed through here, it is still shown. In the document_findings pipeline (the only
 * place this runs today) every can't-read code is `warning`/`info` and `blocksCtc:false`, so
 * suppression can change no completeness status and block nothing.
 *
 * ONE SWITCH, so bringing them back is an env change and not an archaeology project:
 * `UW_UNREADABLE_FINDINGS_SHOW=1` restores the findings everywhere this module is consulted (both the
 * persist chokepoint in store.saveAnalysis and the file-view display filter). Default (unset) =
 * SUPPRESSED. Read at CALL time, never cached at require time.
 *
 * Pure + dependency-free (no pg, no config) so every consumer can require it.
 */

// Value-level "couldn't find this value" codes that do NOT end in `_unreadable` — enumerated
// explicitly. (The `*_unreadable` family — every doc-level "couldn't read the document" code plus
// `contract_seller_unreadable` / `title_seller_unreadable` / `background_screened_parties_unreadable`
// — is caught by the suffix test below, so it is deliberately NOT repeated here.)
const CANT_READ_CODES = new Set([
  // The engine's own "this document could not be read or understood automatically."
  'needs_manual_review',
  // A read value PILOT could not confirm in the document's own text (a possible mis-read) — noise
  // about PILOT's own read quality, not a fact about the file.
  'values_unconfirmed_in_document',
  // A readable bank statement whose ending (closing) balance PILOT could not locate.
  'bank_no_ending_balance',
  // A voided check whose routing / account number PILOT could not read.
  'voided_check_no_routing',
  'voided_check_no_account',
]);

/**
 * Is this finding purely "PILOT couldn't read / couldn't find a value"? Code-only + fatal-guarded so
 * it can never hide a real dealbreaker.
 * @param {{code?: string, severity?: string}} f
 */
function isCantReadFinding(f) {
  if (!f || f.code == null) return false;
  // Never hide a DEALBREAKER, even if its code looks like a read-failure — neither a `fatal` nor a
  // finding that explicitly blocks clear-to-close. In the document_findings pipeline (the only place
  // this partition runs today) every can't-read code is warning/info with blocksCtc:false, so this
  // guard changes nothing there. It is a structural guard for a can't-read code emitted elsewhere at a
  // higher bar (e.g. the APPRAISAL desk's `appraisal_as_is_unreadable` is warning + blocks_ctc:true,
  // and `arv_unreadable` is fatal) ever being routed through this partition — such a finding must
  // never be silently dropped.
  if (String(f.severity || 'warning') === 'fatal') return false;
  if (f.blocks_ctc === true || f.blocksCtc === true) return false;
  const code = String(f.code);
  if (/_unreadable$/.test(code)) return true;   // the whole `*_unreadable` family (doc- and value-level)
  return CANT_READ_CODES.has(code);
}

/** The owner's escape hatch: default SUPPRESS; `UW_UNREADABLE_FINDINGS_SHOW=1` brings them back. */
function suppressing() {
  return String(process.env.UW_UNREADABLE_FINDINGS_SHOW == null ? '' : process.env.UW_UNREADABLE_FINDINGS_SHOW)
    .trim() !== '1';
}

/**
 * Split a list of findings into the ones to keep and the can't-read ones to suppress. Honors the
 * switch: when suppression is OFF, everything is kept and `suppressed` is empty. Never throws; a
 * non-array yields empty buckets.
 * @param {Array<object>} findings
 * @returns {{ kept: object[], suppressed: object[] }}
 */
function partition(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (!suppressing()) return { kept: list.slice(), suppressed: [] };
  const kept = [];
  const suppressed = [];
  for (const f of list) {
    if (isCantReadFinding(f)) suppressed.push(f);
    else kept.push(f);
  }
  return { kept, suppressed };
}

/**
 * A SQL boolean that is TRUE for a can't-read finding ROW — for `... AND NOT <this>` on a query over
 * `document_findings`, kept in lock-step with `isCantReadFinding` (same code set, same `_unreadable`
 * suffix, same dealbreaker guard: never a fatal, never a CTC-blocker). The CALLER decides whether to
 * apply it — gate on `suppressing()` so the escape hatch stays honored on the SQL side too. `alias` is
 * the table alias (e.g. 'df'); omit for an unaliased column. The codes are compile-time constants
 * (`[a-z_]`), so inlining them cannot inject; `alias` is sanitized to identifier characters.
 */
function sqlIsCantRead(alias) {
  const p = alias ? `${String(alias).replace(/[^A-Za-z0-9_]/g, '')}.` : '';
  const codes = [...CANT_READ_CODES].map((c) => `'${c}'`).join(', ');
  return `(${p}severity <> 'fatal' AND ${p}blocks_ctc IS NOT TRUE`
    + ` AND (${p}code ~ '_unreadable$' OR ${p}code IN (${codes})))`;
}

module.exports = { isCantReadFinding, suppressing, partition, sqlIsCantRead, CANT_READ_CODES };
