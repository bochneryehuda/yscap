'use strict';
/**
 * Exception-workflow REDESIGN — the register (2026-07-24;
 * docs/EXCEPTION-WORKFLOW-REDESIGN.md).
 *
 * PURE part (always runs): the type registry (every type carries reason codes /
 * expirability / SLA; reasonCodesFor is registry-driven), compensating-factor
 * sanitizing, dealDrift.
 *
 * DB part (runs only with DATABASE_URL) — the redesign's lifecycle guarantees:
 *   • a pricing_exception request writes a first-class row with deal_snapshot,
 *     due_at (SLA), severity, requested_by_kind (staff AND borrower shapes);
 *   • re_request_of links a fresh ask to the prior denied one;
 *   • withdraw stamps withdrawn_by/withdrawn_at and NOT decided_by;
 *   • an OPEN request can NOT be cleared (withdraw/decide first) — a decided
 *     one can;
 *   • approval validity: expiresAt sticks on an expirable type, is REFUSED on
 *     guaranty_waiver, and expireDueApprovals flips only past-due approved
 *     rows of expirable types ('expired' grants nothing by construction);
 *   • recordIssuanceOverride writes a born-approved row and NEVER throws;
 *   • registerForApp / listExceptions type filter / metrics / agingOpen /
 *     the updated_at trigger.
 *
 *   node scripts/test-exception-register-db.js
 *   DATABASE_URL=postgres://… node scripts/test-exception-register-db.js
 */
const R = require('path').resolve(__dirname, '..');
const LE = require(R + '/src/lib/loan-exceptions');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---------- PURE: the type registry ----------
(function pure() {
  const types = Object.keys(LE.EXCEPTION_TYPES);
  ok(types.includes('guaranty_waiver') && types.includes('esign_before_ctc')
    && types.includes('pricing_exception') && types.includes('issuance_override'),
  'registry: all four types present');
  for (const t of types) {
    const cfg = LE.EXCEPTION_TYPES[t];
    ok(cfg.label && cfg.reasonCodes && typeof cfg.expirable === 'boolean', `registry: ${t} carries label/reasons/expirable`);
    ok(LE.reasonCodesFor(t) === cfg.reasonCodes, `registry: reasonCodesFor(${t}) is registry-driven`);
  }
  ok(LE.EXCEPTION_TYPES.guaranty_waiver.expirable === false, 'registry: guaranty waiver is NEVER expirable');
  ok(LE.EXCEPTION_TYPES.issuance_override.recordOnly === true, 'registry: issuance override is record-only');
  ok(LE.isExceptionType('pricing_exception') && !LE.isExceptionType('nope'), 'isExceptionType accepts registry keys only');
  ok(LE.reasonLabelFor('pricing_exception', 'leverage') === LE.PRICING_EXCEPTION_REASONS.leverage,
    'reasonLabelFor resolves pricing codes');
  ok(LE.reasonCodesFor('unknown_type') === LE.REASON_CODES, 'unknown type falls back to guaranty reasons (legacy)');

  // due_at derives from the type's SLA.
  const from = new Date('2026-07-24T12:00:00Z');
  ok(LE.dueAtFor('pricing_exception', from).getTime() === from.getTime() + 48 * 3600 * 1000, 'dueAtFor: pricing = +48h');
  ok(LE.dueAtFor('esign_before_ctc', from).getTime() === from.getTime() + 24 * 3600 * 1000, 'dueAtFor: esign = +24h');
  ok(LE.dueAtFor('issuance_override', from) === null, 'dueAtFor: record-only type has no SLA');

  // compensating factors sanitize: unknown code → 'other'; empties dropped; capped.
  const cf = LE.sanitizeCompensatingFactors([
    { code: 'fico_strong', note: 'FICO 780 vs 680 min' },
    { code: 'not_a_code', note: 'still kept as other' },
    { code: null, note: '' },
    'garbage',
  ]);
  ok(Array.isArray(cf) && cf.length === 2, 'sanitizeCompensatingFactors keeps only meaningful entries');
  ok(cf[0].code === 'fico_strong' && cf[1].code === 'other', 'unknown factor code becomes other');
  ok(LE.sanitizeCompensatingFactors('nope') === null && LE.sanitizeCompensatingFactors([]) === null,
    'sanitizeCompensatingFactors: non-arrays/empties → null');

  // dealDrift: compares snapshot vs live joined values; silent on missing data.
  const drift = LE.dealDrift({
    deal_snapshot: { loan_amount: 100000, purchase_price: 200000, rehab_budget: 50000, arv: 300000 },
    loan_amount: 120000, live_purchase_price: 200000, live_rehab_budget: null, live_arv: 300000,
  });
  ok(drift.length === 1 && drift[0].field === 'loan_amount' && drift[0].was === 100000 && drift[0].now === 120000,
    'dealDrift flags only the moved value, never missing data');
  ok(LE.dealDrift({}).length === 0 && LE.dealDrift({ deal_snapshot: null }).length === 0, 'dealDrift: no snapshot → no drift');
})();

