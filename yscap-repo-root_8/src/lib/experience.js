'use strict';

const db = require('../db');

// FROZEN baseline (#89) — experience window. A completed deal counts toward the
// borrower's tier / experience ONLY if its exit is within the last 3 years:
//   · a FLIP exits on its SALE date
//   · a hold / rental exits on its LEASE (rent) or REFI date
//   · a GROUND-UP exits on whichever of those it has — see the amendment below
// An exit more than 36 months ago, or a future-dated exit, counts toward
// nothing. This mirrors the frozen track-record tool's qualifies() exactly and
// must be applied at EVERY server-side experience/tier count so the tier can
// never be inflated by stale deals. Reuse RECENT_EXIT_SQL — don't re-derive it.

/* ── THE GROUND-UP AMENDMENT (owner-authorized 2026-08-09) ────────────────────
   THE OWNER'S WORDS, choosing between three options put to them: a ground-up is
   finished when the building is done AND they "Sold OR rented/refinanced".

   WHAT WAS WRONG. The base rule sends anything that is not a flip to
   COALESCE(rent_date, refi_date). A ground-up that was BUILT AND SOLD — the most
   ordinary ground-up outcome there is — carries a sale date and no rent or refi
   date, so its exit date was NULL and it counted toward NOTHING. Confirmed both
   ways before changing anything: exitDateOf({deal_type:'ground-up',
   sale_date:'2025-06-01'}) returned null, and the same row through EXIT_DATE_SQL
   on a real database returned NULL. A borrower who built and sold three houses
   was credited with none of them, while `requested_exp_ground` still priced the
   loan on the claim.

   THE SYSTEM ALREADY PROMISED THIS RULE. `trackRecordMissing` in routes/borrower.js
   tells the borrower a ground-up still needs "a completed exit (sale, rent, or
   refinance)" — so the screen has always said a sale finishes a ground-up, and
   only the COUNT disagreed. This amendment makes the count agree with the promise
   the product already makes; it does not introduce a new standard.

   THE SHAPE IS THE PROOF, and it is why this is written as a COALESCE over the
   OLD EXPRESSION rather than as a rewritten CASE. The new rule returns the old
   rule's answer WHENEVER THE OLD RULE HAD ONE, by construction — the fallback is
   only ever reached where the old expression was already NULL, i.e. exactly the
   rows that counted for nothing. Therefore:

       NO DEAL THAT COUNTS TODAY CAN STOP COUNTING, AND NO COUNTED DEAL'S EXIT
       DATE CAN MOVE. The change is purely additive.

   That is a property of the expression, not of a test battery, and it is what
   makes an authorized change to a frozen counting rule safe to ship: a borrower
   cannot lose a tier, no registered loan can be re-sized downward, and the
   experience condition cannot reopen on a live file. `scripts/test-ground-up-
   exit-pure.js` proves it exhaustively over every deal_type × date combination
   anyway, and the DB half proves the SQL twin agrees row for row.

   A rewritten CASE would NOT have this property. Writing the ground branch as
   COALESCE(sale_date, rent_date, refi_date) reads more naturally and is wrong: a
   ground-up that was rented in 2023 and sold in 2025 would move its exit from the
   rent date to the sale date, and a deal_type spelled "ground-up flip" — which
   the base rule sends down the flip branch — would move off its sale date
   entirely. Both can push a deal out of the 36-month window. Do not "simplify"
   this into a CASE.

   Deliberately NOT changed: the 36-month window, the future-exit rule, the flip
   rule, the hold rule, and `bucketOf`. Only the ground-up's EXIT DATE moved, and
   only where it did not have one. */
const GROUND_SQL =
  "(lower(coalesce(deal_type,'')) LIKE '%ground%' OR lower(coalesce(deal_type,'')) LIKE '%construction%')";
/* The rule as it stood before the amendment. Kept as its own constant so the
   additive property above is visible in the source and provable in a test. */
const EXIT_DATE_BASE_SQL =
  "(CASE WHEN lower(coalesce(deal_type,'')) LIKE '%flip%' THEN sale_date ELSE COALESCE(rent_date, refi_date) END)";
const EXIT_DATE_SQL =
  `COALESCE(${EXIT_DATE_BASE_SQL},`
  + ` CASE WHEN ${GROUND_SQL} THEN COALESCE(sale_date, rent_date, refi_date) END)`;
