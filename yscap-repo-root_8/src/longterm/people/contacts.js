'use strict';
/**
 * LONG-TERM — who is on this loan.
 *
 * Owner-directed 2026-08-14: *"We need to map up the loan officers — it should
 * realize from Encompass which loan officer each and every file belongs to. We need
 * to map a full assigned contacts through Encompass: loan officer, processors,
 * closers, and funders, and both closers. Full section."* And, on where the answer
 * comes from: **Encompass fills it, PILOT can override locally.**
 *
 * THE READ SURFACE IS `LoanTeamMember.{Name|UserId|Email|Phone}.<role>`, and the
 * live probe settled every part of that grammar on 2026-08-14:
 *
 *   · It is **`UserId`, not `Id`** — `LoanTeamMember.Id.<role>` is an invalid field
 *     id, and fieldReader rejects the WHOLE batch on one bad id.
 *   · The role segment is the TENANT'S OWN role name, spaces included. This tenant
 *     has **no role called "Loan Officer"** — its loan-officer slot is
 *     `Loan Coordinator`. So the names live in settings
 *     (`contacts.encompassRoleNames`), never in code.
 *   · `UserId` is the Encompass LOGIN ID, which is exactly `/company/users[].id` —
 *     the join key the people map is built on.
 *
 * WHY THE NAME AND EMAIL ARE STORED BUT NEVER TRUSTED TO IDENTIFY ANYBODY. The
 * probe found `/associates` rows whose name disagreed with their own id — one real
 * row read `{"id":"mschwimmer","name":"Malky Katz"}`, two different people — and the
 * tenant's own names carry double spaces ("Malky  Katz"). So the login id resolves
 * WHO, and the name/email/phone are kept only to SHOW on a file where nobody has
 * linked that login yet. A contact whose login is unlinked still displays; it simply
 * does not attribute the file to a PILOT person, and therefore does not put it in
 * anybody's `own` pipeline.
 *
 * THE OVERRIDE IS PILOT-SIDE AND STAYS THAT WAY. `override_staff_id` records that
 * somebody here reassigned a file locally. It is NEVER written back — Encompass is
 * one-way — and it is deliberately a SEPARATE column from `staff_id` so the next
 * sync can refresh what Encompass says without touching what we decided. Both sides
 * are honoured by the pipeline scope (access.pipelineScopeSql), which is what makes
 * a locally-reassigned file genuinely the new person's.
 *
 * PURE + IO, split: everything that decides is pure and testable with no database
 * and no Encompass; the persistence is at the bottom.
 */

const match = require('./match');

const lazy = {
  get db() { return require('../db'); },
  get client() { return require('../encompass/client'); },
  get settings() { return require('../settings/store'); },
  get links() { return require('./links'); },
};

/** The four things Encompass publishes per role. `Id` is NOT one of them. */
const PARTS = ['UserId', 'Name', 'Email', 'Phone'];

/**
 * OUR default role → the tenant's Encompass role name. Mirrors the settings default
 * (`contacts.encompassRoleNames`) and is used only when settings cannot be read.
 * "Loan Coordinator" is not a typo — see the header.
 */
const DEFAULT_ENCOMPASS_ROLE_NAMES = {
  loan_officer: 'Loan Coordinator',
  processor: 'Loan Processor',
  underwriter: 'Underwriter',
  closer: 'Closer',
  funder: 'Funder',
  post_closer: 'Post Closer',
};

const DEFAULT_ROLES = ['loan_officer', 'processor', 'underwriter', 'closer', 'funder', 'post_closer'];

/** The roles we mirror, and what each is called in Encompass, out of settings. */
function roleConfig(settings = {}) {
  const roles = Array.isArray(settings['contacts.roles']) && settings['contacts.roles'].length
    ? settings['contacts.roles'].map(String)
    : DEFAULT_ROLES;
  const names = (settings['contacts.encompassRoleNames'] && typeof settings['contacts.encompassRoleNames'] === 'object')
    ? settings['contacts.encompassRoleNames']
    : DEFAULT_ENCOMPASS_ROLE_NAMES;
  // A role with no Encompass name cannot be read, and asking for a field id built
  // from `undefined` would reject the entire batch. Drop it rather than poison the
  // read for every other role on the loan.
  return roles
    .map((r) => ({ role: r, encompassRole: names[r] ? String(names[r]) : null }))
    .filter((r) => r.encompassRole);
}

/**
 * The exact field ids to ask fieldReader for.
 *
 * Deduplicated, because a duplicate id answers `400 "Items in the collection should
 * be unique."` and loses the whole batch — two of our roles pointing at one
 * Encompass role name (a plausible settings state) would do exactly that.
 */
