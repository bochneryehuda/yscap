/**
 * Intake — the site's loan application POSTs here (guarded by x-intake-key).
 * Creates/updates the borrower, creates the application (each a distinct
 * property address), auto-generates the checklist, and routes a notification
 * to the selected loan officer — or to the admins (Lead Capture) if none.
 * The pricing/guideline engines are NOT invoked here; economics arrive as a
 * snapshot in the payload.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const C = require('../lib/crypto');
const notify = require('../lib/notify');
const cfg = require('../config');
const { redactPII } = require('../lib/redact');
// (checklist generation now flows through the ensureFileConditions chokepoint)

router.post('/', async (req, res) => {
  // Fail CLOSED: with no key configured this endpoint would accept anonymous
  // writes (spoofed borrowers/applications). Allow that only outside production.
  if (!cfg.intakeApiKey) {
    if (cfg.env === 'production')
      return res.status(503).json({ error: 'intake not configured (INTAKE_API_KEY unset)' });
  } else if (req.get('x-intake-key') !== cfg.intakeApiKey) {
    return res.status(401).json({ error: 'bad intake key' });
  }
  const p = req.body || {};
  const email = p.email || p.b1Email;
  if (!email) return res.status(400).json({ error: 'borrower email required' });
  // The public site sends money/units as formatted strings ("$500,000", "1,200").
  // Coerce to plain numbers or NULL before they hit typed numeric columns —
  // inserting "$500,000" raw throws a Postgres 22P02 and 500s a real submission.
  const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
  const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };
  const client = await db.getClient();
  let dupOfBorrowerId = null;   // set when a shared email hit a DIFFERENT person's row
  try {
    await client.query('BEGIN');
    // SAME-EMAIL, DIFFERENT-PERSON guard (owner incident 2026-07-15 night): a
    // public submission on a family-shared email must NEVER adopt an existing
    // row whose NAME belongs to someone else (that silent merge folded a loan
    // officer's lead and a different real borrower into one profile and handed
    // the file to the wrong officer). This is a public endpoint — nobody is
    // here to answer a 409 — so the submission gets a DISTINCT profile with a
    // placeholder email instead; the real email is preserved as an additional
    // contact, the pair is queued for human dedup review, and admins are told.
    const submittedFirst = p.firstName || p.b1First || 'Unknown';
    const submittedLast = p.lastName || p.b1Last || 'Unknown';
    const identity = require('../clickup/identity');
    const exRow = (await client.query(`SELECT id, first_name, last_name FROM borrowers WHERE email=$1 LIMIT 1`,
      [String(email).toLowerCase().trim()])).rows[0];
    if (exRow && identity.nameConflict(submittedFirst, submittedLast, exRow.first_name, exRow.last_name)) {
      dupOfBorrowerId = exRow.id;
    }
    // 1) upsert borrower (canonical profile) — or a DISTINCT profile when the
    // email already belongs to a different person (never a silent merge).
    const emailForRow = dupOfBorrowerId
      ? `noemail+intake-${require('crypto').randomBytes(6).toString('hex')}@clickup.local`
      : email;
    const b = await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,citizenship)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET
         -- A real submitted name heals a placeholder row; never a real one.
         first_name=CASE WHEN lower(btrim(coalesce(borrowers.first_name,''))) IN ('','unknown','co-borrower')
                          AND lower(btrim(EXCLUDED.first_name)) NOT IN ('','unknown')
                         THEN EXCLUDED.first_name ELSE borrowers.first_name END,
         last_name=CASE WHEN lower(btrim(coalesce(borrowers.last_name,''))) IN ('','unknown','co-borrower')
                         AND lower(btrim(EXCLUDED.last_name)) NOT IN ('','unknown')
                        THEN EXCLUDED.last_name ELSE borrowers.last_name END,
         cell_phone=COALESCE(borrowers.cell_phone,EXCLUDED.cell_phone),
         citizenship=COALESCE(borrowers.citizenship,EXCLUDED.citizenship),
         updated_at=now() RETURNING id`,
      [submittedFirst, submittedLast, emailForRow,
       p.cellPhone || p.b1Phone || null, p.citizenship || p.b1Citizen || null]);
    const borrowerId = b.rows[0].id;
    if (p.ssn || p.b1Ssn) {
      // #91/#92: only persist a real 9-digit SSN, canonically (digits only). A
      // partial/garbage value from the public form is skipped, never stored.
      const s = C.ssnForStorage(p.ssn || p.b1Ssn);
      if (s) await client.query(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3 WHERE id=$1`,
        [borrowerId, s.encrypted, s.last4]);
    }
    // 2) resolve loan officer (by email or name) -> may be null (Lead Capture)
    let officerId = null, officerName = p.loOfficer || p.loanOfficerName || null;
    if (p.loOfficerEmail || p.loanOfficerEmail) {
      const o = await client.query(`SELECT id,full_name FROM staff_users WHERE email=$1 AND is_active=true`,
        [p.loOfficerEmail || p.loanOfficerEmail]);
      if (o.rows[0]) { officerId = o.rows[0].id; officerName = o.rows[0].full_name; }
    } else if (officerName) {
      const o = await client.query(`SELECT id FROM staff_users WHERE full_name ILIKE $1 AND is_active=true ORDER BY created_at ASC, id ASC LIMIT 1`, [officerName]);
      if (o.rows[0]) officerId = o.rows[0].id;
    }
    // 3) create the application (distinct property address)
    // Assignment fields flow through so ensureFileConditions generates the
    // assignment condition on an intake assignment deal (audit finding #3).
    // Same shared invariant as every other create path (#96): the ticked flag is
    // truth, underlying/fee hard-null off a non-assignment, purchase = underlying
    // + fee. The public form uses looser key names, so normalize them first.
    const asg = require('../lib/fields').assignmentFields({
      isAssignment: !!(p.isAssignment || p.assignment),
      underlyingContractPrice: num(p.underlyingContractPrice || p.underlyingPrice),
      assignmentFee: num(p.assignmentFee),
      purchasePrice: num(p.purchasePrice || p.price),
    });
    const a = await client.query(
      `INSERT INTO applications
         (borrower_id,loan_officer_id,loan_officer_name,program,loan_type,property_address,property_type,units,
          purchase_price,as_is_value,arv,rehab_budget,loan_amount,ltv,
          is_assignment,underlying_contract_price,assignment_fee,source,raw_intake,status,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'website_form',$18,'new',now()) RETURNING id`,
      [borrowerId, officerId, officerName, p.program || p.dealType || null, require('../lib/fields').sanitizeLoanType(p.loanType || p.purpose),   // #95: public form can't persist a program as a loan type
       JSON.stringify(p.propertyAddress || { line1: p.pStreet, city: p.pCity, state: p.pState, zip: p.pZip }),
       p.propertyType || p.propType || null, int(p.units || p.units24 || p.unitsN),
       asg.purchasePrice, num(p.asIsValue || p.asIs), num(p.arv),
       num(p.rehabBudget || p.rehab), num(p.loanAmount), num(p.ltv),
       asg.isAssignment, asg.underlying, asg.assignFee,
       JSON.stringify(redactPII(p))]);
    const appId = a.rows[0].id;
    await client.query('COMMIT');

    // The borrower + application are now saved. Respond success IMMEDIATELY — the
    // checklist + routing below are best-effort follow-ups, and a failure there
    // must never turn into a 500 that makes the website resubmit the form and
    // create a DUPLICATE application.
    res.status(201).json({ ok: true, borrowerId, applicationId: appId, assigned: !!officerId });
    // Shared-email dedup bookkeeping (post-commit, best-effort): keep the REAL
    // email on the new profile as an additional contact so it is never lost
    // (the primary email slot holds the placeholder to avoid the unique-email
    // collision), record the pair for human dedup review, and tell the admins.
    if (dupOfBorrowerId) {
      try {
        await db.query(
          `INSERT INTO borrower_contacts (borrower_id, kind, value, source)
           VALUES ($1,'email',$2,'intake') ON CONFLICT (borrower_id, kind, value) DO NOTHING`,
          [borrowerId, String(email).toLowerCase().trim()]);
        await db.query(
          `INSERT INTO borrower_dedup_candidates (borrower_id, matched_borrower_id, reason, source_task_id)
           VALUES ($1,$2,'shared_email_uncorroborated',NULL)
           ON CONFLICT (borrower_id, matched_borrower_id) DO NOTHING`,
          [borrowerId, dupOfBorrowerId]);
        await notify.notifyAdmins({
          type: 'borrower_dedup', title: 'Shared email — two different names (kept separate)',
          body: `A website application from "${(p.firstName || p.b1First || '')} ${(p.lastName || p.b1Last || '')}" used an email that already belongs to a different person's profile. ` +
            `The new file was created on its OWN profile (placeholder email); the submitted email is saved as an additional contact. Review the pair and fix the primary email.`,
          link: `/internal/borrowers/${borrowerId}` });
        // Owner-directed 2026-07-15 night: a shared email is ITS OWN review
        // card in Sync review — "assign this email to ONE borrower". The boot
        // sweep re-produces and auto-closes it; this makes it immediate.
        const key = 'dedup:' + [String(borrowerId), String(dupOfBorrowerId)].sort().join(':');
        const other = (await db.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [dupOfBorrowerId])).rows[0] || {};
        await require('../lib/sync-review').queueReview({
          borrowerId, taskId: key, direction: 'inbound',
          fieldKey: 'shared_email', reason: 'shared_email_needs_reassignment',
          suppressIfRejected: true,
          rawValue: JSON.stringify({ b1: borrowerId, b2: dupOfBorrowerId, source: 'intake' }).slice(0, 300),
          clickupValue: String(email).toLowerCase().trim().slice(0, 160),
          portalValue: `${[submittedFirst, submittedLast].filter(Boolean).join(' ')} AND ${[other.first_name, other.last_name].filter(Boolean).join(' ')}`.slice(0, 160) });
      } catch (dupErr) { console.error('[intake] dedup bookkeeping failed:', db.describeError(dupErr)); }
    }
    try {
      // Invariant chokepoint (root fix 2026-07-14): derives program/loan
      // type/assignment from the SAVED row — this caller used to pass no opts
      // at all, so an intake assignment deal never got its assignment condition.
      await require('../lib/conditions/ensure').ensureFileConditions(appId, { reason: 'intake' });
      // Create + link the ClickUp task in the correct folder the moment a file is
      // started from the public website form too (#92) — the same create-on-start
      // wired into the staff + borrower origination paths. Best-effort.
      require('../clickup/orchestrator').createForNewFile(appId).catch((e) => console.error('[clickup] create-on-start (intake)', appId, e && e.message));
      const addr = p.pStreet || p.propertyAddress?.line1 || 'new property';
      if (officerId) {
        await notify.notifyStaff(officerId, {
          type: 'new_application', title: 'New application assigned to you',
          body: `${p.firstName || p.b1First || 'A borrower'} — ${addr}`, applicationId: appId,
          link: `/internal/app/${appId}` });
      } else {
        await notify.notifyAdmins({
          type: 'unassigned_application', title: 'New application needs assignment (Lead Capture)',
          body: `${p.firstName || p.b1First || 'A borrower'} — ${addr}`, applicationId: appId,
          link: `/internal` });
      }
    } catch (followUp) { console.error('[intake] post-commit follow-up failed:', db.describeError(followUp)); }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Never leak raw DB error strings to the public endpoint.
    console.error('[intake] failed:', db.describeError(e));
    if (!res.headersSent) res.status(500).json({ error: 'could not save the application — please try again' });
  } finally { client.release(); }
});

module.exports = router;
