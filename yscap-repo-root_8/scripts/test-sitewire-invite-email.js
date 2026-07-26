'use strict';
/* Per-file Sitewire invite-email override (owner-directed 2026-07-21): change WHICH email the borrower
 * invite goes to (borrower / GC / partner), stored on the file so push + resend honor it. DB-gated;
 * Sitewire writes are OFF here (no creds), so the live-assign path is exercised only for its guards.
 * Run: DATABASE_URL=... node scripts/test-sitewire-invite-email.js */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-invite-email (no DATABASE_URL)'); process.exit(0); }
const db = require('../src/db');
const orch = require('../src/sitewire/orchestrator');
const crypto = require('crypto');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };

async function seed(borrowerEmail) {
  const email = borrowerEmail || ('inv' + crypto.randomBytes(4).toString('hex') + '@e.com');
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('I','V',$1) RETURNING id`, [email])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number) VALUES($1,'funded',$2) RETURNING id`, [bor, 'INV' + crypto.randomBytes(3).toString('hex')])).rows[0].id;
  return { app, bor, email };
}
const cleanup = async (app, bor) => { await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app]); await db.query(`DELETE FROM applications WHERE id=$1`, [app]); await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]); };
const linkEmail = async (app) => (await db.query(`SELECT invite_email FROM sitewire_property_links WHERE application_id=$1`, [app])).rows[0];

(async () => {
  // pure: inviteEmailFor
  ok('inviteEmailFor: override wins', orch.inviteEmailFor({ invite_email: 'gc@x.com' }, { borrower_email: 'b@x.com' }) === 'gc@x.com');
  ok('inviteEmailFor: blank override → borrower email', orch.inviteEmailFor({ invite_email: '   ' }, { borrower_email: 'b@x.com' }) === 'b@x.com');
  ok('inviteEmailFor: none → null', orch.inviteEmailFor(null, null) === null);

  // invalid email is rejected (never guessed)
  {
    const { app, bor } = await seed();
    ok('setBorrowerInviteEmail: rejects a bad email', (await orch.setBorrowerInviteEmail(app, 'not-an-email')).error === 'invalid_email');
    ok('setBorrowerInviteEmail: rejects blank', (await orch.setBorrowerInviteEmail(app, '')).error === 'invalid_email');
    ok('setBorrowerInviteEmail: nothing stored on reject', !(await linkEmail(app)));
    await cleanup(app, bor);
  }

  // valid email is stored on the file (creates the link row if none); writes off → not_pushed
  {
    const { app, bor } = await seed();
    const r = await orch.setBorrowerInviteEmail(app, '  GC@Contractor.com ');
    ok('setBorrowerInviteEmail: ok + stored', r.ok === true && r.stored === true);
    ok('setBorrowerInviteEmail: trims + stores the override', (await linkEmail(app)).invite_email === 'GC@Contractor.com');
    ok('setBorrowerInviteEmail: writes off (no creds) → not_pushed', r.sitewire === 'not_pushed');
    // changing it again replaces the stored override
    await orch.setBorrowerInviteEmail(app, 'partner@x.com');
    ok('setBorrowerInviteEmail: change replaces the override', (await linkEmail(app)).invite_email === 'partner@x.com');
    await cleanup(app, bor);
  }

  // status read exposes the prefill (override or borrower email) + the override + borrower email
  {
    const { app, bor, email } = await seed();
    let s = await orch.getBorrowerInviteStatus(app);
    ok('status: unmanaged before push', s.managed === false);
    ok('status: prefill falls back to the borrower email', s.invite_email === email && s.override_email === null && s.borrower_email === email);
    await orch.setBorrowerInviteEmail(app, 'gc@build.com');
    s = await orch.getBorrowerInviteStatus(app);
    ok('status: override becomes the prefill + is surfaced', s.invite_email === 'gc@build.com' && s.override_email === 'gc@build.com' && s.borrower_email === email);
    await cleanup(app, bor);
  }

  // resend on a not-managed file is refused (never guesses a property)
  {
    const { app, bor } = await seed();
    ok('resendBorrowerInvite: not_managed when unpushed', (await orch.resendBorrowerInvite(app)).error === 'not_managed');
    await cleanup(app, bor);
  }

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} invite-email assertions ${fail === 0 ? 'passed' : ''}`);
  try { await db.pool.end(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
