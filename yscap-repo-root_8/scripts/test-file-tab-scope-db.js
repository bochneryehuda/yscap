/**
 * ONE FILE SCOPE, EVERY TAB — a staffer who can open a file can use its tabs.
 *
 * OWNER-REPORTED 2026-08-25, two symptoms, one root cause:
 *   · "I'm trying to import this [appraisal] XML … and it comes up XML not found."
 *   · "You click [See what doesn't match] … sometimes it's getting to a forbidden
 *      error by the processor, not by my user."
 *
 * `src/lib/permissions.js` holds TWO fragments and they answer DIFFERENT questions:
 *   · `visibleOfficersSql` — THE five-way definition of "which files may this staffer
 *     see": primary LO, primary processor, DELEGATION (staff_users.visible_officer_ids),
 *     an active assignee row, or an OPEN workflow hand-off.
 *   · `assigneeExistsSql`  — branch 4 of those five, on its own.
 *
 * staff.js's `/applications/:id` middleware uses the FULL rule, so the file screen, the
 * term sheet and the Encompass tab all opened. Seven other routers had copied
 * `assigneeExistsSql` into their own per-file check — two of them under a comment
 * reading "the same per-file scope every staff surface uses — never a hand-written one",
 * which is exactly what the author believed they were doing. The result on a live file:
 * the same person, on the same file, could read every condition and the borrower's
 * details, and got "not found" from the appraisal tab and the XML import.
 *
 * THE CLASS: a scope copied instead of called loses a branch silently, and the branch it
 * loses is invisible until somebody reaches the file the unusual way. Section A is the
 * source guard that stops the copy coming back; section B proves the behaviour over real
 * HTTP against a real database, from all five directions plus a stranger.
 *
 * CHAT IS IN, BY THE OWNER'S OWN ANSWER. Asked directly whether a staffer who reaches a
 * file the other two ways should also read its internal thread, the owner chose "the same
 * as the rest of the file" — so `routes/staff-chat.js` and `lib/chat.js staffCanAccess`
 * are on the shared rule too, and an explicitly-seated member still gets in regardless.
 *
 * AND A RETURNED HAND-OFF KEEPS ITS ACCESS, likewise by the owner's own answer ("once
 * they worked it, they keep it"): `visibleOfficersSql` branch 5 no longer requires the
 * hand-off to be OPEN. A cancelled or withdrawn one still grants nothing — cancelling
 * one means the person was never given the work.
 *
 * The DB half needs DATABASE_URL and skips cleanly; the source guard always runs.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// A guard's own explanation necessarily NAMES the helper it forbids, so it must read the
// code and not the prose — otherwise it fails on the comment that explains it.
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ── A) the source guard: no file scope may be hand-rolled ─────────────────── */
const SCOPE_EXCEPTIONS = new Set();   // every file scope is the shared rule now

const routeFiles = fs.readdirSync(path.join(__dirname, '..', 'src', 'routes'))
  .filter((f) => f.endsWith('.js')).map((f) => `src/routes/${f}`)
  .concat(['src/lib/underwriting/escalations.js']);

/* Written as the RULE, not as a snapshot of today's table. Counting modules that
   still carry the NARROW helper would read zero the moment they are all fixed —
   which is the correct end state — and an "I found some" assertion would then fail
   confusingly, reading as "you broke something" when the truth is "there is nothing
   left to find". So the sweep counts modules that scope a file AT ALL, and the rule
   is that each of them asks the shared helper. */
