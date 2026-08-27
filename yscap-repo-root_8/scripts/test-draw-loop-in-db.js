'use strict';
/**
 * test-draw-loop-in-db.js — THE DRAW COORDINATOR IS NEVER OUT OF THE LOOP (owner-directed
 * 2026-07-28). Two halves of one instruction, each pinned here:
 *
 *   1. "The draw coordinator assigned to a file should always be added as a VIEWER on the
 *      DocuSign package that goes out for the wire request form … receiving notifications
 *      when it's being signed."  → orchestrate.loadCcViewers adds them (draw_request only).
 *   2. "On every email that is going out to the borrower about the draw process the draw
 *      coordinator and the loan officer should always be looped into that email."
 *      → notify.js loops them in at the ONE borrower fan-out chokepoint, keyed on the
 *      notification's 'draws' category — so it is true for every draw email that exists
 *      today AND every one added later, with no call site having to remember.
 *
 * Every assertion runs the REAL code path against a REAL Postgres (the resolver's SQL, the
 * live notify send path, a real buildDefinition). DB-gated: skips cleanly with no
 * DATABASE_URL. Nothing leaves the process — the email provider is 'none' AND sendMail is
 * stubbed.
 *
 * Run: DATABASE_URL=postgres://… node scripts/test-draw-loop-in-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-loop-in-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-draw-loop';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO = path.join(__dirname, '..');
const db = require(REPO + '/src/db');
const cfg = require(REPO + '/src/config');
const dr = require(REPO + '/src/lib/draw-recipients');
const notify = require(REPO + '/src/lib/notify');
const emailMod = require(REPO + '/src/lib/email');
const orchestrate = require(REPO + '/src/lib/esign/orchestrate');
const fileInbox = require(REPO + '/src/lib/file-inbox');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL', msg); } };
const TAG = 'dli' + crypto.randomBytes(4).toString('hex');
// Lowercased: every recipient list in the app is normalized, so a mixed-case fixture
// address would only ever compare against itself.
const E = (who) => `${who}.${TAG}@example.com`.toLowerCase();

// ---- the email interceptor --------------------------------------------------
// notify._emailRow SPLITS the send when it injects an open pixel: the borrower gets the
// pixel copy with no BCC, and the monitors get a separate pixel-free copy addressed To
// them (`_skipCapture`). Both shapes mean "this address was looped in", so collect both.
let sends = [];
const realSendMail = emailMod.sendMail;
emailMod.sendMail = async (opts) => { sends.push(opts); return { ok: true, id: 'stub' }; };
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();
function monitorsOf(calls) {
  const s = new Set();
  for (const c of calls) {
    // The draw loop-in moved from a hidden Bcc to a VISIBLE Cc (owner-directed 2026-08-03:
    // "everybody should be looped in one email so we can then keep responding … so we can see
    // who else is looped in"). The 2026-07-28 REQUIREMENT this suite guards is unchanged — the
    // coordinator, the desk and the officer are always on a borrower's draw email — so the
    // assertions below stand as written; only the header carrying them changed. Both are
    // collected so this suite keeps covering the Bcc monitors on every NON-draw email.
    for (const e of [].concat(c.cc || [])) s.add(lower(e));
    for (const e of [].concat(c.bcc || [])) s.add(lower(e));
    if (c._skipCapture) for (const e of [].concat(c.to || [])) s.add(lower(e));
  }
  return s;
}
function toAddrsOf(calls) {
  const s = new Set();
  for (const c of calls) if (!c._skipCapture) for (const e of [].concat(c.to || [])) s.add(lower(e));
  return s;
}
/** Fire one borrower notification and return { monitors, to } once the send has settled. */
async function fanOut(appId, opts) {
  sends = [];
  await notify.notifyAppBorrowers(appId, opts);
  await notify.drainEmails();
  return { monitors: monitorsOf(sends), to: toAddrsOf(sends), calls: sends.slice() };
}

