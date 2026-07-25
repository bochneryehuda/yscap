'use strict';
/**
 * PILOT ADVISORY overlay on Condition Center conditions (owner-directed 2026-07-24).
 *
 * THE RULE: PILOT must NEVER sign off / clear a real Condition Center condition itself — a
 * human always clears it. Instead PILOT lays an ADVISORY on top of the human layer, on
 * EVERY condition it can judge (open OR already signed off):
 *
 *   VERDICT.READY      ('ready')     — open, PILOT verified it is met → ready to clear
 *   VERDICT.NOT_READY  ('not_ready') — open, PILOT still needs something first
 *   VERDICT.AGREE      ('agree')     — signed off, PILOT confirms it was cleared correctly
 *   VERDICT.DISPUTE    ('dispute')   — signed off, but PILOT found evidence it should NOT be
 *   (null)                           — PILOT has no advisory for this condition
 *
 * The advisory is INDEPENDENT of the sign-off status — it works on a signed-off condition
 * too (that is the whole point of AGREE / DISPUTE). It NEVER touches status / signed_off_* —
 * the human still clears (or un-clears) the condition.
 *
 * (PILOT's OWN findings — AI / document-review / investor-guideline findings — are a
 * different thing and MAY be auto-resolved by PILOT with a note; that lives in the
 * document_findings / ai_suggestions layer, not here.)
 *
 * Gated on cfg.pilotReadyStampEnabled (default ON — the advisory clears nothing, so it is
 * safe on). Never throws (best-effort — an advisory must never break an upload / import).
 */
const cfg = require('../../config');

const VERDICT = Object.freeze({
  READY: 'ready', NOT_READY: 'not_ready', AGREE: 'agree', DISPUTE: 'dispute',
});
const VERDICTS = Object.freeze(Object.values(VERDICT));

/**
 * Pure: PILOT's verdict for one condition, given whether PILOT thinks it is met
 * (`complete`), whether PILOT has POSITIVE evidence it is NOT met (`contradicted` — e.g. an
 * open fatal finding, a failed verification), and whether a human has signed it off.
 *   - A DISPUTE is only ever raised on real contradicting evidence, never on mere absence of
 *     data — a correctly-signed-off condition PILOT simply can't confirm gets no advisory.
 * Returns a VERDICT string or null (no advisory).
 */
function verdictFor(complete, contradicted, signedOff) {
  if (signedOff) {
    if (contradicted) return VERDICT.DISPUTE;
    if (complete) return VERDICT.AGREE;
    return null;                       // can't confirm — but no positive contradiction → silent
  }
  // Open. PILOT only runs an evaluator for a condition it CAN judge, so an open condition
  // that reaches here always gets an advisory (owner-directed: advise on EVERY condition):
  // verified → ready, otherwise → not_ready ("PILOT hasn't confirmed this yet").
  return complete ? VERDICT.READY : VERDICT.NOT_READY;
}

/**
 * Set (or refresh) PILOT's advisory on a condition. verdict null/'' clears it. ADVISORY
 * ONLY — never changes status or signs off. Works on a signed-off condition too.
 * @returns {Promise<boolean>} true if a row was written.
 */
async function setAdvice(client, itemId, verdict, note) {
  try {
    if (!cfg.pilotReadyStampEnabled || !itemId) return false;
    if (!verdict) return clearAdvice(client, itemId);
    if (!VERDICTS.includes(verdict)) return false;
    const r = await client.query(
      `UPDATE checklist_items
          SET pilot_advice = $2, pilot_advice_note = $3, pilot_advice_at = now(),
              updated_at = now()
        WHERE id = $1
          AND (pilot_advice IS DISTINCT FROM $2 OR COALESCE(pilot_advice_note,'') <> COALESCE($3,''))
        RETURNING id`, [itemId, verdict, note || null]);
    return !!r.rows[0];
  } catch (e) {
    console.error('[pilot-advice] setAdvice', itemId, e && e.message);
    return false;
  }
}

/** Remove PILOT's advisory from a condition. Never touches status/sign-off. */
async function clearAdvice(client, itemId) {
  try {
    if (!itemId) return false;
    const r = await client.query(
      `UPDATE checklist_items
          SET pilot_advice = NULL, pilot_advice_note = NULL, pilot_advice_at = NULL,
              updated_at = now()
        WHERE id = $1 AND pilot_advice IS NOT NULL
        RETURNING id`, [itemId]);
    return !!r.rows[0];
  } catch (e) {
    console.error('[pilot-advice] clearAdvice', itemId, e && e.message);
    return false;
  }
}

module.exports = { VERDICT, VERDICTS, verdictFor, setAdvice, clearAdvice };
