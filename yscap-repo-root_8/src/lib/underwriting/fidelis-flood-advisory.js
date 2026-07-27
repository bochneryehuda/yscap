'use strict';
/**
 * FIDELIS flood-zone ADVISORY (owner-directed 2026-07-27).
 *
 * THE RULE. A Fidelis Investors file does NOT carry the internal flood-certificate
 * condition. The condition itself (`rtl_cond_flood`, db/177) is unchanged for every
 * other capital partner — db/333 simply wraps its rule so it never attaches when the
 * note buyer is Fidelis (`note_buyer_is_fidelis`, any label spelling). The owner's
 * words: "for Fidelis files that condition should automatically not populate."
 *
 * THE EXCEPTION, AND WHY IT IS AN ADVISORY. If the property turns out to sit in a
 * flood zone, that matters on a Fidelis file too — but per the governing HARD RULE
 * (2026-07-22) the AI never creates a condition. So this raises an `ai_suggestions`
 * row on the file's AI Findings panel with a one-click "create the flood certificate
 * condition" action, and a human decides. Advisory only: it posts nothing, clears
 * nothing, blocks nothing, and touches no frozen number.
 *
 * WHERE THE FLOOD ZONE COMES FROM — exactly the two sources the owner named, read off
 * the file's CURRENT appraisal row (the same derivation as the conditions engine's
 * `in_flood_zone`, so PILOT never disagrees with itself about whether a file is in a
 * flood zone):
 *   · FEMA          — `appraisals.fema_flood_sfha` (the official Special Flood Hazard
 *                     Area flag from the FEMA cross-check), or an "A"/"V" `fema_flood_zone`;
 *   · the appraisal — `appraisals.flood_zone`, the appraiser's own stated zone, "A"/"V".
 * PROVEN-ONLY: no appraisal, or an all-NULL determination, raises NOTHING (never a
 * guessed flood zone). A concrete non-A/V zone ("X") is a real "not in a flood zone"
 * and also raises nothing.
 *
 * QUIET BY CONSTRUCTION. The advisory is withdrawn on its own when it stops being
 * true (the note buyer changes away, the flood signal goes, or a flood condition is
 * now on the file), and it is NEVER re-raised once a human has decided on it —
 * `aiSug.record` can only refresh an `open` row, so without that guard a Dismiss
 * would come back on the next file view forever (the same trap desk-sync documents).
 * Severity is `warning`, not `fatal`, so it does not fan out the fatal-finding email
 * to the whole file team; `important` pins it to the top of the panel instead.
 *
 * Never throws — every entry point is guarded. Test: scripts/test-fidelis-flood-advisory-db.js.
 */

const aiSug = require('./ai-suggestions');
const { isFidelisNoteBuyer } = require('../conditions/field-registry');

const SOURCE = 'fidelis_flood_zone';
const FLOOD_TEMPLATE_CODE = 'rtl_cond_flood';
const DEDUPE_KEY = `fidelis-flood:${FLOOD_TEMPLATE_CODE}`;

// The engine's own OPEN_STATUSES (conditions/engine.js) — a terminal or intake-stage
// file is frozen, so no advisory is raised on it.
const OPEN_STATUSES = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close'];

// An A* or V* zone is a Special Flood Hazard Area. Same test as engine.loadRuleContext.
const isSfhaZone = (z) => /^(A|V)/.test(String(z || '').trim().toUpperCase());

/**
 * The file's flood-zone evidence from its CURRENT appraisal. PROVEN-ONLY.
 * @returns {Promise<{inFloodZone:boolean, femaSfha:(boolean|null), femaZone:(string|null),
 *                    appraisalZone:(string|null), sources:string[], checked:boolean}>}
 *   checked=false means there was nothing to read (no appraisal / read failed) — the
 *   caller treats that as "no flood zone proven", never as "not in a flood zone".
 */
async function floodZoneEvidence(client, appId) {
  const out = {
    inFloodZone: false, femaSfha: null, femaZone: null, appraisalZone: null,
    sources: [], checked: false,
  };
  if (!client || !appId) return out;
  try {
    const r = await client.query(
      `SELECT fema_flood_sfha, fema_flood_zone, flood_zone
         FROM appraisals
        WHERE application_id = $1 AND superseded = false
        ORDER BY imported_at DESC NULLS LAST, id DESC LIMIT 1`, [appId]);
    const row = r.rows[0];
    if (!row) return out;
    out.checked = true;
    out.femaSfha = row.fema_flood_sfha === true ? true : (row.fema_flood_sfha === false ? false : null);
    out.femaZone = row.fema_flood_zone || null;
    out.appraisalZone = row.flood_zone || null;
    // FEMA: the official SFHA flag, or a FEMA-mapped A*/V* zone.
    if (out.femaSfha === true || isSfhaZone(out.femaZone)) out.sources.push('fema');
    // The appraisal report: the appraiser's own stated zone.
    if (isSfhaZone(out.appraisalZone)) out.sources.push('appraisal');
    out.inFloodZone = out.sources.length > 0;
  } catch (e) {
    console.error('[fidelis-flood-advisory] floodZoneEvidence', appId, e && e.message);
  }
  return out;
}

