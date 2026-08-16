#!/usr/bin/env node
/**
 * READ-ONLY. Settles docs/longterm/LOS-MASTER-PLAN.md §5.0:
 * do long-term loans in this tenant carry Encompass conditions or not?
 *
 * The census said 348 conditions across 12 loans. The live probe said 0 across
 * 200 loans. The census did not record WHICH 12 loans (PII scrub), so the only
 * way to settle it is to sweep and count.
 *
 * Issues only GETs plus the two read-shaped POSTs the guarded client allows
 * (token + pipeline search). Writes nothing anywhere.
 */
const client = require('/home/user/yscap/yscap-repo-root_8/src/longterm/encompass/client.js');

const LIMIT = Number(process.env.SWEEP_LIMIT || 400);

(async () => {
  if (!client.configured()) { console.error('not configured'); process.exit(2); }
  console.log('READ_ONLY sentinel:', client.READ_ONLY);

  // 1. Discover loans. v3 pipeline: row key is `loanId`, values nested under `fields`.
  const body = {
    filter: { canonicalName: 'Loan.LastModified', matchType: 'greaterThan', value: '1900-01-01', precision: 'Day' },
    fields: ['Loan.LoanNumber', 'Loan.LoanFolder', 'Fields.1401', 'Fields.MS.STATUS'],
    sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }],
  };
  const rows = await client.pipelineSearch(body, { limit: LIMIT, start: 0 });
  console.log('pipeline rows:', rows.length);

  const loans = rows.map(r => ({
    id: r.loanId || r.loanGuid,
    program: (r.fields || {})['Fields.1401'] || '',
    milestone: (r.fields || {})['Fields.MS.STATUS'] || '',
    folder: (r.fields || {})['Loan.LoanFolder'] || '',
  })).filter(l => l.id);

  const isLT = l => /DSCR/i.test(l.program);
  console.log('long-term (DSCR) in sample:', loans.filter(isLT).length, 'of', loans.length);

  // 2. Read conditions per loan.
  let withConds = 0, totalConds = 0, errors = 0, checked = 0;
  const hits = [];
  const byStatus = {};

  for (const l of loans) {
    checked += 1;
    try {
      const c = await client.apiGet(`/encompass/v3/loans/${l.id}/conditions`);
      const n = Array.isArray(c) ? c.length : 0;
      if (n > 0) {
        withConds += 1; totalConds += n;
        hits.push({ program: l.program, milestone: l.milestone, folder: l.folder, count: n });
        for (const one of c) {
          const s = one && one.status ? String(one.status) : '(none)';
          byStatus[s] = (byStatus[s] || 0) + 1;
        }
      }
    } catch (e) {
      errors += 1;
      if (errors <= 3) console.log('  err:', String(e.message).slice(0, 140));
    }
    if (checked % 50 === 0) console.log(`  …${checked}/${loans.length} · loans with conditions so far: ${withConds}`);
  }

  console.log('\n================ VERDICT ================');
  console.log('loans checked            :', checked);
  console.log('loans WITH conditions    :', withConds);
  console.log('total conditions found   :', totalConds);
  console.log('read errors              :', errors);
  console.log('status breakdown         :', JSON.stringify(byStatus));
  console.log('\nhits (program / milestone / folder / count):');
  for (const h of hits) console.log('  -', h.program, '|', h.milestone, '|', h.folder, '|', h.count);
  console.log('=========================================');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
