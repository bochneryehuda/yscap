'use strict';
/**
 * THE STAFF WORKSPACE — one queue, grouped by borrower, and one line's whole story.
 *
 * Owner-directed: the back office had TWO stacked track records on one screen.
 * This is the ONE, and it carries every feature from both.
 *
 * ── GROUPED BY BORROWER, NOT BY LINE ───────────────────────────────────────
 * Eight properties entered at once are read TOGETHER against one document set
 * and one entity. A flat list of lines makes a reviewer open the same operating
 * agreement eight times; grouping means they answer the ownership question once
 * for the company and it carries (the Check A rule from Phase 2).
 *
 * ── THE SERVER OWNS THE VERDICT ────────────────────────────────────────────
 * Every next step, every refusal and every readiness sentence comes from
 * `pillar-actions` — the same pure module the screen reads. The screen shows
 * what came back, verbatim. A button the server would refuse is the failure
 * mode this arrangement exists to prevent, and it is why the bulk rule lives in
 * that pure module rather than in the route.
 *
 * ── NOTHING HERE DECIDES ANYTHING ──────────────────────────────────────────
 * This module READS. The only write is `decidePillar`, which records a HUMAN's
 * answer into the `human_*` columns — never `auto_*`, which belong to the
 * machine and must never be overwritten by a person's opinion (db/494's whole
 * point is that the two never collapse).
 */

const PA = require('./pillar-actions');

const str = (v) => String(v == null ? '' : v).trim();

