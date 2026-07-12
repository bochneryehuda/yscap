/** Admin API — user management + Lead-Capture overview. */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const provider = require('../lib/email');
const tpl = require('../lib/email/template');
const mail = require('../lib/email/catalog');
const roster = require('./roster');
const { requireAuth, requirePermission } = require('../auth');

// Capability-gated admin surface (mirrors the file/condition surfaces): team &
// roster management needs manage_team; integrations/email config needs
// platform_setup — so a Software Setup persona granted platform_setup can wire
// up integrations without also becoming a full admin, and a manage_team grantee
// can run the roster. admin/super_admin hold both by default.
router.use(requireAuth);
router.use(['/staff', '/permissions-meta', '/borrowers'], requirePermission('manage_team'));
router.use(['/test-email', '/integrations'], requirePermission('platform_setup'));

const { ROLE_KEYS, CAPABILITIES, effectivePermissions, sanitizeOverrides } = require('../lib/permissions');
const ROLES = ROLE_KEYS;
const DEPTS = ['sales', 'operations'];

/**
 * Send a branded test email so you can confirm the provider (Resend/Graph) and
 * FROM domain are wired correctly. POST { to?: "you@x.com" } — defaults to the
 * admin's own address. Returns the provider result, including any error verbatim
 * (e.g. Resend "domain not verified"), so misconfiguration is obvious.
 */
router.post('/test-email', async (req, res) => {
  let to = (req.body && req.body.to) || null;
  if (!to) {
    const r = await db.query(`SELECT email FROM staff_users WHERE id=$1`, [req.actor.id]);
    to = r.rows[0]?.email;
  }
  if (!to) return res.status(400).json({ ok: false, error: 'no recipient (pass {to})' });
  if (cfg.emailProvider === 'none') {
    return res.status(400).json({
      ok: false, provider: 'none',
      error: 'EMAIL_PROVIDER is none — set RESEND_API_KEY (or the MS_* vars) and redeploy.',
    });
  }
  const built = tpl.render({
    audience: 'staff',
    title: 'YS Capital email test',
    preheader: 'This confirms transactional email is working.',
    intro: 'This is a test message from the YS Capital Group portal.',
    lines: [`Provider: ${cfg.emailProvider}. From: ${cfg.notifyFrom}. If you received this, email delivery is configured correctly.`],
    note: 'You can safely ignore this message.',
  });
  try {
    const r = await provider.sendMail({ to, subject: built.subject, text: built.text, html: built.html });
    return res.json({ ok: !!(r && r.ok), provider: cfg.emailProvider, from: cfg.notifyFrom, to, id: r && r.id });
  } catch (e) {
    return res.status(502).json({ ok: false, provider: cfg.emailProvider, from: cfg.notifyFrom, to, error: e.message });
  }
});

// ---------------- staff / team management ----------------
// super_admin is strictly above admin. Only a super_admin may create/assign the
// super_admin role or modify an existing super_admin account — otherwise a plain
// admin could reset the president's password, deactivate him, or self-escalate.
const isSuper = (req) => req.actor.role === 'super_admin';
async function targetRole(id) {
  const r = await db.query(`SELECT role FROM staff_users WHERE id=$1`, [id]);
  return r.rows[0] ? r.rows[0].role : null;
}
// Returns null if allowed, or an {code,error} to send. `newRole` is the role the
// request would assign (or undefined if unchanged).
function roleGuard(req, currentRole, newRole) {
  if (currentRole === 'super_admin' && !isSuper(req))
    return { code: 403, error: 'only a super admin can modify a super admin account' };
  if (newRole === 'super_admin' && !isSuper(req))
    return { code: 403, error: 'only a super admin can grant the super admin role' };
  // The `admin` role carries EVERY platform-wide power by default, so GRANTING it
  // — minting a new admin via create, or promoting an existing account — is
  // super-admin-only too. Without this, a non-super manage_team holder could hand
  // out the whole platform through the role channel instead of the permissions
  // channel, sidestepping the powerful-cap gate below (audit RESIDUAL 1).
  if (newRole === 'admin' && !isSuper(req))
    return { code: 403, error: 'only a super admin can grant the admin role' };
  return null;
}

// Platform-wide capabilities that ONLY a super admin may grant (through either the
// role or the permissions channel). These are the "keys to the whole platform" —
// granting any of them is exactly how "manage team" could become a path to every
// power, so they are gated ABOVE the manage_team capability itself. view_audit_log
// is included because it exposes the company-wide PII trail across every file.
const POWERFUL_CAPS = ['manage_team', 'platform_setup', 'delete_files', 'see_all_files', 'manage_conditions', 'view_audit_log'];
// UUIDs are case-insensitive/canonicalizing in Postgres, so a self-vs-target id
// compare MUST be case-folded — otherwise the same actor's own id in a different
// case slips past the self-escalation block (audit DEFECT 1).
const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// Roles + capability catalog + each role's default grants, for the Team UI.
router.get('/permissions-meta', (req, res) => {
  const { ROLES, ROLE_DEFAULTS } = require('../lib/permissions');
  res.json({ roles: ROLES, capabilities: CAPABILITIES, roleDefaults: ROLE_DEFAULTS });
});

