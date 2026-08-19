'use strict';
/**
 * src/lib/elementix/identity.js — which Elementix login is this, and whose is it?
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * The owner asked for "a list of all of our users" in Elementix, linked to the
 * loan officers in PILOT. There is no tool for that: the account's published
 * catalogue is 40 tools and NOT ONE of them lists the organisation's users. So
 * the list cannot be pulled.
 *
 * It does not have to be. Each officer has their own Elementix login (owner,
 * 2026-08-18), and PILOT's OAuth has carried a per-officer scope since db/489.
 * So the link is made the other way round and is stronger for it: the officer
 * signs in to PILOT as themselves, clicks Connect, and approves in Elementix as
 * themselves. The row that comes back IS the link — we are not matching two
 * lists by name and hoping, we are recording an act of authentication. A name
 * match can be wrong; this cannot.
 *
 * What `welcome` adds is the LABEL: what Elementix calls that login, so an
 * admin screen can show "PILOT: Yehuda B ↔ Elementix: yehuda" and a human can
 * see at a glance that the right seat is attached to the right person. That is
 * a display nicety on top of a link that is already sound — which is why every
 * field it reads is optional and nothing breaks when the vendor answers with a
 * shape we did not expect.
 */

const db = require('../../db');
const crm = require('./crm-tools');

const str = (v) => String(v == null ? '' : v).trim();
const clip = (v, n) => (str(v) ? str(v).slice(0, n) : null);

/**
 * Pull a human identity out of whatever `welcome` answered.
 *
 * PURE, and DELIBERATELY UNSURE OF ITSELF. `welcome` is one of the tools whose
 * response shape was never transcribed (the connector research probed 21 of 40),
 * so this reads a spread of plausible spellings and returns nulls for anything
 * it cannot find. It NEVER invents a label from something adjacent — an empty
 * admin row that says "connected, name unknown" is honest and fixable; a row
 * confidently showing the wrong officer's name is neither.
 *
 * The email is the field worth the most, because it is the one that can be
 * checked against `staff_users.email` — so `mismatch` is reported when the
 * Elementix login's email is a DIFFERENT address from the PILOT officer who
 * connected it. That is not made into a refusal: plenty of people sign up to a
 * vendor with a personal address. It is surfaced for a human to look at.
 */
