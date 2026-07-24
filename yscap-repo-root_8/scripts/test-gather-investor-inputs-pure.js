'use strict';
/*
 * #232 — gatherInvestorInputs: the per-condition data-source wiring that feeds the
 * investor-guideline review the signals the canonical context can't hold. This locks
 * in the NEVER-FABRICATE discipline: a signal the file can't prove is OMITTED (so its
 * rule stays silent), and a DB error on one read never throws and never invents.
 */
const assert = require('assert');
const { gatherInvestorInputs } = require('../src/lib/underwriting/run');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ok  ' + name); passed++; }

// A tiny mock db.query that routes by which table/columns the SQL hits. The flood
// read and the appraisal-present read both hit `appraisals`, so route the flood one
// FIRST by its distinctive fema_flood_sfha column. `flood` is the row that query returns
// ([] = no appraisal row → in_flood_zone stays unknown/omitted).
// `expApp` = the applications row the experience read returns ([]=no row → omit). `trackAgg`
// = the rows the reused countBorrowersExperience GROUP BY returns ([{deal_type,n}]) → verified count.
function mkDb({ fico, apprPresent, flood, expApp, trackAgg, staleExit, throwOn } = {}) {
  return {
    query: async (sql) => {
      if (throwOn && sql.includes(throwOn)) throw new Error('boom');
      if (sql.includes('fema_flood_sfha')) {
        return { rows: flood === undefined ? [] : [flood] };
      }
      if (sql.includes('credit_reports')) {
        return { rows: fico == null ? [] : [{ middle_score: fico }] };
      }
      if (sql.includes('requested_exp_flips')) {   // the applications experience read
        return { rows: expApp === undefined ? [] : [expApp] };
      }
      if (sql.includes('isg_stale_exit')) {        // the stale-exit probe (marked query)
        return { rows: staleExit ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('track_records')) {         // countBorrowersExperience GROUP BY
        return { rows: trackAgg || [] };
      }
      if (sql.includes('appraisals')) {
        return { rows: apprPresent ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  // 1. A file with a completed credit pull + a current appraisal → both signals set.
  {
    const out = await gatherInvestorInputs('app-1', mkDb({ fico: 712, apprPresent: true }));
    ok('imported credit FICO is read into fico_credit', out.fico_credit === 712);
    ok('a current appraisal sets appraisal_present = true', out.appraisal_present === true);
  }

  // 2. NEVER FABRICATE: no credit report → no fico_credit key (rule stays silent, not "0").
  {
    const out = await gatherInvestorInputs('app-2', mkDb({ fico: null, apprPresent: false }));
    ok('no credit report → fico_credit omitted (never invented)', !('fico_credit' in out));
    ok('no appraisal → appraisal_present omitted (never judges value early)', !('appraisal_present' in out));
  }

  // 3. A credit-table error omits ONLY fico but still reads the appraisal — and never throws.
  {
    const out = await gatherInvestorInputs('app-3', mkDb({ fico: 700, apprPresent: true, throwOn: 'credit_reports' }));
    ok('a credit_reports query error omits fico_credit (no throw)', !('fico_credit' in out));
    ok('the appraisal read still succeeds despite the credit error', out.appraisal_present === true);
  }

  // 4. An appraisals-table error omits ONLY appraisal_present.
  {
    const out = await gatherInvestorInputs('app-4', mkDb({ fico: 680, apprPresent: true, throwOn: 'appraisals' }));
    ok('fico still read when the appraisals query errors', out.fico_credit === 680);
    ok('an appraisals query error omits appraisal_present (no throw)', !('appraisal_present' in out));
  }

  // 5. Missing inputs → an empty bag, never a throw.
  {
    ok('null applicationId → {} (no throw)', JSON.stringify(await gatherInvestorInputs(null, mkDb({}))) === '{}');
    ok('null db → {} (no throw)', JSON.stringify(await gatherInvestorInputs('app-5', null)) === '{}');
    ok('a db with no .query → {} (no throw)', JSON.stringify(await gatherInvestorInputs('app-6', {})) === '{}');
  }

  // 6. FLOOD ZONE (#250) — the FATAL isg_flood_zone_needs_insurance rule fires ONLY on
  //    in_flood_zone === true, so true must require PROOF of a Special Flood Hazard Area.
  const flood = async (row) => (await gatherInvestorInputs('app-f', mkDb({ apprPresent: true, flood: row }))).in_flood_zone;
  {
    // Proven in an SFHA → true (any one of the three signals).
    ok('FEMA SFHA flag true → in_flood_zone true', (await flood({ fema_flood_sfha: true, fema_flood_zone: null, flood_zone: null })) === true);
    ok('FEMA zone AE → in_flood_zone true', (await flood({ fema_flood_sfha: null, fema_flood_zone: 'AE', flood_zone: null })) === true);
    ok('FEMA zone VE → in_flood_zone true', (await flood({ fema_flood_sfha: null, fema_flood_zone: 'VE', flood_zone: null })) === true);
    ok("appraiser stated zone 'A' → in_flood_zone true", (await flood({ fema_flood_sfha: null, fema_flood_zone: null, flood_zone: 'A' })) === true);

    // A concrete NOT-in-SFHA determination → false (rule stays silent, but truthful).
    ok('FEMA SFHA flag false → in_flood_zone false', (await flood({ fema_flood_sfha: false, fema_flood_zone: null, flood_zone: null })) === false);
    ok("stated zone 'X' (non-A/V) → in_flood_zone false", (await flood({ fema_flood_sfha: null, fema_flood_zone: null, flood_zone: 'X' })) === false);
    ok("FEMA zone 'X' → in_flood_zone false", (await flood({ fema_flood_sfha: null, fema_flood_zone: 'X', flood_zone: null })) === false);

    // NEVER FABRICATE: not-checked (all NULL) or no appraisal → OMITTED, never guessed.
    const outNull = await gatherInvestorInputs('app-fn', mkDb({ apprPresent: true, flood: { fema_flood_sfha: null, fema_flood_zone: null, flood_zone: null } }));
    ok('all flood fields NULL (not checked) → in_flood_zone omitted', !('in_flood_zone' in outNull));
    const outNoAppr = await gatherInvestorInputs('app-fx', mkDb({ apprPresent: false }));
    ok('no appraisal row → in_flood_zone omitted', !('in_flood_zone' in outNoAppr));

    // A flood-query error omits in_flood_zone and never throws.
    const outErr = await gatherInvestorInputs('app-fe', mkDb({ apprPresent: true, flood: { fema_flood_sfha: true }, throwOn: 'fema_flood_sfha' }));
    ok('a flood query error omits in_flood_zone (no throw)', !('in_flood_zone' in outErr));

    // appraisal_rural (#254) — from the current appraisal's UAD neighborhood location type
    // (same current-appraisal read). Feeds the FATAL isg_rural_property (fires only on === true).
    const ruralOf = async (loc) => (await gatherInvestorInputs('app-r', mkDb({ apprPresent: true, flood: { nbhd_location_type: loc } }))).appraisal_rural;
    ok('nbhd_location_type Rural → appraisal_rural true', (await ruralOf('Rural')) === true);
    ok('nbhd_location_type Urban → appraisal_rural false', (await ruralOf('Urban')) === false);
    ok('nbhd_location_type Suburban → appraisal_rural false', (await ruralOf('Suburban')) === false);
    const outRuralNull = await gatherInvestorInputs('app-rn', mkDb({ apprPresent: true, flood: { nbhd_location_type: null } }));
    ok('nbhd_location_type NULL → appraisal_rural omitted (never guessed)', !('appraisal_rural' in outRuralNull));
    const outRuralNoAppr = await gatherInvestorInputs('app-rx', mkDb({ apprPresent: false }));
    ok('no appraisal row → appraisal_rural omitted', !('appraisal_rural' in outRuralNoAppr));

    // appraisal_mid_construction (#255) — SubjectToCompletion is the precise UAD "not yet complete"
    // condition; feeds the FATAL isg_bl_mid_construction (fires only on === true).
    const midOf = async (cond) => (await gatherInvestorInputs('app-m', mkDb({ apprPresent: true, flood: { condition_of_appraisal: cond } }))).appraisal_mid_construction;
    ok('SubjectToCompletion → appraisal_mid_construction true', (await midOf('SubjectToCompletion')) === true);
    ok('SubjectToRepairs → appraisal_mid_construction false (a rehab, not construction)', (await midOf('SubjectToRepairs')) === false);
    ok('SubjectToInspection → appraisal_mid_construction false', (await midOf('SubjectToInspection')) === false);
    ok('AsIs → appraisal_mid_construction false', (await midOf('AsIs')) === false);
    const outMidNull = await gatherInvestorInputs('app-mn', mkDb({ apprPresent: true, flood: { condition_of_appraisal: null } }));
    ok('NULL condition → appraisal_mid_construction omitted (never guessed)', !('appraisal_mid_construction' in outMidNull));
    const outMidNoAppr = await gatherInvestorInputs('app-mx', mkDb({ apprPresent: false }));
    ok('no appraisal row → appraisal_mid_construction omitted', !('appraisal_mid_construction' in outMidNoAppr));
  }

  // 7. CLAIMED vs VERIFIED EXPERIENCE (#251) — the FATAL isg_experience_claimed_over_verified
  //    fires only when claimed_exp > verified_exp, so we emit the pair ONLY when there's a real
  //    claim, and OMIT both when there's nothing claimed (never a fabricated 0).
  const app3 = { borrower_id: 'b1', co_borrower_id: null, requested_exp_flips: 2, requested_exp_holds: 1, requested_exp_ground: 0 };
  {
    // Claim 3, 2 verified recent deals → both emitted (rule would fire 3>2).
    const out = await gatherInvestorInputs('app-x', mkDb({ expApp: app3, trackAgg: [{ deal_type: 'flip', n: 2 }] }));
    ok('claimed_exp sums requested_exp_flips+holds+ground', out.claimed_exp === 3);
    ok('verified_exp = summed verified track-record count', out.verified_exp === 2);

    // Claim 3, 3 verified → both emitted, equal (rule stays silent, but the signal is present).
    const outEq = await gatherInvestorInputs('app-x', mkDb({ expApp: app3, trackAgg: [{ deal_type: 'flip', n: 2 }, { deal_type: 'hold', n: 1 }] }));
    ok('claimed 3 / verified 3 → both emitted (3 and 3)', outEq.claimed_exp === 3 && outEq.verified_exp === 3);

    // Claim 3, nothing verified yet → verified_exp is a REAL 0 (rule fires — this is the note-buyer intent).
    const out0 = await gatherInvestorInputs('app-x', mkDb({ expApp: app3, trackAgg: [] }));
    ok('claimed 3 / none verified → verified_exp is a real 0 (not omitted)', out0.claimed_exp === 3 && out0.verified_exp === 0);

    // NO claim (all requested_exp 0) → nothing to verify → BOTH omitted (never a fabricated 0).
    const noClaim = { borrower_id: 'b1', co_borrower_id: null, requested_exp_flips: 0, requested_exp_holds: 0, requested_exp_ground: 0 };
    const outNo = await gatherInvestorInputs('app-x', mkDb({ expApp: noClaim, trackAgg: [{ deal_type: 'flip', n: 5 }] }));
    ok('no experience claimed → claimed_exp omitted', !('claimed_exp' in outNo));
    ok('no experience claimed → verified_exp omitted', !('verified_exp' in outNo));

    // No application row → both omitted.
    const outNoApp = await gatherInvestorInputs('app-x', mkDb({ expApp: undefined }));
    ok('no application row → experience signals omitted', !('claimed_exp' in outNoApp) && !('verified_exp' in outNoApp));

    // An experience-read error omits both and never throws.
    const outErr2 = await gatherInvestorInputs('app-x', mkDb({ expApp: app3, throwOn: 'requested_exp_flips' }));
    ok('an experience query error omits claimed/verified (no throw)', !('claimed_exp' in outErr2) && !('verified_exp' in outErr2));

    // has_stale_exit (#252) — a WARNING that fires only when a claimed exit is older than 3 years.
    // Gated on a real claim (claim > 0). true when a stale exit exists; false when checked-and-none;
    // OMITTED when there's no claim or on error.
    const outStale = await gatherInvestorInputs('app-x', mkDb({ expApp: app3, trackAgg: [{ deal_type: 'flip', n: 1 }], staleExit: true }));
    ok('a claimed exit older than 3 years → has_stale_exit true', outStale.has_stale_exit === true);
    const outFresh = await gatherInvestorInputs('app-x', mkDb({ expApp: app3, trackAgg: [{ deal_type: 'flip', n: 1 }], staleExit: false }));
    ok('claim with no stale exit → has_stale_exit false (checked)', outFresh.has_stale_exit === false);
    const noClaim2 = { borrower_id: 'b1', co_borrower_id: null, requested_exp_flips: 0, requested_exp_holds: 0, requested_exp_ground: 0 };
    const outNoClaimStale = await gatherInvestorInputs('app-x', mkDb({ expApp: noClaim2, staleExit: true }));
    ok('no claim → has_stale_exit omitted (never nags a file that does not rely on experience)', !('has_stale_exit' in outNoClaimStale));
  }

  // 8. CASH-OUT (#253) — is_cash_out is the ECONOMIC classification (refinance_economic_type);
  //    feeds the Blue Lake escalation isg_bl_cashout_over_250k (fires on is_cash_out && proceeds>250k).
  //    Independent of experience claim. Never-false-fire: only 'cash_out' sets true; NULL → omit.
  const coApp = (extra) => Object.assign({ borrower_id: 'b1', co_borrower_id: null, requested_exp_flips: 0, requested_exp_holds: 0, requested_exp_ground: 0 }, extra);
  {
    // Economic cash-out with a verified number → is_cash_out true + cash_out_proceeds (prefers verified).
    const out = await gatherInvestorInputs('app-co', mkDb({ expApp: coApp({ refinance_economic_type: 'cash_out', verified_cash_out: 300000, estimated_cash_out: 999999 }) }));
    ok('economic cash_out → is_cash_out true', out.is_cash_out === true);
    ok('cash_out_proceeds prefers the VERIFIED number', out.cash_out_proceeds === 300000);

    // Only an estimate on file → falls back to the estimate (real, file-carried).
    const outEst = await gatherInvestorInputs('app-co', mkDb({ expApp: coApp({ refinance_economic_type: 'cash_out', verified_cash_out: null, estimated_cash_out: 275000 }) }));
    ok('no verified number → cash_out_proceeds falls back to the estimate', outEst.cash_out_proceeds === 275000);

    // Economically cash_out but no proceeds number → is_cash_out true, proceeds omitted (rule stays silent).
    const outNoAmt = await gatherInvestorInputs('app-co', mkDb({ expApp: coApp({ refinance_economic_type: 'cash_out', verified_cash_out: null, estimated_cash_out: null }) }));
    ok('cash_out with no proceeds number → cash_out_proceeds omitted', outNoAmt.is_cash_out === true && !('cash_out_proceeds' in outNoAmt));

    // Rate-and-term → a real false (economically NOT cash-out); rule stays silent.
    const outRT = await gatherInvestorInputs('app-co', mkDb({ expApp: coApp({ refinance_economic_type: 'rate_term', estimated_cash_out: 500000 }) }));
    ok('rate_term → is_cash_out false (not omitted, not true)', outRT.is_cash_out === false);
    ok('rate_term → cash_out_proceeds omitted (never fires the escalation)', !('cash_out_proceeds' in outRT));

    // Not classified (NULL — e.g. a purchase) → is_cash_out OMITTED (never fabricated).
    const outNull = await gatherInvestorInputs('app-co', mkDb({ expApp: coApp({ refinance_economic_type: null, estimated_cash_out: 500000 }) }));
    ok('unclassified refi type → is_cash_out omitted (never guessed)', !('is_cash_out' in outNull) && !('cash_out_proceeds' in outNull));
  }

  console.log(`\ngatherInvestorInputs (#232 data-source wiring) pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