(async function dbPart() {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP exception-register DB lifecycle (no DATABASE_URL)'); finish(); return; }
  const db = require(R + '/src/db');
  const rnd = () => 'exr' + Math.random() + '@e.com';
  const b = await db.query("INSERT INTO borrowers(first_name,last_name,email) VALUES('Reg','One',$1) RETURNING id", [rnd()]);
  const bId = b.rows[0].id;
  const app = await db.query(
    `INSERT INTO applications(borrower_id, loan_amount, purchase_price, rehab_budget, arv, program)
     VALUES ($1, 150000, 200000, 50000, 320000, 'standard') RETURNING id`, [bId]);
  const appId = app.rows[0].id;
  const lo = await db.query("INSERT INTO staff_users(email,full_name,role,is_active) VALUES($1,'LO Reg','loan_officer',true) RETURNING id", [rnd()]);
  const loId = lo.rows[0].id;
  const sa = await db.query("INSERT INTO staff_users(email,full_name,role,is_active) VALUES($1,'SA Reg','super_admin',true) RETURNING id", [rnd()]);
  const saId = sa.rows[0].id;

  // ---- pricing exception request: first-class row with the governance fields.
  let cx = await db.getClient(); await cx.query('BEGIN');
  const p1 = await LE.requestPricingException(cx, {
    appId, reasonCode: 'finance_more_fee', reasonNote: 'Finance 20% of the fee',
    requestedBy: loId,
    compensatingFactors: LE.sanitizeCompensatingFactors([{ code: 'liquidity_reserves', note: '12mo reserves' }, { code: 'experience_depth' }]),
  });
  await cx.query('COMMIT'); cx.release();
  ok(p1.exception_type === 'pricing_exception' && p1.status === 'requested', 'pricing request inserts a requested row');
  ok(p1.reason_code === 'finance_more_fee', 'pricing request keeps the structured reason');
  ok(p1.deal_snapshot && Number(p1.deal_snapshot.loan_amount) === 150000, 'deal_snapshot captured at request time');
  ok(p1.due_at != null, 'due_at (review SLA) stamped');
  ok(p1.severity === 'standard', 'severity defaults to standard');
  ok(p1.requested_by_kind === 'staff', 'staff request records kind=staff');
  ok(Array.isArray(p1.compensating_factors) && p1.compensating_factors.length === 2, 'compensating factors stored');
  ok(p1.exception_seq != null, 'exception_seq (EX-n reference) assigned');

  // ---- deny, then a fresh request links back via re_request_of.
  const denied = await LE.decideException(p1.id, 'denied', saId, 'not this one');
  ok(denied && denied.status === 'denied', 'deny records');
  let cy = await db.getClient(); await cy.query('BEGIN');
  const p2 = await LE.requestPricingException(cy, {
    appId, reasonCode: 'leverage', reasonNote: 'try again with more skin', requestedBy: loId, reRequestOf: p1.id,
  });
  await cy.query('COMMIT'); cy.release();
  ok(p2.re_request_of === p1.id, 're_request_of links the fresh ask to the denied one');

  // ---- withdraw stamps withdrawn_*, not decided_*.
  const wd = await LE.withdrawException(p2.id, loId);
  ok(wd && wd.status === 'withdrawn', 'withdraw works');
  ok(wd.withdrawn_by === loId && wd.withdrawn_at != null, 'withdraw stamps withdrawn_by/withdrawn_at');
  ok(wd.decided_by == null && wd.decided_at == null, 'withdraw no longer overloads decided_*');

  // ---- clear: refused on OPEN, allowed once handled.
  let cz = await db.getClient(); await cz.query('BEGIN');
  const p3 = await LE.requestPricingException(cz, { appId, reasonCode: 'loan_size', reasonNote: 'under min', requestedBy: loId });
  await cz.query('COMMIT'); cz.release();
  ok((await LE.clearException(p3.id, loId, 'bury it')) === null, 'an OPEN request can NOT be cleared');
  ok((await LE.getById(p3.id)).status === 'requested', 'the refused clear left it open');
  await LE.decideException(p3.id, 'denied', saId, 'no');
  const cl = await LE.clearException(p3.id, loId, 'handled');
  ok(cl && cl.status === 'cleared', 'a decided exception clears fine');

  // ---- borrower-initiated request shape.
  let cb = await db.getClient(); await cb.query('BEGIN');
  const pb = await LE.requestPricingException(cb, {
    appId, reasonNote: 'borrower asked from the portal', requestedByKind: 'borrower', requestedByBorrowerId: bId,
  });
  await cb.query('COMMIT'); cb.release();
  ok(pb.requested_by_kind === 'borrower' && pb.requested_by_borrower_id === bId && pb.requested_by == null,
    'borrower request records kind + borrower id, no staff requester');
  ok(pb.reason_code === 'other', 'missing reason code coerces to other');
  await LE.withdrawException(pb.id, saId);

  // ---- approval validity (expiresAt): sticks on expirable, refused on guaranty.
  let ce = await db.getClient(); await ce.query('BEGIN');
  const p4 = await LE.requestPricingException(ce, { appId, reasonCode: 'leverage', reasonNote: 'expiry test', requestedBy: loId });
  await ce.query('COMMIT'); ce.release();
  const in30d = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const ap4 = await LE.decideException(p4.id, 'approved', saId, 'ok for 30 days', db, { expiresAt: in30d });
  ok(ap4 && ap4.status === 'approved' && ap4.expires_at != null, 'expirable type stores the approval validity');

  const cb2 = await db.query("INSERT INTO borrowers(first_name,last_name,email) VALUES('Co','Reg',$1) RETURNING id", [rnd()]);
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [appId, cb2.rows[0].id]);
  let cg = await db.getClient(); await cg.query('BEGIN');
  const g1 = await LE.requestGuarantyWaiver(cg, { appId, subjectBorrowerId: cb2.rows[0].id, reasonCode: 'passive_member', reasonNote: 'x', requestedBy: loId });
  await cg.query('COMMIT'); cg.release();
  const apg = await LE.decideException(g1.id, 'approved', saId, 'fine', db, { expiresAt: in30d });
  ok(apg && apg.status === 'approved' && apg.expires_at == null, 'guaranty waiver REFUSES an expiry (never clock-driven)');

  // ---- expiry sweep: flips only past-due approved expirable rows.
  await db.query(`UPDATE loan_exceptions SET expires_at = now() - interval '1 hour' WHERE id=$1`, [p4.id]);
  const flipped = await LE.expireDueApprovals();
  ok(flipped.some((r) => r.id === p4.id), 'expireDueApprovals flips the lapsed approval');
  const p4after = await LE.getById(p4.id);
  ok(p4after.status === 'expired' && p4after.expired_at != null, 'lapsed approval is status=expired (grants nothing)');
  ok((await LE.expireDueApprovals()).every((r) => r.id !== p4.id), 'the sweep is once-per-row (status moved)');
  ok((await LE.getById(g1.id)).status === 'approved', 'the guaranty approval is untouched by the sweep');

  // an expired row can be re-requested with the chain intact
  let cr = await db.getClient(); await cr.query('BEGIN');
  const p5 = await LE.requestPricingException(cr, { appId, reasonCode: 'leverage', reasonNote: 'renew', requestedBy: loId, reRequestOf: p4.id });
  await cr.query('COMMIT'); cr.release();
  ok(p5.re_request_of === p4.id, 'an expired approval can be re-requested (renewal = re-assessment)');

  // ---- issuance override: born approved; never throws.
  const ovr = await LE.recordIssuanceOverride({ appId, staffId: saId, note: 'status_change: proceeding past fatal', snapshot: { action: 'status_change', tier: 'fatal' } });
  ok(ovr && ovr.status === 'approved' && ovr.exception_type === 'issuance_override', 'issuance override records born-approved');
  ok(ovr.decided_by === saId && ovr.requested_by === saId, 'override records the acting super-admin both sides');
  const bad = await LE.recordIssuanceOverride({ appId: '00000000-0000-0000-0000-000000000000', staffId: saId, note: 'x' });
  ok(bad === null, 'recordIssuanceOverride NEVER throws (bad file → null)');

  // ---- register + list + metrics + aging.
  const reg = await LE.registerForApp(appId);
  ok(reg.length >= 5, 'registerForApp returns the whole history');
  ok(reg.some((r) => r.exception_type === 'issuance_override') && reg.some((r) => r.exception_type === 'pricing_exception')
    && reg.some((r) => r.exception_type === 'guaranty_waiver'), 'register spans every type on the file');

  const onlyPricing = await LE.listExceptions({ status: 'all', type: 'pricing_exception' });
  ok(onlyPricing.length > 0 && onlyPricing.every((r) => r.exception_type === 'pricing_exception'), 'listExceptions type filter');
  const expiredList = await LE.listExceptions({ status: 'expired' });
  ok(expiredList.some((r) => r.id === p4.id), 'listExceptions serves the expired bucket');

  // drift: the live loan amount moves after the request snapshot.
  await db.query('UPDATE applications SET loan_amount=175000 WHERE id=$1', [appId]);
  const p5row = (await LE.listExceptions({ status: 'open' })).find((r) => r.id === p5.id);
  ok(p5row && Array.isArray(p5row.deal_drift) && p5row.deal_drift.some((d) => d.field === 'loan_amount'),
    'deal drift surfaces when the economics move under an open request');

  const m = await LE.metrics();
  ok(m && Array.isArray(m.byTypeStatus) && m.byTypeStatus.length > 0, 'metrics: by type/status counts');
  const pricingTiming = m.timing.find((t) => t.exception_type === 'pricing_exception');
  ok(pricingTiming && pricingTiming.decided >= 2 && pricingTiming.approvalRate != null, 'metrics: approval rate + timing per type');
  ok(m.openAging && typeof m.openAging.open === 'number', 'metrics: open aging block');

  // aging feed: force p5 past its due_at.
  await db.query(`UPDATE loan_exceptions SET due_at = now() - interval '2 hours' WHERE id=$1`, [p5.id]);
  const aging = await LE.agingOpen();
  ok(aging.some((r) => r.id === p5.id && Number(r.open_hours) >= 0), 'agingOpen serves overdue open requests');

  // ---- esign expiry fails CLOSED at READ time (before the sweep runs):
  // an approved-but-lapsed row is presented as 'expired' to the send-gate reader.
  let cs = await db.getClient(); await cs.query('BEGIN');
  const es1 = await LE.requestEsignBeforeCtc(cs, { appId, reasonCode: 'borrower_timeline', reasonNote: 'read-closed test', requestedBy: loId });
  await cs.query('COMMIT'); cs.release();
  await LE.decideException(es1.id, 'approved', saId, 'ok briefly', db, { expiresAt: new Date(Date.now() + 3600 * 1000).toISOString() });
  await db.query(`UPDATE loan_exceptions SET expires_at = now() - interval '1 minute' WHERE id=$1`, [es1.id]);
  const lapsedView = await LE.latestEsignBeforeCtc(appId);
  ok(lapsedView && lapsedView.status === 'expired', 'a lapsed esign approval reads as expired BEFORE the sweep (fail-closed)');
  ok((await LE.getById(es1.id)).status === 'expired', 'every read surface presents the lapsed approval as expired');
  const rawEs1 = (await db.query('SELECT status FROM loan_exceptions WHERE id=$1', [es1.id])).rows[0];
  ok(rawEs1.status === 'approved', 'the DB row is untouched by the read (the sweep stays the writer)');

  // ---- updated_at trigger keeps itself fresh without hand-setting.
  const before = (await db.query('SELECT updated_at FROM loan_exceptions WHERE id=$1', [p5.id])).rows[0].updated_at;
  await new Promise((r) => setTimeout(r, 30));
  await db.query(`UPDATE loan_exceptions SET reason_note='touched' WHERE id=$1`, [p5.id]);
  const after = (await db.query('SELECT updated_at FROM loan_exceptions WHERE id=$1', [p5.id])).rows[0].updated_at;
  ok(new Date(after).getTime() > new Date(before).getTime(), 'updated_at trigger stamps every write');

  finish();
})().catch((e) => { console.error(e); fail++; finish(); });

function finish() {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
