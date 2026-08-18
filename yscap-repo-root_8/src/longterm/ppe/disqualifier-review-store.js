'use strict';
/**
 * LT PPE — the durable home of the PER-SCENARIO DISQUALIFIER REVIEW (db/581, owner-instructed
 * 2026-08-18). `disqualifier-review.js` computes the question; this is where it waits, and where the
 * ANSWER stays.
 *
 * IT IS A TABLE BECAUSE THE QUESTION IS RECOMPUTED AND THE ANSWER MUST NOT BE. The daily check prices
 * the same battery again tomorrow, so a review that lived only in the computation would re-ask every
 * question a reviewer had already settled, every day, forever. That exact failure has been paid for
 * twice on the RTL side — `ai_suggestions` re-raising a dismissed row on the next file view, and
 * `finding_decisions` (db/333) existing only to stop it — and the lesson is written into the shape
 * here rather than learned a third time.
 *
 * A DECISION SURVIVES A RE-RUN. Identity is (scope, program, scenario, item) and `recordItems` UPSERTS
 * on it: a re-run refreshes `last_seen_at` and touches nothing else on a decided row.
 *
 * BUT A CHANGED SITUATION REOPENS IT, and this is the half that keeps the queue honest. Every item
 * carries a `stateKey` — a fingerprint of what was TRUE when the question was asked (the
 * classification, plus what our sheet does about it, plus Lender Price's own reason). A decision
 * reached about "our sheet says nothing here" is NOT an answer about "our sheet now charges 0.750
 * points here", and silently keeping the old answer over a moved situation would be the queue quietly
 * lying about having been reviewed. When the state moves, the row reopens and the previous answer is
 * KEPT in `prior_decision` — never destroyed, so "was this ever looked at?" is always answerable.
 *
 * AN ITEM THAT STOPS APPEARING IS `stale`, NOT DELETED. A disqualifier Lender Price no longer raises
 * may have gone because somebody fixed our sheet, or because the vendor changed a rule, or because the
 * battery stopped generating that scenario — three very different things, and deleting the row would
 * erase the only record that could tell them apart. `markStaleFor` is scoped to ONE run's scenarios so
 * a partial battery can never retire questions it never looked at.
 *
 * IT DECIDES NOTHING. Recording "we should refuse this" does not write a rule, move a price, or
 * publish anything: putting a rule in force is a super admin's separate, recorded act (section 2.57).
 * This module stores what a person concluded and stops there, which is exactly what the owner asked
 * for.
 *
 * The clock is INJECTED (`opts.now`), matching every other PPE store — a module that reads the wall
 * clock cannot be tested for what it does at a boundary.
 *
 * LT-only. No RTL imports.
 */

const crypto = require('crypto');

const DECISIONS = ['refuse', 'price', 'allow', 'lp_is_wrong', 'needs_more_info'];

/** What each decision MEANS, in the words a person reads. Stored nowhere — rendered. */
const DECISION_WORDS = {
  refuse: 'We should refuse this loan too — our sheet needs a rule that turns it down.',
  price: 'We are right to price it — this is a loan we take, at a price.',
  allow: 'We should allow it with no extra charge — Lender Price is stricter than we want to be.',
  lp_is_wrong: 'Lender Price has this wrong — raise it with them; our sheet stands.',
  needs_more_info: 'Not enough to decide yet — somebody has to find something out first.',
};

/**
 * A stable digest of the scenario's FACTS.
 *
 * SORTED KEYS, AND NEVER `JSON.stringify` ON THE RAW OBJECT. Two engines building the same scenario in
 * a different key order would otherwise produce two different keys for one loan, and the queue would
 * carry the same question twice with the answer on only one of them. Undefined and null are dropped
 * rather than serialized, because "the fact was absent" and "the key was omitted" are the same
 * scenario and must not become two rows.
 */
function scenarioKey(scenario) {
  const s = (scenario && typeof scenario === 'object') ? scenario : {};
  const keys = Object.keys(s).filter((k) => s[k] !== undefined && s[k] !== null).sort();
  const flat = keys.map((k) => `${k}=${typeof s[k] === 'object' ? JSON.stringify(s[k]) : String(s[k])}`).join('|');
  return `sc_${crypto.createHash('sha256').update(flat).digest('hex').slice(0, 24)}`;
}

