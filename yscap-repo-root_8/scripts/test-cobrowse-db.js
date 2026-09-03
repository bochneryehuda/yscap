'use strict';
/**
 * CO-BROWSING (Phases A–C) — the consent register, the permission rule, the doors and
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
 *   E. Phase B — take control: the second consent, sanitised + rate-capped input relay,
 *      refusals, 30 s expiry, release on end, the redaction drop, a helper token refused;
 *   F. Phase C — restart recovery (orphaned rows), the view-as wall on /mine.
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
  // A run that died mid-way (a crash, a mutation proof) leaves its rows; clear them
  // so an old 'cb-…' staffer can never make a busy check answer for a fresh one.
  await db.query(`DELETE FROM staff_users WHERE email LIKE 'cb-%@example.test'`).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE email LIKE 'cb-%@b.test'`).catch(() => {});
  // ONLY this suite's own fixtures. `LIKE 'Firm %'` would match a real brokerage in
  // whatever database DATABASE_URL happens to point at — a test may never delete a row
  // it did not create.
  await db.query(`DELETE FROM tpo_firms WHERE name LIKE 'Firm cb-%' AND NOT EXISTS (SELECT 1 FROM staff_users su WHERE su.tpo_firm_id = tpo_firms.id)`).catch(() => {});
  const firmId = (await db.query(`INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`Firm cb-${tag}`])).rows[0].id;
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
  // Retention is metadata only: a column whose NAME suggests content (event, snapshot,
  // dom, screen, payload, key) may exist only as an integer COUNT — never text/jsonb/bytea.
  const colRows = (await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='cobrowse_sessions'`)).rows;
  const suspect = colRows.filter((c) => /event|snapshot|dom|screen|payload|key/.test(c.column_name));
  assert(suspect.length >= 2 && suspect.every((c) => c.data_type === 'integer'), `the table has no column that could hold the screen or a keystroke — only counts (${suspect.map((c) => `${c.column_name}:${c.data_type}`).join(', ')})`);
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

  // ── E. Phase B — take control, a second consent ────────────────────────────
  console.log('E. take control');
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: lo2.id }, saTok);
  assert(r.status === 200, `a fresh request to lo2 (got ${r.status} ${r.data && r.data.error})`);
  const s7 = r.data.session.id;
  // A second viewer asking the SAME person while the first is unanswered is told so (atomic busy).
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: lo2.id }, loTok);
  assert(r.status === 409 && r.data.code === 'busy', `an unanswered request blocks a second asker (got ${r.status} ${r.data && r.data.code})`);
  r = await call('POST', `/api/cobrowse/${s7}/respond`, { accept: true }, lo2Tok);
  assert(r.status === 200 && r.data.session.control.status === 'none' && r.data.session.controlAvailable === true, 'a live session starts with no control, control askable');
  const v7 = await open(wsUrl(saTok, s7, 'viewer'));
  const g7 = await open(wsUrl(lo2Tok, s7, 'guest'));
  assert(!v7.closed && !g7.closed, 'both sides attached');
  assert(await waitFor(v7.msgs, (m) => m.includes('"t":"hello"') && m.includes('"control":"none"')), 'hello carries the control state');
  v7.ws.send(JSON.stringify({ t: 'input', k: 'click', id: 5, x: 1, y: 1 }));
  assert(await waitFor(v7.msgs, (m) => m.includes('"no_control"')), 'an input before control is granted is refused no_control');
  await new Promise((rr) => setTimeout(rr, 100));
  assert(!g7.msgs.some((m) => m.includes('"t":"input"')), 'and nothing reached the guest');
  // Only the viewer may ask; only the watched person may answer.
  r = await call('POST', `/api/cobrowse/${s7}/control/request`, null, lo2Tok);
  assert(r.status === 403, 'the watched person cannot ask for control of their own screen');
  r = await call('POST', `/api/cobrowse/${s7}/control/request`, null, saTok);
  assert(r.status === 200 && r.data.session.control.status === 'requested' && r.data.session.control.expiresAt, 'the viewer asks; the request carries its own expiry');
  assert(await waitFor(g7.msgs, (m) => m.includes('"t":"control"') && m.includes('"requested"')), 'the guest socket hears the request');
  r = await call('POST', `/api/cobrowse/${s7}/control/respond`, { accept: true }, saTok);
  assert(r.status === 403, 'the viewer cannot answer their own control request');
  r = await call('POST', `/api/cobrowse/${s7}/control/respond`, { accept: true }, lo2Tok);
  assert(r.status === 200 && r.data.session.control.status === 'granted' && r.data.session.control.grants === 1, 'the watched person allows control; the grant is counted');
  assert(await waitFor(v7.msgs, (m) => m.includes('"t":"control"') && m.includes('"granted"')), 'the viewer socket hears the grant');
  assert(await waitFor(g7.msgs, (m) => m.includes('"t":"control"') && m.includes('"granted"')), 'the guest socket hears the grant');
  // Now an input flows — sanitised.
  v7.ws.send(JSON.stringify({ t: 'input', k: 'click', id: 5, x: 10, y: 20, evil: '<script>', value: 'x'.repeat(5000) }));
  assert(await waitFor(g7.msgs, (m) => m.includes('"t":"input"') && m.includes('"k":"click"') && m.includes('"id":5')), 'a click reaches the guest addressed by mirror id');
  const relayed = JSON.parse(g7.msgs.find((m) => m.includes('"t":"input"')));
  assert(relayed.evil === undefined && relayed.value.length === 4000 && relayed.x === 10, 'the hub re-serialises only the known fields, sized (unknown field dropped, value capped)');
  v7.ws.send(JSON.stringify({ t: 'input', k: 'launch_missiles', id: 5 }));
  assert(await waitFor(v7.msgs, (m) => m.includes('"bad_input"')), 'an unknown input kind is refused');
  v7.ws.send(JSON.stringify({ t: 'input', k: 'input', id: 5, value: 'y'.repeat(20000) }));
  assert(await waitFor(v7.msgs, (m) => m.includes('"too_large"')), 'an oversize input is refused');
  const beforeBurst = g7.msgs.filter((m) => m.includes('"t":"input"')).length;
  for (let i = 0; i < 90; i++) v7.ws.send(JSON.stringify({ t: 'input', k: 'cursor', x: i, y: i }));
  await new Promise((rr) => setTimeout(rr, 300));
  const burst = g7.msgs.filter((m) => m.includes('"t":"input"')).length - beforeBurst;
  assert(burst > 0 && burst <= hub.INPUT_RATE_PER_SEC, `a burst of 90 inputs in one second is capped at ${hub.INPUT_RATE_PER_SEC} (relayed ${burst})`);
  // The guest takes it back by moving.
  r = await call('POST', `/api/cobrowse/${s7}/control/release`, { reason: 'guest_moved' }, lo2Tok);
  assert(r.status === 200 && r.data.session.control.status === 'released' && r.data.session.control.releaseReason === 'guest_moved', 'the watched person takes control back; the reason is recorded');
  assert(await waitFor(v7.msgs, (m) => m.includes('"t":"control"') && m.includes('"released"')), 'the viewer hears the release');
  v7.ws.send(JSON.stringify({ t: 'input', k: 'click', id: 5 }));
  assert(await waitFor(v7.msgs, (m, i) => i > 3 && m.includes('"no_control"')), 'an input after release is refused again');
  // Refused, then asked again.
  r = await call('POST', `/api/cobrowse/${s7}/control/request`, null, saTok);
  r = await call('POST', `/api/cobrowse/${s7}/control/respond`, { accept: false }, lo2Tok);
  assert(r.status === 200 && r.data.session.control.status === 'refused', 'the watched person may say no');
  r = await call('POST', `/api/cobrowse/${s7}/control/request`, null, saTok);
  assert(r.status === 200 && r.data.session.control.status === 'requested', 'a refusal does not stop a later ask');
  // A control request nobody answers cancels itself.
  await db.query(`UPDATE cobrowse_sessions SET control_requested_at = now() - interval '2 minutes' WHERE id=$1`, [s7]);
  const swC = await S.sweep({ liveIds: new Set(hub._internals.rooms.keys()) });
  const s7c = (await db.query(`SELECT control_status, control_release_reason FROM cobrowse_sessions WHERE id=$1`, [s7])).rows[0];
  assert(swC.expiredControlRequests >= 1 && s7c.control_status === 'released' && s7c.control_release_reason === 'request_expired', 'an unanswered control request expires on its own (30 s)');
  // Granted, then the session ends: control ends with it.
  await call('POST', `/api/cobrowse/${s7}/control/request`, null, saTok);
  await call('POST', `/api/cobrowse/${s7}/control/respond`, { accept: true }, lo2Tok);
  // THE GUEST'S BYTES ARE RELAYED UNCONDITIONALLY, and that is the fix for the blank mirror
  // (owner-reported 2026-09-02). An rrweb stream is stateful, so a server that DROPS a batch
  // desynchronises the mirror for good — and the batch a content check most wants to refuse
  // is the FULL SNAPSHOT, which is where a printed Social Security number actually lives. The
  // MASK (proven in a real browser by render-cobrowse-mask.js) is what keeps a secret out.
  // This asserts the DECISION: re-add a drop and it fails.
  g7.ws.send(JSON.stringify({ t: 'rrweb', events: [{ type: 3, data: { source: 0, texts: [{ id: 9, value: 'SSN 123-45-6789' }] }, timestamp: Date.now() }] }));
  assert(await waitFor(v7.msgs, (m) => m.includes('123-45-6789')), 'a batch is relayed whatever it carries — nothing is held back');
  assert(!v7.msgs.some((m) => m.includes('"kind":"redacted"')), 'no viewer is ever told a frame was held back');
  g7.ws.send(JSON.stringify({ t: 'rrweb', events: [{ type: 3, data: { source: 0, texts: [{ id: 9, value: 'Loan 2125551234 at 10.25%' }] }, timestamp: Date.now() }] }));
  assert(await waitFor(v7.msgs, (m) => m.includes('2125551234')), 'an ordinary batch (phone, rate) is relayed untouched');
  // A FULL SNAPSHOT is the one batch that must never be refused: every later mutation is
  // expressed against the node ids it establishes, so losing it blanks the mirror forever.
  g7.ws.send(JSON.stringify({ t: 'rrweb', events: [{ type: 2, data: { node: { id: 1, type: 0 }, initialOffset: { top: 0, left: 0 } }, timestamp: Date.now() }] }));
  assert(await waitFor(v7.msgs, (m) => m.includes('"type":2')), 'a FULL SNAPSHOT always reaches the viewer');
  // ⛔ AND A BIG ONE REACHES IT TOO. The assertions above prove no CONTENT check drops a
  // batch; the post-merge audit (2026-09-02) showed they say nothing about a SIZE one. It
  // added `if (text.length > 200000) { r.pendingBatches += 1; return; }` immediately before
  // the relay — the most plausible well-intentioned reintroduction there is — and both
  // suites stayed green (pure 217/0, this one 112/0) while the mirror blanked exactly as
  // before. A real full snapshot of a busy page runs to hundreds of kilobytes, so a cap in
  // that range refuses precisely the batch that must never be refused.
  //
  // This sends a genuinely large snapshot — comfortably over any cap somebody would think
  // to write, and still far under the hub's own 4 MB MAX_MESSAGE_BYTES, which is a
  // connection-level refusal and a different thing — and requires it to arrive WHOLE.
  const bigTag = `big-${tag}`;
  const filler = 'x'.repeat(600000);   // ~0.6 MB: 3x the audit's cap, well under MAX_MESSAGE_BYTES
  const bigSnapshot = JSON.stringify({ t: 'rrweb', events: [{ type: 2, data: { node: { id: 1, type: 0, filler }, initialOffset: { top: 0, left: 0 } }, timestamp: Date.now(), marker: bigTag }] });
  assert(bigSnapshot.length > 500000, `the large-snapshot fixture really is large (${bigSnapshot.length} bytes)`);
  g7.ws.send(bigSnapshot);
  assert(await waitFor(v7.msgs, (m) => m.includes(bigTag), 6000),
    `a LARGE full snapshot (${bigSnapshot.length} bytes) reaches the viewer — no size cap may drop a batch`);
  const gotBig = v7.msgs.find((m) => m.includes(bigTag));
  assert(gotBig.length === bigSnapshot.length,
    `it arrives byte-for-byte, not truncated (sent ${bigSnapshot.length}, got ${gotBig.length})`);
  assert(gotBig === bigSnapshot, 'and unaltered — the hub relays the guest\'s own bytes');
  r = await call('POST', `/api/cobrowse/${s7}/end`, null, lo2Tok);
  assert(r.status === 200, 'the watched person ends the session');
  await new Promise((rr) => setTimeout(rr, 250));
  const s7row = (await db.query(`SELECT status, control_status, control_release_reason, control_grants, control_events, redaction_drops FROM cobrowse_sessions WHERE id=$1`, [s7])).rows[0];
  assert(s7row.status === 'ended' && s7row.control_status === 'released' && s7row.control_release_reason === 'session_ended', 'ending the session releases control in the same write');
  assert(Number(s7row.control_grants) === 2 && Number(s7row.control_events) >= 1, `the register holds the counts: grants=${s7row.control_grants} events=${s7row.control_events}`);
  // db/683's counter column is left in place (this repo never drops a column) and is written
  // by nothing now that the content guard is gone.
  assert(Number(s7row.redaction_drops) === 0, 'nothing writes the retired redaction counter');
  const auC = await db.query(`SELECT action FROM audit_log WHERE entity_type='cobrowse_session' AND entity_id=$1 AND action LIKE 'cobrowse_control%' ORDER BY id`, [s7]);
  assert(auC.rows.length >= 6 && auC.rows.some((x) => x.action === 'cobrowse_control_granted') && auC.rows.some((x) => x.action === 'cobrowse_control_released'), `every control step is audited (${auC.rows.length} rows)`);


  // ── C6. A SOCKET IS NOT AUTHENTICATED ONCE ────────────────────────────────
  // Post-merge audit, 2026-09-02: `actorFromToken` ran at connect and NEVER again.
  // Every HTTP request from a deactivated staffer died at the next call, while
  // their already-open viewer socket kept receiving the watched person's live
  // screen — until the socket happened to drop, the guest pressed Stop, or the
  // four-hour cap fired. The same held for a borrower who reset their password
  // expecting the watching to stop. Nothing in either suite noticed, because
  // both only ever tested the door and never the room.
  //
  // Proven here by a socket ACTUALLY CLOSING, on the real hub, over a real
  // WebSocket — never by reading the source.
  console.log('C6. a live socket is re-checked, not trusted for ever');
  {
    const watcher = await mk('super_admin', 'Watcher');
    const watched = await mk('loan_officer', 'Watched');
    const wTok = tok(watcher), dTok = tok(watched);
    r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: watched.id }, wTok);
    assert(r.status === 200, 'a session is requested for the re-check case');
    const s8 = r.data.session.id;
    r = await call('POST', `/api/cobrowse/${s8}/respond`, { accept: true }, dTok);
    assert(r.status === 200, 'the watched person accepts');
    const g8 = await open(wsUrl(dTok, s8, 'guest'));
    const v8 = await open(wsUrl(wTok, s8, 'viewer'));
    assert(await waitFor(v8.msgs, (m) => m.includes('"t":"hello"')), 'the viewer is attached and watching');
    g8.ws.send(JSON.stringify({ t: 'rrweb', events: [{ type: 3, data: { source: 0, texts: [{ id: 1, value: 'before-revoke' }] }, timestamp: Date.now() }] }));
    assert(await waitFor(v8.msgs, (m) => m.includes('before-revoke')), 'the screen is genuinely streaming to it');

    // A HEARTBEAT ON A HEALTHY SESSION CLOSES NOTHING. Without this the assertion
    // below would pass just as well for a heartbeat that hung up on everyone.
    await hub._internals.heartbeat();
    await new Promise((rr) => setTimeout(rr, 120));
    assert(v8.ws.readyState === 1 && g8.ws.readyState === 1,
      'a heartbeat leaves an authorised viewer and guest exactly where they were');
    g8.ws.send(JSON.stringify({ t: 'rrweb', events: [{ type: 3, data: { source: 0, texts: [{ id: 1, value: 'still-streaming' }] }, timestamp: Date.now() }] }));
    assert(await waitFor(v8.msgs, (m) => m.includes('still-streaming')), 'and the stream carries on');

    // Now deactivate the WATCHER, exactly as the admin screen does.
    await db.query(`UPDATE staff_users SET is_active=false, token_version=token_version+1 WHERE id=$1`, [watcher.id]);
    const closed8 = new Promise((resolve) => { if (v8.ws.readyState === 3) return resolve(v8.ws._closeCode || null); v8.ws.once('close', (c) => resolve(c)); setTimeout(() => resolve(null), 4000); });
    await hub._internals.heartbeat();
    const code8 = await closed8;
    assert(code8 === 4401, `a deactivated watcher's LIVE socket is closed on the next heartbeat (got ${code8})`);
    // AND THE SESSION IS FILED AS WHAT IT WAS. Leaving the socket's own close
    // handler to end it would record `guest_left` — "the watched person walked
    // away" — for a session cut off by a revocation.
    await new Promise((rr) => setTimeout(rr, 400));
    const row8 = (await db.query(`SELECT status, end_reason FROM cobrowse_sessions WHERE id=$1`, [s8])).rows[0];
    assert(row8.status === 'ended' && row8.end_reason === 'revoked',
      `the register says the session was REVOKED, not that somebody wandered off (status=${row8.status} reason=${row8.end_reason})`);
    assert(g8.ws.readyState !== 1 || await waitFor(g8.msgs, (m) => m.includes('"t":"ended"')),
      'and the watched person is told, so they are not left showing a screen to nobody');

    // A DEGRADED DATABASE IS NOT A REVOCATION. `stillAllowed` answers UNKNOWN when
    // a query throws, and the beat must leave the socket alone — the first cut ran a
    // `SELECT 1` probe and guessed, so one degraded beat tore down every live
    // co-browse in the process (pre-merge audit, 2026-09-02).
    {
      const watcher3 = await mk('super_admin', 'Watcher3');
      const watched3 = await mk('loan_officer', 'Watched3');
      const w3Tok = tok(watcher3), d3Tok = tok(watched3);
      r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: watched3.id }, w3Tok);
      const sA = r.data.session.id;
      await call('POST', `/api/cobrowse/${sA}/respond`, { accept: true }, d3Tok);
      const gA = await open(wsUrl(d3Tok, sA, 'guest'));
      const vA = await open(wsUrl(w3Tok, sA, 'viewer'));
      assert(await waitFor(vA.msgs, (m) => m.includes('"t":"hello"')), 'a third session is attached for the degraded-pool case');
      const realQuery = db.query.bind(db);
      db.query = async (text, params) => {
        if (/FROM staff_users|FROM borrower_auth/.test(String(text))) throw new Error('canceling statement due to statement timeout');
        return realQuery(text, params);
      };
      try {
        await hub._internals.heartbeat();
        await new Promise((rr) => setTimeout(rr, 250));
        assert(vA.ws.readyState === 1 && gA.ws.readyState === 1,
          'a beat that CANNOT TELL leaves both sockets open — a degraded pool is not a revocation');
      } finally { db.query = realQuery; }
      await call('POST', `/api/cobrowse/${sA}/end`, null, d3Tok).catch(() => {});
    }

    // AN OVERLAPPING BEAT MUST NOT KILL A HEALTHY SOCKET. `setInterval` fires
    // whether or not the last beat finished. The first beat clears `isAlive`; the
    // pong that would set it again has not been processed yet; so a second beat
    // that runs the ping loop sees `isAlive === false` and calls `terminate()` on a
    // socket whose only fault is a pong in flight. And whatever made the first beat
    // slow — a busy event loop, a slow database — is the same thing keeping the
    // pong from landing, so it feeds itself.
    //
    // The first version of the guard sat BELOW the ping loop and protected only the
    // database re-check, while its comment claimed otherwise; the pre-merge audit
    // ran it and watched a socket die (2026-09-02). This drives the real thing: a
    // beat held open inside `stillAllowed`, a second beat fired underneath it, and
    // the socket required to survive.
    {
      const watcher4 = await mk('super_admin', 'Watcher4');
      const watched4 = await mk('loan_officer', 'Watched4');
      const w4Tok = tok(watcher4), d4Tok = tok(watched4);
      r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: watched4.id }, w4Tok);
      const sB = r.data.session.id;
      await call('POST', `/api/cobrowse/${sB}/respond`, { accept: true }, d4Tok);
      const gB = await open(wsUrl(d4Tok, sB, 'guest'));
      const vB = await open(wsUrl(w4Tok, sB, 'viewer'));
      assert(await waitFor(vB.msgs, (m) => m.includes('"t":"hello"')), 'a fourth session is attached for the overlap case');
      const realQuery = db.query.bind(db);
      let release = null;
      const held = new Promise((rr) => { release = rr; });
      db.query = async (text, params) => {
        if (/FROM staff_users/.test(String(text))) { await held; }
        return realQuery(text, params);
      };
      // THE PONG MUST NOT LAND INSIDE THE WINDOW, or the killing condition never
      // arises and this test passes for the wrong reason — it did on the first
      // run, because a loopback pong returns in about a millisecond. Silencing
      // the server's own ping is the honest model of the case that matters: a
      // busy event loop or a slow link, where the pong is in flight when the next
      // tick fires. The sockets themselves are perfectly healthy throughout.
      const room = hub._internals.rooms.get(sB);
      const live = [room && room.guest, ...(room ? room.viewers : [])].filter(Boolean);
      assert(live.length === 2, `both server-side sockets are in the room (${live.length})`);
      const realPings = live.map((w) => w.ping.bind(w));
      for (const w of live) w.ping = () => {};
      let firstDone = false;
      const first = hub._internals.heartbeat().then(() => { firstDone = true; });
      await new Promise((rr) => setTimeout(rr, 150));
      assert(!firstDone, 'the first beat really is held open inside the identity lookup');
      await hub._internals.heartbeat();              // the overlapping tick
      await new Promise((rr) => setTimeout(rr, 150));
      assert(vB.ws.readyState === 1 && gB.ws.readyState === 1,
        'a beat that overlaps a slow one terminates NOBODY — the guard covers the ping loop, not just the re-check');
      release(); await first;
      live.forEach((w, i) => { w.ping = realPings[i]; });
      db.query = realQuery;
      await call('POST', `/api/cobrowse/${sB}/end`, null, d4Tok).catch(() => {});
    }
  }

  // AND DEACTIVATION DOES NOT WAIT FOR A HEARTBEAT. The re-check above bounds the
  // exposure at one beat; the admin screen ends the session outright, so a screen
  // stops being watched the moment the person is deactivated.
  {
    const watcher2 = await mk('super_admin', 'Watcher2');
    const watched2 = await mk('loan_officer', 'Watched2');
    const w2Tok = tok(watcher2), d2Tok = tok(watched2);
    r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: watched2.id }, w2Tok);
    const s9 = r.data.session.id;
    await call('POST', `/api/cobrowse/${s9}/respond`, { accept: true }, d2Tok);
    // REAL SOCKETS ON BOTH SIDES. A session with no live room is an ORPHAN, and the
    // sweep ends it as 'expired' — which would let this case "pass" for the wrong
    // reason, and did on the first run.
    const g9 = await open(wsUrl(d2Tok, s9, 'guest'));
    const v9 = await open(wsUrl(w2Tok, s9, 'viewer'));
    assert(await waitFor(v9.msgs, (m) => m.includes('"t":"hello"')), 'the second session is genuinely attached');
    let row9 = (await db.query(`SELECT status FROM cobrowse_sessions WHERE id=$1`, [s9])).rows[0];
    assert(row9.status === 'active', 'a second session is live before the deactivation');
    r = await call('PATCH', `/api/admin/staff/${watcher2.id}`, { isActive: false }, saTok);
    assert(r.status === 200, `the admin screen deactivates the watcher (got ${r.status})`);
    await new Promise((rr) => setTimeout(rr, 400));
    row9 = (await db.query(`SELECT status, end_reason FROM cobrowse_sessions WHERE id=$1`, [s9])).rows[0];
    assert(row9.status === 'ended' && row9.end_reason === 'revoked',
      `deactivating a staffer ends the co-browse they were party to at once (status=${row9.status} reason=${row9.end_reason})`);
    assert(g9.ws.readyState !== 1 || await waitFor(g9.msgs, (m) => m.includes('"t":"ended"')),
      'and the watched person is told, so their banner comes down rather than lying');
  }

  // A borrower's HELPER (a real assistant row + the real envelope) is not the borrower:
  // it may not see, answer, or end a co-browse aimed at the borrower (audit blocker).
  const asstRow = (await db.query(`INSERT INTO borrower_assistants (borrower_id, email, name, token_version) VALUES ($1, $2, 'Helper', 0) RETURNING id`, [bo.id, `cb-${tag}-helper@b.test`])).rows[0];
  const asstTok = require('../src/lib/borrower-assistant').mintToken({ borrowerId: bo.id, borrowerTv: 5, assistantId: asstRow.id, assistantTv: 0 });
  await db.query(`UPDATE cobrowse_sessions SET status='ended', ended_at=now(), end_reason='revoked' WHERE watched_borrower_id=$1 AND status IN ('requested','active')`, [bo.id]);
  r = await call('POST', '/api/cobrowse/request', { kind: 'borrower', id: bo.id }, saTok);
  assert(r.status === 200, `a fresh request to the borrower (got ${r.status} ${r.data && r.data.error})`);
  const s9 = r.data.session.id;
  r = await call('GET', '/api/cobrowse/mine', null, asstTok);
  assert(r.status === 403 && r.data.code === 'proxy_actor', `the helper is refused at /mine (got ${r.status} ${r.data && r.data.code})`);
  r = await call('POST', `/api/cobrowse/${s9}/respond`, { accept: true }, asstTok);
  assert(r.status === 403 && r.data.code === 'proxy_actor', 'the helper cannot consent for the borrower');
  const s9row = (await db.query(`SELECT status FROM cobrowse_sessions WHERE id=$1`, [s9])).rows[0];
  assert(s9row.status === 'requested', 'and the request is still unanswered');
  // The library rule is a second layer under the route wall, and is proven on its own.
  const s9raw = await S.loadRaw(s9);
  assert(S.isWatched(s9raw, { kind: 'borrower', id: bo.id }) === true && S.isWatched(s9raw, { kind: 'borrower', id: bo.id, assistant: true }) === false
    && S.isWatched(s9raw, { kind: 'borrower', id: bo.id, guestConditions: true }) === false, 'isWatched: the borrower yes, their helper no, a guest link no');
  r = await call('POST', `/api/cobrowse/${s9}/respond`, { accept: true }, boTok);
  assert(r.status === 200 && r.data.session.status === 'active', 'the borrower themselves still can');
  const hc = await open(wsUrl(asstTok, s9, 'guest'));
  const hcode = hc.closed ? hc.closed.code : await closeCode(hc.ws);
  assert(hcode === 4401, `the helper token is refused by the hub too (got ${hcode})`);
  await call('POST', `/api/cobrowse/${s9}/end`, null, saTok);
  await db.query(`DELETE FROM borrower_assistants WHERE id=$1`, [asstRow.id]);

  // ── F. Phase C — restart recovery, the view-as wall on every door ─────────
  console.log('F. hardening');
  r = await call('POST', '/api/cobrowse/request', { kind: 'staff', id: lo2.id }, loTok);
  assert(r.status === 200, `a request to lo2 for the restart test (got ${r.status} ${r.data && r.data.error})`);
  const s8 = r.data.session.id;
  r = await call('POST', `/api/cobrowse/${s8}/respond`, { accept: true }, lo2Tok);
  assert(r.status === 200, 'lo2 accepts (the processor signed out in D, so their token is gone — by design)');
  await db.query(`UPDATE cobrowse_sessions SET started_at = now() - interval '20 minutes', last_seen_at = now() - interval '10 minutes' WHERE id=$1`, [s8]);
  let swO = await S.sweep({ liveIds: new Set([String(s8)]) });
  let s8row = (await db.query(`SELECT status FROM cobrowse_sessions WHERE id=$1`, [s8])).rows[0];
  assert(swO.orphanedSessions === 0 && s8row.status === 'active', 'a quiet session with a LIVE room is never treated as an orphan');
  swO = await S.sweep({ liveIds: new Set() });
  s8row = (await db.query(`SELECT status, end_reason FROM cobrowse_sessions WHERE id=$1`, [s8])).rows[0];
  assert(swO.orphanedSessions >= 1 && s8row.status === 'ended' && s8row.end_reason === 'expired', 'after a restart an orphaned active row is closed by the sweep');
  swO = await S.sweep();
  assert(swO.orphanedSessions === 0, 'a sweep with no room set (a test, a hub-less process) never guesses about orphans');
  r = await call('GET', '/api/cobrowse/mine', null, impTok);
  assert(r.status === 403 && r.data.code === 'inside_view', `inside a view-as, /mine is refused too (got ${r.status} ${r.data && r.data.code})`);
  const hs = hub.stats();
  assert('controlled' in hs, 'stats report how many rooms are under control');

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
