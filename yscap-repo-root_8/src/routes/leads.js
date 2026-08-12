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
const F = require('../lib/fields');           // jsonbText: NUL-safe jsonb binds
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { redactPII } = require('../lib/redact');

const TOOL_LABEL = {
  loan_application: 'Loan application',
  rehab_budget: 'Rehab budget / Scope of Work',
  term_sheet: 'Term sheet request',
  term_sheet_generated: 'Term sheet generated',
  term_sheet_exception: 'Term sheet — exception request',
  track_record: 'Track record',
  deal_analyzer: 'Deal analyzer',
  qualifier: 'Qualifier',
  quote_request: 'Quote request',
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
// Tools allowed to land WITHOUT any visitor contact info (owner-directed
// 2026-07-24): a term-sheet generation notifies our team with the exact terms
// even when the visitor left no email/phone (we ASK for contact right after,
// but it is never a requirement). Contact-less submissions must carry a valid
// form token (proof-of-page-visit + dwell) — a blind bot never has one.
const CONTACTLESS_TOOLS = new Set(['term_sheet_generated']);
// Term-sheet events carry their own descriptive subject line (used as the
// notification title so the inbox shows EXACTLY what was generated). Routing
// is the same for every tool — see the owner-directed rule below.
const SALES_TOOLS = new Set(['term_sheet', 'term_sheet_generated', 'term_sheet_exception']);
const MX_CHECK = process.env.LEADS_MX_CHECK !== '0';
const cryptoLib = require('crypto');
const cfg = require('../config');
// Shared HMAC form token (extracted to lib/form-token so /api/apply verifies
// the exact same tokens this page-token endpoint hands out).
const { signFormToken, formTokenAgeMs, TOKEN_MIN_MS, TOKEN_MAX_MS } = require('../lib/form-token');
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

// Contact-less tools (term-sheet generations) can double-fire on a re-render —
// absorb repeats of the SAME submission from the SAME IP for a few minutes.
// In-memory like the rate limiter (single-instance service).
const ANON_SEEN = new Map(); // key -> ts
const ANON_DEDUP_MS = 10 * 60 * 1000;
/* The fields that make one contact-less submission DIFFERENT from another. It used to
   hash `payload` alone, which was right when `payload` carried everything — but the
   deal facts now ride at the TOP LEVEL too (the entity, the property, the figures —
   see lib/lead-deal-facts.js), so a visitor who priced a SECOND, genuinely different
   property inside ten minutes had it silently absorbed as a duplicate and got no lead
   at all. That is the same "they were not added as a lead" complaint one layer down,
   so the identity of a submission has to include the deal it is about.
   Still deliberately narrow: a re-render of the SAME deal is still one lead. */
const ANON_IDENTITY_KEYS = ['payload', 'company', 'borrowerName', 'propertyAddress',
  'propertyType', 'program', 'loanAmount', 'subject'];
function anonDuplicate(ip, tool, body) {
  const b = (body && typeof body === 'object') ? body : {};
  const ident = {};
  for (const k of ANON_IDENTITY_KEYS) if (b[k] !== undefined) ident[k] = b[k];
  const key = ip + '|' + tool + '|' + cryptoLib.createHash('sha256').update(JSON.stringify(ident)).digest('hex').slice(0, 24);
  const now = Date.now();
  if (ANON_SEEN.size > 5000) for (const [k, t] of ANON_SEEN) if (now - t > ANON_DEDUP_MS) ANON_SEEN.delete(k);
  const seen = ANON_SEEN.get(key);
  ANON_SEEN.set(key, now);
  return !!(seen && now - seen < ANON_DEDUP_MS);
}

router.post('/', async (req, res) => {
  const b = req.body || {};
  const tool = String(b.tool || 'contact').slice(0, 60);
  const name = b.name ? String(b.name).slice(0, 200) : null;
  const email = b.email ? String(b.email).trim().slice(0, 200) : null;
  const phone = b.phone ? String(b.phone).slice(0, 40) : null;
  if (!email && !phone && !CONTACTLESS_TOOLS.has(tool)) return res.status(400).json({ error: 'email or phone required' });
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
  if (CONTACTLESS_TOOLS.has(tool)) {
    // No contact info to vouch for the sender — the form token is mandatory
    // (a curl replay never fetched one), and repeats of the same generation
    // from the same IP are absorbed instead of re-emailing the sales desk.
    const age = formTokenAgeMs(b.formToken);
    if (age == null) return drop('missing/invalid form token');
    if (age < TOKEN_MIN_MS || age > TOKEN_MAX_MS) return drop(`token age ${age}ms out of range`);
    if (!b.payload) return drop('contact-less submission with no payload');
    if (anonDuplicate(req.ip, tool, b)) {
      return res.status(201).json({ ok: true, leadId: null, duplicate: true, routedTo: 'the YS Capital Group loan desk' });
    }
  }

  // Per-prospect assignment lock (released right after the row is written, or in
  // the catch). Declared out here so the catch can always let it go.
  let assignLock = null;
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
    /* ── WHO OWNS THIS SUBMISSION ─────────────────────────────────────────────────────────
       Owner-directed 2026-08-07, two complaints about the same endpoint:

       (1) *"A random person goes on our website. He puts in a thing, and he exports a term sheet.
           It gets to the queue, and it goes to a loan officer. There's no information. There's not
           even a name. There's no reason why something like this should go to a loan officer. It's
           just making them crazy as a lead. Only if it has any information should it go to a loan
           officer. If not, it should not go into the queue. It's not considered a lead. It should
           just go to the sales inbox."*

       (2) *"the same term sheet without an address … was on the same browser session and went to a
           DIFFERENT loan officer … It should go to one loan officer if it's on one browser
           session."*

       So: a submission that names NOBODY is not a lead and is never assigned; and within one
       browser session the officer, once picked, does not change. */

    // Does this submission tell us who the visitor is? Name, email or phone — any one of them is
    // enough to call somebody back, which is the entire test. `term_sheet_generated` is the tool
    // that can arrive with none of them (CONTACTLESS_TOOLS), and that is precisely the case the
    // owner is describing.
    const hasContact = !!(name || email || phone);

    // Resolve the branded ?lo= officer code to a real, selectable staff row. This is a DELIBERATE
    // choice by the visitor (they arrived on that officer's own link), so it applies even with no
    // contact details — an anonymous visitor on Yehuda's link is still Yehuda's visitor.
    let officerId = null, officerRow = null;
    const code = b.officerCode ? String(b.officerCode).toLowerCase().replace(/[^a-z0-9._-]/g, '') : '';
    if (code) {
      const o = await db.query(
        // is_external=false: a public ?lo= marketing code must never resolve to
        // an external (TPO / broker) user (TPO PORTAL invariant, CLAUDE.md).
        `SELECT id, full_name, email FROM staff_users
          WHERE lower(split_part(email,'@',1))=$1 AND is_active=true AND is_external=false
          ORDER BY created_at ASC, id ASC LIMIT 1`, [code]);
      if (o.rows[0]) { officerRow = o.rows[0]; officerId = o.rows[0].id; }
    }
    /* WORK DONE FROM A STAFF LOGIN STAYS WITH THAT PERSON — it is never handed to the
       queue (owner-directed 2026-08-07: "if somebody is doing something from his
       login, it should always stay with his information, his name. It should come in
       as a lead in his system").

       A staff member generated a term sheet in their own portal, emailed it to a
       lead, and the lead arrived under a DIFFERENT officer's name. The tools are the
       same static pages the marketing site serves and they read their officer from
       `window.YSBRAND` (`?lo=`), which the portal never set — so the lead posted with
       no officer and the round-robin below correctly did its job on what LOOKED like
       an unowned marketing lead.

       The portal now declares its origin (`fromStaffPortal`, alongside the signed-in
       staffer's own officerCode — see StaffInvestorSuite / TermSheetStudio). Two
       rules follow, and the second is the load-bearing one:
         1. `assigned_via` records it as `staff_portal`, so "why does this lead belong
            to this person?" is answerable from the row itself (db/484).
         2. A staff-portal lead is NEVER round-robined. If its officer cannot be
            resolved at all it falls through to the SALES DESK, which a human works —
            never to an officer who had nothing to do with it. An unassigned lead is
            recoverable; a lead silently filed in the wrong person's book is the bug
            being fixed, and it is the more expensive of the two.
       The declaration is not a privilege: it can only ever make the lead LESS likely
       to be auto-assigned, so a spoofed value costs nothing. */
    const leadAssign = require('../lib/lead-assignment');
    const fromStaffPortal = b.fromStaffPortal === true || b.fromStaffPortal === 'true';

    // An opaque per-visit id the page holds in sessionStorage. It carries nothing about the
    // person — it only says "these submissions came from one visit". Capped and character-limited
    // because it is public input headed for a text column.
    const sessionId = b.sessionId ? String(b.sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null : null;

    /* STICK TO THE OFFICER THIS SESSION ALREADY HAS (owner-directed 2026-08-07). Checked BEFORE
       the rotation, so a visitor who exports three term sheets in one sitting produces three
       submissions for ONE officer instead of walking the roster. Best-effort: an unreadable
       lookup simply falls through, which is the behaviour that existed before.

       DELIBERATELY NOT APPLIED TO A STAFF-PORTAL SUBMISSION. Stickiness answers "which officer
       is this VISITOR already talking to"; a staff-portal lead whose own officer code did not
       resolve must reach the sales desk, never an officer who had nothing to do with it (the
       rule directly above). Letting a session id assign one would re-open exactly that bug
       through a second door. */
    /* WHO GETS THIS LEAD — the over-assignment fix (owner-reported 2026-08-11:
       "everyone who clicks Generate Term Sheet gets a lead again and goes to
       someone; a few loan officers get the same thing if he exports a few times").
       Two changes, both here:
         (a) REUSE the officer this prospect already has, broadened from the old
             session-only match to email / phone / session / IP+name — so a repeat
             export in another format, another tab, or the next day sticks to the
             SAME officer instead of round-robining onto a second one.
         (b) hold a per-prospect ADVISORY LOCK across the lookup → pick → INSERT, so
             a near-simultaneous burst (the PDF + Excel + proof-of-funds each POST)
             can never each round-robin onto a DIFFERENT officer (the first-in-
             session race). Best-effort; released right after the row is written. */
    const decision = leadAssign.decideLeadOfficer({ officerId, tool, fromStaffPortal });
    let assignedVia = decision.assignedVia;
    let viaSession = false;   // reused an EXISTING assignment (suppresses re-notify below)
    const ident = { email, phone, sessionId, ip: req.ip, name };
    // Only a lead that would otherwise round-robin needs this — a branded ?lo=
    // link, a staff-portal lead, a newsletter and a nameless export never do.
    const routable = !officerId && decision.mayRoundRobin && hasContact;
    if (routable) {
      assignLock = await leadAssign.acquireAssignmentLock(leadAssign.assignmentKey(ident));
      const prior = await leadAssign.findRecentAssignment(db, ident);
      if (prior) {
        officerId = prior.officer_id;
        officerRow = { id: prior.officer_id, full_name: prior.full_name, email: prior.email };
        assignedVia = 'session'; viaSession = true;
      } else {
        // #29 round-robin: fair rotation onto the next loan officer. An empty pool
        // falls through to the sales-desk / admin routing below — a lead is never lost.
        const rr = await leadAssign.pickRoundRobinOfficer();
        if (rr) { officerRow = rr; officerId = rr.id; assignedVia = 'round_robin'; }
      }
    }
    if (!officerId && fromStaffPortal) {
      // Stated to be somebody's own work, but we could not resolve who. Say so —
      // this is a wiring fault worth seeing, not a lead to hand out.
      console.warn(`[leads] ${tool} declared a staff-portal origin but its officer code ` +
        `${code ? `"${code}" did not resolve` : 'was missing'} — routing to the sales desk, NOT the rotation`);
    }
    // A submission that names NOBODY is not a lead (owner-directed 2026-08-07).
    const anonymous = !hasContact && !officerId;
    if (anonymous) assignedVia = 'anonymous';

    const label = TOOL_LABEL[tool] || tool;
    // Record WHICH page sent the submission (the browser's Referer header) in
    // the stored payload — free marketing/source attribution for every tool,
    // with no front-end change. Never overwrites anything the tool sent.
    const payloadObj = b.payload ? redactPII(b.payload) : {};
    const fromUrl = String(req.get('referer') || '').slice(0, 300);
    if (fromUrl && payloadObj && typeof payloadObj === 'object' && !Array.isArray(payloadObj) && !payloadObj._submittedFrom) payloadObj._submittedFrom = fromUrl;
    const payloadJson = (b.payload || fromUrl) ? F.jsonbText(payloadObj) : null;
    /* THE DEAL THE VISITOR TYPED, ON THE LEAD ROW ITSELF (owner-reported 2026-08-07).
       A term sheet generated from an officer's own ?lo= link with the LLC, the property
       and the figures filled in — but no email and no phone — DID create a row (that
       has been allowed since 2026-07-24). What it could not do is SHOW anything: this
       INSERT wrote none of the CRM columns the lead screens read, so everything the
       visitor entered sat in the `payload` jsonb that no screen renders, and the lead
       appeared in the officer's book as a nameless row with nothing on it — which from
       his side is indistinguishable from no lead at all.
       `lead-deal-facts` promotes them, bounded to their columns so a pasted essay or a
       30-digit number can never turn a public capture into a 500. A submission that
       sends none of it writes all-NULL and behaves exactly as before. */
    const leadFacts = require('../lib/lead-deal-facts');
    const facts = leadFacts.dealFactsFrom(b);
    // A LEAD WITH NO CONTACT DETAILS STILL NEEDS A NAME, or the officer cannot tell one
    // anonymous term sheet from the next. The entity/borrower they typed IS the identity
    // they gave us; failing that, the property. Never invents one.
    const leadName = name || leadFacts.displayNameFrom(b, facts);
    // THE ROW IS STILL WRITTEN — an anonymous export is real marketing signal and the team may
    // well want to look at what the site is producing. What changes is that it does NOT sit in
    // anybody's working queue: 'archived' is exactly the state the queue's own filter excludes
    // (`status NOT IN ('converted','archived')`), so it is out of the badge and the default list
    // while staying findable, and `assigned_via='anonymous'` records WHY it is there. If the
    // visitor comes back and leaves their details, that is a NEW submission with contact info and
    // it is routed normally.
    const leadStatus = anonymous ? 'archived' : 'new';
    // BOTH sides' columns, and the two changes reinforce each other: an ANONYMOUS export is
    // archived out of the working queue (mine) AND now carries the entity/property the visitor
    // typed (main's `leadName` + deal facts), so the row a human goes looking for is actually
    // readable instead of a nameless blank. Bind positions are counted in the test — the shifted
    // bind that once put an interest reserve into `payoff_lender` came from editing a list like
    // this one, so add a column and its value in the SAME position or not at all.
    const ins = await db.query(
      `INSERT INTO leads (tool,name,email,phone,officer_code,officer_id,subject,message,payload,ip_address,user_agent,assigned_via,
                          session_id,status,company,property_address,property_type,program,loan_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [tool, leadName, email, phone, code || null, officerId,
       b.subject ? String(b.subject).slice(0, 240) : `${label} — ${leadName || email || 'new lead'}`,
       b.message ? String(b.message).slice(0, 4000) : null,
       payloadJson,
       req.ip, (req.get('user-agent') || '').slice(0, 400), assignedVia,
       sessionId, leadStatus,
       facts.company, facts.propertyAddress ? F.jsonbText(facts.propertyAddress) : null,
       facts.propertyType, facts.program, facts.loanAmount]);
    const leadId = ins.rows[0].id;
    // The assignment decision + the row are written — release the per-prospect
    // lock now so the slow tail (filing the PDF, sending email) never serializes
    // another visitor's submission.
    if (assignLock) { await leadAssign.releaseAssignmentLock(assignLock); assignLock = null; }

    // Build a compact summary for the internal notification.
    const meta = [];
    if (name) meta.push({ label: 'Name', value: name });
    if (email) meta.push({ label: 'Email', value: email });
    if (phone) meta.push({ label: 'Phone', value: phone });
    meta.push({ label: 'Tool', value: label });
    // The tools may pass display rows (e.g. the exact term-sheet terms: program,
    // loan amount, rate, LTC/ARV…) so the sales/officer email shows the deal at
    // a glance. Sanitized + capped — this is public input headed into an email —
    // and value-scrubbed for SSN/card patterns (audit 2026-07-24: redactPII is
    // key-based, so a number typed into free text would otherwise ride along).
    if (b.payload && Array.isArray(b.payload.metaRows)) {
      const pii = require('../lib/pii-guard');
      for (const r of b.payload.metaRows.slice(0, 14)) {
        if (r && r.label && r.value != null && String(r.value).trim() !== '') {
          meta.push({ label: pii.scan(String(r.label).slice(0, 48)).redacted,
                      value: pii.scan(String(r.value).slice(0, 160)).redacted });
        }
      }
    }
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

    /* THE TERM SHEET IS FILED ON THE LEAD, not only mailed to the officer
       (owner-directed 2026-08-07: "He can also attach to the lead the term sheet that
       he generated, and then loan officers can do his research to try to figure out who
       that person is and try to call him"). Before this, the generated PDF existed only
       as an attachment on one notification email — so it was in whichever inbox that
       landed in and nowhere in PILOT; anyone else opening the lead saw no term sheet at
       all, and a deleted email lost it for good.
       Written through the SAME `documents.lead_id` shape the staff "Files" panel
       already lists and downloads, so it needs no new surface, and recorded on the
       lead's activity feed so the timeline says where it came from.
       BEST-EFFORT AND LAST: a storage hiccup must never cost us the lead itself, which
       is already committed above — losing the attachment is recoverable, losing the
       visitor is not.
       `source_type='system'` is what records that no human uploaded this, and
       `uploaded_by_kind` is deliberately left NULL: its CHECK allows only
       'borrower'/'staff' (db/schema.sql), so writing 'system' there would violate the
       constraint and the whole filing would fail — a real trap, since the surrounding
       catch would have swallowed it and the attachment would silently never appear.
       `visibility='staff_only'`: a lead has no borrower to show it to. */
    if (atts.length) {
      try {
        const storage = require('../lib/storage');
        const { normalizeBase64String } = require('../lib/upload-bytes');
        for (const a of atts) {
          try {
            const buf = Buffer.from(normalizeBase64String(a.content), 'base64');
            if (!buf.length) continue;
            const { ref, provider } = await storage.save(buf, { filename: a.filename });
            const d = await db.query(
              `INSERT INTO documents (lead_id, filename, content_type, size_bytes, storage_provider, storage_ref,
                                      source_type, visibility)
               VALUES ($1,$2,$3,$4,$5,$6,'system','staff_only') RETURNING id`,
              [leadId, a.filename, a.contentType, buf.length, provider, ref]);
            await db.query(
              `INSERT INTO lead_activities (lead_id, activity_type, subject, body, meta)
               VALUES ($1,'file','Generated on the site',$2,$3)`,
              [leadId, a.filename, JSON.stringify({ documentId: d.rows[0].id, tool })]);
          } catch (e) {
            console.warn(`[leads] could not file "${a.filename}" onto lead ${leadId}: ${e && e.message}`);
          }
        }
      } catch (e) { console.warn('[leads] lead-document filing unavailable:', e && e.message); }
    }

    const notifyOpts = {
      type: 'new_lead',
      // Term-sheet events carry their own descriptive subject ("Term sheet
      // generated — $455,000 Fix & Flip — 12 Main St") so sales sees EXACTLY
      // what was generated right in the inbox; everything else keeps the
      // uniform "New <tool> from <who>" title.
      title: (SALES_TOOLS.has(tool) && b.subject) ? String(b.subject).slice(0, 160)
           : `New ${label.toLowerCase()} from ${name || email || 'a visitor'}`,
      body: (b.message ? String(b.message).slice(0, 4000) : null) || `A visitor submitted the ${label.toLowerCase()} on the site.`,
      meta, link: '/internal/leads', ctaLabel: 'Open leads',
      attachments: atts, files: atts.map(a => a.filename),
    };

    // Notify — the owner's routing rule (owner-directed 2026-07-24, refined):
    //   • An officer was picked (branded ?lo= link or an explicit selection) →
    //     it goes to THAT officer's email, and ONLY that officer. Every tool.
    //   • No officer → the SALES desk inbox. Every content tool (a track
    //     record / rehab budget / term sheet / quote / contact with nobody
    //     picked lands at sales, not the whole admin desk).
    //   • A SUBSCRIPTION stays a single quiet email to pilot@ (owner-directed
    //     2026-07-15). Admins keep their in-app Leads-desk rows for unrouted
    //     leads without the email fan-out; if no sales inbox is configured
    //     (SALES_NOTIFY_TO="") the legacy admin-desk fan-out still applies so
    //     an unrouted lead is never silent.
    try {
      const mailer = require('../lib/email');
      const salesTo = cfg.salesNotifyTo;
      // Owner-directed 2026-07-24 (round 2): the DSCR waitlist follows the same
      // "nothing picked → sales desk" rule as every content tool (it's a real
      // lead with contact info). Only the newsletter subscription keeps its own
      // quiet pilot@ inbox. All the waitlist's bot defenses stay untouched.
      const wantsSales = !!salesTo && !officerId && tool !== 'subscribe';
      // Do NOT re-notify on a REUSED assignment (viaSession): the officer already
      // heard about this prospect on the first export, so a burst of exports must
      // not bombard them with a copy each — the crux of the owner's report.
      if (officerId && !viaSession) { await notify.notifyStaff(officerId, { ...notifyOpts, emailTo: officerRow.email }); }
      if (wantsSales) {
        // An anonymous export says so on its face, so nobody on the sales desk spends a minute
        // hunting for a name that was never given (owner-directed 2026-08-07). It is a signal that
        // the site produced a term sheet, not a person to call — and it is deliberately NOT in
        // anybody's lead queue.
        if (anonymous) {
          notifyOpts.badge = { text: 'No contact details', tone: 'neutral' };
          notifyOpts.emailBody = 'A visitor generated this on the site and left no name, email or phone, '
            + 'so there is nobody to follow up with and it has not been routed to a loan officer or '
            + 'added to the leads queue. The figures they were shown are below.';
          notifyOpts.ctaLabel = 'Open leads';
          notifyOpts.note = 'You are seeing this because nobody was named on the submission. '
            + 'If they come back and leave their details it will arrive as a normal lead.';
        }
        const built = notify.buildEmail(notifyOpts, 'staff');
        // Reply-To the visitor when we have their address — sales can just hit
        // reply. Attachments ride along (the generated PDF/Excel the tools send).
        await mailer.sendMail({
          to: [salesTo], subject: built.subject, text: built.text, html: built.html,
          attachments: atts.length ? atts : undefined,
          replyTo: email || null,
          _ctx: { type: 'new_lead', audience: 'staff' },
        }).catch(() => {});
        // Admins keep their in-app Leads-desk rows (badge/count), no email blast — but NOT for an
        // anonymous export, which is the "making them crazy" notification the owner asked to stop.
        // The row is on the archived leads list either way; nobody needs an in-app nudge about a
        // visitor who left no way to reach them.
        if (!anonymous) await notify.notifyAdmins({ ...notifyOpts, inAppOnly: true });
      } else if (!officerId) {
        if (tool === 'subscribe') {
          const built = notify.buildEmail(notifyOpts, 'staff');
          await mailer.sendMail({ to: [SUBSCRIBE_NOTIFY_TO], subject: built.subject, text: built.text, html: built.html }).catch(() => {});
        } else {
          // No sales inbox configured (or low-signal tool): legacy admin-desk fan-out.
          await notify.notifyAdmins(notifyOpts);
        }
      }
      await db.query(`UPDATE leads SET emailed_officer=true WHERE id=$1`, [leadId]);
    } catch (_) { /* never fail the submission on a notify hiccup */ }

    // Confirmation to the visitor (best-effort). NEVER for the subscribe-class
    // tools (#153): a bot can enter any victim's address, and the confirmation
    // becomes backscatter that burns the sending domain's reputation. A real
    // newsletter signup needs no "we received your inquiry" letter.
    if (email && !LOW_SIGNAL_TOOLS.has(tool) && !viaSession) {
      try {
        // The body promises "just reply to this email" — when the lead routed to
        // an officer, replies go to that officer instead of the no-reply sender.
        // No application exists yet, so the file+ inbox doesn't apply here.
        // ATTACH THE TERM SHEET to the visitor's confirmation (owner-directed 2026-08-12): a loan
        // officer (or a prospect) who clicks "Email me this term sheet" on the generator asked to be
        // sent the actual sheet — before this they got a plain "we received it" note and no PDF. The
        // client already sends the generated PDF in `attachments`; forward the PDF one(s) to the
        // visitor for the term-sheet tools only. It is the INITIAL term sheet.
        const termSheetAtts = SALES_TOOLS.has(tool)
          ? atts.filter((a) => /pdf/i.test(a.contentType || '') || /\.pdf$/i.test(a.filename || ''))
          : [];
        const r = await mail.send('leadReceived', email, {
          firstName: name ? String(name).split(' ')[0] : '',
          toolLabel: label,
          officerName: officerRow ? officerRow.full_name : null,
          hasTermSheet: termSheetAtts.length > 0,
          // #150: the confirmation arrives FROM the routed officer by name.
        }, { replyTo: officerRow?.email || null, from: officerRow ? require('../lib/email').fromWithName(officerRow.full_name) : null,
             attachments: termSheetAtts.length ? termSheetAtts : undefined });
        if (r && r.ok) await db.query(`UPDATE leads SET emailed_submitter=true WHERE id=$1`, [leadId]);
      } catch (_) {}
    }

    res.status(201).json({ ok: true, leadId,
      routedTo: officerRow ? officerRow.full_name : 'the YS Capital Group loan desk',
      // Contact-less submissions get a signed handle so the page can attach the
      // visitor's email/phone AFTERWARDS (the optional "want us to follow up?"
      // ask) — nothing but contact info can be written with it.
      contactToken: CONTACTLESS_TOOLS.has(tool) ? signContactToken(leadId) : undefined });
  } catch (e) {
    if (assignLock) { await require('../lib/lead-assignment').releaseAssignmentLock(assignLock).catch(() => {}); assignLock = null; }
    console.error('[leads] submit failed:', db.describeError(e));
    res.status(500).json({ error: 'could not submit — please try again' });
  }
});

/* ------------------------------------------------------------------ contact
 * attach — the optional follow-up after a contact-less term-sheet generation.
 * The signed token (issued in the 201 above) is the capability: it can only
 * fill the CONTACT fields of that one lead row, and only within 2 hours. */
function signContactToken(leadId, ts) {
  const t = ts || Date.now();
  const sig = cryptoLib.createHmac('sha256', String(cfg.jwtSecret || 'dev'))
    .update(`leadcontact|${leadId}|${t}`).digest('hex').slice(0, 40);
  return `${t}.${sig}`;
}
router.post('/contact', async (req, res) => {
  const b = req.body || {};
  const leadId = String(b.leadId || '');
  const m = /^(\d{10,16})\.([0-9a-f]{40})$/.exec(String(b.contactToken || ''));
  if (!/^[0-9a-f-]{36}$/i.test(leadId) || !m) return res.status(400).json({ error: 'invalid request' });
  const age = Date.now() - Number(m[1]);
  const h = (s) => cryptoLib.createHash('sha256').update(String(s), 'utf8').digest();
  if (!(age >= 0 && age <= TOKEN_MAX_MS) ||
      !cryptoLib.timingSafeEqual(h(signContactToken(leadId, Number(m[1]))), h(String(b.contactToken)))) {
    return res.status(400).json({ error: 'invalid request' });
  }
  // Same per-IP hourly cap as submissions — this endpoint sends email too
  // (audit 2026-07-24: a valid token must not become a 2-hour replay bomb).
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'too many submissions — please try again later' });
  const email = b.email ? String(b.email).trim().slice(0, 200) : null;
  const phone = b.phone ? String(b.phone).slice(0, 40) : null;
  const name = b.name ? String(b.name).slice(0, 200) : null;
  if (!email && !phone) return res.status(400).json({ error: 'email or phone required' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
  try {
    const cur = (await db.query(
      `SELECT id, tool, subject, officer_id, name, email, phone, status, assigned_via, session_id
         FROM leads WHERE id=$1`, [leadId])).rows[0];
    if (!cur) return res.status(404).json({ error: 'not found' });
    // Fill BLANKS only, and notify with the values ACTUALLY stored. A replay
    // (or a call that changes nothing) stores nothing and re-notifies no one.
    const finalName = cur.name || name, finalEmail = cur.email || email, finalPhone = cur.phone || phone;
    const changed = finalName !== cur.name || finalEmail !== cur.email || finalPhone !== cur.phone;
    if (!changed) return res.json({ ok: true, unchanged: true });

    /* THIS IS THE MOMENT AN ANONYMOUS EXPORT BECOMES A REAL LEAD (owner-directed 2026-08-07:
       *"Only if it has any information should it go to a loan officer"*).

       The submission arrived with nobody named, so it was parked out of the queue and never
       routed. The visitor has now told us who they are, which is exactly the condition the
       owner set — so it re-enters the queue and gets an owner, the same way it would have if
       they had left their details in the first place. Session stickiness applies here too: if
       this visit already has an officer, they keep it rather than the rotation choosing again.

       An already-routed or already-working lead is untouched — this only ever promotes a lead
       that was parked BECAUSE nobody was named. */
    let officerId = cur.officer_id;
    let promoted = false;
    if (!officerId && cur.assigned_via === 'anonymous') {
      try {
        if (cur.session_id) {
          const prior = (await db.query(
            `SELECT l.officer_id FROM leads l
               JOIN staff_users s ON s.id = l.officer_id AND s.is_active = true
              WHERE l.session_id = $1 AND l.officer_id IS NOT NULL
              ORDER BY l.created_at DESC LIMIT 1`, [cur.session_id])).rows[0];
          if (prior) officerId = prior.officer_id;
        }
        if (!officerId) {
          const rr = await require('../lib/lead-assignment').pickRoundRobinOfficer();
          if (rr) officerId = rr.id;
        }
      } catch (_) { /* an unroutable lead still gets un-parked below and reaches sales */ }
      promoted = true;
    }
    await db.query(
      `UPDATE leads SET name=$2, email=$3, phone=$4,
              officer_id = COALESCE($5, officer_id),
              assigned_via = CASE WHEN $6 THEN (CASE WHEN $5 IS NULL THEN NULL ELSE 'round_robin' END) ELSE assigned_via END,
              status = CASE WHEN $6 AND status = 'archived' THEN 'new' ELSE status END
        WHERE id=$1`,
      [leadId, finalName, finalEmail, finalPhone, officerId || null, promoted]);
    const lead = { ...cur, officer_id: officerId };
    // Tell the same people who saw the generation that the visitor is reachable now.
    try {
      const label = TOOL_LABEL[lead.tool] || lead.tool;
      const notifyOpts = {
        type: 'new_lead',
        title: `Visitor left contact info — ${label.toLowerCase()}`,
        body: `The visitor behind "${lead.subject || label}" left their contact details.`,
        meta: [
          ...(finalName ? [{ label: 'Name', value: finalName }] : []),
          ...(finalEmail ? [{ label: 'Email', value: finalEmail }] : []),
          ...(finalPhone ? [{ label: 'Phone', value: finalPhone }] : []),
        ],
        link: '/internal/leads', ctaLabel: 'Open leads',
      };
      // Same routing rule as the submission itself: the routed officer owns it;
      // sales only hears about unrouted visitors.
      if (lead.officer_id) {
        const o = await db.query(`SELECT email FROM staff_users WHERE id=$1`, [lead.officer_id]);
        await notify.notifyStaff(lead.officer_id, { ...notifyOpts, emailTo: o.rows[0]?.email });
      } else if (cfg.salesNotifyTo) {
        const built = notify.buildEmail(notifyOpts, 'staff');
        await require('../lib/email').sendMail({
          to: [cfg.salesNotifyTo], subject: built.subject, text: built.text, html: built.html,
          replyTo: finalEmail || null, _ctx: { type: 'new_lead', audience: 'staff' } }).catch(() => {});
      } else {
        // No sales inbox configured: legacy admin fan-out, so a visitor who
        // left contact info is never silently unnoticed (audit finding).
        await notify.notifyAdmins(notifyOpts);
      }
    } catch (_) { /* best-effort */ }
    res.json({ ok: true });
  } catch (e) {
    console.error('[leads] contact attach failed:', db.describeError(e));
    res.status(500).json({ error: 'could not save — please try again' });
  }
});

module.exports = router;
