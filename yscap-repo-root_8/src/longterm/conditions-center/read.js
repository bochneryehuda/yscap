'use strict';
/**
 * LONG-TERM — READING THE GENERAL CONDITION CENTER.
 *
 * One loan's conditions, grouped the way the work happens: by the gate they
 * block, in the buckets' own order.
 *
 * ── THE AUDIENCE IS APPLIED HERE, ONCE ──────────────────────────────────────
 *
 * `audience: 'client'` returns only what a borrower may see, under the BORROWER
 * wording, with the internal note dropped — not the internal object with fields
 * deleted. Building the client's payload FOR the client is defence (a); scrubbing
 * an internal one is defence (b), and (b) alone is how something gets out. It
 * FAILS CLOSED: anything that is not exactly `internal` is treated as a client.
 *
 * ── A COUNT IS THREE NUMBERS, NEVER ONE ─────────────────────────────────────
 *
 * "8 of 12 done" hides the difference between a condition that was satisfied,
 * one somebody waived, and one that never applied. They are three different
 * facts and the last two are the ones asked about a year later, so the summary
 * carries all of them and the screen decides what to show.
 *
 * ── A DEGRADED READ IS NOT AN EMPTY FILE ────────────────────────────────────
 *
 * An empty list reads as "nothing is outstanding", which is a claim and usually
 * a wrong one. Every read that could not complete says so.
 *
 * ── WHERE IT READS FROM (db/652 + db/653) ───────────────────────────────────
 *
 * The conditions are `checklist_items` in the ONE Condition Center, owned by
 * `lt_loan_id`; the BUCKETS are still Long-Term's own (`lt_condition_buckets` —
 * the owner's headings and their order). Every enumerated value comes back
 * through `vocabulary.js`, the same translation the seed wrote through, which is
 * what keeps the three numbers below three: `waived` and `not_applicable` are
 * recovered from (status, waived_at, is_required) rather than collapsed into
 * "satisfied".
 */

const db = require('../db');
const vocab = require('./vocabulary');
const { ownerOf, ownerWhere } = require('../../lib/condition-owner');

const CLIENT_VISIBLE = new Set(['external', 'both']);

/** Statuses that mean the condition is no longer work. */
const DONE = new Set(['satisfied', 'waived', 'not_applicable']);

/**
 * THE DOCUMENTS ON THIS FILE'S CONDITIONS, one query for the whole loan.
 *
 * INTERNAL ONLY — the caller adds these to the staff shape and never to the
 * client one. The `shape()` header records what is deliberately absent from a
 * borrower's payload and this belongs on that list for a sharper reason than
 * most: a rejection reason and a slot label are staff free text.
 *
 * THE COLUMN NAMES ARE THE SHARED TABLE'S OWN, deliberately unrenamed. The
 * screen hands these rows straight to the shared Condition Center components,
 * which read `review_status` / `is_current` / `reviewed_by_name` /
 * `rejection_reason` off a document row — renaming a field here to suit
 * Long-Term would either force the LT screen to map back, or tempt somebody to
 * rename it inside a SHARED component, which silently changes the short-term
 * product. One owner-scoped statement, in the statement (`ownerWhere`), so a
 * document from another loan or another product matches no row.
 */
async function documentsByCondition(loanId, client = db) {
  const where = ownerWhere(ownerOf('lt_loan', loanId), 'd');
  const { rows } = await client.query(
    `SELECT d.id, d.checklist_item_id, d.filename, d.content_type, d.size_bytes,
            d.slot_label, d.doc_kind, d.is_current, d.created_at,
            COALESCE(d.review_status, 'pending') AS review_status,
            d.rejection_reason, d.reviewed_at,
            rev.full_name AS reviewed_by_name
       FROM documents d
       LEFT JOIN staff_users rev ON rev.id = d.reviewed_by
      WHERE ${where.sql} AND d.checklist_item_id IS NOT NULL
      ORDER BY d.created_at`,
    where.params,
  );
  const byItem = new Map();
  for (const r of rows) {
    const key = String(r.checklist_item_id);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(r);
  }
  return byItem;
}

