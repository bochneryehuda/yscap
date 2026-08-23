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

/**
 * The role key that means "this is the loan officer".
 *
 * Named once because three different questions turn on it and they must give the
 * same answer: the pipeline's officer filter, the owner's census column, and the
 * roster's "an officer with an empty book". A string typed in three places is a
 * string somebody eventually renames in two.
 */
const OFFICER_ROLE = 'loan_officer';

const DEFAULT_ROLES = [OFFICER_ROLE, 'processor', 'underwriter', 'closer', 'funder', 'post_closer'];

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
function describeContact(row, { staffName = null, overrideName = null, overrideByName = null, labels = {} } = {}) {
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
    // WHO DID IT AND WHEN — the other two thirds of the record `reassign` writes.
    // All three columns were written together and only the reason was ever read, so
    // a screen could say a file had been reassigned and why, and never by whom. On
    // an action that GRANTS SOMEBODY ACCESS to a file (`access.onFileSql` matches
    // `override_staff_id`) those are the two facts a reviewer actually needs, and
    // Long-Term writes nothing to `audit_log` — an RTL table — so this row is the
    // only place they exist.
    //
    // The name is resolved by the caller from the same map it already builds for
    // the other two people on the row; a person since deleted leaves the id, which
    // is why the id travels too rather than only a name that might be blank.
    overrideBy: row.override_by ? String(row.override_by) : null,
    overrideByName: overrideByName || null,
    overrideAt: row.override_at || null,
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
 *
 * `opts.values` lets a caller that has ALREADY read this loan's fields hand them
 * over instead of paying for a second fieldReader. The loan sync does exactly that:
 * it asks for the team's field ids and the lock's in ONE call, because the pacing
 * rule on this tenant is a self-imposed gap between calls — halving the calls per
 * loan halves how long a pass holds the shared connection. With nothing supplied
 * this reads for itself, so the standalone path is unchanged.
 */
async function syncLoanContacts(loanId, encompassLoanGuid, opts = {}) {
  if (!lazy.client.configured()) {
    return { ok: false, reason: 'Encompass is not connected yet.' };
  }
  const { settings } = await lazy.settings.load();
  const ids = fieldIdsFor(settings);
  if (!ids.length) return { ok: false, reason: 'No loan-team roles are configured to read.' };

  let values = opts.values || null;
  if (!values) {
    try {
      values = await lazy.client.fieldReader(encompassLoanGuid, ids);
    } catch (e) {
      return { ok: false, reason: `Could not read the loan team: ${(e && e.message) || e}` };
    }
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

/** Same shape links.js uses, so one `fail()` in the router turns either module's
 *  refusal into its own status and its own sentence. */
function refuse(status, message) {
  const e = new Error(message);
  e.status = status;
  e.plain = message;
  return e;
}

/**
 * What is wrong with a reassignment REQUEST, before any database is asked. PURE.
 *
 * Split out from `reassign` because these are the refusals that do not depend on
 * the state of the book, and a rule nobody can test without a Postgres is a rule
 * that gets tested less often than it should be.
 *
 * CLEARING IS A DIFFERENT REQUEST FROM SETTING, and the asymmetry is deliberate:
 *
 *   · Setting one REQUIRES A REASON. The plan's own override rule (§2.3) is that an
 *     override is "always visibly stamped as an override — who set it, when, and
 *     why". The screen shows that sentence to the next person who opens the file and
 *     wonders why Encompass names somebody else; an unexplained reassignment is the
 *     silent divergence the rule exists to prevent, so the reason is part of the
 *     record and not a nicety. A few spaces is not a reason.
 *   · Clearing one needs neither a person nor a reason. It is how "actually,
 *     Encompass was right" is said, and demanding an explanation for undoing a
 *     mistake is how a wrong override survives.
 */
const MIN_REASON = 4;

function reassignProblem({ role, staffId, reason } = {}) {
  if (!String(role || '').trim()) return refuse(400, 'Which role on this file? None was named.');
  // No person named = a clear, which is a legitimate request and asks for nothing else.
  if (!String(staffId || '').trim()) return null;
  if (String(reason || '').trim().length < MIN_REASON) {
    return refuse(400, 'Say briefly why this file is being reassigned. It is shown on the file so the next person knows why it does not match Encompass.');
  }
  return null;
}

/**
 * Reassign one role on one file to a PILOT person — or clear the reassignment.
 *
 * The guarded orchestration over `setOverride`, which is the raw writer and stays
 * that way (the sync's own paths have no business running these checks).
 *
 * Every check answers a question a bad reassignment would leave unanswered, and the
 * two that matter most are the two `links.confirmLink` already learned:
 *
 *   · THE PERSON MUST BE INTERNAL. A TPO broker is a `staff_users` row with
 *     `is_external = true`, and an override is matched by the pipeline scope — so
 *     naming one here would put an outside brokerage's account on a long-term file
 *     and in its pipeline. This is the standing repo-wide rule that every internal
 *     roster query excludes external accounts, and it is load-bearing here rather
 *     than tidy.
 *   · THE PERSON MUST BE ACTIVE. Handing a file to a deactivated account routes it
 *     to nobody while looking, on screen, exactly like it was routed to somebody.
 *
 * ENCOMPASS IS NOT TOLD. Nothing here writes anything anywhere near Encompass — the
 * override is a PILOT-side routing decision, never a correction to the system of
 * record (§2.3 rule 5), and Encompass's own columns are left exactly as they are so
 * the screen can keep showing both sides.
 *
 * THE OVERRIDE COLUMNS ARE THE RECORD. `override_by` / `override_at` /
 * `override_reason` are written together with the person, so who did this, when and
 * why survives on the row itself. Nothing is written to `audit_log`: that is an RTL
 * table, and Long-Term does not touch one without a per-item entry in the
 * authorisation ledger.
 */
async function reassign(loanId, role, staffId, actorId, reason, client = null) {
  const problem = reassignProblem({ role, staffId, reason });
  if (problem) throw problem;

  const wanted = String(staffId || '').trim();
  // The repo's usual optional trailing client: a caller already inside a transaction
  // runs there (and owns the BEGIN/COMMIT), and only a caller with none takes a
  // connection and owns the transaction itself. Without it a reassignment that has
  // to happen together with something else would be forced onto its own connection,
  // and could not see — or be rolled back with — the caller's own work.
  const own = !client;
  const dbc = client || await lazy.db.getClient();
  try {
    if (own) await dbc.query('BEGIN');

    const { rows: loans } = await dbc.query('SELECT id FROM lt_loans WHERE id = $1::uuid', [String(loanId || '')]);
    if (!loans.length) throw refuse(404, 'No such long-term loan.');

    if (wanted) {
      const { rows: people } = await dbc.query(
        `SELECT id, is_active, COALESCE(is_external, false) AS is_external
           FROM staff_users WHERE id = $1::uuid`,
        [wanted],
      );
      if (!people.length) throw refuse(404, 'That PILOT person does not exist.');
      if (people[0].is_external) {
        throw refuse(400, 'That account is an outside broker, not a member of staff, so a long-term file cannot be assigned to them.');
      }
      if (people[0].is_active === false) {
        throw refuse(400, 'That PILOT person is deactivated, so the file would be assigned to nobody. Reactivate them first, or pick somebody else.');
      }
    }

    const row = await setOverride(loanId, role, wanted || null, actorId, reason, dbc);
    if (!row) {
      // The UPDATE matched nothing, which on an existing loan means the role is not
      // on this file. Said in words rather than answered with a silent success —
      // "saved" on a role that does not exist is the confident-empty this side keeps
      // finding.
      throw refuse(404, 'That role is not on this file, so there is nothing to reassign.');
    }

    if (own) await dbc.query('COMMIT');
    return row;
  } catch (e) {
    // Only ever unwind OUR OWN transaction. A bare ROLLBACK on a caller's client
    // would throw away work this function never knew about — the refusals above are
    // ordinary answers, not a reason to discard somebody else's transaction.
    if (own) await dbc.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (own) dbc.release();
  }
}

module.exports = {
  PARTS,
  OFFICER_ROLE,
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
  reassign,
  reassignProblem,
  MIN_REASON,
  _internals: { clean, refuse },
};
