'use strict';
/**
 * LONG-TERM — the people map: pull the Encompass roster, propose the links.
 *
 * Phase 1 of the build order. It ships BEFORE the pipeline for a reason recorded
 * in access.js: an officer's scope is `own`, `own` resolves through the contact
 * map, and the contact map resolves through these links — so an unmapped officer
 * sees an EMPTY pipeline, not everything. Building the pipeline first would mean
 * shipping a screen that is silently blank for most of the company.
 *
 * WHAT THIS DOES, AND THE LINE IT WILL NOT CROSS.
 *
 *   · READS `/encompass/v1/company/users` — the roster — and mirrors it into
 *     `lt_encompass_users`. Nothing is written to Encompass, ever; the client
 *     itself refuses any non-GET outside its two allow-listed read-shaped POSTs.
 *   · SUGGESTS a PILOT person for each Encompass user (match.js, pure).
 *   · A HUMAN CONFIRMS. Nothing here sets a link to `confirmed`.
 *
 * THREE RULES THAT ARE ABOUT SAFETY, NOT TIDINESS:
 *
 *   1. **A decided link is never touched.** `confirmed` and `rejected` both mean a
 *      person answered. Re-proposing a rejection every sync is how a review screen
 *      becomes noise people click past — the exact failure the RTL finding-decisions
 *      ledger was built to fix. The upsert's WHERE clause is what enforces it.
 *   2. **A user who disappears from Encompass is DEACTIVATED, never deleted.** Their
 *      login id is on historical loans; deleting the row would orphan every contact
 *      that names them.
 *   3. **The sync degrades, it does not half-apply.** The roster write and the
 *      suggestion write are one transaction, so a failure mid-way leaves the map as
 *      it was rather than mirrored-but-unproposed.
 *
 * SEPARATION: writes only `lt_*`; READS `staff_users` (authorized in writing
 * 2026-08-03, `sql-read staff_users` in docs/LONG-TERM-AUTHORIZED-COPIES.md) to
 * find the person an Encompass login belongs to.
 */

// `match` is pure and loads anywhere. The database pool, the Encompass client and
// the settings store are required LAZILY — the same shape term-sheet-stamp.js uses
// on the RTL side — so that reading this module (for `toRosterRow`, the roster
// path, the caps) never opens a pool or needs a driver on disk. That is what lets
// the whole shape of the roster read be unit-tested with no Postgres in reach.
const match = require('./match');
const lazy = {
  get db() { return require('../db'); },
  get client() { return require('../encompass/client'); },
  get settings() { return require('../settings/store'); },
};

const USERS_PATH = '/encompass/v1/company/users';
const PAGE = 200;
// The live tenant has 46 users. The cap is a runaway guard, not a limit anyone is
// expected to reach; hitting it is reported rather than silently truncating.
const MAX_PAGES = 25;

/** Encompass's user shape → our row. Tolerant: the tenant's payload is not a contract. */
function toRosterRow(u) {
  const loginId = String((u && (u.id || u.userId || u.loginId)) || '').trim();
  if (!loginId) return null;
  const personas = Array.isArray(u.personas)
    ? u.personas.map((p) => String((p && (p.entityName || p.name)) || p || '')).filter(Boolean)
    : [];
  const roles = Array.isArray(u.roles)
    ? u.roles.map((r) => String((r && (r.entityName || r.name)) || r || '')).filter(Boolean)
    : [];
  const indicators = Array.isArray(u.userIndicators) ? u.userIndicators.map(String) : [];
  return {
    login_id: loginId,
    // Encompass's own fullName carries double and trailing spaces — squash them on
    // the way in so every screen does not have to.
    full_name: String(u.fullName || u.name || '').trim().replace(/\s+/g, ' ') || null,
    email: match.normalizeEmail(u.email) || null,
    phone: String(u.phone || u.workPhone || '').trim() || null,
    personas,
    role_names: roles,
    // `Enabled` is the tenant's own word for an active login. Absent indicators are
    // read as active: a roster we cannot read the flag from must not silently
    // deactivate the whole company.
    is_active: indicators.length ? indicators.includes('Enabled') : true,
  };
}

/**
 * Read the whole roster from Encompass. READ-ONLY.
 * Returns `{users, pages, truncated}` — `truncated` is true when the cap was hit,
 * so a caller can say so rather than report a short roster as complete.
 */
