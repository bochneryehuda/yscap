/**
 * Public lead capture. The marketing tools POST their submissions here instead
 * of opening the visitor's email client. We store the submission, notify the
 * routed loan officer (or the admin desk), and email the visitor a confirmation
 * — all server-side via the configured provider. No visitor login required.
 *
 *   POST /api/leads   { tool, name, email, phone, officerCode, subject, message, payload }
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { redactPII } = require('../lib/redact');

const TOOL_LABEL = {
  loan_application: 'Loan application',
  rehab_budget: 'Rehab budget / Scope of Work',
  term_sheet: 'Term sheet request',
  track_record: 'Track record',
  deal_analyzer: 'Deal analyzer',
  qualifier: 'Qualifier',
  contact: 'Contact request',
  subscribe: 'Newsletter / updates subscription',
  dscr_waitlist: 'DSCR instant pricing — waitlist',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Newsletter/updates subscriptions notify ONLY this single inbox (owner-directed
// 2026-07-15 — the whole admin desk was getting them and it made the team nervous).
// A plain routing address, not a secret; env-overridable without a code change.
const SUBSCRIBE_NOTIFY_TO = process.env.SUBSCRIBE_NOTIFY_TO || 'pilot@yscapgroup.com';

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
          WHERE lower(split_part(email,'@',1))=$1 AND is_active=true
          ORDER BY created_at ASC, id ASC LIMIT 1`, [code]);
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
    // #99: the marketing tools attach their generated PDF/Excel so the routed
    // officer receives the ACTUAL files server-side — no more ugly .eml draft the
    // visitor has to open and send. Cap count + size defensively (public,
    // email-sending endpoint); the provider layer gates further and, when a file
    // is too big to attach, the email still lists it by name.
    const atts = (Array.isArray(b.attachments) ? b.attachments : [])
      .filter(a => a && a.filename && a.dataBase64)
      .slice(0, 4)
      .map(a => {
        // Strict normalize (lib/upload-bytes): junk that is not base64 becomes
        // an empty (dropped) attachment instead of a corrupt email file.
        let content = '';
        try { content = require('../lib/upload-bytes').normalizeBase64String(a.dataBase64); } catch (_) { /* dropped below */ }
        return {
          filename: String(a.filename).slice(0, 180),
          contentType: a.contentType || 'application/octet-stream',
          content,
        };
      })
      .filter(a => a.content.length > 0 && a.content.length < 8 * 1024 * 1024);
    const notifyOpts = {
      type: 'new_lead',
      title: `New ${label.toLowerCase()} from ${name || email || 'a visitor'}`,
      body: (b.message ? String(b.message).slice(0, 4000) : null) || `A visitor submitted the ${label.toLowerCase()} on the site.`,
      meta, link: '/internal/leads', ctaLabel: 'Open leads',
      attachments: atts, files: atts.map(a => a.filename),
    };

    // Notify the routed officer, else the admin desk (in-app + branded email).
    // EXCEPTION — a newsletter/updates SUBSCRIPTION is low-signal and was pinging
    // the whole admin desk (owner-directed 2026-07-15: "making everybody nervous").
    // It now goes to a SINGLE inbox (pilot@yscapgroup.com) as email only — no
    // fan-out, no in-app rows for every admin. The lead is still stored and shows
    // on the Leads desk for anyone who looks.
    try {
      if (officerId) { await notify.notifyStaff(officerId, { ...notifyOpts, emailTo: officerRow.email }); }
      else if (tool === 'subscribe') {
        const built = notify.buildEmail(notifyOpts, 'staff');
        await require('../lib/email').sendMail({ to: [SUBSCRIBE_NOTIFY_TO], subject: built.subject, text: built.text, html: built.html }).catch(() => {});
      }
      else { await notify.notifyAdmins(notifyOpts); }
      await db.query(`UPDATE leads SET emailed_officer=true WHERE id=$1`, [leadId]);
    } catch (_) { /* never fail the submission on a notify hiccup */ }

    // Confirmation to the visitor (best-effort).
    if (email) {
      try {
        // The body promises "just reply to this email" — when the lead routed to
        // an officer, replies go to that officer instead of the no-reply sender.
        // No application exists yet, so the file+ inbox doesn't apply here.
        const r = await mail.send('leadReceived', email, {
          firstName: name ? String(name).split(' ')[0] : '',
          toolLabel: label,
          officerName: officerRow ? officerRow.full_name : null,
        }, { replyTo: officerRow?.email || null });
        if (r && r.ok) await db.query(`UPDATE leads SET emailed_submitter=true WHERE id=$1`, [leadId]);
      } catch (_) {}
    }

    res.status(201).json({ ok: true, leadId, routedTo: officerRow ? officerRow.full_name : 'the YS Capital Group loan desk' });
  } catch (e) {
    console.error('[leads] submit failed:', db.describeError(e));
    res.status(500).json({ error: 'could not submit — please try again' });
  }
});

module.exports = router;
