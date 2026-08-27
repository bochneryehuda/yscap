'use strict';

/**
 * TWO PROFILES, ONE PERSON — MERGED AUTOMATICALLY WHEN IT IS PROVABLE, AND NEVER
 * OTHERWISE (owner-directed 2026-08-27: "Profiles should automatically be merged
 * if it matches … find the root cause of the duplicate profile, fix the root
 * cause … and make sure in the future it's not happening again").
 *
 * ── THE ROOT CAUSE ──────────────────────────────────────────────────────────
 * `borrowers.email` is unique only for the profile that OWNS an address:
 * `borrowers_email_owner_uk ON borrowers(email) WHERE shares_email = false`
 * (db/318). The flag exists for a real case the owner asked for — a husband and
 * wife on one mailbox — and it is a HUMAN JUDGEMENT: "these are two different
 * people".
 *
 * But MACHINES set it too, and they set it for a completely different reason:
 * to get past that index. `clickup/ingest.js` flags a new profile
 * `shares_email` whenever it cannot CORROBORATE an email match, and the ClickUp
 * placeholder heal does the same on a 23505. So one column carries two facts
 * that nothing can tell apart — "a person decided" and "a machine needed room" —
 * and once it is set the duplicate is invisible to the only constraint that
 * would have stopped it. Nothing ever revisits it, so it is permanent.
 *
 * MEASURED, on the reported borrower: two `Leib Lichtman` profiles on
 * leonlichtman646@gmail.com, same date of birth, same phone (written two ways),
 * same home address (differing only in case) — one flagged `shares_email`, one
 * owning the address, and only one of them carrying the Social and the loan
 * files. Nobody ever decided they were two people.
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────
 * Merges a pair ONLY when it is PROVABLE, and leaves everything else exactly
 * where it is — on the duplicates screen, for a human. Proof is one of:
 *
 *   · the same `ssn_hash`. One Social Security number is one person. This is
 *     the only single field that proves it on its own.
 *   · the same real email AND the same full name, with nothing contradicting
 *     it. A husband and wife share a mailbox; they do not share a name.
 *
 * and then, ON TOP of proof, four refusals — any one of which sends the pair to
 * a human instead:
 *
 *   1. A HUMAN ALREADY DECIDED. `borrower_profile_links` is where "yes, two
 *      different people" is recorded. If the pair is there, this never touches
 *      it. `shares_email` on its own is NOT that record — machines set it, which
 *      is the whole defect — so it is deliberately not read as a decision here.
 *   2. ANYTHING NEEDS A CHOICE. The pair goes through the SAME
 *      `borrower-merge.compare()` the staff screen uses; a single-valued field
 *      that genuinely disagrees is a decision, and decisions are not ours. Two
 *      spellings of one value are not a disagreement (below).
 *   3. BOTH SIDES HAVE A PORTAL LOGIN. A login is pinned to one profile per
 *      address; collapsing two is a sign-in change, not a clean-up.
 *   4. THE SOCIALS DIFFER. Two different numbers are two different people,
 *      whatever else agrees. This is checked before proof, not after.
 *
 * ── A SPELLING IS NOT A DISAGREEMENT ────────────────────────────────────────
 * `compare()` is deliberately literal — it renders values for a human to read,
 * so `6465650705` and `(646) 565-0705` are two different strings. They are one
 * phone number. Rather than loosen the shared comparer (it is right for the
 * screen), a conflict is discounted here only when the repo's OWN definition
 * for that field says the two values MEAN the same thing: `address.sameAddress`
 * for an address, digits for a phone, case for an email. Everything else stands
 * as a real conflict and stops the merge.
 *
 * ── AND IT NEVER INVENTS A MERGE PATH ───────────────────────────────────────
 * The merge itself is `borrower-merge.mergeBorrowers`, unchanged: one
 * transaction, the losing profile snapshotted first, every foreign key
 * discovered live. A second copy of that would be the most destructive
 * duplication in this repo.
 */

const db = require('../db');
const merge = require('./borrower-merge');