async function fetchRoster() {
  const users = [];
  let start = 0;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (pages >= MAX_PAGES) { truncated = true; break; }
    const body = await lazy.client.apiGet(`${USERS_PATH}?limit=${PAGE}&start=${start}`);
    const batch = Array.isArray(body) ? body : (body && Array.isArray(body.users) ? body.users : []);
    pages += 1;
    for (const u of batch) {
      const row = toRosterRow(u);
      if (row) users.push(row);
    }
    if (batch.length < PAGE) break;
    start += batch.length;
  }

  // The same login twice in one read would make the upsert's ON CONFLICT fire
  // against a row inserted in the same statement, which Postgres refuses outright
  // ("cannot affect row a second time"). Last one wins; the roster is a set.
  const byId = new Map();
  for (const u of users) byId.set(u.login_id, u);
  return { users: [...byId.values()], pages, truncated };
}

/** Mirror the roster into lt_encompass_users, inside the caller's transaction. */
async function writeRoster(dbc, users) {
  const seen = [];
  for (const u of users) {
    await dbc.query(
      `INSERT INTO lt_encompass_users
         (login_id, full_name, email, phone, personas, role_names, is_active, encompass_synced_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now())
       ON CONFLICT (login_id) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         personas = EXCLUDED.personas,
         role_names = EXCLUDED.role_names,
         is_active = EXCLUDED.is_active,
         encompass_synced_at = now(),
         updated_at = now()`,
      [u.login_id, u.full_name, u.email, u.phone, u.personas, u.role_names, u.is_active],
    );
    seen.push(u.login_id);
  }

  // Gone from Encompass → deactivated here, never deleted (rule 2). Only ever run
  // against a roster we actually read: an empty read is an outage, and treating it
  // as "everyone left" would deactivate the whole company.
  let deactivated = 0;
  if (seen.length) {
    const { rowCount } = await dbc.query(
      `UPDATE lt_encompass_users
          SET is_active = false, updated_at = now()
        WHERE is_active = true AND NOT (login_id = ANY($1::text[]))`,
      [seen],
    );
    deactivated = rowCount || 0;
  }
  return { written: seen.length, deactivated };
}

/**
 * Write the proposals. Only ever INSERTs a link that does not exist, or refreshes
 * one that is still `suggested` — a decided row is untouched (rule 1).
 */
async function writeSuggestions(dbc, suggestions) {
  let proposed = 0;
  for (const s of suggestions) {
    const { rowCount } = await dbc.query(
      `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status, match_method, updated_at)
            VALUES ($1, $2::uuid, 'suggested', $3, now())
       ON CONFLICT (encompass_login_id) DO UPDATE SET
              staff_id = EXCLUDED.staff_id,
              match_method = EXCLUDED.match_method,
              updated_at = now()
        WHERE lt_staff_links.status = 'suggested'
          AND lt_staff_links.staff_id IS DISTINCT FROM EXCLUDED.staff_id`,
      [s.loginId, s.staffId, s.method],
    );
    if (rowCount) proposed += 1;
  }
  return proposed;
}

/**
 * The PILOT people a link may point at. Reads the shared identity zone only.
 *
 * `staff_users.full_name` is ONE column and is NOT NULL — it is the BORROWERS table
 * that splits a person into first/middle/last. Composing a name from first_name
 * here would reference columns that do not exist on this table, and because the
 * caller wraps the pass in a catch it would report a confident empty roster
 * forever rather than an error. Verified against db/schema.sql.
 *
 * EXTERNAL accounts are excluded: a TPO broker is a `staff_users` row with
 * `is_external=true`, and a broker must never be linkable to an Encompass login
 * (that would hand an outside firm a long-term pipeline).
 */
async function loadStaff(dbc) {
  const { rows } = await dbc.query(
    `SELECT id, email, role, is_active, full_name
       FROM staff_users
      WHERE COALESCE(is_external, false) = false`,
  );
  return rows;
}

/**
 * The whole pass: read Encompass, mirror the roster, propose the links.
 * Never throws for an ordinary failure — returns `{ok:false, reason}` so a screen
 * can say what happened.
 */
async function syncRoster() {
  if (!lazy.client.configured()) {
    return { ok: false, reason: 'Encompass is not connected yet — add the long-term Encompass credentials first.' };
  }

  let roster;
  try {
    roster = await fetchRoster();
  } catch (e) {
    return { ok: false, reason: `Could not read the Encompass roster: ${(e && e.message) || e}` };
  }
  if (!roster.users.length) {
    // Never write an empty roster: see the deactivation guard above.
    return { ok: false, reason: 'Encompass returned no users, so nothing was changed.' };
  }

  const { settings } = await lazy.settings.load();

  const dbc = await lazy.db.getClient();
  try {
    await dbc.query('BEGIN');
    const wrote = await writeRoster(dbc, roster.users);
    const staff = await loadStaff(dbc);
    const { rows: existing } = await dbc.query('SELECT * FROM lt_staff_links');
    const proposal = match.matchRoster(roster.users, staff, { existing, settings });
    const proposed = await writeSuggestions(dbc, proposal.suggestions);
    await dbc.query('COMMIT');
    return {
      ok: true,
      users: wrote.written,
      deactivated: wrote.deactivated,
      suggested: proposal.suggestions.length,
      proposedNow: proposed,
      unmatched: proposal.unmatched.length,
      truncated: roster.truncated,
    };
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    return { ok: false, reason: `Could not save the people map: ${(e && e.message) || e}` };
  } finally {
    dbc.release();
  }
}

