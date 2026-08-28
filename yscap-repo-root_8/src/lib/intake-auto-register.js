'use strict';

/**
 * A PUBLIC APPLICATION REGISTERS THE PRODUCT IT WAS BUILT ON (owner-directed
 * 2026-08-06).
 *
 * The owner: *"When somebody finishes generating a term sheet on the marketing
 * site, he should have a 'Start Application' button. If he starts an
 * application, he should fill out everything … The point is, it should come with
 * all the registered details when he started the application. It should feed
 * automatically into the products and pricing that he'd chosen."* Asked directly
 * whether the public door should register by itself, given nobody is signed in
 * behind it: *"Register it automatically too."*
 *
 * WHAT THIS IS NOT. It computes no price. It reuses `pricing.buildInputs` +
 * `pricing.quoteProgram` (the frozen engines) and `persistProductRegistration` —
 * the same pair every other register door goes through — so the numbers on the
 * file are the engine's, identical to what the applicant was shown, and the note
 * buyer is derived by the same rule as everywhere else.
 *
 * THE REFUSALS ARE THE FEATURE. This runs with NO HUMAN BEHIND IT, on a door
 * anyone on the internet can post to, so it registers ONLY the plain case and
 * declines everything else — leaving exactly today's outcome, an unregistered
 * file for the team to price:
 *
 *   · only the three self-registerable programs (standard / gold / silver).
 *     MANUAL is approval-bearing and is never carried here in the first place;
 *     it is refused again anyway, because a public body is not to be trusted.
 *   · only an ELIGIBLE quote. A MANUAL / INELIGIBLE / ERROR status means the
 *     scenario needs a human — a super-admin exception, a guideline call — and
 *     an exception must never be raised by an anonymous form post.
 *   · the vesting rule and the missing-as-is refusal are asked EXACTLY as the
 *     two interactive doors ask them, through the same shared modules, so this
 *     door cannot become the lenient one.
 *   · it never registers onto a file that already has a registration.
 *
 * NEVER THROWS, NEVER BLOCKS. A lead is worth incomparably more than an
 * automatic registration: every failure path returns a reason and leaves the
 * application exactly as intake created it. The caller ignores the result.
 */

const PROGRAMS = new Set(['standard', 'gold', 'silver']);

/**
 * Is this a program a public form may register on its own?
 * PURE — `manual`, junk, and anything absent are all refused.
 */
function publicProgram(raw) {
  const p = String(raw || '').trim().toLowerCase();
  return PROGRAMS.has(p) ? p : null;
}

/**
 * Register the elected product on a freshly-created public application.
 *
 * @param {string} appId
 * @param {string} rawProgram   the `pricingProgram` the marketing form carried
 * @param {object} client       an open pg client/pool (the caller's)
 * @returns {Promise<{registered:boolean, program?:string, reason?:string}>}
 */