/* Addresses that are not identities. A ClickUp shadow address is minted per
   TASK, so two of them are never evidence of the same person — and a
   placeholder must never be allowed to prove a match. */
const PLACEHOLDER_EMAIL = /@(clickup|import)\.local$/i;
const PLACEHOLDER_NAME = new Set(['unknown', 'borrower', 'co-borrower', 'n/a', 'na', '']);

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const digits = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
const dayOf = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** A real, identity-bearing email, or null. */
function realEmail(v) {
  const s = lc(v);
  if (!s || !s.includes('@') || PLACEHOLDER_EMAIL.test(s)) return null;
  return s;
}

/** The person's name as one comparable token, or null when it names nobody. */
function nameKey(row) {
  const first = lc(row && row.first_name);
  const last = lc(row && row.last_name);
  if (!first || !last || PLACEHOLDER_NAME.has(first) || PLACEHOLDER_NAME.has(last)) return null;
  return `${first} ${last}`.replace(/\s+/g, ' ');
}

/**
 * Are these two profiles PROVABLY the same person?
 *
 * PURE — no database, so every rule is unit-testable. Answers `{ same, basis,
 * why }`; `same:false` is the default for anything it cannot prove, which is
 * most pairs.
 */
function provableMatch(a, b) {
  if (!a || !b || String(a.id) === String(b.id)) return { same: false, basis: null, why: 'same row' };

  // A CONTRADICTION BEATS EVERY AGREEMENT. Two real Socials that differ are two
  // people however identical the rest of the profile looks — this is asked
  // first so no later rule can talk its way past it.
  if (a.ssn_hash && b.ssn_hash && a.ssn_hash !== b.ssn_hash) {
    return { same: false, basis: null, why: 'different Social Security numbers' };
  }
  const dobA = dayOf(a.date_of_birth), dobB = dayOf(b.date_of_birth);
  if (dobA && dobB && dobA !== dobB) {
    return { same: false, basis: null, why: 'different dates of birth' };
  }

  // PROOF 1 — one Social Security number is one person.
  if (a.ssn_hash && b.ssn_hash && a.ssn_hash === b.ssn_hash) {
    return { same: true, basis: 'ssn', why: 'the same Social Security number' };
  }

  // PROOF 2 — the same mailbox AND the same person's name. A household shares
  // an address; it does not share a full name.
  const emA = realEmail(a.email), emB = realEmail(b.email);
  const nmA = nameKey(a), nmB = nameKey(b);
  if (emA && emA === emB && nmA && nmA === nmB) {
    return { same: true, basis: 'email_name', why: 'the same email address and the same full name' };
  }

  return { same: false, basis: null, why: 'nothing proves these are one person' };
}

/**
 * Is a conflict `compare()` reported only a difference in SPELLING?
 *
 * Delegated to the repo's own definition for each field — never a tolerance
 * invented here. A field with no such definition is always a real conflict,
 * so a new single-valued column is safe by default.
 */
function formatOnlyConflict(key, aVal, bVal) {
  if (key === 'cell_phone') {
    const x = digits(aVal).slice(-10), y = digits(bVal).slice(-10);
    return !!x && x === y;
  }
  if (key === 'email') return !!lc(aVal) && lc(aVal) === lc(bVal);
  if (key === 'date_of_birth') return !!dayOf(aVal) && dayOf(aVal) === dayOf(bVal);
  if (key === 'current_address' || key === 'mailing_address') {
    try {
      const ADDR = require('./address');
      return !!ADDR.sameAddress(aVal, bVal);
    } catch (_) { return false; }
  }
  return false;
}

/**
 * WHICH PROFILE SURVIVES. Deterministic, and never the one that would cost
 * something to lose: the portal login first (a sign-in must not move), then the
 * profile that OWNS the email address (the row every upsert already resolves
 * to), then the one carrying the Social, then the one carrying the files, and
 * an explicit tie-break on age so two runs can never disagree.
 */
