'use strict';
/**
 * ASKING FOR A DOCUMENT ABOUT A PAST PROJECT — typed, and connected three ways.
 *
 * Owner-directed: *"When you request a document, it should post that as
 * underwriting conditions connected, and it should be a real workflow over
 * there, with internal notes on everything."*
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * The ask was a `window.prompt`. Whatever the staffer typed became the label,
 * the borrower's instruction and the idempotency key all at once — so "OA" and
 * "operating agreement" made two conditions for one document, nothing knew
 * WHICH document had been asked for, and nothing knew WHY. The upload landed on
 * the oldest open request for the line, whichever ask that happened to be.
 *
 * ── THE ASK, THE SLOT AND THE PILLAR ARE ONE WORD ──────────────────────────
 * `field_key = trdoc:<trackRecordId>:<slug>:<pillar>` carries all three, so:
 *   · an identical ask REUSES its row and a different ask makes its own — the
 *     idempotency the free-text version could never have;
 *   · the row knows which of the three pillars it was meant to move, so an
 *     accepted document can advance that pillar instead of a human guessing;
 *   · `track_record_id` says which property, so one upload closes the request
 *     and files against the line in the same action.
 *
 * ── THE COMPANY GOES IN `raised_entity`, NOT IN `llc_id` ───────────────────
 * `checklist_items` carries a CHECK constraint, `chk_one_owner`, that allows
 * EXACTLY ONE of `application_id` / `borrower_id` / `llc_id` to be set: those
 * three are not pointers, they are the row's OWNER, one per `scope`. Writing
 * the company into `llc_id` on a request owned by a file or a profile is
 * therefore refused by the database — which is right, and it is what the DB
 * test caught on its first run.
 *
 * So the entity is recorded in `raised_entity` (db/075), the jsonb column that
 * already means "what this condition is about" for a raised issue. The OWNER
 * stays the file or the borrower, because they are who has to act; the company
 * is what the document concerns. Never re-point `llc_id` to "connect" a
 * condition to an entity — an LLC-owned row is an LLC's own document SLOT, a
 * different thing entirely.
 *
 * ── PURE / IMPURE SPLIT ─────────────────────────────────────────────────────
 * The vocabulary, the key and every word the borrower reads are PURE and unit-
 * tested offline. Only `requestDocument` touches the database. That matters
 * because the borrower-facing sentence is the part most likely to be got wrong
 * and the part hardest to test through HTTP.
 *
 * ── A REQUEST NEVER NEEDS A LOAN FILE ──────────────────────────────────────
 * An operating agreement is a fact about the BORROWER, not about one loan. Both
 * old routes refused without an `applicationId`, so a property on the profile of
 * someone with no open file could not be chased at all. A request made without
 * a file is `scope='borrower_profile'` — a shape `checklist_items` has always
 * supported and the LLC slots already use — and `migrateProfileRequests` moves
 * it onto a file when one opens, keeping the same row so its history, its
 * documents and its notes travel with it.
 */

const notify = require('../notify');

/** The three pillars, spelled as db/494 spells them. */
const PILLARS = ['recency', 'ownership', 'exit'];

/**
 * What a reviewer may ask for. The vocabulary the owner listed, plus the four
 * entity documents, each mapped to:
 *   pillars       which of the three questions this document can answer
 *   defaultPillar the one it usually answers, pre-selected in the picker
 *   target        'property' (files on the line) | 'entity' (also belongs on the
 *                 company's own document slot, so it is available forever)
 *   slot          the LLC checklist template code, when target is 'entity'
 *
 * A closing statement can serve ownership OR the exit depending on whether it is
 * the purchase or the sale, which is exactly why the requester picks the pillar
 * rather than the type implying it.
 */
