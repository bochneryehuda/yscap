/**
 * Notification service. Writes an in-app notification row (always) and, best
 * effort, fans it out by BRANDED email via the configured provider — recording
 * the email status on the row so nothing is lost if the provider is down/absent.
 *
 * The in-app row stores the plain title/body (unchanged). The email is rendered
 * through src/lib/email/template.js into the light PILOT-branded HTML + a
 * plaintext fallback, with an absolute CTA link back into the portal.
 */
const db = require('../db');
const email = require('./email');
const tpl = require('./email/template');
const { link: portalLink } = require('./email/catalog');
const cfg = require('../config');
const { scrubText, scrubTextExcept } = require('./borrower-safe');
const { fileReplyTo } = require('./file-address');   // #68 per-file shared reply-to

/* Turn a notification's opts into a branded {subject,html,text}. */
function buildEmail(opts, audience) {
  // Deep links must resolve into the portal SPA (/portal/#/…), not the site root.
  const link = opts.link ? portalLink(opts.link) : portalLink('/');
  return tpl.render({
    title:     opts.title,
    preheader: opts.body || opts.title,
    greeting:  opts.greeting || (audience === 'borrower' ? 'Hello,' : ''),
    intro:     opts.body || '',
    lines:     opts.lines || [],
    meta:      opts.meta || [],
    // The email lists the file(s) even when the bytes are too big to attach; the
    // explicit `files` list wins, else derive from whatever bytes were attached.
    files:     (Array.isArray(opts.files) && opts.files.length ? opts.files : (opts.attachments || []).map((a) => a && a.filename)).filter(Boolean),
    cta:       { label: opts.ctaLabel || (audience === 'borrower' ? 'Open your portal' : 'Open the loan file'), url: link },
    note:      opts.note || (audience === 'borrower'
                 ? 'You are receiving this because you have an active file with YS Capital Group.'
                 : ''),
    audience,
  });
}

async function _emailRow(id, to, opts, audience) {
  if (!to || !to.length) { await _mark(id, 'skipped'); return; }
  try {
    const msg = buildEmail(opts, audience);
    // Attachments (owner-directed): doc-upload + chat emails carry the actual
    // file(s). Each is { filename, contentType, content (base64) }. Bounded +
    // sanitized at the call site; providers that don't support attachments ignore them.
    const attachments = Array.isArray(opts.attachments) ? opts.attachments.filter((a) => a && a.filename && a.content) : [];
    // #68: file-scoped emails carry a per-file Reply-To (file+<appId>@<domain>) so
    // any reply forwards to every assignee. An explicit opts.replyTo wins; otherwise
    // derive it from the applicationId. Null when no inbound domain is configured or
    // this isn't a file email (unchanged behavior then).
    const replyTo = opts.replyTo || fileReplyTo(opts.applicationId);
    const res = await email.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html, attachments, replyTo });
    await _mark(id, res && res.ok ? 'sent' : 'skipped');
  } catch (e) {
    await db.query(`UPDATE notifications SET email_status='error', email_error=$2 WHERE id=$1`, [id, String(e.message).slice(0, 400)]);
  }
}
async function _mark(id, status) {
  await db.query(
    `UPDATE notifications SET email_status=$2, emailed_at=CASE WHEN $2='sent' THEN now() ELSE emailed_at END WHERE id=$1`,
    [id, status]);
}

