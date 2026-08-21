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
 * A records read that PROVED the pillar because Check A held at the time is the
 * second thing a revoke has to answer for: its conclusion is withdrawn (down to
 * the `no_data` state a fresh read would now produce) while what the deed says
 * is kept, because that observation is still true.
 *
 * ── IT ONLY EVER ADDS CONFIDENCE — IT NEVER OVERWRITES THE RECORDS ─────────
 * Verifying an entity is an action that can only make a line MORE proven, so
 * the carry refuses to write over an ownership pillar the records check has
 * already settled (`auto_source='elementix'` with `proved` or `contradicted`).
 * Unguarded it did exactly that — stamping `auto_source='entity'` over a
 * records-proved pillar, which took the derived "Verified to Elementix" stamp
 * off the line the moment a staffer confirmed the company. The one thing that
 * still writes over a proved row is a CONTRADICTION this module itself finds
 * (the membership window), because a negative finding is never suppressed to
 * protect a stamp. See the guard at the write for the whole reasoning.
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
  const out = { carried: 0, cleared: 0, contradicted: 0, noData: 0, preserved: 0, downgraded: 0, humanConfirmed: [], ok: true };
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
              p.human_verdict AS pillar_human, p.satisfied_by_llc_id,
              p.auto_source AS pillar_source, p.auto_verdict AS pillar_verdict,
              p.auto_evidence->>'controlVerdict'   AS pillar_control,
              p.auto_evidence->>'satisfiedByLlcId' AS pillar_control_llc,
              p.auto_evidence->'checkB'->>'granteeIsMatchedEntity' AS pillar_check_b,
              p.auto_evidence->'checkB'->>'grantee' AS pillar_grantee,
              p.auto_evidence->'checkB'->>'heldAs'  AS pillar_held_as,
              p.auto_evidence->>'matched'          AS pillar_matched,
              p.auto_grade                         AS pillar_grade,
              l.llc_name                           AS entity_name
         FROM track_records t
         JOIN llc_borrowers b ON b.llc_id = t.llc_id AND b.borrower_id = t.borrower_id
         JOIN llcs l          ON l.id = t.llc_id
         LEFT JOIN track_record_pillars p
                ON p.track_record_id = t.id AND p.pillar = 'ownership'
        WHERE t.llc_id = ANY($1::uuid[])`, [ids])).rows;

    for (const row of lines) {
      const checkA = { verified: row.ownership_verified === true, verifiedAt: row.ownership_verified_at };

      /* ── THE TWO THINGS THE RECORDS MAY ALREADY HAVE SAID ABOUT THIS PILLAR ──
         Computed ONCE, here, because the revoke branch and the write branch were
         each asking a version of the same question and drifted apart: the revoke
         correctly refused to touch a deed naming the BORROWER THEMSELVES, while
         the write's contradiction exception happily overwrote exactly that. One
         definition removes the asymmetry.

         `restsOnThisEntity` — the records PROVED this pillar, and the reason they
         could is THIS entity's Check A (`checks.js`'s `controlVerdict:'confirmed'`
         branch, which also stamps `satisfiedByLlcId`). A proof with no
         `controlVerdict` is a deed naming the borrower in person; no entity is
         between them and the property, so nothing about this entity — verified,
         revoked, or a membership window — has anything to say about it.

         `recordsMatchedThisEntity` — the records found a party named as the
         grantee or holder on a recorded instrument AND THAT PARTY IS THIS
         COMPANY. The `granteeIsMatchedEntity` flag alone is NOT that: `checks.js`
         sets it when the recorded party matches ANY name in `ctx.entityNames`,
         and `verify-run.js` fills that list with the line's free-text
         `entity_name` PLUS EVERY COMPANY ON THE BORROWER'S PROFILE — nothing
         ties it back to `t.llc_id`. Reading the bare flag as "the records proved
         Check B for this entity" therefore let confirming control of Alpha
         promote a pillar whose deed names BRAVO, writing "control of that
         company has now been confirmed" while Bravo's own Check A was still
         false, and printing "Verified to Elementix" on the investor package for
         a company nobody had confirmed. So the grantee is compared to THIS
         entity's name through the shared `promotionMatch` — the repo's strict
         matcher (identical, suffix-only, or a pure re-spacing; never a
         substring), so the two can never drift about what counts as the same
         company — and the holder must be an ENTITY: a deed naming the borrower
         in person is `proved` already and has no company to confirm.

         `sameLegalEntityName`, NOT `promotionMatch`. The looser matcher deletes
         the entity suffix from both sides, so it reads "Smith Holdings LLC" and
         "Smith Holdings Corp" as one company — two different legal entities, and
         an operating LLC beside a management Corp is an ordinary shape on one
         borrower's profile. Confirming the LLC then minted "Verified to
         Elementix" on a property whose deed names the Corp, with the Corp's own
         Check A still false. `pickEntity` already refuses that exact pair as
         ambiguous; the strict matcher is that judgement applied here. */
      const restsOnThisEntity = row.pillar_source === 'elementix'
        && row.pillar_verdict === 'proved'
        && row.pillar_control === 'confirmed'
        && String(row.pillar_control_llc || '') === String(row.llc_id || '');
      const recordsHasCheckB = row.pillar_source === 'elementix'
        && String(row.pillar_check_b || '') === 'true';
      let recordsMatchedThisEntity = false;
      try {
        recordsMatchedThisEntity = recordsHasCheckB
          && String(row.pillar_held_as || '') === 'entity'
          && require('./track-record-entity').sameLegalEntityName(row.pillar_grantee, row.entity_name);
      } catch (_) { recordsMatchedThisEntity = false; }   // an unreadable matcher never promotes
      const recordsProvedCheckB = recordsMatchedThisEntity;

      if (!checkA.verified) {
        /* REVOKED (or never verified). Clear only what WE carried. A pillar a
           human confirmed is never silently cleared — that erases a decision —
           so it is reported instead, for the caller to raise entity_unverified.

           THE RECORDS READ IS THE SECOND THING CHECK A CAN HAVE PROVED, and it
           is not ours to erase. When the records check ran while the entity was
           confirmed, `checks.js` wrote the pillar as `elementix`/`proved` with
           `controlVerdict:'confirmed'` in its evidence — and it does NOT set
           `satisfied_by_llc_id`, so the clear above matched nothing and that
           pillar stood after a revoke, still stating "this borrower's control of
           that company has been confirmed" and still printing "Verified to
           Elementix" on the investor package. A stamp that outlives the evidence
           it rests on is the mirror image of the carry overwriting one. */
        if (row.pillar_human === 'confirmed' && (row.satisfied_by_llc_id || restsOnThisEntity)) {
          out.humanConfirmed.push({ trackRecordId: row.id, llcId: row.satisfied_by_llc_id || row.llc_id });
          continue;
        }

        /* THE TWO ARMS ARE MUTUALLY EXCLUSIVE, AND THAT ORDERING IS THE WHOLE
           POINT. The carry stamps `satisfied_by_llc_id` on EVERY line it writes,
           and `verify-run.js` does not list that column, so it SURVIVES a later
           records read — which means the ordinary sequence (confirm the company,
           then press "Check the records") leaves a pillar that is both
           `elementix`/`proved` AND carry-stamped. Running the clear first then
           NULLed `auto_source` / `auto_verdict` / `auto_evidence`, the downgrade
           below found nothing, and the promise one line above it — DOWNGRADED,
           NEVER WIPED — was false on the more common of the two orderings: the
           deed, its document id and its date were destroyed, the pillar read
           "Not checked yet", and `downgraded` reported 0.

           So: a records proof that rests on THIS entity is DOWNGRADED (never
           cleared), and everything else the carry wrote is cleared exactly as
           before. */
        if (restsOnThisEntity) {
          /* DOWNGRADED, NEVER WIPED. What the deed says is a real records
             observation and survives; only the CONCLUSION that rested on Check A
             is withdrawn, landing the pillar exactly where a fresh read of the
             same records would land it — `checks.js`'s own entityNoData state
             (source `elementix`, verdict `no_data`, same grade, needsControlCheck).
             `satisfied_by_llc_id` goes with it: we are no longer carrying this.
             The merge COALESCEs off any existing `priorWhy`: written bare, a
             second application copies the FIRST withdrawal's own sentence into
             `priorWhy` and the deed's words are gone — the opposite of what this
             branch is for. This statement's predicates are on the TARGET row, so
             its re-check already makes a second write a clean no-op; the COALESCE
             is the belt to that brace. */
          const d = await client.query(
            `UPDATE track_record_pillars
                SET auto_verdict='no_data', auto_confidence=NULL, satisfied_by_llc_id=NULL,
                    auto_evidence = COALESCE(auto_evidence,'{}'::jsonb)
                                    || jsonb_build_object('priorWhy',
                                         COALESCE(auto_evidence->'priorWhy', auto_evidence->'why'))
                                    || $2::jsonb,
                    auto_checked_at=now(), updated_at=now()
              WHERE track_record_id=$1 AND pillar='ownership'
                AND auto_source='elementix' AND auto_verdict='proved'
                AND auto_evidence->>'controlVerdict' = 'confirmed'`,
            [row.id, JSON.stringify({
              controlVerdict: null,
              needsControlCheck: true,
              controlRevokedAt: new Date().toISOString(),
              why: 'The records show the company held this property, but this borrower’s control of that company has since been revoked — so holding it no longer shows their ownership. Confirm the company again, or check whether a deed names the borrower themselves.',
            })]);
          out.downgraded += d.rowCount || 0;
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

      /* CHECK B IS ANSWERED BY WHOEVER ANSWERED IT — the caller, or the records.
         `checks.js` writes "the company IS the grantee on the recorded deed, and
         nobody has confirmed control yet" as `elementix`/`no_data` carrying
         `checkB.granteeIsMatchedEntity`. That is Check B PROVED and Check A
         merely unasked — which is the exact state confirming a company exists to
         complete. Before this the carry read the caller's `checkB` alone, got
         null, and wrote `entity`/`no_data` over the top: grade `strong` → `weak`,
         the deed's own sentence and its document id DELETED, and a message that
         read "we have not yet confirmed that this entity is the one that held
         this property" — which the records had already confirmed. Confirming a
         company made the line strictly WEAKER, on the one path the feature is
         most for. */
      const verdict = ownershipVerdict({
        checkA,
        checkB: (opts.checkB ? opts.checkB(row) : null)
          || (recordsProvedCheckB ? { proved: true, confidence: 'certain' } : null),
        hold: { from: row.purchase_date, to: row.counts_from },
        member: { from: row.held_from, to: row.held_to },
      });
      if (!verdict) continue;

      /* A RECORDS-PROVED CHECK B IS PROMOTED IN PLACE, NOT RE-STATED AS OURS.
         `checks.js`'s own confirmed branch answers this same situation with
         `auto_source='elementix'`, the deed's grade, and the evidence kept — so
         writing anything else here would make "confirm the company" and "re-read
         the records" produce two different pillars for one set of facts, and the
         stamp would appear or disappear depending on which button somebody
         pressed. The evidence is MERGED, never replaced: the document id, the
         recording date and the grantee all survive inside `checkB`, and the
         sentence being replaced is kept as `priorWhy` rather than dropped —
         COALESCEd off any existing `priorWhy` so a second application can never
         overwrite the deed's own words with our own. `auto_grade` is deliberately absent from the SET —
         the records graded this, we did not. Only an UNSETTLED records row is
         promoted; an already-proved one keeps checks.js's own specific sentence
         (a refinance, a current-owner record) rather than gaining our generic
         one, and a contradicted one is never quietly turned into a proof. */
      const promote = recordsProvedCheckB && verdict.auto_verdict === 'proved';

      /* THE CARRY MAY ONLY ADD CONFIDENCE — IT MAY NEVER OVERWRITE WHAT WE READ
         OFF THE RECORD.

         This UPDATE used to be unconditional, while the CLEAR branch above has
         always had the shape it should have had too ("touch only what WE
         carried", `AND satisfied_by_llc_id IS NOT NULL`). Unguarded, the carry
         wrote `auto_source='entity'` straight over an ownership pillar the
         RECORDS CHECK had already PROVED (`auto_source='elementix'`) — and
         because the records stamp is DERIVED from exactly those two columns,
         marking an entity's ownership verified TOOK "Verified to Elementix" OFF
         the line, on every screen and on the investor package. An action that
         can only ever ADD confidence was silently removing it.

         `recordsSettled` is what the records have already decided about this
         pillar, and an inference never re-opens it:
           · `proved`       — we read the deed. Nothing the carry knows is
                              stronger, and its own `proved` says LESS, because
                              the stamp reads the SOURCE and not just the verdict.
           · `contradicted` — a real negative finding ("every recorded deed
                              conveys this property to somebody else"). Writing
                              over it would hide the one thing a reviewer has to
                              look at.

         A CONTRADICTION THE CARRY ITSELF FINDS STILL WRITES OVER A PROVED ROW —
         but ONLY over a proof that rests on THIS entity. The membership window is
         evidence about the BORROWER that the records read never saw ("this entity
         held the property before they had anything to do with it"), and a
         negative finding must never be suppressed to protect a stamp; it drops
         the line to `sourced`, which is exactly what VERIFIED_BLOCKED_WHERE is
         for. Left unnarrowed it also landed on a deed naming the BORROWER
         THEMSELVES — a proof with no entity anywhere in it — rewriting it as
         "this property was sold before the borrower joined this entity", which is
         simply not what that deed says, and taking the stamp off a line the
         records had proved outright. The revoke branch guards that exact case;
         this one has to as well, which is why `restsOnThisEntity` is computed
         once for both.

         Everything the carry has always answered is untouched: a pillar nobody
         has checked, an `elementix`/`no_data` ("the company held it, nobody has
         confirmed control") — the very question Check A answers — and its own
         earlier carry. COALESCE on both columns because a never-checked pillar
         holds NULLs, and `NOT (NULL AND NULL)` is NULL, not true: the standing
         three-valued-logic trap, which here would have refused every fresh row
         and turned the whole feature off. */
      /* THE RECORDS NAMED A DIFFERENT COMPANY — SAY NOTHING, DESTROY NOTHING.
         Narrowing the promotion above is only half the answer: without this the
         carry would fall through to the ordinary write and REPLACE that pillar's
         evidence with "we have not yet confirmed that this entity is the one
         that held this property", deleting the deed sentence, the grantee's name
         and the document id the records did find — the exact clobber this whole
         change exists to stop, just moved one case along. Confirming Alpha has
         nothing to say about a deed naming Bravo, so the honest answer is to
         leave the row exactly as the records left it and report it preserved. */
      if (recordsHasCheckB && !recordsMatchedThisEntity) { out.preserved += 1; continue; }

      const recordsSettled = (verdict.auto_verdict === 'contradicted' && restsOnThisEntity)
        ? ['contradicted']
        : ['proved', 'contradicted'];

      const w = promote
        ? await client.query(
          `UPDATE track_record_pillars
              SET auto_verdict='proved', auto_source='elementix', auto_confidence='certain',
                  auto_evidence = COALESCE(auto_evidence,'{}'::jsonb)
                                  || jsonb_build_object('priorWhy',
                                       COALESCE(auto_evidence->'priorWhy', auto_evidence->'why'))
                                  || $2::jsonb,
                  satisfied_by_llc_id=$3, auto_checked_at=now(), updated_at=now()
            WHERE track_record_id=$1 AND pillar='ownership'
              AND auto_source='elementix'
              AND COALESCE(auto_verdict,'') NOT IN ('proved','contradicted')
              AND COALESCE(auto_evidence->'checkB'->>'granteeIsMatchedEntity','') = 'true'`,
          [row.id, JSON.stringify({
            why: row.pillar_matched
              ? `"${row.pillar_matched}" is named on the recorded instrument for this property, and this borrower’s control of that company has now been confirmed.`
              : 'The records show this company held this property, and this borrower’s control of it has now been confirmed.',
            controlVerdict: 'confirmed',
            satisfiedByLlcId: row.llc_id,
            needsControlCheck: false,
            /* A WITHDRAWAL THAT HAS BEEN ANSWERED IS NOT STILL STANDING. Round-
               tripping confirm → revoke → confirm otherwise left the row reading
               `proved` and `controlVerdict:'confirmed'` while still carrying the
               revoke's own `controlRevokedAt` — self-contradictory state on a row
               an auditor may read years later. jsonb `||` cannot delete a key, so
               it is nulled. */
            controlRevokedAt: null,
            checkA: { verifiedAt: row.ownership_verified_at, llcId: row.llc_id },
          }), row.llc_id])
        : await client.query(
          `UPDATE track_record_pillars
              SET auto_verdict=$2, auto_source=$3, auto_confidence=$4, auto_grade=$5,
                  auto_evidence=$6::jsonb, satisfied_by_llc_id=$7, auto_checked_at=now(), updated_at=now()
            WHERE track_record_id=$1 AND pillar='ownership'
              AND NOT (COALESCE(auto_source,'') = 'elementix'
                       AND COALESCE(auto_verdict,'') = ANY($8::text[]))`,
          [row.id, verdict.auto_verdict, verdict.auto_source, verdict.auto_confidence, verdict.auto_grade,
            JSON.stringify({ message: verdict.message, checkA: { verifiedAt: row.ownership_verified_at, llcId: row.llc_id } }),
            row.llc_id, recordsSettled]);

      /* COUNT WHAT ACTUALLY MOVED. The entity screen shows this summary to the
         reviewer, so reporting a carry the guard refused would claim evidence
         nothing wrote. A refused row is REPORTED as preserved, never dropped in
         silence. */
      /* A 0-row write means the guard refused it — unless there is no ownership
         pillar on the line at all, which the LEFT JOIN already told us. Counting
         that as `preserved` would report "the records had settled this" about a
         row that does not exist. */
      if (!w.rowCount) { if (row.pillar_verdict) out.preserved += 1; continue; }

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

/**
 * PREVIOUS FILES — the stamps a pre-fix revoke left standing.
 *
 * Until the guard above existed, a records proof that rested on Check A survived
 * a revoke untouched: `checks.js` writes it with no `satisfied_by_llc_id`, so the
 * clear ("only what WE carried") matched nothing. Those lines are still on disk
 * today saying `elementix`/`proved`, still stating that the borrower's control
 * "has been confirmed", and still printing "Verified to Elementix" on the
 * investor package for a company somebody un-verified. Going forward the revoke
 * withdraws them; nothing reaches the ones already sitting there, and they heal
 * only if a human happens to touch that entity's ownership check again.
 *
 * So this is the same downgrade, applied once at boot to every pillar whose
 * Check A link is CURRENTLY not verified. It is SELF-DRAINING by construction —
 * the downgrade takes the row out of its own `auto_verdict='proved'` predicate —
 * so it is idempotent across deploys with no cursor to keep. It only ever
 * REMOVES a claim, never adds one; it never touches a pillar a human confirmed
 * (their decision is theirs), never touches a deed naming the borrower in person
 * (no `controlVerdict`), and keeps the deed's own sentence as `priorWhy`.
 *
 * The reverse direction is deliberately NOT healed here and cannot be: a line
 * whose records proof a pre-fix CONFIRM overwrote with `entity/*` no longer holds
 * what the deed said, so the only way back is to read the county again — a
 * vendor call, per line, which is a human's decision to spend, not a boot pass's.
 */
