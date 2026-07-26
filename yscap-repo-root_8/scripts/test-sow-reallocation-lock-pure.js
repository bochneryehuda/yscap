/**
 * SCOPE-OF-WORK RE-ALLOCATION EXCLUSION (owner-directed 2026-07-26).
 *
 * The term-sheet-sent freeze exists so a SENT term sheet can never silently
 * disagree with the file. A Scope of Work save that leaves the CONSTRUCTION
 * BUDGET AMOUNT exactly where it is — money moves between line items, the total
 * doesn't budge — cannot create that disagreement, so it is allowed. A save that
 * MOVES the total is still frozen, and Clear-to-Close / Funded stays frozen
 * either way (past CTC the scope has gone to the investor).
 *
 * PURE — the whole matrix runs against a fake pg client, so it needs no DATABASE_URL.
 * It proves the exclusion is keyed on the DATA (and therefore applies identically
 * to staff and borrower saves) and that every "can't prove it" path fails CLOSED.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused/unused';

const lock = require('../src/lib/file-lock');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/**
 * A fake pg client serving every query file-lock + rehab-budget make:
 *   · the applications row (status / structural unlock / term-sheet-sent)
 *   · the current product registration (the authoritative rehab budget)
 *   · applications.rehab_budget (the fallback budget)
 * `throwOn` makes a named query blow up, to prove the fail-closed paths.
 */
function fakeClient({ status = 'processing', unlocked = null, tsSent = false,
                      regBudget = null, regStale = false, appBudget = null, throwOn = null } = {}) {
  return {
    async query(sql) {
      const s = String(sql);
      if (/FROM applications a WHERE a\.id/.test(s)) {
        if (throwOn === 'lock') throw new Error('boom');
        return { rows: [{ status, structural_unlocked_at: unlocked, ts_sent: tsSent }] };
      }
      if (/FROM product_registrations/.test(s)) {
        if (throwOn === 'budget') throw new Error('boom');
        return { rows: regBudget == null ? [] : [{ inputs: { rehabBudget: regBudget }, stale: regStale }] };
      }
      if (/rehab_budget FROM applications/.test(s)) {
        if (throwOn === 'budget') throw new Error('boom');
        return { rows: [{ rehab_budget: appBudget }] };
      }
      return { rows: [] };
    },
  };
}

const STAFF = { actor: { kind: 'staff', role: 'admin' } };
const SUPER = { actor: { kind: 'staff', role: 'super_admin' } };
const BORROWER = {};                       // the borrower paths pass no actor
const sow = (total, target) => ({ total, ...(target === undefined ? {} : { state: { target } }) });

