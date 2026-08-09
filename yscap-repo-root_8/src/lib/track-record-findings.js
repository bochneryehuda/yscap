'use strict';
/**
 * THE TRACK RECORD REVIEWS ITSELF (owner-directed 2026-08-02).
 *
 * The owner's words: "if you find any errors within the track record … we should
 * NOT send it to the regular manual review queue. We should have findings ON the
 * track record of stuff that was not done correctly … and you should not be able
 * to clear and sign off on the experience condition till you clear those
 * findings. If you find our SUBJECT PROPERTY on the track record that should be
 * a finding to be cleared … give a few options over there what to do."
 *
 * WHAT THIS IS FOR. A track record is the evidence the whole experience tier is
 * priced off — how many flips, how many holds, how recent. If it is wrong, the
 * loan is sized wrong. Two ways it goes wrong that a human can only fix by
 * looking:
 *
 *   duplicate_line              two lines that look like the same property, so
 *                               one deal is being counted twice and the borrower
 *                               reads as more experienced than they are.
 *   subject_property_on_record  the property THIS loan is buying is sitting on
 *                               the list of deals already DONE. It is not done —
 *                               we are financing it right now — so it must not
 *                               count toward the experience that prices it.
 *
 * NEVER FABRICATES. Every detector returns nothing when it cannot read the data
 * it needs: an unreadable address yields no key and joins no group, and a file
 * with no subject property raises no subject-property finding. Silence is always
 * the safe answer here, because a finding BLOCKS the experience condition.
 *
 * A DECIDED FINDING STAYS DECIDED. The detector re-runs on every file view, so
 * without that rule a reviewer's "these really are two different houses" would
 * come back minutes later, forever — the trap `finding_decisions` (db/333) was
 * built to close for the AI desks. `decidedKeys` is the same idea, keyed on the
 * pair rather than on the row, so it survives the rows being re-read.
 *
 * IT DECIDES NOTHING AND DELETES NOTHING. Raising a finding writes a note;
 * clearing one runs an ordinary audited path (the human-confirmed merge, or a
 * line removal a person asked for). Owner-directed 2026-08-02: "the system
 * should always need a human to confirm, never do this risky stuff itself."
 */

const db = require('../db');
const TRK = require('./track-record-key');
const ADDR = require('./address');

/* ── the finding catalogue ─────────────────────────────────────────────────
   Each code declares the OPTIONS a reviewer gets, which is the owner's "give a
   few options over there what to do". The server validates against this table,
   and the screen renders from it — so a new finding type is one entry here plus
   a detector, and the two can never disagree about what is offered. */
const FINDINGS = {
  duplicate_line: {
    severity: 'warning',
    actions: ['merge', 'keep_both'],
  },
  subject_property_on_record: {
    severity: 'warning',
    actions: ['remove_line', 'not_our_property'],
  },
};

const ACTION_RESOLUTION = {
  merge: 'merged',
  keep_both: 'kept_both',
  remove_line: 'removed_line',
  not_our_property: 'not_our_property',
  dismiss: 'dismissed',
};

/** 'dismiss' is available on every finding, like the appraisal desk's own. */
function actionsFor(code) {
  const spec = FINDINGS[code];
  return spec ? [...spec.actions, 'dismiss'] : ['dismiss'];
}
function isActionAllowed(code, action) { return actionsFor(code).includes(action); }

function err(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

/** The one-line address a reviewer reads. Never throws. */
function addrText(a) {
  try { return ADDR.canonicalOneLine(a) || ADDR.addressTextOf(a) || ''; }
  catch (_) { try { return String(a == null ? '' : a); } catch (_2) { return ''; } }
}

/* A pair's identity, order-independent, so the SAME two lines produce the SAME
   key however the detector happens to order them — otherwise a dismissal would
   be bypassed the next time they came back the other way round. */
function pairKey(a, b) {
  return `duplicate_line:${[String(a), String(b)].sort().join('|')}`;
}

/* ── detectors (PURE — given rows, return findings; no DB, never throw) ──── */

/**
 * Two lines that look like the same property.
 *
 * Deliberately NOT the transitive grouping the heal pass uses for merging:
 * `sameAddress` is not transitive (a bare row matches every unit in a building,
 * a house-number range matches every number it spans), so a group of three can
 * contain two genuinely different properties. A FINDING is about a PAIR, and
 * every pair reported here is one the function directly confirmed — so what the
 * reviewer is asked about is always literally the two addresses shown.
 */
function duplicateFindings(rows) {
  const out = [];
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (!TRK.sameProperty(a.property_address, b.property_address)) continue;
      // The line carrying more is the one a merge would keep; showing it first
      // makes the card read the way the action will behave.
      const [keep, other] = rank(a) >= rank(b) ? [a, b] : [b, a];
      out.push({
        code: 'duplicate_line',
        trackRecordId: keep.id,
        otherId: other.id,
        dedupeKey: pairKey(a.id, b.id),
        title: 'Two lines look like the same property',
        detail: `“${addrText(keep.property_address)}” and “${addrText(other.property_address)}” look like the same property, `
          + 'so this deal may be counted twice toward the borrower’s experience. '
          + 'If they are the same, merge them into one line. If they are two different properties '
          + '(two units in one building, or two houses on one lot), keep both and this will not be raised again.',
      });
    }
  }
  return out;
}

