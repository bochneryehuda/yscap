'use strict';
/**
 * LONG-TERM — saved pipeline views.
 *
 * A view is a NAMED SET OF FILTERS, and that is all it is. The table has existed
 * since db/553 with nothing writing to it; this is the code.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE SECURITY PROPERTY, and the whole reason this file is short:
 *
 *   A VIEW CAN ONLY EVER NARROW. It carries no scope of its own.
 *
 * Who may see which loans is decided by `access.pipelineScopeSql` from the SIGNED-IN
 * person, inside `buildPipelineQuery`, every time — a saved view's filters are
 * appended to that, never substituted for it. So a shared view built by an admin who
 * sees everything shows an officer only their own book, and a view saved by one
 * officer and opened by another cannot reveal a single row the second officer could
 * not already open. This is what makes a SHARED view safe to offer at all, and it is
 * a property of where the scope is applied rather than of anything checked here.
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE FILTERS ARE SANITISED ON THE WAY IN **AND** ON THE WAY OUT. On the way in
 * because a key nobody declared is either ignored — leaving a view that does not do
 * what its name says, which is worse than a refusal — or, one careless change later,
 * interpolated. On the way OUT because a view saved a year ago may carry a filter
 * this build no longer honours, and a stored row must never be trusted more than a
 * request body.
 *
 * SEPARATION: reads and writes only `lt_*` (plus the authorised `staff_users` FK).
 */

const lazy = {
  get db() { return require('./db'); },
};

/**
 * Every filter a view may carry, and how each is cleaned.
 *
 * Deliberately the SAME set `buildPipelineQuery` reads, and no more. A key here that
 * the query does not honour is a promise the screen cannot keep, so
 * `test-lt-views-pure.js` compares the two lists and fails when they drift.
 */
const FILTER_KEYS = {
  stage: (v) => str(v),
  folder: (v) => str(v),
  search: (v) => str(v),
  officerStaffId: (v) => uuid(v),
  unassigned: (v) => (v === true || v === 'true' ? true : null),
  // `mine` is stored as a FLAG, never as a staff id, and that is what makes a SHARED
  // view of it behave sensibly: it resolves against whoever is looking, so "Mine, at
  // underwriting" is one view the whole desk can use rather than a saved pointer at
  // one person's queue. It is also why nobody can save a view of somebody else's
  // personal book — `officerStaffId` is the deliberate, named way to look at that.
  mine: (v) => (v === true || v === 'true' ? true : null),
  sort: (v) => str(v),
  dir: (v) => (String(v).toLowerCase() === 'asc' ? 'asc' : String(v).toLowerCase() === 'desc' ? 'desc' : null),
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  // A filter is a short token or a search phrase; anything longer is a mistake or an
  // attempt, and either way it is not stored.
  return s === '' || s.length > 200 ? null : s;
}
function uuid(v) {
  const s = str(v);
  return s && UUID_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * Keep only what this build honours. Returns `{filters, dropped}` — `dropped` NAMES
 * what was thrown away, because a view silently missing half its filters is a view
 * that quietly shows the wrong book.
 */
function sanitizeFilters(raw) {
  const filters = {};
  const dropped = [];
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    const clean = FILTER_KEYS[k];
    if (!clean) { dropped.push(k); continue; }
    const out = clean(v);
    if (out === null || out === undefined) { dropped.push(k); continue; }
    filters[k] = out;
  }
  return { filters, dropped };
}

/** A name a person will recognise in a list, and nothing longer. */
function sanitizeName(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, 80);
}

/**
 * The views one person may use: their own, plus the SHARED ones (`staff_id IS NULL`).
 *
 * Ordered shared-last so somebody's own arrangement is what they see first. Every
 * stored filter set is re-sanitised on the way out.
 */
