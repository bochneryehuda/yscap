'use strict';
/**
 * WHICH TITLE COMPANY ACTUALLY DELIVERS? (owner-directed 2026-08-03.)
 *
 * We have been choosing vendors on memory. Now that every order records when it
 * went out, when the documents came back and how many times somebody had to chase,
 * that question is arithmetic — no new data collection, and NO vendor integration
 * (owner-directed: "let's not build massive integrations now").
 *
 * WHAT IS MEASURED, and why each one:
 *   · orders placed      — how much of a sample this is. A vendor with two orders
 *                          is not a track record, and the card says so rather than
 *                          printing a confident 50%.
 *   · on-time            — did the documents arrive by the date we expected them?
 *                          The industry's first measure of a vendor, and the one
 *                          41% of lender executives name as their top operational
 *                          problem.
 *   · turnaround         — the median calendar hours from sending the order to the
 *                          documents landing. MEDIAN, not mean: one vendor sitting
 *                          on one file for six weeks would otherwise make an
 *                          otherwise-good company look terrible, and the number
 *                          people want is "what usually happens".
 *   · had to be chased   — how often a follow-up was needed before they delivered.
 *                          Responsiveness, measured by our own effort rather than
 *                          by a survey.
 *   · still out          — what they are sitting on right now, and for how long.
 *
 * DELIBERATELY NOT MEASURED: accuracy. Nothing in this system records whether a
 * commitment came back correct — a rejected document is about the borrower's
 * paperwork, not the vendor's — and inventing a number for it would make the whole
 * card untrustworthy. When there is a real source for it, add it here.
 *
 * COMPUTED FROM `file_orders`, never from `service_contacts.last_used_at`: that
 * column is not reliably maintained on the staff path, so a scorecard built on it
 * would quietly describe a different set of orders than the desk shows.
 *
 * The MATH is pure and exported for testing; only `scorecardsFor` touches the
 * database. Never throws — a scorecard is decoration on a decision, and it must
 * never be what stops somebody placing an order.
 */

const db = require('../db');
const orderSla = require('./order-sla');

/** Under this many delivered orders we show the figures but say they are thin. */
const THIN_SAMPLE = 5;

function num(v) { try { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; } catch (_e) { return null; } }

/** The middle value. Even-length takes the lower of the two middles rather than
    averaging them, so the answer is always a turnaround that really happened. */
function median(values) {
  const list = (Array.isArray(values) ? values : []).map(num).filter((n) => n != null).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.floor((list.length - 1) / 2)];
}

/**
 * Turn a vendor's order rows into a scorecard. PURE — `now` is passed in, so the
 * same rows always produce the same card.
 *
 * @param {Array} rows  file_orders rows for ONE vendor
 * @param {Date}  now
 */
function scoreOrders(rows, now) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.ordered_at);
  const out = {
    orders: list.length,
    delivered: 0,
    onTime: 0,
    onTimePct: null,
    medianHours: null,
    medianDays: null,
    chased: 0,
    chasedPct: null,
    openNow: 0,
    oldestOpenDays: null,
    overdueNow: 0,
    thinSample: true,
    lastOrderedAt: null,
  };
  if (!list.length) return out;

  const hours = [];
  for (const r of list) {
    const placed = new Date(r.ordered_at).getTime();
    if (!out.lastOrderedAt || placed > new Date(out.lastOrderedAt).getTime()) out.lastOrderedAt = r.ordered_at;
    const back = r.first_response_at ? new Date(r.first_response_at).getTime() : null;
    if (back != null && Number.isFinite(placed) && back >= placed) {
      out.delivered += 1;
      hours.push((back - placed) / 3600000);
      // ON TIME is judged against the SAME due date the desk and the nudge use, so
      // a vendor can never be scored late for an order the file called on time.
      const due = orderSla.effectiveDueOn(r);
      const arrived = orderSla.nyDay(r.first_response_at);
      if (due && arrived && arrived <= due) out.onTime += 1;
      if (Number(r.followup_count) > 0) out.chased += 1;
    } else {
      const st = orderSla.orderState(r, now);
      if (st.open) {
        out.openNow += 1;
        if (st.overdue) out.overdueNow += 1;
        if (st.daysOut != null && (out.oldestOpenDays == null || st.daysOut > out.oldestOpenDays)) out.oldestOpenDays = st.daysOut;
      }
    }
  }
  if (out.delivered) {
    out.onTimePct = Math.round((out.onTime / out.delivered) * 100);
    out.chasedPct = Math.round((out.chased / out.delivered) * 100);
    out.medianHours = Math.round(median(hours));
    // Rounded to a tenth of a day, because "1.8 days" is what somebody choosing a
    // vendor actually compares.
    out.medianDays = Math.round((out.medianHours / 24) * 10) / 10;
  }
  out.thinSample = out.delivered < THIN_SAMPLE;
  return out;
}

