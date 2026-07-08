'use strict';

const db = require('../db');

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
    `SELECT id, borrower_id, requested_exp_flips, requested_exp_holds, requested_exp_ground
       FROM applications WHERE id=$1`,
    [appId]);
  const app = ar.rows[0];
  if (!app) return null;

  const required = requestedFromApp(app);
  const counts = await countBorrowerExperience(app.borrower_id, client);
  const requiredAny = hasRequirement(required);
  // NO experience claimed on the file → there is nothing to verify, so the
  // track-record condition is NOT APPLICABLE. We auto-satisfy it (stamped
  // notApplicable) so it drops out of the open conditions list — it "disappears"
  // until experience is added (either on the application or written back from
  // Products & Pricing), at which point it reopens for real verification.
  const notApplicable = !requiredAny;
  const met = requiredAny && requirementMet(counts, required);
  const satisfied = notApplicable || met;
  const payload = {
    autoExperienceTask: true, notApplicable, required, counts, satisfied,
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
    // Keep the sign-off in place UNLESS the requirement has since grown beyond
    // what's verified — e.g. Products & Pricing re-priced off MORE experience
    // than was signed off for. Then reopen for re-verification (mirrors the
    // liquidity condition's reopen-on-increase); otherwise just refresh counts.
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

  // Auto-managed (no human sign-off): n/a → satisfied (drops out of the open
  // conditions list); requirement met → received (awaiting sign-off); requested
  // but unmet → outstanding.
  const status = notApplicable ? 'satisfied' : met ? 'received' : 'outstanding';
  await client.query(
    `UPDATE checklist_items SET status=$3, tool_payload=$2, updated_at=now() WHERE id=$1`,
    [item.id, JSON.stringify(payload), status]);
  return { required, counts, satisfied, itemId: item.id };
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
  requestedFromApp,
  syncExperienceChecklistForApplication,
  syncExperienceChecklistForBorrower,
};