// The full team, with the roster fields the admin console edits. Each row
// carries its raw permission overrides plus the resolved effective capability
// list so the Team UI can show exactly what each person can do.
router.get('/staff', async (req, res) => {
  const r = await db.query(
    `SELECT id,email,full_name,role,title,department,phone,cell,ext,
            is_active,site_selectable,sort_order,mfa_enabled,permissions,
            COALESCE(visible_officer_ids,'{}')::uuid[] AS visible_officer_ids,
            (password_hash IS NOT NULL) AS has_login, last_login_at
       FROM staff_users ORDER BY department NULLS LAST, sort_order, full_name`);
  res.json(r.rows.map((row) => ({
    ...row,
    permissions: row.permissions || null,
    visibleOfficerIds: row.visible_officer_ids || [],
    effectivePermissions: [...effectivePermissions(row.role, row.permissions)],
  })));
});

// Create a staff member. They appear on the roster (if sales + site_selectable),
// in portal assignment lists, and can log in as soon as a password is set —
// either directly here (password) or via an emailed invite (sendInvite:true).
router.post('/staff', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim();
  const fullName = String(b.fullName || '').trim();
  const role = String(b.role || 'loan_officer');
  if (!email || !fullName) return res.status(400).json({ error: 'email and fullName required' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'bad role' });
  if (b.department && !DEPTS.includes(b.department)) return res.status(400).json({ error: 'bad department' });
  if (b.password) { const w = C.passwordProblem(b.password); if (w) return res.status(400).json({ error: w }); }
  try {
    // Guard against granting super_admin, or silently touching an existing
    // super_admin (e.g. re-adding the president's email would otherwise
    // demote/overwrite him). On conflict we deliberately do NOT change role —
    // role changes go through the edit endpoint — so re-adding never demotes.
    const existing = await db.query(`SELECT role FROM staff_users WHERE email=$1`, [email]);
    const g = roleGuard(req, existing.rows[0] && existing.rows[0].role, role);
    if (g) return res.status(g.code).json({ error: g.error });
    // S1-05: a non-super must not touch (or mint an invite for) an EXISTING admin
    // account. Without this, re-inviting an admin's email returns a raw invite
    // token that /auth/accept would use to overwrite that admin's password and
    // hand back an admin session — an admin-account takeover (post-fix audit
    // HIGH). super_admin targets are already blocked by roleGuard above.
    if (!isSuper(req) && existing.rows[0] && existing.rows[0].role === 'admin')
      return res.status(403).json({ error: 'only a super admin can modify an admin account' });

    const dept = b.department || (['processor', 'underwriter', 'loan_coordinator', 'software_setup'].includes(role) ? 'operations' : 'sales');
    const permOverrides = sanitizeOverrides(b.permissions);
    // S1-05: the create path must apply the SAME powerful-cap gate as the edit
    // path — otherwise a non-super manage_team holder could mint a brand-new
    // account pre-loaded with platform-wide overrides (audit RESIDUAL 1).
    if (permOverrides && !isSuper(req) && POWERFUL_CAPS.some((c) => permOverrides[c] === true))
      return res.status(403).json({ error: 'Only a super admin can grant platform-wide permissions (manage team, platform setup, delete files, see all files, manage conditions, view audit log).' });
    const r = await db.query(
      `INSERT INTO staff_users
         (email,full_name,role,title,department,phone,cell,ext,
          site_selectable,is_active,sort_order,password_hash,permissions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12)
       ON CONFLICT (email) DO UPDATE SET
         full_name=EXCLUDED.full_name, title=EXCLUDED.title,
         department=EXCLUDED.department, phone=EXCLUDED.phone, cell=EXCLUDED.cell,
         ext=EXCLUDED.ext, site_selectable=EXCLUDED.site_selectable, is_active=true,
         updated_at=now()
       RETURNING id, (xmax=0) AS created`,
      [email, fullName, role, b.title || null, dept, b.phone || null, b.cell || null, b.ext || null,
       b.siteSelectable !== false, Number(b.sortOrder) || 100, b.password ? await C.hashPassword(b.password) : null,
       permOverrides ? JSON.stringify(permOverrides) : null]);
    const staffId = r.rows[0].id;
    roster.bust();

    let invited = false, inviteToken = null;
    if (!b.password && b.sendInvite) {
      inviteToken = C.randomToken(24);
      await db.query(
        `INSERT INTO invite_tokens (token_hash,kind,email,role,created_by,expires_at)
         VALUES ($1,'staff',$2,$3,$4, now() + interval '7 days')`,
        [C.sha256(inviteToken), email, role, req.actor.id]);
      try {
        let inviter = 'YS Capital Group';
        const iv = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
        if (iv.rows[0]?.full_name) inviter = iv.rows[0].full_name;
        const sent = await mail.send('staffInvite', email, {
          fullName, role, acceptUrl: mail.link('/accept?token=' + inviteToken), inviter, days: 7 });
        invited = !!(sent && sent.ok);
      } catch (_) {}
    }
    res.status(201).json({ ok: true, staffId, created: r.rows[0].created, invited, inviteToken });
  } catch (e) { res.status(500).json({ error: 'could not save staff member' }); }
});