/* THE CANDIDATE TEST, WRITTEN ONCE. The selection phase and the write phase
   must ask EXACTLY the same question: the selector only bounds the work, so a
   row it excludes can never be healed however the write's own WHERE reads, and
   a row the write excludes is simply skipped. Two copies of this drift, and the
   drift is silent — the old selector asked about whichever company the LINE
   points at NOW (a join on b.llc_id = t.llc_id) while the write asked nothing
   about a company at all, so an ORPHANED proof (its entity deleted, so the FK
   NULLed track_records.llc_id) fell out of the join entirely and went on
   printing "Verified to Elementix" for a company that no longer exists.

   NO BACKTICKS IN THIS STRING -- it is spliced into a JS template literal and
   one would end it. That has bitten this file twice. */
const HEAL_CANDIDATE_SQL = (p) => `
     ${p}.pillar = 'ownership'
     AND ${p}.auto_source = 'elementix'
     AND ${p}.auto_verdict = 'proved'
     AND ${p}.auto_evidence->>'controlVerdict' = 'confirmed'
     AND COALESCE(${p}.human_verdict,'') <> 'confirmed'
     AND COALESCE(${p}.auto_evidence->>'satisfiedByLlcId','') <> ''
     AND NOT EXISTS (
       SELECT 1
         FROM track_records t_
         JOIN llc_borrowers b_ ON b_.borrower_id = t_.borrower_id
        WHERE t_.id = ${p}.track_record_id
          AND b_.llc_id::text = ${p}.auto_evidence->>'satisfiedByLlcId'
          AND b_.ownership_verified = true)`;