const DOC_TYPES = [
  { slug: 'closing_statement', label: 'Closing statement (HUD/ALTA)', pillars: ['ownership', 'exit', 'recency'], defaultPillar: 'exit', target: 'property' },
  { slug: 'deed', label: 'Deed', pillars: ['ownership', 'exit', 'recency'], defaultPillar: 'ownership', target: 'property' },
  { slug: 'recorded_mortgage', label: 'Recorded mortgage', pillars: ['ownership', 'exit', 'recency'], defaultPillar: 'exit', target: 'property' },
  { slug: 'payoff_statement', label: 'Payoff statement', pillars: ['exit', 'recency'], defaultPillar: 'exit', target: 'property' },
  { slug: 'lease', label: 'Lease', pillars: ['exit', 'recency'], defaultPillar: 'exit', target: 'property' },
  { slug: 'tenant_estoppel', label: 'Tenant estoppel', pillars: ['exit'], defaultPillar: 'exit', target: 'property' },
  { slug: 'certificate_of_occupancy', label: 'Certificate of occupancy', pillars: ['exit', 'recency'], defaultPillar: 'exit', target: 'property' },
  { slug: 'schedule_e', label: 'Schedule E (tax return)', pillars: ['ownership', 'exit'], defaultPillar: 'ownership', target: 'property' },
  { slug: 'bank_statements', label: 'Bank statements', pillars: ['exit'], defaultPillar: 'exit', target: 'property' },
  { slug: 'property_profile_report', label: 'Property profile report', pillars: ['ownership', 'exit', 'recency'], defaultPillar: 'ownership', target: 'property' },
  // The entity four. `slot` is the LLC checklist template code the document
  // belongs on afterwards — the same codes `entity-adopt.SLOT_FOR_DOC_TYPE`
  // uses, so a document arriving either way lands in the same place.
  { slug: 'operating_agreement', label: 'Operating agreement', pillars: ['ownership'], defaultPillar: 'ownership', target: 'entity', slot: 'rtl_llc_opagmt' },
  { slug: 'articles_of_organization', label: 'Articles of organization', pillars: ['ownership'], defaultPillar: 'ownership', target: 'entity', slot: 'rtl_llc_formation' },
  { slug: 'ein_letter', label: 'EIN letter', pillars: ['ownership'], defaultPillar: 'ownership', target: 'entity', slot: 'rtl_llc_ein' },
  { slug: 'certificate_of_good_standing', label: 'Certificate of good standing', pillars: ['ownership'], defaultPillar: 'ownership', target: 'entity', slot: 'rtl_llc_goodstanding' },
  { slug: 'other', label: 'Other', pillars: PILLARS, defaultPillar: 'ownership', target: 'property' },
];

const BY_SLUG = new Map(DOC_TYPES.map((d) => [d.slug, d]));

/** The requested type, or null. Never guesses from a near-miss. */
const docType = (slug) => BY_SLUG.get(String(slug || '').trim()) || null;

/**
 * What each pillar is FOR, in the borrower's own words. Never says "pillar",
 * never says "verification" — it says what the document proves about their
 * project, which is the only framing that gets a document uploaded.
 */
const PILLAR_PURPOSE = {
  ownership: (property) => `to confirm you owned ${property}`,
  exit: (property) => `to confirm how ${property} was finished`,
  recency: (property) => `to confirm when ${property} was finished`,
};

const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 500);

/**
 * `trdoc:<trackRecordId>:<slug>:<pillar>` — the idempotency key AND the record
 * of what was asked. Returns '' when any part is missing, and every caller must
 * read that as "cannot build a request", never as a usable key.
 */
function fieldKeyFor(trackRecordId, slug, pillar) {
  const id = clean(trackRecordId, 64);
  const t = docType(slug);
  const p = PILLARS.includes(pillar) ? pillar : '';
  if (!id || !t || !p) return '';
  return `trdoc:${id}:${t.slug}:${p}`;
}

/** The inverse. Returns null for anything that is not one of our keys. */
function parseFieldKey(key) {
  const m = String(key || '').match(/^trdoc:([^:]+):([^:]+):([^:]+)$/);
  if (!m) return null;
  const t = docType(m[2]);
  if (!t || !PILLARS.includes(m[3])) return null;
  return { trackRecordId: m[1], slug: t.slug, pillar: m[3], docType: t };
}