/**
 * What makes two rows the SAME question: the dimension when we could name one, Lender Price's own
 * reason text when we could not. The fallback matters — two refusals we cannot place on one scenario
 * are two separate things for somebody to name, and keying both on `null` would collapse them into one
 * row and lose one of them.
 */
function itemKey(item) {
  const d = item && item.dimension;
  if (d) return `dim:${d}`;
  const r = (item && item.lpReason) ? String(item.lpReason) : '';
  return `lp:${crypto.createHash('sha256').update(r).digest('hex').slice(0, 20)}`;
}

/**
 * The fingerprint of the SITUATION the question was asked about.
 *
 * Deliberately built from the three things a reviewer weighed: what we concluded our side does
 * (`classification`), WHAT our sheet actually does about it (the applied adjustments' rule codes and
 * cost, or the fact that it is silent), and Lender Price's own reason. Anything that moves one of
 * those makes the old answer an answer to a different question. It deliberately does NOT include
 * `last_seen_at` or any counter — a fingerprint that changed on every run would reopen every decision
 * on every run, which is the same as having no decisions at all.
 */
function stateKey(item) {
  const sheet = (item && item.ourSheet) || {};
  const adj = (Array.isArray(sheet.adjustments) ? sheet.adjustments : [])
    .map((a) => `${a.code || '?'}@${a.costMilli == null ? '?' : a.costMilli}`)
    .sort()
    .join(',');
  const parts = [
    item && item.classification,
    sheet.state || 'none',
    adj,
    (item && item.lpReason) || '',
    (item && item.ourEligibility && item.ourEligibility.declines) ? 'ours_declines' : 'ours_allows',
  ];
  return crypto.createHash('sha256').update(parts.join('')).digest('hex').slice(0, 24);
}

function nowOf(opts) {
  const n = opts && opts.now;
  if (typeof n === 'number' && Number.isFinite(n)) return Math.trunc(n);
  if (typeof n === 'function') return Math.trunc(n());
  return Date.now();
}