function identityFrom(payload) {
  const out = { user: null, email: null, org: null };
  if (!payload || typeof payload !== 'object') return out;

  // WHERE a name was found decides WHAT it means, so the nests are kept apart
  // rather than flattened into one search list. A bare `name` inside an explicit
  // `user` object is that user's name; the same key at the root, or inside an
  // `organization`, is just as likely the company — and guessing wrong prints
  // another person's name against an officer's seat.
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const userNests = ['user', 'me', 'profile', 'session', 'viewer', 'currentUser', 'current_user']
    .map((k) => obj(payload[k])).filter(Boolean);
  const orgNests = ['organization', 'org', 'account', 'company', 'tenant', 'workspace']
    .map((k) => obj(payload[k])).filter(Boolean);
  // A generic envelope is not evidence of either meaning; treat what is inside
  // it exactly as we treat the root.
  const rootish = [payload, ...['data', 'result', 'welcome'].map((k) => obj(payload[k])).filter(Boolean)];

  const pick = (sources, keys) => {
    for (const src of sources) {
      for (const k of keys) {
        const v = src[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    return null;
  };

  // UNAMBIGUOUS keys — these name a person wherever they appear.
  const USER_KEYS = ['userName', 'username', 'user_name', 'displayName', 'display_name',
    'fullName', 'full_name', 'login', 'handle'];
  // AMBIGUOUS — only trusted inside an explicit user object.
  const NAME_KEYS = ['name', ...USER_KEYS];
  const EMAIL_KEYS = ['email', 'userEmail', 'user_email', 'emailAddress', 'email_address'];
  const ORG_KEYS = ['organization', 'organizationName', 'organization_name', 'org', 'orgName',
    'org_name', 'account', 'accountName', 'company', 'companyName', 'tenant', 'name'];

  const userFromNest = pick(userNests, NAME_KEYS);
  out.user = userFromNest || pick(rootish, USER_KEYS);
  out.email = pick(userNests, EMAIL_KEYS) || pick(rootish, EMAIL_KEYS);
  out.org = pick(orgNests, ORG_KEYS) || pick(rootish, ORG_KEYS.filter((k) => k !== 'name'))
    // A root-level bare `name` is read as the ORG only once we are confident it
    // is not the person: either nothing claimed the user slot, or the user came
    // out of an explicit `user` object and so cannot be this key.
    || ((!out.user || userFromNest) ? pick(rootish, ['name']) : null);

  // Same value in both slots means we could not tell them apart. Keep the org
  // (a welcome screen naming the account is the likelier reading) and drop the
  // person rather than assert a name we may have invented.
  if (out.user && out.org && out.user === out.org) out.user = null;

  // An email is only an email. Anything else was a wrong pick.
  if (out.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.email)) out.email = null;
  return out;
}

/**
 * Ask Elementix who this connection belongs to, and record it.
 *
 * Best-effort by contract: the caller is usually finishing an OAuth approval, and
 * a connection that works must never be reported as failed because a cosmetic
 * label could not be read. Returns what it learned either way.
 *
 * `staffId` null asks about the COMPANY-WIDE connection; a staff id asks about
 * that officer's own.
 *
 * THE CALL GOES OUT ON THE SEAT BEING ASKED ABOUT, and is BILLED to the human
 * who asked. Those are two different people whenever an admin refreshes the
 * COMPANY label: passing the admin's id as the seat would send the question down
 * the admin's own connection (if they have one), and Elementix would answer with
 * the admin's name — which this function then writes onto the company row as its
 * label. `tokenSeat` is what keeps them apart; `staffId` stays the ledger's
 * answer to "who used the allowance".
 */
async function recordIdentity(staffId = null, opts = {}) {
  const res = await crm.call('welcome', {}, {
    staffId: staffId || opts.actingStaffId || null,
    tokenSeat: staffId || null,
  });
  if (!res || res.ok !== true) {
    return { ok: false, reason: (res && res.reason) || 'welcome_failed',
      detail: (res && res.detail) || 'Elementix did not answer the welcome check.' };
  }
  const id = identityFrom(res.data);
  try {
    const url = require('../../config').elementix.url;
    await db.query(
      `UPDATE elementix_oauth
          SET elx_user_label = COALESCE($3, elx_user_label),
              elx_user_email = COALESCE($4, elx_user_email),
              elx_org_label  = COALESCE($5, elx_org_label),
              identity_at    = now(),
              identity_raw   = $6::jsonb,
              updated_at     = now()
        WHERE resource_url = $1
          AND staff_id IS NOT DISTINCT FROM $2::uuid`,
      [String(url || '').replace(/\/+$/, ''), staffId || null,
        clip(id.user, 200), clip(id.email, 200), clip(id.org, 200),
        crm.vendorJsonb(res.data, 20000)]);
  } catch (_) {
    /* A label we could not store is a label; the connection is unaffected. */
  }
  return { ok: true, ...id };
}

/**
 * Every stored Elementix connection, with the PILOT officer it belongs to.
 * THIS IS THE "list of our users" THE OWNER ASKED FOR — assembled from the
 * officers who have actually connected, which is the only list that is true.
 *
 * NO TOKEN, ENCRYPTED OR OTHERWISE, IS SELECTED. The columns are named
 * explicitly rather than `SELECT *` for exactly that reason: this feeds an
 * admin screen, and a `*` here would put a refresh token one careless
 * `res.json(row)` away from the wire.
 */
async function connections() {
  const { rows } = await db.query(
    `SELECT o.staff_id,
            s.full_name        AS officer_name,
            s.email            AS officer_email,
            s.role             AS officer_role,
            s.is_active        AS officer_active,
            o.elx_user_label,
            o.elx_user_email,
            o.elx_org_label,
            o.identity_at,
            o.connected_at,
            o.last_refresh_at,
            o.expires_at,
            o.last_error,
            o.last_error_at,
            (o.refresh_token_enc IS NOT NULL) AS self_renewing
       FROM elementix_oauth o
       LEFT JOIN staff_users s ON s.id = o.staff_id
      ORDER BY (o.staff_id IS NULL) DESC, s.full_name NULLS LAST`);

  return rows.map((r) => ({
    scope: r.staff_id ? 'officer' : 'company',
    staffId: r.staff_id,
    officer: r.staff_id
      ? { id: r.staff_id, name: r.officer_name, email: r.officer_email, role: r.officer_role, active: r.officer_active }
      : null,
    elementix: { user: r.elx_user_label, email: r.elx_user_email, org: r.elx_org_label, checkedAt: r.identity_at },
    connectedAt: r.connected_at,
    lastRefreshAt: r.last_refresh_at,
    expiresAt: r.expires_at,
    selfRenewing: r.self_renewing,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    // Surfaced, never enforced — see identityFrom. A personal signup address is
    // a normal reason for these to differ.
    emailMismatch: !!(r.elx_user_email && r.officer_email
      && String(r.elx_user_email).toLowerCase() !== String(r.officer_email).toLowerCase()),
  }));
}

/**
 * Which officers have NOT connected their own login yet. They still work — they
 * read through the company-wide connection — but their skip traces cannot be
 * attributed to their own Elementix seat, so the CRM screen nudges them.
 *
 * Loan-officer-shaped roles only: nobody is nagged to connect a data vendor they
 * have no reason to use.
 */
async function officersNotConnected() {
  const { rows } = await db.query(
    `SELECT s.id, s.full_name, s.email, s.role
       FROM staff_users s
      WHERE s.is_active = true
        AND s.is_external = false
        AND s.role IN ('loan_officer','admin','super_admin','processor')
        AND NOT EXISTS (SELECT 1 FROM elementix_oauth o WHERE o.staff_id = s.id)
      ORDER BY s.full_name`);
  return rows.map((r) => ({ id: r.id, name: r.full_name, email: r.email, role: r.role }));
}

module.exports = { identityFrom, recordIdentity, connections, officersNotConnected };
