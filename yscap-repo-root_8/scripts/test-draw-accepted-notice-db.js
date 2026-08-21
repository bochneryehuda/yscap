'use strict';
/**
 * THE DRAW COORDINATOR IS TOLD WHEN THE BORROWER APPROVES (owner-reported 2026-08-21).
 *
 * THE REPORT. *"When a borrower is approving the inspection results online, he's clicking on the
 * Approve button from his email or log in, and the draw coordinator is not getting a notification.
 * We need to set up a nice notification to the draw coordinator that this draw number, whatever
 * this amount was, was approved by the borrower through the online system … Make sure, either way,
 * when they approve it, either on the portal or on their email, the draw coordinator and the loan
 * officer should get a notification that the borrower approved it."*
 *
 * ROOT CAUSE, and it is why a pure test could never have found it: `notify.notifyAppStaff` — the
 * ONE whole-team fan-out — selects `application_assignees`, and PILOT has no draw-coordinator
 * POINTER. A coordinator is identified by what they DID on the file (pressed "Start the draw
 * process", or holds a live draw hand-off), which is an entirely different resolver
 * (`draw-recipients.drawCoordinatorsForFile`). So the borrower pressed Accept, the fan-out ran
 * against the assignee table, and the one person whose job it is to release the money was
 * structurally not in the list. The loan officer WAS — the db/103 trigger keeps the primary officer
 * as an assignee — which is exactly why only half the team ever heard.
 *
 * WHAT THIS PROVES, end to end against a REAL database and the REAL notify path:
 *   A. The gap itself: a coordinator who owns the file's draws but is NOT an assignee.
 *   B. Both doors the owner named — the portal and the emailed link — reach them, and the officer.
 *   C. The message names the draw and the money, and says WHERE the button was pressed.
 *   D. It is keyed on the DRAW CATEGORY, so it cannot quietly widen a coordinator's scope.
 *   E. A broker is never a recipient of an internal draw notification.
 *
 * DB-gated: skips cleanly with no DATABASE_URL. Nothing leaves the process.
 * Run: DATABASE_URL=… node scripts/test-draw-accepted-notice-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-accepted-notice-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-draw-accept';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const db = require('../src/db');
const dr = require('../src/lib/draw-recipients');
const notify = require('../src/lib/notify');
const NOTICE = require('../src/sitewire/draw-accepted-notice');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };
const TAG = 'dan' + crypto.randomBytes(4).toString('hex');

(async () => {
  // An EXTERNAL staff row must carry a firm — `staff_users_external_firm_check` makes an unscoped
  // external identity structurally unwritable (the TPO PORTAL identity invariant), which is a good
  // thing to trip over here: a broker fixture that skipped it would not be a real broker.
  let firmId = null;
  const staff = async (role, who, { external = false, active = true } = {}) => {
    if (external && !firmId) {
      firmId = (await db.query(
        `INSERT INTO tpo_firms(name, status) VALUES($1,'active') RETURNING id`, [`Firm ${TAG}`])).rows[0].id;
    }
    return (await db.query(
      `INSERT INTO staff_users(email, full_name, role, is_active, is_external, tpo_firm_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [`${who}.${TAG}@example.com`.toLowerCase(), who, role, active, external, external ? firmId : null])).rows[0].id;
  };

  const lo = await staff('loan_officer', 'officer');
  const coord = await staff('draw_coordinator', 'coord');
  const bor = (await db.query(
    `INSERT INTO borrowers(first_name,last_name,email) VALUES('Draw','Accept',$1) RETURNING id`,
    [`borrower.${TAG}@example.com`])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_amount, rehab_budget)
     VALUES($1,$2,'funded',$3,'{"oneLine":"7 Draw Ln, Town, NY 11111","city":"Town","state":"NY","zip":"11111"}',400000,50000)
     RETURNING id`, [bor, lo, `YS${TAG.toUpperCase()}`])).rows[0].id;

  // The coordinator OWNS this file's draws by having started them — and is deliberately NOT an
  // assignee, which is the shape of every real file and the whole reason the bug existed.
  const swId = 800000 + crypto.randomBytes(2).readUInt16BE(0);
  await db.query(
    `INSERT INTO sitewire_property_links(application_id, sitewire_property_id, matched_by, state, pushed_at,
                                         draw_setup_started_at, draw_setup_started_by)
     VALUES($1,$2,'created','live',now(),now(),$3)`, [app, swId + 5, coord]);

  const notesFor = async (staffId, type) => Number((await db.query(
    `SELECT count(*)::int n FROM notifications WHERE staff_id=$1 AND application_id=$2 AND type=$3`,
    [staffId, app, type])).rows[0].n);
  const latest = async (staffId) => (await db.query(
    `SELECT title, body FROM notifications WHERE staff_id=$1 AND application_id=$2
      ORDER BY created_at DESC, id DESC LIMIT 1`, [staffId, app])).rows[0];

  // ======================================================================
  // A. THE GAP — the coordinator owns the draws and is not an assignee
  // ======================================================================
  {
    const coords = await dr.drawCoordinatorsForFile(app);
    eq('A1 the coordinator who started this file\'s draws is the file\'s coordinator',
      coords.map((c) => String(c.id)), [String(coord)]);
    const assignees = (await db.query(
      `SELECT staff_id FROM application_assignees WHERE application_id=$1 AND removed_at IS NULL`, [app])).rows;
    ok('A2 …and is NOT an application assignee, which is why the fan-out could never reach them',
      !assignees.some((a) => String(a.staff_id) === String(coord)));
    ok('A3 the loan officer IS one (the db/103 pointer trigger), which is why only half the team heard',
      assignees.some((a) => String(a.staff_id) === String(lo)));

    const ids = (await dr.drawStaffIdsForFile(app)).map(String);
    ok('A4 the staff-side loop-in resolves BOTH of the people the owner named', ids.includes(String(coord)) && ids.includes(String(lo)));
  }

  // ======================================================================
  // B. THE FAN-OUT NOW REACHES THEM — keyed on the draw category
  // ======================================================================
  {
    const before = await notesFor(coord, 'draw_accepted');
    const sent = await notify.notifyAppStaff(app, {
      type: 'draw_accepted', title: 'Draw 1 approved by the borrower',
      body: 'The borrower approved the inspection results in their portal.', applicationId: app,
    });
    ok('B1 a draw notification now names the coordinator among its recipients',
      (sent || []).map(String).includes(String(coord)));
    ok('B2 …and the loan officer', (sent || []).map(String).includes(String(lo)));
    ok('B3 …and it actually reached them', (await notesFor(coord, 'draw_accepted')) > before);

    // THE CATEGORY IS THE GATE. A non-draw event must NOT loop the coordinator in — that scope
    // rule (owner-directed 2026-08-10) is exactly what stops a part-of-the-file role receiving
    // everything, and widening it here would undo it.
    const sent2 = await notify.notifyAppStaff(app, {
      type: 'status_change', title: 'Status moved', body: 'x', applicationId: app,
    });
    ok('B4 a NON-draw event does not loop the draw coordinator in',
      !(sent2 || []).map(String).includes(String(coord)));
    ok('B5 …while the loan officer still gets it, so nothing else moved',
      (sent2 || []).map(String).includes(String(lo)));
  }

  // ======================================================================
  // C. WHAT IT SAYS — the draw, the money, and where the button was pressed
  // ======================================================================
  {
    // The payload builder is pure, so every branch is checkable without staging a whole draw.
    const blocks = { money: { number: 2 }, figures: { primary: { label: 'To be released', value: '$33,450.00' } }, facts: { rows: [1] } };
    const p = NOTICE.acceptedPayload(blocks, 'email', { drawTag: 'Draw 2', wireDueAt: '2026-08-25T16:00:00Z' });
    ok('C1 the title names WHICH draw', /Draw 2/.test(p.title));
    ok('C2 …and that it was approved', /approved/i.test(p.title));
    ok('C3 the body states the amount', /\$33,450\.00/.test(p.body));
    ok('C4 …and WHERE they pressed the button', /from the email we sent them/.test(p.body));
    ok('C5 …and carries the ranked money block rather than restating it in prose', !!p.figures);

    const portal = NOTICE.acceptedPayload(blocks, 'portal', { drawTag: 'Draw 2' });
    ok('C6 the portal path says so instead', /in their portal/.test(portal.body));
    const broker = NOTICE.acceptedPayload(blocks, 'tpo', { drawTag: 'Draw 2' });
    ok('C7 a BROKER approval is never described as the borrower — the coordinator is about to move money',
      /The broker/.test(broker.body) && !/The borrower/.test(broker.body));

    // NEVER INVENT A DRAW NUMBER. A finding whose draw cannot be resolved must not print
    // "Draw #undefined" at the top of an email.
    const bare = NOTICE.acceptedPayload(null, 'portal', {});
    ok('C8 a draw that cannot be named says so rather than printing an empty number',
      !/undefined|null|#\s*$/.test(bare.title) && /A draw was approved/.test(bare.title));
    eq('C9 …and quotes no money it could not read', bare.figures, null);
    ok('C10 an unreadable wire deadline is simply omitted, never printed as "Invalid Date"',
      !/Invalid Date/.test(NOTICE.acceptedPayload(blocks, 'portal', { wireDueAt: 'not-a-date' }).body));

    // The type is what carries it into the draw category — get this wrong and the coordinator
    // silently drops out of the fan-out again.
    eq('C11 it is announced as a draw event, which is what the loop-in keys on', p.type, 'draw_accepted');
  }

  // ======================================================================
  // D. THE WHOLE PATH, through the real sender
  // ======================================================================
  {
    const f = (await db.query(
      `INSERT INTO draw_findings(application_id, sitewire_draw_id, status, total_requested_cents,
                                 total_approved_cents, delivered_at, accepted_at, accepted_via, wire_due_at)
       VALUES($1,$2,'accepted',5000000,3345000,now(),now(),'portal',now() + interval '48 hours')
       RETURNING *`, [app, swId])).rows[0];
    const before = await notesFor(coord, 'draw_accepted');
    const sent = await NOTICE.notifyDrawAccepted(db, f, 'portal', { wireDueAt: f.wire_due_at });
    ok('D1 the shared notice reaches the coordinator', (sent || []).map(String).includes(String(coord)));
    ok('D2 …and the loan officer', (sent || []).map(String).includes(String(lo)));
    ok('D3 …and lands as a real notification', (await notesFor(coord, 'draw_accepted')) > before);
    const row = await latest(coord);
    ok('D4 …whose wording says the borrower approved it', row && /approved/i.test(row.title + ' ' + row.body));

    // IT MUST NEVER THROW. An acceptance has already happened by the time this runs — a broken
    // decoration must not turn a successful approval into a 500 for the borrower.
    let threw = null;
    try { await NOTICE.notifyDrawAccepted(db, null, 'portal', {}); } catch (e) { threw = e; }
    ok('D5 a missing finding is answered with nothing, never an exception', !threw);
    try { await NOTICE.notifyDrawAccepted({ query: async () => { throw new Error('down'); } }, f, 'portal', {}); }
    catch (e) { threw = e; }
    ok('D6 …and neither is a database that is refusing to answer', !threw);
  }

  // ======================================================================
  // E. A BROKER IS NEVER A RECIPIENT of an internal draw notification
  // ======================================================================
  {
    const broker = await staff('loan_officer', 'broker', { external: true });
    // …and an is_tpo file must name its firm, for the same reason.
    const app2 = (await db.query(
      `INSERT INTO applications(borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_amount,
                                is_tpo, tpo_firm_id)
       VALUES($1,$2,'funded',$3,'{"oneLine":"9 Broker Way"}',300000,true,$4) RETURNING id`,
      [bor, broker, `YSB${TAG.toUpperCase()}`, firmId])).rows[0].id;
    await db.query(
      `INSERT INTO sitewire_property_links(application_id, sitewire_property_id, matched_by, state, pushed_at,
                                           draw_setup_started_at, draw_setup_started_by)
       VALUES($1,$2,'created','live',now(),now(),$3)`, [app2, swId + 9, coord]);

    const ids = (await dr.drawStaffIdsForFile(app2)).map(String);
    ok('E1 the external broker is never in the internal draw loop-in', !ids.includes(String(broker)));
    ok('E2 …while the coordinator still is, so the file is covered', ids.includes(String(coord)));

    const sent = await notify.notifyAppStaff(app2, { type: 'draw_accepted', title: 'x', body: 'y', applicationId: app2 });
    ok('E3 …and the fan-out does not reach them either', !(sent || []).map(String).includes(String(broker)));

    // A DEACTIVATED coordinator cannot receive anything and must not be counted as covered.
    await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [coord]);
    ok('E4 a deactivated coordinator is not resolved as a recipient',
      !(await dr.drawStaffIdsForFile(app2)).map(String).includes(String(coord)));
    await db.query(`UPDATE staff_users SET is_active=true WHERE id=$1`, [coord]);
  }

  // ======================================================================
  // F. THE SHARED DRAW DESK INBOX gets ONE copy (owner-directed 2026-08-21:
  //    "you can always notify our group email, which is draws@yscapgroup.com")
  //
  // WHY THIS WAS MISSING and could not have been found by reading the recipient list: the fan-out
  // emails one `staff_users` row at a time, and `draws@yscapgroup.com` is a shared MAILBOX with no
  // such row — so no resolver could ever have put it there. It was already copied on every
  // BORROWER draw email, on the wire-form DocuSign viewers and on the one-email thread helper; our
  // OWN team notifications were the one place it was absent, which is exactly where the borrower
  // pressing Accept lands. Asserted on the WIRE PAYLOAD: a passing send against the `none`
  // provider proves nothing about who was addressed.
  // ======================================================================
  {
    const mailer = require('../src/lib/email');
    const realSend = mailer.sendMail;
    const outbox = [];
    mailer.sendMail = async (m) => { outbox.push(m); return { ok: true, id: 'test' }; };
    let deskPersonToRemove = null;
    const toList = () => outbox.flatMap((m) => (Array.isArray(m.to) ? m.to : [m.to]).filter(Boolean).map(String));
    const deskCopies = () => toList().filter((a) => a.toLowerCase() === dr.DRAW_DESK_INBOX.toLowerCase()).length;
    try {
      const f = (await db.query(
        `INSERT INTO draw_findings(application_id, sitewire_draw_id, status, wire_due_at)
         VALUES($1,$2,'delivered', now() + interval '2 days') RETURNING *`, [app, swId + 5])).rows[0];

      outbox.length = 0;
      await NOTICE.notifyDrawAccepted(db, f, 'portal', {});
      eq('F1 the shared draw desk inbox gets exactly ONE copy', deskCopies(), 1);
      const deskMail = outbox.find((m) => (Array.isArray(m.to) ? m.to : [m.to])
        .some((a) => String(a).toLowerCase() === dr.DRAW_DESK_INBOX.toLowerCase()));
      ok('F2 …carrying the same message the team got, not a bare notice',
        !!deskMail && /approved/i.test(String(deskMail.subject || '') + String(deskMail.text || '')));

      // A NON-draw notification must be byte-identical to before — the desk hears only its own part.
      outbox.length = 0;
      await notify.notifyAppStaff(app, { type: 'status_change', title: 'x', body: 'y', applicationId: app });
      eq('F3 a non-draw notification sends the desk nothing', deskCopies(), 0);

      /* AN IN-APP-ONLY FAN-OUT SENDS NOTHING, and this is the load-bearing one: `notifyAppThread`
         sets it precisely BECAUSE the borrower's email already carried the draw team — this
         address included — on a visible Cc. Without this guard the duplicate that helper was
         written to remove would come straight back. */
      outbox.length = 0;
      await notify.notifyAppStaff(app, { type: 'draw_accepted', title: 'x', body: 'y', applicationId: app, inAppOnly: true });
      eq('F4 an in-app-only draw fan-out sends the desk nothing', deskCopies(), 0);

      /* A COORDINATOR WHOSE OWN ADDRESS IS THE SHARED INBOX has already been emailed by the
         fan-out — a second copy of one sentence is exactly what a shared inbox must not receive. */
      /* This fixture is the ONE row in this suite whose address cannot be TAG-scoped — the whole
         point is that it IS the shared inbox — so it must be re-runnable and must not be left
         behind in a shared test database, where an ACTIVE staff row wearing the draw desk's
         address would quietly join other suites' recipient lists. Created if absent, reused if a
         previous run left one, and removed below only if THIS run created it. */
      const made = (await db.query(
        `INSERT INTO staff_users(email, full_name, role, is_active, is_external)
         VALUES($1,'Draw Desk','draw_coordinator',true,false)
         ON CONFLICT (email) DO NOTHING RETURNING id`, [dr.DRAW_DESK_INBOX])).rows[0];
      const deskPerson = made ? made.id : (await db.query(
        `UPDATE staff_users SET is_active=true WHERE lower(email)=lower($1) RETURNING id`,
        [dr.DRAW_DESK_INBOX])).rows[0].id;
      deskPersonToRemove = made ? deskPerson : null;
      const app3 = (await db.query(
        `INSERT INTO applications(borrower_id, loan_officer_id, status, ys_loan_number, property_address, loan_amount)
         VALUES($1,$2,'funded',$3,'{"oneLine":"11 Desk St"}',250000) RETURNING id`,
        [bor, lo, `YSD${TAG.toUpperCase()}`])).rows[0].id;
      await db.query(
        `INSERT INTO sitewire_property_links(application_id, sitewire_property_id, matched_by, state, pushed_at,
                                             draw_setup_started_at, draw_setup_started_by)
         VALUES($1,$2,'created','live',now(),now(),$3)`, [app3, swId + 11, deskPerson]);
      outbox.length = 0;
      await notify.notifyAppStaff(app3, { type: 'draw_accepted', title: 'x', body: 'y', applicationId: app3 });
      eq('F5 …is emailed once in total, never twice', deskCopies(), 1);
    } finally {
      mailer.sendMail = realSend;
      // Let every fire-and-forget fan-out settle first, INCLUDING its sent_emails capture:
      // deleting this fixture's notifications out from under one in flight is exactly the
      // `sent_emails → notifications` foreign-key error `drainEmails` exists to prevent.
      try { await notify.drainEmails(); } catch (_) {}
      // Only ever removes a row this run created — never one that was already there.
      if (deskPersonToRemove) {
        try { await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [deskPersonToRemove]); } catch (_) {}
        try { await db.query(`UPDATE sitewire_property_links SET draw_setup_started_by=NULL WHERE draw_setup_started_by=$1`, [deskPersonToRemove]); } catch (_) {}
        try { await db.query(`DELETE FROM staff_users WHERE id=$1`, [deskPersonToRemove]); } catch (_) {}
      }
    }
  }

  console.log(fail ? `test-draw-accepted-notice-db: ${pass} passed, ${fail} FAILED` : `test-draw-accepted-notice-db: all ${pass} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-draw-accepted-notice-db threw:', e); process.exit(1); });