/**
 * Exactly what the borrower will read, shown to the staffer BEFORE they post it.
 *
 * The blueprint's own example is the contract: "We need the operating agreement
 * for MW Trading LLC to confirm your ownership of 62 Highland Street." An entity
 * document names the company; a property document does not.
 */
function borrowerSentence({ slug, pillar, entityName, propertyLabel, customLabel }) {
  const t = docType(slug);
  if (!t) return '';
  const p = PILLARS.includes(pillar) ? pillar : t.defaultPillar;
  const place = clean(propertyLabel, 200) || 'this property';
  const forEntity = t.target === 'entity' && clean(entityName, 200)
    ? ` for ${clean(entityName, 200)}`
    : '';
  /* "Other" has no name of its own, so "We need the other …" is nonsense. It
     uses whatever the reviewer typed, and falls back to a sentence that at
     least tells the borrower a document is wanted and what it is for. */
  const what = t.slug === 'other'
    ? (clean(customLabel, 160) ? `the ${clean(customLabel, 160).toLowerCase()}` : 'one more document')
    : `the ${t.label.replace(/\s*\(.*\)\s*$/, '').toLowerCase()}`;
  return `We need ${what}${forEntity} ${PILLAR_PURPOSE[p](place)}.`;
}

/** The staff-facing label — the desk reads the property first. */
function staffLabel({ slug, pillar, propertyLabel, entityName, customLabel }) {
  const t = docType(slug);
  if (!t) return '';
  const p = PILLARS.includes(pillar) ? pillar : t.defaultPillar;
  const who = t.target === 'entity' && clean(entityName, 120) ? ` — ${clean(entityName, 120)}` : '';
  const named = t.slug === 'other' && clean(customLabel, 120) ? clean(customLabel, 120) : t.label;
  return `Track record — ${clean(propertyLabel, 120) || 'a past project'}: ${named}${who} (${p})`.slice(0, 300);
}

/**
 * Everything a request needs, validated, with the exact words on it. PURE, so a
 * screen can render the preview without posting anything.
 * Returns `{ ok:false, error }` rather than throwing — the caller is a route.
 */
function buildRequest({ trackRecordId, slug, pillar, entityName, propertyLabel, llcId, customLabel }) {
  const t = docType(slug);
  if (!t) return { ok: false, error: 'pick a document type from the list' };
  const p = PILLARS.includes(pillar) ? pillar : t.defaultPillar;
  /* The label goes in quotes rather than after an article: "a operating
     agreement" and "a articles of organization" are both wrong, and a message
     that reads as broken English is a message nobody trusts. */
  if (!t.pillars.includes(p)) {
    return { ok: false, error: `“${t.label}” cannot answer the ${p} question — pick ${t.pillars.join(' or ')}` };
  }
  const fieldKey = fieldKeyFor(trackRecordId, t.slug, p);
  if (!fieldKey) return { ok: false, error: 'which property is this about?' };
  if (t.target === 'entity' && !llcId) {
    return { ok: false, error: `“${t.label}” belongs to a company — say which one` };
  }
  const named = t.slug === 'other' && clean(customLabel, 160) ? clean(customLabel, 160) : t.label;
  return {
    ok: true,
    fieldKey,
    slug: t.slug,
    pillar: p,
    target: t.target,
    slot: t.slot || null,
    label: staffLabel({ slug: t.slug, pillar: p, propertyLabel, entityName, customLabel }),
    borrowerLabel: `${named} — ${clean(propertyLabel, 160) || 'a past project'}`.slice(0, 300),
    borrowerSentence: borrowerSentence({ slug: t.slug, pillar: p, entityName, propertyLabel, customLabel }),
  };
}

/* ── the impure half ─────────────────────────────────────────────────────── */