function pickSurvivor(a, b) {
  const score = (r) => [
    r.has_login ? 1 : 0,
    r.shares_email ? 0 : 1,
    r.ssn_hash ? 1 : 0,
    Number(r.files || 0),
    -new Date(r.created_at || 0).getTime(),
  ];
  const sa = score(a), sb = score(b);
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return sa[i] > sb[i] ? { survivor: a, merged: b } : { survivor: b, merged: a };
  }
  return String(a.id) < String(b.id) ? { survivor: a, merged: b } : { survivor: b, merged: a };
}

/* ── THE SWEEP ──────────────────────────────────────────────────────────────
   Candidates are pairs that share the one thing a duplicate always shares: an
   email address, or a Social. Everything else about whether they are one person
   is decided by `provableMatch` above.

   Bounded per pass and ordered, so a large back book drains over successive
   boots rather than merging thousands of profiles in one unattended burst.
   Never throws: a clean-up that can stop the server coming up is worse than the
   duplicates it removes. */

/** Every profile that shares an identity-bearing email or a Social with another. */
async function candidatePairs(limit) {
  const r = await db.query(
    `WITH grp AS (
       SELECT lower(btrim(email)) AS k, array_agg(id ORDER BY created_at) AS ids
         FROM borrowers
        WHERE email IS NOT NULL AND btrim(email) <> ''
          AND email !~* '@(clickup|import)\\.local$'
        GROUP BY 1 HAVING count(*) > 1
       UNION ALL
       SELECT 'ssn:' || ssn_hash AS k, array_agg(id ORDER BY created_at) AS ids
         FROM borrowers WHERE ssn_hash IS NOT NULL
        GROUP BY 1 HAVING count(*) > 1)
     SELECT ids FROM grp ORDER BY ids LIMIT $1`, [limit]);
  const pairs = [], seen = new Set();
  for (const row of r.rows) {
    const ids = row.ids || [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = [String(ids[i]), String(ids[j])].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([ids[i], ids[j]]);
      }
    }
  }
  return pairs;
}

/** The columns the rules above read, plus the two counts `pickSurvivor` needs. */
async function loadPair(idA, idB) {
  const r = await db.query(
    `SELECT b.id, b.first_name, b.last_name, b.email, b.shares_email, b.cell_phone,
            b.date_of_birth, b.ssn_hash, b.created_at,
            EXISTS (SELECT 1 FROM borrower_auth a WHERE a.borrower_id = b.id) AS has_login,
            (SELECT count(*)::int FROM applications ap
              WHERE (ap.borrower_id = b.id OR ap.co_borrower_id = b.id) AND ap.deleted_at IS NULL) AS files
       FROM borrowers b WHERE b.id = ANY($1::uuid[])`, [[idA, idB]]);
  return [r.rows.find((x) => String(x.id) === String(idA)), r.rows.find((x) => String(x.id) === String(idB))];
}

/**
 * RECORD THAT A HUMAN SAID "TWO DIFFERENT PEOPLE, ONE MAILBOX".
 *
 * This is the OTHER half of the root cause. Three doors let a staffer keep two
 * profiles on one address, and only one of them (the staff file-create path)
 * ever wrote the decision down — the profile editor and the contact-promote
 * door just set `shares_email` and moved on. So a real decision and a machine's
 * workaround left byte-identical evidence, and nothing could honour the first
 * without also protecting the second.
 *
 * Written for BOTH directions, because "do not merge" is symmetric and the
 * sweep may meet the pair from either side. Best-effort by design: failing to
 * record the note must never fail the save the person just made — the worst
 * case is that the pair is offered on the duplicates screen, which is where an
 * unrecorded pair already sits today.
 */
async function recordSharedEmailDecision(borrowerId, email, actorId = null) {
  try {
    const em = realEmail(email);
    if (!em || !borrowerId) return { recorded: 0 };
    const others = (await db.query(
      `SELECT id FROM borrowers WHERE lower(btrim(email)) = $1 AND id <> $2`, [em, borrowerId])).rows;
    let n = 0;
    for (const o of others) {
      await db.query(
        `INSERT INTO borrower_profile_links (borrower_id, linked_borrower_id, reason, created_by)
         VALUES ($1,$2,'shared_email_allowed',$3), ($2,$1,'shared_email_allowed',$3)
         ON CONFLICT (borrower_id, linked_borrower_id) DO NOTHING`, [borrowerId, o.id, actorId]);
      n++;
    }
    return { recorded: n };
  } catch (_) { return { recorded: 0 }; }
}