/** Plain-language "where we saw it" for the advisory body. */
function whereFound(ev) {
  const bits = [];
  if (ev.sources.includes('fema')) {
    bits.push(ev.femaZone
      ? `the FEMA flood map (zone ${ev.femaZone})`
      : 'the FEMA flood map (Special Flood Hazard Area)');
  }
  if (ev.sources.includes('appraisal')) {
    bits.push(`the appraisal report (zone ${ev.appraisalZone})`);
  }
  return bits.length === 2 ? `${bits[0]} and ${bits[1]}` : (bits[0] || 'the file');
}

/**
 * The state of the flood-certificate condition on this file. Three outcomes matter, because
 * they need three different advisories:
 *   · absent            — nothing on the file → advise OPENING one (the main case).
 *   · settled           — signed off / waived / satisfied → a human already dealt with the
 *                         flood determination; never nag about settled work.
 *   · open + OPTIONAL   — the gap this closes. db/333 downgrades a touched flood cert on a
 *                         Fidelis file to `is_required = false` (signable with nothing
 *                         attached) *because no flood zone was known at the time*. If a flood
 *                         zone turns up LATER, that condition is still sitting there optional
 *                         and could be cleared empty with nobody told — which is exactly the
 *                         case the owner asked to be warned about. So it gets its own advisory.
 *   · open + REQUIRED   — the condition is already doing its job; stay quiet.
 * @returns {Promise<{present:boolean, settled:boolean, optionalOpen:boolean, itemId:(string|null),
 *                    readFailed:boolean}>}
 */
async function floodConditionState(client, appId) {
  const out = { present: false, settled: false, optionalOpen: false, itemId: null, readFailed: false };
  try {
    const r = await client.query(
      `SELECT ci.id, ci.is_required, ci.status, ci.signed_off_at, ci.waived_at
         FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id = $1 AND t.code = $2
        ORDER BY ci.created_at LIMIT 1`, [appId, FLOOD_TEMPLATE_CODE]);
    const row = r.rows[0];
    if (!row) return out;
    out.present = true;
    out.itemId = row.id;
    out.settled = !!row.signed_off_at || !!row.waived_at
      || ['received', 'satisfied'].includes(String(row.status || ''));
    out.optionalOpen = !out.settled && row.is_required === false;
    return out;
  } catch (_) {
    // Fail CLOSED on a read error: if we can't tell what is on the file, stay quiet rather
    // than advise opening a duplicate condition.
    out.readFailed = true;
    out.present = true;
    return out;
  }
}

/**
 * Has a human already acted on this advisory on this file? `aiSug.record`'s dedupe
 * only refreshes a row while it is `status='open'`, so ANY non-open row means a
 * person decided (dismissed / noted / converted / escalated / marked important /
 * asked the super-admin) and the advisory must not be re-inserted — otherwise a
 * Dismiss silently comes back on the next file view, forever.
 */
async function decidedByHuman(client, appId) {
  try {
    const r = await client.query(
      `SELECT 1 FROM ai_suggestions
        WHERE application_id = $1 AND source = $2 AND dedupe_key = $3 AND status <> 'open'
        LIMIT 1`, [appId, SOURCE, DEDUPE_KEY]);
    return !!r.rows[0];
  } catch (_) {
    // Fail OPEN. Suppressing on a read error would mean a transient database blip
    // silently swallows a genuine flood-zone advisory, and nobody would ever know it
    // was skipped; the cost of the other direction is at most one duplicate row a
    // human can dismiss. (In practice this read shares the caller's connection with
    // the insert that follows, so a failure here almost always fails that too.)
    return false;
  }
}

/**
 * Withdraw the OPEN advisory when it is no longer true. UNTOUCHED rows only
 * (`status='open'`) — a human's decision is a record of a judgement made and is
 * never rewritten here. Marked `dismissed` with a reason so the trail shows WHY it
 * closed instead of the row simply vanishing.
 */
async function retract(client, appId, why) {
  try {
    const r = await client.query(
      `UPDATE ai_suggestions
          SET status = 'dismissed', status_reason = $3, updated_at = now()
        WHERE application_id = $1 AND source = $2 AND dedupe_key = $4 AND status = 'open'
        RETURNING id`,
      [appId, SOURCE, `Withdrawn automatically: ${why}`, DEDUPE_KEY]);
    return r.rowCount || 0;
  } catch (_) { return 0; }
}

/**
 * The whole advisory pass for one file. NEVER throws.
 * @returns {Promise<{raised:number, retracted:number, reason:string}>}
 *   reason is a short machine tag for logs/tests: 'not_fidelis' | 'file_frozen' |
 *   'no_flood_zone' | 'condition_present' | 'decided_by_human' | 'raised' (no condition on
 *   the file) | 'raised_optional' (an optional one is on the file and should be required).
 */