/**
 * Everything the admin screen shows: every Encompass user, its link, the PILOT
 * person it points at, and — for a row with no link — why not.
 */
async function listPeople() {
  const { settings } = await lazy.settings.load();
  const [{ rows: users }, { rows: links }, staff] = await Promise.all([
    lazy.db.query('SELECT * FROM lt_encompass_users ORDER BY is_active DESC, lower(COALESCE(full_name, login_id))'),
    lazy.db.query('SELECT * FROM lt_staff_links'),
    loadStaff(lazy.db),
  ]);

  const linkBy = new Map(links.map((l) => [l.encompass_login_id, l]));
  const staffBy = new Map(staff.map((s) => [String(s.id), s]));
  const { unmatched } = match.matchRoster(users, staff, { existing: links, settings });
  const reasonBy = new Map(unmatched.map((u) => [u.loginId, u.reason]));

  const people = users.map((u) => {
    const link = linkBy.get(u.login_id) || null;
    const person = link && link.staff_id ? staffBy.get(String(link.staff_id)) : null;
    return {
      loginId: u.login_id,
      name: u.full_name,
      email: u.email,
      personas: u.personas || [],
      active: u.is_active,
      syncedAt: u.encompass_synced_at,
      // WHAT THIS PERSON DOES IN ENCOMPASS. The roster writes `personas` and
      // `role_names` on every sync and nothing read the roles at all — yet they are
      // the evidence somebody confirming a link is meant to weigh: "is this
      // Nussbaum the loan officer or the closer?" is answered by the roles, and
      // without them a reviewer is matching on a name alone.
      roles: Array.isArray(u.role_names) ? u.role_names : [],
      status: link ? link.status : 'none',
      matchMethod: link ? link.match_method : null,
      confirmedAt: link ? link.confirmed_at : null,
      // WHO CONFIRMED IT. Written by both link writers since the day they shipped,
      // read by nothing — and confirming a link decides whose pipeline this
      // person's files land in, so it is the same kind of record as the file
      // reassignment. Resolved from the roster's OWN staff list, which is already
      // loaded, so this costs no query; an id we cannot name (somebody since
      // removed) travels as the id rather than as a blank.
      confirmedBy: link && link.confirmed_by ? String(link.confirmed_by) : null,
      confirmedByName: link && link.confirmed_by
        ? (staffBy.get(String(link.confirmed_by)) ? match.staffName(staffBy.get(String(link.confirmed_by))) : null)
        : null,
      staff: person
        ? { id: String(person.id), name: match.staffName(person), email: person.email, role: person.role }
        : null,
      // Only meaningful on a row with no proposal; a linked row carries null.
      whyNoMatch: link && link.staff_id ? null : (reasonBy.get(u.login_id) || null),
    };
  });

  const counts = people.reduce((acc, p) => {
    acc[p.status] = (acc[p.status] || 0) + 1;
    return acc;
  }, {});

  return {
    people,
    counts,
    total: people.length,
    // The pickable people, so the screen can offer a manual link without a second call.
    staff: pickableFrom(staff),
  };
}

/**
 * The PILOT people a screen may offer to pick from. PURE.
 *
 * ONE definition, because two screens now ask the same question — the People screen
 * offering a manual link, and the loan workspace offering to reassign a file — and
 * "who may be picked" is exactly the sort of list that grows a second copy and then
 * disagrees with itself. `loadStaff` has already excluded external accounts (a TPO
 * broker must never be offered a long-term file); this drops the deactivated, who
 * would route a file to nobody while looking on screen like a real assignment.
 */
function pickableFrom(staff) {
  return (staff || [])
    .filter((s) => s.is_active !== false)
    .map((s) => ({ id: String(s.id), name: match.staffName(s), email: s.email, role: s.role }));
}

/** The same list, for a caller that wants only it and not the whole roster. */
async function pickableStaff(dbc = lazy.db) {
  return pickableFrom(await loadStaff(dbc));
}

module.exports = {
  USERS_PATH,
  toRosterRow,
  fetchRoster,
  syncRoster,
  listPeople,
  pickableStaff,
  _internals: { writeRoster, writeSuggestions, loadStaff, MAX_PAGES, PAGE },
};
