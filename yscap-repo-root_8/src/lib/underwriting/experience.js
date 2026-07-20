'use strict';
/**
 * Experience / track-record underwriting (the owner's MAJOR requirement, 2026-07-20).
 *
 * The rule, in the owner's words: the borrower doesn't need a project that's *very* close to the new
 * deal, but they must have at least ONE comparable "anchor" deal in the same range. If someone is
 * taking on a HEAVY rehab (or a GROUND-UP) and has no experience at or near that level, that's a
 * flag; one adjacent ("hybrid") project counts. Quality over quantity — you need the anchor deal.
 * And it must be VERIFIED: an unverified comparable deal does not clear the requirement, and the
 * file cannot go clear-to-close on experience that isn't verified.
 *
 * How it works:
 *   1. Classify the NEW deal's demand tier from its rehab intensity (light / moderate / heavy /
 *      ground-up). Experience is only GATED for HEAVY and GROUND-UP deals — a light/moderate deal
 *      doesn't require a prior anchor (a first light-rehab is fine).
 *   2. An "anchor" is a past track-record deal that is (a) at least one tier below the demand (so a
 *      MODERATE/hybrid project anchors a HEAVY deal, a HEAVY project anchors a GROUND-UP), (b) at
 *      least ~half the new deal's project size (the "same range" test), and (c) EXITED within the
 *      last 3 years (a completed sale for a flip; a lease/refi for a hold — the frozen 3-year window).
 *   3. A VERIFIED anchor clears the requirement. A comparable anchor that exists but isn't verified
 *      blocks clear-to-close until it's verified. No comparable anchor at all blocks with an
 *      "insufficient experience" dealbreaker.
 *
 * Pure: no AI, no DB. Fed the deal economics + the borrower's track-record rows + today.
 */

const TIER = { light: 1, moderate: 2, heavy: 3, groundup: 4 };
const TIER_LABEL = { 1: 'light rehab', 2: 'moderate / hybrid rehab', 3: 'heavy rehab', 4: 'ground-up construction' };
const ANCHOR_SIZE_RATIO = 0.5;   // an anchor must be at least half the new deal's project size ("same range")
const EXIT_WINDOW_MONTHS = 36;   // the frozen 3-year experience window (matches track-record.js qualifies())

const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isGroundUpText = (s) => /ground.?up|new construction|new build|construction loan/i.test(String(s || ''));

// Whole months between two YYYY-MM-DD (or Date-ish) strings — calendar based, positive if `to` is
// after `from`. Returns null on an unparseable pair. No Date.now(); `today` is always injected.
function monthsBetween(fromISO, toISO) {
  const f = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fromISO || ''));
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(toISO || ''));
  if (!f || !t) return null;
  const months = (+t[1] - +f[1]) * 12 + (+t[2] - +f[2]);
  return +t[3] < +f[3] ? months - 1 : months; // not past the day-of-month yet → one fewer whole month
}

// Classify a deal's rehab intensity into a tier. base = the value the rehab is measured against
// (purchase price / as-is value). A ground-up flag wins outright.
function tierOf(rehab, base, groundUp) {
  if (groundUp) return TIER.groundup;
  const r = numOf(rehab) || 0;
  const b = numOf(base);
  const ratio = b && b > 0 ? r / b : 0;
  if (r >= 150000 || ratio >= 0.5) return TIER.heavy;
  if (ratio >= 0.15) return TIER.moderate;
  return TIER.light;
}

// A past deal's completed-exit date by its type: a flip / ground-up exits on SALE; a hold exits on
// LEASE (rent) or REFI. Returns the ISO date or null if it hasn't exited.
function exitDateOf(tr) {
  const type = String(tr.deal_type || '').toLowerCase();
  if (/hold|rental|rent/.test(type)) return tr.rent_date || tr.refi_date || null;
  return tr.sale_date || null; // flip / ground-up / unknown → sale
}

/**
 * @param {{purchasePrice,asIsValue,arv,rehabBudget,loanType,program,propertyType}} deal
 * @param {Array<object>} trackRecords  rows from the track_records table
 * @param {{today?:string}} opts
 */
