'use strict';

const db = require('../db');

// FROZEN baseline (#89) — experience window. A completed deal counts toward the
// borrower's tier / experience ONLY if its exit is within the last 3 years:
//   · a FLIP exits on its SALE date
//   · a hold / rental / ground-up-and-held exits on its LEASE (rent) or REFI date
// An exit more than 36 months ago, or a future-dated exit, counts toward
// nothing. This mirrors the frozen track-record tool's qualifies() exactly and
// must be applied at EVERY server-side experience/tier count so the tier can
// never be inflated by stale deals. Reuse RECENT_EXIT_SQL — don't re-derive it.
const EXIT_DATE_SQL =
  "(CASE WHEN lower(coalesce(deal_type,'')) LIKE '%flip%' THEN sale_date ELSE COALESCE(rent_date, refi_date) END)";
const RECENT_EXIT_SQL =
  `${EXIT_DATE_SQL} IS NOT NULL`
  + ` AND ${EXIT_DATE_SQL} <= CURRENT_DATE`
  + ` AND ${EXIT_DATE_SQL} >= (CURRENT_DATE - INTERVAL '36 months')`;

function int(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : 0;
}

function bucketOf(dealType) {
  const s = String(dealType || '').toLowerCase();
  if (s.indexOf('ground') >= 0 || s.indexOf('construction') >= 0) return 'ground';
  if (s.indexOf('flip') >= 0) return 'flips';
  return 'holds';
}

function requestedFromApp(app) {
  return {
    flips: int(app && app.requested_exp_flips),
    holds: int(app && app.requested_exp_holds),
    ground: int(app && app.requested_exp_ground),
  };
}

function hasRequirement(required) {
  return int(required.flips) + int(required.holds) + int(required.ground) > 0;
}

function requirementMet(counts, required) {
  return int(counts.flips) >= int(required.flips)
    && int(counts.holds) >= int(required.holds)
    && int(counts.ground) >= int(required.ground);
}

async function countBorrowerExperience(borrowerId, client = db, opts = {}) {
  return countBorrowersExperience([borrowerId], client, opts);
}

// Experience across one or more borrowers, summed. A loan file with a
// co-borrower counts BOTH borrowers' completed deals toward the file's
// experience (#80): if borrower A has 2 flips and co-borrower B has 2 flips,
// the file has 4 flips. Each track_records row already belongs to exactly one
// borrower, so summing the per-borrower counts never double-counts a deal.
async function countBorrowersExperience(borrowerIds, client = db, opts = {}) {
  const ids = (borrowerIds || []).filter(Boolean);
  const counts = { flips: 0, holds: 0, ground: 0, total: 0 };
  if (!ids.length) return counts;
  const verifiedOnly = !!opts.verifiedOnly;
  const r = await client.query(
    `SELECT lower(coalesce(deal_type,'')) AS deal_type, count(*)::int AS n
       FROM track_records
      WHERE borrower_id = ANY($1::uuid[])
        AND ($2::boolean=false OR is_verified=true)
        AND (${RECENT_EXIT_SQL})
      GROUP BY 1`,
    [ids, verifiedOnly]);
  for (const row of r.rows) {
    const n = int(row.n);
    counts[bucketOf(row.deal_type)] += n;
    counts.total += n;
  }
  return counts;
}

// The set of borrower ids whose experience counts for a file: the primary
// borrower plus the co-borrower when present.
function fileBorrowerIds(app) {
  return [app && app.borrower_id, app && app.co_borrower_id].filter(Boolean);
}