/* IT ASKS ABOUT THE COMPANY THE PROOF NAMES, NOT THE ONE THE LINE POINTS AT.
   `satisfiedByLlcId` is what the proof RESTS on; `track_records.llc_id` is
   whatever the line happens to reference today, and the two come apart in two
   ordinary ways -- the entity is deleted (the FK NULLs the column) or the line
   is re-pointed at a different company. Keyed on the line's column, a proof
   resting on an UNVERIFIED company was never reached the moment those diverged. */
async function healSelectIds(client, limit) {
  const r = await client.query(
    `SELECT p.id
       FROM track_record_pillars p
      WHERE ${HEAL_CANDIDATE_SQL('p')}
      ORDER BY p.id
      LIMIT ${limit}`);
  return r.rows.map((x) => x.id);
}

/* THE WRITE RE-ASKS THE WHOLE QUESTION, and it is a SEPARATE STATEMENT on
   purpose. Under READ COMMITTED every statement takes its own snapshot, so a
   Confirm that commits between the selection and this write IS seen here and
   the row is skipped -- as one statement it would have been judged on a
   snapshot taken before that Confirm existed and would have withdrawn a stamp
   for a company that had just been verified.

   HONEST LIMIT: a Confirm committing DURING this statement is still missed, and
   cannot be caught without serialising the whole pass. That residue only ever
   REMOVES a claim (the posture of this whole function), it is bounded by one
   statement inside one boot, and the withdrawn pillar keeps its checkB -- so the
   next press of Confirm, or the next records read, promotes it straight back.

   AND IT REPEATS THE WHOLE CANDIDATE TEST, which is not belt-and-braces either
   -- it is the correctness of the statement. An id list carries NO condition on
   the target row, and under READ COMMITTED Postgres re-checks only the quals
   against the TARGET relation when a blocked writer wakes: the list was fixed
   before the lock wait, so a second writer proceeds anyway. With the priorWhy
   merge below, a second application copies the FIRST one's withdrawal sentence
   into priorWhy and the deed's own words are destroyed. Two ordinary ways in:
   two instances booting at once on a zero-downtime deploy (each takes the same
   first-500-by-id), and a staffer pressing Revoke while a deploy's heal runs.
   Repeating the test makes the re-check see a row that no longer qualifies, so
   the second write is a clean 0 rows -- the shape the live revoke already had.
   The COALESCE on priorWhy is the second layer. */
