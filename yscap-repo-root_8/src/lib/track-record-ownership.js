'use strict';
/**
 * CHECK A CARRIES — verify the entity once, and every property it held inherits it.
 *
 * Owner-directed 2026-08-09, in their own words: "If he has ten properties in the
 * track record, it should automatically understand, 'Okay, this is on this
 * LLC' … If we verify ownership of these two LLCs, then all the ownership of all
 * the properties is verified."
 *
 * ── THE TWO CHECKS, AND WHY THEY STAY SEPARATE ─────────────────────────────
 * The owner corrected an earlier design into two INDEPENDENT questions:
 *
 *   CHECK A — does the borrower CONTROL this entity?   Asked ONCE per entity.
 *   CHECK B — did that entity own THIS property?       Asked once per line.
 *
 * Ten properties across two entities is therefore two Check A's and ten small
 * Check B's, not ten full investigations. Check A's answer lives on
 * `llc_borrowers.ownership_verified` (db/495); Check B's lives on the line's own
 * ownership pillar. This module is the join between them.
 *
 * ── IT WRITES auto_verdict, NEVER human_verdict ─────────────────────────────
 * The whole doctrine of this rebuild is that the machine OBSERVES and a person
 * DECIDES (db/494's own rule, and D1's lesson). A carried ownership pillar
 * arrives with its evidence already assembled and its grade filled in, so
 * confirming it is one click instead of a fresh investigation — but it is still
 * a click. Nothing here can satisfy a pillar.
 *
 * ── SILENCE IS NEVER A NEGATIVE FINDING, AND THE MESSAGE NAMES WHICH CHECK ──
 * "The entity is not verified yet" and "we cannot see this entity on the deed"
 * are different problems with different fixes, and a reviewer must never have to
 * guess which one they are looking at. So the four outcomes are distinct:
 *
 *   proved        both checks hold
 *   no_data       Check A holds, Check B is unproven — we have not looked, or
 *                 the public record is silent. NOT a negative finding.
 *   contradicted  the evidence says the OPPOSITE: the holding period falls
 *                 outside the borrower's membership window, so this entity held
 *                 the property before the borrower had anything to do with it.
 *   (untouched)   Check A does not hold. The pillar is left alone rather than
 *                 stamped, because "the entity is not verified" is a fact about
 *                 the ENTITY and belongs on the entity, not written onto ten
 *                 properties as if each had its own problem.
 *
 * ── REVOKING AN ENTITY REVOKES THE CARRY ────────────────────────────────────
 * A verification result is not read-only. `syncEntityToTrackRecords` runs on
 * revoke too and clears every pillar it had carried. A pillar a HUMAN confirmed
 * is NOT silently cleared — that would erase a person's decision — it is left
 * standing and reported, so the caller can raise `entity_unverified` against it.
 *
 * ── AND IT NEVER TOUCHES track_records.is_verified ──────────────────────────
 * That flag is about the DEAL — its verify route gates on a completed, in-window
 * exit. Entity ownership is about WHO HELD IT. Collapsing them would make
 * verifying an entity appear to verify a deal that has no exit at all.
 */

/** Pure: does `[from,to]` (a holding period) sit inside the membership window? */
function withinMembership(hold, member) {
  const d = (v) => (v == null ? null : String(v).slice(0, 10));
  const hFrom = d(hold && hold.from);
  const hTo = d(hold && hold.to);
  const mFrom = d(member && member.from);
  const mTo = d(member && member.to);

  /* UNKNOWN IS NOT A CONTRADICTION. NULL on either side means "no dated limit
     recorded", which is the common case — most entities on a profile have no
     membership dates at all. Reading that as "they did not hold it" would
     contradict essentially the whole back book on the day this ships. */
  if (!mFrom && !mTo) return { ok: true, why: 'no_membership_dates' };
  if (!hFrom && !hTo) return { ok: true, why: 'no_holding_dates' };

  /* A CONTRADICTION NEEDS A PROVABLE OVERLAP FAILURE, judged on the dates we
     actually have. The property was sold before they joined, or bought after
     they left — either is the evidence saying the opposite. */
  if (mFrom && hTo && hTo < mFrom) return { ok: false, why: 'sold_before_they_joined' };
  if (mTo && hFrom && hFrom > mTo) return { ok: false, why: 'bought_after_they_left' };
  return { ok: true, why: 'within' };
}

/**
 * Pure: given Check A's state and Check B's evidence, what does the ownership
 * pillar say? Returns null to mean "leave the pillar alone".
 */
