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
const audience = require('../audience');

const CLIENT_VISIBLE = new Set(['external', 'both']);

/**
 * ONE SCRUB FOR EVERY SENTENCE A CLIENT READS OFF A CONDITION.
 *
 * `audience.scrubInvestorNames` is the single definition (charter rule 10 — a
 * second copy is how the two drift and the drifted one leaks); this only carries
 * the two rules every caller here would otherwise repeat: a blank stays NULL
 * rather than becoming an empty string, and a non-string is never handed to the
 * scrubber. It FAILS CLOSED on nothing — the scrubber itself already refuses any
 * audience that is not exactly `internal`.
 */
function scrubClient(v) {
  if (v === null || v === undefined || v === '') return null;
  return audience.scrubInvestorNames(String(v), 'borrower');
}

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
                  AND d.review_status = 'accepted') AS accepted_count,
              -- WHY A REJECTED CONDITION HAS TO SAY WHY, TO THE BORROWER TOO.
              -- Rejecting a document sets the condition back to outstanding (see
              -- condition-docs/review.js). With no reason the borrower watches a
              -- condition re-open unexplained and uploads the same wrong document
              -- again, which is the whole cost of leaving it out.
              --
              -- THE TWO SOURCES ARE THE ONES THE SHORT-TERM BORROWER DOOR READS,
              -- in its order: the condition's own borrower-SAFE issue reason,
              -- then the newest rejected document's reason. The issue reason is
              -- written by short-term paths only and is always NULL on a
              -- long-term row today; it is read anyway so that the day anything
              -- writes one, this door already shows the better answer instead of
              -- silently omitting it. The internal note is never a candidate --
              -- it is precisely the field this pair exists to avoid.
              --
              -- KEEP THIS COMMENT CLAUSE-FREE AND BACKTICK-FREE. It sits inside a
              -- SQL template literal: a backtick ends the literal outright, and
              -- the separation gate parses the prose as SQL, so an ordinary
              -- sentence naming a table reads as a cross-product query.
              COALESCE(c.issue_reason,
                (SELECT d.rejection_reason FROM documents d
                  WHERE d.checklist_item_id = c.id AND d.review_status = 'rejected'
                  ORDER BY d.reviewed_at DESC NULLS LAST LIMIT 1)) AS rejection_reason
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
  /* THE FILE'S OWN RULE VALUES, read ONCE for the whole list rather than per
     condition — the same values the engine decided the conditions with, so a
     slot that is dropped and a contact that is greyed are answering the same
     question the rule answered. Best-effort by design: an unreadable context
     leaves `live` null, `slotsFor` falls back to keeping every slot and
     `contactTypesFor` answers `applies: null` ("we could not tell"), which is
     the honest reading and never a confident "does not apply". */
  const live = await liveFieldValues(loanId, client);
  const shaped = visible.map((r) => shape(r, internal, docsByItem.get(String(r.id)) || [], live));

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

/**
 * The loan's rule-field values, or null.
 *
 * `engine.loadContext` + `registry.read` is the SAME pair the engine itself uses
 * to decide which conditions apply, so this cannot drift from the decision that
 * put the conditions on the file. Required lazily: `read.js` is imported by the
 * guest door and by the client view, and the engine pulls in the whole rule
 * stack — a cost neither of those pays until a condition actually asks.
 *
 * NEVER THROWS. Reading the list of conditions must not fail because one
 * property row could not be read.
 */
