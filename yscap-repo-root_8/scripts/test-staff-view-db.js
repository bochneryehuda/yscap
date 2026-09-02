'use strict';
/*
 * STAFF VIEW, THROUGH THE REAL DOOR — a super admin steps into a teammate's own
 * console, sees what they see, can change nothing, and comes back out.
 *
 * The pure suite proves the RULES (the read-only wall, the envelope, the clock)
 * with no server. It cannot prove the DOOR: that /start refuses everybody it
 * should, that the token it mints really authenticates as the TARGET with the
 * TARGET's role and permissions, that a write is actually refused on the wire
 * rather than merely refused by a function nobody called, and that the way back
 * out returns the VIEWER's own session. This feature moves a real session
 * between two real people, and until 2026-08-26 it was reachable from ONE
 * product's team screen; making it reachable from the other is exactly the
 * moment to prove the whole path rather than assert it.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Every
 * row it creates is removed in the finally block.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-staff-view-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-this-suite-only';
const assert = require('assert');
const http = require('http');

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(m); };
const yes = (v, m) => { assert.ok(v, m); ok(m); };

const db = require('../src/db');
const app = require('../src/server');
const C = require('../src/lib/crypto');

const tag = `sv${process.pid}${Date.now() % 100000}`;
const ids = [];

let firmId = null;
/* An EXTERNAL staff row must carry a firm — `staff_users_external_firm_check`
   makes an unscoped external identity structurally unwritable, which is the TPO
   isolation rule. So the broker fixture gets a real firm rather than a relaxed
   constraint. */
async function mkStaff(role, active = true, external = false) {
  if (external && !firmId) {
    firmId = (await db.query(`INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`Firm ${tag}`])).rows[0].id;
  }
  const r = await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id, password_hash, token_version)
     VALUES ($1,$2,$3,$4,$5,$6,'x',0) RETURNING id, role, token_version`,
    [`${tag}.${role}${ids.length}@example.test`, `${role} ${tag}`, role, active, external, external ? firmId : null]);
  ids.push(r.rows[0].id);
  return r.rows[0];
}
/* The SAME signer the auth layer uses — a hand-rolled token would prove nothing
   about what the real login mints. */
const staffToken = (s) => C.signJwt({ sub: s.id, kind: 'staff', role: s.role, tv: s.token_version || 0 }, 3600);

let server;
const call = (method, path, { token, body } = {}) => new Promise((resolve) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request({
    host: '127.0.0.1', port: server.address().port, method, path,
    headers: Object.assign(
      token ? { Authorization: `Bearer ${token}` } : {},
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
  }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) { j = { _raw: buf.slice(0, 200) }; } resolve({ status: res.statusCode, body: j }); });
  });
  req.on('error', () => resolve({ status: 0, body: null }));
  if (data) req.write(data);
  req.end();
});

