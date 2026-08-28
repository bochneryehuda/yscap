'use strict';
/**
 * canSeeDocument — the staff document-download authorization gate (routes/staff.js).
 * It guards every /documents route (metadata, dossier, preview, download).
 *
 * A borrower/entity-scoped document (no application_id) must be openable by anyone
 * who may see that PERSON — the same authority that opens the borrower's profile.
 * The gate used to re-inline a NARROWER scope for that branch:
 *
 *     SELECT 1 FROM applications a WHERE a.borrower_id = <doc.borrower_id> AND <visible>
 *
 * which matches only a file whose PRIMARY borrower is this person. So it 403'd:
 *   • a staffer assigned to a file where the person is the CO-borrower (never a
 *     primary, so a.borrower_id never equals them), and
 *   • the officer who OWNS the profile (primary_officer_id / borrower_officers)
 *     with no matching loan file — the ClickUp-sourced client with only non-RTL
 *     business, which is exactly why the person may have no file at all.
 *
 * The fix delegates the borrower branch to canSeeBorrowerId — the ONE borrower
 * visibility gate (VISIBLE_BORROWER_SQL + the seesAllBorrowers shortcut) — so a
 * document's person-scope authorization can never drift from "may I open this
 * borrower's profile?". The APPLICATION branch is deliberately unchanged and must
 * stay strict: an officer on App2 must NOT reach App1's document just because both
 * files share a borrower.
 *
 * DB-gated: the gate is a SQL predicate over applications/borrowers, so a pure
 * test cannot catch it. SKIPs cleanly with no DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-can-see-document-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');
const { ensureSchema } = require(R + '/src/migrate-boot');
const P = require(R + '/src/lib/permissions');
const staffRouter = require(R + '/src/routes/staff');   // the route module, canSeeDocument is exported on it
const canSeeDocument = staffRouter.canSeeDocument;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const tag = `csd_${process.pid}`;
const q = (t, p) => db.query(t, p);

// A staffer req the way authenticate() shapes it: kind + id + role + the resolved
// perms Set (authenticate runs effectivePermissions(role, permissions_jsonb) onto
// the actor; can() only falls back to role defaults when perms are absent, so
// building the Set here is the faithful shape — and the only way a per-person
// see_all_files revocation is visible to the gate).
const asStaff = (id, role, ovr) => ({ actor: { kind: 'staff', id, role, perms: P.effectivePermissions(role, ovr || null) } });
// A document the way the route loads it before calling the gate.
const doc = (o) => ({ application_id: null, borrower_id: null, llc_id: null, ...o });

async function staff(role) {
  return (await q(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'CSD Tester',$2) RETURNING id`,
    [`${tag}_${Math.floor(Math.random() * 1e9)}@example.com`, role])).rows[0].id;
}
async function borrower(extra = {}) {
  const r = (await q(
    `INSERT INTO borrowers (first_name,last_name,email,primary_officer_id)
     VALUES ('Csd','Tester',$1,$2) RETURNING id`,
    [`${tag}_${Math.floor(Math.random() * 1e9)}@example.com`, extra.primaryOfficerId || null])).rows[0];
  return r.id;
}

(async function main() {
  await ensureSchema();

  // ── the cast ────────────────────────────────────────────────────────────
  const LO1 = await staff('loan_officer');       // primary LO on file A
  const LO2 = await staff('loan_officer');       // primary LO on file A2 (same borrower B, different file)
  const LO3 = await staff('loan_officer');       // owns borrower P's PROFILE, has no file with them
  const STRANGER = await staff('loan_officer');  // unrelated to everyone
  const ADMIN = await staff('admin');            // see_all_files
  const PROC = await staff('processor');          // back-office persona (2026-08-26): the ROLE now holds see_all_files

  const B = await borrower();                    // primary borrower on A and A2
  const C = await borrower();                    // CO-borrower on A — never a primary anywhere
  const P = await borrower({ primaryOfficerId: LO3 });  // profile-owned by LO3, no loan file

  // A: primary borrower B, co-borrower C, LO1. A2: primary borrower B, LO2.
  const A = (await q(
    `INSERT INTO applications (borrower_id, co_borrower_id, property_address, loan_amount, status, loan_officer_id)
     VALUES ($1,$2,'{"street":"1 Main St"}'::jsonb, 300000, 'processing', $3) RETURNING id`,
    [B, C, LO1])).rows[0].id;
  const A2 = (await q(
    `INSERT INTO applications (borrower_id, property_address, loan_amount, status, loan_officer_id)
     VALUES ($1,'{"street":"2 Main St"}'::jsonb, 300000, 'processing', $2) RETURNING id`,
    [B, LO2])).rows[0].id;

  const docC = doc({ borrower_id: C });          // a co-borrower profile document (e.g. C's photo ID)
  const docB = doc({ borrower_id: B });          // the primary borrower's profile document
  const docP = doc({ borrower_id: P });          // a document on the file-less, profile-owned person
  const docAppA = doc({ application_id: A, borrower_id: B });  // an application-scoped document on A

  // ── 1. THE FIX: a co-borrower's profile document is readable by the file's LO ──
  ok(await canSeeDocument(asStaff(LO1, 'loan_officer'), docC) === true,
    'the LO assigned to the file can open the CO-borrower\'s profile document (was 403 — no app has borrower_id=C)');
  ok(await canSeeDocument(asStaff(STRANGER, 'loan_officer'), docC) === false,
    '…and an unrelated officer still cannot — the boundary holds');

  // ── 2. THE FIX: the profile-OWNER (no loan file) can open the person's document ──
  ok(await canSeeDocument(asStaff(LO3, 'loan_officer'), docP) === true,
    'the officer who owns the profile (primary_officer_id) can open the document even with NO loan file (was 403)');
  ok(await canSeeDocument(asStaff(LO1, 'loan_officer'), docP) === false,
    '…and an officer with no relationship to that person cannot');

  // ── 3. the primary borrower path still works (regression) ──
  ok(await canSeeDocument(asStaff(LO1, 'loan_officer'), docB) === true,
    'the primary borrower\'s own file LO still opens their profile document');
  ok(await canSeeDocument(asStaff(LO2, 'loan_officer'), docB) === true,
    'an LO on the SAME person\'s OTHER file (A2) also sees their profile document — they work with that person');
  ok(await canSeeDocument(asStaff(STRANGER, 'loan_officer'), docB) === false,
    'a stranger cannot open the primary borrower\'s profile document');

  // ── 4. the APPLICATION branch is unchanged and STILL strict (the load-bearing boundary) ──
  ok(await canSeeDocument(asStaff(LO1, 'loan_officer'), docAppA) === true,
    'the LO on file A opens A\'s application-scoped document');
  ok(await canSeeDocument(asStaff(LO2, 'loan_officer'), docAppA) === false,
    'the LO on file A2 (SAME borrower B) does NOT reach A\'s application document — the borrower fix never loosened the file branch');
  ok(await canSeeDocument(asStaff(STRANGER, 'loan_officer'), docAppA) === false,
    'a stranger cannot open the application document either');

  // ── 5. see-all + seesAllBorrowers are consistent with the profile PII model ──
  ok(await canSeeDocument(asStaff(ADMIN, 'admin'), docC) === true,
    'a see-all admin opens any document');
  // A processor seesAllBorrowers — they may open ANY borrower profile and reveal ANY
  // SSN — so a borrower-scoped document (strictly less sensitive) must follow.
  ok(await canSeeDocument(asStaff(PROC, 'processor'), docC) === true,
    'a processor (seesAllBorrowers) opens any borrower-scoped document — consistent with the profile/SSN gate');
  ok(await canSeeDocument(asStaff(PROC, 'processor'), docP) === true,
    '…including for a file-less, profile-owned person');
  // Since 2026-08-26 (back-office persona) the processor ROLE holds see_all_files
  // by default — whole-pipeline access like admins — so a DEFAULT processor DOES
  // reach any application document.
  ok(await canSeeDocument(asStaff(PROC, 'processor'), docAppA) === true,
    'a default processor reaches any application document — the back-office persona (role-level see_all_files)');
  // The supported revocation path is PER PERSON via the permissions jsonb (Team
  // screen). A revoked processor keeps seesAllBorrowers (a role carve-out — sees
  // every PERSON) but the FILE branch goes back to file-scoped, which keeps that
  // branch observable.
  const revoked = { see_all_files: false };
  ok(await canSeeDocument(asStaff(PROC, 'processor', revoked), docC) === true,
    'a see_all_files-REVOKED processor still opens a borrower-scoped document (seesAllBorrowers is a role carve-out)');
  ok(await canSeeDocument(asStaff(PROC, 'processor', revoked), docAppA) === false,
    'a see_all_files-REVOKED processor does NOT reach an application document they are not assigned to — the file branch stays file-scoped');

  // ── cleanup ──
  await q(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[A, A2]]).catch(() => {});
  await q(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [[B, C, P]]).catch(() => {});
  await q(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[LO1, LO2, LO3, STRANGER, ADMIN, PROC]]).catch(() => {});

  console.log(`test-can-see-document-db: ${pass} passed, ${fail} failed`);
  await db.pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
