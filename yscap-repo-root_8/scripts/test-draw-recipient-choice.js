/* Draw-send recipient choice (owner-directed 2026-07-21): the DocuSign wire form (a soloBorrower package)
 * can be sent to the borrower (default) OR the co-borrower; multi-signer packages (term sheet) are unchanged.
 * This exercises the PURE roster builder (no DB, no network) — the one place the choice takes effect.
 * Run: node scripts/test-draw-recipient-choice.js
 */
const orch = require('../src/lib/esign/orchestrate');
const buildRoster = orch.buildRoster;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };

if (typeof buildRoster !== 'function') { console.log('FAIL buildRoster not exported'); process.exit(1); }

const app = {
  b_id: 'B1', b_first: 'Moshe', b_last: 'Spitzer', b_email: 'moshe@example.com',
  cb_id: 'C1', cb_first: 'Sarah', cb_last: 'Spitzer', cb_email: 'sarah@example.com',
  co_borrower_id: 'C1',
};
const soloSpec = { soloBorrower: true, countersignRequired: false };
const dualSpec = { soloBorrower: false, countersignRequired: false };

// 1) SOLO, default → the PRIMARY borrower is the single signer
{ const r = buildRoster(app, soloSpec, 'env1');
  ok('1 solo default: one signer', r.length === 1);
  ok('1 solo default: is borrower', r[0].email === 'moshe@example.com' && r[0].role === 'borrower' && r[0].borrowerId === 'B1'); }

// 2) SOLO, recipient=co_borrower → the CO-BORROWER is the single signer (identity swapped, still role 'borrower')
{ const r = buildRoster(app, soloSpec, 'env2', { recipient: 'co_borrower' });
  ok('2 solo→co: one signer', r.length === 1);
  ok('2 solo→co: is co-borrower', r[0].email === 'sarah@example.com' && r[0].borrowerId === 'C1' && r[0].role === 'borrower'); }

// 3) SOLO, recipient=co_borrower but NO co-borrower on file → falls back to the primary borrower (never empty)
{ const solo = { ...app, cb_id: null, cb_first: null, cb_last: null, cb_email: null, co_borrower_id: null };
  const r = buildRoster(solo, soloSpec, 'env3', { recipient: 'co_borrower' });
  ok('3 solo→co w/o co: falls back to borrower', r.length === 1 && r[0].email === 'moshe@example.com'); }

// 4) SOLO, recipient='borrower' explicit → primary borrower (same as default)
{ const r = buildRoster(app, soloSpec, 'env4', { recipient: 'borrower' });
  ok('4 solo borrower explicit', r.length === 1 && r[0].email === 'moshe@example.com'); }

// 5) MULTI-signer package (term sheet) is UNCHANGED by the choice: both borrower + co-borrower sign,
//    and recipient='co_borrower' does NOT swap/drop the primary (the choice only applies to solo).
{ const r = buildRoster(app, dualSpec, 'env5', { recipient: 'co_borrower' });
  ok('5 dual: two signers', r.length === 2);
  ok('5 dual: primary borrower first', r[0].role === 'borrower' && r[0].email === 'moshe@example.com');
  ok('5 dual: co-borrower second', r[1].role === 'co_borrower' && r[1].email === 'sarah@example.com'); }

// ===== SEND-PATH re-resolution (the bug caught pre-merge): buildDefinition re-resolves each seeded
// recipient's identity at send time. It MUST key on the stored borrower_id, not the role string, or a
// co-borrower choice silently reverts to the primary borrower. resolveRecipientIdentity is that logic. =====
const resolve = orch.resolveRecipientIdentity;
ok('resolve exported', typeof resolve === 'function');
// The seeded row for a co-borrower choice: role='borrower' (b1 anchors) but borrower_id = the co-borrower.
{ const r = resolve({ role: 'borrower', borrower_id: 'C1' }, app);
  ok('send: solo→co keeps co-borrower email', r.email === 'sarah@example.com' && r.name === 'Sarah Spitzer'); }
// The seeded row for the primary borrower: role='borrower', borrower_id = the primary.
{ const r = resolve({ role: 'borrower', borrower_id: 'B1' }, app);
  ok('send: primary borrower stays primary', r.email === 'moshe@example.com'); }
// A role='borrower' row with a borrower_id that ISN'T the co-borrower resolves to the primary (never leaks co).
{ const r = resolve({ role: 'borrower', borrower_id: 'ZZ' }, app);
  ok('send: unknown borrower_id → primary', r.email === 'moshe@example.com'); }
// An explicit co_borrower-role recipient (multi-signer package) still resolves to the co-borrower.
{ const r = resolve({ role: 'co_borrower', borrower_id: 'C1' }, app);
  ok('send: co_borrower role → co-borrower', r.email === 'sarah@example.com'); }