const EXIT_WINDOW_MONTHS = 36;   // frozen; the SQL below and exitCounts() both read it
/* The window is INTERPOLATED, not restated. It used to be a hardcoded
   INTERVAL '36 months' beside a constant whose own comment claimed "the SQL
   below and exitCounts() both read it" — so changing the constant would have
   moved the JS twin and left the SQL on 36, silently disagreeing about which
   deals count (audit 2026-08-09). */
const RECENT_EXIT_SQL =
  `${EXIT_DATE_SQL} IS NOT NULL`
  + ` AND ${EXIT_DATE_SQL} <= CURRENT_DATE`
  + ` AND ${EXIT_DATE_SQL} >= (CURRENT_DATE - INTERVAL '${EXIT_WINDOW_MONTHS} months')`;

/* ── THE SAME TWO RULES, IN JAVASCRIPT ────────────────────────────────────────
   EXIT_DATE_SQL and RECENT_EXIT_SQL are the definition, but not every consumer
   can run SQL: the investor export renders rows it already has in hand. It used
   to carry its OWN version — `sale_date || refi_date || rent_date`, no deal_type
   branch, and a 30.44-day "month" — which meant the TPR package's "Recent (3yr)"
   column disagreed with the counts the sign-off gate uses, on two axes:

     · a hold carrying BOTH a rent date and a refi date exited on a different day
       in the export than in the count (SQL prefers rent_date; it preferred refi);
     · an approximated month drifts against calendar months, so deals near the
       boundary fell on opposite sides.

   These are the JS twins. Anything that needs the rule without a database calls
   THEM — never a fourth re-derivation. Dates are compared as YYYY-MM-DD strings
   so a timezone can never move a deal across the boundary. */

/** A date-ish value (pg Date, ISO string, 'YYYY-MM-DD') as 'YYYY-MM-DD', or null. */
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** Calendar-month subtraction that matches Postgres: 2024-02-29 - 36mo = 2021-02-28. */
function minusMonths(d, n) {
  const day = d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() - n, 1);
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, lastDay));
  return t;
}

/** True exactly when GROUND_SQL is — the same two substrings `bucketOf` reads. */
function isGroundUp(dealType) {
  const s = String(dealType || '').toLowerCase();
  return s.indexOf('ground') >= 0 || s.indexOf('construction') >= 0;
}

/**
 * JS twin of EXIT_DATE_SQL: a flip exits on its sale, a hold on lease-up or refi,
 * and a GROUND-UP falls back to whichever completion it has when the base rule
 * left it with none (owner-authorized 2026-08-09 — see the header).
 *
 * The two halves are kept in the same shape as the SQL on purpose: `base` is the
 * old rule verbatim, and the ground fallback is only consulted when `base` is
 * null. That is the additive property the header states, expressed identically in
 * both languages so the twins cannot drift into disagreeing about it.
 */
function exitDateOf(row) {
  if (!row) return null;
  const flip = String(row.deal_type || '').toLowerCase().includes('flip');
  const base = ymd(flip ? row.sale_date : (row.rent_date || row.refi_date));
  if (base) return base;
  if (!isGroundUp(row.deal_type)) return null;
  return ymd(row.sale_date) || ymd(row.rent_date) || ymd(row.refi_date);
}

/** JS twin of RECENT_EXIT_SQL: a completed, non-future exit inside the frozen 36 months. */
function exitCounts(row, today = new Date()) {
  const exit = exitDateOf(row);
  if (!exit) return false;
  const t = ymd(today);
  if (!t || exit > t) return false;                       // no exit, or still in the future
  return exit >= ymd(minusMonths(today, EXIT_WINDOW_MONTHS));
}

function int(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : 0;
}

function bucketOf(dealType) {
  const s = String(dealType || '').toLowerCase();
  if (s.indexOf('ground') >= 0 || s.indexOf('construction') >= 0) return 'ground';
  if (s.indexOf('flip') >= 0) return 'flips';
  return 'holds';
}

function requestedFromApp(app) {
  return {
    flips: int(app && app.requested_exp_flips),
    holds: int(app && app.requested_exp_holds),
    ground: int(app && app.requested_exp_ground),
  };
}

function hasRequirement(required) {
  return int(required.flips) + int(required.holds) + int(required.ground) > 0;
}

function requirementMet(counts, required) {
  return int(counts.flips) >= int(required.flips)
    && int(counts.holds) >= int(required.holds)
    && int(counts.ground) >= int(required.ground);
}

async function countBorrowerExperience(borrowerId, client = db, opts = {}) {
  return countBorrowersExperience([borrowerId], client, opts);
}