function assessExperience(deal = {}, trackRecords = [], opts = {}) {
  const today = opts.today || null;
  const purchase = numOf(deal.purchasePrice);
  const asIs = numOf(deal.asIsValue);
  const base = Math.max(purchase || 0, asIs || 0) || purchase || asIs || 0;
  const newGroundUp = isGroundUpText(deal.loanType) || isGroundUpText(deal.program) || isGroundUpText(deal.propertyType);
  const demandTier = tierOf(deal.rehabBudget, base, newGroundUp);
  const newSize = (base || 0) + (numOf(deal.rehabBudget) || 0);
  const requiredTier = Math.max(TIER.light, demandTier - 1); // one tier below the demand anchors it

  // Evaluate every past deal against this new deal.
  const evaluated = (trackRecords || []).map((tr) => {
    const trGroundUp = isGroundUpText(tr.deal_type);
    const t = tierOf(tr.rehab_amount, tr.purchase_price, trGroundUp);
    const size = (numOf(tr.purchase_price) || 0) + (numOf(tr.rehab_amount) || 0);
    const exit = exitDateOf(tr);
    const monthsAgo = today && exit ? monthsBetween(exit, today) : null;
    const exitedInWindow = monthsAgo != null && monthsAgo >= 0 && monthsAgo <= EXIT_WINDOW_MONTHS;
    const bigEnough = newSize > 0 ? size >= ANCHOR_SIZE_RATIO * newSize : true;
    const tierOk = t >= requiredTier;
    const comparable = tierOk && bigEnough && exitedInWindow;
    return { tr, tier: t, size, exit, exitedInWindow, comparable, verified: tr.is_verified === true,
      label: `${TIER_LABEL[t]}${size ? ` · $${Math.round(size).toLocaleString('en-US')}` : ''}` };
  });

  const candidates = evaluated.filter((e) => e.comparable);
  const verifiedAnchors = candidates.filter((e) => e.verified);
  const gated = demandTier >= TIER.heavy;   // only heavy / ground-up deals REQUIRE an anchor

  const findings = [];
  const mkFatal = (code, title, howTo) => findings.push({
    source: 'experience', code, severity: 'fatal', status: 'open', blocksCtc: true,
    field: 'experience', docValue: `${TIER_LABEL[demandTier]} deal`, fileValue: `${verifiedAnchors.length} verified comparable project(s)`,
    title, howTo, actions: ['request_document', 'post_condition', 'grant_exception', 'decline'],
    opensCondition: 'underwriting_review_cleared',
  });

  if (gated && verifiedAnchors.length === 0) {
    if (candidates.length > 0) {
      const list = candidates.map((c) => c.label).join('; ');
      mkFatal('experience_anchor_unverified',
        'A comparable project is on file but not verified',
        `This is a ${TIER_LABEL[demandTier]} deal, which requires at least one verified project of comparable type and size. ${candidates.length} comparable project(s) are on file (${list}) but none is verified. Verify the documentation (HUD/closing statements, payoffs, photos, lease/refi) before clear-to-close — experience that isn't verified can't clear the file.`);
    } else {
      mkFatal('experience_insufficient',
        `Insufficient verified experience for a ${TIER_LABEL[demandTier]} deal`,
        `This is a ${TIER_LABEL[demandTier]} deal. The borrower needs at least one verified, completed project (exited within the last 3 years) of a comparable level — ${TIER_LABEL[requiredTier]} or heavier — and at least about half this deal's size. None is on file. Collect and verify a comparable track-record project, or escalate for an experience exception, before clear-to-close.`);
    }
  }

  return {
    demandTier, demandLabel: TIER_LABEL[demandTier], requiredTier, requiredLabel: TIER_LABEL[requiredTier],
    gated, newSize,
    anchors: candidates.map((c) => ({ label: c.label, tier: c.tier, size: c.size, exit: c.exit, verified: c.verified })),
    hasVerifiedAnchor: verifiedAnchors.length > 0,
    trackRecordCount: (trackRecords || []).length,
    findings,
  };
}

// Impure edge: load the deal economics + the borrower's track records and assess. Returns the full
// assessment, or null when the file/borrower can't be loaded. Never throws.
async function assessExperienceForFile(client, appId, opts = {}) {
  try {
    const app = (await client.query(
      `SELECT borrower_id, purchase_price, as_is_value, arv, rehab_budget, program, loan_type, property_type
         FROM applications WHERE id=$1`, [appId])).rows[0];
    if (!app || !app.borrower_id) return null;
    const trs = (await client.query(
      `SELECT deal_type, purchase_price, sale_price, rehab_amount, purchase_date, sale_date,
              rent_date, refi_date, is_verified
         FROM track_records WHERE borrower_id=$1`, [app.borrower_id])).rows;
    return assessExperience({
      purchasePrice: app.purchase_price, asIsValue: app.as_is_value, arv: app.arv,
      rehabBudget: app.rehab_budget, program: app.program, loanType: app.loan_type, propertyType: app.property_type,
    }, trs, opts);
  } catch (_) { return null; }
}

module.exports = { assessExperience, assessExperienceForFile, TIER, TIER_LABEL, _internals: { tierOf, monthsBetween, exitDateOf } };