/** How much a line carries — the merge keeps the richer one. */
function rank(r) {
  return (r.is_verified ? 1000 : 0)
    + (r.has_documents ? 100 : 0)
    + (r.purchase_price != null ? 1 : 0)
    + (r.sale_price != null ? 1 : 0)
    + (r.deal_type ? 1 : 0);
}

/**
 * The file's OWN subject property sitting on the borrower's list of finished
 * deals. Silent unless the file actually has a readable subject address.
 */
function subjectPropertyFindings(rows, subjectAddress, applicationId) {
  if (!subjectAddress || !applicationId) return [];
  if (!TRK.trackRecordKey(subjectAddress)) return [];   // unreadable → never guess
  const out = [];
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!TRK.sameProperty(r.property_address, subjectAddress)) continue;
    out.push({
      code: 'subject_property_on_record',
      trackRecordId: r.id,
      otherId: null,
      applicationId,
      dedupeKey: `subject_property_on_record:${applicationId}:${r.id}`,
      title: 'This loan’s own property is on the track record',
      detail: `“${addrText(r.property_address)}” is the property this loan is for, but it is listed as a deal already done. `
        + 'A deal we are financing right now is not completed experience, so it must not count toward the '
        + 'experience this loan is priced on. Remove the line if it was added by mistake — or, if the borrower '
        + 'genuinely owned and exited this property before, say so and it will be left alone.',
    });
  }
  return out;
}

/* ── the sync (DB) ─────────────────────────────────────────────────────────── */

const ROWS_SQL = `
  SELECT t.id, t.property_address, t.is_verified, t.purchase_price, t.sale_price, t.deal_type,
         EXISTS (SELECT 1 FROM documents d WHERE d.track_record_id = t.id) AS has_documents
    FROM track_records t WHERE t.borrower_id = $1`;

/**
 * Recompute a borrower's track-record findings.
 *
 * Best-effort by contract: it is called from a file view and a sign-off, and a
 * detector problem must never break either. It returns a shape, never throws.
 */
async function syncForBorrower(borrowerId, { applicationId = null, subjectAddress = null, client = null } = {}) {
  const q = client || db;
  const out = { ok: true, raised: 0, cleared: 0, open: 0 };
  try {
    const rows = (await q.query(ROWS_SQL, [borrowerId])).rows;
    const found = [
      ...duplicateFindings(rows),
      ...subjectPropertyFindings(rows, subjectAddress, applicationId),
    ];

    // A finding a human already settled must never be raised again.
    const decided = new Set((await q.query(
      `SELECT dedupe_key FROM track_record_findings
        WHERE borrower_id=$1 AND status IN ('resolved','dismissed')`, [borrowerId])).rows.map((r) => r.dedupe_key));
    const fresh = found.filter((f) => !decided.has(f.dedupeKey));

    for (const f of fresh) {
      const ins = await q.query(
        `INSERT INTO track_record_findings
           (borrower_id, application_id, code, severity, title, detail, track_record_id, other_id, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (borrower_id, dedupe_key) WHERE status='open'
         DO UPDATE SET title=EXCLUDED.title, detail=EXCLUDED.detail
         RETURNING (xmax = 0) AS inserted`,
        /* application_id COMES FROM THE FINDING, never from whichever file
           happened to trigger this run. A duplicate line is wrong on every file
           the borrower has, so it is borrower-level (NULL) — stamping it with
           the triggering file would hide it from their other files, and
           `openForFile` filters on exactly this column, so the gate on those
           files would let the experience condition through with an open
           duplicate standing. Only subject_property_on_record sets it. */
        [borrowerId, f.applicationId || null, f.code,
          (FINDINGS[f.code] && FINDINGS[f.code].severity) || 'warning',
          f.title, f.detail, f.trackRecordId || null, f.otherId || null, f.dedupeKey]);
      if (ins.rows[0] && ins.rows[0].inserted) out.raised += 1;
    }

    /* AN OPEN FINDING WHOSE PROBLEM WENT AWAY MUST CLOSE ITSELF, or it blocks the
       experience condition with nothing left to click — the reviewer merged the
       lines somewhere else, or the subject property was taken off the record.

       BUT A RUN MAY ONLY RETIRE WHAT IT ACTUALLY LOOKED FOR. This function is
       called two ways: from a FILE (which knows a subject property) and from the
       boot pass (which does not, and passes neither id nor address). Closing
       everything absent from `found` would mean the boot pass silently resolved
       every subject_property_on_record finding in the book, on every deploy,
       because it never evaluated that code at all. The same trap one level down:
       a borrower with two files would have file A's sync retire file B's
       subject-property finding, since B's key is not in A's result. So a row is
       only ever retired when THIS run evaluated its code, and — for a code that
       is about one deal — when the row belongs to the deal being synced. */
    const evaluated = new Set(['duplicate_line']);
    const didSubject = !!(applicationId && subjectAddress);
    if (didSubject) evaluated.add('subject_property_on_record');

    const live = new Set(found.map((f) => f.dedupeKey));
    const stale = (await q.query(
      `SELECT id, dedupe_key, code, application_id FROM track_record_findings
        WHERE borrower_id=$1 AND status='open'`, [borrowerId]))
      .rows.filter((r) => evaluated.has(r.code)
        && (r.code !== 'subject_property_on_record' || String(r.application_id) === String(applicationId))
        && !live.has(r.dedupe_key));
    for (const s of stale) {
      await q.query(
        `UPDATE track_record_findings
            SET status='resolved', resolution='dismissed', resolved_at=now(),
                resolution_note='No longer applies — the track record changed.'
          WHERE id=$1 AND status='open'`, [s.id]);
      out.cleared += 1;
    }

    out.open = (await q.query(
      `SELECT count(*)::int n FROM track_record_findings WHERE borrower_id=$1 AND status='open'`, [borrowerId])).rows[0].n;
    return out;
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'error', raised: 0, cleared: 0, open: 0 };
  }
}