// ---- fixtures ---------------------------------------------------------------
const ids = { staff: [], borrowers: [], apps: [], firms: [] };
async function seedStaff(role, name, { active = true } = {}) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO staff_users (id, email, full_name, role, is_active) VALUES ($1,$2,$3,$4,$5)`,
    [id, E(name), name, role, active]);
  ids.staff.push(id);
  return { id, email: E(name), name };
}
async function seedBorrower(first, last, who) {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,$2,$3,$4)`, [id, first, last, E(who)]);
  ids.borrowers.push(id);
  return { id, email: E(who) };
}
async function seedApp({ borrowerId, coBorrowerId = null, officerId = null, processorId = null, status = 'funded' }) {
  const id = (await db.query(
    `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, processor_id, status,
                               ys_loan_number, property_address, loan_amount, rehab_budget)
     VALUES ($1,$2,$3,$4,$5,$6,'{"oneLine":"7 Draw Ln, Town, NY 11111","street":"7 Draw Ln","city":"Town","state":"NY","zip":"11111"}',400000,50000)
     RETURNING id`,
    [borrowerId, coBorrowerId, officerId, processorId, status, `YS${TAG.toUpperCase()}${ids.apps.length}`])).rows[0].id;
  ids.apps.push(id);
  return id;
}

async function main() {
  // -------------------------------------------------------------------------
  console.log('\n1. drawCoordinatorsForFile — WHICH coordinator is "assigned to this file"');
  // -------------------------------------------------------------------------
  const lo = await seedStaff('loan_officer', 'officer');
  const loAssistant = await seedStaff('loan_officer', 'officer2');
  const processor = await seedStaff('processor', 'processor');
  const coordA = await seedStaff('draw_coordinator', 'coordA');     // started THIS file's draws
  const coordB = await seedStaff('draw_coordinator', 'coordB');     // another active coordinator
  const coordGone = await seedStaff('draw_coordinator', 'coordGone', { active: false });
  const borrower = await seedBorrower('Pat', 'Borrower', 'borrower');
  const coBorrower = await seedBorrower('Chris', 'Co', 'coborrower');

  const appA = await seedApp({ borrowerId: borrower.id, coBorrowerId: coBorrower.id, officerId: lo.id, processorId: processor.id });
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, matched_by, state, draw_setup_started_at, draw_setup_started_by)
     VALUES ($1,'created','live',now(),$2)`, [appA, coordA.id]);

  let people = await dr.drawCoordinatorsForFile(appA);
  ok(people.length === 1 && people[0].id === coordA.id, 'the coordinator who STARTED this file\'s draw process is the file\'s coordinator');
  ok(people[0].src === 'started_draw', '…recorded with its source, so the precedence is auditable');

  // A second file whose draws were handed to coordB through the Workflow (no Sitewire link).
  const appB = await seedApp({ borrowerId: borrower.id, officerId: lo.id });
  const wfId = (await db.query(
    `INSERT INTO workflow_items (application_id, submission_type, to_staff_id, to_role, status)
     VALUES ($1,'draw_setup',$2,'draw_coordinator','open') RETURNING id`, [appB, coordB.id])).rows[0].id;
  people = await dr.drawCoordinatorsForFile(appB);
  ok(people.length === 1 && people[0].id === coordB.id, 'a LIVE draw hand-off in the Workflow names the file\'s coordinator too');

  await db.query(`UPDATE workflow_items SET status='returned' WHERE id=$1`, [wfId]);
  ok((await dr.drawCoordinatorsForFile(appB)).length === 0, 'a CLOSED hand-off no longer claims the file (the desk fallback takes over)');
  await db.query(`UPDATE workflow_items SET status='open' WHERE id=$1`, [wfId]);

  // A deactivated coordinator can't receive anything, so they are never resolved.
  await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [coordA.id]);
  ok((await dr.drawCoordinatorsForFile(appA)).length === 0, 'a DEACTIVATED coordinator is not the file\'s coordinator');
  await db.query(`UPDATE staff_users SET is_active=true WHERE id=$1`, [coordA.id]);

  ok((await dr.drawCoordinatorsForFile(null)).length === 0, 'no file → no coordinator (never throws)');
  ok(Array.isArray(await dr.drawCoordinatorsForFile('not-a-uuid')), 'a garbage id returns a list instead of throwing into a notification path');

  // -------------------------------------------------------------------------
  console.log('\n2. drawTeamBcc / drawLoopInBcc — the desk, the file\'s coordinator, the officer');
  // -------------------------------------------------------------------------
  let team = await dr.drawTeamBcc(appA);
  ok(team.includes(dr.DRAW_DESK_INBOX), 'the shared draws@ desk is always on the list');
  ok(team.includes(coordA.email), 'the FILE\'s coordinator is on the list');
  ok(!team.includes(coordB.email), '…and an unrelated coordinator is NOT — this is per-file, not the whole desk');
  ok(!team.includes(coordGone.email), 'a deactivated coordinator is never mailed');

  const appNoCoord = await seedApp({ borrowerId: borrower.id, officerId: lo.id });
  team = await dr.drawTeamBcc(appNoCoord);
  ok(team.includes(coordA.email) && team.includes(coordB.email),
    'a file with NOBODY assigned falls back to the whole active desk — a draw email is never uncovered');
  ok((await dr.drawTeamBcc()).includes(coordB.email), 'called with no file at all it is the old desk-wide behavior (back-compat)');

  let loop = await dr.drawLoopInBcc(appA);
  ok(loop.includes(coordA.email) && loop.includes(dr.DRAW_DESK_INBOX) && loop.includes(lo.email),
    'the loop-in = the file\'s coordinator + the desk + the file\'s LOAN OFFICER');
  await db.query(
    `INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'loan_officer',false)
     ON CONFLICT DO NOTHING`, [appA, loAssistant.id]);
  loop = await dr.drawLoopInBcc(appA);
  ok(loop.includes(loAssistant.email), 'an assistant loan officer on the file is looped in too (#113)');
  ok(!loop.includes(processor.email), 'the processor is not part of the owner\'s draw loop-in rule');

  // -------------------------------------------------------------------------
  console.log('\n3. EVERY borrower draw email loops them in (the notify chokepoint)');
  // -------------------------------------------------------------------------
  // One case per draw notification type actually sent to borrowers today.
  const DRAW_TYPES = ['draw', 'draw_setup', 'draw_findings', 'draw_message', 'draw_dispute_resolved', 'draw_request'];
  for (const type of DRAW_TYPES) {
    const r = await fanOut(appA, { type, title: `A ${type} email`, body: 'About your construction draw.', applicationId: appA });
    ok(r.monitors.has(coordA.email) && r.monitors.has(dr.DRAW_DESK_INBOX) && r.monitors.has(lo.email),
      `"${type}" → the coordinator, the desk and the loan officer are all looped in`);
    ok(r.to.has(borrower.email) && !r.to.has(coordA.email),
      `…"${type}" still goes TO the borrower; the internal addresses ride as BCC only`);
  }

  {
    // The control: a NON-draw email is untouched by this rule.
    const r = await fanOut(appA, { type: 'condition_added', title: 'A condition', body: 'Please upload it.', applicationId: appA });
    ok(!r.monitors.has(coordA.email) && !r.monitors.has(dr.DRAW_DESK_INBOX),
      'a NON-draw borrower email does NOT pull in the draw desk (the rule is scoped to the draw process)');
    ok(r.monitors.has(lo.email), '…the loan officer still rides it, exactly as before');
  }

  {
    // "ALWAYS" means always: the global CC_LO_ON_BORROWER switch does not govern draws.
    const prev = cfg.ccLoanOfficerOnBorrowerEmail;
    cfg.ccLoanOfficerOnBorrowerEmail = false;
    try {
      const draw = await fanOut(appA, { type: 'draw', title: 'Released', body: 'On its way.', applicationId: appA });
      ok(draw.monitors.has(lo.email) && draw.monitors.has(coordA.email),
        'with CC_LO_ON_BORROWER OFF the officer + coordinator are STILL looped in on a draw email ("always")');
      const other = await fanOut(appA, { type: 'condition_added', title: 'A condition', body: 'x', applicationId: appA });
      ok(!other.monitors.has(lo.email), '…while a non-draw email honors the switch (nothing else changed)');
    } finally { cfg.ccLoanOfficerOnBorrowerEmail = prev; }
  }

  {
    // A caller that already passes its own bccExtra keeps it — the loop-in is ADDITIVE.
    const r = await fanOut(appA, { type: 'draw', title: 'Released', body: 'x', applicationId: appA, bccExtra: ['extra.' + TAG + '@example.com'] });
    ok(r.monitors.has('extra.' + TAG + '@example.com') && r.monitors.has(coordA.email),
      'a caller-supplied bccExtra survives alongside the loop-in (additive, never a replacement)');
  }

  {
    // No duplicate monitor copies on a file with a co-borrower.
    const r = await fanOut(appA, { type: 'draw', title: 'Released', body: 'x', applicationId: appA });
    ok(r.to.has(borrower.email) && r.to.has(coBorrower.email), 'both borrowers are told');
    const deskCopies = r.calls.filter((c) => monitorsOf([c]).has(coordA.email)).length;
    ok(deskCopies === 1, 'the coordinator gets exactly ONE copy, not one per borrower');
  }

  {
    // A file with no coordinator assigned still reaches the desk.
    const r = await fanOut(appNoCoord, { type: 'draw', title: 'Released', body: 'x', applicationId: appNoCoord });
    ok(r.monitors.has(dr.DRAW_DESK_INBOX) && r.monitors.has(lo.email),
      'a file with no coordinator assigned still reaches the draw desk + the officer');
  }

  // -------------------------------------------------------------------------
  console.log('\n4. The WIRE REQUEST FORM copies the coordinator as a DocuSign viewer');
  // -------------------------------------------------------------------------
  {
    const wire = (await orchestrate.loadCcViewers(db, appA, 'draw_request')).map((v) => lower(v.email));
    ok(wire.includes(coordA.email), 'the file\'s draw coordinator is a viewer on the wire-request package');
    ok(wire.includes(dr.DRAW_DESK_INBOX), '…and so is the shared draw desk, so the envelope is never uncovered');
    ok(wire.includes(lo.email) && wire.includes(processor.email), '…alongside the loan officer + processor (unchanged)');
    ok((await orchestrate.loadCcViewers(db, appA, 'draw_request')).every((v) => v.name && v.email),
      'every viewer carries a name + email (DocuSign rejects a nameless recipient)');

    // THE ORIGINATION PACKAGES COPY THE COORDINATOR TOO — owner-directed 2026-08-21,
    // which REVERSES the draw_request-only scoping this block used to assert ("when
    // you're sending out the term sheet package, when you're sending out the ISKA, and
    // when you're sending out the draw form, then the draw coordinator … should be
    // looped in as viewers"). The old expectation is kept in the git history, not here.
    //
    // But the DESK FALLBACK must not follow them there, and that is the sharper half of
    // the rule: a file has no draw project until it FUNDS, so at term-sheet time there is
    // never a coordinator assigned, and the wire form's fallback would put the whole draw
    // desk plus the shared inbox on every borrower's loan documents. The wire form keeps
    // its cover (asserted three lines up); the origination packages take only a
    // coordinator the file actually has.
    /* THE HETER ISKA IS NARROWER SINCE 2026-08-26 (owner-directed, superseding
       the 2026-08-21 loop-in for THIS package only: "Only the loan officer and
       the processor and the borrower, obviously" — no coordinator, no admins).
       The term-sheet package keeps the 2026-08-21 coordinator loop-in. */
    const iska = (await orchestrate.loadCcViewers(db, appA, 'heter_iska')).map((v) => lower(v.email));
    ok(!iska.includes(coordA.email),
      'the HETER ISKA does NOT copy the draw coordinator (owner-directed 2026-08-26 — LO + processor + borrower only)');
    ok(!iska.includes(dr.DRAW_DESK_INBOX),
      '…and never the shared draw desk either');
    const ts = (await orchestrate.loadCcViewers(db, appA, 'term_sheet_package')).map((v) => lower(v.email));
    ok(ts.includes(coordA.email) && !ts.includes(dr.DRAW_DESK_INBOX),
      '…while the TERM SHEET package still copies the file\'s own coordinator (2026-08-21, unchanged) and never the desk');
    ok(iska.includes(lo.email), '…and the Heter Iska still copies the loan officer');
  }

  {
    // End-to-end: a REAL draw_request envelope, built the way the send path builds it.
    const envRow = (await db.query(
      `INSERT INTO esign_envelopes (application_id, purpose, status, countersign_required)
       VALUES ($1,'draw_request','not_sent',false) RETURNING *`, [appA])).rows[0];
    await db.query(
      `INSERT INTO esign_recipients (envelope_row_id, role, routing_order, recipient_id_ds, borrower_id, name, email, embedded, client_user_id, status)
       VALUES ($1,'borrower',1,'1',$2,'Pat Borrower',$3,true,$4,'created')`,
      [envRow.id, borrower.id, borrower.email, `${envRow.id}:borrower`]);
    const def = await orchestrate.buildDefinition(envRow, { db });
    const cc = (def.carbonCopies || []).map((c) => lower(c.email));
    ok(cc.includes(coordA.email), 'buildDefinition really carries the coordinator onto the wire-form envelope');
    ok(cc.includes(dr.DRAW_DESK_INBOX), '…and the draw desk');
    ok(!cc.includes(borrower.email), 'the signing borrower is never also a viewer');
    const ccIds = (def.carbonCopies || []).map((c) => Number(c.recipientId));
    ok(ccIds.length === new Set(ccIds).size && ccIds.every((n) => n > 1),
      'viewer recipientIds are unique and come after the signer (no DocuSign id collision)');
  }

  // -------------------------------------------------------------------------
  console.log('\n5. The ONE draw email that must NOT be BCC\'d — the magic signing link');
  // -------------------------------------------------------------------------
  {
    // PILOT's "your wire form is ready to sign" email carries a magic link that signs the
    // borrower IN AS THEM. BCC'ing staff there would hand a staffer the ability to sign the
    // wire form in the borrower's legal identity — so it is deliberately excluded, and the
    // coordinator is looped into that step as a DocuSign VIEWER instead (section 4).
    const src = fs.readFileSync(path.join(REPO, 'src/lib/esign/notify-signers.js'), 'utf8');
    const drawSend = src.slice(src.indexOf("mail.send('drawWireReadyToSign'"), src.indexOf("mail.send('esignReadyToSign'"));
    ok(drawSend.length > 0 && !/\bbcc\b/i.test(drawSend),
      'the wire-form ready-to-sign email (magic link) is never BCC\'d to staff');
    ok(/magic signUrl authenticates AS this borrower/.test(src) && /VIEWER on the envelope itself/.test(src),
      '…and the reason is written down beside it, so it is never "fixed" by adding one');
  }

  // -------------------------------------------------------------------------
  console.log('\n6. drawReplyLoopIn — who a REPLY on a draw-process file loops in (owner-directed 2026-08-06)');
  // -------------------------------------------------------------------------
  {
    const loopIn = await dr.drawReplyLoopIn(appA);
    ok(loopIn.includes(coordA.email) && loopIn.includes(dr.DRAW_DESK_INBOX) && loopIn.includes(lo.email),
      'a file in a draw process loops in the coordinator + the draws@ desk + the loan officer');

    const detailed = await dr.drawReplyLoopInDetailed(appA);
    const coordChip = detailed.find((x) => x.email === coordA.email);
    ok(coordChip && coordChip.name === coordA.name, '…the detailed form carries a display NAME for the composer chips');
    ok(detailed.some((x) => x.email === dr.DRAW_DESK_INBOX && /draw desk/i.test(x.name)), '…and a friendly name for the draws@ desk');

    ok((await dr.drawReplyLoopIn(appNoCoord)).length === 0,
      'a file with NO assigned draw coordinator loops NOBODY in — an ordinary reply is unchanged');
    ok((await dr.drawReplyLoopIn(null)).length === 0, 'no file → no loop-in (never throws)');
  }

  // -------------------------------------------------------------------------
  console.log('\n7. The file-inbox reply FORWARD carries the draw loop-in on a VISIBLE Cc');
  // -------------------------------------------------------------------------
  {
    sends = [];
    await fileInbox.forwardToAssignees({
      applicationId: appA, fromEmail: borrower.email, subject: 'Re: draw',
      text: 'Here is the invoice.', html: null, attachments: [],
      toEmails: [lo.email, processor.email], cc: await dr.drawReplyLoopIn(appA),
    });
    const call = sends[0] || {};
    const ccSet = new Set([].concat(call.cc || []).map(lower));
    ok(ccSet.has(coordA.email) && ccSet.has(dr.DRAW_DESK_INBOX),
      'a borrower reply on a draw file is forwarded with the coordinator + the draws@ desk on the Cc');
    ok(!ccSet.has(lo.email), '…the loan officer is not duplicated onto the Cc (already a To recipient)');
    ok(![].concat(call.to || []).map(lower).includes(borrower.email), 'the reply sender is never a recipient of the forward');

    // A file NOT in a draw process forwards with NO draw Cc — the ordinary path is untouched.
    sends = [];
    await fileInbox.forwardToAssignees({
      applicationId: appNoCoord, fromEmail: borrower.email, subject: 'Re: docs',
      text: 'x', html: null, attachments: [], toEmails: [lo.email], cc: await dr.drawReplyLoopIn(appNoCoord),
    });
    ok(!(sends[0] && sends[0].cc && sends[0].cc.length), 'a non-draw file forwards with no draw Cc');
  }

  // -------------------------------------------------------------------------
  console.log('\n8. The draw-wire "new entity" alert is ONE email with EVERYBODY visible on it');
  // -------------------------------------------------------------------------
  {
    // The 69 Bassett report: "I don't see anybody looped into this email on the CC line."
    // The alert now goes through notifyAppStaffThread(type:'draw'), so it is a single email
    // whose recipients — the assignees PLUS the draw loop-in — are all visible.
    sends = [];
    await notify.notifyAppStaffThread(appA, {
      type: 'draw', title: 'Draw wire goes to a NEW entity — operating agreement required',
      body: 'A fatal condition was opened.', applicationId: appA,
    });
    await notify.drainEmails();
    const emailCalls = sends.filter((c) => !c._skipCapture);
    ok(emailCalls.length === 1, 'the alert goes out as exactly ONE email (not one per assignee, nobody visible)');
    const to = new Set([].concat(emailCalls[0] && emailCalls[0].to || []).map(lower));
    ok(to.has(coordA.email) && to.has(dr.DRAW_DESK_INBOX) && to.has(lo.email),
      'the coordinator, the draws@ desk and the loan officer are all VISIBLE recipients of that one email');
    ok(!to.has(borrower.email), 'the borrower is never on this internal staff alert');

    // Source guard: the alert must route through notifyAppStaffThread(type:'draw'), never the
    // old notifyAppStaff(condition_added) that put nobody on the CC line.
    const wireSrc = fs.readFileSync(path.join(REPO, 'src/lib/esign/draw-wire.js'), 'utf8');
    const alertBlock = wireSrc.slice(wireSrc.indexOf('new-entity wire needs an operating agreement'));
    ok(/notifyAppStaffThread\(appId,\s*\{\s*type:\s*'draw'/.test(alertBlock),
      'draw-wire.js routes the new-entity alert through notifyAppStaffThread(type:draw)');
    ok(!/notifyAppStaff\(appId,\s*\{\s*\n\s*type:\s*'condition_added'/.test(alertBlock),
      '…and no longer through the old notifyAppStaff(condition_added)');
  }

  // -------------------------------------------------------------------------
  console.log('\n8b. A TPO BROKER is never a recipient of an internal draw thread or draw loop-in');
  // -------------------------------------------------------------------------
  // On a TPO file the loan_officer IS the external broker (TPO identity model). The broker's
  // visibility is the /api/tpo surface ONLY — they must never receive an internal-format staff
  // draw thread (note-buyer names, internal money) nor be looped into a draw email. This pins the
  // is_external=false filter on notifyAppStaffThread + the draw-recipient resolvers (firm-isolation
  // is the #1 TPO risk, CLAUDE.md). notifyStaff's external early-return does NOT cover the thread
  // path — it emails a direct To list — so the filter has to live on the query itself.
  {
    const firmId = (await db.query(`INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`Firm ${TAG}`])).rows[0].id;
    ids.firms.push(firmId);
    const brokerId = crypto.randomUUID();
    const brokerEmail = E('broker');
    await db.query(
      `INSERT INTO staff_users (id, email, full_name, role, is_active, is_external, tpo_firm_id)
       VALUES ($1,$2,'Broker Bob','tpo_officer',true,true,$3)`, [brokerId, brokerEmail, firmId]);
    ids.staff.push(brokerId);
    // Our internal account-executive on the same file — this one MUST stay reachable on staff threads.
    const ae = await seedStaff('loan_officer', 'aeInternal');
    const tpoApp = await seedApp({ borrowerId: borrower.id, officerId: brokerId });
    await db.query(`UPDATE applications SET is_tpo=true, tpo_firm_id=$2 WHERE id=$1`, [tpoApp, firmId]);
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'account_executive',false)
       ON CONFLICT DO NOTHING`, [tpoApp, ae.id]);

    const loEmails = await dr.fileLoanOfficerEmails(tpoApp);
    ok(!loEmails.includes(brokerEmail), 'fileLoanOfficerEmails EXCLUDES the external broker (never looped into a draw email)');
    const loopT = await dr.drawLoopInBcc(tpoApp);
    ok(!loopT.includes(brokerEmail), 'drawLoopInBcc EXCLUDES the external broker');
    ok(loopT.includes(dr.DRAW_DESK_INBOX), '…while the internal draws@ desk is still on it');

    // The internal STAFF draw thread must reach our AE but NEVER the broker.
    sends = [];
    await notify.notifyAppStaffThread(tpoApp, { type: 'draw_inbound', title: 'A draw was inspected', body: 'internal', applicationId: tpoApp });
    await notify.drainEmails();
    const allTo = new Set();
    for (const c of sends) for (const e of [].concat(c.to || [])) allTo.add(lower(e));
    ok(!allTo.has(brokerEmail), 'notifyAppStaffThread never puts the external broker on the To of an internal draw thread');
    ok(allTo.has(ae.email), '…while our internal account-executive on the file IS reached (the thread is not vacuously empty)');
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
}

main()
  .catch((e) => { console.error(e); fail++; })
  .then(async () => {
    emailMod.sendMail = realSendMail;
    try { await notify.drainEmails(); } catch (_) {}
    for (const a of ids.apps) {
      await db.query(`DELETE FROM sent_emails WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM email_messages WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [a]).catch(() => {});
    }
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [ids.borrowers]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [ids.staff]).catch(() => {});
    // Firms LAST — applications + staff_users carry a tpo_firm_id FK into tpo_firms.
    await db.query(`DELETE FROM tpo_firms WHERE id = ANY($1)`, [ids.firms]).catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(fail === 0 ? 0 : 1);
  });