// Experience across one or more borrowers, summed. A loan file with a
// co-borrower counts BOTH borrowers' completed deals toward the file's
// experience (#80): if borrower A has 2 flips and co-borrower B has 2 flips,
// the file has 4 flips. Each track_records row already belongs to exactly one
// borrower, so summing the per-borrower counts never double-counts a deal.
async function countBorrowersExperience(borrowerIds, client = db, opts = {}) {
  const ids = (borrowerIds || []).filter(Boolean);
  const counts = { flips: 0, holds: 0, ground: 0, total: 0 };
  if (!ids.length) return counts;
  const verifiedOnly = !!opts.verifiedOnly;
  const r = await client.query(
    `SELECT lower(coalesce(deal_type,'')) AS deal_type, count(*)::int AS n
       FROM track_records
      WHERE borrower_id = ANY($1::uuid[])
        AND ($2::boolean=false OR is_verified=true)
        AND (${RECENT_EXIT_SQL})
      GROUP BY 1`,
    [ids, verifiedOnly]);
  for (const row of r.rows) {
    const n = int(row.n);
    counts[bucketOf(row.deal_type)] += n;
    counts.total += n;
  }
  return counts;
}

// The set of borrower ids whose experience counts for a file: the primary
// borrower plus the co-borrower when present.
function fileBorrowerIds(app) {
  return [app && app.borrower_id, app && app.co_borrower_id].filter(Boolean);
}

/**
 * The experience threshold that must be VERIFIED before the experience condition
 * can be signed off — the CURRENT registered product's experience, which is the
 * SAME number `signOffGate` reads (staff.js, is_current registration inputs).
 *
 * ONE definition, because three places now ask the question — the condition
 * sync, the sign-off gate's shortfall message, and the file's track-record
 * to-do list. Two of them disagreeing would show an officer a list of work that
 * does not match what the gate actually refuses on.
 *
 * Falls back to the caller's value — the application's own CLAIM — when nothing
 * is registered yet, and since 2026-08-06 that fallback genuinely DECIDES: the
 * gate used to refuse an unregistered file outright ("Register a product
 * first"), which is a dead end on a condition about the track record. An
 * officer who generated a term sheet claiming 10 stabilized rentals is now told
 * to verify the ten deals (owner-directed: "the condition should require
 * verifying 10 — you should not be able to sign it off till you verify 10"),
 * and a file whose claim IS verified may be signed off without a registration.
 * The separate Products & Pricing condition is what requires a registration.
 *
 * Never throws — a read failure is the same fallback.
 */