/** A one-line summary a human can read at a glance. PURE. */
function summarize(card, { vendorName } = {}) {
  if (!card || !card.orders) return 'No orders placed with them yet.';
  if (!card.delivered) {
    return card.openNow
      ? `${card.orders} order${card.orders === 1 ? '' : 's'} placed, nothing back yet${card.oldestOpenDays != null ? ` (oldest is ${card.oldestOpenDays} days out)` : ''}.`
      : `${card.orders} order${card.orders === 1 ? '' : 's'} placed, none delivered.`;
  }
  const who = vendorName ? `${vendorName}: ` : '';
  const pace = card.medianDays != null ? `usually back in ${card.medianDays} day${card.medianDays === 1 ? '' : 's'}` : 'turnaround unknown';
  const punctual = card.onTimePct != null ? `, on time ${card.onTimePct}% of the time` : '';
  const chase = card.chasedPct ? `, chased on ${card.chasedPct}%` : '';
  const thin = card.thinSample ? ` (only ${card.delivered} order${card.delivered === 1 ? '' : 's'} to go on)` : '';
  return `${who}${pace}${punctual}${chase}${thin}.`;
}

/**
 * Scorecards for a set of vendor contacts. Never throws — returns {} on failure,
 * and every caller treats a missing card as "we do not know yet".
 *
 * @param {string[]} contactIds  service_contacts ids
 * @returns {Promise<Object<string, object>>} keyed by contact id
 */
async function scorecardsFor(contactIds, { now = new Date(), excludeApplicationId = null } = {}) {
  const ids = [...new Set((Array.isArray(contactIds) ? contactIds : []).filter(Boolean))];
  if (!ids.length) return {};
  try {
    const params = [ids];
    let notThisFile = '';
    // `excludeApplicationId` is what lets a card say "they are late on N OTHER
    // orders" truthfully. Without it a file whose own title order is three days
    // late, with nothing else anywhere, read "late on 1 other order right now".
    if (excludeApplicationId) { params.push(excludeApplicationId); notThisFile = `AND o.application_id <> $${params.length}`; }
    const r = await db.query(
      `SELECT o.vendor_contact_id, o.order_type, o.status, o.ordered_at, o.first_response_at,
              o.completed_at, o.followup_count, o.due_on, o.sla_days
         FROM file_orders o
         -- A DEAD DEAL IS NOT A VENDOR'S FAULT, and it never closes on its own.
         -- The retire sweep only completes an order when its condition is signed
         -- off or the loan funds, so an order on a declined or withdrawn file stays
         -- 'ordered' FOREVER -- and the due-date arithmetic keeps running on it, so
         -- it counted as open AND overdue for good. Since the leaderboard sorts on
         -- the overdue count FIRST, the worst-vendors table would fill up with title
         -- companies holding orders nobody will ever chase, crowding out the ones
         -- actually letting us down; the per-file card's "late on N other orders
         -- right now" was wrong the same way. The desk already refuses to list a
         -- dead file for exactly this reason -- this is the same rule, one place on.
         JOIN applications a ON a.id = o.application_id AND a.deleted_at IS NULL
          -- 'on_hold' too, and it is NOT the same list as the desk on purpose: the
          -- desk answers "what is there?" and still shows a held file, while this
          -- answers "is this vendor slow?" — and a wait WE chose is not their
          -- fault. Deliberately different questions, deliberately different lists.
          AND a.status NOT IN ('declined','withdrawn','on_hold')
        WHERE o.vendor_contact_id = ANY($1::uuid[]) AND o.ordered_at IS NOT NULL ${notThisFile}
        -- id last so a capped read would be deterministic; there is no cap here
        -- because the set is bounded by the caller's id list.
        ORDER BY o.ordered_at DESC, o.id`, params);
    const byVendor = new Map();
    for (const row of r.rows) {
      if (!byVendor.has(row.vendor_contact_id)) byVendor.set(row.vendor_contact_id, []);
      byVendor.get(row.vendor_contact_id).push(row);
    }
    const out = {};
    for (const id of ids) out[id] = scoreOrders(byVendor.get(id) || [], now);
    return out;
  } catch (e) {
    console.error('[vendor-scorecard]', (e && e.message) || e);
    return {};
  }
}