async function listViews(staffId, dbc = null) {
  const q = dbc || lazy.db;
  const { rows } = await q.query(
    `SELECT id, staff_id, name, filters, is_default, sort_order
       FROM lt_pipeline_views
      WHERE staff_id = $1::uuid OR staff_id IS NULL
      ORDER BY (staff_id IS NULL), sort_order, name`,
    [staffId || null],
  );
  return rows.map((r) => {
    const { filters, dropped } = sanitizeFilters(r.filters);
    return {
      id: r.id,
      name: r.name,
      shared: r.staff_id === null,
      mine: r.staff_id !== null && String(r.staff_id) === String(staffId || ''),
      isDefault: r.is_default === true,
      sortOrder: r.sort_order,
      filters,
      // A view written by an older build may carry a filter this one no longer
      // honours. Saying so beats showing a book that quietly disagrees with the name.
      staleFilters: dropped.length ? dropped : null,
    };
  });
}

/**
 * Save a view. A SHARED view (`shared: true`) is an administrator's decision — the
 * caller decides that; this module refuses to guess, so `shared` must be passed
 * explicitly and the route is what gates it.
 *
 * Returns `{ok:false, reason}` for anything a person can fix, never a throw.
 */
async function saveView({ staffId, name, filters, shared = false, isDefault = false, id = null }) {
  const cleanName = sanitizeName(name);
  if (!cleanName) return { ok: false, reason: 'Give the view a name.' };
  if (!shared && !staffId) return { ok: false, reason: 'A personal view needs a signed-in person.' };

  const { filters: clean, dropped } = sanitizeFilters(filters);
  const owner = shared ? null : String(staffId);

  const dbc = await lazy.db.getClient();
  try {
    await dbc.query('BEGIN');

    // One default per person, enforced by a partial unique index — so the old one is
    // cleared in the SAME transaction rather than left to collide.
    if (isDefault && owner) {
      await dbc.query(
        'UPDATE lt_pipeline_views SET is_default = false, updated_at = now() WHERE staff_id = $1::uuid AND is_default',
        [owner],
      );
    }

    let row;
    if (id) {
      // A person may only edit their OWN view; a shared one is edited by whoever the
      // route allowed in, which is why the ownership test is on the staff column and
      // not on a role read here.
      const { rows } = await dbc.query(
        `UPDATE lt_pipeline_views
            SET name = $3, filters = $4::jsonb, is_default = $5, updated_at = now()
          WHERE id = $1::uuid AND staff_id IS NOT DISTINCT FROM $2::uuid
        RETURNING id`,
        [id, owner, cleanName, JSON.stringify(clean), !!(isDefault && owner)],
      );
      if (!rows.length) { await dbc.query('ROLLBACK'); return { ok: false, reason: 'That view is not yours to change.' }; }
      row = rows[0];
    } else {
      const { rows } = await dbc.query(
        `INSERT INTO lt_pipeline_views (id, staff_id, name, filters, is_default)
              VALUES (gen_random_uuid(), $1::uuid, $2, $3::jsonb, $4) RETURNING id`,
        [owner, cleanName, JSON.stringify(clean), !!(isDefault && owner)],
      );
      row = rows[0];
    }

    await dbc.query('COMMIT');
    return { ok: true, id: row.id, filters: clean, dropped: dropped.length ? dropped : null };
  } catch (e) {
    try { await dbc.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    return { ok: false, reason: String((e && e.message) || e).slice(0, 300) };
  } finally {
    dbc.release();
  }
}

/** Remove a view. A shared one is only removable by a caller the route let through. */
async function deleteView(id, staffId, { allowShared = false } = {}) {
  const where = allowShared
    ? 'id = $1::uuid AND (staff_id IS NULL OR staff_id = $2::uuid)'
    : 'id = $1::uuid AND staff_id = $2::uuid';
  const { rowCount } = await lazy.db.query(
    `DELETE FROM lt_pipeline_views WHERE ${where}`, [id, staffId || null],
  );
  return { ok: rowCount > 0, removed: rowCount || 0 };
}

/** The view a person opens on, if they set one. */
async function defaultView(staffId) {
  if (!staffId) return null;
  const { rows } = await lazy.db.query(
    'SELECT id, name, filters FROM lt_pipeline_views WHERE staff_id = $1::uuid AND is_default LIMIT 1',
    [staffId],
  );
  if (!rows.length) return null;
  const { filters } = sanitizeFilters(rows[0].filters);
  return { id: rows[0].id, name: rows[0].name, filters };
}

module.exports = {
  FILTER_KEYS,
  sanitizeFilters,
  sanitizeName,
  listViews,
  saveView,
  deleteView,
  defaultView,
};