/** The buckets, in order, including any a buyer added. */
async function buckets(client = db) {
  const { rows } = await client.query(
    `SELECT key, label, blurb, position
       FROM lt_condition_buckets
      WHERE is_active = true
      ORDER BY position, key`,
  );
  return rows.map((r) => ({ key: r.key, label: r.label, blurb: r.blurb || null, position: r.position }));
}

/**
 * One loan's conditions, grouped by bucket.
 *
 * @param {string} loanId
 * @param {{audience?: 'internal'|'client', db?: object}} opts
 */
async function forLoan(loanId, opts = {}) {
  const client = opts.db || db;
  const internal = opts.audience === 'internal';

  let list = [];
  let bucketRows = [];
  let degraded = null;
  let docsByItem = new Map();
  try {
    bucketRows = await buckets(client);
    const where = ownerWhere(ownerOf('lt_loan', loanId), 'c');
    const { rows } = await client.query(
      `SELECT c.id, t.code, c.category, c.field_key, c.label, c.hint,
              c.borrower_label, c.borrower_hint, c.audience, c.item_kind, c.tool_key,
              c.is_required, c.slots, c.tool_payload AS answer,
              c.status, c.origin_kind, c.sort_order, c.notes,
              c.signed_off_at AS satisfied_at, c.waived_at, c.waived_reason,
              sat.full_name AS satisfied_by_name,
              wav.full_name AS waived_by_name,
              t.config,
              (SELECT count(*) FROM documents d
                WHERE d.checklist_item_id = c.id AND d.is_current) AS file_count,
              (SELECT count(*) FROM documents d
                WHERE d.checklist_item_id = c.id AND d.is_current
                  AND d.review_status = 'accepted') AS accepted_count
         FROM checklist_items c
         LEFT JOIN checklist_templates t ON t.id = c.template_id
         LEFT JOIN staff_users sat ON sat.id = c.signed_off_by
         LEFT JOIN staff_users wav ON wav.id = c.waived_by
        WHERE ${where.sql}
        ORDER BY c.sort_order, c.label`,
      where.params,
    );
    // Read back into the owner's own wording BEFORE anything else looks at it,
    // so the audience filter, the buckets and the three numbers all reason about
    // one vocabulary. `config` is read off the TEMPLATE — one config, edited
    // once, rather than a per-instance copy free to go stale.
    list = rows.map((r) => ({
      ...r,
      bucket_key: vocab.bucketOf(r.category),
      audience: vocab.audienceFromShared(r.audience),
      kind: vocab.kindFromShared(r),
      origin: vocab.originFromShared(r.origin_kind),
      status: vocab.statusOf(r),
      config: r.config || {},
      is_enabled: !(r.config && r.config.enabled === false),
      disabled_reason: (r.config && r.config.disabledReason) || null,
    }));
    // The documents are read only for the TEAM's screen. A failure here is the
    // same class of degraded read as the conditions themselves — the file is
    // reported with its counts and without the list, never as a file with no
    // documents on it.
    if (internal) docsByItem = await documentsByCondition(loanId, client);
  } catch (e) {
    degraded = String((e && e.message) || e).slice(0, 300);
  }

  const visible = list.filter((r) => internal || CLIENT_VISIBLE.has(String(r.audience || 'internal')));
  const shaped = visible.map((r) => shape(r, internal, docsByItem.get(String(r.id)) || []));

  const byBucket = new Map();
  for (const b of bucketRows) byBucket.set(b.key, { ...b, conditions: [], summary: emptySummary() });
  for (const c of shaped) {
    // A condition whose bucket a buyer retired still shows, under the key it was
    // filed with. Dropping it would be the one outcome nobody could explain.
    if (!byBucket.has(c.bucket)) {
      byBucket.set(c.bucket, { key: c.bucket, label: c.bucket, blurb: null, position: 999, conditions: [], summary: emptySummary(), retired: true });
    }
    const b = byBucket.get(c.bucket);
    b.conditions.push(c);
    count(b.summary, c);
  }

  const groups = [...byBucket.values()]
    .sort((a, b) => a.position - b.position || String(a.key).localeCompare(String(b.key)))
    // An EMPTY bucket is dropped from a client's view and KEPT for staff: the
    // team's screen is a map of the whole workflow, the borrower's is a list of
    // what is being asked of them, and a heading over nothing on a borrower's
    // screen reads as something missing.
    .filter((b) => internal || b.conditions.length > 0);

  const summary = emptySummary();
  for (const c of shaped) count(summary, c);

  return { buckets: groups, summary, degraded, audience: internal ? 'internal' : 'client' };
}

