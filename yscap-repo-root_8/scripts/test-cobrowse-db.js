'use strict';
/**
 * CO-BROWSING (Phase A) — the consent register, the permission rule, the doors and
 * the WebSocket hub, against a REAL Postgres and REAL HTTP + a REAL `ws` client.
 *
 * Skips (exit 0) without DATABASE_URL. Proves:
 *   A. permission rule — who may ask to watch whom (super admin any; staff ↔ staff;
 *      LO only own borrowers; never self, never a borrower as viewer, never a TPO,
 *      never a borrower with no login; outside-scope reads as "no such person");
 *   B. lifecycle over HTTP — request → the guest's pending list → decline / accept →
 *      status → end by either party; nobody else may answer; one watcher per screen;
 *      a second request by the same viewer supersedes the first;
 *   C. the hub — a viewer's socket is refused before consent; after consent the
 *      guest's rrweb batches reach the viewer byte-for-byte; a viewer's control
 *      message is refused (Phase A is watch-only); ending the session closes both
 *      sockets with the reason; a stranger's token is refused; an impersonation
 *      token is refused;
 *   D. sign-out ends the session; the audit rows exist; the screen is never stored.
 */
const path = require('path');
if (!process.env.DATABASE_URL) { console.log('SKIP test-cobrowse-db: DATABASE_URL not set'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.EMAIL_PROVIDER = 'none';
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const hub = require('../src/lib/cobrowse/hub');
const S = require('../src/lib/cobrowse/sessions');

let failures = 0, passes = 0;
function assert(c, msg) { if (c) { passes++; console.log('PASS', msg); } else { failures++; console.log('FAIL', msg); } }
const uid = () => crypto.randomUUID();
const tag = Date.now().toString(36);

async function main() {
  await require('../src/migrate-boot').ensureSchema();
  const server = http.createServer(app);
  hub.attach(server);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, data };
  };

  // ── fixtures ──────────────────────────────────────────────────────────────
  const firmId = (await db.query(`INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`Firm ${tag}`])).rows[0].id;
  const mk = async (role, name, extra = {}) => {
    const r = await db.query(
      `INSERT INTO staff_users (email, full_name, role, password_hash, is_active, is_external, tpo_firm_id, token_version)
       VALUES ($1,$2,$3,'x',true,$4,$5,3) RETURNING id, role, token_version`,
      [`cb-${tag}-${name}@example.test`, `${name} ${tag}`, role, !!extra.external, extra.external ? firmId : null]);
    return r.rows[0];
  };
  const superAdmin = await mk('super_admin', 'Super');
  const lo = await mk('loan_officer', 'Officer');
  const lo2 = await mk('loan_officer', 'Other');
  const proc = await mk('processor', 'Processor');
  const inactive = await mk('processor', 'Gone'); await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [inactive.id]);
  const broker = await mk('tpo_officer', 'Broker', { external: true });
  const tok = (u, kind = 'staff') => C.signJwt({ sub: String(u.id), kind, role: u.role, tv: u.token_version || 0, sid: uid() }, 3600);

  // A borrower with a login, on the LO's file; a second borrower on nobody's file; a third with no login.
  const mkBorrower = async (name, withLogin) => {
    const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Rrower',$2) RETURNING id`, [name, `cb-${tag}-${name}@b.test`])).rows[0];
    if (withLogin) await db.query(`INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',5)`, [b.id]);
    return { id: b.id, role: 'borrower', token_version: withLogin ? 5 : 0 };
  };
  const bo = await mkBorrower('Bo', true);
  const stranger = await mkBorrower('Stranger', true);
  const nologin = await mkBorrower('Nologin', false);
  const appRow = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, status, property_address, program, loan_type)
     VALUES ($1,$2,'file_intake','{"line1":"9 Watch Ave","city":"Town","state":"NJ","zip":"07001"}','Fix & Flip','Purchase') RETURNING id`,
    [bo.id, lo.id])).rows[0];

  // ── A. permission rule ────────────────────────────────────────────────────
  console.log('A. who may watch whom');
  let m = await S.mayWatch({ kind: 'staff', id: superAdmin.id, role: 'super_admin' }, { kind: 'staff', id: proc.id });
  assert(m.ok, 'super admin may watch a teammate');
  m = await S.mayWatch({ kind: 'staff', id: superAdmin.id, role: 'super_admin' }, { kind: 'borrower', id: stranger.id });
  assert(m.ok, 'super admin may watch any borrower with a login');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'staff', id: proc.id });
  assert(m.ok, 'a loan officer may watch a teammate (team ↔ team, with consent)');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'borrower', id: bo.id });
  assert(m.ok && m.target.kind === 'borrower', 'a loan officer may watch their OWN borrower');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'borrower', id: stranger.id });
  assert(!m.ok && m.code === 'no_such_target' && !/exist/i.test(m.message), 'a borrower outside the officer\'s scope reads as "not yours" — same words as non-existent (no probing)');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'borrower', id: uid() });
  assert(!m.ok && m.code === 'no_such_target', 'a non-existent borrower gets the identical refusal');
  m = await S.mayWatch({ kind: 'staff', id: superAdmin.id, role: 'super_admin' }, { kind: 'borrower', id: nologin.id });
  assert(!m.ok && m.code === 'no_login', 'a borrower with no portal login has no screen to watch (409 shape)');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'staff', id: lo.id });
  assert(!m.ok && m.code === 'self', 'you cannot watch yourself');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'staff', id: inactive.id });
  assert(!m.ok, 'a deactivated teammate cannot be watched');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'staff', id: broker.id });
  assert(!m.ok, 'a TPO broker (external) cannot be watched');
  m = await S.mayWatch({ kind: 'staff', id: broker.id, role: 'tpo_officer' }, { kind: 'staff', id: lo.id });
  assert(!m.ok && m.code === 'not_staff', 'a TPO broker cannot be a viewer');
  m = await S.mayWatch({ kind: 'borrower', id: bo.id }, { kind: 'staff', id: lo.id });
  assert(!m.ok && m.code === 'not_staff', 'a borrower can never be a viewer');
  m = await S.mayWatch({ kind: 'staff', id: lo.id, role: 'loan_officer' }, { kind: 'tpo', id: broker.id });
  assert(!m.ok && m.code === 'bad_target', 'an unknown kind is refused');

  // ── B. lifecycle over HTTP ────────────────────────────────────────────────
  console.log('B. request → consent → end, over HTTP');
  const loTok = tok(lo), procTok = tok(proc), lo2Tok = tok(lo2), boTok = tok(bo, 'borrower'), saTok = tok(superAdmin);
  let r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: proc.id }, loTok);
  assert(r.status === 200 && r.data.session && r.data.session.status === 'requested', `a request is recorded as requested (got ${r.status})`);
  const s1 = r.data.session.id;
  assert(r.data.session.expiresAt && new Date(r.data.session.expiresAt) > new Date(), 'a request carries an expiry');
  assert(r.data.session.controlAvailable === false, 'Phase A says plainly: no control');

  r = await call('GET', '/api/cobrowse/mine', null, procTok);
  assert(r.status === 200 && r.data.pending.some((p) => p.id === s1), 'the watched person sees the request in their pending list');
  assert(r.data.pending[0].viewer.name.startsWith('Officer'), 'the prompt names WHO is asking');
  r = await call('GET', '/api/cobrowse/mine', null, lo2Tok);
  assert(r.status === 200 && !r.data.pending.some((p) => p.id === s1), 'nobody else sees it');

  r = await call('POST', `/api/cobrowse/${s1}/respond`, { accept: true }, lo2Tok);
  assert(r.status === 403, `only the person being asked can answer (got ${r.status})`);
  r = await call('POST', `/api/cobrowse/${s1}/respond`, { accept: false }, procTok);
  assert(r.status === 200 && r.data.session.status === 'declined', 'the watched person can decline');
  r = await call('POST', `/api/cobrowse/${s1}/respond`, { accept: true }, procTok);
  assert(r.status === 409, 'a declined request cannot be accepted afterwards');

  // Accept path.
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: proc.id }, loTok);
  const s2 = r.data.session.id;
  r = await call('POST', `/api/cobrowse/${s2}/respond`, { accept: true }, procTok);
  assert(r.status === 200 && r.data.session.status === 'active' && r.data.session.consentedAt, 'accept makes the session active with a consent stamp');
  r = await call('GET', `/api/cobrowse/${s2}`, null, loTok);
  assert(r.status === 200 && r.data.session.isViewer && !r.data.session.isWatched && r.data.wsPath === '/ws/cobrowse', 'the viewer reads the session and where to connect');
  r = await call('GET', `/api/cobrowse/${s2}`, null, lo2Tok);
  assert(r.status === 403, 'a third party cannot read the session');

  // One watcher per screen.
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: proc.id }, lo2Tok);
  assert(r.status === 409 && r.data.code === 'busy' && /Officer/.test(r.data.error), `a second viewer is refused while somebody is watching (got ${r.status})`);

  // A viewer inside a view-as cannot ask — a REAL staff-view session, minted by the real door.
  const sv = await call('POST', '/api/staff-view/start', { staffId: proc.id }, saTok);
  assert(sv.status === 200 && sv.data.token, `a real staff-view token was minted for the test (got ${sv.status})`);
  const impTok = sv.data.token;
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: lo.id }, impTok);
  // Two walls refuse this, and whichever fires first is correct: the console-wide
  // staff-view read-only guard (src/lib/staff-view.js, mounted above every router,
  // answers {staffViewReadOnly:true}) or this router's own notInsideAView (code
  // inside_view — the one that bites for a BORROWER view, whose guard blocks almost
  // nothing). Either way the request never reaches the register.
  assert(r.status === 403 && (r.data.code === 'inside_view' || r.data.staffViewReadOnly === true),
    `nobody inside a view-as may ask to co-browse (got ${r.status} ${r.data && (r.data.code || (r.data.staffViewReadOnly && 'staffViewReadOnly'))})`);
  await call('POST', '/api/staff-view/exit', null, impTok);

  // Borrower target, with the LO's file recorded.
  r = await call('POST', '/api/cobrowse/request', { kind: 'borrower', id: bo.id, applicationId: appRow.id }, saTok);
  assert(r.status === 200 && r.data.session.applicationId === appRow.id, 'a borrower request records the file it came from');
  const s3 = r.data.session.id;
  r = await call('GET', '/api/cobrowse/mine', null, boTok);
  assert(r.status === 200 && r.data.pending.some((p) => p.id === s3), 'the borrower sees the prompt with their own token');
  r = await call('POST', `/api/cobrowse/${s3}/respond`, { accept: true }, boTok);
  assert(r.status === 200 && r.data.session.status === 'active', 'the borrower accepts');
  r = await call('POST', `/api/cobrowse/${s3}/end`, null, boTok);
  assert(r.status === 200 && r.data.session.status === 'ended' && r.data.session.endReason === 'stopped_by_guest', 'the borrower can stop it at any time, and the reason says who stopped it');
  r = await call('POST', '/api/cobrowse/request', { kind: 'borrower', id: stranger.id }, loTok);
  assert(r.status === 403, 'a loan officer cannot request a borrower outside their scope');
  r = await call('POST', '/api/cobrowse/request', { kind: 'borrower', id: nologin.id }, saTok);
  assert(r.status === 409 && r.data.code === 'no_login', 'a borrower with no login → 409 no_login');

  // ── C. the hub ────────────────────────────────────────────────────────────
  console.log('C. the live channel');
  const wsUrl = (t, sid, role) => `ws://127.0.0.1:${port}/ws/cobrowse?token=${encodeURIComponent(t)}&session=${sid}&role=${role}`;
  const open = (url) => new Promise((resolve) => {
    const ws = new WebSocket(url); const msgs = [];
    ws.on('message', (d) => msgs.push(String(d)));
    ws.on('open', () => resolve({ ws, msgs, closed: null }));
    ws.on('close', (code, reason) => { resolve({ ws, msgs, closed: { code, reason: String(reason) } }); });
    ws.on('error', () => {});
  });
  const waitFor = (msgs, pred, ms = 2500) => new Promise((resolve) => {
    const t0 = Date.now(); const tick = () => { if (msgs.some(pred)) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(tick, 25); }; tick();
  });
  const closeCode = (ws) => new Promise((resolve) => { if (ws.readyState === 3) return resolve(ws._closeCode || null); ws.once('close', (c) => resolve(c)); setTimeout(() => resolve(null), 2500); });

  // A session that is still 'requested': the viewer's socket is refused.
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: lo2.id }, saTok);
  const s4 = r.data.session.id;
  let c = await open(wsUrl(saTok, s4, 'viewer'));
  let code = c.closed ? c.closed.code : await closeCode(c.ws);
  assert(code === 4404, `before consent the viewer's socket is closed 4404 (got ${code})`);
  r = await call('POST', `/api/cobrowse/${s4}/respond`, { accept: true }, lo2Tok);
  assert(r.status === 200, 'lo2 accepts');

  // Wrong role / wrong person / bad token.
  c = await open(wsUrl(procTok, s4, 'viewer'));
  code = c.closed ? c.closed.code : await closeCode(c.ws);
  assert(code === 4403, `a stranger cannot attach as viewer (got ${code})`);
  c = await open(wsUrl(saTok, s4, 'guest'));
  code = c.closed ? c.closed.code : await closeCode(c.ws);
  assert(code === 4403, `the viewer cannot attach as the guest (got ${code})`);
  c = await open(wsUrl('not-a-token', s4, 'viewer'));
  code = c.closed ? c.closed.code : await closeCode(c.ws);
  assert(code === 4401, `a bad token is refused 4401 (got ${code})`);
  c = await open(wsUrl(impTok, s4, 'viewer'));
  code = c.closed ? c.closed.code : await closeCode(c.ws);
  assert(code === 4401, `an impersonation (view-as) token is refused (got ${code})`);
  const upgradeElsewhere = await new Promise((resolve) => { const w = new WebSocket(`ws://127.0.0.1:${port}/ws/other?token=x`); w.on('error', () => resolve('refused')); w.on('open', () => resolve('opened')); setTimeout(() => resolve('timeout'), 2500); });
  assert(upgradeElsewhere === 'refused', 'an upgrade on any other path is refused');

  // The real pair.
  const viewer = await open(wsUrl(saTok, s4, 'viewer'));
  assert(!viewer.closed, 'the viewer attaches once consent is given');
  assert(await waitFor(viewer.msgs, (m) => m.includes('"t":"hello"') && m.includes('"guestOnline":false')), 'the viewer is told the guest is not online yet');
  const guest = await open(wsUrl(lo2Tok, s4, 'guest'));
  assert(!guest.closed, 'the watched person attaches as the guest');
  assert(await waitFor(guest.msgs, (m) => m.includes('"t":"snapshot"')), 'a guest joining with a viewer waiting is asked for a full snapshot');
  assert(await waitFor(viewer.msgs, (m) => m.includes('"t":"guest_online"')), 'the viewer is told the guest came online');
  const batch = JSON.stringify({ t: 'rrweb', events: [{ type: 2, data: { node: { type: 0, childNodes: [] } }, timestamp: Date.now() }, { type: 3, data: { source: 1, positions: [{ x: 10, y: 20, id: 1, timeOffset: 0 }] }, timestamp: Date.now() }] });
  guest.ws.send(batch);
  assert(await waitFor(viewer.msgs, (m) => m === batch), 'a guest batch reaches the viewer byte-for-byte');
  guest.ws.send(JSON.stringify({ t: 'control', action: 'click', id: 1 }));
  await new Promise((rr) => setTimeout(rr, 150));
  assert(!viewer.msgs.some((m) => m.includes('"t":"control"')), 'an unknown guest message type is dropped, never relayed');
  const before = viewer.msgs.length;
  viewer.ws.send(JSON.stringify({ t: 'click', id: 1, x: 5, y: 5 }));
  assert(await waitFor(viewer.msgs, (m) => m.includes('"not_allowed"')), 'a viewer trying to CONTROL is refused — Phase A is watch-only');
  assert(!guest.msgs.some((m) => m.includes('"t":"click"')), 'and nothing reached the guest');
  viewer.ws.send(JSON.stringify({ t: 'snapshot' }));
  assert(await waitFor(guest.msgs, (m, i) => i > 0 && m.includes('"t":"snapshot"')), 'a viewer may ask the guest for a fresh snapshot');
  void before;
  const st = hub.stats();
  assert(st.rooms >= 1 && st.guests >= 1 && st.viewers >= 1, `stats report the live room (${JSON.stringify(st)})`);

  // Ending closes both with the reason.
  r = await call('POST', `/api/cobrowse/${s4}/end`, null, saTok);
  assert(r.status === 200 && r.data.session.endReason === 'stopped_by_viewer', 'the viewer ends it; the reason says so');
  assert(await waitFor(viewer.msgs, (m) => m.includes('"t":"ended"') && m.includes('stopped_by_viewer')), 'the viewer socket is told the session ended and why');
  assert(await waitFor(guest.msgs, (m) => m.includes('"t":"ended"')), 'the guest socket is told too');
  await new Promise((rr) => setTimeout(rr, 200));
  assert(viewer.ws.readyState >= 2 && guest.ws.readyState >= 2, 'both sockets are closed by the server');
  assert(!hub._internals.rooms.has(s4), 'the room is forgotten');
  const cnt = (await db.query(`SELECT event_batches, started_at FROM cobrowse_sessions WHERE id=$1`, [s4])).rows[0];
  assert(cnt.started_at && Number(cnt.event_batches) >= 1, 'the register recorded that the guest connected and how many batches flowed');

  // ── D. sign-out, audit, no screen stored ──────────────────────────────────
  console.log('D. sign-out, the audit trail, and what is NOT stored');
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: proc.id }, loTok);
  const s5 = r.data.session.id;
  await call('POST', `/api/cobrowse/${s5}/respond`, { accept: true }, procTok);
  r = await call('POST', '/auth/logout', null, procTok);
  await new Promise((rr) => setTimeout(rr, 300));
  const s5row = (await db.query(`SELECT status, end_reason FROM cobrowse_sessions WHERE id=$1`, [s5])).rows[0];
  assert(s5row.status === 'ended' && s5row.end_reason === 'signed_out', `the watched person signing out ends the session (got ${s5row.status}/${s5row.end_reason})`);
  const au = await db.query(`SELECT action FROM audit_log WHERE entity_type='cobrowse_session' AND entity_id=$1 ORDER BY id`, [s2]);
  assert(au.rows.map((x) => x.action).join(',') === 'cobrowse_requested,cobrowse_accepted', `the register audits request and consent (got ${au.rows.map((x) => x.action).join(',')})`);
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='cobrowse_sessions'`)).rows.map((x) => x.column_name);
  assert(!cols.some((cn) => /event|snapshot|dom|screen|payload/.test(cn) && cn !== 'event_batches'), 'the table has no column that could hold the screen — retention is metadata only');
  const hist = await call('GET', '/api/cobrowse/history', null, saTok);
  assert(hist.status === 200 && hist.data.sessions.length >= 5, 'a super admin reads the whole register');
  const hist2 = await call('GET', '/api/cobrowse/history', null, lo2Tok);
  assert(hist2.status === 200 && hist2.data.sessions.every((x) => x.viewer.id === lo2.id || x.watched.id === lo2.id), 'everybody else reads only the sessions they were party to');

  // a stale request expires by the sweep
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: lo2.id }, loTok);
  const s6 = r.data.session.id;
  await db.query(`UPDATE cobrowse_sessions SET requested_at = now() - interval '10 minutes' WHERE id=$1`, [s6]);
  const sw = await S.sweep();
  const s6row = (await db.query(`SELECT status, end_reason FROM cobrowse_sessions WHERE id=$1`, [s6])).rows[0];
  assert(sw.expiredRequests >= 1 && s6row.status === 'expired' && s6row.end_reason === 'request_expired', 'a request nobody answered expires on its own');

  // cleanup
  await db.query(`DELETE FROM cobrowse_sessions WHERE viewer_staff_id IN ($1,$2,$3,$4)`, [superAdmin.id, lo.id, lo2.id, proc.id]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appRow.id]);
  await db.query(`DELETE FROM borrower_auth WHERE borrower_id IN ($1,$2)`, [bo.id, stranger.id]);
  await db.query(`DELETE FROM borrowers WHERE id IN ($1,$2,$3)`, [bo.id, stranger.id, nologin.id]);
  await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`cb-${tag}-%`]);
  await db.query(`DELETE FROM tpo_firms WHERE id=$1`, [firmId]);
  server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