function ownershipVerdict({ checkA, checkB, hold, member }) {
  if (!checkA || !checkA.verified) return null;      // a fact about the ENTITY, not this property

  const window = withinMembership(hold, member);
  if (!window.ok) {
    return {
      auto_verdict: 'contradicted',
      auto_source: 'entity',
      auto_confidence: 'certain',
      auto_grade: 'unacceptable',
      message: window.why === 'sold_before_they_joined'
        ? 'This property was sold before the borrower joined this entity, so holding it does not show their ownership.'
        : 'This property was bought after the borrower left this entity, so holding it does not show their ownership.',
    };
  }

  if (checkB && checkB.proved) {
    return {
      auto_verdict: 'proved',
      auto_source: 'entity',
      auto_confidence: checkB.confidence || 'likely',
      /* STRONG, never SUPERIOR. Superior is reserved for evidence we read
         ourselves off a recorded instrument; this is a verified entity plus a
         record that the entity was the grantee — strong, and still a human's
         click away from confirmed. */
      auto_grade: 'strong',
      message: 'The borrower’s control of this entity is verified, and the record shows this entity held this property.',
    };
  }

  return {
    auto_verdict: 'no_data',
    auto_source: 'entity',
    auto_confidence: 'possible',
    auto_grade: 'weak',
    /* NAMES WHICH CHECK IS MISSING. This is the whole point of not collapsing
       the two: the fix for this sentence is "go look at the deed", and the fix
       for an unverified entity is "get the operating agreement". */
    message: 'The borrower’s control of this entity is verified, but we have not yet confirmed that this entity is the one that held this property.',
  };
}

/**
 * Fan out one entity's Check A to every track-record line it holds.
 *
 * Mirrors `syncLlcConditions`, which does the same job for loan files. Returns a
 * summary; NEVER throws — a verification click must not fail because a fan-out
 * did.
 */
async function syncEntityToTrackRecords(llcId, opts = {}) {
  const database = require('../db');
  const client = opts.client || database;
  const out = { carried: 0, cleared: 0, contradicted: 0, noData: 0, humanConfirmed: [], ok: true };
  try {
    if (!llcId) return out;

    /* Every entity this one owns, so a property held by a subsidiary inherits
       the parent's Check A. The chain walker is already cycle-guarded and
       depth-capped — reuse it rather than re-walking. */
    const llc = require('./llc');
    let ids = [String(llcId)];
    try {
      const desc = await llc.getDescendantEntityIds(llcId, {});
      if (Array.isArray(desc)) ids = [...new Set([String(llcId), ...desc.map(String)])];
    } catch (_) { /* a chain read failure must not stop the direct carry */ }

    const lines = (await client.query(
      `SELECT t.id, t.borrower_id, t.llc_id, t.purchase_date, t.counts_from,
              b.ownership_verified, b.ownership_verified_at, b.held_from, b.held_to,
              p.human_verdict AS pillar_human, p.satisfied_by_llc_id
         FROM track_records t
         JOIN llc_borrowers b ON b.llc_id = t.llc_id AND b.borrower_id = t.borrower_id
         LEFT JOIN track_record_pillars p
                ON p.track_record_id = t.id AND p.pillar = 'ownership'
        WHERE t.llc_id = ANY($1::uuid[])`, [ids])).rows;

    for (const row of lines) {
      const checkA = { verified: row.ownership_verified === true, verifiedAt: row.ownership_verified_at };

      if (!checkA.verified) {
        /* REVOKED (or never verified). Clear only what WE carried. A pillar a
           human confirmed is never silently cleared — that erases a decision —
           so it is reported instead, for the caller to raise entity_unverified. */
        if (row.pillar_human === 'confirmed' && row.satisfied_by_llc_id) {
          out.humanConfirmed.push({ trackRecordId: row.id, llcId: row.satisfied_by_llc_id });
          continue;
        }
        const r = await client.query(
          `UPDATE track_record_pillars
              SET auto_verdict=NULL, auto_source=NULL, auto_confidence=NULL,
                  auto_grade=NULL, auto_evidence=NULL, satisfied_by_llc_id=NULL,
                  auto_checked_at=now(), updated_at=now()
            WHERE track_record_id=$1 AND pillar='ownership' AND satisfied_by_llc_id IS NOT NULL`,
          [row.id]);
        out.cleared += r.rowCount || 0;
        continue;
      }

      const verdict = ownershipVerdict({
        checkA,
        checkB: opts.checkB ? opts.checkB(row) : null,
        hold: { from: row.purchase_date, to: row.counts_from },
        member: { from: row.held_from, to: row.held_to },
      });
      if (!verdict) continue;

      await client.query(
        `UPDATE track_record_pillars
            SET auto_verdict=$2, auto_source=$3, auto_confidence=$4, auto_grade=$5,
                auto_evidence=$6::jsonb, satisfied_by_llc_id=$7, auto_checked_at=now(), updated_at=now()
          WHERE track_record_id=$1 AND pillar='ownership'`,
        [row.id, verdict.auto_verdict, verdict.auto_source, verdict.auto_confidence, verdict.auto_grade,
          JSON.stringify({ message: verdict.message, checkA: { verifiedAt: row.ownership_verified_at, llcId: row.llc_id } }),
          row.llc_id]);

      if (verdict.auto_verdict === 'proved') out.carried += 1;
      else if (verdict.auto_verdict === 'contradicted') out.contradicted += 1;
      else out.noData += 1;
    }
    return out;
  } catch (e) {
    out.ok = false;
    out.error = e && e.message;
    return out;
  }
}

module.exports = {
  withinMembership,
  ownershipVerdict,
  syncEntityToTrackRecords,
};