function emptySummary() {
  return { total: 0, outstanding: 0, inProgress: 0, received: 0, satisfied: 0, waived: 0, notApplicable: 0, done: 0 };
}

function count(s, c) {
  s.total += 1;
  if (c.status === 'outstanding') s.outstanding += 1;
  else if (c.status === 'in_progress') s.inProgress += 1;
  else if (c.status === 'received') s.received += 1;
  else if (c.status === 'satisfied') s.satisfied += 1;
  else if (c.status === 'waived') s.waived += 1;
  else if (c.status === 'not_applicable') s.notApplicable += 1;
  if (DONE.has(c.status)) s.done += 1;
}

/**
 * One condition, for one audience.
 *
 * The client's object is BUILT rather than stripped, and it is built from the
 * borrower wording with a fallback to the internal label ONLY where the engine
 * has already decided the condition is borrower-facing — which it only does when
 * borrower wording exists. So the fallback is unreachable in practice and is
 * there so a hand-inserted row can never render blank.
 */
function shape(r, internal, docs = []) {
  const base = {
    id: r.id,
    code: r.code || null,
    bucket: r.bucket_key,
    fieldKey: r.field_key || null,
    kind: r.kind,
    status: r.status,
    isRequired: r.is_required,
    slots: slotsFor(r, internal),
    documents: { total: Number(r.file_count) || 0, accepted: Number(r.accepted_count) || 0 },
  };

  if (!internal) {
    return {
      ...base,
      label: r.borrower_label || r.label,
      hint: r.borrower_hint || null,
      // DELIBERATELY ABSENT for a client: the internal note, who signed it off,
      // why it was waived, the condition's own settings, and whether the
      // template is switched on. Every one of those is a fact about how WE work.
    };
  }

  return {
    ...base,
    // The documents themselves, for the team only — see `documentsByCondition`.
    // The two counts above stay exactly as they were, so every existing reader
    // of `documents.total` / `.accepted` is untouched.
    documents: { ...base.documents, list: docs },
    label: r.label,
    hint: r.hint || null,
    borrowerLabel: r.borrower_label || null,
    borrowerHint: r.borrower_hint || null,
    audience: r.audience,
    origin: r.origin,
    notes: r.notes || null,
    config: r.config || {},
    answer: r.answer || {},
    satisfiedAt: r.satisfied_at,
    satisfiedBy: r.satisfied_by_name || null,
    waivedAt: r.waived_at,
    waivedBy: r.waived_by_name || null,
    waivedReason: r.waived_reason || null,
    // A condition whose TEMPLATE is switched off is shown greyed WITH ITS
    // REASON rather than hidden: hiding it would read as a feature that vanished,
    // and a person who was told about it would go looking for a bug.
    enabled: r.is_enabled !== false,
    disabledReason: r.is_enabled === false ? (r.disabled_reason || null) : null,
  };
}

/**
 * The slots, with the ones this file cannot use removed.
 *
 * A slot carrying `whenField` / `notWhenField` names a rule field, and the
 * ENGINE has already decided the condition applies — but a slot is finer than a
 * condition: New York's title package genuinely has fewer of them, and leaving a
 * slot nobody can ever fill on the screen is what makes a file look permanently
 * incomplete. The values come from the condition's own stored `answer.fields`
 * when the engine wrote them there; where they are absent the slot is KEPT,
 * because hiding a slot on a guess is the expensive direction.
 */
function slotsFor(r, internal) {
  const slots = Array.isArray(r.slots) ? r.slots : [];
  const values = (r.answer && r.answer.fields) || {};
  return slots
    .filter((s) => {
      if (s.whenField && values[s.whenField] === false) return false;
      if (s.notWhenField && values[s.notWhenField] === true) return false;
      return true;
    })
    .map((s) => (internal ? s : { key: s.key, label: s.label, required: !!s.required }));
}

module.exports = {
  buckets, forLoan, documentsByCondition, DONE, CLIENT_VISIBLE,
  _internals: { shape, slotsFor, count, emptySummary },
};
