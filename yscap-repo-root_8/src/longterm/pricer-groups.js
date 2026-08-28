'use strict';
/**
 * LONG-TERM — the Pricing Engine's saved INVESTOR GROUPS (db/634,
 * owner-directed 2026-08-27).
 *
 * The owner: *"every user should be able to set up by themselves groups. They
 * only want to search this three investors … name every group differently so
 * they can set over there they can price a certain group of investors."*
 *
 * A group is a NAMED SET OF CANONICAL INVESTOR KEYS, and that is all it is. It
 * follows `views.js` (the saved pipeline views) deliberately — a named per-user
 * arrangement is a row, never a code change — with two differences, both the
 * owner's: a group is PERSONAL ONLY (no shared form — "every user … by
 * themselves"), and what it stores is investor KEYS, validated against the
 * white-label sheet (`lenderprice/investor-programs.js`) so a stored group can
 * never carry a spelling that rots or a key nobody can display.
 *
 * ⛔ A GROUP IS A DISPLAY OVERLAY, NEVER A SEARCH INPUT. Nothing here — and
 * nothing that reads a group — may ever narrow what is asked of Lender Price:
 * the vendor is always asked for everything and the board hides the rest
 * (owner: "You should just hide the rest of the data that you're getting and
 * only display the data that the person wants to see"). This module only
 * stores and lists; the overlay lives on the screen.
 *
 * SEPARATION: reads and writes only `lt_pricer_investor_groups` (plus the
 * authorised `staff_users` FK). No RTL table, no RTL import.
 */

const lazy = {
  get db() { return require('./db'); },
};

const programs = require('./lenderprice/investor-programs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A name a person will recognise in a picker, and nothing longer. */
function sanitizeName(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, 80);
}

/**
 * Keep only canonical keys the white-label sheet knows. Returns
 * `{investors, dropped}` — `dropped` NAMES what was refused, because a group
 * silently missing an investor is a group that quietly prices the wrong set.
 * De-duplicated, order kept (a person arranged them).
 */
function sanitizeInvestors(raw) {
  const out = [];
  const dropped = [];
  const seen = new Set();
  for (const v of Array.isArray(raw) ? raw : []) {
    const k = String(v == null ? '' : v).trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    if (programs.whiteLabelOf(k) === null) { dropped.push(k); continue; }
    seen.add(k);
    out.push(k);
  }
  return { investors: out, dropped };
}

/**
 * This person's groups, oldest arrangement first. Stored keys are re-validated
 * on the way out: a key the sheet no longer carries is reported as stale rather
 * than silently applied or silently dropped.
 */
async function listGroups(staffId, dbc = null) {
  if (!staffId) return [];
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    `SELECT id, name, investors, sort_order
       FROM lt_pricer_investor_groups
      WHERE staff_id = $1::uuid
      ORDER BY sort_order, name`,
    [String(staffId)],
  );
  return rows.map((r) => {
    const { investors, dropped } = sanitizeInvestors(r.investors);
    return {
      id: r.id,
      name: r.name,
      investors,
      sortOrder: r.sort_order,
      staleInvestors: dropped.length ? dropped : null,
    };
  });
}

/**
 * Save a group — create, or UPDATE the group of the same name (the unique
 * index on (staff_id, lower(name)) is the contract: one name, one group, and a
 * re-save is an edit rather than a twin a person cannot tell apart).
 *
 * Returns `{ok:false, reason}` for anything a person can fix, never a throw
 * for those. An EMPTY set is refused: a group of nobody would filter the board
 * to nothing and read as broken.
 */
async function saveGroup({ staffId, name, investors }) {
  if (!staffId) return { ok: false, reason: 'A group needs a signed-in person.' };
  const cleanName = sanitizeName(name);
  if (!cleanName) return { ok: false, reason: 'Give the group a name.' };
  const { investors: clean, dropped } = sanitizeInvestors(investors);
  if (!clean.length) {
    return { ok: false, reason: 'Pick at least one investor for the group.' };
  }
  const { rows } = await lazy.db.query(
    `INSERT INTO lt_pricer_investor_groups (id, staff_id, name, investors)
          VALUES (gen_random_uuid(), $1::uuid, $2, $3::jsonb)
     ON CONFLICT (staff_id, lower(name))
       DO UPDATE SET name = EXCLUDED.name, investors = EXCLUDED.investors, updated_at = now()
     RETURNING id, name`,
    [String(staffId), cleanName, JSON.stringify(clean)],
  );
  return { ok: true, id: rows[0].id, name: rows[0].name, investors: clean, dropped: dropped.length ? dropped : null };
}

/** Remove a group. Only its owner's — the WHERE is the whole authorisation. */
async function deleteGroup(id, staffId) {
  if (!staffId || !UUID_RE.test(String(id || ''))) return { ok: false };
  const { rowCount } = await lazy.db.query(
    'DELETE FROM lt_pricer_investor_groups WHERE id = $1::uuid AND staff_id = $2::uuid',
    [String(id), String(staffId)],
  );
  return { ok: rowCount > 0 };
}

module.exports = { listGroups, saveGroup, deleteGroup, _internals: { sanitizeName, sanitizeInvestors } };
