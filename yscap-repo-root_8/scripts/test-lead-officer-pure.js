#!/usr/bin/env node
/**
 * WORK DONE FROM A STAFF LOGIN STAYS WITH THAT PERSON.
 *
 * Owner-reported 2026-08-07: "I generated a term sheet and sent it to the lead through
 * Pilot and lead got it with Shia Kaff's name on it… one of our staff members
 * generated the term sheet in their staff portal… it looks like it used the automatic
 * queue system and was assigned to another officer… We need to make sure that if
 * somebody is doing something from his login, it should always stay with his
 * information, his name. It should come in as a lead in his system."
 *
 * PURE — no DB, no network. Runs in `npm test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { decideLeadOfficer } = require('../src/lib/lead-assignment');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}
const eqv = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b),
  `${what}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`}`);

console.log('\n1. THE REPORTED BUG: a staff-portal lead is NEVER handed to the rotation');
eqv(decideLeadOfficer({ officerId: null, tool: 'term_sheet', fromStaffPortal: true }),
  { assignedVia: null, mayRoundRobin: false },
  'declared staff origin + unresolved officer → the sales desk, NOT the rotation');
eqv(decideLeadOfficer({ officerId: 'staff-1', tool: 'term_sheet', fromStaffPortal: true }),
  { assignedVia: 'staff_portal', mayRoundRobin: false },
  'declared staff origin + resolved officer → theirs, recorded as staff_portal');
ok(decideLeadOfficer({ officerId: null, tool: 'term_sheet', fromStaffPortal: true }).mayRoundRobin === false,
  'this is the ONE line that stops a staffer’s own work landing in a stranger’s book');

console.log('\n2. The public marketing paths are untouched');
eqv(decideLeadOfficer({ officerId: null, tool: 'term_sheet' }),
  { assignedVia: null, mayRoundRobin: true },
  'an unowned public lead still round-robins (that is what the rotation is for)');
eqv(decideLeadOfficer({ officerId: 'staff-1', tool: 'term_sheet' }),
  { assignedVia: 'lo_link', mayRoundRobin: false },
  'a branded ?lo= lead is still lo_link, and never re-assigned');
eqv(decideLeadOfficer({ officerId: null, tool: 'subscribe' }),
  { assignedVia: null, mayRoundRobin: false },
  'a newsletter subscription is not a loan lead and is never assigned');
eqv(decideLeadOfficer({ officerId: null, tool: 'subscribe', fromStaffPortal: true }),
  { assignedVia: null, mayRoundRobin: false },
  'a subscribe from the portal is still never assigned');

console.log('\n3. The declaration needs no authentication, because it can only ever ADD safety');
ok(decideLeadOfficer({ officerId: null, tool: 'contact', fromStaffPortal: true }).mayRoundRobin === false
   && decideLeadOfficer({ officerId: null, tool: 'contact' }).mayRoundRobin === true,
  'the flag can only make a lead LESS likely to be auto-assigned — a spoof costs nothing');
eqv(decideLeadOfficer({ officerId: null, tool: 'contact', fromStaffPortal: 'true' }),
  { assignedVia: null, mayRoundRobin: false }, 'the string "true" is honoured (a form-encoded body)');
for (const junk of [false, 'false', 0, 1, '', null, undefined, 'yes', {}]) {
  const d = decideLeadOfficer({ officerId: null, tool: 'contact', fromStaffPortal: junk });
  ok(d.mayRoundRobin === true, `anything that is not true/"true" is not a declaration: ${JSON.stringify(junk)}`);
}
eqv(decideLeadOfficer(), { assignedVia: null, mayRoundRobin: true }, 'no arguments at all → the public default, never a throw');

console.log('\n4. Every value it can return is one the database accepts (db/484)');
{
  const sql = fs.readFileSync(path.join(__dirname, '../db/484_lead_staff_portal_origin.sql'), 'utf8');
  const m = sql.match(/assigned_via IN \(([^)]*)\)/);
  ok(!!m, 'db/484 declares the assigned_via CHECK');
  const allowed = new Set((m ? m[1] : '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')));
  for (const v of ['lo_link', 'round_robin', 'manual', 'staff_portal']) {
    ok(allowed.has(v), `the CHECK accepts '${v}'`);
  }
  // Every value the decider can produce must be storable, or the write 500s.
  const produced = new Set();
  for (const officerId of [null, 'x']) {
    for (const fromStaffPortal of [true, false]) {
      for (const tool of ['term_sheet', 'subscribe', 'contact']) {
        const v = decideLeadOfficer({ officerId, tool, fromStaffPortal }).assignedVia;
        if (v) produced.add(v);
      }
    }
  }
  for (const v of produced) ok(allowed.has(v), `a value the decider produces is storable: '${v}'`);
  ok(!produced.has('round_robin'), 'the decider never claims round_robin itself — the caller stamps that after it actually picks somebody');
}

console.log('\n5. The route delegates rather than re-deciding (one definition)');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/leads.js'), 'utf8');
  ok(/decideLeadOfficer\(/.test(src), 'routes/leads.js calls decideLeadOfficer');
  ok(/decision\.mayRoundRobin/.test(src), '…and gates the rotation on its answer');
  // The ROTATION gate must not re-derive the rule. (The unrelated `tool !== 'subscribe'`
  // further down decides whether to email the SALES DESK — a different question, and
  // deliberately left alone; an earlier version of this assertion was too broad and
  // flagged it.)
  {
    const gate = src.slice(0, src.indexOf('pickRoundRobinOfficer()'));
    const lastIf = gate.lastIndexOf('if (');
    const condition = gate.slice(lastIf);
    ok(!/subscribe/.test(condition) && !/fromStaffPortal/.test(condition),
      '…and the rotation gate itself carries no second copy of the rule');
  }
}

console.log('\n6. The portal really does tell the tools who is driving');
{
  const officer = fs.readFileSync(path.join(__dirname, '../app-v2/src/lib/toolOfficer.js'), 'utf8');
  ok(/YS_FROM_STAFF_PORTAL\s*=\s*true/.test(officer), 'the host declares the staff-portal origin on the frame');
  ok(/win\.YSBRAND\s*=\s*officer/.test(officer), 'and stamps the signed-in staff member as the tool’s officer');
  ok(/me\.kind !== 'staff'/.test(officer), 'a borrower session is never stamped as an officer');
  ok(/keepExisting/.test(officer), 'a file’s ASSIGNED officer still wins over the operator');
  // The two embedding surfaces must both use it — one of them missing is the bug.
  for (const f of ['../app-v2/src/screens/StaffInvestorSuite.jsx', '../app-v2/src/components/TermSheetStudio.jsx']) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    ok(/stampToolOfficer\(/.test(s), `${path.basename(f)} stamps the frame`);
  }
  // And every tool that posts a lead must send the flag, or that tool is still
  // anonymous inside the portal.
  for (const f of ['../web/v2/tools/termsheet.js', '../web/v2/tools/rehab-budget.js',
                   '../web/v2/tools/track-record.js', '../web/v2/tools/loan-application.html']) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const posts = (s.match(/"\/api\/leads"/g) || []).length;
    const flags = (s.match(/fromStaffPortal/g) || []).length;
    ok(posts === 0 || flags >= posts,
      `${path.basename(f)}: every /api/leads post declares the origin (${flags} flag(s) for ${posts} post(s))`);
  }
}

console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ lead officer attribution: all assertions passed\n');
process.exit(fails ? 1 : 0);
