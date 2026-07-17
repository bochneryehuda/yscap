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

/* ------------------------------------------------------------------ #153 —
 * Bot-spam defense. Root-caused 2026-07-17: the owner's inbox was getting
 * "New newsletter / updates subscription from <random>@…" ALL DAY. It is NOT a
 * resend loop (each notification sends exactly once per POST) — bots were
 * hammering this public endpoint, and every hit stored a lead + sent up to two
 * emails (owner notification + visitor "confirmation" backscatter to a spoofed
 * address). Layers, all dependency-free:
 *   1. FORM TOKEN — GET /api/leads/token hands the page an HMAC-signed
 *      timestamp; the pure-email tools (subscribe / dscr_waitlist) must echo a
 *      token that is valid AND at least LEADS_TOKEN_MIN_MS old (a human dwells
 *      on the page; a curl replay never fetched one). Other tools keep working
 *      without it (their forms carry real content + their own token later).
 *   2. HONEYPOT — a hidden "website" field on the forms; any tool that arrives
 *      with it filled is a bot.
 *   3. DEDUP — the same email+tool within 30 days never creates a second lead
 *      row or another email (also absorbs double-clicks).
 *   4. MX CHECK — subscribe-class domains must resolve mail (best-effort,
 *      fail-open on DNS trouble; kills invented domains, not spoofed real ones).
 *   5. NO CONFIRMATION BACKSCATTER — subscribe-class tools never email the
 *      submitted address (a bot-entered victim address must not get mail).
 * Bots are answered with a FAKE 201 ok (drop silently — never teach the bot
 * what tripped); every drop is console-logged with the reason + IP for ops.
 */
const LOW_SIGNAL_TOOLS = new Set(['subscribe', 'dscr_waitlist']);
const TOKEN_MIN_MS = Number(process.env.LEADS_TOKEN_MIN_MS || 3000);
const TOKEN_MAX_MS = Number(process.env.LEADS_TOKEN_MAX_MS || 2 * 60 * 60 * 1000);
const MX_CHECK = process.env.LEADS_MX_CHECK !== '0';
const cryptoLib = require('crypto');
const cfg = require('../config');
function signFormToken(ts) {
  return ts + '.' + cryptoLib.createHmac('sha256', String(cfg.jwtSecret || 'dev')).update('leadform|' + ts).digest('hex').slice(0, 32);
}
function formTokenAgeMs(token) {
  const m = /^(\d{10,16})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!m) return null;
  if (signFormToken(m[1]) !== m[0]) return null;
  const age = Date.now() - Number(m[1]);
  return age >= 0 ? age : null;
}
const MX_CACHE = new Map(); // domain -> { ok, at }
async function domainAcceptsMail(email) {
  if (!MX_CHECK) return true;
  const domain = String(email).split('@')[1].toLowerCase();
  const hit = MX_CACHE.get(domain);
  if (hit && Date.now() - hit.at < 24 * 60 * 60 * 1000) return hit.ok;
  let ok = true; // fail-open: DNS trouble must never block a real visitor
  try {
    const dns = require('dns').promises;
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (Array.isArray(mx)) ok = mx.length > 0;
  } catch (e) {
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) ok = false;
  }
  if (MX_CACHE.size > 5000) MX_CACHE.clear();
  MX_CACHE.set(domain, { ok, at: Date.now() });
  return ok;
}
// The page fetches this when the visitor first touches a form; echoed on POST.
router.get('/token', (req, res) => {
  res.json({ t: signFormToken(String(Date.now())) });
});

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

  // #153 bot-drop: answer a fake 201 (never teach the bot what tripped), store
  // nothing, email no one. Console-logged (address masked) so ops see the pressure.
  const drop = (reason) => {
    const masked = email ? String(email).replace(/^(.).*?(@.*)$/, '$1***$2') : '';
    console.warn(`[leads] dropped ${tool} from ${req.ip} (${reason})${masked ? ' email=' + masked : ''}`);
    return res.status(201).json({ ok: true, leadId: null, routedTo: 'the YS Capital Group loan desk' });
  };
  // Honeypot: hidden "website" field — humans never see it, form-fillers fill it.
  if (b.website) return drop('honeypot');
  if (LOW_SIGNAL_TOOLS.has(tool)) {
    // Proof-of-page-visit + human dwell time for the pure-email tools.
    const age = formTokenAgeMs(b.formToken);
    if (age == null) return drop('missing/invalid form token');
    if (age < TOKEN_MIN_MS || age > TOKEN_MAX_MS) return drop(`token age ${age}ms out of range`);
    if (email && !(await domainAcceptsMail(email))) return drop('domain has no MX');
  }

  try {
    // Dedup — LOW-SIGNAL tools ONLY (audit-caught 2026-07-17): a repeat
    // subscribe/waitlist for the same address inside 30 days is the SAME lead —
    // no new row, no more emails. Content-carrying tools (contact, loan
    // application, term sheet…) are NEVER deduped: a visitor's second message
    // or corrected submission must always land and notify. Archived rows don't
    // match — a genuine re-subscribe after a spam sweep gets a fresh lead.
    if (email && LOW_SIGNAL_TOOLS.has(tool)) {
      const dup = await db.query(
        `SELECT id FROM leads WHERE tool=$1 AND lower(email)=lower($2)
           AND status <> 'archived'
           AND created_at > now() - interval '30 days' LIMIT 1`, [tool, email]);
      if (dup.rows[0]) return res.status(201).json({ ok: true, leadId: dup.rows[0].id, routedTo: 'the YS Capital Group loan desk' });
    }
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

    // Confirmation to the visitor (best-effort). NEVER for the subscribe-class
    // tools (#153): a bot can enter any victim's address, and the confirmation
    // becomes backscatter that burns the sending domain's reputation. A real
    // newsletter signup needs no "we received your inquiry" letter.
    if (email && !LOW_SIGNAL_TOOLS.has(tool)) {
      try {
        // The body promises "just reply to this email" — when the lead routed to
        // an officer, replies go to that officer instead of the no-reply sender.
        // No application exists yet, so the file+ inbox doesn't apply here.
        const r = await mail.send('leadReceived', email, {
          firstName: name ? String(name).split(' ')[0] : '',
          toolLabel: label,
          officerName: officerRow ? officerRow.full_name : null,
          // #150: the confirmation arrives FROM the routed officer by name.
        }, { replyTo: officerRow?.email || null, from: officerRow ? require('../lib/email').fromWithName(officerRow.full_name) : null });
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
