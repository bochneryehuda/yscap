'use strict';
/**
 * LONG-TERM — the tenant's MILESTONE CATALOG, read from Encompass instead of frozen.
 *
 * WHY THIS EXISTS. `lt_encompass_milestones` is the list of steps a long-term loan
 * moves through, and it has only ever been a PHOTOGRAPH: db/547 seeded it from an
 * export taken on 2026-08-14 and re-asserts those nineteen rows on every boot. The
 * read-only client has carried the verified call since it was written and nothing
 * has ever used it.
 *
 * A stale reference list is usually a small thing. This one is not, because the
 * file screen's stepper marks progress POSITIONALLY: a loan sitting at a milestone
 * the catalog does not carry leaves the current position at -1 and marks NOTHING
 * reached — so the whole progress bar goes blank rather than slightly wrong. The
 * day a buyer adds a step, or renames one, every file at that step loses its
 * stepper and nothing anywhere says why.
 *
 * NOTHING IS EVER DELETED. A milestone that disappears from Encompass is ARCHIVED,
 * because loans passed through it and a retired step still has to explain them.
 * That is the same rule the condition and eFolder mirrors follow.
 *
 * IT REFUSES RATHER THAN GUESSES. Two reads are needed — a LIST that carries the
 * names and statuses, and a per-milestone GET for the role, the days and the
 * assignment rule — so a pass that cannot complete the details leaves those columns
 * alone rather than writing nulls over a catalog that was right. And a read that
 * comes back EMPTY archives nothing: an outage is not evidence that a tenant
 * retired every step it has.
 *
 * IT IS NOT FREE, so it is not run often. Nineteen milestones is one list call plus
 * nineteen detail calls against an API budget shared with every other integration.
 * The catalog changes about never, so a pass is skipped unless the freshest row is
 * older than `LT_MILESTONE_CATALOG_HOURS` (default 24).
 *
 * ENCOMPASS STAYS ONE-WAY. Every call here is a GET.
 */

const lazy = {
  get db() { return require('../db'); },
  get client() { return require('../encompass/client'); },
};

/** The page the client asks for. Kept here so the archive rule can reason about it. */
const PAGE_SIZE = 100;