async function autoRegisterFromIntake(appId, rawProgram, client) {
  const program = publicProgram(rawProgram);
  if (!appId) return { registered: false, reason: 'no_application' };
  if (!program) return { registered: false, reason: 'no_public_program' };
  try {
    const db = require('../db');
    const c = client || db;
    const pricing = require('./pricing');
    if (!pricing.enginesReady()) return { registered: false, reason: 'engines_unavailable' };

    // Never a second registration. A public post arriving twice (a retry, a
    // double submit) must not mint a competing product on the same file.
    const existing = await c.query(
      `SELECT 1 FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    if (existing.rows[0]) return { registered: false, reason: 'already_registered' };

    /* THE FICO MUST BE JOINED IN — IT IS NOT A COLUMN ON `applications`.
       A bare `SELECT * FROM applications` leaves `app.fico` undefined, `buildInputs`
       resolves it to 0, and EVERY engine guards its FICO floor with `fico > 0` — so a
       zero score does not fail the floor, it SKIPS it. On this door, which is public
       and unauthenticated, that meant anyone could cause a file to be born carrying a
       fully-sized, ELIGIBLE, approval-free registration on a program the borrower is
       flatly ineligible for (Gold priced 7.75% at a 600 score against a 660 floor),
       with the note buyer stamped and the loan amount written back onto the file.
       It was also wrong on every auto-registered file, eligible or not: the rate never
       matched what the applicant was shown or what any other door re-quotes.
       This is the SAME query both interactive loaders use (`staff.js`,
       `borrower.js`) — the highest score across the file's borrowers, NULL when
       neither has one — so all three doors price on one definition. Never load a row
       for pricing without it. */
    const ar = await c.query(
      `SELECT a.*, NULLIF(GREATEST(COALESCE(b.fico,0), COALESCE(cb.fico,0)), 0) AS fico
         FROM applications a
         JOIN borrowers b ON b.id = a.borrower_id
         LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
        WHERE a.id = $1`, [appId]);
    const app = ar.rows[0];
    if (!app) return { registered: false, reason: 'no_application' };

    // The file's experience OF RECORD — the same basis the interactive doors
    // price on. A public applicant's claim is already on the row (intake stored
    // requested_exp_*), and no override is accepted here: the whole point of this
    // door is that it registers the file as it stands, nothing more.
    const exp = {
      flips: Number(app.requested_exp_flips) || 0,
      holds: Number(app.requested_exp_holds) || 0,
      ground: Number(app.requested_exp_ground) || 0,
    };
    const inputs = pricing.buildInputs(app, exp, {});
    if (inputs.asIsMissing) return { registered: false, reason: 'as_is_missing' };

    /* NO SCORE ⇒ NO AUTOMATIC REGISTRATION. Every engine guards its FICO floor with
       `fico > 0`, so an absent score is PROVISIONAL pricing (the engines quote at
       700+ pending a real one) rather than a failed floor. That is exactly right for
       an interactive what-if, where a human is watching and will pull credit — and
       exactly wrong here, where nobody is: it would register an ELIGIBLE,
       approval-free product whose floors were never actually tested. Refusing leaves
       the file unregistered for a human to price, which is this door's own stated
       posture: it must never be the lenient one. */
    if (!(Number(inputs.fico) > 0)) return { registered: false, reason: 'no_fico' };

    // The SAME vesting refusal the borrower and staff doors apply — asked through
    // the shared module so this door can never be the lenient one.
    const vestRefusal = require('./vesting-program-rule').registrationRefusal(app, program);
    if (vestRefusal) return { registered: false, reason: 'vesting_refused' };

    // A DISCONTINUED PROGRAM DOES NOT AUTO-REGISTER (owner-directed 2026-08-18) —
    // the same gate every interactive door applies. An anonymous public post can
    // never carry a per-deal exception, so the file simply lands unregistered
    // for a human to price (this door's own posture: never the lenient one).
    {
      const pset = require('./pricing-settings');
      const settings = await pset.load().catch(() => pset.current());
      if (require('./program-availability').registrationRefusal(program, app, settings)) {
        return { registered: false, reason: 'program_discontinued' };
      }
    }

    const quote = pricing.quoteProgram(program, inputs);
    if (!quote || quote.status !== 'ELIGIBLE') {
      // MANUAL / INELIGIBLE / ERROR all mean a human decides. Never an automatic
      // exception from an anonymous post.
      return { registered: false, reason: `quote_${(quote && quote.status) || 'unavailable'}`.toLowerCase() };
    }
    // The sized loan lives on `quote.sizing.totalLoan` — the SAME field
    // persistProductRegistration reads as the registered total. Read it from
    // there rather than from a flattened alias, so "is there a loan?" and "what
    // is recorded?" can never be answered from two different places.
    if (!(Number((quote.sizing || {}).totalLoan) > 0)) return { registered: false, reason: 'no_loan' };

    // A figure the file cannot RECORD is a refusal, not a 500 — asked before the
    // write, exactly as the staff door asks it.
    const storeProblem = require('./product-registration').quoteStorageProblem(quote, inputs);
    if (storeProblem) return { registered: false, reason: 'quote_not_storable' };

    await require('./product-registration').persistProductRegistration(c, {
      appId, program, inputs, quote,
      registeredByStaffId: null,      // nobody is signed in — that is recorded honestly
      isManual: false,
      needsApproval: false,           // an ELIGIBLE, default-priced scenario needs none
    });
    /* THE SIDE EFFECTS OF REGISTERING, which every other register door runs and this one did not
       (found by the fee audit engine, 2026-08-26). `routes/intake.js` builds the file's conditions
       at `ensureFileConditions` and only THEN calls this — so a registration here lands after the
       conditions were decided, and nothing told them about it:

         · THE LIQUIDITY CONDITION kept its generic pre-registration wording and recorded no
           required-liquidity figure at all, on every file the public form has ever
           self-registered. That is the owner's *"the liquidity condition updates"* — it does on
           four doors and did not on the fifth.
         · THE NOTE BUYER is stamped BY the registration (`noteBuyerForProgram`), and it is a rule
           field: the EMD, Social-Security-verification and flood conditions are keyed on it. Rules
           evaluated before the stamp cannot have seen it.

       BEST-EFFORT, EACH IN ITS OWN CATCH, exactly as the borrower and staff doors run them — this
       file's own contract is NEVER THROWS, NEVER BLOCKS, and a lead is worth incomparably more
       than a condition refresh. `enforceSowContingency` is deliberately NOT here: a file created
       by the public form has no Scope of Work to measure, so there is nothing yet to enforce, and
       reopening a rehab-budget condition from an anonymous door is its own decision to make. */
    try { await require('./conditions/engine').evaluateApplication(appId, { reason: 'product_registered' }); } catch (_) { /* advisory */ }
    try { await require('./liquidity').syncLiquidityCondition(appId, quote); } catch (_) { /* advisory */ }
    return { registered: true, program };
  } catch (e) {
    try {
      const db = require('../db');
      console.warn('[intake] auto-register skipped:', db.describeError ? db.describeError(e) : e.message);
    } catch (_) { /* logging must not throw either */ }
    return { registered: false, reason: 'error' };
  }
}

module.exports = { autoRegisterFromIntake, publicProgram, PROGRAMS };