// node-postgres hands back a BIGINT column as a STRING, so a screen doing arithmetic on the clock —
// "how long has this been open?" — would concatenate rather than add, and `lastSeenAt === 2000` is
// false against "2000". Normalized once here, the way `agreement-store.js` does it.
function num(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// The state-moved test, written once and referenced by every branch of the upsert below. Spelling it
// out five times is how the branches drift and a reopened row keeps half its old answer.
const MOVED = `lt_ppe_disqualifier_review.state_key IS DISTINCT FROM EXCLUDED.state_key
                 AND lt_ppe_disqualifier_review.status = 'decided'`;

/**
 * Write one run's review items.
 *
 * Returns a per-item report — `inserted` / `refreshed` / `reopened` — because a caller (and the daily
 * check's own log) has to be able to say what a run actually changed. A run that reopens forty decided
 * questions is news; a run that refreshes forty is not, and the two must never look alike.
 */
async function recordItems(db, scope, programId, items, opts = {}) {
  const at = nowOf(opts);
  const out = { inserted: 0, refreshed: 0, reopened: 0, rows: [] };
  for (const item of (Array.isArray(items) ? items : [])) {
    const sKey = item.scenarioKey || scenarioKey(item.scenario);
    const iKey = itemKey(item);
    const st = stateKey(item);

    const res = await db.query(
      `INSERT INTO lt_ppe_disqualifier_review
         (scope, program_id, scenario_key, scenario, item_key, dimension, lp_reason, adj_type, layer,
          classification, needs_human, question, our_sheet, our_eligibility, state_key,
          status, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,'open',$16,$16)
       ON CONFLICT (scope, program_id, scenario_key, item_key) DO UPDATE SET
         scenario        = EXCLUDED.scenario,
         dimension       = EXCLUDED.dimension,
         lp_reason       = EXCLUDED.lp_reason,
         adj_type        = EXCLUDED.adj_type,
         layer           = EXCLUDED.layer,
         classification  = EXCLUDED.classification,
         needs_human     = EXCLUDED.needs_human,
         question        = EXCLUDED.question,
         our_sheet       = EXCLUDED.our_sheet,
         our_eligibility = EXCLUDED.our_eligibility,
         state_key       = EXCLUDED.state_key,
         last_seen_at    = EXCLUDED.last_seen_at,
         status = CASE WHEN ${MOVED} THEN 'open'
                       WHEN lt_ppe_disqualifier_review.status = 'stale' THEN 'open'
                       ELSE lt_ppe_disqualifier_review.status END,
         prior_decision = CASE WHEN ${MOVED}
                               THEN jsonb_build_object(
                                      'decision', lt_ppe_disqualifier_review.decision,
                                      'note', lt_ppe_disqualifier_review.decision_note,
                                      'by', lt_ppe_disqualifier_review.decided_by,
                                      'at', lt_ppe_disqualifier_review.decided_at,
                                      'stateKey', lt_ppe_disqualifier_review.state_key,
                                      'reopenedAt', EXCLUDED.last_seen_at)
                               ELSE lt_ppe_disqualifier_review.prior_decision END,
         decision      = CASE WHEN ${MOVED} THEN NULL ELSE lt_ppe_disqualifier_review.decision END,
         decision_note = CASE WHEN ${MOVED} THEN NULL ELSE lt_ppe_disqualifier_review.decision_note END,
         decided_by    = CASE WHEN ${MOVED} THEN NULL ELSE lt_ppe_disqualifier_review.decided_by END,
         decided_at    = CASE WHEN ${MOVED} THEN NULL ELSE lt_ppe_disqualifier_review.decided_at END
       RETURNING id, status, (xmax = 0) AS was_insert, prior_decision, decision`,
      [scope, programId, sKey, JSON.stringify(item.scenario || {}), iKey,
        item.dimension || null, item.lpReason || null, item.adjType || null, item.layer || null,
        item.classification, !!item.needsHuman, item.question || '',
        JSON.stringify(item.ourSheet || null), JSON.stringify(item.ourEligibility || null), st, at]);

    const row = res.rows[0];
    // `reopened` is read from the row's OWN state after the write — it was decided a moment ago and is
    // open now — rather than from what this run happened to compute. Inferring it from the inputs
    // would report a reopen that the database's own conditional did not actually perform.
    const reopened = !row.was_insert && row.status === 'open' && !row.decision && !!row.prior_decision;
    if (row.was_insert) out.inserted += 1;
    else if (reopened) out.reopened += 1;
    else out.refreshed += 1;
    out.rows.push({ id: row.id, scenarioKey: sKey, itemKey: iKey, status: row.status, reopened });
  }
  return out;
}

/**
 * Retire the questions this run looked at and no longer sees.
 *
 * SCOPED TO THE SCENARIOS THE RUN ACTUALLY COVERED. A battery is a sample, not the world: retiring
 * every row the run did not mention would quietly close every question about every scenario it did not
 * happen to generate. It also never touches a DECIDED row — a settled answer is not made obsolete by
 * the question ceasing to come up.
 */
async function markStaleFor(db, scope, programId, scenarioKeys, opts = {}) {
  const keys = (Array.isArray(scenarioKeys) ? scenarioKeys : []).filter(Boolean);
  if (!keys.length) return { staled: 0 };
  const at = nowOf(opts);
  const res = await db.query(
    `UPDATE lt_ppe_disqualifier_review
        SET status = 'stale'
      WHERE scope = $1 AND program_id = $2
        AND scenario_key = ANY($3::text[])
        AND status = 'open'
        AND last_seen_at < $4
      RETURNING id`, [scope, programId, keys, at]);
  return { staled: res.rows.length };
}

/** The queue, newest question first. `status` defaults to what is actually work. */
async function listQueue(db, scope, opts = {}) {
  const where = ['scope = $1'];
  const params = [scope];
  if (opts.programId) { params.push(opts.programId); where.push(`program_id = $${params.length}`); }
  const status = opts.status === 'all' ? null : (opts.status || 'open');
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (opts.dimension) { params.push(opts.dimension); where.push(`dimension = $${params.length}`); }
  if (opts.needsHumanOnly) where.push('needs_human = true');
  params.push(Math.min(Math.max(Number(opts.limit) || 100, 1), 500));
  const res = await db.query(
    `SELECT * FROM lt_ppe_disqualifier_review
      WHERE ${where.join(' AND ')}
      ORDER BY last_seen_at DESC, id
      LIMIT $${params.length}`, params);
  return res.rows.map(rowToItem);
}

/** How much work is waiting, by dimension — the shape of the answer, not just its size. */
async function queueSummary(db, scope, programId) {
  const res = await db.query(
    `SELECT status, classification, dimension, needs_human, count(*)::int AS n
       FROM lt_ppe_disqualifier_review
      WHERE scope = $1 AND ($2::uuid IS NULL OR program_id = $2)
      GROUP BY status, classification, dimension, needs_human`, [scope, programId || null]);
  const out = { open: 0, decided: 0, stale: 0, needsHuman: 0, byDimension: {}, byClassification: {} };
  for (const r of res.rows) {
    out[r.status] = (out[r.status] || 0) + r.n;
    if (r.status === 'open' && r.needs_human) {
      out.needsHuman += r.n;
      const d = r.dimension || 'unnamed';
      out.byDimension[d] = (out.byDimension[d] || 0) + r.n;
      out.byClassification[r.classification] = (out.byClassification[r.classification] || 0) + r.n;
    }
  }
  return out;
}

/**
 * Record a human's answer.
 *
 * REFUSES rather than throws, in the shape the rest of this surface uses, and refuses on the two
 * things that would make the record worthless: a decision outside the list, and a decision with nobody
 * named. db/581's CHECK refuses both at the database as well, so this cannot be bypassed by writing
 * the row directly.
 */
async function decide(db, scope, id, { decision, note = null, decidedBy = null } = {}, opts = {}) {
  if (!DECISIONS.includes(decision)) {
    return { ok: false, error: `"${decision}" is not one of the answers this queue takes.`, code: 'unknown_decision' };
  }
  const by = typeof decidedBy === 'string' ? decidedBy.trim() : '';
  if (!by) {
    return {
      ok: false,
      code: 'decider_required',
      error: 'Say who is deciding this — an underwriting decision with nobody named on it is not a record.',
    };
  }
  const at = nowOf(opts);
  const res = await db.query(
    `UPDATE lt_ppe_disqualifier_review
        SET status = 'decided', decision = $3, decision_note = $4, decided_by = $5, decided_at = $6
      WHERE scope = $1 AND id = $2
      RETURNING *`, [scope, id, decision, note, by, at]);
  if (!res.rows.length) return { ok: false, error: 'That question is no longer in the queue.', code: 'not_found' };
  return { ok: true, item: rowToItem(res.rows[0]) };
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    programId: row.program_id,
    scenarioKey: row.scenario_key,
    scenario: row.scenario,
    itemKey: row.item_key,
    dimension: row.dimension,
    lpReason: row.lp_reason,
    adjType: row.adj_type,
    layer: row.layer,
    classification: row.classification,
    needsHuman: row.needs_human,
    question: row.question,
    ourSheet: row.our_sheet,
    ourEligibility: row.our_eligibility,
    stateKey: row.state_key,
    status: row.status,
    decision: row.decision,
    decisionMeans: row.decision ? (DECISION_WORDS[row.decision] || null) : null,
    decisionNote: row.decision_note,
    decidedBy: row.decided_by,
    decidedAt: num(row.decided_at),
    priorDecision: row.prior_decision,
    firstSeenAt: num(row.first_seen_at),
    lastSeenAt: num(row.last_seen_at),
  };
}

module.exports = {
  scenarioKey,
  itemKey,
  stateKey,
  recordItems,
  markStaleFor,
  listQueue,
  queueSummary,
  decide,
  rowToItem,
  DECISIONS,
  DECISION_WORDS,
};
