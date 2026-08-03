/**
 * Intake — turning a public website loan application into a REAL borrower +
 * application file (checklist auto-generated, officer routed, ClickUp task
 * created). The pricing/guideline engines are NOT invoked here; economics
 * arrive as a snapshot in the payload.
 *
 * TWO doors share the ONE core (`siteIntake`):
 *   POST /api/intake  — server-to-server, guarded by x-intake-key (unchanged).
 *   POST /api/apply   — the site's own submit (routes/apply.js), bot-defended
 *                       with the shared form token + honeypot instead of a key,
 *                       and optionally followed by account creation.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const C = require('../lib/crypto');
const notify = require('../lib/notify');
const cfg = require('../config');
const F = require('../lib/fields');
const { redactPII } = require('../lib/redact');
// (checklist generation now flows through the ensureFileConditions chokepoint)

// The public site sends money/units as formatted strings ("$500,000", "1,200").
// Coerce to plain numbers or NULL before they hit typed numeric columns —
// inserting "$500,000" raw throws a Postgres 22P02 and 500s a real submission.
/* A NUMBER THIS COLUMN CANNOT HOLD IS "NOT PROVIDED" HERE (post-merge audit
   2026-07-31). This is the PUBLIC marketing-tool door: the submitter is an
   anonymous visitor with no session and no screen to correct anything on, and
   the whole point of the route is to capture the lead. So an out-of-range value
   is DROPPED — exactly as this helper already drops a non-numeric one — rather
   than sent to numeric(14,2)/int4 to raise 22003 and lose the lead to a 500.
   The ceiling comes from lib/number-bounds so it can never drift from the one
   the staff edit doors quote back to a human. */
const numberBounds = require('../lib/number-bounds');
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n) || numberBounds.moneyOverflows(n)) return null;
  return n;
};
const int = (v) => {
  const n = num(v);
  if (n == null) return null;
  const r = Math.round(n);
  return numberBounds.intOverflows(r) ? null : r;
};
// A PERCENT column — numeric(6,3), not the numeric(14,2) `num()` is calibrated
// for. Same drop-don't-crash rule; only the ceiling differs.
const pct = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!isFinite(n) || numberBounds.pctOverflows(n)) return null;
  return n;
};

/**
 * The intake core. Creates/updates the borrower and creates the application in
 * ONE transaction, then returns `{ borrowerId, applicationId, assigned, dup,
 * borrowerExisted, hasAuth, followUp }`. The caller responds to the client
 * FIRST and then runs `followUp()` (checklist, ClickUp, notifications,
 * co-borrower/vesting) — a follow-up failure must never turn into a 500 that
 * makes the website resubmit the form and create a DUPLICATE application.
 */