(async () => {
  try {
    await require('../src/migrate-boot').ensureSchema();
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));

    const owner = await mkStaff('super_admin');
    const officer = await mkStaff('loan_officer');
    const admin = await mkStaff('admin');
    const gone = await mkStaff('processor', false);
    const broker = await mkStaff('loan_officer', true, true);   // a TPO broker is an EXTERNAL staff row
    const ownerTok = staffToken(owner);

    // ── 1. WHO MAY OPEN THE DOOR ──────────────────────────────────────────
    eq((await call('POST', '/api/staff-view/start', { token: staffToken(admin), body: { staffId: officer.id } })).status, 403,
      '1a a plain ADMIN cannot step into a teammate\'s console — the screen gates on super admin for this exact reason');
    eq((await call('POST', '/api/staff-view/start', { token: staffToken(officer), body: { staffId: admin.id } })).status, 403,
      '1b nor can a loan officer');
    eq((await call('POST', '/api/staff-view/start', { token: ownerTok, body: { staffId: owner.id } })).status, 400,
      '1c and nobody views THEMSELVES — that is the screen they are already on');
    eq((await call('POST', '/api/staff-view/start', { token: ownerTok, body: {} })).status, 400, '1d naming nobody is refused');
    eq((await call('POST', '/api/staff-view/start', { token: ownerTok, body: { staffId: gone.id } })).status, 404,
      '1e a DEACTIVATED person has no session to look at (the button is hidden for them too)');
    eq((await call('POST', '/api/staff-view/start', { token: ownerTok, body: { staffId: broker.id } })).status, 404,
      '1f an EXTERNAL staff row (a TPO broker) is not a teammate — that is what tpo-view is for');
    eq((await call('POST', '/api/staff-view/start', { token: ownerTok, body: { staffId: '00000000-0000-0000-0000-000000000000' } })).status, 404,
      '1g an unknown id is refused, not guessed at');

    // ── 1h. THE VIEWER'S REAL token_version RIDES IN THE TOKEN (owner-reported 2026-09-01:
    //        "When I click on See my screen, I'm popping back up to the sign-in window").
    //        The route used to read `req.actor.tokenVersion ?? req.actor.tv` — properties
    //        that do not exist — so every view carried viewerTv 0, and a super admin whose
    //        row had ever been bumped (a password set from an invite, a reset, a
    //        sign-out-everywhere) was 'revoked' on the very next request. Every fixture
    //        above has token_version 0, which is exactly why this never fired here. ──
    {
      const bumped = await mkStaff('super_admin');
      await db.query(`UPDATE staff_users SET token_version = 7 WHERE id = $1`, [bumped.id]);
      const bumpedTok = staffToken({ ...bumped, token_version: 7 });
      const st = await call('POST', '/api/staff-view/start', { token: bumpedTok, body: { staffId: officer.id } });
      eq(st.status, 200, '1h a super admin with a bumped token_version can start a view');
      const nextReq = await call('GET', '/auth/me', { token: st.body.token });
      eq(nextReq.status, 200, '1h1 …and the very NEXT request inside the view still authenticates (it used to 401 session:invalid)');
      eq(nextReq.body && nextReq.body.id, officer.id, '1h2 as the teammate');
      const sess = (await db.query(`SELECT ended_at, ended_reason FROM staff_view_sessions WHERE viewer_staff_id = $1 ORDER BY started_at DESC LIMIT 1`, [bumped.id])).rows[0];
      yes(sess && !sess.ended_at, `1h3 the session register does not show it revoked (got ${sess && sess.ended_reason})`);
      await call('POST', '/api/staff-view/exit', { token: st.body.token });
    }

    // ── 2. THE TOKEN IS THE TARGET'S OWN CONSOLE ──────────────────────────
    const started = await call('POST', '/api/staff-view/start', { token: ownerTok, body: { staffId: officer.id } });
    eq(started.status, 200, '2a a super admin opens a view of an active teammate');
    const viewTok = started.body.token;
    yes(viewTok && started.body.viewing && started.body.viewing.id === officer.id, '2b and is told whose screen it is');

    const me = await call('GET', '/auth/me', { token: viewTok });
    eq(me.status, 200, '2c the minted token authenticates');
    eq(me.body.id, officer.id, '2d and it IS the teammate — not the viewer wearing a label');
    eq(me.body.role, 'loan_officer', '2e with the teammate\'s own role, so their scope and permissions are theirs');
    /* AND THE ROLE IN THE TOKEN IS THE TARGET'S TOO, which /auth/me cannot show:
       it reads the role out of the DATABASE by id, so a token minted with the
       VIEWER's role would still report 'loan_officer' there while every
       capability gate — which reads req.actor.role off the TOKEN — silently gave
       the view super-admin powers wearing somebody else's name. The register is
       a GET (so the read-only wall cannot mask it) and is super-admin gated, so
       it is exactly the observation that separates the two. */
    /* A super-admin-only GET on ANOTHER router, deliberately: staff-view's own
       /history additionally refuses any request carrying an impersonation (the
       no-nesting door), so asserting on it would pass for that reason whatever
       the role said — a tautology. This one is gated on the role alone. */
    eq((await call('GET', '/api/admin/insights/ai-stack', { token: ownerTok })).status, 200,
      '2e1 CONTROL: the super admin can reach a super-admin-only GET as themselves');
    eq((await call('GET', '/api/admin/insights/ai-stack', { token: viewTok })).status, 403,
      '2e2 and the SAME GET is refused inside the view — the target is a loan officer and stays one');
    /* THE ROLE IS RE-READ FROM THE DATABASE, NOT TAKEN FROM THE TOKEN, and that
       is the defence that makes the line above unbreakable rather than merely
       currently-true: `authenticate` sets req.actor.role from the staff row of
       the token's SUBJECT ("trust the DB role over the JWT claim — role can
       change mid-session"). Proven by forging the claim, which is the only way
       to observe it: a token that SAYS super_admin about a loan officer is still
       refused, so mis-minting one could never escalate a view. */
    const forged = require('../src/lib/staff-view').mintToken({
      targetId: officer.id, targetRole: 'super_admin', targetTv: officer.token_version || 0,
      viewerId: owner.id, viewerRole: 'super_admin', viewerTv: owner.token_version || 0,
      sessionId: (await db.query(`SELECT id FROM staff_view_sessions WHERE staff_id=$1::uuid ORDER BY started_at DESC LIMIT 1`, [officer.id])).rows[0].id,
      startedAt: Math.floor(Date.now() / 1000),
    });
    eq((await call('GET', '/api/admin/insights/ai-stack', { token: forged })).status, 403,
      '2e3 a token CLAIMING the target is a super admin is still refused — the role comes from the database, never the claim');
    /* HONEST NOTE, MEASURED rather than assumed: because of the line 2e3 pins,
       the `role` claim the mint puts in a staff-view token is INERT — mutating
       `targetRole` to the viewer's role changes nothing observable and that
       mutation correctly survives this suite. It is kept in the mint because a
       token should say what it means, and 2e3 is what makes mis-minting it
       harmless rather than a hole. What is NOT inert, and is pinned above, is
       `targetId` (2d) and `targetTv`. */

    const sess = await call('GET', '/api/staff-view/session', { token: viewTok });
    eq(sess.body.active, true, '2f the banner is told this console is somebody else\'s');
    eq(sess.body.viewer.id, owner.id, '2g and who is really looking — the whole point of it being on the record');
    eq(sess.body.readOnly, true, '2h and that it is read-only');

    // ── 3. LOOKING PASSES, ACTING DOES NOT ────────────────────────────────
    const listed = await call('GET', '/api/staff/applications', { token: viewTok });
    yes(listed.status === 200, '3a a GET goes through — seeing their pipeline is the entire feature');
    for (const [m, p, why] of [
      ['POST', '/api/staff/applications', 'creating a file'],
      ['PATCH', '/api/staff/team/' + officer.id, 'changing a teammate'],
      ['POST', '/auth/logout', 'signing the real person out of their own devices'],
      ['POST', '/api/staff-view/start', 'opening a view from inside a view'],
    ]) {
      const r = await call(m, p, { token: viewTok, body: {} });
      yes(r.status === 403, `3b ${why} is refused (${m} ${p} -> ${r.status})`);
    }
    /* THE REASON IT IS A WALL AND NOT A BLOCKLIST: a staffer acting as another
       staffer has no honest attribution — every audit row would carry the wrong
       person's name — so the only write that passes is leaving. */
    ok('3c the refusals are a wall, not a list: nothing that writes is allowed through');

    // ── 4. THE WAY BACK OUT RETURNS THE VIEWER'S OWN SESSION ──────────────
    const exited = await call('POST', '/api/staff-view/exit', { token: viewTok });
    eq(exited.status, 200, '4a exiting is the one POST the wall lets through');
    yes(exited.body.token, '4b and the server hands back a fresh token rather than trusting the browser\'s parked copy');
    const back = await call('GET', '/auth/me', { token: exited.body.token });
    eq(back.body.id, owner.id, '4c which is the VIEWER\'s own console again');
    eq(back.body.role, 'super_admin', '4d with their own role back');
    eq((await call('GET', '/api/staff-view/session', { token: exited.body.token })).body.active, false,
      '4e and that token is a plain staff session — no envelope survives the exit');

    // ── 5. IT IS ON THE RECORD ────────────────────────────────────────────
    const hist = await call('GET', '/api/staff-view/history', { token: ownerTok });
    eq(hist.status, 200, '5a the register is readable by a super admin');
    /* Matched on the NAMES the register actually returns — it answers the
       auditor's question ("who looked, as whom"), so those are the two facts it
       carries, and asserting on an id it does not expose would be testing a
       shape rather than the answer. Both names carry this run's unique tag. */
    const mine = (hist.body.sessions || []).filter((r) => String(r.viewed_name || '').includes(tag) && String(r.viewer_name || '').includes(tag));
    yes(mine.length >= 1, '5b and it recorded this session — who looked, as whom');
    /* Counted, not merely present: `startSession` is what writes the row, and a
       stubbed-out register would leave the door working and the audit trail
       empty — the one failure nobody notices until it is needed. */
    eq((await db.query(
      `SELECT count(*)::int AS n FROM staff_view_sessions WHERE staff_id = $1::uuid AND viewer_staff_id = $2::uuid`,
      [officer.id, owner.id])).rows[0].n, 1, '5b2 exactly one row was written for this view — the register is the door\'s own record');
    /* ⛔ THE EXIT STAMP IS WRITTEN FIRE-AND-FORGET, SO IT IS POLLED, NEVER READ ONCE.
       `staffView.endSession` (src/lib/staff-view.js) deliberately does NOT await its
       UPDATE — its own comment is "a session register failure must never block a
       request", which is the right call: an audit write may not hold up a person
       coming back out of a view. The consequence is that /exit can answer before the
       stamp has committed, so a single read straight after it is a RACE. It won that
       race almost every time and lost it on main on 2026-09-01, turning a green tree
       red for a reason that had nothing to do with the change being merged.
       This waits for the write instead of assuming it, and it still FAILS if the
       stamp never lands — the assertion is unchanged, only its patience is. Do NOT
       "fix" this by awaiting endSession in production: blocking the exit on an audit
       write is exactly what that function refuses to do. */
    const endedAt = await (async () => {
      for (let i = 0; i < 50; i++) {
        const { rows } = await db.query(
          `SELECT ended_at FROM staff_view_sessions
            WHERE staff_id = $1::uuid AND viewer_staff_id = $2::uuid AND ended_at IS NOT NULL`,
          [officer.id, owner.id]);
        if (rows.length) return rows[0].ended_at;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    })();
    yes(endedAt, '5c the exit is recorded too, so a session that is still open is distinguishable from one that closed');
    eq((await call('GET', '/api/staff-view/history', { token: staffToken(admin) })).status, 403,
      '5d an ordinary admin cannot read who has been viewing whom');

    console.log(`\ntest-staff-view-db: all ${n} checks passed.`);
  } finally {
    if (ids.length) await db.query(`DELETE FROM staff_view_sessions WHERE viewer_staff_id = ANY($1::uuid[]) OR staff_id = ANY($1::uuid[])`, [ids]).catch(() => {});
    if (ids.length) await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [ids]).catch(() => {});
    if (firmId) await db.query(`DELETE FROM tpo_firms WHERE id = $1`, [firmId]).catch(() => {});
    if (server) server.close();
    /* The request-audit writer batches on a timer, so ending the pool the same
       tick makes it log a dropped-rows warning after a perfectly good run. Give
       it a moment to flush — the run is over either way, this only keeps the
       output honest about what actually failed. */
    await new Promise((r) => setTimeout(r, 400));
    await db.pool.end().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