// Edit any roster/profile field. Only provided fields change.
router.patch('/staff/:id', async (req, res) => {
  const b = req.body || {};
  if (b.role && !ROLES.includes(b.role)) return res.status(400).json({ error: 'bad role' });
  if (b.department && !DEPTS.includes(b.department)) return res.status(400).json({ error: 'bad department' });
  const tRole = await targetRole(req.params.id);
  const g = roleGuard(req, tRole, b.role);
  if (g) return res.status(g.code).json({ error: g.error });
  // S1-05: a staffer cannot escalate THEMSELVES — no editing your own role,
  // permissions, or shared-file access (that's how "manage team" became a path
  // to self-granting every power). The id compare is case-folded because a
  // Postgres uuid matches case-insensitively — a raw === would let the actor's
  // own id in a different case slip past this block (audit DEFECT 1).
  if (sameId(req.params.id, req.actor.id) &&
      (b.role !== undefined || b.permissions !== undefined || b.visibleOfficerIds !== undefined)) {
    return res.status(403).json({ error: 'You cannot change your own role, permissions, or file access.' });
  }
  // S1-05: an existing admin account holds every platform-wide power, so only a
  // super admin may change ANOTHER admin's role / permissions / file access /
  // active state (mirrors the password-reset guard below). A non-super can still
  // edit their OWN profile above and freely manage the lower roles.
  if (!isSuper(req) && tRole === 'admin' && !sameId(req.params.id, req.actor.id) &&
      (b.role !== undefined || b.permissions !== undefined ||
       b.visibleOfficerIds !== undefined || b.isActive !== undefined)) {
    return res.status(403).json({ error: "Only a super admin can change another admin's role, permissions, access, or active status." });
  }
  // S1-05: only a SUPER admin may grant the powerful, platform-wide capabilities.
  if (b.permissions !== undefined && !isSuper(req)) {
    const _ov = sanitizeOverrides(b.permissions) || {};
    if (POWERFUL_CAPS.some((c) => _ov[c] === true))
      return res.status(403).json({ error: 'Only a super admin can grant platform-wide permissions (manage team, platform setup, delete files, see all files, manage conditions, view audit log).' });
  }
  const map = {
    full_name: b.fullName, role: b.role, title: b.title, department: b.department,
    phone: b.phone, cell: b.cell, ext: b.ext,
    is_active: b.isActive, site_selectable: b.siteSelectable, sort_order: b.sortOrder,
  };
  const sets = [], vals = []; let i = 1;
  for (const [k, v] of Object.entries(map)) if (v !== undefined) { sets.push(`${k}=$${i++}`); vals.push(v); }
  // Deactivating a staffer must cut off ALL their live sessions immediately —
  // including the SSE chat stream — so bump the token version, invalidating every
  // existing token in one shot (S1-01: a fired staffer kept receiving live chat).
  if (b.isActive === false) sets.push('token_version=token_version+1');
  // Permission overrides: {} or null clears them (fall back to role defaults).
  if (b.permissions !== undefined) {
    const ov = sanitizeOverrides(b.permissions);
    sets.push(`permissions=$${i++}`); vals.push(ov ? JSON.stringify(ov) : null);
  }
  // Shared file access: the specific loan officers whose files this staffer may
  // see even when unassigned. Validated to UUIDs + deduped; [] clears it. Read
  // fresh by the scope checks each request, so it takes effect immediately.
  if (b.visibleOfficerIds !== undefined) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = Array.isArray(b.visibleOfficerIds)
      ? [...new Set(b.visibleOfficerIds.map(String).filter((x) => UUID.test(x)))]
      : [];
    sets.push(`visible_officer_ids=$${i++}::uuid[]`); vals.push(ids);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  try {
    const r = await db.query(`UPDATE staff_users SET ${sets.join(',')} WHERE id=$${i} RETURNING id`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'staff member not found' });   // was phantom {ok:true}
    roster.bust();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'could not update staff member' }); }
});

