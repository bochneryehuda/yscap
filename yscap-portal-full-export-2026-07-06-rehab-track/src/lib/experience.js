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
  const verifiedOnly = !!opts.verifiedOnly;
  const r = await client.query(
    `SELECT lower(coalesce(deal_type,'')) AS deal_type, count(*)::int AS n
       FROM track_records
      WHERE borrower_id=$1
        AND ($2::boolean=false OR is_verified=true)
      GROUP BY 1`,
    [borrowerId, verifiedOnly]);
  const counts = { flips: 0, holds: 0, ground: 0, total: 0 };
  for (const row of r.rows) {
    const n = int(row.n);
    counts[bucketOf(row.deal_type)] += n;
    counts.total += n;
  }
  return counts;
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
  const satisfied = requiredAny ? requirementMet(counts, required) : counts.total > 0;
  const payload = {
    autoExperienceTask: true,
    required,
    counts,
    satisfied,
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

  if (satisfied) {
    await client.query(
      `UPDATE checklist_items
          SET status='received',
              tool_payload=$2,
              updated_at=now()
        WHERE id=$1 AND status <> 'satisfied'`,
      [item.id, JSON.stringify(payload)]);
  } else {
    let wasAuto = false;
    if (item.tool_payload && typeof item.tool_payload === 'object') {
      wasAuto = !!item.tool_payload.autoExperienceTask;
    }
    if (wasAuto && item.status === 'received' && !item.signed_off_at) {
      await client.query(
        `UPDATE checklist_items
            SET status='outstanding',
                tool_payload=$2,
                updated_at=now()
          WHERE id=$1`,
        [item.id, JSON.stringify(payload)]);
    }
  }
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