/** Notify one staff user. opts: {type,title,body,applicationId,link,emailTo,meta,lines,ctaLabel,greeting,note} */
async function notifyStaff(staffId, opts) {
  // S1-01 control center: a manager can switch a member's notifications OFF. When
  // off, we still write the in-app row (so their in-app queue keeps working and
  // nothing is lost) but skip the EMAIL. On by default; unknown column / missing
  // row falls back to enabled.
  let emailOn = true;
  try {
    const p = await db.query(`SELECT notifications_enabled FROM staff_users WHERE id=$1`, [staffId]);
    if (p.rows[0] && p.rows[0].notifications_enabled === false) emailOn = false;
  } catch (_) { /* column exists after migration 085; default on */ }
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_kind,staff_id,type,title,body,application_id,link)
     VALUES ('staff',$1,$2,$3,$4,$5,$6) RETURNING id`,
    [staffId, opts.type, opts.title, opts.body || null, opts.applicationId || null, opts.link || null]);
  const id = rows[0].id;
  const to = emailOn ? (opts.emailTo ? [].concat(opts.emailTo) : await _staffEmail(staffId)) : [];
  _emailRow(id, to, opts, 'staff');   // fire-and-forget (marks 'skipped' when `to` is empty)
  return id;
}

// Map a notification `type` onto a user-facing preference category.
const CATEGORY_OF = {
  message: 'messages',
  status_change: 'status_updates', closing_date: 'status_updates',
  doc_rejected: 'documents', doc_accepted: 'documents', doc_uploaded: 'documents',
  llc_verified: 'documents', llc_unverified: 'documents',
  track_record_unverified: 'documents',
  tool_submitted: 'documents',
  condition_added: 'conditions',
  product_registered: 'pricing', term_sheet: 'pricing', pricing_update: 'pricing',
  reminder: 'reminders',
  draw: 'draws', draw_request: 'draws',
};
// These always reach the borrower in-app even if the category is muted — they
// require action and can't be silently dropped (email can still be turned off).
const ALWAYS_IN_APP = new Set(['doc_rejected', 'condition_added', 'security', 'account', 'llc_unverified', 'track_record_unverified']);
const NOTIFY_CATEGORIES = ['messages', 'status_updates', 'documents', 'conditions', 'pricing', 'reminders', 'draws', 'other'];
const categoryOf = (type) => CATEGORY_OF[type] || 'other';

// #88: keep the borrower's inbox to MAJOR moments. These types EMAIL the borrower
// by default; every other type is in-app ONLY unless the borrower explicitly turns
// that category's email on. So loan-team busywork — a doc the LO uploaded, a
// routine acceptance, a minor in-between status move, a pricing tweak — no longer
// pings the borrower's inbox, while the things that actually matter (a rejected
// doc they must redo, a new condition, the closing date, a registered product /
// term sheet, a chat message, a draw, an account/security event) still do. A
// caller may pass `opts.major` to decide per-event (status_change uses it so only
// DECISION statuses email — see MAJOR_STATUSES in the status route).
const BORROWER_MAJOR_EMAIL = new Set([
  'closing_date', 'product_registered', 'term_sheet',
  // Borrower ACTION items — something the borrower must do — always email (a
  // requested doc, a rejected doc, a new condition, a verification that was
  // revoked and needs redoing). These are the opposite of LO busywork.
  'doc_rejected', 'doc_requested', 'condition_added',
  'llc_unverified', 'track_record_unverified',
  'message', 'draw', 'draw_request', 'security', 'account',
]);

/** Notify a borrower, respecting their per-category preferences. */
async function notifyBorrower(borrowerId, opts) {
  const cat = categoryOf(opts.type);
  // #88: email defaults ON only for major moments (or when a caller passes
  // opts.major=true); everything else is in-app only by default. An explicit
  // per-category borrower preference still wins over this default either way.
  const emailDefault = (typeof opts.major === 'boolean') ? opts.major : BORROWER_MAJOR_EMAIL.has(opts.type);
  let pref = { in_app: true, email: emailDefault };
  try {
    const pr = await db.query(`SELECT in_app,email FROM notification_prefs WHERE borrower_id=$1 AND category=$2`, [borrowerId, cat]);
    if (pr.rows[0]) pref = pr.rows[0];
  } catch (_) { /* prefs table always exists after migration; default per emailDefault */ }
  // Muted in-app and not a must-see? Drop it entirely — this is the borrower
  // choosing to quiet a nervous-making category.
  if (!pref.in_app && !ALWAYS_IN_APP.has(opts.type)) return null;
  // SECURITY (frozen rule): a capital-partner / note-buyer name must never reach
  // a borrower. Scrub every borrower-facing text field once here at the single
  // chokepoint, so BOTH the stored in-app row and the branded email are clean no
  // matter who assembled `opts` (e.g. a staff-typed condition label). Staff
  // notifications (notifyStaff) are intentionally NOT scrubbed.
  // Protect the file's own clean data (address / borrower name / program /
  // money) — which arrives as `meta` values — from the partner names that
  // collide with common place names ("Churchill", "Blue Lake"), while still
  // scrubbing a partner name a staffer typed into the title/body. `meta` itself
  // is trusted DB data and is left as-is.
  const protect = Array.isArray(opts.meta) ? opts.meta.map((m) => m && m.value).filter((v) => typeof v === 'string') : [];
  const sopts = {
    ...opts,
    title: scrubTextExcept(opts.title, protect),
    body: scrubTextExcept(opts.body, protect),
    note: scrubTextExcept(opts.note, protect),
    greeting: scrubTextExcept(opts.greeting, protect),
    ctaLabel: scrubText(opts.ctaLabel),
    lines: Array.isArray(opts.lines) ? opts.lines.map((l) => scrubTextExcept(l, protect)) : opts.lines,
  };
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_kind,borrower_id,type,title,body,application_id,link)
     VALUES ('borrower',$1,$2,$3,$4,$5,$6) RETURNING id`,
    [borrowerId, opts.type, sopts.title, sopts.body || null, opts.applicationId || null, opts.link || null]);
  const id = rows[0].id;
  const to = pref.email ? (opts.emailTo ? [].concat(opts.emailTo) : await _borrowerEmail(borrowerId)) : [];
  _emailRow(id, to, sopts, 'borrower');
  return id;
}

/** Notify BOTH borrowers on a file (primary + co-borrower), de-duplicated.
    Use for file-wide events (status change, closing date, conditions) so an
    invited co-borrower who can see the file also hears about it. */