async function siteIntake(p, opts = {}) {
  const source = opts.source || 'website_form';
  const email = p.email || p.b1Email;
  if (!email) { const e = new Error('borrower email required'); e.status = 400; throw e; }
  const client = await db.getClient();
  let dupOfBorrowerId = null;   // set when a shared email hit a DIFFERENT person's row
  let borrowerExisted = false;  // a borrowers row already carried this email (same person)
  let hasAuth = false;          // ...and that row already has portal credentials
  let borrowerId, appId, officerId = null, officerName = p.loOfficer || p.loanOfficerName || null;
  const submittedFirst = p.firstName || p.b1First || 'Unknown';
  const submittedLast = p.lastName || p.b1Last || 'Unknown';
  // MIDDLE NAME (db/345) — optional on the public form. If the applicant did not
  // get a middle-name box (an older cached page) but typed their whole name into
  // the first-name box, split it here rather than storing "Issac Michael" as a
  // first name: this is the door most legacy merged names came through.
  const PN = require('../lib/person-name');
  let submittedMiddle = String(p.middleName || p.b1Middle || '').trim();
  let submittedSuffix = String(p.nameSuffix || p.b1Suffix || '').trim();
  let nameSplitReason = null;
  if (!submittedMiddle && submittedFirst.trim().includes(' ')) {
    const sp = PN.splitStoredName({ first: submittedFirst, last: submittedLast });
    if (sp.changed) { submittedMiddle = sp.middle; submittedSuffix = submittedSuffix || sp.suffix; nameSplitReason = sp.needsReview ? sp.reason : null; }
  }
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
    const identity = require('../clickup/identity');
    const exRow = (await client.query(`SELECT id, first_name, last_name FROM borrowers WHERE email=$1 LIMIT 1`,
      [String(email).toLowerCase().trim()])).rows[0];
    if (exRow && identity.nameConflict(submittedFirst, submittedLast, exRow.first_name, exRow.last_name)) {
      dupOfBorrowerId = exRow.id;
    }
    borrowerExisted = !!exRow && !dupOfBorrowerId;
    // 1) upsert borrower (canonical profile) — or a DISTINCT profile when the
    // email already belongs to a different person (never a silent merge).
    const emailForRow = dupOfBorrowerId
      ? `noemail+intake-${require('crypto').randomBytes(6).toString('hex')}@clickup.local`
      : email;
    const b = await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,citizenship,middle_name,name_suffix,name_review_needed,name_review_reason)
       VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,''),$8,$9)
       ON CONFLICT (email) WHERE shares_email = false DO UPDATE SET
         -- Fill-only, like the name columns below: a submission may ADD a middle
         -- name we do not have, but never overwrite one already on the profile.
         middle_name=COALESCE(borrowers.middle_name,EXCLUDED.middle_name),
         name_suffix=COALESCE(borrowers.name_suffix,EXCLUDED.name_suffix),
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
       p.cellPhone || p.b1Phone || null, p.citizenship || p.b1Citizen || null,
       submittedMiddle, submittedSuffix, !!nameSplitReason, nameSplitReason]);
    borrowerId = b.rows[0].id;
    if (p.ssn || p.b1Ssn) {
      // #91/#92: only persist a real 9-digit SSN, canonically (digits only). A
      // partial/garbage value from the public form is skipped, never stored.
      const s = C.ssnForStorage(p.ssn || p.b1Ssn);
      if (s) await client.query(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3 WHERE id=$1`,
        [borrowerId, s.encrypted, s.last4]);
    }
    // Self-attested DOB / estimated FICO from the form FILL A BLANK only — they
    // never overwrite a value already on the profile (a real credit pull or a
    // staff-entered DOB always wins). DOB goes through the mandatory
    // sanitizeDob chokepoint (real calendar date + adult plausibility).
    {
      const dob = F.sanitizeDob(p.dob || p.b1Dob);
      const fico = F.sanitizeFico(int(p.fico || p.estFico));
      if (dob || fico) {
        await client.query(
          `UPDATE borrowers SET date_of_birth=COALESCE(date_of_birth,$2), fico=COALESCE(fico,$3), updated_at=now() WHERE id=$1`,
          [borrowerId, dob || null, fico || null]);
      }
    }
    if (borrowerExisted) {
      hasAuth = !!(await client.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [borrowerId])).rows[0];
    }
    // 2) resolve loan officer (by email or name) -> may be null (Lead Capture)
    if (p.loOfficerEmail || p.loanOfficerEmail) {
      // Case-insensitive: the site's branded links carry "Yehuda@…"-style
      // casing; the routing must not silently fall to Lead Capture over case.
      const o = await client.query(`SELECT id,full_name FROM staff_users WHERE lower(email)=lower($1) AND is_active=true`,
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
    const loanTypeIn = F.sanitizeLoanType(p.loanType || p.purpose);
    const asg = F.assignmentFields({
      // The loan PURPOSE governs both invariants the helper enforces: an
      // assignment is a purchase concept, and a refinance carries no purchase
      // price at all (owner-directed 2026-08-02 — it is sized on the as-is
      // value). The public form already sends `purchasePrice: null` on a
      // refinance; passing the purpose means a hand-rolled post to this open
      // endpoint cannot get one in either.
      loanType: loanTypeIn,
      isAssignment: !!(p.isAssignment || p.assignment),
      underlyingContractPrice: num(p.underlyingContractPrice || p.underlyingPrice),
      assignmentFee: num(p.assignmentFee),
      purchasePrice: num(p.purchasePrice || p.price),
    });
    /* THE DERIVED PRICE HAS TO FIT TOO (post-merge audit round 2, 2026-08-02).
       On an assignment `assignmentFields` binds purchase_price = underlying +
       fee, so the two PARTS can each be comfortably storable while the number
       actually written is not: $900bn + $900bn raised 22003 and LOST THE LEAD to
       a 500, which is the one failure this door exists to avoid. Judge what is
       BOUND, not only what was typed — the same reasoning the create doors got
       in fields.applicationNumberProblem. Those doors REFUSE; this one is
       public, so it DROPS, like every other unstorable value here. The two parts
       are still recorded, so nothing the sender typed is lost. */
    if (numberBounds.moneyOverflows(asg.purchasePrice)) asg.purchasePrice = null;
    /* THE REFINANCE ECONOMICS THE PUBLIC FORM ALREADY COLLECTS (owner-directed
       2026-08-02). `web/v2/tools/loan-application.html` has asked a refinancing
       applicant for the current payoff, the ORIGINAL purchase price and the date
       acquired for some time — and this door had nowhere to put any of them, so
       three answered questions were dropped on every single public refinance
       application and the file arrived missing exactly what the owner reported
       missing. Refinance-only, like every other door. */
    const isRefiIntake = require('../lib/deal-basis').sizesOnAsIsValue(loanTypeIn);
    const refiOnly = (v) => (isRefiIntake ? v : null);
    const payoffAmount = refiOnly(num(p.payoffAmount != null ? p.payoffAmount : p.payoff));
    const origPurchase = refiOnly(num(p.originalPurchasePrice != null ? p.originalPurchasePrice : p.origPrice2));
    // A typed 2-digit year resolves to the real year rather than persisting as
    // year 0026 (the 2026-07-15 date-incident rule); anything unreadable is null.
    const acqDate = refiOnly(F.normalizeTypedDate(p.acquisitionDate != null ? p.acquisitionDate : p.acqDate));
    const payoffLender = refiOnly(F.textColumn(p.payoffLender, 'payoff_lender'));
    const payoffLoanNo = refiOnly(F.textColumn(p.payoffLoanNumber, 'payoff_loan_number'));
    // Interest-reserve request: months (0..24 per the column CHECK) or an exact
    // dollar amount — both optional; display/record only, engines stay frozen.
    let irMonths = int(p.requestedIrMonths != null ? p.requestedIrMonths : p.resMonths);
    if (irMonths != null) irMonths = Math.max(0, Math.min(24, irMonths));
    let irAmount = num(p.requestedIrAmount != null ? p.requestedIrAmount : p.resAmount);
    if (irAmount != null && !(irAmount > 0)) irAmount = null;
    const a = await client.query(
      `INSERT INTO applications
         (borrower_id,loan_officer_id,loan_officer_name,program,loan_type,property_address,property_type,units,
          purchase_price,as_is_value,arv,rehab_budget,loan_amount,ltv,
          is_assignment,underlying_contract_price,assignment_fee,
          rehab_type,sqft_pre,sqft_post,requested_ir_months,requested_ir_amount,
          requested_exp_flips,requested_exp_holds,requested_exp_ground,
          payoff_amount,original_purchase_price,acquisition_date,payoff_lender,payoff_loan_number,
          personal_name_purchase,
          source,raw_intake,status,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
               $28,$29,$30,$31,$32,$33,$26,$27,'new',now()) RETURNING id`,
      [borrowerId, officerId, officerName, p.program || p.dealType || null, loanTypeIn,   // #95: public form can't persist a program as a loan type
       /* jsonbText, not JSON.stringify — a NUL byte anywhere in a PUBLIC form post is
          refused by Postgres and would strand the lead with a 500, the same failure
          mode as an unstorable number above (audit 2026-08-02). */
       F.jsonbText(p.propertyAddress || { line1: p.pStreet, city: p.pCity, state: p.pState, zip: p.pZip }),
       p.propertyType || p.propType || null, int(p.units || p.units24 || p.unitsN),
       asg.purchasePrice, num(p.asIsValue || p.asIs), num(p.arv),
       // `ltv` is numeric(6,3) — a PERCENT, not money — so `num()`'s
       // numeric(14,2) calibration is three orders of magnitude too loose for it
       // and an `ltv` of 5000 raised 22003 and LOST THE LEAD to a 500 (pre-merge
       // audit 2026-07-31). The shipped marketing form does not send it, but the
       // endpoint is public and accepts it. Dropped, like every other unstorable
       // value on this door.
       num(p.rehabBudget || p.rehab), num(p.loanAmount), pct(p.ltv),
       asg.isAssignment, asg.underlying, asg.assignFee,
       p.rehabType || null, int(p.sqftPre || p.sqftCurrent), int(p.sqftPost),
       irMonths, irAmount,
       int(p.expFlips) || 0, int(p.expHolds != null ? p.expHolds : p.expBrrrr) || 0, int(p.expGround) || 0,
       source, F.jsonbText(redactPII(p)),
       // $28..$32 — the refinance economics. Positional, and the placeholder list
       // above puts them BEFORE $26/$27 in the column order, so keep the two in
       // step: the column list reads … requested_exp_ground, payoff_amount,
       // original_purchase_price, acquisition_date, payoff_lender,
       // payoff_loan_number, source, raw_intake. (The borrower door learned this
       // the hard way — see its own note about a shifted bind list.)
       payoffAmount, origPurchase, acqDate, payoffLender, payoffLoanNo,
       /* $33 — HOW IS IT VESTED. The public form asks it now (owner-directed
          2026-08-02: "'Individual — no entity' on all three application doors").
          Same shared reading as the other two doors, and it defaults to an
          ENTITY, so a garbled answer on a public form can never silently drop
          the LLC condition off the file. Appended LAST and slotted before $26 in
          the VALUES list above — keep the two in step (see the note there). */
       F.vestsIndividually(p)]);
    appId = a.rows[0].id;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }

  // Everything below runs AFTER the caller has already responded 201 — each
  // block is best-effort and independently caught, so a hiccup here can never
  // resubmit-loop the website into duplicate applications.
  async function followUp() {
    // Shared-email dedup bookkeeping: keep the REAL email on the new profile as
    // an additional contact so it is never lost (the primary email slot holds
    // the placeholder to avoid the unique-email collision), record the pair for
    // human dedup review, and tell the admins.
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
          portalValue: `${[submittedFirst, submittedLast].filter(Boolean).join(' ')} AND ${require('../lib/person-name').displayName(other)}`.slice(0, 160) });
      } catch (dupErr) { console.error('[intake] dedup bookkeeping failed:', db.describeError(dupErr)); }
    }
    // CO-BORROWER from the same submission (map the whole form, not just the
    // primary): a lean version of the staff attach — heal-only upsert + link,
    // guarded by the SAME same-email-different-person rule. Never on the dup
    // path (that whole submission is already under human review).
    if (!dupOfBorrowerId) {
      try {
        const coFirst = p.coFirstName || p.b2First || null;
        const coLast = p.coLastName || p.b2Last || null;
        const coMiddle = String(p.coMiddleName || p.b2Middle || '').trim();   // optional (db/345)
        const coEmail = String(p.coEmail || p.b2Email || '').toLowerCase().trim();
        if (coEmail && coEmail !== String(email).toLowerCase().trim() && (coFirst || coLast)) {
          const identity = require('../clickup/identity');
          const ex2 = (await db.query(`SELECT id, first_name, last_name FROM borrowers WHERE email=$1 LIMIT 1`, [coEmail])).rows[0];
          if (ex2 && identity.nameConflict(coFirst || 'Unknown', coLast || 'Unknown', ex2.first_name, ex2.last_name)) {
            // The co-borrower email belongs to a DIFFERENT person's profile —
            // never adopt it silently; the full details stay in raw_intake for
            // staff to attach deliberately.
            console.warn(`[intake] co-borrower email matches a different person — left unlinked (app ${appId})`);
          } else {
            const cb = await db.query(
              `INSERT INTO borrowers (first_name,last_name,email,cell_phone,citizenship,middle_name)
               VALUES ($1,$2,$3,$4,$5,NULLIF($6,''))
               ON CONFLICT (email) WHERE shares_email = false DO UPDATE SET
                 middle_name=COALESCE(borrowers.middle_name,EXCLUDED.middle_name),
                 first_name=CASE WHEN lower(btrim(coalesce(borrowers.first_name,''))) IN ('','unknown','co-borrower')
                                  AND lower(btrim(EXCLUDED.first_name)) NOT IN ('','unknown')
                                 THEN EXCLUDED.first_name ELSE borrowers.first_name END,
                 last_name=CASE WHEN lower(btrim(coalesce(borrowers.last_name,''))) IN ('','unknown','co-borrower')
                                 AND lower(btrim(EXCLUDED.last_name)) NOT IN ('','unknown')
                                THEN EXCLUDED.last_name ELSE borrowers.last_name END,
                 cell_phone=COALESCE(borrowers.cell_phone,EXCLUDED.cell_phone),
                 citizenship=COALESCE(borrowers.citizenship,EXCLUDED.citizenship),
                 updated_at=now() RETURNING id`,
              [coFirst || 'Co-borrower', coLast || 'Unknown', coEmail, p.b2Phone || null, p.b2Citizen || null, coMiddle]);
            const coId = cb.rows[0].id;
            if (p.b2Ssn) {
              const s2 = C.ssnForStorage(p.b2Ssn);
              if (s2) await db.query(
                `UPDATE borrowers SET ssn_encrypted=COALESCE(ssn_encrypted,$2), ssn_last4=COALESCE(ssn_last4,$3) WHERE id=$1`,
                [coId, s2.encrypted, s2.last4]);
            }
            const coDob = F.sanitizeDob(p.b2Dob);
            if (coDob) await db.query(`UPDATE borrowers SET date_of_birth=COALESCE(date_of_birth,$2) WHERE id=$1`, [coId, coDob]);
            await db.query(`UPDATE applications SET co_borrower_id=$2 WHERE id=$1 AND co_borrower_id IS NULL`, [appId, coId]);
          }
        }
      } catch (coErr) { console.error('[intake] co-borrower attach failed:', db.describeError(coErr)); }
      // VESTING ENTITY from the form — resolved-or-created on the borrower and
      // wired through the vesting chokepoint (llc_id + LLC docs checklist +
      // condition + re-eval), same as the staff origination path.
      try {
        const entityName = String(p.entityName || p.eName || '').trim();
        if (entityName) {
          await require('../lib/vesting').setVestingLlcByName(appId, entityName, {
            source: 'intake',
            // Only used when the entity is genuinely NEW — a name the borrower
            // already has keeps its own details (never overwritten by a re-type).
            fields: { ein: (p.eEin || p.entityEin || null), formationState: (p.eState || p.entityState || null) },
          });
        }
      } catch (vestErr) { console.error('[intake] vesting wiring failed:', db.describeError(vestErr)); }
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
        // No officer picked (owner-directed 2026-07-24): the SALES desk inbox
        // gets the email; admins keep their in-app rows (no email blast). The
        // file still lands in Lead Capture for assignment exactly as before.
        // With no sales inbox configured, the legacy admin fan-out applies.
        const unassignedOpts = {
          type: 'unassigned_application', title: 'New application needs assignment (Lead Capture)',
          body: `${p.firstName || p.b1First || 'A borrower'} — ${addr}`, applicationId: appId,
          link: `/internal` };
        if (cfg.salesNotifyTo) {
          // Same file-identity subject suffix the admin emails get via enrichment.
          const built = notify.buildEmail({
            ...unassignedOpts,
            subjectTag: [`${p.firstName || p.b1First || ''} ${p.lastName || p.b1Last || ''}`.trim(), addr].filter(Boolean).join(' · '),
          }, 'staff');
          await require('../lib/email').sendMail({
            to: [cfg.salesNotifyTo], subject: built.subject, text: built.text, html: built.html,
            replyTo: (p.email || p.b1Email || null), _ctx: { type: 'unassigned_application', audience: 'staff' },
          }).catch(() => {});
          await notify.notifyAdmins({ ...unassignedOpts, inAppOnly: true });
        } else {
          await notify.notifyAdmins(unassignedOpts);
        }
      }
    } catch (followUpErr) { console.error('[intake] post-commit follow-up failed:', db.describeError(followUpErr)); }
  }
  return { borrowerId, applicationId: appId, assigned: !!officerId, officerId,
           dup: !!dupOfBorrowerId, borrowerExisted, hasAuth, followUp };
}

router.post('/', async (req, res) => {
  // Fail CLOSED: with no key configured this endpoint would accept anonymous
  // writes (spoofed borrowers/applications). Allow that only outside production.
  if (!cfg.intakeApiKey) {
    if (cfg.env === 'production')
      return res.status(503).json({ error: 'intake not configured (INTAKE_API_KEY unset)' });
  } else {
    // Constant-time compare (matches the webhook verifiers) — a plain !== leaks
    // the key byte-by-byte via response timing. Hash both sides to a fixed
    // length first so the comparison is also independent of the key length.
    const crypto = require('crypto');
    const h = (s) => crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest();
    if (!crypto.timingSafeEqual(h(req.get('x-intake-key')), h(cfg.intakeApiKey))) {
      return res.status(401).json({ error: 'bad intake key' });
    }
  }
  const p = req.body || {};
  if (!(p.email || p.b1Email)) return res.status(400).json({ error: 'borrower email required' });
  try {
    const out = await siteIntake(p, { source: 'website_form' });
    // The borrower + application are now saved. Respond success IMMEDIATELY — the
    // checklist + routing are best-effort follow-ups, and a failure there
    // must never turn into a 500 that makes the website resubmit the form and
    // create a DUPLICATE application.
    res.status(201).json({ ok: true, borrowerId: out.borrowerId, applicationId: out.applicationId, assigned: out.assigned });
    out.followUp().catch((e) => console.error('[intake] post-commit follow-up failed:', db.describeError(e)));
  } catch (e) {
    // Never leak raw DB error strings to the public endpoint.
    console.error('[intake] failed:', db.describeError(e));
    if (!res.headersSent) res.status(500).json({ error: 'could not save the application — please try again' });
  }
});

module.exports = router;
module.exports.siteIntake = siteIntake;