/** How old the freshest row may be before a pass is worth its calls. */
const DEFAULT_MAX_AGE_HOURS = (() => {
  const raw = Number(process.env.LT_MILESTONE_CATALOG_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 24;
})();

const text = (v) => {
  const s = String(v == null ? '' : v).trim();
  return s || null;
};
const int = (v) => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * One milestone as our table holds it, from the two Encompass shapes.
 *
 * PURE, and every field is optional on purpose: the LIST answer carries the name
 * and the two statuses, the per-id answer adds the role, the days and whether a
 * member must be assigned. A caller that has only the list gets a row with those
 * three left undefined, and the writer then leaves whatever we already hold.
 *
 * `sequence` is the LIST's own order. Encompass returns the catalog in pipeline
 * order and offers no order field of its own, so this is an inference — it is
 * stated here rather than buried, and it is the only one in this module.
 */
function rowFrom(listItem, detail, index) {
  const l = listItem || {};
  const d = detail || {};
  const role = d.role && typeof d.role === 'object' ? d.role : {};
  return {
    milestoneId: text(l.id != null ? l.id : d.id),
    sequence: index + 1,
    milestoneName: text(l.name != null ? l.name : d.name),
    tpoStatus: text(l.tpoStatus != null ? l.tpoStatus : d.tpoStatus),
    consumerStatus: text(l.consumerStatus != null ? l.consumerStatus : d.consumerStatus),
    isArchived: (l.isArchived === true || d.isArchived === true),
    // Detail-only. `undefined` means "this pass did not learn it"; `null` would
    // mean "Encompass says there is none", and the writer treats the two apart.
    role: detail ? text(role.entityName) : undefined,
    roleId: detail ? text(role.entityId) : undefined,
    assignmentRequired: detail ? d.assignMemberToRoleRequired === true : undefined,
    expectedDays: detail ? int(d.daysToFinish) : undefined,
  };
}

/** The list Encompass answered with, whatever envelope it arrived in. */
function itemsOf(answer) {
  if (Array.isArray(answer)) return answer;
  if (answer && Array.isArray(answer.items)) return answer.items;
  if (answer && Array.isArray(answer.value)) return answer.value;
  return [];
}

/** Is the catalog fresh enough that a pass would spend twenty calls for nothing? */
async function needsRefresh(db, maxAgeHours) {
  if (!(maxAgeHours > 0)) return true;
  const { rows } = await db.query(
    'SELECT max(catalog_synced_at) AS newest FROM lt_encompass_milestones',
  );
  const newest = rows[0] && rows[0].newest;
  if (!newest) return true;                       // never refreshed at all
  return (Date.now() - new Date(newest).getTime()) > maxAgeHours * 3600 * 1000;
}

/**
 * Write one milestone.
 *
 * COALESCE ONTO WHAT WE HOLD for every detail column, for the same reason the loan
 * mirror does it: a pass that could not read the detail must never blank a role or
 * a day count that was right. The three NOT NULL columns are COALESCEd onto
 * themselves so an insert can supply them and an update can decline to.
 */
async function writeRow(db, row) {
  await db.query(
    `INSERT INTO lt_encompass_milestones
       (milestone_id, sequence, milestone_name, role, role_id, assignment_required,
        expected_days, tpo_status, consumer_status, is_archived,
        catalog_synced_at, catalog_source, updated_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, false), COALESCE($7, 0),
             COALESCE($8, ''), COALESCE($9, ''), $10, now(), 'live', now())
     ON CONFLICT (milestone_id) DO UPDATE SET
       sequence            = EXCLUDED.sequence,
       milestone_name      = COALESCE(EXCLUDED.milestone_name, lt_encompass_milestones.milestone_name),
       role                = COALESCE($4, lt_encompass_milestones.role),
       role_id             = COALESCE($5, lt_encompass_milestones.role_id),
       assignment_required = COALESCE($6, lt_encompass_milestones.assignment_required),
       expected_days       = COALESCE($7, lt_encompass_milestones.expected_days),
       tpo_status          = COALESCE($8, lt_encompass_milestones.tpo_status),
       consumer_status     = COALESCE($9, lt_encompass_milestones.consumer_status),
       is_archived         = EXCLUDED.is_archived,
       catalog_synced_at   = now(),
       catalog_source      = 'live',
       updated_at          = now()`,
    [row.milestoneId, row.sequence, row.milestoneName,
      row.role === undefined ? null : row.role,
      row.roleId === undefined ? null : row.roleId,
      row.assignmentRequired === undefined ? null : row.assignmentRequired,
      row.expectedDays === undefined ? null : row.expectedDays,
      row.tpoStatus, row.consumerStatus, row.isArchived],
  );
}

/**
 * One pass. Never throws — it answers `{ok:false, reason}` so a sync screen can
 * say what happened.
 */
async function refreshOnce(opts = {}) {
  const db = opts.db || lazy.db;
  const client = opts.client || lazy.client;

  const maxAgeHours = opts.maxAgeHours != null ? Number(opts.maxAgeHours) : DEFAULT_MAX_AGE_HOURS;
  if (!opts.force) {
    let due = true;
    try { due = await needsRefresh(db, maxAgeHours); } catch (e) { due = true; }
    if (!due) return { ok: true, skipped: true, reason: `the catalog was confirmed less than ${maxAgeHours}h ago` };
  }

  let answer;
  try {
    // ARCHIVED ONES INCLUDED. Reading only the live ones would make "archived in
    // Encompass" and "gone from Encompass" look identical, and this module treats
    // those two differently on purpose.
    answer = await client.getMilestoneSettings({ includeArchived: true });
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }

  const items = itemsOf(answer).filter((x) => x && text(x.id));
  if (!items.length) {
    // An empty answer is an OUTAGE, not a tenant that retired every step it has.
    return { ok: false, reason: 'Encompass returned no milestones — nothing was changed' };
  }

  // The detail read is what carries the role, the days and the assignment rule.
  // A single failure costs THAT milestone its detail columns for this pass and
  // nothing else — the row still lands with its name, statuses and position.
  let detailFailures = 0;
  const rows = [];
  for (let i = 0; i < items.length; i += 1) {
    let detail = null;
    try {
      detail = await client.getMilestoneSetting(String(items[i].id));
    } catch (e) {
      detail = null;
      detailFailures += 1;
    }
    rows.push(rowFrom(items[i], detail, i));
  }

  let written = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.milestoneId || !row.milestoneName) { failed += 1; continue; }
    try { await writeRow(db, row); written += 1; } catch (e) { failed += 1; }
  }

  // A milestone we hold that Encompass no longer lists at all. ARCHIVED, never
  // deleted — and only when the read genuinely covered the catalog, which is why
  // the empty answer above returns before ever reaching here.
  //
  // AND ONLY WHEN WE READ THE WHOLE OF IT. The list is asked for one page of a
  // hundred (the endpoint's own default is TEN, which is why the page size is
  // always passed); a tenant with more than that would give us a first page, and
  // archiving everything absent from a FIRST PAGE would retire most of a buyer's
  // catalog in one pass. A full page is the signal that there may be a second, so
  // it declines to judge and says why.
  let archived = 0;
  const maybeMorePages = items.length >= PAGE_SIZE;
  if (maybeMorePages) {
    return { ok: true, skipped: false, read: items.length, written, failed, archived: 0, detailFailures,
      reason: `read a full page of ${PAGE_SIZE} — nothing was archived, because a milestone missing from a first page is not a milestone that is gone` };
  }
  try {
    const ids = rows.map((r) => r.milestoneId).filter(Boolean);
    const { rowCount } = await db.query(
      `UPDATE lt_encompass_milestones
          SET is_archived = true, catalog_synced_at = now(), catalog_source = 'live', updated_at = now()
        WHERE NOT (milestone_id = ANY($1::text[]))
          AND is_archived = false`,
      [ids],
    );
    archived = rowCount || 0;
  } catch (e) {
    archived = 0;
  }

  return {
    ok: true,
    skipped: false,
    read: items.length,
    written,
    failed,
    archived,
    // Said out loud: a pass whose details all failed wrote names and positions
    // over a catalog whose roles and day counts nobody confirmed.
    detailFailures,
  };
}

module.exports = {
  refreshOnce,
  _internals: { rowFrom, itemsOf, needsRefresh, PAGE_SIZE, DEFAULT_MAX_AGE_HOURS },
};