async function liveFieldValues(loanId, client) {
  try {
    const engine = require('./engine');
    const registry = require('./field-registry');
    // loadContext takes the CLIENT ITSELF, not an options object. Passing
    // { db: client } gives it something with no .query, every read throws into
    // its own per-query catch, and it answers a context whose every field is
    // null — a silent, confident "nothing applies to this file".
    const ctx = await engine.loadContext(loanId, client);
    if (!ctx) return null;
    const values = ctx.values || registry.read(ctx);
    return values && typeof values === 'object' ? values : null;
  } catch (_) {
    return null;
  }
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
function shape(r, internal, docs = [], live = null) {
  const base = {
    id: r.id,
    code: r.code || null,
    bucket: r.bucket_key,
    fieldKey: r.field_key || null,
    kind: r.kind,
    status: r.status,
    isRequired: r.is_required,
    slots: slotsFor(r, internal, live),
    /* The contacts this condition asks for. Empty on every condition that asks
       for none, so the screens that do not draw contacts are untouched. */
    contactTypes: contactTypesFor(r, live),
    documents: { total: Number(r.file_count) || 0, accepted: Number(r.accepted_count) || 0 },
  };

  if (!internal) {
    /* THE WORDING A CLIENT READS IS SCRUBBED TOO, for the same reason the
       rejection reason below is. `label` and `hint` are NOT a fixed whitelist:
       the desk may PATCH both (routes/condition-center.js writes label / hint /
       borrower_label / borrower_hint from free text), so what a borrower reads
       here is a sentence a human typed, which is precisely the charter's second
       defence — scrub the free text. MEASURED before it shipped: every one of
       the 82 strings the shipped library carries passes through unchanged, so
       this is inert on every word the owner wrote and bites only on a name a
       staffer types afterwards. */
    return {
      ...base,
      label: scrubClient(r.borrower_label || r.label),
      hint: scrubClient(r.borrower_hint),
      /* THE REASON A DOCUMENT CAME BACK, SCRUBBED. This is the one piece of staff
         free text a client is entitled to, because rejecting their document is
         an instruction to them and an instruction with no reason cannot be
         followed. It goes through the investor scrub for exactly the reason the
         charter names: it is a sentence a human typed, so it is the second
         defence's own case, not the whitelist's. Null unless something really
         was rejected — an empty reason on a healthy condition would read as a
         problem nobody has. */
      rejectionReason: scrubClient(r.rejection_reason),
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
function slotsFor(r, internal, live) {
  const slots = Array.isArray(r.slots) ? r.slots : [];
  /* THE LIVE VALUES WIN, and until they existed this filter never fired.
     The comment below used to say the values come from the condition's own
     stored `answer.fields` — but NOTHING WRITES THAT KEY (the engine reads the
     rule context and never persists it), so `values` was always `{}` and every
     slot was always kept. The visible cost: the owner asked for New York's title
     package to drop the closing protection letter and the preliminary settlement
     statement, `notWhenField: 'is_new_york'` was written to do it, and on a real
     New York file both slots were still there. The stored answer is kept as the
     fallback so a caller that cannot reach the context behaves as before. */
  const values = { ...((r.answer && r.answer.fields) || {}), ...(live || {}) };
  return slots
    .filter((s) => {
      if (s.whenField && values[s.whenField] === false) return false;
      if (s.notWhenField && values[s.notWhenField] === true) return false;
      return true;
    })
    .map((s) => (internal ? s : { key: s.key, label: s.label, required: !!s.required }));
}

/**
 * The contacts a condition asks for, each saying whether it applies to THIS file.
 *
 * DELIBERATELY NOT THE SAME TREATMENT AS A SLOT. A slot that cannot apply is
 * REMOVED (a New York file genuinely has fewer documents, and an unfillable slot
 * makes a finished file look incomplete). A contact that cannot apply is KEPT and
 * MARKED — owner-directed 2026-08-31: *"The New York Settlement Agent Order
 * should be grayed out. And collapsed. Be visible that doesn't belong for this
 * file."* The two are different because a slot is a place to put something and a
 * contact is a question about the deal: seeing that the question was asked and
 * answered "not this file" is the reassurance; seeing an empty box is not.
 *
 * `applies` is THREE-VALUED and the third value is the point: `null` means we
 * could not read the field, which must never render as a confident "no".
 */
function contactTypesFor(r, live) {
  const types = (r.config && Array.isArray(r.config.contactTypes)) ? r.config.contactTypes : [];
  const values = { ...((r.answer && r.answer.fields) || {}), ...(live || {}) };
  return types.map((t) => {
    let applies = true;
    let whyNot = null;
    if (t.whenField) {
      const v = values[t.whenField];
      if (v === true) applies = true;
      else if (v === false) { applies = false; whyNot = FIELD_WHY[t.whenField] || 'This file does not need it.'; }
      else { applies = null; whyNot = 'Not established on this file yet.'; }
    }
    return { key: t.key, label: t.label, required: !!t.required, applies, whyNot };
  });
}

/* Plain-language reasons, keyed on the rule field. One wording, so the contact
   row and the order card can never explain the same fact two different ways. */
const FIELD_WHY = Object.freeze({
  is_new_york: 'Only on a New York file.',
  in_flood_zone: 'Only where the property is in a flood zone.',
  is_condo: 'Only on a condominium.',
  borrower_rents: 'Only where the borrower rents where they live.',
});

module.exports = {
  buckets, forLoan, documentsByCondition, DONE, CLIENT_VISIBLE,
  _internals: { shape, slotsFor, contactTypesFor, liveFieldValues, count, emptySummary },
};