/**
 * Post the request as a real condition.
 *
 * @param {object} a
 * @param {string} a.trackRecordId  the property being asked about — required
 * @param {string} a.borrowerId     whose record it is — required
 * @param {string} [a.appId]        the loan file. WITHOUT one the request is
 *                                  borrower-profile-scoped and still real.
 * @param {string} a.slug           a `DOC_TYPES` slug
 * @param {string} [a.pillar]       defaults to the type's own
 * @param {string} [a.llcId]        required for an entity document
 * @param {string} [a.internalNote] staff-only, recorded on the condition
 * @param {string} a.actorId
 * @returns {{itemId, reused, scope, fieldKey, pillar, borrowerSentence}}
 *
 * Throws with `.status` for anything a route should answer 4xx.
 */
async function requestDocument(a, client) {
  const db = client || require('../../db');
  const trackRecordId = clean(a.trackRecordId, 64);
  if (!trackRecordId) { const e = new Error('which property is this about?'); e.status = 400; throw e; }

  const tr = (await db.query(
    `SELECT borrower_id, property_address, llc_id, entity_name FROM track_records WHERE id=$1`,
    [trackRecordId])).rows[0];
  if (!tr) { const e = new Error('track record not found'); e.status = 404; throw e; }

  const llcId = clean(a.llcId, 64) || tr.llc_id || null;
  let entityName = clean(a.entityName, 200) || clean(tr.entity_name, 200) || '';
  if (llcId && !entityName) {
    const l = (await db.query(`SELECT llc_name FROM llcs WHERE id=$1`, [llcId])).rows[0];
    entityName = (l && l.llc_name) || '';
  }

  const built = buildRequest({
    trackRecordId, slug: a.slug, pillar: a.pillar, entityName, llcId,
    customLabel: a.customLabel,
    propertyLabel: addressLabel(tr.property_address),
  });
  if (!built.ok) { const e = new Error(built.error); e.status = 400; throw e; }

  // A file makes it a condition on that loan; without one it lives on the
  // person, which is where an operating agreement belongs anyway.
  const scope = a.appId ? 'application' : 'borrower_profile';
  const appId = a.appId || null;

  /* Idempotent on the KEY, and on the FILE it is scoped to — the same ask on two
     different loans is two conditions, which is right: each file has to see it.
     A satisfied row is deliberately not reused; asking again after sign-off is a
     new ask. */
  const existing = (await db.query(
    `SELECT id FROM checklist_items
      WHERE field_key=$1
        AND application_id IS NOT DISTINCT FROM $2::uuid
        AND status <> 'satisfied'
      LIMIT 1`, [built.fieldKey, appId])).rows[0];

  const originDetail = JSON.stringify({
    raisedAgainst: 'track_record', entityId: trackRecordId,
    docType: built.slug, pillar: built.pillar, target: built.target, slot: built.slot,
    llcId: llcId || null, entityName: entityName || null,
  });
  /* What the document is ABOUT. An entity document names the company (so the
     screen and the upload path can find its slot); a property document names
     the property. Never the row's owner — see the header. */
  const raisedEntity = JSON.stringify(built.target === 'entity' && llcId
    ? { kind: 'llc', id: String(llcId), name: entityName || 'the entity' }
    : { kind: 'track_record', id: String(trackRecordId), name: addressLabel(tr.property_address) || 'a past project' });

  let itemId;
  if (existing) {
    /* Audience is only ever RAISED. An ask already shown to the borrower must
       never silently go internal on a re-post — the same rule raise-issue.js
       settled on 2026-08-04. */
    await db.query(
      `UPDATE checklist_items
          SET label=$2, borrower_label=$3, hint=$4, borrower_hint=$4,
              audience='both', issue_reason=$4, track_record_id=$5,
              raised_entity=$6::jsonb, origin_detail=$7::jsonb,
              status = CASE WHEN status='issue' THEN 'issue' ELSE 'outstanding' END,
              updated_at=now()
        WHERE id=$1`,
      [existing.id, built.label, built.borrowerLabel, built.borrowerSentence,
        trackRecordId, raisedEntity, originDetail]);
    itemId = existing.id;
  } else {
    /* THE OWNER IS THE FILE OR THE PERSON — exactly one, per `chk_one_owner`.
       A request with a file is owned by the file; without one it is owned by
       the borrower. `llc_id` is deliberately NOT set: see the file header. */
    const ins = await db.query(
      `INSERT INTO checklist_items
         (scope, application_id, borrower_id, label, borrower_label, hint, borrower_hint,
          audience, item_kind, is_required, category, field_key, status,
          created_by_kind, created_by_id, origin_kind, origin_detail, issue_reason,
          raised_entity, track_record_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$6,'both','document',true,'prior_to_docs',$7,'outstanding',
               'staff',$8,'manual_custom',$9::jsonb,$6,$10::jsonb,$11,500)
       RETURNING id`,
      [scope, appId, appId ? null : tr.borrower_id, built.label, built.borrowerLabel,
        built.borrowerSentence, built.fieldKey, a.actorId || null, originDetail,
        raisedEntity, trackRecordId]);
    itemId = ins.rows[0].id;
  }

  // The internal note is part of the same action, not a second step somebody
  // forgets. Staff-only; the borrower never sees it.
  if (clean(a.internalNote, 4000)) {
    try {
      await require('./notes').addNote({
        subjectKind: 'condition', subjectId: itemId, borrowerId: tr.borrower_id,
        body: a.internalNote, authorId: a.actorId,
      }, db);
    } catch (_) { /* a note must never lose the request */ }
  }

  // Tell the borrower — only ever on a file, because a profile-scoped request
  // has no loan for the email to be about. It reaches them the moment the
  // request migrates onto their next file.
  if (appId && tr.borrower_id) {
    try {
      const ctx = await notify.fileContext(appId);
      await notify.notifyBorrower(tr.borrower_id, {
        type: 'doc_requested',
        title: 'A document was requested',
        body: `${built.borrowerSentence}${ctx ? ` It is for your loan (${ctx.label}).` : ''}`,
        meta: (ctx && ctx.borrowerMeta) || undefined,
        applicationId: appId,
        link: `/app/${appId}`,
        ctaLabel: 'Upload the document',
      });
    } catch (_) { /* best-effort, exactly as raise-issue does */ }
  }

  return {
    itemId,
    reused: !!existing,
    scope,
    fieldKey: built.fieldKey,
    pillar: built.pillar,
    target: built.target,
    slot: built.slot,
    borrowerSentence: built.borrowerSentence,
  };
}