(async () => {
  // ---------------------------------------------------------------- nothing frozen
  {
    const c = fakeClient({ status: 'processing', appBudget: 126000 });
    assert(await lock.sowLockReason('a', sow(126000), c, STAFF) === null, 'unfrozen file → SOW save allowed');
    assert(await lock.sowLockReason('a', sow(999999), c, STAFF) === null,
      'unfrozen file → even a MISMATCHED total saves (the SOW is always a draft; matching is a condition gate, not a lock)');
  }

  // ------------------------------------------------- THE EXCLUSION: term sheet sent
  {
    const c = fakeClient({ status: 'processing', tsSent: true, appBudget: 126000 });

    assert(await lock.sowLockReason('a', sow(126000), c, STAFF) === null,
      'term sheet SENT + total unchanged → staff reallocation ALLOWED (the owner’s case)');
    assert(await lock.sowLockReason('a', sow(126000), c, BORROWER) === null,
      'term sheet SENT + total unchanged → BORROWER reallocation allowed too (the test is on the data, not the actor)');
    assert(await lock.sowLockReason('a', sow('$126,000.00', '126000'), c, STAFF) === null,
      'formatted money ("$126,000.00") parses the same as the raw number — no false freeze');
    assert(await lock.sowLockReason('a', sow(126000, 126000), c, STAFF) === null,
      'first-page construction budget also equal → still allowed');

    // ...and everything that ISN'T budget-neutral stays frozen.
    const moved = await lock.sowLockReason('a', sow(126100), c, STAFF);
    assert(!!moved && /frozen/i.test(moved), 'term sheet SENT + total MOVED → still frozen');
    assert(/move money BETWEEN Scope of Work line items/i.test(moved),
      'the refusal TELLS staff a same-total reallocation is the thing that is allowed');
    assert(/\$126,100\.00/.test(moved) && /\$126,000\.00/.test(moved),
      'the refusal quotes both cent-precise figures, so the gap is visible');

    const centOff = await lock.sowLockReason('a', sow(125999.99), c, STAFF);
    assert(!!centOff && /\$0\.01 lower/.test(centOff), 'a ONE-CENT gap is refused and the message names it (never rounded away)');

    const tgtOff = await lock.sowLockReason('a', sow(126000, 120000), c, STAFF);
    assert(!!tgtOff && /frozen/i.test(tgtOff), 'line items match but the FIRST-PAGE construction budget does not → still frozen');

    const noTotal = await lock.sowLockReason('a', {}, c, STAFF);
    assert(!!noTotal && /frozen/i.test(noTotal), 'an empty draft carries no total → can’t be proven neutral → frozen');

    const bor = await lock.sowLockReason('a', sow(126100), c, BORROWER);
    assert(!!bor && /loan officer/i.test(bor) && !/Clear the Term Sheet package/i.test(bor),
      'a borrower gets the loan-officer copy, never "clear the package" (they can’t clear one)');
  }

  // A file with NO budget on record: a SOW save would be SETTING the number, which
  // is not a reallocation — the term-sheet freeze still applies.
  {
    const c = fakeClient({ status: 'processing', tsSent: true, appBudget: null });
    const r = await lock.sowLockReason('a', sow(126000), c, STAFF);
    assert(!!r && /no construction budget on record/i.test(r),
      'no budget on record → the save would SET the budget, not preserve it → frozen, and says so');
  }

  // A STALE registration is ignored in favor of the file's current budget (the #30
  // rule inside requiredRehabBudget) — the exclusion inherits that automatically.
  {
    const c = fakeClient({ status: 'processing', tsSent: true, regBudget: 100000, regStale: true, appBudget: 126000 });
    assert(await lock.sowLockReason('a', sow(126000), c, STAFF) === null,
      'a STALE registration is ignored — neutrality is judged against the file’s CURRENT budget');
  }
  {
    const c = fakeClient({ status: 'processing', tsSent: true, regBudget: 100000, appBudget: 126000 });
    assert(await lock.sowLockReason('a', sow(100000), c, STAFF) === null,
      'a LIVE registration is the authoritative budget (matches requiredRehabBudget’s own precedence)');
  }

  // ------------------------------------------------------- past CTC: still frozen
  for (const status of ['clear_to_close', 'funded']) {
    const c = fakeClient({ status, appBudget: 126000 });
    const r = await lock.sowLockReason('a', sow(126000), c, STAFF);
    assert(!!r, `${status} + total unchanged → STILL frozen (the scope has gone to the investor)`);
    assert(/change request/i.test(r) && /capital-partner approval/i.test(r),
      `${status} → the message points staff at the Scope of Work change request / capital-partner approval`);
    assert(/right up until Clear to Close/i.test(r),
      `${status} → the message states where the same-total allowance ends`);

    const b = await lock.sowLockReason('a', sow(126000), c, BORROWER);
    assert(!!b && /loan officer/i.test(b) && !/capital-partner/i.test(b),
      `${status} → the borrower gets loan-officer copy, with no internal capital-partner wording`);
  }

  // A super-admin who has UNLOCKED the file is still honored, exactly as before.
  {
    const c = fakeClient({ status: 'funded', unlocked: new Date(), appBudget: 126000 });
    assert(await lock.sowLockReason('a', sow(126000), c, SUPER) === null,
      'a super-admin structural unlock still opens a funded file (unchanged behavior)');
    assert(!!(await lock.sowLockReason('a', sow(126000), c, STAFF)),
      'the unlock is super-admin-only — a plain admin is still frozen');
  }

  // Declined / withdrawn get the plain status message — there is nothing to reallocate.
  for (const status of ['declined', 'withdrawn']) {
    const c = fakeClient({ status, appBudget: 126000 });
    const r = await lock.sowLockReason('a', sow(126000), c, STAFF);
    assert(!!r && !/change request/i.test(r), `${status} → plain status refusal, no reallocation workflow offered`);
  }

  // -------------------------------------------------------------- fails CLOSED
  {
    const c = fakeClient({ status: 'processing', tsSent: true, appBudget: 126000, throwOn: 'budget' });
    const r = await lock.sowLockReason('a', sow(126000), c, STAFF);
    assert(!!r, 'the budget read blowing up can never GRANT a reallocation — it fails closed (frozen)');
    const n = await lock.sowBudgetNeutral('a', sow(126000), c);
    assert(n.neutral === false, 'sowBudgetNeutral fails closed on a read error');
  }
  {
    // Parity with structuralLockReason: an unreadable FILE row doesn't hard-block.
    const c = fakeClient({ throwOn: 'lock' });
    assert(await lock.sowLockReason('a', sow(1), c, STAFF) === null, 'an unreadable file row does not hard-block (parity with structuralLockReason)');
    assert(await lock.structuralLockReason('a', c, STAFF) === null, 'structuralLockReason keeps that same behavior');
  }

  // ------------------------------------------- structuralLockReason is UNCHANGED
  // Every other economics write path still calls it; the refactor must be a no-op there.
  {
    assert(await lock.structuralLockReason('a', fakeClient({ status: 'processing' }), STAFF) === null,
      'structuralLockReason: unfrozen → null');
    const ctc = await lock.structuralLockReason('a', fakeClient({ status: 'clear_to_close' }), STAFF);
    assert(/its loan structure is locked/.test(ctc), 'structuralLockReason: CTC message unchanged');
    const ts = await lock.structuralLockReason('a', fakeClient({ status: 'processing', tsSent: true }), STAFF);
    assert(/Clear the Term Sheet package first/.test(ts), 'structuralLockReason: term-sheet message unchanged');
    const tsB = await lock.structuralLockReason('a', fakeClient({ status: 'processing', tsSent: true }), BORROWER);
    assert(/Contact your loan officer/.test(tsB), 'structuralLockReason: borrower term-sheet message unchanged');
    assert(await lock.structuralLockReason('a', fakeClient({ status: 'funded', unlocked: new Date() }), SUPER) === null,
      'structuralLockReason: super-admin unlock still honored');
    // The term-sheet freeze is NEVER bypassed by an unlock — the load-bearing rule.
    const both = await lock.structuralLockReason('a', fakeClient({ status: 'funded', unlocked: new Date(), tsSent: true }), SUPER);
    assert(!!both && /Clear the Term Sheet package/.test(both),
      'structuralLockReason: a super-admin unlock does NOT bypass the term-sheet freeze');
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll Scope-of-Work reallocation lock checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
