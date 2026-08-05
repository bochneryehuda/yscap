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

module.exports = { pickRoundRobinOfficer, enabled };