async function registeredExperienceNeed(appId, client = db, fallback = null) {
  const base = fallback || { flips: 0, holds: 0, ground: 0 };
  try {
    const cur = await client.query(
      `SELECT inputs FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    if (!cur.rows[0]) return base;
    const pin = cur.rows[0].inputs || {};
    return { flips: int(pin.expFlips), holds: int(pin.expHolds), ground: int(pin.expGround) };
  } catch (_) { return base; }
}

async function syncExperienceChecklistForApplication(appId, client = db) {
  const ar = await client.query(
    `SELECT id, borrower_id, co_borrower_id, requested_exp_flips, requested_exp_holds, requested_exp_ground
       FROM applications WHERE id=$1`,
    [appId]);
  const app = ar.rows[0];
  if (!app) return null;

  const required = requestedFromApp(app);
  // Experience for the FILE = the primary borrower + the co-borrower, summed
  // (#80): both borrowers' completed deals count toward the requirement.
  const ids = fileBorrowerIds(app);
  const counts = await countBorrowersExperience(ids, client);
  // VERIFIED experience (owner-directed 2026-07-20) — the file's experience
  // CONDITION is tied to VERIFIED deals, not merely ENTERED ones. `counts` above
  // stays the ENTERED (on-record) figure for display; `verifiedCounts` is what
  // drives "met" / the condition becoming ready to sign off. "If it's not
  // verified experience, then you should not be able to sign off that experience
  // condition even if you entered everything."
  const verifiedCounts = await countBorrowersExperience(ids, client, { verifiedOnly: true });
  // The experience threshold that must be VERIFIED to sign off = the CURRENT
  // registered product's experience — the SAME number the sign-off gate uses
  // (staff.js signOffGate: is_current registration inputs, regardless of stale).
  // Loans SIZE on the borrower's CLAIMED experience (frozen rule), but funding is
  // gated on the REGISTERED experience being verified; so "met" / the reopen must
  // track the REGISTERED need — not the raw application claim, which can exceed
  // the registered need and would otherwise reopen a legitimately signed-off
  // condition on every recompute (a loop the gate can never permanently satisfy).
  // Falls back to the application claim when nothing is registered yet — in that
  // state the gate blocks sign-off anyway, so the fallback is never the gate.
  const gateNeed = await registeredExperienceNeed(appId, client, required);
  /* WHERE THE NUMBER CAME FROM, and whether the file now disagrees with it
     (owner-reported 2026-08-21: "we changed the application to only three experiences,
     we changed the products and prices to only three, but the condition is still
     requiring five and we can't sign off").
     The requirement is the CURRENT REGISTERED product's experience — deliberately, so a
     lowered claim only relaxes the gate once the product is RE-REGISTERED on it
     (2026-08-09). That rule is right and stays; what was missing is that the screen never
     SAID so, so a file whose re-register did not carry the lower number just showed a
     stubborn "5" with nothing to act on. This is explanation, never a change to the
     requirement: `needFrom` says which of the two answered, and `claimBelowNeed` is the
     exact stuck state — the file itself now claims less than the loan was priced on. */
  const registered = await client.query(
    `SELECT created_at FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]
  ).then((r) => r.rows[0] || null).catch(() => null);
  const needFrom = registered ? 'registration' : 'application';
  const claimBelowNeed = !!registered && (
    required.flips < gateNeed.flips || required.holds < gateNeed.holds || required.ground < gateNeed.ground);
  const registeredAt = registered ? registered.created_at : null;
  /* AND WHETHER THE ADVICE CAN ACTUALLY BE FOLLOWED (owner-reported 2026-08-21, file
     YSCAP258134810 — 5705 Melvin St; the claim was lowered to three and the condition went
     on demanding five). Telling somebody to "re-register Products & Pricing" is only useful
     while the file can BE re-registered: past a sent term sheet, or at clear-to-close /
     funded, the register route refuses and the reader is left with a remedy that cannot
     produce the state the refusal demands — the dead-end class this codebase names
     elsewhere (`term-sheet-stamp.REGENERATE_MESSAGE`). So the stuck state carries the
     freeze with it, and the screen says what clears it instead of repeating advice that
     will bounce.

     Asked ACTOR-LESS on purpose: this is a description of the file, not a permission
     check, so it must never inherit a super-admin's unlock and read "you can re-register"
     to somebody who cannot. Best-effort — an unreadable lock leaves the plain advice
     standing, never a false "this file is frozen". */
  let reRegisterBlockedBy = null;
  if (claimBelowNeed) {
    try {
      reRegisterBlockedBy = await require('./file-lock').structuralLockReason(appId, client) || null;
    } catch (_) { reRegisterBlockedBy = null; }
  }
  // Per-borrower breakdown (#103) — on a co-borrower file the experience
  // condition shows BOTH borrowers, each named, with their OWN 3-year-window
  // counts and a link to their OWN track record. The requirement is still the
  // SUM (above); this is display detail only, so it never changes met/required.
  let perBorrower = null;
  if (ids.length > 1) {
    const nm = await client.query(
      `SELECT id, first_name, last_name FROM borrowers WHERE id = ANY($1::uuid[])`, [ids]);
    const nameById = {};
    for (const row of nm.rows) nameById[row.id] = require('./person-name').displayName(row) || 'Borrower';
    perBorrower = [];
    for (const bid of ids) {
      perBorrower.push({
        borrowerId: bid,
        name: nameById[bid] || 'Borrower',
        isPrimary: bid === app.borrower_id,
        counts: await countBorrowersExperience([bid], client),
        verifiedCounts: await countBorrowersExperience([bid], client, { verifiedOnly: true }),
      });
    }
  }
  // A NEGATIVE track-record change makes the registered product FATAL
  // (owner-directed 2026-07-14, same family as the db/096 economics trigger —
  // track_records writes can't fire that applications trigger, so the check
  // lives here, on the path every track-record mutation already calls). If the
  // CURRENT registration priced with more experience than is verified NOW
  // (a line item was un-verified, deleted, or aged out), the structure no
  // longer holds: flag it stale and reopen Products & Pricing + the signed
  // term sheet.
  try {
    const reg = await client.query(
      `SELECT id, inputs FROM product_registrations
        WHERE application_id=$1 AND is_current AND NOT stale LIMIT 1`, [appId]);
    if (reg.rows[0]) {
      const pin = reg.rows[0].inputs || {};
      const pricedWith = { flips: int(pin.expFlips), holds: int(pin.expHolds), ground: int(pin.expGround) };
      // The fatality is a NEGATIVE experience-of-record change — never a fresh
      // registration. Loans size on the CLAIMED experience (frozen rule), so at
      // registration pricedWith == the claim while VERIFIED is often still 0; the
      // old check (pricedWith > all-rows count) flagged every such registration
      // "experience dropped" at birth and silently disarmed the guard (audit
      // #10/#29). Judge against VERIFIED experience, with the current claim as a
      // floor: only when the registration priced on MORE than the file now claims
      // AND more than is verified has the experience of record actually dropped.
      const claim = required;   // requestedFromApp(app) — the claimed-of-record floor
      const verified = verifiedCounts;   // computed once above (verifiedOnly)
      const dropped =
           (pricedWith.flips  > int(claim.flips)  && pricedWith.flips  > int(verified.flips))
        || (pricedWith.holds  > int(claim.holds)  && pricedWith.holds  > int(verified.holds))
        || (pricedWith.ground > int(claim.ground) && pricedWith.ground > int(verified.ground));
      if (dropped) {
        await client.query(
          `UPDATE product_registrations SET stale=true,
                  stale_reason='verified track-record experience dropped below what the product was priced with'
            WHERE id=$1`, [reg.rows[0].id]);
        await client.query(
          `UPDATE checklist_items SET status='received', signed_off_at=NULL, signed_off_by=NULL,
                  reviewed_at=NULL, reviewed_by=NULL,
                  notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%'
                             THEN '[auto] Verified track-record experience dropped below what the product was priced with — re-register the product.'
                             ELSE notes END,
                  updated_at=now()
            WHERE application_id=$1 AND tool_key='product_pricing'
              AND (status='satisfied' OR signed_off_at IS NOT NULL)`, [appId]);
        await client.query(
          `UPDATE checklist_items ci SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL,
                  reviewed_at=NULL, reviewed_by=NULL,
                  notes=CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                             THEN '[auto] Verified experience changed — the signed term sheet no longer matches. Generate the new term sheet and collect a fresh signature.'
                             ELSE ci.notes END,
                  updated_at=now()
             FROM checklist_templates t
            WHERE t.id=ci.template_id AND t.code='rtl_cond_signedts' AND ci.application_id=$1
              AND (ci.status IN ('received','satisfied') OR ci.signed_off_at IS NOT NULL)`, [appId]);
      }
    }
  } catch (e) { console.warn('[experience] registration staleness check skipped:', e.message); }

  const requiredAny = hasRequirement(required);
  // NO experience claimed on the file → there is nothing to verify, so the
  // track-record condition is NOT APPLICABLE. We auto-satisfy it (stamped
  // notApplicable) so it drops out of the open conditions list — it "disappears"
  // until experience is added (either on the application or written back from
  // Products & Pricing), at which point it reopens for real verification.
  const notApplicable = !requiredAny;
  // MET is judged on VERIFIED experience (owner-directed 2026-07-20) against the
  // REGISTERED need (gateNeed) — matching the sign-off gate exactly — the
  // condition only reads "met"/ready-to-sign-off once the required deals are
  // VERIFIED, never on entered-but-unverified deals. `enteredMet` is kept for the
  // desk so the UI can say "entered enough, X still to verify".
  const enteredMet = requiredAny && requirementMet(counts, gateNeed);
  const met = requiredAny && requirementMet(verifiedCounts, gateNeed);
  const satisfied = notApplicable || met;
  const payload = {
    // `required` stays the application CLAIM (what the file says); `gateNeed` is
    // what must actually be VERIFIED to sign off (the registered product's
    // experience). The desk shows the shortfall against gateNeed.
    autoExperienceTask: true, notApplicable, required, gateNeed, counts, verifiedCounts, satisfied,
    enteredMet, verifiedMet: met,
    // Explanation only — see the note by needFrom. Never feeds met/required.
    needFrom, claimBelowNeed, registeredAt, reRegisterBlockedBy,
    perBorrower,
    checkedAt: new Date().toISOString(),
  };

  const ir = await client.query(
    `SELECT id, status, tool_payload, signed_off_at
       FROM checklist_items
      WHERE application_id=$1 AND tool_key='track_record'
      ORDER BY created_at LIMIT 1`,
    [appId]);
  const item = ir.rows[0];
  if (!item) return { required, counts, satisfied, itemId: null };

  // A truthy signed_off_at is always a GENUINE human sign-off — the not-
  // applicable auto-satisfy below uses status='satisfied' with a NULL stamp, so
  // it never impersonates one.
  if (item.signed_off_at) {
    // Keep the sign-off in place UNLESS VERIFIED experience now falls short of the
    // REGISTERED need (gateNeed) — e.g. a track-record line was un-verified/removed,
    // or Products & Pricing re-registered on MORE experience than is verified. This
    // uses the SAME threshold as the sign-off gate, so a condition the gate would
    // still accept never reopens (no reopen/re-sign loop); otherwise reopen for
    // re-verification. When it holds, just refresh the counts.
    if (requiredAny && !met) {
      await client.query(
        `UPDATE checklist_items
            SET status='outstanding', tool_payload=$2, signed_off_at=NULL, signed_off_by=NULL, updated_at=now()
          WHERE id=$1`,
        [item.id, JSON.stringify(payload)]);
      return { required, counts, satisfied: false, itemId: item.id, reopened: true };
    }
    await client.query(`UPDATE checklist_items SET tool_payload=$2, updated_at=now() WHERE id=$1`, [item.id, JSON.stringify(payload)]);
    return { required, counts, satisfied: true, itemId: item.id };
  }

  // The experience condition is ALWAYS a visible slot (#97) — a reminder that
  // never silently disappears. When NO experience is claimed on the file it stays
  // 'outstanding' but is NOT required: the team can sign it off freely (nothing
  // to verify for the current structure) or leave it open. When experience IS
  // claimed it's required — 'received' once met (awaiting sign-off), else
  // 'outstanding' — and the sign-off gate enforces verification.
  const status = met ? 'received' : 'outstanding';
  const isRequired = !notApplicable;
  await client.query(
    `UPDATE checklist_items SET status=$3, is_required=$4, tool_payload=$2, updated_at=now() WHERE id=$1`,
    [item.id, JSON.stringify(payload), status, isRequired]);
  return { required, counts, satisfied, itemId: item.id };
}