async function notifyAppBorrowers(appId, opts) {
  const { rows } = await db.query(`SELECT borrower_id, co_borrower_id FROM applications WHERE id=$1`, [appId]);
  const a = rows[0]; if (!a) return [];
  const ids = [...new Set([a.borrower_id, a.co_borrower_id].filter(Boolean))];
  const out = [];
  for (const id of ids) out.push(await notifyBorrower(id, opts));
  return out;
}

/** Notify every ACTIVE staffer on a file — the primary LO/processor AND any
    full-access ASSISTANTS (#113) — de-duplicated. Previously each file-event site
    hand-built the recipient set from the denormalized loan_officer_id/processor_id
    pointer, which EXCLUDED assistants: they had full access but were silent
    recipients. This is the single fan-out chokepoint (mirrors notifyAppBorrowers)
    so every file event reaches the whole team. `opts.exceptStaffId` skips the actor
    who caused the event (staff-triggered sites). Per-staffer notifications_enabled
    is honored inside notifyStaff, so it isn't re-implemented here. */
async function notifyAppStaff(appId, opts = {}) {
  const { rows } = await db.query(
    `SELECT DISTINCT staff_id FROM application_assignees
      WHERE application_id=$1 AND removed_at IS NULL AND staff_id IS NOT NULL`, [appId]);
  const except = opts.exceptStaffId ? String(opts.exceptStaffId) : null;
  const out = [];
  for (const r of rows) {
    if (except && String(r.staff_id) === except) continue;
    out.push(await notifyStaff(r.staff_id, opts));
  }
  return out;
}

/** Notify every active admin (used when an application has no loan officer). */
async function notifyAdmins(opts) {
  const { rows } = await db.query(
    `SELECT id, email FROM staff_users WHERE role IN ('admin','super_admin') AND is_active = true`);
  const ids = [];
  for (const a of rows) ids.push(await notifyStaff(a.id, { ...opts, emailTo: a.email }));
  // also copy the configured NOTIFY_ADMINS inbox list, if any (branded)
  if (cfg.notifyAdmins.length) {
    const msg = buildEmail(opts, 'staff');
    email.sendMail({ to: cfg.notifyAdmins, subject: msg.subject, text: msg.text, html: msg.html,
      replyTo: opts.replyTo || fileReplyTo(opts.applicationId) }).catch(() => {});
  }
  return ids;
}

async function _staffEmail(id)    { const r = await db.query(`SELECT email FROM staff_users WHERE id=$1`, [id]); return r.rows[0]?.email ? [r.rows[0].email] : []; }
async function _borrowerEmail(id) { const r = await db.query(`SELECT email FROM borrowers   WHERE id=$1`, [id]); return r.rows[0]?.email ? [r.rows[0].email] : []; }

/**
 * File context for notifications: every notification about a file should say
 * WHICH file — loan number, property, borrower, program — without the reader
 * having to open the portal. Returns { label, addr, loanNo, borrowerName,
 * meta } (meta = [{label,value}] lines rendered in the branded email).
 * Best-effort: returns null on any error so a notification never fails.
 */
async function fileContext(appId, extraMeta = []) {
  try {
    const r = await db.query(
      `SELECT a.ys_loan_number, a.property_address, a.program, a.loan_type, a.status,
              a.purchase_price, a.arv, a.rehab_budget, a.loan_amount,
              b.first_name, b.last_name, b.email, b.cell_phone
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId]);
    const a = r.rows[0];
    if (!a) return null;
    const pa = a.property_address || {};
    const addr = pa.oneLine || [pa.street || pa.line1, pa.city, pa.state].filter(Boolean).join(', ') || '(no address yet)';
    const borrowerName = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || 'Borrower';
    const loanNo = a.ys_loan_number || 'Loan # pending';
    const money = (n) => (n == null ? null : '$' + Math.round(Number(n)).toLocaleString('en-US'));
    const meta = [
      { label: 'File', value: loanNo },
      { label: 'Property', value: addr },
      { label: 'Borrower', value: `${borrowerName}${a.email ? ` · ${a.email}` : ''}${a.cell_phone ? ` · ${a.cell_phone}` : ''}` },
      a.program ? { label: 'Program', value: a.program } : null,
      a.loan_type ? { label: 'Loan type', value: a.loan_type } : null,
      a.purchase_price != null ? { label: 'Purchase price', value: money(a.purchase_price) } : null,
      a.arv != null ? { label: 'ARV', value: money(a.arv) } : null,
      a.rehab_budget != null ? { label: 'Rehab budget', value: money(a.rehab_budget) } : null,
      a.loan_amount != null ? { label: 'Loan amount', value: money(a.loan_amount) } : null,
      ...extraMeta,
    ].filter(Boolean);
    return { label: `${loanNo} · ${addr}`, addr, loanNo, borrowerName, meta };
  } catch (_) { return null; }
}

module.exports = { notifyStaff, notifyBorrower, notifyAppBorrowers, notifyAppStaff, notifyAdmins, buildEmail, fileContext, NOTIFY_CATEGORIES, ALWAYS_IN_APP };