/** Every borrower on a file (primary + co-borrower), the same set the gate counts. */
async function borrowerIdsForFile(appId, q = db) {
  const r = await q.query(
    `SELECT borrower_id FROM applications WHERE id=$1
      UNION
     SELECT co_borrower_id FROM applications WHERE id=$1 AND co_borrower_id IS NOT NULL`, [appId]);
  return r.rows.map((x) => x.borrower_id).filter(Boolean);
}

/** Recompute for every borrower on a file, using that file's subject property. */
async function syncForFile(appId, { client = null } = {}) {
  const q = client || db;
  try {
    const app = (await q.query(
      `SELECT id, property_address FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!app) return { ok: true, raised: 0, cleared: 0, open: 0 };
    const ids = await borrowerIdsForFile(appId, q);
    const tot = { ok: true, raised: 0, cleared: 0, open: 0 };
    for (const b of ids) {
      const r = await syncForBorrower(b, { applicationId: appId, subjectAddress: app.property_address, client });
      tot.raised += r.raised; tot.cleared += r.cleared; tot.open += r.open;
      if (!r.ok) tot.ok = false;
    }
    return tot;
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'error', raised: 0, cleared: 0, open: 0 };
  }
}

/** The open findings for a file's borrowers — what the screen shows and the gate counts. */
async function openForFile(appId, q = db) {
  try {
    const ids = await borrowerIdsForFile(appId, q);
    if (!ids.length) return [];
    const r = await q.query(
      `SELECT f.*, tr.property_address AS keep_address, ot.property_address AS other_address
         FROM track_record_findings f
         LEFT JOIN track_records tr ON tr.id = f.track_record_id
         LEFT JOIN track_records ot ON ot.id = f.other_id
        WHERE f.borrower_id = ANY($1::uuid[]) AND f.status='open'
          AND (f.application_id IS NULL OR f.application_id = $2)
        ORDER BY f.created_at`, [ids, appId]);
    return r.rows.map((x) => ({ ...x, actions: actionsFor(x.code) }));
  } catch (_) { return []; }
}

/**
 * THE GATE. Owner-directed: the experience condition cannot be signed off while
 * the track record still has something on it nobody has looked at.
 *
 * FAILS OPEN on a read error — this runs inside signOffGate, and a database blip
 * must not make a condition permanently unsignable.
 */
async function experienceBlockReason(appId, q = db) {
  let all;
  try { all = await openForFile(appId, q); } catch (_) { return null; }
  /* ONLY A 'warning' HOLDS THE CONDITION. `openForFile` returns every open row
     because the screen must SHOW them all, but an 'info' finding is advisory —
     a public-records index disagreeing with the borrower is something a reviewer
     should see, not something that stops a closing. Without this filter the first
     advisory code added would silently become a gate, and an outside data vendor
     would be able to hold up a loan. */
  const open = all.filter((f) => f && f.severity !== 'info');
  if (!open.length) return null;
  const what = open.length === 1 ? 'one thing' : `${open.length} things`;
  const first = open[0] && open[0].title ? ` (${open[0].title.toLowerCase()})` : '';
  return `The track record has ${what} to review${first}. `
    + 'Open the Track record section, settle each finding — merge the duplicate, remove the line, or say it is fine — '
    + 'and then this can be signed off.';
}

/**
 * Carry out a reviewer's decision. THE ONLY WAY A FINDING LEAVES 'open'.
 *
 * Everything destructive routes through an existing audited path; nothing here
 * invents a second way to delete a track-record line.
 */
async function resolveFinding({ findingId, action, note, actorId, appId }) {
  if (!actorId) throw err(400, 'a track-record decision must record who made it');
  const f = (await db.query(`SELECT * FROM track_record_findings WHERE id=$1`, [findingId])).rows[0];
  if (!f) throw err(404, 'that finding is gone');
  if (f.status !== 'open') throw err(409, 'somebody already settled that finding');
  if (!isActionAllowed(f.code, action)) throw err(400, `“${action}” is not one of the options for this finding`);

  let outcome = '';
  if (action === 'merge') {
    if (!f.track_record_id || !f.other_id) throw err(409, 'this finding no longer knows which two lines it meant');
    const m = await require('./track-record-heal').mergeTrackRecordPair({
      keepId: f.track_record_id, loserId: f.other_id, actorId });
    outcome = m.carried && m.carried.length
      ? `Merged into one line, keeping the details only the removed line had (${m.carried.map((c) => c.replace(/_/g, ' ')).join(', ')}).`
      : 'Merged into one line.';
  } else if (action === 'remove_line') {
    if (!f.track_record_id) throw err(409, 'this finding no longer points at a line');
    const gone = await removeLine(f.track_record_id, actorId, f.borrower_id);
    outcome = gone ? 'Took the line off the track record.' : 'That line was already gone.';
  } else if (action === 'keep_both') {
    outcome = 'Recorded that these are two different properties — they will not be raised again.';
  } else if (action === 'not_our_property') {
    outcome = 'Recorded that the borrower really did own and exit this property before — the line stays.';
  } else {
    outcome = 'Dismissed.';
  }

  await db.query(
    `UPDATE track_record_findings
        SET status = CASE WHEN $2='dismiss' THEN 'dismissed' ELSE 'resolved' END,
            resolution=$3, resolution_note=$4, resolved_by=$5, resolved_at=now()
      WHERE id=$1 AND status='open'`,
    [findingId, action, ACTION_RESOLUTION[action] || action, note || outcome, actorId]);

  await db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ('staff',$1,'track_record_finding_resolved','borrower',$2,$3::jsonb)`,
    [actorId, f.borrower_id, JSON.stringify({ findingId, code: f.code, action, appId: appId || f.application_id })]
  ).catch(() => { /* the decision itself is what matters */ });

  // Re-run so anything the action fixed closes itself and the count is current.
  if (appId) await syncForFile(appId);
  return { ok: true, outcome };
}

/**
 * Take a line off the track record because a reviewer said it does not belong.
 *
 * A VERIFIED line is refused: that is signed-off evidence, and unverifying it is
 * a separate, deliberate act. Documents are DETACHED rather than destroyed —
 * `documents.track_record_id` is ON DELETE CASCADE, so deleting the row would
 * take the borrower's uploaded proof with it.
 */
async function removeLine(trackRecordId, actorId, borrowerId) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const row = (await client.query(
      `SELECT id, is_verified FROM track_records WHERE id=$1 FOR UPDATE`, [trackRecordId])).rows[0];
    if (!row) { await client.query('COMMIT'); return false; }
    if (row.is_verified) {
      throw err(409, 'that line is verified evidence — unverify it on the track record first if it really does not belong');
    }
    await client.query(`UPDATE documents SET track_record_id=NULL WHERE track_record_id=$1`, [trackRecordId]);
    await client.query(`UPDATE checklist_items SET track_record_id=NULL WHERE track_record_id=$1`, [trackRecordId]);
    await client.query(`DELETE FROM track_records WHERE id=$1`, [trackRecordId]);
    await client.query('SAVEPOINT trkf_audit');
    try {
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('staff',$1,'track_record_line_removed','borrower',$2,$3::jsonb)`,
        [actorId, borrowerId, JSON.stringify({ removed: trackRecordId })]);
      await client.query('RELEASE SAVEPOINT trkf_audit');
    } catch (_) { await client.query('ROLLBACK TO SAVEPOINT trkf_audit').catch(() => {}); }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    try { client.release(); } catch (_) { /* already gone */ }
  }
}

module.exports = {
  syncForBorrower, syncForFile, openForFile, experienceBlockReason, resolveFinding,
  actionsFor, isActionAllowed, FINDINGS,
  _internals: { duplicateFindings, subjectPropertyFindings, pairKey, addrText, rank, removeLine },
};
