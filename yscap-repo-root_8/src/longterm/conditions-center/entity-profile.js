'use strict';
/**
 * LONG-TERM — PUTTING THE VESTING COMPANY ON THE BORROWER'S PROFILE.
 *
 * The other half of `entity-prefill.js`. That module READS what the borrower
 * already holds for this company; this one is how a company that is NOT on the
 * profile yet gets there, so the documents a long-term file collects are filed
 * where every future loan — long-term or short-term — will already find them.
 *
 * ── WHY THIS EXISTS: THE SCREEN WAS PROMISING IT ────────────────────────────
 *
 * `LtConditionAnswer.jsx` has told people, on every long-term file whose vesting
 * company is not on the profile: *"What is uploaded here will be saved to it,
 * and verified once — so the next loan for the same company starts already
 * done."* Nothing did that. The read side was shared and correct and there was
 * no write side at all, so an operating agreement collected on a long-term file
 * stayed on that file's condition, the next loan for the same company asked for
 * it again, and the short-term side never saw it. A screen that promises
 * something the code does not do is worse than a screen that promises nothing.
 *
 * ── THE OWNER AUTHORIZED THE WRITE, IN WRITING ──────────────────────────────
 *
 * `docs/LONG-TERM-AUTHORIZED-COPIES.md`, on `import src/lib/llc.js`: *"verified
 * to his profile in future when you use this LLC it's already verified"*, and
 * the scope line — *"Long-Term reads and writes the entity through THIS module
 * and never with raw SQL of its own, so every rule above applies to both
 * products by construction."* That is exactly the shape here: every statement
 * below goes through `src/lib/llc.js`, and this file contains no SQL against an
 * entity table of its own.
 *
 * ── NOTHING IS COPIED, AND THAT IS THE DESIGN ───────────────────────────────
 *
 * The obvious build is to let the condition take an upload and then COPY the
 * bytes onto the profile. That is what the short-term `entity-adopt.js` does,
 * and it has to: there the documents arrive on a loan file with no statement of
 * which slot they belong to, so it reads the AI's extractions to work it out.
 *
 * Long-Term needs none of that, because the SHARED upload door already files an
 * entity document straight onto the company — `src/lib/condition-docs/upload.js`
 * takes an `llcId`, scopes the checklist item to it, and leaves BOTH file-owner
 * columns null ("the SAME statement files an RTL document and a Long-Term one").
 * So the long-term screen offers the company's OWN slots and the upload lands on
 * the profile the first time. One document, one place, both products read it.
 *
 * That removes a whole class rather than implementing it well: there is no
 * second copy to drift, nothing to re-copy when a document is replaced, no
 * question of which copy a reviewer accepted, and no guess about which slot a
 * document belongs in — the person said which slot by choosing it.
 *
 * ── WHAT THIS WILL NOT DO ───────────────────────────────────────────────────
 *
 * · It never decides that a loan vests in a company. That is `vesting.js`'s
 *   answer to Encompass field 4008 and this module only ever consumes it — an
 *   INDIVIDUAL vesting is refused outright, because putting a company on a
 *   person's permanent record off a stale field 1859 is precisely the trap the
 *   owner's "individual means individual" rule closes.
 * · It never marks an entity verified. Verification is a person having READ the
 *   operating agreement and confirmed the borrower controls the company.
 * · It is never automatic. Putting a company on a person's permanent record is a
 *   decision, so it is a button — the same posture the short-term side takes.
 *
 * NEVER THROWS for a reason a person can act on; every refusal comes back as a
 * `{ ok: false, status, error }` in plain words.
 */

const db = require('../db');
const llc = require('../../lib/llc');
const vestingView = require('../vesting-view');

/** The stamp recorded on an entity THIS path created (db/400). */
const ADOPTED_SOURCE = 'lt_vesting_entity';

/**
 * The loan's own vesting facts, read from the long-term columns only.
 * Returns null when the loan cannot be read — never a guess.
 */