async function syncFidelisFloodAdvisory(client, appId) {
  const out = { raised: 0, retracted: 0, reason: 'not_fidelis' };
  if (!client || !appId) return out;
  try {
    const app = (await client.query(
      `SELECT lender, status, deleted_at FROM applications WHERE id = $1`, [appId])).rows[0];
    if (!app) return out;

    // A deleted or terminal/intake-stage file gets no advisory. Deliberately NOT
    // retracting here — a funded file's history stays as it was.
    if (app.deleted_at || !OPEN_STATUSES.includes(app.status)) {
      out.reason = 'file_frozen';
      return out;
    }

    // Not a Fidelis file → this advisory does not apply. The flood cert is a real
    // rule-driven condition for the other partners, so withdraw any advisory left
    // over from when the file WAS Fidelis.
    if (!isFidelisNoteBuyer(app.lender)) {
      out.retracted = await retract(client, appId, 'the file\'s capital partner is no longer Fidelis.');
      out.reason = 'not_fidelis';
      return out;
    }

    const ev = await floodZoneEvidence(client, appId);
    if (!ev.inFloodZone) {
      out.retracted = await retract(client, appId,
        'the current appraisal no longer places the property in a flood zone.');
      out.reason = 'no_flood_zone';
      return out;
    }

    // What (if anything) is already on the file decides WHICH advisory is right.
    const cond = await floodConditionState(client, appId);
    if (cond.present && !cond.optionalOpen) {
      // Either it is already a live REQUIRED condition, or a human has settled it. Both
      // mean there is nothing to advise. (A failed read lands here too — fail closed.)
      out.retracted = await retract(client, appId,
        'a flood certificate condition is now on the file.');
      out.reason = 'condition_present';
      return out;
    }

    if (await decidedByHuman(client, appId)) {
      out.reason = 'decided_by_human';
      return out;
    }

    const where = whereFound(ev);
    const common = {
      applicationId: appId,
      source: SOURCE,
      // WARNING, not fatal: a fatal fans the "new fatal AI finding" email out to the whole
      // file team, and this is a heads-up, not a dealbreaker. `important` pins it to the top
      // of the AI Findings panel instead.
      severity: 'warning',
      important: true,
      evidence: {
        code: 'fidelis_flood_zone_advisory',
        sources: ev.sources,
        femaSfha: ev.femaSfha,
        femaZone: ev.femaZone,
        appraisalZone: ev.appraisalZone,
        templateCode: FLOOD_TEMPLATE_CODE,
        conditionState: cond.optionalOpen ? 'optional_open' : 'absent',
      },
      // ONE dedupe key across both variants, so a file can only ever hold one of these
      // rows — if the condition state changes, the open row is rewritten in place rather
      // than joined by a second notice about the same flood zone.
      dedupeKey: DEDUPE_KEY,
    };

    if (cond.optionalOpen) {
      // The condition IS on the file but marked optional (db/333 downgraded it while no
      // flood zone was known), so it could be signed off with nothing attached. There is no
      // one-click for "make this required", so this is an INFO advisory pointing at the
      // condition itself — kind 'info' deliberately offers no create button, because
      // creating a second flood condition is the wrong move here.
      await aiSug.record(client, Object.assign({}, common, {
        checklistItemId: cond.itemId,
        kind: 'info',
        title: 'Flood zone found — the flood certificate on this file is marked optional',
        body: `This property looks like it sits in a flood zone per ${where}. `
          + 'The flood certificate condition is already on the file but marked OPTIONAL — this '
          + 'file\'s capital partner does not require it as a standing condition, so it can be '
          + 'signed off with nothing attached. A flood zone changes that: get the life-of-loan '
          + 'flood determination (and the flood policy, if one is needed) onto the condition '
          + 'and mark it required before signing it off.',
      }));
    } else {
      await aiSug.record(client, Object.assign({}, common, {
        kind: 'condition',
        title: 'Flood zone found — open the flood certificate condition?',
        body: `This property looks like it sits in a flood zone per ${where}. `
          + 'This file\'s capital partner does not require the internal flood certificate as a '
          + 'standing condition, so PILOT did not add one — but a flood zone changes that. '
          + 'Open the flood certificate condition to get the life-of-loan flood determination '
          + '(and the flood policy, if one is needed) onto the file, or dismiss this if the '
          + 'determination has already been handled.',
        // Both shapes the UI/route read: app-v2 UnderwritingPanel derives the code from
        // `fields.opensCondition || templateCode`, and the decide route from
        // `templateCode || fields.opensCondition`. Setting both makes the one-click
        // "create this condition" work on either path.
        proposedAction: {
          type: 'attach_condition',
          templateCode: FLOOD_TEMPLATE_CODE,
          fields: { opensCondition: FLOOD_TEMPLATE_CODE, code: FLOOD_TEMPLATE_CODE },
        },
      }));
    }
    out.raised = 1;
    out.reason = cond.optionalOpen ? 'raised_optional' : 'raised';
    return out;
  } catch (e) {
    console.error('[fidelis-flood-advisory] sync', appId, e && e.message);
    return out;
  }
}

module.exports = {
  SOURCE, DEDUPE_KEY, FLOOD_TEMPLATE_CODE, OPEN_STATUSES,
  isSfhaZone, floodZoneEvidence, whereFound,
  floodConditionState, decidedByHuman, retract,
  syncFidelisFloodAdvisory,
};
