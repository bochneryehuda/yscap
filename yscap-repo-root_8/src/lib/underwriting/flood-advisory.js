'use strict';
/**
 * Flood-certificate condition ADVISORY signal (IG-W9, owner-directed 2026-07-24).
 *
 * The "Flood certificate" condition (rtl_cond_flood) asks the team to upload the
 * life-of-loan FEMA flood-zone determination for the property. PILOT NEVER signs this
 * condition off itself — a human always clears a Condition Center condition (the
 * owner-directed reversal). Instead PILOT lays an ADVISORY on top of the human layer
 * (pilot-advice-engine), telling the processor whether the flood determination is on
 * file and reads clean. Advisory only — this clears nothing and blocks nothing.
 *
 * "PILOT has confirmed the flood determination" is a strict, provable state, never a
 * guess — mirroring the contract/gov-ID completeness pattern:
 *   - a CURRENT, analyzed, readable `flood` extraction exists for THIS application
 *     (status='analyzed', not superseded, confidence not 'unreadable') — i.e. PILOT
 *     actually read the flood determination on this file; AND
 *   - there is ZERO open FATAL `flood` finding — the fatal from the flood review is
 *     `flood_insurance_required` (the property sits in a Special Flood Hazard Area and
 *     no flood policy is on file), which is exactly the reason a human would revisit a
 *     flood condition that looked cleared.
 *
 * So "ready" only ever fires once the determination is actually read + clean; a missing
 * or unread determination advises "not ready" (never a false "ready"). Never throws.
 */

// The flood review's finding source — an open FATAL here is the dispute/contradiction
// signal (see doc-checks.computeFloodFindings, which emits mk('flood', …)).
const FLOOD_FINDING_SOURCES = ['flood'];

/**
 * Has PILOT read the flood determination on THIS file, and is it clean (no open fatal
 * flood finding)?
 * @returns {Promise<{floodRead:boolean, openFatal:number, complete:boolean}>}
 */
async function floodCompleteness(client, appId) {
  const out = { floodRead: false, openFatal: 0, complete: false };
  if (!appId) return out;
  try {
    const r = await client.query(
      `SELECT 1 FROM document_extractions ex
        WHERE ex.application_id = $1 AND ex.doc_type = 'flood'
          AND ex.is_current = true AND ex.superseded = false
          AND ex.status = 'analyzed' AND COALESCE(ex.confidence,'') <> 'unreadable'
        LIMIT 1`, [appId]);
    out.floodRead = !!r.rows[0];

    const fr = await client.query(
      `SELECT count(*)::int AS n FROM document_findings f
        WHERE f.application_id = $1 AND f.status = 'open'
          AND f.severity = 'fatal' AND f.source = ANY($2)`, [appId, FLOOD_FINDING_SOURCES]);
    out.openFatal = (fr.rows[0] && fr.rows[0].n) || 0;

    out.complete = out.floodRead && out.openFatal === 0;
  } catch (e) {
    console.error('[flood-advisory] floodCompleteness', appId, e && e.message);
  }
  return out;
}

module.exports = { floodCompleteness, FLOOD_FINDING_SOURCES };