async function loanVesting(loanId, client) {
  const { rows } = await client.query(
    `SELECT id, borrower_id, vesting_type, vesting_entity_name
       FROM lt_loans WHERE id = $1::uuid`,
    [String(loanId)],
  );
  return rows[0] || null;
}

/**
 * PUT THE VESTING COMPANY ON THE BORROWER'S PROFILE.
 *
 * Create-or-REUSE through `llc.findOrCreateLlc` — the repo's one entity create
 * chokepoint, so a company the borrower already has is reused with its documents
 * and its verification, never duplicated — then its document slots through
 * `llc.generateLlcChecklist`, which is idempotent per (entity, template).
 *
 * @returns {Promise<{ok:true, llcId, existed, entityName, slots:Array}|{ok:false,status,error}>}
 */
async function putOnProfile(loanId, opts = {}) {
  // The LONG-TERM pool, like every other module here — a caller inside a
  // transaction passes its own connection so the shared helpers see its
  // uncommitted writes, which is exactly why they all take a trailing client.
  const client = opts.db || db;
  const actorId = opts.actorId || null;

  let loan = null;
  try {
    loan = await loanVesting(loanId, client);
  } catch (_) {
    return { ok: false, status: 503, error: 'PILOT could not read this loan just now. Try again in a moment.' };
  }
  if (!loan) return { ok: false, status: 404, error: 'That loan was not found.' };

  // THE PERSON RECORD IS WHAT AN ENTITY HANGS OFF (`llcs.borrower_id` is NOT
  // NULL), so a loan whose borrower nobody has confirmed has nowhere to put the
  // company. Said plainly rather than half-done.
  if (!loan.borrower_id) {
    return {
      ok: false,
      status: 409,
      error: 'This loan is not linked to a borrower profile yet, so there is nowhere to save the company. Link the borrower first.',
    };
  }

  /* HOW IT VESTS IS THE ONE ANSWER `vesting-view.js` GIVES.
     `vestingOf` is called with NO PARTY ROWS deliberately. Its display ladder
     falls back to an entity party's legal name when field 4008 named none —
     right for a screen, wrong here: a party row can be a company that guarantees
     the loan while title vests elsewhere, and this writes to a person's
     PERMANENT record. So the name has to be the one Encompass gave for the
     vesting itself (field 1859) or nothing at all.
     `type === null` is its own refusal: "Encompass has not said" is not
     "individual", and it is not an entity either — nothing is claimed. */
  const vest = vestingView.vestingOf(loan, []);
  const entityName = String(vest.entityName || '').trim();
  /* REDUNDANT FOR THE REFUSAL, LOAD-BEARING FOR THE WORDING — the same honest
     note as the individual guard below. A loan PILOT has not read carries no
     vesting type, so `vestingOf` names no company and the name check would
     refuse it anyway. What this adds is the truth about WHY: saying "no vesting
     company name recorded" here would assert that an entity takes title and only
     its name is missing, which is a fact nobody has. */
  if (vest.type === null) {
    return {
      ok: false,
      status: 409,
      error: 'PILOT has not read how this loan vests yet, so it cannot tell whether there is a company to save.',
    };
  }
  /* REDUNDANT FOR THE REFUSAL, LOAD-BEARING FOR THE WORDING — stated rather
     than implied. `vestingOf` returns no entity name at all on an individual
     vesting (it never consults field 1859, which is the owner's rule), so the
     name check below would refuse this loan anyway. What this guard adds is the
     REASON: "it vests in the borrower personally" is something a person can act
     on, where "no company name recorded yet" would send them looking for a name
     that must never be used on this loan. It is also what keeps the refusal
     correct if that display rule ever changes. */
  if (vest.type === 'individual') {
    return {
      ok: false,
      status: 409,
      error: 'This loan vests in the borrower personally, so there is no company to save.',
    };
  }
  /* NO NAME IS A REFUSAL, and it also happens to be the guard that catches an
     UNRECOGNISED vesting word. The two vesting modules read such a word
     differently on purpose — the write-time rule (`vesting.js`) draws no entity
     conclusion from it and therefore stores NO name, while this display-time
     rule buckets anything that is not "individual" as an entity. Measured
     against the live book that divergence cannot reach here: a loan whose 4008
     is a word nobody recognises has `vesting_entity_name` NULL by that storage
     rule, so it refuses on the name rather than putting a company on a person's
     record off a word PILOT does not understand. */
  if (!entityName) {
    return {
      ok: false,
      status: 409,
      error: 'This loan has no vesting company name recorded yet, so there is nothing to save. It comes from Encompass once somebody enters it.',
    };
  }

  let made = null;
  try {
    made = await llc.findOrCreateLlc(loan.borrower_id, { llcName: entityName }, client);
  } catch (_) {
    return { ok: false, status: 503, error: 'PILOT could not save the company to the profile just now. Try again in a moment.' };
  }

  // THE SLOTS. Without them the company sits on the profile with nothing that
  // can ever be filed against it, which is why the create and the slots are one
  // action rather than two. Idempotent, so a company the borrower already had
  // keeps exactly the slots it had.
  try {
    await llc.generateLlcChecklist(made.id, client);
  } catch (_) { /* best-effort — the entity exists either way, and the slots retry */ }

  // THE PROVENANCE STAMP, only on an entity this action CREATED (db/400). An
  // entity the borrower already had is theirs and is left unstamped — stamping
  // it would wrongly hold its bank balances out of the short-term liquidity
  // reading. On one we just created the stamp is correct AND it is the safe
  // direction: the hold releases itself the moment a document lands or a person
  // verifies the company.
  if (!made.existed) {
    try {
      await client.query(
        `UPDATE llcs
            SET adopted_at = now(), adopted_source = $2, updated_at = now()
          WHERE id = $1::uuid AND adopted_at IS NULL`,
        [made.id, ADOPTED_SOURCE],
      );
    } catch (_) { /* the stamp is a record, never a gate */ }
  }

  /* DELIBERATELY NOT DONE HERE: the many-to-many `llc_borrowers` link the
     short-term co-borrower work added. `findOrCreateLlc` has already set
     `llcs.borrower_id`, which IS the ownership link every reader uses; the
     many-to-many row is a short-term co-borrower feature Long-Term has no
     equivalent of yet. Reaching for it would add a second authorized crossing
     for something nothing here needs — and authorization is per item, never for
     convenience. If a long-term co-borrower ever needs it, that is one line and
     one ledger entry, decided then. */

  let slots = [];
  try {
    slots = await llc.getSlots(made.id, client);
  } catch (_) { slots = []; }

  return {
    ok: true,
    llcId: String(made.id),
    existed: !!made.existed,
    entityName,
    actorId,
    vesting: vest || null,
    slots: slots.map((s) => ({
      itemId: String(s.item_id),
      code: String(s.code || ''),
      label: s.label || null,
      filled: !!(s.document_id && s.review_status === 'accepted'),
    })),
  };
}

/**
 * AFTER THE COMMIT — the entity's own conditions, through the shared module.
 * Best-effort by design: it may never reverse a company a person just put on a
 * profile.
 *
 * THE SHAREPOINT MIRROR IS NOT KICKED HERE, and that is a decision rather than
 * an omission. The mirror runs its own drain and files a long-term document
 * already (the one-mirror grant in the crossing ledger), so a kick would only
 * make it prompt — and it would cost a SECOND authorized crossing for a module
 * this feature does not otherwise need. The whole of this build reaches RTL
 * through `src/lib/llc.js` and nothing else, which is exactly what the ledger's
 * scope line for that import describes.
 */
async function afterPutOnProfile(llcId) {
  try { await llc.syncLlcConditions(llcId); } catch (_) { /* best-effort */ }
}

module.exports = { putOnProfile, afterPutOnProfile, ADOPTED_SOURCE, _internals: { loanVesting } };
