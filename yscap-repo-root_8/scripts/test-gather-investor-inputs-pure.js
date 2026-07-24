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

// A tiny mock db.query that routes by which table the SQL hits.
function mkDb({ fico, apprPresent, throwOn } = {}) {
  return {
    query: async (sql) => {
      if (throwOn && sql.includes(throwOn)) throw new Error('boom');
      if (sql.includes('credit_reports')) {
        return { rows: fico == null ? [] : [{ middle_score: fico }] };
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

  console.log(`\ngatherInvestorInputs (#232 data-source wiring) pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