function addressLabel(pa) {
  if (!pa) return '';
  if (typeof pa === 'string') return pa;
  if (typeof pa !== 'object') return '';
  if (pa.oneLine) return String(pa.oneLine);
  return [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ');
}

/**
 * How urgent is this line? Lower sorts first. Mirrors the spirit of
 * `app-v2/src/lib/next-up.js byUrgency`: something a person is BLOCKED on beats
 * something merely waiting, and age breaks ties.
 *
 * A CONTRADICTION IS THE MOST URGENT THING ON THE SCREEN. It is the one state
 * where the records actively disagree with what a borrower told us, and it is
 * the state most likely to change a loan.
 */
function urgencyOf(row) {
  const p = row.pillars || [];
  if (p.some((x) => x.auto_verdict === 'contradicted' && !x.human_verdict)) return 0;
  if (row.openFindings > 0) return 1;
  if (p.some((x) => x.auto_verdict === 'proved' && !x.human_verdict)) return 2;   // cheap wins
  if (p.some((x) => !x.human_verdict && !x.auto_verdict)) return 3;               // never checked
  if (p.some((x) => !x.human_verdict)) return 4;                                  // asked, waiting
  return 5;                                                                        // done
}

/**
 * The queue: every borrower with unfinished track-record work, and their lines.
 *
 * Scope is the CALLER'S — `visibleBorrowerSql` is passed in by the route so this
 * module never re-implements who may see whom (the repo's standing rule that a
 * scope has one definition).
 */
async function loadQueue({ visibleBorrowerSql, params = [], limit = 40, filter = 'all', staffId = null }, client) {
  const db = client || require('../../db');
  const where = [];
  if (visibleBorrowerSql) where.push(`(${visibleBorrowerSql})`);
  // A line nobody can act on is not work: terminal and already-verified lines
  // are excluded unless the caller asks for everything.
  if (filter !== 'all') where.push(`t.is_verified = false`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = (await db.query(
    `SELECT t.id, t.borrower_id, t.property_address, t.deal_type, t.purchase_date,
            t.counts_from, t.hold_days, t.is_verified, t.verification_status,
            t.docs_status, t.entity_name, t.llc_id, t.pillars_met, t.created_at, t.updated_at,
            NULLIF(TRIM(COALESCE(b.full_name,'')),'') AS borrower_name,
            COALESCE((SELECT json_agg(json_build_object(
                       'id', p.id, 'pillar', p.pillar,
                       'auto_verdict', p.auto_verdict, 'auto_source', p.auto_source,
                       'auto_confidence', p.auto_confidence, 'auto_grade', p.auto_grade,
                       'auto_evidence', p.auto_evidence, 'auto_checked_at', p.auto_checked_at,
                       'human_verdict', p.human_verdict, 'human_at', p.human_at,
                       'satisfied_by_llc_id', p.satisfied_by_llc_id) ORDER BY p.pillar)
                      FROM track_record_pillars p WHERE p.track_record_id = t.id), '[]'::json) AS pillars,
            (SELECT count(*)::int FROM track_record_findings f
              WHERE f.track_record_id = t.id AND f.status = 'open') AS open_findings,
            (SELECT count(*)::int FROM checklist_items ci
              WHERE ci.track_record_id = t.id AND ci.item_kind = 'document'
                AND ci.status IN ('outstanding','requested','issue')) AS open_requests,
            (SELECT count(*)::int FROM documents d
              WHERE d.track_record_id = t.id AND d.is_current) AS doc_count
       FROM track_records t
       JOIN borrowers b ON b.id = t.borrower_id
       ${whereSql}
      ORDER BY t.updated_at DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 40, 1), 200) * 8}`, params)).rows;

  const decorated = rows.map((r) => {
    const pillars = Array.isArray(r.pillars) ? r.pillars : [];
    const line = {
      id: r.id,
      borrowerId: r.borrower_id,
      borrowerName: r.borrower_name || 'Unnamed borrower',
      address: addressLabel(r.property_address),
      dealType: r.deal_type,
      countsFrom: r.counts_from,
      holdDays: r.hold_days,
      isVerified: r.is_verified === true,
      verificationStatus: r.verification_status,
      docsStatus: r.docs_status,
      entityName: r.entity_name,
      llcId: r.llc_id,
      pillars,
      openFindings: r.open_findings,
      openRequests: r.open_requests,
      docCount: r.doc_count,
      updatedAt: r.updated_at,
      readiness: PA.lineReadiness(pillars),
      bulk: PA.bulkConfirmRefusal(pillars),
    };
    line.urgency = urgencyOf(line);
    return line;
  });

  // Group by borrower, ordered by their most urgent line, then by how long the
  // group has been waiting.
  const groups = new Map();
  for (const l of decorated) {
    if (!groups.has(l.borrowerId)) {
      groups.set(l.borrowerId, { borrowerId: l.borrowerId, borrowerName: l.borrowerName, lines: [] });
    }
    groups.get(l.borrowerId).lines.push(l);
  }
  const out = [...groups.values()].map((g) => {
    g.lines.sort((a, b) => a.urgency - b.urgency || String(a.address).localeCompare(String(b.address)));
    g.urgency = g.lines.length ? g.lines[0].urgency : 9;
    g.outstanding = g.lines.filter((l) => !l.readiness.ready && !l.isVerified).length;
    g.contradicted = g.lines.filter((l) => l.urgency === 0).length;
    g.oldest = g.lines.reduce((m, l) => (!m || l.updatedAt < m ? l.updatedAt : m), null);
    return g;
  }).sort((a, b) => a.urgency - b.urgency || (a.oldest < b.oldest ? -1 : 1));

  return {
    groups: out.slice(0, Math.min(Math.max(Number(limit) || 40, 1), 200)),
    totals: {
      borrowers: out.length,
      lines: decorated.length,
      contradicted: decorated.filter((l) => l.urgency === 0).length,
      waiting: decorated.filter((l) => !l.readiness.ready && !l.isVerified).length,
    },
  };
}

/**
 * One line's whole story: the three evidence cards, the documents, the open
 * requests, the findings and the internal notes — everything the reviewer needs
 * without opening a second screen.
 */
async function loadLine(trackRecordId, { role, canSignOff } = {}, client) {
  const db = client || require('../../db');
  const t = (await db.query(
    `SELECT t.*, NULLIF(TRIM(COALESCE(b.full_name,'')),'') AS borrower_name,
            l.llc_name, l.is_verified AS entity_docs_verified,
            ${require('./records-stamp').stampSelect('t')}
       FROM track_records t
       JOIN borrowers b ON b.id = t.borrower_id
       LEFT JOIN llcs l ON l.id = t.llc_id
      WHERE t.id=$1`, [trackRecordId])).rows[0];
  if (!t) return null;

  const pillars = (await db.query(
    `SELECT * FROM track_record_pillars WHERE track_record_id=$1 ORDER BY pillar`, [trackRecordId])).rows;

  const requests = (await db.query(
    `SELECT id, label, borrower_hint, status, field_key, application_id, scope, created_at
       FROM checklist_items
      WHERE track_record_id=$1 AND item_kind='document'
      ORDER BY created_at DESC`, [trackRecordId])).rows;

  // Which pillar each open request was asked FOR — so a card can say "already
  // asked" instead of offering the same ask again.
  const DR = require('./doc-request');
  const askedFor = new Set();
  for (const r of requests) {
    if (!['outstanding', 'requested', 'issue'].includes(r.status)) continue;
    const k = DR.parseFieldKey(r.field_key);
    if (k) askedFor.add(k.pillar);
  }

  const documents = (await db.query(
    `SELECT id, filename, content_type, size_bytes, created_at, review_status,
            rejection_reason, slot_label AS doc_type
       FROM documents WHERE track_record_id=$1 AND is_current ORDER BY created_at DESC`,
    [trackRecordId])).rows;

  const findings = (await db.query(
    `SELECT id, code, severity, title, detail, status, created_at
       FROM track_record_findings
      WHERE track_record_id=$1 AND status='open' ORDER BY created_at`, [trackRecordId])).rows;

  const notes = await require('./notes').readNotes('property', trackRecordId, { limit: 50 }, db);

  const cards = pillars.map((p) => PA.evidenceCard(p, {
    role, canSignOff, hasOpenRequest: askedFor.has(p.pillar),
  }));

  return {
    line: {
      id: t.id,
      borrowerId: t.borrower_id,
      borrowerName: t.borrower_name || 'Unnamed borrower',
      address: addressLabel(t.property_address),
      // The raw jsonb address so an inline edit can re-send it UNCHANGED (the PUT
      // door always requires an address; db/485 only un-verifies on a real
      // change, so re-sending the same object never resets the review or
      // degrades the structured line1/city/state/zip to a bare one-line).
      propertyAddressRaw: t.property_address || null,
      dealType: t.deal_type,
      /* WHAT KIND OF BUILDING IT WAS. The query above is `t.*`, so this value
         was already in hand and was simply not being passed on — which is why
         the whole Track Record Center had no property type to show or to edit
         (owner-reported 2026-08-16). Rendered through the shared vocabulary so
         a stored "single family" and a stored "Single-family" read as one thing
         on every screen; an unrecognised spelling is shown as it was stored,
         never rewritten. */
      propertyType: require('../property-type').trackRecordPropertyTypeLabel(t.property_type),
      purchaseDate: t.purchase_date,
      saleDate: t.sale_date,
      rentDate: t.rent_date,
      refiDate: t.refi_date,
      countsFrom: t.counts_from,
      holdDays: t.hold_days,
      purchasePrice: t.purchase_price,
      salePrice: t.sale_price,
      rehabAmount: t.rehab_amount,
      rentAmount: t.rent_amount,
      refiAmount: t.refi_amount,
      currentValue: t.current_value,
      ownedPersonally: t.owned_personally === true,
      isVerified: t.is_verified === true,
      verificationStatus: t.verification_status,
      docsStatus: t.docs_status,
      entityName: t.entity_name || t.llc_name || null,
      llcId: t.llc_id,
      entityDocsVerified: t.entity_docs_verified === true,
      loNotes: t.lo_notes,
      /* The records stamp (one definition, records-stamp.js) — the chip the
         line detail renders beside the address. */
      recordsStamp: t.records_stamp || null,
      recordsStampAt: t.records_stamp_at || null,
    },
    cards,
    readiness: PA.lineReadiness(pillars),
    bulk: PA.bulkConfirmRefusal(pillars),
    requests,
    documents,
    findings,
    notes,
  };
}

/**
 * Record a HUMAN's answer on one pillar.
 *
 * Writes ONLY the `human_*` columns. `auto_*` is the machine's observation and
 * a person disagreeing with it does not make the observation untrue — keeping
 * both is what lets a reviewer next year see that the records said one thing
 * and somebody decided another, which is the entire reason db/494 has two sets
 * of columns.
 *
 * @returns {{ok, pillar, readiness}} or throws with `.status`
 */
async function decidePillar(pillarId, { verdict, note, staffId, role, canSignOff }, client) {
  const db = client || require('../../db');
  const v = str(verdict);
  if (v !== '' && !PA.HUMAN_VERDICTS.includes(v)) {
    const e = new Error('that is not one of the answers'); e.status = 400; throw e;
  }
  const row = (await db.query(
    `SELECT p.*, t.borrower_id FROM track_record_pillars p
       JOIN track_records t ON t.id = p.track_record_id WHERE p.id=$1`, [pillarId])).rows[0];
  if (!row) { const e = new Error('not found'); e.status = 404; throw e; }

  // CONFIRM is the one direction that can ADD credit, so it is the one that
  // needs authority. Reject and needs_doc only ever withhold.
  if (v === 'confirmed' && !PA._internals.canSignOff(role, canSignOff)) {
    const e = new Error('Confirming a check lets the project count toward experience, so it needs sign-off. You can reject it or ask for a document.');
    e.status = 403; throw e;
  }
  // A REJECTION MUST SAY WHY. A reviewer months from now has to be able to read
  // the reason, and "rejected" with no note is unanswerable.
  if (v === 'rejected' && !str(note)) {
    const e = new Error('Say why you are rejecting this — it comes off the experience count and somebody will need to know.');
    e.status = 400; throw e;
  }

  await db.query(
    /* `$2::text` on EVERY use: `$2 IS NULL` carries no type information, so
       Postgres cannot infer the parameter and answers 42P08 before the statement
       ever runs. Clearing the verdict, the who and the when TOGETHER matters —
       a half-cleared row reads as "answered by nobody". */
    `UPDATE track_record_pillars
        SET human_verdict = $2::text,
            human_by = CASE WHEN $2::text IS NULL THEN NULL ELSE $3::uuid END,
            human_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
            updated_at = now()
      WHERE id=$1`, [pillarId, v || null, staffId || null]);

  if (str(note)) {
    try {
      await require('./notes').addNote({
        subjectKind: 'pillar', subjectId: pillarId, borrowerId: row.borrower_id,
        body: note, authorId: staffId,
      }, db);
    } catch (_) { /* the decision is the record; a note must never lose it */ }
  }

  const pillars = (await db.query(
    `SELECT * FROM track_record_pillars WHERE track_record_id=$1 ORDER BY pillar`, [row.track_record_id])).rows;
  return { ok: true, trackRecordId: row.track_record_id, borrowerId: row.borrower_id, readiness: PA.lineReadiness(pillars) };
}

/**
 * Confirm every machine-proved pillar on one line, in one action.
 *
 * THE SERVER IS WHERE THIS IS REFUSED. The blueprint says so explicitly, and it
 * is right: a screen can be bypassed, a screen can be stale, and this is the one
 * action that credits a borrower without a person reading anything. The rule
 * itself lives in `pillar-actions.bulkConfirmRefusal`, so the button the screen
 * greys out and the refusal the route returns can never disagree.
 */
async function bulkConfirm(trackRecordId, { staffId, role, canSignOff, note }, client) {
  const db = client || require('../../db');
  if (!PA._internals.canSignOff(role, canSignOff)) {
    const e = new Error('Confirming checks needs sign-off.'); e.status = 403; throw e;
  }
  const pillars = (await db.query(
    `SELECT * FROM track_record_pillars WHERE track_record_id=$1 ORDER BY pillar`, [trackRecordId])).rows;
  if (!pillars.length) { const e = new Error('not found'); e.status = 404; throw e; }

  const verdict = PA.bulkConfirmRefusal(pillars);
  if (!verdict.ok) { const e = new Error(verdict.reason); e.status = 422; e.code = 'bulk_refused'; throw e; }

  const ids = pillars.filter((p) => !p.human_verdict).map((p) => p.id);
  await db.query(
    `UPDATE track_record_pillars
        SET human_verdict='confirmed', human_by=$2::uuid, human_at=now(), updated_at=now()
      WHERE id = ANY($1::uuid[])`, [ids, staffId || null]);

  if (str(note)) {
    const borrowerId = (await db.query('SELECT borrower_id FROM track_records WHERE id=$1', [trackRecordId])).rows[0];
    for (const id of ids) {
      try {
        await require('./notes').addNote({
          subjectKind: 'pillar', subjectId: id, borrowerId: borrowerId && borrowerId.borrower_id,
          body: note, authorId: staffId }, db);
      } catch (_) { /* best-effort */ }
    }
  }

  const after = (await db.query(
    `SELECT * FROM track_record_pillars WHERE track_record_id=$1 ORDER BY pillar`, [trackRecordId])).rows;
  return { ok: true, confirmed: ids.length, readiness: PA.lineReadiness(after) };
}

module.exports = {
  loadQueue,
  loadLine,
  decidePillar,
  bulkConfirm,
  urgencyOf,
  addressLabel,
};
