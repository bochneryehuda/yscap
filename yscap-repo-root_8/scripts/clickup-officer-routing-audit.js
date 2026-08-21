'use strict';
/**
 * Which loan officers can PILOT actually place in ClickUp?
 *
 * This is the check that would have caught the 2026-08-21 report ("All of the files
 * from Joshua Freidlander is going into the lead capture folder") months earlier.
 * `src/clickup/routing.js` is a HAND-TYPED registry; `staff_users` is the live
 * roster. Nothing ever compared the two, and the failure is SILENT by design — an
 * officer PILOT cannot place is filed to Lead Capture, which is exactly what a file
 * with no officer at all does.
 *
 * So: read the real roster, ask the real resolver about every active loan officer,
 * and print anyone it cannot place — plus every registry row no live staffer claims
 * (a departed officer, or a typo in the registry itself).
 *
 * READ-ONLY. It writes nothing, calls no external service, and never changes
 * routing. Exit code 1 when something needs attention, so it can be run on a
 * schedule and noticed.
 *
 *   node scripts/clickup-officer-routing-audit.js
 *
 * Requires DATABASE_URL.
 */
const db = require('../src/db');
const routing = require('../src/clickup/routing');

const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const norm = (e) => (e ? String(e).toLowerCase().trim() : null);

(async function main() {
  const officers = (await db.query(
    `SELECT id, full_name, email, role, clickup_user_id
       FROM staff_users
      WHERE is_active = true
        AND COALESCE(is_external, false) = false
        AND role IN ('loan_officer','admin','super_admin')
      ORDER BY full_name`)).rows;

  const placed = [];
  const gaps = [];
  const claimedPipelines = new Set();

  for (const o of officers) {
    const route = routing.resolveRoutingFor({
      clickupUserId: o.clickup_user_id,
      email: o.email,
      name: o.full_name,
    });
    if (route.role === 'loan_officer') {
      placed.push({ o, route });
      claimedPipelines.add(String(route.pipelineFolderId));
      continue;
    }
    // Only an officer who actually CARRIES files is a problem worth raising — an
    // admin who has never been assigned a file needs no ClickUp folder.
    const files = (await db.query(
      `SELECT count(*)::int AS n FROM applications
        WHERE loan_officer_id = $1 AND COALESCE(deleted, false) = false`, [o.id])).rows[0].n;
    gaps.push({ o, files });
  }

  console.log(`Loan-officer routing audit — ${officers.length} active internal officer(s)\n`);

  console.log('PLACED');
  for (const { o, route } of placed) {
    console.log(`  ✓ ${pad(o.full_name, 26)} ${pad(o.email, 30)} → ${pad(route.officer, 22)} (matched by ${route.matchedBy})`);
  }

  const realGaps = gaps.filter((g) => g.files > 0);
  const idleGaps = gaps.filter((g) => g.files === 0);

  if (realGaps.length) {
    console.log('\nCANNOT BE PLACED — every one of their files is going to Lead Capture');
    for (const { o, files } of realGaps) {
      console.log(`  ✗ ${pad(o.full_name, 26)} ${pad(o.email, 30)} ${files} file(s)`);
      const guess = Object.keys(routing.LOAN_OFFICERS)
        .filter((k) => k.toLowerCase().split(/\s+/).pop() === String(o.full_name || '').toLowerCase().split(/\s+/).pop());
      if (guess.length) console.log(`      the registry has a similar name: ${guess.join(', ')}`);
      console.log('      fix: add their staff email to CLICKUP_STAFF in src/clickup/routing.js (the stable key),');
      console.log('           or correct the spelling in LOAN_OFFICERS to match their portal name.');
    }
  }
  if (idleGaps.length) {
    console.log('\nnot placed, but carries no files (nothing to fix today)');
    for (const { o } of idleGaps) console.log(`  · ${pad(o.full_name, 26)} ${o.email} (${o.role})`);
  }

  // A registry row nobody live claims: a departed officer, or a typo in the registry.
  const unclaimed = Object.entries(routing.LOAN_OFFICERS)
    .filter(([, f]) => f && f.pipeline && !claimedPipelines.has(String(f.pipeline)));
  if (unclaimed.length) {
    console.log('\nREGISTRY ROWS NO ACTIVE OFFICER CLAIMS (departed, or a typo in the registry)');
    for (const [name, f] of unclaimed) console.log(`  · ${pad(name, 26)} pipeline ${f.pipeline}`);
  }

  // The staff emails the registry lists that no live staff row carries.
  const liveEmails = new Set(officers.map((o) => norm(o.email)).filter(Boolean));
  const strandedEmails = routing.CLICKUP_STAFF
    .filter((s) => s.role === 'loan_officer' && !liveEmails.has(norm(s.staffEmail)))
    .map((s) => s.staffEmail);
  if (strandedEmails.length) {
    console.log('\nREGISTRY EMAILS WITH NO ACTIVE STAFF ROW');
    for (const e of strandedEmails) console.log(`  · ${e}`);
  }

  console.log('');
  if (realGaps.length) {
    console.log(`${realGaps.length} officer(s) carrying files cannot be routed — their files are landing in Lead Capture.`);
    await db.end?.();
    process.exit(1);
  }
  console.log('Every active loan officer carrying files can be routed to their own ClickUp folder.');
  await db.end?.();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
