'use strict';
/**
 * Lead-assignment queue — ROUND-ROBIN (owner-directed message-3, #29).
 *
 * An inbound marketing lead that carries no officer (no ?lo= branded link) is assigned to the next
 * loan officer in FAIR rotation, so every lead gets an owner instead of piling up unowned on the sales
 * desk. "Next" = the eligible officer whose most-recent round-robin lead is OLDEST — a never-assigned
 * officer goes first, then the one who has waited longest since their last one. This is self-adjusting:
 * adding or removing an officer needs no cursor to maintain, and it can never hand every lead to the
 * same person.
 *
 * ELIGIBLE POOL = ACTIVE, site-selectable LOAN OFFICERS — the public-facing officers who take new
 * business (the same people the marketing "select your loan officer" dropdown offers). Adjust the pool
 * by toggling an officer's "Site" flag on the Team screen; nothing else to configure. Off-switch:
 * LEADS_ROUND_ROBIN_DISABLED=1 (then leads fall back to the existing sales-desk routing).
 *
 * Returns { id, email, full_name } or null. NULL means "no eligible officer" — the caller keeps its
 * existing sales-desk / admin fallback, so a lead is NEVER lost. Never throws (a rotation hiccup must
 * not break public lead capture).
 *
 * NOTE on concurrency: two leads arriving in the same instant can both read the same "oldest" officer
 * and both land on them. That is a fairness nit, not a correctness bug — the very next lead sees that
 * officer at the front of the queue no longer and rotation self-corrects. No lock is taken (it would be
 * over-engineering for this endpoint's volume).
 */
const db = require('../db');

function enabled() { return process.env.LEADS_ROUND_ROBIN_DISABLED !== '1'; }

async function pickRoundRobinOfficer(client = db) {
  if (!enabled()) return null;
  try {
    const r = await client.query(
      `SELECT s.id, s.email, s.full_name
         FROM staff_users s
         LEFT JOIN LATERAL (
           SELECT max(l.created_at) AS last_at
             FROM leads l
            WHERE l.officer_id = s.id AND l.assigned_via = 'round_robin'
         ) la ON true
        WHERE s.is_active = true AND s.role = 'loan_officer' AND s.site_selectable = true
        -- Oldest most-recent round-robin lead first; a never-assigned officer (NULL) is oldest of all.
        -- sort_order then id make the pick deterministic when two officers are equally "due".
        ORDER BY la.last_at ASC NULLS FIRST, s.sort_order ASC, s.id ASC
        LIMIT 1`);
    return r.rows[0] || null;
  } catch (e) {
    console.error('[leads] round-robin pick failed:', e && e.message);
    return null;   // never break public lead capture over a rotation hiccup
  }
}

/**
 * WHO OWNS THIS LEAD, and may the rotation touch it? — PURE, so the whole truth table
 * is unit-testable without a DB (scripts/test-lead-officer-pure.js).
 *
 * Owner-reported 2026-08-07: a staff member generated a term sheet in their own portal
 * and emailed it to a lead; the lead arrived under a DIFFERENT officer's name. The
 * tools inside PILOT are the same static pages the marketing site serves and they read
 * their officer from `window.YSBRAND` (`?lo=`), which the portal never set — so the
 * lead posted with no officer and the rotation below did exactly what it is built to
 * do with an unowned marketing lead.
 *
 * THE RULE (owner's words): "if somebody is doing something from his login, it should
 * always stay with his information, his name. It should come in as a lead in his
 * system." So a submission that declares a staff-portal origin is NEVER round-robined.
 * If its officer cannot be resolved it falls through to the SALES DESK — which a human
 * works — rather than to an officer who had nothing to do with it. An unassigned lead
 * is recoverable; a lead silently filed in the wrong person's book is the bug.
 *
 * The declaration is not a privilege and needs no authentication: it can only ever
 * make a lead LESS likely to be auto-assigned, so a spoofed value costs nothing.
 *
 * @param {{officerId?: string|null, tool?: string, fromStaffPortal?: boolean}} a
 * @returns {{assignedVia: string|null, mayRoundRobin: boolean}}
 *   `assignedVia` is the value for `leads.assigned_via` (db/480) when an officer is
 *   already resolved; null when there is nobody yet. `mayRoundRobin` is whether the
 *   caller may go looking for a rotation owner.
 */
function decideLeadOfficer({ officerId = null, tool = '', fromStaffPortal = false } = {}) {
  const staff = fromStaffPortal === true || fromStaffPortal === 'true';
  if (officerId) return { assignedVia: staff ? 'staff_portal' : 'lo_link', mayRoundRobin: false };
  // A newsletter subscription is not a loan lead and has never been assigned.
  if (String(tool || '') === 'subscribe') return { assignedVia: null, mayRoundRobin: false };
  // Stated to be somebody's own work but unresolvable → the sales desk, never the
  // rotation. This is the line that fixes the report.
  if (staff) return { assignedVia: null, mayRoundRobin: false };
  return { assignedVia: null, mayRoundRobin: true };
}

module.exports = { pickRoundRobinOfficer, enabled, decideLeadOfficer };