async function healApply(client, ids) {
  if (!ids.length) return 0;
  const r = await client.query(
    `UPDATE track_record_pillars p
        SET auto_verdict='no_data', auto_confidence=NULL, satisfied_by_llc_id=NULL,
            auto_evidence = COALESCE(p.auto_evidence,'{}'::jsonb)
                            || jsonb_build_object('priorWhy',
                                 COALESCE(p.auto_evidence->'priorWhy', p.auto_evidence->'why'))
                            || $1::jsonb,
            auto_checked_at=now(), updated_at=now()
      WHERE p.id = ANY($2::uuid[])
        AND ${HEAL_CANDIDATE_SQL('p')}`,
    [JSON.stringify({
      controlVerdict: null,
      needsControlCheck: true,
      controlRevokedAt: new Date().toISOString(),
      why: 'The records show the company held this property, but this borrower’s control of that company is not verified — so holding it does not show their ownership. Confirm the company, or check whether a deed names the borrower themselves.',
    }), ids]);
  return r.rowCount || 0;
}

async function healRevokedRecordsProofsOnce(opts = {}) {
  const out = { downgraded: 0, ok: true };
  if (String(process.env.TRACK_RECORD_REVOKED_PROOF_HEAL_DISABLED || '') === '1') return { ...out, skipped: 'disabled' };
  const client = opts.client || require('../db');
  const limit = Math.max(1, Math.min(5000, Number(process.env.TRACK_RECORD_REVOKED_PROOF_HEAL_LIMIT) || 500));
  try {
    const ids = await healSelectIds(client, limit);
    out.downgraded = await healApply(client, ids);
    /* NO SILENT CAPS. It drains at most `limit` rows PER BOOT, so a large back
       book takes several deploys to finish - true, and invisible unless it is
       said. `more` counts what was SELECTED, not what was written: a row the
       write's re-check skipped was still work this pass took off the queue. */
    out.more = ids.length >= limit;
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
  healRevokedRecordsProofsOnce,
  /* The two phases are exported ONLY so a test can commit a Confirm BETWEEN
     them and prove the write re-asks. Nothing in production calls them
     directly -- the pass above is the one entry point. */
  _internals: { healSelectIds, healApply },
};