// Set / reset a staff password (admin-driven provisioning or lockout recovery).
router.post('/staff/:id/password', async (req, res) => {
  const pw = (req.body || {}).password || '';
  { const w = C.passwordProblem(pw); if (w) return res.status(400).json({ error: w }); }
  const tRole = await targetRole(req.params.id);
  const g = roleGuard(req, tRole);
  if (g) return res.status(g.code).json({ error: g.error });
  // S1-05: resetting an ADMIN's password (a peer-admin takeover vector) is
  // super-admin-only; roleGuard already blocks resetting a super_admin.
  if (tRole === 'admin' && !isSuper(req))
    return res.status(403).json({ error: "Only a super admin can reset another admin's password." });
  const r = await db.query(
    `UPDATE staff_users SET password_hash=$2, token_version=token_version+1,
        failed_attempts=0, locked_until=NULL, updated_at=now()
      WHERE id=$1 RETURNING email`, [req.params.id, await C.hashPassword(pw)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'staff not found' });
  res.json({ ok: true, email: r.rows[0].email });
});

// Send a "your console is ready" welcome. Staff WITH a login get a sign-in
// email; staff without get an invite link to set their password.
async function sendWelcome(row) {
  let url, hasLogin = !!row.has_login;
  if (hasLogin) url = mail.link('/internal/login');
  else {
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,role,expires_at)
       VALUES ($1,'staff',$2,$3, now() + interval '14 days')`, [C.sha256(token), row.email, row.role]);
    url = mail.link('/accept?token=' + token);
  }
  const r = await mail.send('staffWelcome', row.email, { fullName: row.full_name, role: row.role, url, hasLogin });
  return !!(r && r.ok);
}
router.post('/staff/:id/welcome', async (req, res) => {
  const r = await db.query(
    `SELECT email, full_name, role, (password_hash IS NOT NULL) AS has_login
       FROM staff_users WHERE id=$1 AND is_active=true`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'staff not found' });
  try {
    const sent = await sendWelcome(r.rows[0]);
    res.json({ ok: true, sent, email: r.rows[0].email });
  } catch (e) { res.status(502).json({ error: 'could not send welcome email' }); }
});
// Email a staff member a "set a new password" link. Works whether or not they
// already have a login — accepting the token resets their password (the /accept
// staff path does ON CONFLICT DO UPDATE password_hash). super_admin-protected.
router.post('/staff/:id/reset-email', async (req, res) => {
  const tRole = await targetRole(req.params.id);
  const g = roleGuard(req, tRole);
  if (g) return res.status(g.code).json({ error: g.error });
  // S1-05: sending a password-reset email for another ADMIN is super-admin-only,
  // mirroring the /staff/:id/password guard — keeps the whole admin-account
  // surface consistent (an admin is otherwise a takeover target).
  if (tRole === 'admin' && !isSuper(req))
    return res.status(403).json({ error: "Only a super admin can reset another admin's password." });
  const r = await db.query(`SELECT email, full_name, role FROM staff_users WHERE id=$1 AND is_active=true`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'staff not found' });
  try {
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,role,created_by,expires_at)
       VALUES ($1,'staff',$2,$3,$4, now() + interval '7 days')`,
      [C.sha256(token), r.rows[0].email, r.rows[0].role, req.actor.id]);
    const sent = await mail.send('staffPasswordReset', r.rows[0].email, {
      fullName: r.rows[0].full_name, url: mail.link('/accept?token=' + token), days: 7 });
    res.json({ ok: true, sent: !!(sent && sent.ok), email: r.rows[0].email });
  } catch (e) { res.status(502).json({ error: 'could not send reset email' }); }
});

router.post('/staff/welcome-all', async (req, res) => {
  const onlyNoLogin = (req.body || {}).onlyWithoutLogin !== false;   // default: those who can't log in yet
  const r = await db.query(
    `SELECT email, full_name, role, (password_hash IS NOT NULL) AS has_login
       FROM staff_users WHERE is_active=true ${onlyNoLogin ? 'AND password_hash IS NULL' : ''}
      ORDER BY full_name`);
  let sent = 0, failed = 0;
  for (const row of r.rows) {
    try { (await sendWelcome(row)) ? sent++ : failed++; }
    catch (_) { failed++; }
  }
  res.json({ ok: true, total: r.rows.length, sent, failed });
});

router.get('/borrowers', async (req, res) => {
  const r = await db.query(
    `SELECT id,first_name,last_name,email,tier,created_at FROM borrowers ORDER BY created_at DESC LIMIT 200`);
  res.json(r.rows);
});

// Which third-party integrations are configured (keys present) vs pending.
router.get('/integrations', (req, res) => {
  res.json(require('../lib/integrations').status());
});

module.exports = router;