function fieldIdsFor(settings = {}) {
  const seen = new Set();
  const ids = [];
  for (const { encompassRole } of roleConfig(settings)) {
    for (const part of PARTS) {
      const id = `LoanTeamMember.${part}.${encompassRole}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Encompass leaves an unassigned slot as an empty string, not as an absent key. */
function clean(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

/**
 * fieldReader's answer → one contact per role.
 *
 * A role with NOTHING on it is omitted rather than stored empty: an empty row would
 * read on screen as "this loan has a closer" when it does not, and would make the
 * fill rates the plan is built on meaningless.
 */
function contactsFromFields(values, settings = {}) {
  const out = [];
  for (const { role, encompassRole } of roleConfig(settings)) {
    const get = (part) => clean(values ? values[`LoanTeamMember.${part}.${encompassRole}`] : null);
    const loginId = get('UserId');
    const name = get('Name');
    const email = match.normalizeEmail(get('Email')) || null;
    const phone = get('Phone');
    if (!loginId && !name && !email && !phone) continue;
    out.push({ role, encompassRole, loginId, name, email, phone });
  }
  return out;
}

/**
 * Attribute each contact to a PILOT person.
 *
 * ONLY a CONFIRMED link attributes. A suggestion is a machine's guess awaiting a
 * human, and letting one decide whose pipeline a file lands in would be the
 * auto-match deciding after all — the exact thing the owner's "admin confirms"
 * answer rules out. An unattributed contact still displays, by name.
 *
 * @param confirmedByLogin  Map<loginId, staffId> of CONFIRMED links only.
 */
function attribute(contacts, confirmedByLogin) {
  const byLogin = confirmedByLogin instanceof Map
    ? confirmedByLogin
    : new Map(Object.entries(confirmedByLogin || {}));
  return (contacts || []).map((c) => ({
    ...c,
    staffId: c.loginId ? (byLogin.get(c.loginId) || null) : null,
  }));
}

/**
 * What a screen shows for one contact: the PILOT person when we know them, the
 * Encompass name when we do not, and — always — a note when somebody here
 * reassigned it locally, so the file never silently disagrees with Encompass
 * without saying so.
 */
function describeContact(row, { staffName = null, overrideName = null, labels = {} } = {}) {
  const label = labels[row.role] || row.role;
  const overridden = !!row.override_staff_id;
  return {
    role: row.role,
    label,
    encompassName: row.encompass_name || null,
    encompassLoginId: row.encompass_login_id || null,
    email: row.encompass_email || null,
    phone: row.encompass_phone || null,
    staffId: row.staff_id ? String(row.staff_id) : null,
    staffName: staffName || null,
    overridden,
    overrideStaffId: row.override_staff_id ? String(row.override_staff_id) : null,
    overrideName: overrideName || null,
    overrideReason: row.override_reason || null,
    // The person this file actually belongs to, for anything that has to pick one.
    effectiveStaffId: row.override_staff_id ? String(row.override_staff_id)
      : (row.staff_id ? String(row.staff_id) : null),
    // Plain wording for the one state that surprises people.
    note: overridden
      ? 'Reassigned in PILOT. Encompass still names the person above; nothing was written back.'
      : (row.encompass_login_id && !row.staff_id
        ? 'This Encompass user is not linked to a PILOT person yet, so the file is not in their pipeline.'
        : null),
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Write one loan's contacts, inside the caller's transaction.
 *
 * THE OVERRIDE IS NEVER TOUCHED. The upsert lists every Encompass-sourced column
 * and deliberately omits `override_staff_id` / `override_by` / `override_at` /
 * `override_reason`, so a sync refreshing what Encompass says can never undo a
 * local reassignment. That is the whole reason they are separate columns.
 *
 * A role Encompass no longer names is REMOVED — an unassigned closer must stop
 * showing as the closer — but only when we actually read the loan (an empty read is
 * an outage, not "the team left").
 */
async function writeContacts(dbc, loanId, contacts) {
  if (!Array.isArray(contacts) || !contacts.length) return { written: 0, removed: 0 };
  for (const c of contacts) {
    await dbc.query(
      `INSERT INTO lt_loan_contacts
         (id, loan_id, role, encompass_name, encompass_email, encompass_phone,
          encompass_login_id, staff_id, encompass_synced_at, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::uuid, now(), now())
       ON CONFLICT (loan_id, role) DO UPDATE SET
         encompass_name = EXCLUDED.encompass_name,
         encompass_email = EXCLUDED.encompass_email,
         encompass_phone = EXCLUDED.encompass_phone,
         encompass_login_id = EXCLUDED.encompass_login_id,
         staff_id = EXCLUDED.staff_id,
         encompass_synced_at = now(),
         updated_at = now()`,
      [loanId, c.role, c.name, c.email, c.phone, c.loginId, c.staffId || null],
    );
  }
  const { rowCount } = await dbc.query(
    `DELETE FROM lt_loan_contacts
      WHERE loan_id = $1::uuid AND NOT (role = ANY($2::text[]))`,
    [loanId, contacts.map((c) => c.role)],
  );
  return { written: contacts.length, removed: rowCount || 0 };
}

/** Every confirmed link, as the login → staff map `attribute` wants. */
async function confirmedLinkMap(dbc) {
  const { rows } = await dbc.query(
    `SELECT encompass_login_id, staff_id FROM lt_staff_links
      WHERE status = 'confirmed' AND staff_id IS NOT NULL`,
  );
  return new Map(rows.map((r) => [r.encompass_login_id, String(r.staff_id)]));
}

/**
 * Read one loan's team from Encompass and mirror it. READ-ONLY.
 * Never throws for an ordinary failure — returns `{ok:false, reason}`.
 */
async function syncLoanContacts(loanId, encompassLoanGuid) {
  if (!lazy.client.configured()) {
    return { ok: false, reason: 'Encompass is not connected yet.' };
  }
  const { settings } = await lazy.settings.load();
  const ids = fieldIdsFor(settings);
  if (!ids.length) return { ok: false, reason: 'No loan-team roles are configured to read.' };

  let values;
  try {
    values = await lazy.client.fieldReader(encompassLoanGuid, ids);
  } catch (e) {
    return { ok: false, reason: `Could not read the loan team: ${(e && e.message) || e}` };
  }

  const dbc = await lazy.db.getClient();
  try {
    await dbc.query('BEGIN');
    const confirmed = await confirmedLinkMap(dbc);
    const contacts = attribute(contactsFromFields(values, settings), confirmed);
    const wrote = await writeContacts(dbc, loanId, contacts);
    await dbc.query('COMMIT');
    return {
      ok: true,
      ...wrote,
      attributed: contacts.filter((c) => c.staffId).length,
      unlinked: contacts.filter((c) => c.loginId && !c.staffId).length,
    };
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    return { ok: false, reason: `Could not save the loan team: ${(e && e.message) || e}` };
  } finally {
    dbc.release();
  }
}

/**
 * Re-attribute EVERY loan's contacts from the confirmed links, touching nothing
 * else. This is what makes confirming a link on the people screen retroactive: the
 * moment an admin says "this login is that person", every file that login is on
 * becomes theirs, with no Encompass call and no loan re-sync.
 *
 * Only ever fills or corrects `staff_id` from a CONFIRMED link, and never touches
 * an override.
 */
async function reattributeAll(dbc = lazy.db) {
  const { rowCount } = await dbc.query(
    `UPDATE lt_loan_contacts c
        SET staff_id = l.staff_id, updated_at = now()
       FROM lt_staff_links l
      WHERE l.encompass_login_id = c.encompass_login_id
        AND l.status = 'confirmed'
        AND l.staff_id IS NOT NULL
        AND c.staff_id IS DISTINCT FROM l.staff_id`,
  );
  // A link that was undone must stop attributing, or a file stays in the pipeline
  // of somebody the admin just unlinked.
  const { rowCount: cleared } = await dbc.query(
    `UPDATE lt_loan_contacts c
        SET staff_id = NULL, updated_at = now()
      WHERE c.staff_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM lt_staff_links l
           WHERE l.encompass_login_id = c.encompass_login_id
             AND l.status = 'confirmed'
             AND l.staff_id = c.staff_id
        )`,
  );
  return { attributed: rowCount || 0, cleared: cleared || 0 };
}

/**
 * Reassign a file locally. PILOT-side only — nothing is written to Encompass.
 * Passing a null staff id CLEARS the override, which is how "actually, Encompass
 * was right" is expressed.
 *
 * Takes the repo's usual optional trailing `client` so a caller can reassign inside
 * a transaction — a reassignment that has to happen together with something else
 * (or not at all) would otherwise be forced onto its own connection, and the
 * database would be left half-changed if the other half failed.
 */
async function setOverride(loanId, role, staffId, actorId, reason, dbc = null) {
  const conn = dbc || lazy.db;
  const { rows } = await conn.query(
    `UPDATE lt_loan_contacts
        SET override_staff_id = $3::uuid,
            override_by = CASE WHEN $3::uuid IS NULL THEN NULL ELSE $4::uuid END,
            override_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,
            override_reason = CASE WHEN $3::uuid IS NULL THEN NULL ELSE $5 END,
            updated_at = now()
      WHERE loan_id = $1::uuid AND role = $2
      RETURNING *`,
    [loanId, String(role || ''), staffId || null, actorId || null, reason || null],
  );
  return rows[0] || null;
}

module.exports = {
  PARTS,
  DEFAULT_ROLES,
  DEFAULT_ENCOMPASS_ROLE_NAMES,
  roleConfig,
  fieldIdsFor,
  contactsFromFields,
  attribute,
  describeContact,
  writeContacts,
  confirmedLinkMap,
  syncLoanContacts,
  reattributeAll,
  setOverride,
  _internals: { clean },
};