/** Has a human already said these are two different people? */
async function humanDecided(idA, idB) {
  const r = await db.query(
    `SELECT 1 FROM borrower_profile_links
      WHERE (borrower_id=$1 AND linked_borrower_id=$2)
         OR (borrower_id=$2 AND linked_borrower_id=$1) LIMIT 1`, [idA, idB]);
  return !!r.rows[0];
}

/**
 * Decide ONE pair. Returns `{ merge:false, reason }` for everything it will not
 * touch — every refusal is named, so "why is this duplicate still here?" is
 * always answerable.
 */
async function decidePair(idA, idB) {
  const [a, b] = await loadPair(idA, idB);
  if (!a || !b) return { merge: false, reason: 'gone' };

  const m = provableMatch(a, b);
  if (!m.same) return { merge: false, reason: 'not_provable', why: m.why };
  if (await humanDecided(a.id, b.id)) return { merge: false, reason: 'human_decided' };
  if (a.has_login && b.has_login) return { merge: false, reason: 'two_logins' };

  const { survivor, merged } = pickSurvivor(a, b);
  const cmp = await merge.compare(survivor.id, merged.id);
  const real = (cmp.fields || []).filter(
    (f) => f.conflict && !formatOnlyConflict(f.key, f.survivor, f.merged));
  if (real.length) {
    return { merge: false, reason: 'needs_a_choice', fields: real.map((f) => f.key) };
  }
  return { merge: true, survivorId: survivor.id, mergedId: merged.id, basis: m.basis, why: m.why };
}

/**
 * One bounded pass. `dryRun` reports exactly what it WOULD do and writes
 * nothing — the safe way to look at the back book before letting it run.
 */
async function autoMergeOnce({ limit = 200, dryRun = false } = {}) {
  const out = { pairs: 0, merged: 0, skipped: {}, done: [], errors: 0 };
  let pairs;
  try { pairs = await candidatePairs(limit); }
  catch (e) { return { ...out, errors: 1, reason: (e && e.message) || 'error' }; }
  out.pairs = pairs.length;

  for (const [x, y] of pairs) {
    let d;
    try { d = await decidePair(x, y); }
    catch (e) { out.errors++; continue; }
    if (!d.merge) {
      out.skipped[d.reason] = (out.skipped[d.reason] || 0) + 1;
      continue;
    }
    if (dryRun) { out.done.push({ ...d, dryRun: true }); out.merged++; continue; }
    try {
      /* THE SHARED MERGE, with NO `choices`: by the time we are here every
         single-valued field either agrees, is a spelling of the same value, or
         is held by only one side — so there is nothing to choose, which is
         exactly the condition that made this pair safe to merge unattended. */
      await merge.mergeBorrowers({ survivorId: d.survivorId, mergedId: d.mergedId, actorId: null });
      try {
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           VALUES ('system', NULL, 'borrower_auto_merged', 'borrower', $1, $2::jsonb)`,
          [d.survivorId, JSON.stringify({ mergedId: d.mergedId, basis: d.basis, why: d.why })]);
      } catch (_) { /* the merge is what matters; its note is best-effort */ }
      out.merged++;
      out.done.push({ survivorId: d.survivorId, mergedId: d.mergedId, basis: d.basis });
    } catch (e) {
      out.errors++;
      out.skipped.merge_failed = (out.skipped.merge_failed || 0) + 1;
    }
  }
  return out;
}

module.exports = {
  provableMatch, formatOnlyConflict, pickSurvivor,
  candidatePairs, decidePair, autoMergeOnce, recordSharedEmailDecision,
  _internals: { realEmail, nameKey, dayOf, digits, loadPair, humanDecided },
};