// Admin/other → keep seeded config (null identity).
{ const r = resolve({ role: 'admin', borrower_id: null }, app);
  ok('send: admin keeps config', r.email === null && r.name === null); }

// ===== SEED-SEAM (the bug caught POST-merge): sendPackage → createOrClaimEnvelope must FORWARD
// opts.recipient so the SOLO signer is SEEDED with the chosen borrower_id. A fake db captures the
// esign_recipients seed. Mirrors exactly how sendPackage calls createOrClaimEnvelope. =====
(async () => {
  const createOrClaim = orch.createOrClaimEnvelope;
  ok('createOrClaimEnvelope exported', typeof createOrClaim === 'function');
  const spec = orch.packageSpec('draw_request');
  const fullApp = { ...app, id: 'APP1' };

  // A fake db: no in-flight/prior envelope, seq 0, envelope INSERT returns a row, condition/doc inserts
  // are no-ops, and each esign_recipients INSERT is captured.
  function makeDb(seededOut) {
    return { query: async (sql, params) => {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };                                 // seq (check FIRST)
      if (/INSERT INTO esign_envelopes/i.test(sql)) return { rows: [{ id: 'ENV1', application_id: 'APP1', purpose: 'draw_request', status: 'not_sent' }] };
      if (/FROM esign_envelopes\s+WHERE application_id/i.test(sql)) return { rows: [] };          // inflight + prior
      if (/INSERT INTO esign_recipients/i.test(sql)) { seededOut.push({ role: params[1], borrower_id: params[5], name: params[6], email: params[7] }); return { rows: [] }; }
      return { rows: [] };  // condition lookups + env_docs inserts
    } };
  }

  // With recipient='co_borrower' FORWARDED → the single seeded signer carries the CO-BORROWER's identity.
  { const seeded = []; await createOrClaim(makeDb(seeded), fullApp, 'draw_request', spec, null, { reissue: false, recipient: 'co_borrower' });
    const signer = seeded.find((r) => r.role === 'borrower');
    ok('seed: forwarded co_borrower seeds co-borrower', !!signer && signer.borrower_id === 'C1' && signer.email === 'sarah@example.com'); }

  // Default (no recipient) → the primary borrower is seeded (byte-identical to before the feature).
  { const seeded = []; await createOrClaim(makeDb(seeded), fullApp, 'draw_request', spec, null, { reissue: false });
    const signer = seeded.find((r) => r.role === 'borrower');
    ok('seed: default seeds primary borrower', !!signer && signer.borrower_id === 'B1' && signer.email === 'moshe@example.com'); }

  // ===== The EXACT forward line: sendPackage MUST pass opts.recipient through to the seed. This drives
  // sendPackage itself (stubbing the actual DocuSign send) so it FAILS if the one-line forward is reverted. =====
  const cfg = require('../src/config');
  cfg.docusign = { ...(cfg.docusign || {}), sendEnabled: true, testMode: false };
  const appRow = { id: 'APP1', ys_loan_number: 'YS1', b_id: 'B1', b_first: 'Moshe', b_last: 'Spitzer', b_email: 'moshe@example.com', cb_id: 'C1', cb_first: 'Sarah', cb_last: 'Spitzer', cb_email: 'sarah@example.com', co_borrower_id: 'C1' };
  function fullDb(seededOut) {
    return { query: async (sql, params) => {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
      if (/FROM applications a\s+JOIN borrowers/i.test(sql)) return { rows: [appRow] };            // loadApplication
      if (/INSERT INTO esign_envelopes/i.test(sql)) return { rows: [{ id: 'ENV1', status: 'not_sent' }] };
      if (/FROM esign_envelopes\s+WHERE application_id/i.test(sql)) return { rows: [] };           // inflight/prior
      if (/INSERT INTO esign_recipients/i.test(sql)) { seededOut.push({ role: params[1], borrower_id: params[5], email: params[7] }); return { rows: [] }; }
      if (/RETURNING/i.test(sql)) return { rows: [{ id: 'X' }] };
      return { rows: [{ id: 'X', status: 'outstanding' }] };                                       // ensureDrawRequestCondition + condition lookups
    } };
  }
  const stopSend = { sendClaimedEnvelope: async () => { throw Object.assign(new Error('STOP_AFTER_SEED'), { __stop: true }); } };
  { const seeded = [];
    try { await orch.sendPackage('APP1', 'draw_request', { id: 'staff1' }, { recipient: 'co_borrower', db: fullDb(seeded), send: stopSend, docusign: {}, storage: {} }); }
    catch (_) { /* expected: the stubbed send throws AFTER the recipient was seeded */ }
    const signer = seeded.find((r) => r.role === 'borrower');
    ok('sendPackage forwards recipient to the seed', !!signer && signer.borrower_id === 'C1' && signer.email === 'sarah@example.com'); }

  console.log(`\ntest-draw-recipient-choice: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
