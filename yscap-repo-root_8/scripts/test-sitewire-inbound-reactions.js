'use strict';
/**
 * Bidirectional Phase 1 — PILOT reacts to inbound Sitewire changes. Drives reconcileOne against a
 * stubbed Sitewire client and asserts: the first reconcile BASELINES silently (no notification burst),
 * a genuinely new draw notifies the team, a real status transition notifies once + audits + advances
 * the watermark, and the same status never re-fires. DB-gated skip.
 *
 * AND THE TWO EVENTS ARE TOLD APART (owner-reported 2026-08-20: "he just clicks
 * Start, and he's starting to take pictures … our draw department is getting an
 * email right away … it sounds for our team that this is an actual draw request
 * that he submitted already"). Pressing Start CREATES the draw row in a DRAFT
 * status, so a first-seen draw is very often a draft — and this file used to
 * ASSERT the old behaviour, expecting a `draw_inbound` "new draw request" on a
 * `pending_borrower` draw. It now pins the split end to end:
 *   · a first-seen DRAFT   → a `draw_draft_started` in-app row, NO email, and NO
 *                            `draw_inbound` (the misleading one);
 *   · that draw SUBMITTED  → a `draw_inbound` that says "submitted for review",
 *                            and that one DOES email;
 *   · a first-seen draw that is ALREADY submitted → straight to `draw_inbound`.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sitewire-inbound-reactions (no DATABASE_URL)'); process.exit(0); }
process.env.SITEWIRE_ENABLED = process.env.SITEWIRE_ENABLED || '1';
const db = require('../src/db');
const client = require('../src/sitewire/client');
const email = require('../src/lib/email');
const notify = require('../src/lib/notify');
const reconcile = require('../src/sitewire/reconcile');

// THE WIRE, CAPTURED. "The desk was not emailed" is the owner's actual complaint,
// and a notifications row cannot prove it — only what reached the mailer can.
const sent = [];
const realSend = email.sendMail;
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const subjects = () => sent.map((m) => String(m.subject || ''));
let P = 0, F = 0;
const R = Math.floor(Math.random() * 900000) + 100000;
const PROP = 4000000 + R, D1 = 5000000 + R, D2 = 6000000 + R;
function ok(c, m) { c ? (P++, console.log('  ok -', m)) : (F++, console.log('  FAIL -', m)); }

// mutable stub state
let DRAWS = [];
client.getProperty = async () => ({ id: PROP, budget: { id: 1, draws: DRAWS } });
client.getDraw = async (id) => { const d = DRAWS.find((x) => x.id === id) || {}; return { ...d, requests: [], draw_events: [] }; };

async function inboundCount(appId, field, reacted) {
  const r = await db.query(`SELECT count(*)::int c FROM sitewire_pull_field_change WHERE application_id=$1 AND field=$2 AND reacted=$3`, [appId, field, reacted]);
  return r.rows[0].c;
}
async function notifyCount(appId, type = 'draw_inbound') {
  const r = await db.query(`SELECT count(*)::int c FROM notifications WHERE application_id=$1 AND type=$2`, [appId, type]);
  return r.rows[0].c;
}
async function latestBody(appId, type) {
  const r = await db.query(
    `SELECT title, body FROM notifications WHERE application_id=$1 AND type=$2 ORDER BY created_at DESC, id DESC LIMIT 1`, [appId, type]);
  return r.rows[0] || { title: '', body: '' };
}

(async () => {
  const ids = []; let staffId;
  try {
    const st = (await db.query(`INSERT INTO staff_users (email,full_name,role,token_version,is_active) VALUES ($1,'Coord','draw_coordinator',0,true) RETURNING id`, [`co${R}@e.com`])).rows[0]; staffId = st.id;
    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('In','Bound',$1) RETURNING id`, [`ib${R}@e.com`])).rows[0];
    const a = (await db.query(`INSERT INTO applications (borrower_id,status,loan_officer_id,property_address) VALUES ($1,'funded',$2,'{"oneLine":"5 Sync St"}') RETURNING id`, [b.id, staffId])).rows[0];
    ids.push(a.id);
    await db.query(`INSERT INTO sitewire_property_links (application_id,sitewire_property_id,matched_by,pushed_at) VALUES ($1,$2,'created',now())`, [a.id, PROP]);
    // ensure the coordinator is an assignee so notifyAppStaff has a recipient (trigger mirrors loan_officer_id, but assert)
    await db.query(`INSERT INTO application_assignees (application_id,staff_id,role) VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [a.id, staffId]).catch(() => {});

    // --- A: FIRST reconcile baselines silently ---
    DRAWS = [{ id: D1, number: 1, status: 'pending_borrower', total_requested_cents: 100000, total_approved_cents: 0 }];
    await reconcile.reconcileOne(a.id);
    ok((await notifyCount(a.id)) === 0, 'first reconcile: NO notification (baseline)');
    ok((await inboundCount(a.id, 'baseline', false)) === 1, 'first reconcile: baseline audit recorded');
    let sync = (await db.query(`SELECT status_synced FROM sitewire_draws WHERE sitewire_draw_id=$1`, [D1])).rows[0];
    ok(sync && sync.status_synced === 'pending_borrower', 'watermark baselined to current status');

    // --- B: a borrower presses START. The draw row appears in a DRAFT status. ---
    sent.length = 0;
    DRAWS.push({ id: D2, number: 2, status: 'pending_borrower', total_requested_cents: 50000, total_approved_cents: 0 });
    await reconcile.reconcileOne(a.id);
    await notify.drainEmails();
    ok((await notifyCount(a.id, 'draw_inbound')) === 0,
      'draft started: NO "draw request came in" notification — this is the owner\'s bug');
    ok((await notifyCount(a.id, 'draw_draft_started')) === 1, 'draft started: 1 draft notification fired');
    ok((await inboundCount(a.id, 'new_draw_draft', true)) === 1, 'draft started: new_draw_draft audit (reacted)');
    ok(!subjects().some((x) => /draft/i.test(x)),
      'draft started: NOTHING reached the mailer — the desk is told in-app, not emailed');
    {
      const n = await latestBody(a.id, 'draw_draft_started');
      ok(/draft/i.test(n.title) && /not submitted/i.test(n.title),
        'draft started: the TITLE says draft and not-submitted, before anything else');
      ok(/have not submitted it for review yet/i.test(n.body), 'draft started: the body says so too');
      ok(!/action needed/i.test(n.body), 'draft started: it never claims action is needed');
      ok(!/\$/.test(n.body), 'draft started: no dollar figure — a draft\'s numbers still move');
    }

    // --- B2: they SUBMIT it. THIS is the email the desk is waiting for. ---
    sent.length = 0;
    DRAWS[1].status = 'pending';
    await reconcile.reconcileOne(a.id);
    await notify.drainEmails();
    ok((await notifyCount(a.id, 'draw_inbound')) === 1, 'submitted: the draw_inbound notification fires now');
    ok((await notifyCount(a.id, 'draw_draft_started')) === 1, 'submitted: the draft notice is not repeated');
    {
      const n = await latestBody(a.id, 'draw_inbound');
      ok(/submitted for review/i.test(n.title), 'submitted: the title says "submitted for review"');
      ok(/no longer a draft/i.test(n.body), 'submitted: the body draws the contrast explicitly');
    }
    ok(subjects().some((x) => /submitted for review/i.test(x)),
      'submitted: THIS one reaches the mailer — the desk is emailed when it is real');

    // --- B3: a draw first SEEN already submitted skips the draft notice entirely ---
    sent.length = 0;
    const D3 = D2 + 1;
    DRAWS.push({ id: D3, number: 3, status: 'inspecting', total_requested_cents: 70000, total_approved_cents: 0 });
    await reconcile.reconcileOne(a.id);
    await notify.drainEmails();
    ok((await notifyCount(a.id, 'draw_inbound')) === 2, 'first-seen submitted: goes straight to draw_inbound');
    ok((await notifyCount(a.id, 'draw_draft_started')) === 1, 'first-seen submitted: no draft notice invented');
    ok((await inboundCount(a.id, 'new_draw', true)) === 1, 'first-seen submitted: new_draw audit (reacted)');

    // --- C: a status TRANSITION on draw 1 → approved notifies + advances watermark ---
    DRAWS[0].status = 'approved'; DRAWS[0].total_approved_cents = 90000;
    await reconcile.reconcileOne(a.id);
    ok((await notifyCount(a.id)) === 3, 'transition→approved: 1 more notification');
    ok((await inboundCount(a.id, 'status', true)) === 1, 'transition: status audit (reacted)');
    ok((await inboundCount(a.id, 'total_approved_cents', false)) === 1, 'transition: approved-amount change audited (not reacted)');
    sync = (await db.query(`SELECT status_synced FROM sitewire_draws WHERE sitewire_draw_id=$1`, [D1])).rows[0];
    ok(sync.status_synced === 'approved', 'watermark advanced to approved');

    // --- D: same status again → NO re-fire ---
    await reconcile.reconcileOne(a.id);
    ok((await notifyCount(a.id)) === 3, 'no transition: notification count unchanged (no re-fire)');

    console.log(`\n${P} passed, ${F} failed`);
  } catch (e) { console.error('THREW', e && e.message, e && e.stack); F++; }
  finally {
    // DRAIN BEFORE TEARING DOWN. The reconcile above notifies through routes, and the
    // email fan-out is fire-and-forget (a web request must never wait on an email), so a
    // sent_emails INSERT can still be in flight here — pointing at a notifications row
    // this teardown deletes. The two lock each other and Postgres kills one: deadlock
    // detected (40P01), which fails a suite whose assertions all passed. A no-op when
    // nothing is in flight.
    try { email.sendMail = realSend; } catch (_) {}
    try { await require('../src/lib/notify').drainEmails(); } catch (_) { /* never blocks teardown */ }
    try { for (const id of ids) { await db.query(`DELETE FROM sitewire_pull_field_change WHERE application_id=$1`, [id]); await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [id]); await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [id]); await db.query(`DELETE FROM notifications WHERE application_id=$1`, [id]); const bb = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [id])).rows[0]; await db.query(`DELETE FROM applications WHERE id=$1`, [id]); if (bb) await db.query(`DELETE FROM borrowers WHERE id=$1`, [bb.borrower_id]); } if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    if (F) process.exit(1);
  }
})();
