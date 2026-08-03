'use strict';
/**
 * "INDIVIDUAL — NO ENTITY" IS OFFERED ON ALL THREE APPLICATION DOORS
 * (owner-directed 2026-08-02).
 *
 * The rule, the Gold refusal, the affidavit condition and the display all
 * shipped first — but the CHOICE existed in exactly one place: a staff waiver
 * button INSIDE an already-created file. So every applicant had to claim an
 * entity and a staffer undid it afterwards. This pins the three doors that can
 * create a file:
 *
 *   1. the borrower's application  (app-v2 Apply.jsx → /drafts/:id/submit)
 *   2. the staff new-file form     (app-v2 StaffNewFile.jsx → POST /applications)
 *   3. the public loan application (web/v2/tools/loan-application.html → intake)
 *
 * The public form is the interesting one: it has ASKED since it shipped and even
 * printed the answer on its review summary, but never SENT it — the same
 * collected-then-discarded class as the refinance fields.
 *
 * PURE — reads the shared reader and the source of each door. No DB, no browser.
 */
const fs = require('fs');
const path = require('path');
const F = require('../src/lib/fields');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

console.log('1. ONE reading of the answer, shared by every door');
ok(typeof F.vestsIndividually === 'function', 'fields.vestsIndividually is the shared reader');
ok(F.vestsIndividually({}) === false,
  'nothing said → an ENTITY. The safe default: reading a blank as "individual" would silently drop the LLC condition');
ok(F.vestsIndividually({ vesting: 'individual' }) === true, 'the radio value is understood');
ok(F.vestsIndividually({ vesting: 'no_entity' }) === true, '…and so is "no entity"');
ok(F.vestsIndividually({ personalNamePurchase: true }) === true, '…and the explicit flag');
ok(F.vestsIndividually({ vesting: 'entity' }) === false, 'an entity answer is an entity');
ok(F.vestsIndividually({ vesting: 'garbage' }) === false,
  'an answer nothing can read never drops the LLC condition');
ok(F.vestsIndividually({ vesting: 'individual', llcName: 'Smith Holdings LLC' }) === false,
  'A NAMED ENTITY WINS over the radio — the same precedence vesting-program-rule applies (llc_id wins), so the two can never disagree about one file');
ok(F.vestsIndividually({ personalNamePurchase: true, entityName: 'ABC LLC' }) === false,
  '…however the entity was spelled');

console.log('\n2. every CREATE door stores the answer');
for (const [file, label] of [
  ['src/routes/staff.js', 'the staff new-file door'],
  ['src/routes/borrower.js', 'the borrower door'],
  ['src/routes/intake.js', 'the public intake door'],
]) {
  const s = read(file);
  ok(/vestsIndividually/.test(s), `${label} reads the shared answer`);
  ok(/personal_name_purchase/.test(s), `${label} writes the column`);
}
{
  // The borrower has TWO create paths — a direct create and the draft submit —
  // and the application form uses the DRAFT one, so covering only the first
  // would leave the door this feature exists for still broken.
  const s = read('src/routes/borrower.js');
  const inserts = s.match(/INSERT INTO applications[\s\S]{0,1200}?RETURNING/g) || [];
  ok(inserts.length >= 2, 'the borrower door really does have two create paths');
  ok(inserts.every((q) => /personal_name_purchase/.test(q)),
    '…and BOTH store the vesting answer (the draft submit is the one the form uses)');
}
{
  /* A SHIFTED BIND IS THE FAILURE MODE HERE, and this door has already been bitten
     by it once (its own comment records the interest-reserve amount landing in
     payoff_lender). Every placeholder must be contiguous from $1 with no gap. */
  for (const file of ['src/routes/staff.js', 'src/routes/borrower.js', 'src/routes/intake.js']) {
    const s = read(file);
    for (const m of s.matchAll(/INSERT INTO applications[\s\S]{0,1400}?VALUES \(([^)]*)\)/g)) {
      const nums = [...m[1].matchAll(/\$(\d+)/g)].map((x) => +x[1]);
      if (!nums.length) continue;
      const uniq = new Set(nums);
      const max = Math.max(...nums);
      ok(uniq.size === max && [...Array(max)].every((_, i) => uniq.has(i + 1)),
        `${path.basename(file)}: placeholders run $1..$${max} with no gap`);
    }
  }
}

console.log('\n3. the borrower application ASKS');
{
  const s = read('app-v2', 'src', 'screens', 'Apply.jsx');
  ok(/How will you hold title\?/.test(s), 'the question is on the screen');
  ok(/no entity/i.test(s), '…offering "no entity" in words');
  ok(/vesting: 'individual'/.test(s), '…and it records the choice');
  ok(/vesting: 'individual', entityName: '', llcId: ''/.test(s),
    'choosing their own name CLEARS any entity — the two contradict, so one has to go');
}

console.log('\n4. the staff new-file form ASKS');
{
  const s = read('app-v2', 'src', 'screens', 'StaffNewFile.jsx');
  ok(/How is it vested\?/.test(s), 'the question is on the screen');
  ok(/vesting: 'individual', entityName: '', llcId: ''/.test(s), 'picking individual clears the entity');
  ok(/vesting: f\.vesting \|\| 'entity'/.test(s), '…and the choice is SENT (the gap this closes)');
  ok(/Gold Standard program will refuse/i.test(s),
    '…and it says up front that Gold will refuse an individually-vested file');
}

console.log('\n5. the public loan application SENDS what it always asked');
{
  const s = read('web', 'v2', 'tools', 'loan-application.html');
  ok(/id="vestEntity"/.test(s), 'the form has asked the question all along');
  ok(/vesting: el\("vestEntity"\)\.checked \? "entity" : "individual"/.test(s),
    '…and it now SENDS the answer — it used to be collected and thrown away');
  ok(/llcName: el\("vestEntity"\)\.checked \? val\("eName"\) : ""/.test(s),
    '…along with the entity name, so the server\'s entity-wins rule has something to weigh');
}

console.log('\n6. nothing here touches a frozen pricing engine');
ok(!/standard-program|gold-standard|termsheet\.js/.test(read('src', 'lib', 'fields.js')),
  'the shared reader is pure field handling — no engine is involved');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  vesting-doors: the choice is offered, sent and stored on all three application doors');
process.exit(fail ? 1 : 0);
