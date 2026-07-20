/**
 * Identity-field sync-review normalization (owner-reported 2026-07-20, Shloimy
 * Friedman). Two parts:
 *   (1) CODE — src/clickup/mapper.js fieldValueEquivalent now treats a case-only
 *       email difference and a formatting-only SSN difference as EQUIVALENT, so
 *       the outbound no-op suppression skips them and the PII overwrite shield
 *       never queues a review. (Pure, no DB — always runs.)
 *   (2) BACKFILL — db/194 auto-closes the FALSE pii_overwrite_blocked rows that
 *       are already in the queue, while leaving genuine conflicts OPEN. (DB-gated.)
 */
const mapper = require('../src/clickup/mapper');
const F = require('../src/clickup/fields');

let failures = 0;
const eq = (name, got, want) => { const ok = got === want; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(got)} want ${JSON.stringify(want)})`}`); if (!ok) failures++; };

// ---- (1) the code fix — no DB needed ---------------------------------------
const feq = mapper.fieldValueEquivalent;
eq('email case-only is equivalent (the reported bug)', feq(F.SHARED.borrowerEmail, 'Shloimy6125@gmail.com', 'shloimy6125@gmail.com'), true);
eq('email different is NOT equivalent', feq(F.SHARED.borrowerEmail, 'a@b.com', 'z@b.com'), false);
eq('ssn dashes-vs-digits is equivalent (the reported bug)', feq(F.SHARED.borrowerSSN, '123-45-4776', '123454776'), true);
eq('ssn different is NOT equivalent', feq(F.SHARED.borrowerSSN, '123-45-4776', '888-88-8888'), false);

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP db-backfill part (no DATABASE_URL)');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL sync-review-pii-normalize (code) assertions passed');
    process.exit(failures ? 1 : 0);
  }
  process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
  const db = require('../src/db');
  const fs = require('fs');
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const ids = {};
  const seed = async (key, fieldKey, cur, prop) => {
    const task = `pii-test-${key}-${sfx}`;
    // Mirror what queueReview writes for an OUTBOUND row: current_value +
    // clickup_value = the ClickUp side; proposed_value + portal_value = PILOT's.
    // Populating all four exercises the migration's primary (clickup/portal) path.
    const r = await db.query(
      `INSERT INTO sync_review_queue (task_id, direction, field_key, current_value, proposed_value, clickup_value, portal_value, reason, status)
       VALUES ($1,'outbound',$2,$3,$4,$3,$4,'pii_overwrite_blocked','open') RETURNING id`,
      [task, fieldKey, cur, prop]);
    ids[key] = r.rows[0].id;
  };
  const statusOf = async (id) => (await db.query(`SELECT status, auto_resolved FROM sync_review_queue WHERE id=$1`, [id])).rows[0];
  try {
    // false positives (should close) …
    await seed('email_case', 'email', 'Shloimy6125@gmail.com', 'shloimy6125@gmail.com');
    await seed('ssn_mask', 'ssn', '✱✱✱-✱✱-4776', '✱✱✱-✱✱-4776');
    // … and genuine conflicts (must stay open)
    await seed('email_diff', 'email', 'real@x.com', 'typo@x.com');
    await seed('ssn_diff', 'ssn', '✱✱✱-✱✱-4776', '✱✱✱-✱✱-9999');

    // Run the actual backfill migration SQL.
    await db.query(fs.readFileSync(require('path').join(__dirname, '../db/195_close_false_pii_email_ssn_reviews.sql'), 'utf8'));

    const emailCase = await statusOf(ids.email_case);
    const ssnMask = await statusOf(ids.ssn_mask);
    const emailDiff = await statusOf(ids.email_diff);
    const ssnDiff = await statusOf(ids.ssn_diff);
    eq('backfill closes the case-only email review', emailCase.status === 'resolved' && emailCase.auto_resolved === true, true);
    eq('backfill closes the formatting-only SSN review', ssnMask.status === 'resolved' && ssnMask.auto_resolved === true, true);
    eq('backfill leaves a genuinely different email OPEN', emailDiff.status, 'open');
    eq('backfill leaves a genuinely different SSN OPEN', ssnDiff.status, 'open');
  } catch (e) {
    console.error('ERROR', e.message); failures++;
  } finally {
    try { await db.query(`DELETE FROM sync_review_queue WHERE task_id LIKE $1`, [`pii-test-%-${sfx}`]); } catch (_) {}
  }
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL sync-review-pii-normalize assertions passed');
  process.exit(failures ? 1 : 0);
})();