let scoping = 0, offenders = [];
for (const rel of routeFiles) {
  const src = strip(read(rel));
  // Does this module decide "may this staffer reach this FILE" at all?
  if (!/FROM applications\b|applications a\b/.test(src)) continue;
  const asksShared = /visibleOfficersSql\s*\(/.test(src);
  const asksNarrow = /assigneeExistsSql\s*\(/.test(src);
  if (!asksShared && !asksNarrow) continue;      // scopes by something else entirely
  scoping++;
  if (SCOPE_EXCEPTIONS.has(rel)) continue;
  // The narrow branch is only ever acceptable ALONGSIDE the full rule, never instead.
  if (!asksShared) offenders.push(rel);
}
ok(offenders.length === 0,
  `A1  no route module scopes a file with the assignee branch alone${offenders.length ? ` — ${offenders.join(', ')}` : ''}`);
ok(scoping >= 5, `A2  the guard actually looked at the file-scoping modules (found ${scoping}; an empty sweep proves nothing)`);

for (const rel of ['src/routes/appraisal.js', 'src/routes/underwriting.js', 'src/routes/sitewire.js',
  'src/routes/trustpoint.js', 'src/routes/amc.js', 'src/routes/class.js', 'src/routes/richervalues.js',
  'src/lib/underwriting/escalations.js']) {
  ok(/visibleOfficersSql\s*\(/.test(strip(read(rel))), `A3  ${rel} asks the shared five-way rule`);
}
for (const rel of ['src/routes/staff-chat.js', 'src/lib/chat.js']) {
  ok(/visibleOfficersSql\s*\(/.test(strip(read(rel))), `A4  ${rel} asks the shared five-way rule`);
}
ok(/conversation_members/.test(strip(read('src/lib/chat.js'))),
  'A5  …and an explicitly-seated chat member still gets in on their own');
ok(!/status IN \('open','in_progress'\)/.test(strip(read('src/lib/permissions.js'))),
  'A6  branch 5 no longer requires the hand-off to still be open');
ok(/wi\.status <> 'cancelled'/.test(strip(read('src/lib/permissions.js'))),
  'A7  …while a CANCELLED hand-off still grants nothing');

/* ── B) the behaviour, over real HTTP ───────────────────────────────────────── */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP db portion (no DATABASE_URL)');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL file-tab-scope (source) assertions passed');
    process.exit(failures ? 1 : 0);
  }
  const db = require('../src/db');
  const { signJwt } = require('../src/lib/crypto');
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = `fts${process.pid}${Date.now()}`;
  let officer;
  try {
    const mk = async (role, tag) => (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
      [`${u}-${tag}@test.local`, `Scope ${tag}`, role])).rows[0].id;
    officer = await mk('loan_officer', 'lo');
    const delegated = await mk('processor', 'deleg');
    const handoff = await mk('processor', 'hand');
    const assignee = await mk('processor', 'assn');
    // The stranger must hold a role WITHOUT see_all_files, or the scope rule
    // this suite proves never gets asked. It was a processor until 2026-08-26,
    // when the owner gave processors whole-pipeline visibility ("the back
    // office sees the entire pipeline") — a loan officer is now the honest
    // no-path fixture.
    const stranger = await mk('loan_officer', 'stranger');
    await db.query(`UPDATE staff_users SET visible_officer_ids = ARRAY[$1]::uuid[] WHERE id=$2`, [officer, delegated]);

    const bor = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Scope','Tab',$1) RETURNING id`,
      [`${u}-b@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type,program,loan_officer_id,ys_loan_number)
       VALUES ($1,'underwriting','Purchase','Gold Standard',$2,$3) RETURNING id`,
      [bor, officer, `YSCAP${String(Date.now()).slice(-9)}`])).rows[0].id;
    await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, status, to_staff_id, to_role, from_staff_id)
       VALUES ($1,'processing','open',$2,'processor',$3)`, [appId, handoff, officer]);
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'processor')`, [appId, assignee]);

    // The owner's second symptom: a processor who FINISHED and handed the file back.
    // Loan officers, not processors, since 2026-08-26 (processors hold
    // see_all_files by role default now, so a processor fixture would pass
    // these hand-off assertions through the WRONG branch and B6's refusal
    // could never be observed). The hand-off branch matches to_staff_id, so
    // the staffer's own role does not matter to the rule under test.
    const returned = await mk('loan_officer', 'returned');
    await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, status, to_staff_id, to_role, from_staff_id)
       VALUES ($1,'processing','returned',$2,'processor',$3)`, [appId, returned, officer]);
    const cancelled = await mk('loan_officer', 'cancelled');
    await db.query(
      `INSERT INTO workflow_items (application_id, submission_type, status, to_staff_id, to_role, from_staff_id)
       VALUES ($1,'processing','cancelled',$2,'processor',$3)`, [appId, cancelled, officer]);

    const tok = (id) => signJwt({ sub: id, kind: 'staff', role: 'processor', tv: 0, sid: 'scope' });
    const status = async (who, method, p, body) => (await fetch(base + p, {
      method, headers: { authorization: `Bearer ${tok(who)}`, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    })).status;

    const TABS = [
      ['the file screen', 'GET', `/api/staff/applications/${appId}`],
      ['the appraisal tab', 'GET', `/api/appraisal/${appId}`],
      ['the underwriting desk', 'GET', `/api/underwriting/${appId}`],
    ];
    for (const [who, label] of [[delegated, 'a DELEGATED processor (visible_officer_ids)'],
      [handoff, 'a HAND-OFF processor (an open workflow item)'],
      [assignee, 'an ASSIGNEE processor (the control)'],
      [returned, 'a RETURNED hand-off processor (they finished and handed it back)']]) {
      for (const [name, m, p] of TABS) {
        ok(await status(who, m, p) === 200, `B1  ${label} can open ${name}`);
      }
      // The owner's own symptom: the XML import must REACH the route. 400 = "send me the
      // XML" (this probe sends none) and is the proof it is no longer refused as missing.
      const s = await status(who, 'POST', `/api/appraisal/${appId}/import`, {});
      ok(s === 400, `B2  ${label} reaches the appraisal XML import (got ${s}, not a 404 "not found")`);
    }
    // …and nothing was widened past the rule: somebody on none of the five paths is still out.
    ok(await status(stranger, 'GET', `/api/staff/applications/${appId}`) === 403,
      'B3  a staffer on NONE of the five paths is still refused the file screen');
    for (const [name, m, p] of TABS.slice(1)) {
      ok(await status(stranger, m, p) === 404, `B4  …and still refused ${name}`);
    }
    ok(await status(stranger, 'POST', `/api/appraisal/${appId}/import`, {}) === 404,
      'B5  …and still refused the XML import');
    // A CANCELLED hand-off means the work was taken back before they did it.
    ok(await status(cancelled, 'GET', `/api/staff/applications/${appId}`) === 403,
      'B6  a CANCELLED hand-off grants nothing');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL file-tab-scope assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (officer) await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`${u}-%`]); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
  process.exit(failures ? 1 : 0);
})();
