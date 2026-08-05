/**
 * The DocuSign auto-clear condition codes stay in lock-step with the e-sign
 * package definitions (owner-directed 2026-08-05). A few conditions clear
 * themselves when their DocuSign package is fully signed, and the staff condition
 * row stamps them "DocuSign — auto-clears" so nobody works them by hand. That set
 * (esign/auto-clear.js) must equal exactly the ORIGINATION packages' cleared
 * conditions — and must NOT include the draw request form, which needs review.
 *
 * PURE — no DB. In `npm test`.
 */
'use strict';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
const assert = require('assert');
const { AUTO_CLEAR_CONDITION_CODES, ORIGINATION_PACKAGES, isAutoClearedByEsign } = require('../src/lib/esign/auto-clear');
const { PACKAGES } = require('../src/lib/esign/orchestrate');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Derive the cleared conditions from the ORIGINATION e-sign packages themselves.
const derived = new Set();
for (const pkg of ORIGINATION_PACKAGES) {
  const spec = PACKAGES[pkg];
  ok(!!spec, `origination package ${pkg} exists`);
  for (const d of (spec && spec.docs) || []) if (d.condition) derived.add(d.condition);
}

ok(JSON.stringify([...AUTO_CLEAR_CONDITION_CODES].sort()) === JSON.stringify([...derived].sort()),
  `the auto-clear set equals the origination packages' conditions (${[...derived].sort().join(', ')})`);

// The four the owner named are all in.
for (const c of ['rtl_cond_signedts', 'rtl_cond_signed_app', 'rtl_cond_iska', 'cond_noo_affidavit_individual']) {
  ok(isAutoClearedByEsign(c), `${c} is auto-cleared by DocuSign`);
}

// The DRAW request / wire form is signed in DocuSign too, but it must NEVER read as
// auto-cleared — it needs human review before the draw is delivered to the investor.
ok(PACKAGES.draw_request && PACKAGES.draw_request.docs.some((d) => d.condition === 'draw_cond_signed_request'),
  'sanity: the draw package really does clear draw_cond_signed_request');
ok(!isAutoClearedByEsign('draw_cond_signed_request'), 'the draw request form is NOT stamped auto-clear (it needs review)');
ok(!ORIGINATION_PACKAGES.includes('draw_request'), 'the draw package is excluded from the origination set');

// Junk / unrelated codes never stamp.
ok(!isAutoClearedByEsign(''), 'blank code is not auto-cleared');
ok(!isAutoClearedByEsign('rtl_p1_id'), 'an ordinary document condition is not auto-cleared');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll DocuSign auto-clear code checks passed.');
