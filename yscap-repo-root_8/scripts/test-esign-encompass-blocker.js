'use strict';
/**
 * test-esign-encompass-blocker — the e-sign panel must SEE the Encompass match
 * gate, and every blocker must keep a way out on screen.
 *
 * OWNER REPORT (2026-07-27): "after everything is cleared … the button to
 * request an exception goes away … and now I can't send the term-sheet package
 * because it doesn't match within Encompass, but I want to give an exception
 * that for this time it doesn't need to match."
 *
 * ROOT CAUSE — TWO gates hold a term-sheet send, and the panel only knew ONE.
 *   1. esign/gate.js — the appraisal / P&P / closing-date prerequisites.
 *   2. encompass/reconcile.issuanceGate — enforced at the send ROUTE only.
 * The panel read (1) alone, so a file with every condition signed off rendered
 * "All prerequisites met" (gate.ready === true). The entire escape-hatch block
 * lived inside the `!gate.ready` branch of EsignFileSection, so being READY
 * DELETED it from the screen — and then the send came back "Encompass has 7
 * unmatched field(s). As an admin you can override — provide a reason", advice
 * with nothing to click, because the client never collected or sent
 * `encompassOverrideReason`.
 *
 * This test pins both halves: the server now REPORTS the Encompass gate in the
 * per-file e-sign payload (fail-open, dormant with no Encompass loan), and the
 * panel renders the blocker + the override OUTSIDE the ready branch.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');

let pass = 0;
const ok = (name, fn) => { fn(); console.log('  ok ', name); pass++; };
const okAsync = async (name, fn) => { await fn(); console.log('  ok ', name); pass++; };

// ── Stub encompass/reconcile BEFORE tracking.js lazy-requires it ─────────────
// (require.resolve does not execute the module, so seeding the cache wins.)
const reconcilePath = require.resolve(R + '/src/encompass/reconcile');
let issuanceGateStub = async () => ({ block: false, hasLoan: false, openBlocking: 0, openBlockingKeys: [] });
require.cache[reconcilePath] = {
  id: reconcilePath, filename: reconcilePath, loaded: true, children: [], paths: [],
  exports: { issuanceGate: (...a) => issuanceGateStub(...a) },
};

const tracking = require(R + '/src/lib/esign/tracking');

(async () => {
  console.log('e-sign Encompass blocker — the second gate the panel must see\n');

  // ── The read model surfaces the Encompass gate ─────────────────────────────
  await okAsync('a blocking Encompass mismatch is reported with its field count', async () => {
    issuanceGateStub = async () => ({ block: true, hasLoan: true, openBlocking: 7, openBlockingKeys: ['loan_amount', 'arv'] });
    const e = await tracking.encompassSendBlock('app-1');
    assert.strictEqual(e.block, true);
    assert.strictEqual(e.hasLoan, true);
    assert.strictEqual(e.openBlocking, 7);
    assert.deepStrictEqual(e.openBlockingKeys, ['loan_amount', 'arv']);
  });

  await okAsync('DORMANT with no Encompass loan — never blocks a file Encompass has never seen', async () => {
    issuanceGateStub = async () => ({ block: false, hasLoan: false, openBlocking: 0, openBlockingKeys: [] });
    const e = await tracking.encompassSendBlock('app-2');
    assert.strictEqual(e.block, false);
    assert.strictEqual(e.hasLoan, false);
  });

  await okAsync('FAILS OPEN — a reconcile crash can never strand a send or break the panel', async () => {
    issuanceGateStub = async () => { throw new Error('encompass unreachable'); };
    const e = await tracking.encompassSendBlock('app-3');
    assert.deepStrictEqual(e, { block: false, hasLoan: false, openBlocking: 0, openBlockingKeys: [] });
  });

  await okAsync('a malformed gate answer degrades to safe zeros (never NaN/undefined in the UI)', async () => {
    issuanceGateStub = async () => ({ block: true });
    const e = await tracking.encompassSendBlock('app-4');
    assert.strictEqual(e.block, true);
    assert.strictEqual(e.openBlocking, 0);
    assert.deepStrictEqual(e.openBlockingKeys, []);
  });

  // ── fileEsign carries it alongside the prerequisites gate ──────────────────
  await okAsync('fileEsign returns `encompass` next to `gate` — a READY file still reports the block', async () => {
    issuanceGateStub = async () => ({ block: true, hasLoan: true, openBlocking: 7, openBlockingKeys: ['arv'] });
    // Stub the prerequisites gate to fully READY — the exact state the owner hit.
    // tracking.js captured the exports OBJECT at require time, so patch the
    // property in place (swapping require.cache[...].exports would be ignored).
    const gateMod = require(R + '/src/lib/esign/gate');
    const savedSendGate = gateMod.esignSendGate;
    gateMod.esignSendGate = async () => ({ ready: true, sendAllowed: true, outstanding: [], canRequestException: false });
    try {
      // No envelopes, no loan number — the send-health aggregate is the one query
      // that must return a row (it is a bare count over the whole table).
      const fakeDb = {
        query: async (sql) => (/sent10min/.test(String(sql))
          ? { rows: [{ backingOff: 0, queued: 0, deadLettered: 0, sent10min: 0 }] }
          : { rows: [] }),
      };
      const out = await tracking.fileEsign(fakeDb, 'app-5');
      assert.strictEqual(out.gate.ready, true, 'prerequisites are met');
      assert.ok(out.encompass, 'the payload carries the Encompass gate');
      assert.strictEqual(out.encompass.block, true, 'and it still reports the term-sheet block');
      assert.strictEqual(out.encompass.openBlocking, 7);
    } finally { gateMod.esignSendGate = savedSendGate; }
  });

  // ── The panel contract — the escape hatch must survive a READY file ────────
  const panel = fs.readFileSync(R + '/app-v2/src/components/EsignFileSection.jsx', 'utf8');

  ok('the panel reads the Encompass gate from the payload', () => {
    assert.ok(/data\.encompass/.test(panel), 'EsignFileSection must read data.encompass');
    assert.ok(/const encBlocks\s*=/.test(panel), 'and derive a blocking flag from it');
  });

  ok('the Encompass blocker renders OUTSIDE the gate.ready branch (the reported bug)', () => {
    // The readiness ternary closes with `</>\n        )}` — everything the panel
    // shows only when NOT ready lives before it. The Encompass block must come
    // after, or being "ready" deletes the escape hatch from the screen again.
    const readyBranchEnd = panel.indexOf('{/* THE ENCOMPASS MATCH BLOCKER');
    const excRequestBlock = panel.indexOf('canRequestException ? (');
    assert.ok(readyBranchEnd > 0, 'the Encompass blocker block exists');
    assert.ok(excRequestBlock > 0 && excRequestBlock < readyBranchEnd,
      'the super-admin request stays in the not-ready branch; the Encompass blocker comes after it');
    assert.ok(/\{encBlocks && \(/.test(panel), 'and it is gated on encBlocks alone — never on gate.ready');
  });

  ok('an admin gets the override the send route asks for, with a required reason', () => {
    assert.ok(/encompassOverrideReason/.test(panel), 'the client sends encompassOverrideReason');
    assert.ok(/isAdmin && !encOvrOpen/.test(panel), 'the override is offered to admins only');
    assert.ok(/disabled=\{busy === 'send:term_sheet_package' \|\| !encOvrNote\.trim\(\)/.test(panel),
      'and refuses to send without a typed reason');
  });

  ok('a non-admin is told the two real next steps instead of hitting a dead end', () => {
    assert.ok(/ask an admin to make an exception for this send/.test(panel));
    // Encompass sync is a TAB of Application details, not a section of its own
    // (owner-directed 2026-08-03) — the jump asks for the tab, then opens the
    // section that holds it. Jumping at the deleted section id would silently
    // do nothing, which is a dead end dressed up as a way out.
    assert.ok(/requestAppDetailTab\('encompass'\); goToSection\('sec-application'\)/.test(panel),
      'and can jump straight to what does not match — the Encompass tab, already open');
    assert.ok(!/goToSection\('sec-encompass'\)/.test(panel),
      'and never at the retired section id');
  });

  ok('the term-sheet Send button no longer fires a send that can only fail', () => {
    assert.ok(/const encHeld = encBlocks && p\.purpose === 'term_sheet_package'/.test(panel));
    assert.ok(/blocked = !sendAllowed \|\| needsLoan \|\| already \|\| encHeld/.test(panel));
  });

  ok('the Heter Iska is never held by Encompass (it carries no Encompass numbers)', () => {
    // encHeld is purpose-scoped, so the Iska button's blocked-ness is untouched.
    assert.ok(/encBlocks && p\.purpose === 'term_sheet_package'/.test(panel),
      'the hold is scoped to the term-sheet package only');
  });

  ok('a failed send re-opens the reason box instead of leaving the advice unclickable', () => {
    assert.ok(/e\.data\.code === 'encompass_override_reason_required'/.test(panel));
    assert.ok(/setEncOvrOpen\(true\)/.test(panel));
  });

  ok('Retry / Re-issue has its own way past the check (the panel box drives the FIRST send only)', () => {
    assert.ok(/const reissueSend = \(e\) =>/.test(panel));
    assert.ok(/onClick=\{\(\) => reissueSend\(e\)\}/.test(panel));
  });

  // ── The server contract the panel depends on ──────────────────────────────
  const route = fs.readFileSync(R + '/src/routes/staff.js', 'utf8');
  ok('the send route still REQUIRES a reason and records the override', () => {
    assert.ok(/encompass_override_reason_required/.test(route), 'the code the client keys on still exists');
    assert.ok(/recordIssuanceOverride/.test(route), 'and an override is still written to the exception register');
    assert.ok(/if \(!tapeAdmin\(req\)\) return res\.status\(422\)/.test(route),
      'a non-admin can still never override — the UI mirrors the server rule, it does not replace it');
  });

  console.log(`\ne-sign Encompass blocker — ${pass} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