// #103 — one-shot boot backfill: recompute the experience condition for every
// co-borrower file so its payload carries the per-borrower breakdown (and each
// borrower's own track-record link) without waiting for the next experience-
// affecting action. Safe to re-run — the sync preserves genuine sign-offs and a
// pure recompute never changes the summed requirement, so nothing reopens.
async function backfillCoBorrowerExperience(client = db) {
  const r = await client.query(
    `SELECT id FROM applications WHERE co_borrower_id IS NOT NULL AND deleted_at IS NULL`);
  let n = 0;
  for (const row of r.rows) {
    try { await syncExperienceChecklistForApplication(row.id, client); n++; } catch (_) { /* best-effort */ }
  }
  return n;
}

async function syncExperienceChecklistForBorrower(borrowerId, client = db) {
  const apps = await client.query(
    `SELECT id FROM applications
      WHERE borrower_id=$1 OR co_borrower_id=$1`,
    [borrowerId]);
  const out = [];
  /* PER-FILE, so one file's failure cannot abort its siblings. This loop used
     to be a bare await: the first application that threw skipped every one
     after it, and the caller's advisory catch hid that anything was missed —
     a revoke reported success while a second file's condition was never
     recomputed (audit 2026-08-09 #2). A failed file is retried by the next
     recompute; a SKIPPED one was retried by nothing. */
  for (const row of apps.rows) {
    try { out.push(await syncExperienceChecklistForApplication(row.id, client)); }
    catch (e) {
      console.error('[experience] condition recompute failed for application', row.id, (e && e.message) || e);
      out.push(null);
    }
  }
  return out;
}

module.exports = {
  bucketOf,
  countBorrowerExperience,
  countBorrowersExperience,
  backfillCoBorrowerExperience,
  fileBorrowerIds,
  requestedFromApp,
  hasRequirement,
  requirementMet,
  registeredExperienceNeed,
  syncExperienceChecklistForApplication,
  syncExperienceChecklistForBorrower,
  RECENT_EXIT_SQL,
  EXIT_DATE_SQL,
  EXIT_WINDOW_MONTHS,
  exitDateOf,
  exitCounts,
  isGroundUp,
  /* EXIT_DATE_BASE_SQL is the PRE-AMENDMENT rule. It is exported for exactly one
     reason: the equivalence test runs it beside EXIT_DATE_SQL on real rows and
     asserts the new one never disagrees except where the old was NULL. Nothing
     else may use it — it is the old rule, not a second definition. */
  EXIT_DATE_BASE_SQL,
  _internals: { ymd, minusMonths },
};
