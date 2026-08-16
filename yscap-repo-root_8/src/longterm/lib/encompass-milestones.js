'use strict';

// The Encompass milestone / status catalog — read access.
//
// Mirrors the model in src/longterm/prisma/schema.prisma (LtEncompassMilestone)
// and the table in db/547_lt_encompass_milestones.sql. The catalog is reference
// data: it is loaded by the migration seed and read here. There is no write path
// yet (changing / rolling back / syncing statuses is future work).

const db = require('../db');

// The column list lives in one place so the SELECT and the row mapper never drift.
const COLUMNS = `milestone_id, sequence, milestone_name, role, role_id,
  assignment_required, expected_days, tpo_status, consumer_status,
  is_archived, created_at, updated_at`;

// Map a raw DB row (snake_case) to the clean camelCase shape the API returns.
function toMilestone(r) {
  return {
    milestoneId: r.milestone_id,
    sequence: r.sequence,
    milestoneName: r.milestone_name,
    role: r.role,
    roleId: r.role_id,
    assignmentRequired: r.assignment_required,
    expectedDays: r.expected_days,
    tpoStatus: r.tpo_status,
    consumerStatus: r.consumer_status,
    isArchived: r.is_archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The whole catalog, ordered by pipeline position. */
async function listMilestones({ includeArchived = true } = {}) {
  const where = includeArchived ? '' : ' WHERE is_archived = false';
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM lt_encompass_milestones${where} ORDER BY sequence ASC`);
  return rows.map(toMilestone);
}

/** One milestone by its Encompass identifier, or null. */
async function getMilestone(milestoneId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM lt_encompass_milestones WHERE milestone_id = $1`, [milestoneId]);
  return rows[0] ? toMilestone(rows[0]) : null;
}

/** How many milestones are in the catalog. */
async function countMilestones() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM lt_encompass_milestones');
  return rows[0].n;
}

module.exports = { listMilestones, getMilestone, countMilestones, toMilestone };