/**
 * Move every open profile-scoped track-record request onto a loan file.
 *
 * THE SAME ROW MOVES — it is never re-created — so its documents, its history
 * and its internal notes travel with it, and the borrower is not asked twice for
 * a document they already uploaded. Skips any request the file already carries
 * under the same key, so opening a second file cannot produce a duplicate.
 */
async function migrateProfileRequests(borrowerId, appId, client) {
  const db = client || require('../../db');
  if (!borrowerId || !appId) return { moved: 0 };
  const r = await db.query(
    `UPDATE checklist_items p
        SET scope='application', application_id=$2, borrower_id=NULL, updated_at=now()
      WHERE p.borrower_id=$1
        AND p.scope='borrower_profile'
        AND p.field_key LIKE 'trdoc:%'
        AND p.status <> 'satisfied'
        AND NOT EXISTS (SELECT 1 FROM checklist_items f
                         WHERE f.application_id=$2 AND f.field_key=p.field_key)
      RETURNING id`, [borrowerId, appId]);
  return { moved: r.rowCount, itemIds: r.rows.map((x) => x.id) };
}

function addressLabel(pa) {
  if (!pa) return '';
  if (typeof pa === 'string') return pa;
  if (typeof pa !== 'object') return '';
  if (pa.oneLine) return String(pa.oneLine);
  return [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ');
}

module.exports = {
  DOC_TYPES,
  PILLARS,
  PILLAR_PURPOSE,
  docType,
  fieldKeyFor,
  parseFieldKey,
  buildRequest,
  borrowerSentence,
  staffLabel,
  requestDocument,
  migrateProfileRequests,
  addressLabel,
};