/** One vendor's card, or null. Never throws. */
async function scorecardFor(contactId, opts) {
  if (!contactId) return null;
  const all = await scorecardsFor([contactId], opts);
  return all[contactId] || null;
}

/**
 * Every vendor we have ever ordered from, worst first — the admin's view of who
 * is actually delivering. Bounded; never throws.
 */
async function vendorLeaderboard({ contactType = null, limit = 200, now = new Date() } = {}) {
  try {
    const params = [Math.max(1, Math.min(500, Number(limit) || 200))];
    let typeSql = '';
    if (contactType) { params.push(contactType); typeSql = `AND c.contact_type = $${params.length}`; }
    const r = await db.query(
      `SELECT c.id, c.company_name, c.contact_name, c.email, c.contact_type,
              count(o.id)::int AS n
         FROM service_contacts c
         JOIN file_orders o ON o.vendor_contact_id = c.id AND o.ordered_at IS NOT NULL
         JOIN applications a ON a.id = o.application_id AND a.deleted_at IS NULL
        WHERE true ${typeSql}
        GROUP BY c.id
        -- Most-used first as the PRE-sort; the real ordering is by how well they
        -- perform, which needs the business-day arithmetic below.
        ORDER BY n DESC, c.id
        LIMIT $1`, params);
    const cards = await scorecardsFor(r.rows.map((x) => x.id), { now });
    const list = r.rows.map((x) => ({
      id: x.id,
      name: x.company_name || x.contact_name || x.email || 'Unnamed vendor',
      email: x.email || null,
      contactType: x.contact_type,
      card: cards[x.id] || null,
    })).filter((x) => x.card);
    // WORST FIRST: whoever is sitting on the most overdue work, then the least
    // punctual, then the slowest. A leaderboard sorted best-first is a trophy
    // cabinet; this is meant to be a to-do list.
    list.sort((a, b) => (b.card.overdueNow - a.card.overdueNow)
      || ((a.card.onTimePct == null ? 101 : a.card.onTimePct) - (b.card.onTimePct == null ? 101 : b.card.onTimePct))
      || ((b.card.medianHours || 0) - (a.card.medianHours || 0))
      || String(a.id).localeCompare(String(b.id)));
    return list;
  } catch (e) {
    console.error('[vendor-scorecard] leaderboard', (e && e.message) || e);
    return [];
  }
}

module.exports = {
  THIN_SAMPLE, scoreOrders, summarize, median,
  scorecardFor, scorecardsFor, vendorLeaderboard,
};