async function syncExperienceChecklistForApplication(appId, client = db) {
  const ar = await client.query(
    `SELECT id, borrower_id, co_borrower_id, requested_exp_flips, requested_exp_holds, requested_exp_ground
       FROM applications WHERE id=$1`,
    [appId]);
  const app = ar.rows[0];
  if (!app) return null;

  const required = requestedFromApp(app);
  // Experience for the FILE = the primary borrower + the co-borrower, summed
  // (#80): both borrowers' completed deals count toward the requirement.
  const ids = fileBorrowerIds(app);
  const counts = await countBorrowersExperience(ids, client);
  // VERIFIED experience (owner-directed 2026-07-20) — the file's experience
  // CONDITION is tied to VERIFIED deals, not merely ENTERED ones. `counts` above
  // stays the ENTERED (on-record) figure for display; `verifiedCounts` is what
  // drives "met" / the condition becoming ready to sign off. "If it's not
  // verified experience, then you should not be able to sign off that experience
  // condition even if you entered everything."
  const verifiedCounts = await countBorrowersExperience(ids, client, { verifiedOnly: true });
  // The experience threshold that must be VERIFIED to sign off = the CURRENT
  // registered product's experience — the SAME number the sign-off gate uses
  // (staff.js signOffGate: is_current registration inputs, regardless of stale).
  // Loans SIZE on the borrower's CLAIMED experience (frozen rule), but funding is
  // gated on the REGISTERED experience being verified; so "met" / the reopen must
  // track the REGISTERED need — not the raw application claim, which can exceed
  // the registered need and would otherwise reopen a legitimately signed-off
  // condition on every recompute (a loop the gate can never permanently satisfy).
  // Falls back to the application claim when nothing is registered yet — in that
  // state the gate blocks sign-off anyway, so the fallback is never the gate.
  let gateNeed = required;
  try {
    const cur = await client.query(
      `SELECT inputs FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    if (cur.rows[0]) {
      const pin = cur.rows[0].inputs || {};
      gateNeed = { flips: int(pin.expFlips), holds: int(pin.expHolds), ground: int(pin.expGround) };
    }
  } catch (_) { /* best-effort — fall back to the application claim */ }
  // Per-borrower breakdown (#103) — on a co-borrower file the experience
  // condition shows BOTH borrowers, each named, with their OWN 3-year-window
  // counts and a link to their OWN track record. The requirement is still the
  // SUM (above); this is display detail only, so it never changes met/required.
  let perBorrower = null;
  if (ids.length > 1) {
    const nm = await client.query(
      `SELECT id, first_name, last_name FROM borrowers WHERE id = ANY($1::uuid[])`, [ids]);
    const nameById = {};
    for (const row of nm.rows) nameById[row.id] = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Borrower';
    perBorrower = [];
    for (const bid of ids) {
      perBorrower.push({
        borrowerId: bid,
        name: nameById[bid] || 'Borrower',
        isPrimary: bid === app.borrower_id,
        counts: await countBorrowersExperience([bid], client),
        verifiedCounts: await countBorrowersExperience([bid], client, { verifiedOnly: true }),
      });
    }
  }
  // A NEGATIVE track-record change makes the registered product FATAL
  // (owner-directed 2026-07-14, same family as the db/096 economics trigger —
  // track_records writes can't fire that applications trigger, so the check
  // lives here, on the path every track-record mutation already calls). If the
  // CURRENT registration priced with more experience than is verified NOW
  // (a line item was un-verified, deleted, or aged out), the structure no
  // longer holds: flag it stale and reopen Products & Pricing + the signed
  // term sheet.
  try {
    const reg = await client.query(
      `SELECT id, inputs FROM product_registrations
        WHERE application_id=$1 AND is_current AND NOT stale LIMIT 1`, [appId]);
    if (reg.rows[0]) {
      const pin = reg.rows[0].inputs || {};
      const pricedWith = { flips: int(pin.expFlips), holds: int(pin.expHolds), ground: int(pin.expGround) };
      // The fatality is a NEGATIVE experience-of-record change — never a fresh
      // registration. Loans size on the CLAIMED experience (frozen rule), so at
      // registration pricedWith == the claim while VERIFIED is often still 0; the
      // old check (pricedWith > all-rows count) flagged every such registration
      // "experience dropped" at birth and silently disarmed the guard (audit
      // #10/#29). Judge against VERIFIED experience, with the current claim as a
      // floor: only when the registration priced on MORE than the file now claims
      // AND more than is verified has the experience of record actually dropped.
      const claim = required;   // requestedFromApp(app) — the claimed-of-record floor
      const verified = verifiedCounts;   // computed once above (verifiedOnly)
      const dropped =
           (pricedWith.flips  > int(claim.flips)  && pricedWith.flips  > int(verified.flips))
        || (pricedWith.holds  > int(claim.holds)  && pricedWith.holds  > int(verified.holds))
        || (pricedWith.ground > int(claim.ground) && pricedWith.ground > int(verified.ground));
      if (dropped) {
        await client.query(
          `UPDATE product_registrations SET stale=true,
                  stale_reason='verified track-record experience dropped below what the product was priced with'
            WHERE id=$1`, [reg.rows[0].id]);
        await client.query(
          `UPDATE checklist_items SET status='received', signed_off_at=NULL, signed_off_by=NULL,
                  reviewed_at=NULL, reviewed_by=NULL,
                  notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%'
                             THEN '[auto] Verified track-record experience dropped below what the product was priced with — re-register the product.'
                             ELSE notes END,
                  updated_at=now()
            WHERE application_id=$1 AND tool_key='product_pricing'
              AND (status='satisfied' OR signed_off_at IS NOT NULL)`, [appId]);
        await client.query(
          `UPDATE checklist_items ci SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL,
                  reviewed_at=NULL, reviewed_by=NULL,
                  notes=CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                             THEN '[auto] Verified experience changed — the signed term sheet no longer matches. Generate the new term sheet and collect a fresh signature.'
                             ELSE ci.notes END,
                  updated_at=now()
             FROM checklist_templates t
            WHERE t.id=ci.template_id AND t.code='rtl_cond_signedts' AND ci.application_id=$1
              AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL)`, [appId]);
      }
    }
  } catch (e) { console.warn('[experience] registration staleness check skipped:', e.message); }

  const requiredAny = hasRequirement(required);
  // NO experience claimed on the file → there is nothing to verify, so the
  // track-record condition is NOT APPLICABLE. We auto-satisfy it (stamped
  // notApplicable) so it drops out of the open conditions list — it "disappears"
  // until experience is added (either on the application or written back from
  // Products & Pricing), at which point it reopens for real verification.
  const notApplicable = !requiredAny;
  // MET is judged on VERIFIED experience (owner-directed 2026-07-20) against the
  // REGISTERED need (gateNeed) — matching the sign-off gate exactly — the
  // condition only reads "met"/ready-to-sign-off once the required deals are
  // VERIFIED, never on entered-but-unverified deals. `enteredMet` is kept for the
  // desk so the UI can say "entered enough, X still to verify".
  const enteredMet = requiredAny && requirementMet(counts, gateNeed);
  const met = requiredAny && requirementMet(verifiedCounts, gateNeed);
  const satisfied = notApplicable || met;
  const payload = {
    // `required` stays the application CLAIM (what the file says); `gateNeed` is
    // what must actually be VERIFIED to sign off (the registered product's
    // experience). The desk shows the shortfall against gateNeed.
    autoExperienceTask: true, notApplicable, required, gateNeed, counts, verifiedCounts, satisfied,
    enteredMet, verifiedMet: met,
    perBorrower,
    checkedAt: new Date().toISOString(),
  };

  const ir = await client.query(
    `SELECT id, status, tool_payload, signed_off_at
       FROM checklist_items
      WHERE application_id=$1 AND tool_key='track_record'
      ORDER BY created_at LIMIT 1`,
    [appId]);
  const item = ir.rows[0];
  if (!item) return { required, counts, satisfied, itemId: null };

  // A truthy signed_off_at is always a GENUINE human sign-off — the not-
  // applicable auto-satisfy below uses status='satisfied' with a NULL stamp, so
  // it never impersonates one.
  if (item.signed_off_at) {
    // Keep the sign-off in place UNLESS VERIFIED experience now falls short of the
    // REGISTERED need (gateNeed) — e.g. a track-record line was un-verified/removed,
    // or Products & Pricing re-registered on MORE experience than is verified. This
    // uses the SAME threshold as the sign-off gate, so a condition the gate would
    // still accept never reopens (no reopen/re-sign loop); otherwise reopen for
    // re-verification. When it holds, just refresh the counts.
    if (requiredAny && !met) {
      await client.query(
        `UPDATE checklist_items
            SET status='outstanding', tool_payload=$2, signed_off_at=NULL, signed_off_by=NULL, updated_at=now()
          WHERE id=$1`,
        [item.id, JSON.stringify(payload)]);
      return { required, counts, satisfied: false, itemId: item.id, reopened: true };
    }
    await client.query(`UPDATE checklist_items SET tool_payload=$2, updated_at=now() WHERE id=$1`, [item.id, JSON.stringify(payload)]);
    return { required, counts, satisfied: true, itemId: item.id };
  }

  // The experience condition is ALWAYS a visible slot (#97) — a reminder that
  // never silently disappears. When NO experience is claimed on the file it stays
  // 'outstanding' but is NOT required: the team can sign it off freely (nothing
  // to verify for the current structure) or leave it open. When experience IS
  // claimed it's required — 'received' once met (awaiting sign-off), else
  // 'outstanding' — and the sign-off gate enforces verification.
  const status = met ? 'received' : 'outstanding';
  const isRequired = !notApplicable;
  await client.query(
    `UPDATE checklist_items SET status=$3, is_required=$4, tool_payload=$2, updated_at=now() WHERE id=$1`,
    [item.id, JSON.stringify(payload), status, isRequired]);
  return { required, counts, satisfied, itemId: item.id };
}

// #103 — one-shot boot backfill: recompute the experience condition for every
// co-borrower file so its payload carries the per-borrower breakdown (and each
// borrower's own track-record link) without waiting for the next experience-
// affecting action. Safe to re-run — the sync preserves genuine sign-offs and a
// pure recompute never changes the summed requirement, so nothing reopens.
async function backfillCoBorrowerExperience(client = db) {
  const r = await client.query(
    `SELECT id FROM applications WHERE co_borrower_id IS NOT NULL AND deleted_at IS NULL`);
  let n = 0;
  for (const row of r.rows) {
    try { await syncExperienceChecklistForApplication(row.id, client); n++; } catch (_) { /* best-effort */ }
  }
  return n;
}

async function syncExperienceChecklistForBorrower(borrowerId, client = db) {
  const apps = await client.query(
    `SELECT id FROM applications
      WHERE borrower_id=$1 OR co_borrower_id=$1`,
    [borrowerId]);
  const out = [];
  for (const row of apps.rows) out.push(await syncExperienceChecklistForApplication(row.id, client));
  return out;
}

module.exports = {
  bucketOf,
  countBorrowerExperience,
  countBorrowersExperience,
  backfillCoBorrowerExperience,
  fileBorrowerIds,
  requestedFromApp,
  syncExperienceChecklistForApplication,
  syncExperienceChecklistForBorrower,
  RECENT_EXIT_SQL,
  EXIT_DATE_SQL,
};
