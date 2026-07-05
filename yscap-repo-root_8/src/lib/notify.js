/**
 * Notification service. Writes an in-app notification row (always) and, best
 * effort, fans it out by BRANDED email via the configured provider — recording
 * the email status on the row so nothing is lost if the provider is down/absent.
 *
 * The in-app row stores the plain title/body (unchanged). The email is rendered
 * through src/lib/email/template.js into deep-ink/teal branded HTML + a
 * plaintext fallback, with an absolute CTA link back into the portal.
 */
const db = require('../db');
const email = require('./email');
const tpl = require('./email/template');
const { link: portalLink } = require('./email/catalog');
const cfg = require('../config');

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
    const res = await email.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html });
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
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_kind,staff_id,type,title,body,application_id,link)
     VALUES ('staff',$1,$2,$3,$4,$5,$6) RETURNING id`,
    [staffId, opts.type, opts.title, opts.body || null, opts.applicationId || null, opts.link || null]);
  const id = rows[0].id;
  const to = opts.emailTo ? [].concat(opts.emailTo) : await _staffEmail(staffId);
  _emailRow(id, to, opts, 'staff');   // fire-and-forget
  return id;
}

/** Notify a borrower. */
async function notifyBorrower(borrowerId, opts) {
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_kind,borrower_id,type,title,body,application_id,link)
     VALUES ('borrower',$1,$2,$3,$4,$5,$6) RETURNING id`,
    [borrowerId, opts.type, opts.title, opts.body || null, opts.applicationId || null, opts.link || null]);
  const id = rows[0].id;
  const to = opts.emailTo ? [].concat(opts.emailTo) : await _borrowerEmail(borrowerId);
  _emailRow(id, to, opts, 'borrower');
  return id;
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
    email.sendMail({ to: cfg.notifyAdmins, subject: msg.subject, text: msg.text, html: msg.html }).catch(() => {});
  }
  return ids;
}

async function _staffEmail(id)    { const r = await db.query(`SELECT email FROM staff_users WHERE id=$1`, [id]); return r.rows[0]?.email ? [r.rows[0].email] : []; }
async function _borrowerEmail(id) { const r = await db.query(`SELECT email FROM borrowers   WHERE id=$1`, [id]); return r.rows[0]?.email ? [r.rows[0].email] : []; }

module.exports = { notifyStaff, notifyBorrower, notifyAdmins, buildEmail };
