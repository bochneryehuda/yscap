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

    const ar = await c.query(`SELECT * FROM applications WHERE id=$1`, [appId]);
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

    // The SAME vesting refusal the borrower and staff doors apply — asked through
    // the shared module so this door can never be the lenient one.
    const vestRefusal = require('./vesting-program-rule').registrationRefusal(app, program);
    if (vestRefusal) return { registered: false, reason: 'vesting_refused' };

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
