/**
 * Public lead capture. The marketing tools POST their submissions here instead
 * of opening the visitor's email client. We store the submission, notify the
 * routed loan officer (or the admin desk), and email the visitor a confirmation
 * — all server-side via the configured provider. No visitor login required.
 *
 *   POST /api/leads   { tool, name, email, phone, officerCode, subject, message, payload }
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { redactPII } = require('../lib/redact');

const TOOL_LABEL = {
  loan_application: 'Loan application',
  rehab_budget: 'Rehab budget / Scope of Work',
  term_sheet: 'Term sheet request',
  deal_analyzer: 'Deal analyzer',
  qualifier: 'Qualifier',
  contact: 'Contact request',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lightweight in-memory per-IP rate limit — this endpoint is public and sends
// email, so cap bursts. (Per-process; fine for a single-instance service.)
const HITS = new Map();
const WINDOW_MS = 60 * 60 * 1000, MAX_PER_WINDOW = 30;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 5000) for (const [k, v] of HITS) if (!v.some(t => now - t < WINDOW_MS)) HITS.delete(k);
  return arr.length > MAX_PER_WINDOW;
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const tool = String(b.tool || 'contact').slice(0, 60);
  const name = b.name ? String(b.name).slice(0, 200) : null;
  const email = b.email ? String(b.email).trim().slice(0, 200) : null;
  const phone = b.phone ? String(b.phone).slice(0, 40) : null;
  if (!email && !phone) return res.status(400).json({ error: 'email or phone required' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'too many submissions — please try again later' });

  try {
    // Resolve the branded ?lo= officer code to a real, selectable staff row.
    let officerId = null, officerRow = null;
    const code = b.officerCode ? String(b.officerCode).toLowerCase().replace(/[^a-z0-9._-]/g, '') : '';
    if (code) {
      const o = await db.query(
        `SELECT id, full_name, email FROM staff_users
          WHERE lower(split_part(email,'@',1))=$1 AND is_active=true LIMIT 1`, [code]);
      if (o.rows[0]) { officerRow = o.rows[0]; officerId = o.rows[0].id; }
    }

    const label = TOOL_LABEL[tool] || tool;
    const ins = await db.query(
      `INSERT INTO leads (tool,name,email,phone,officer_code,officer_id,subject,message,payload,ip_address,user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tool, name, email, phone, code || null, officerId,
       b.subject ? String(b.subject).slice(0, 240) : `${label} — ${name || email || 'new lead'}`,
       b.message ? String(b.message).slice(0, 4000) : null,
       b.payload ? JSON.stringify(redactPII(b.payload)) : null,
       req.ip, (req.get('user-agent') || '').slice(0, 400)]);
    const leadId = ins.rows[0].id;

    // Build a compact summary for the internal notification.
    const meta = [];
    if (name) meta.push({ label: 'Name', value: name });
    if (email) meta.push({ label: 'Email', value: email });
    if (phone) meta.push({ label: 'Phone', value: phone });
    meta.push({ label: 'Tool', value: label });
    const notifyOpts = {
      type: 'new_lead',
      title: `New ${label.toLowerCase()} from ${name || email || 'a visitor'}`,
      body: b.message || `A visitor submitted the ${label.toLowerCase()} on the site.`,
      meta, link: '/staff/leads', ctaLabel: 'Open leads',
    };

    // Notify the routed officer, else the admin desk (in-app + branded email).
    try {
      if (officerId) { await notify.notifyStaff(officerId, { ...notifyOpts, emailTo: officerRow.email }); }
      else { await notify.notifyAdmins(notifyOpts); }
      await db.query(`UPDATE leads SET emailed_officer=true WHERE id=$1`, [leadId]);
    } catch (_) { /* never fail the submission on a notify hiccup */ }

    // Confirmation to the visitor (best-effort).
    if (email) {
      try {
        const r = await mail.send('leadReceived', email, {
          firstName: name ? String(name).split(' ')[0] : '',
          toolLabel: label,
          officerName: officerRow ? officerRow.full_name : null,
        });
        if (r && r.ok) await db.query(`UPDATE leads SET emailed_submitter=true WHERE id=$1`, [leadId]);
      } catch (_) {}
    }

    res.status(201).json({ ok: true, leadId, routedTo: officerRow ? officerRow.full_name : 'the YS Capital loan desk' });
  } catch (e) {
    console.error('[leads] submit failed:', db.describeError(e));
    res.status(500).json({ error: 'could not submit — please try again' });
  }
});

module.exports = router;
