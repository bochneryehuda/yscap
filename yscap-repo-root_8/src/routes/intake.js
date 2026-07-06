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
const { generateChecklist } = require('./borrower');

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
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // 1) upsert borrower (canonical profile)
    const b = await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,citizenship)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`,
      [p.firstName || p.b1First || 'Unknown', p.lastName || p.b1Last || 'Unknown', email,
       p.cellPhone || p.b1Phone || null, p.citizenship || p.b1Citizen || null]);
    const borrowerId = b.rows[0].id;
    if (p.ssn || p.b1Ssn) {
      const ssn = p.ssn || p.b1Ssn;
      await client.query(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3 WHERE id=$1`,
        [borrowerId, C.encryptSSN(ssn), String(ssn).replace(/\D/g, '').slice(-4)]);
    }
    // 2) resolve loan officer (by email or name) -> may be null (Lead Capture)
    let officerId = null, officerName = p.loOfficer || p.loanOfficerName || null;
    if (p.loOfficerEmail || p.loanOfficerEmail) {
      const o = await client.query(`SELECT id,full_name FROM staff_users WHERE email=$1 AND is_active=true`,
        [p.loOfficerEmail || p.loanOfficerEmail]);
      if (o.rows[0]) { officerId = o.rows[0].id; officerName = o.rows[0].full_name; }
    } else if (officerName) {
      const o = await client.query(`SELECT id FROM staff_users WHERE full_name ILIKE $1 AND is_active=true LIMIT 1`, [officerName]);
      if (o.rows[0]) officerId = o.rows[0].id;
    }
    // 3) create the application (distinct property address)
    const a = await client.query(
      `INSERT INTO applications
         (borrower_id,loan_officer_id,loan_officer_name,program,loan_type,property_address,property_type,units,
          purchase_price,as_is_value,arv,rehab_budget,loan_amount,ltv,source,raw_intake,status,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'website_form',$15,'new',now()) RETURNING id`,
      [borrowerId, officerId, officerName, p.program || p.dealType || null, p.loanType || p.purpose || null,
       JSON.stringify(p.propertyAddress || { line1: p.pStreet, city: p.pCity, state: p.pState, zip: p.pZip }),
       p.propertyType || p.propType || null, p.units || p.units24 || p.unitsN || null,
       p.purchasePrice || p.price || null, p.asIsValue || p.asIs || null, p.arv || null,
       p.rehabBudget || p.rehab || null, p.loanAmount || null, p.ltv || null, JSON.stringify(redactPII(p))]);
    const appId = a.rows[0].id;
    await client.query('COMMIT');

    // 4) checklist + notification routing (outside the txn)
    await generateChecklist(appId, borrowerId, p.program || p.dealType, p.loanType || p.purpose);
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
    res.status(201).json({ ok: true, borrowerId, applicationId: appId, assigned: !!officerId });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

module.exports = router;
