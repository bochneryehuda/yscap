'use strict';

/**
 * Reading and writing dashboards.
 *
 * Follows the src/lib/lo-settings.js contract, which is this repo's pattern for
 * user-authored config: ONE owning module, a frozen whitelist of what may be stored,
 * defaults in code, a `validate()` that REFUSES an unknown key rather than silently
 * dropping it, and never a write that bypasses validate.
 *
 * ACCESS, in one place. A person may SEE a dashboard when they own it, when it is a system
 * default, or when it is shared with them / their role / everyone. A person may EDIT only
 * their own — editing a system dashboard FORKS it (see `fork`), which is what makes
 * "reset to the company default" always available and stops one person's edit changing
 * what a colleague sees.
 *
 * A shared dashboard shares the QUESTION, never the ANSWER. Every card re-runs under the
 * viewer's own file scope (see answer.scopeFor), so an admin and an officer open the same
 * card and correctly get different numbers.
 */

const db = require('../../db');
const compile = require('./compile');
const registry = require('./registry');

const VIZ = ['number', 'trend', 'breakdown', 'table', 'compare', 'list'];
const BANDS = ['hero', 'body'];
const WIDTHS = ['one', 'two', 'full'];
const COMPARE_KINDS = ['prior_period', 'prior_year'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Validate a card. Returns a list of plain-language problems; empty means it is storable.
 * Every structural choice is checked against the catalogue — a card may not name a
 * measure, dimension, date field or grain that does not exist, because a stored card that
 * silently returns nothing is indistinguishable from a real zero.
 */
function validateCard(card) {
  const p = [];
  if (!card || typeof card !== 'object') return ['malformed card'];
  if (!card.title || typeof card.title !== 'string') p.push('a card needs a title');
  if (String(card.title || '').length > 120) p.push('the title is too long (120 characters)');
  if (card.viz && !VIZ.includes(card.viz)) p.push(`"${card.viz}" is not a kind of card`);
  if (card.band && !BANDS.includes(card.band)) p.push('band must be hero or body');
  if (card.width && !WIDTHS.includes(card.width)) p.push('width must be one, two or full');
  if (!card.metric_key || !has(registry.MEASURES, card.metric_key)) {
    p.push(`"${card.metric_key}" is not something we can measure`);
  }
  if (card.date_field && !has(registry.DATE_FIELDS, card.date_field)) {
    p.push(`"${card.date_field}" is not a date we hold`);
  }
  if (card.group_by && !has(registry.DIMENSIONS, card.group_by)) {
    p.push(`"${card.group_by}" is not something we can break down by`);
  }
  if (card.grain && !has(registry.TIME_GRAINS, card.grain)) {
    p.push(`"${card.grain}" is not a time period`);
  }
  if (card.grain && !card.date_field) p.push('a card grouped by time needs a date to group on');
  if (card.period && !compile.PERIOD_KINDS.has(card.period.kind)) {
    p.push(`"${card.period.kind}" is not a period we understand`);
  }
  if (card.period && card.period.kind && card.period.kind !== 'all' && !card.date_field) {
    p.push('a card with a date range needs a date to apply it to');
  }
  // A comparison is a real second query, so it is checked like everything else — an unknown
  // kind is refused here rather than silently ignored at answer time, which is how a card
  // ends up subtitled "against last year" with nothing behind it.
  if (card.compare && card.compare.kind) {
    if (!COMPARE_KINDS.includes(card.compare.kind)) {
      p.push(`"${card.compare.kind}" is not a comparison we understand`);
    } else if (!card.date_field || ((card.period && card.period.kind) || 'all') === 'all') {
      p.push('a comparison needs a date and a period — there is no "last year" for all time');
    }
  }
  p.push(...compile.validateFilter(card.filter));
  return p;
}

/** Which dashboards may this person see? */
async function list(actor) {
  const r = await db.query(
    `SELECT d.id, d.name, d.description, d.slug, d.role_default, d.is_system,
            d.owner_staff_id, d.forked_from, d.created_at, d.updated_at,
            (d.owner_staff_id = $1) AS is_mine,
            (SELECT count(*) FROM dashboard_cards c WHERE c.dashboard_id = d.id)::int AS card_count
       FROM dashboards d
      WHERE d.archived_at IS NULL
        AND ( d.owner_staff_id = $1
           OR d.is_system
           OR EXISTS (SELECT 1 FROM dashboard_shares s
                       WHERE s.dashboard_id = d.id
                         AND ( (s.share_kind = 'staff' AND s.staff_id = $1)
                            OR (s.share_kind = 'role'  AND s.role = $2)
                            OR  s.share_kind = 'everyone')) )
      ORDER BY (d.owner_staff_id = $1) DESC, d.is_system DESC, d.name`,
    [actor.id, actor.role]);
  return r.rows;
}

async function canSee(actor, id) {
  const r = await db.query(
    `SELECT 1 FROM dashboards d
      WHERE d.id = $1 AND d.archived_at IS NULL
        AND ( d.owner_staff_id = $2 OR d.is_system
           OR EXISTS (SELECT 1 FROM dashboard_shares s
                       WHERE s.dashboard_id = d.id
                         AND ( (s.share_kind='staff' AND s.staff_id=$2)
                            OR (s.share_kind='role'  AND s.role=$3)
                            OR  s.share_kind='everyone')) )`,
    [id, actor.id, actor.role]);
  return !!r.rows[0];
}

/** Only the owner edits in place. A system dashboard is forked, never edited. */
async function canEdit(actor, id) {
  const r = await db.query(
    `SELECT owner_staff_id, is_system FROM dashboards WHERE id=$1 AND archived_at IS NULL`, [id]);
  const row = r.rows[0];
  if (!row) return false;
  if (row.is_system) return false;
  if (row.owner_staff_id === actor.id) return true;
  const s = await db.query(
    `SELECT 1 FROM dashboard_shares
      WHERE dashboard_id=$1 AND can_edit
        AND ((share_kind='staff' AND staff_id=$2) OR (share_kind='role' AND role=$3))`,
    [id, actor.id, actor.role]);
  return !!s.rows[0];
}

async function get(id) {
  const d = await db.query(
    `SELECT * FROM dashboards WHERE id=$1 AND archived_at IS NULL`, [id]);
  if (!d.rows[0]) return null;
  const c = await db.query(
    `SELECT * FROM dashboard_cards WHERE dashboard_id=$1 ORDER BY band DESC, position, created_at`, [id]);
  return { ...d.rows[0], cards: c.rows };
}

/** The dashboard this person lands on: their own home, else their role's default. */
async function homeFor(actor) {
  const own = await db.query(
    `SELECT id FROM dashboards
      WHERE owner_staff_id=$1 AND archived_at IS NULL AND forked_from IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`, [actor.id]);
  if (own.rows[0]) return get(own.rows[0].id);
  const role = await db.query(
    `SELECT id FROM dashboards WHERE is_system AND role_default=$1 AND archived_at IS NULL LIMIT 1`,
    [actor.role]);
  if (role.rows[0]) return get(role.rows[0].id);
  const any = await db.query(
    `SELECT id FROM dashboards WHERE is_system AND slug='default_staff' AND archived_at IS NULL LIMIT 1`);
  return any.rows[0] ? get(any.rows[0].id) : null;
}

async function create(actor, { name, description }) {
  const r = await db.query(
    `INSERT INTO dashboards (owner_staff_id, name, description) VALUES ($1,$2,$3) RETURNING *`,
    [actor.id, String(name || 'New dashboard').slice(0, 120), description ? String(description).slice(0, 500) : null]);
  return r.rows[0];
}

/**
 * Copy a dashboard to this person. One transaction — a fork that produced a dashboard with
 * no cards would be worse than no fork at all.
 */
async function fork(actor, id, { name } = {}) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const src = await client.query(`SELECT * FROM dashboards WHERE id=$1 AND archived_at IS NULL`, [id]);
    if (!src.rows[0]) { const e = new Error('That dashboard is gone.'); e.status = 404; throw e; }
    const s = src.rows[0];
    const d = await client.query(
      `INSERT INTO dashboards (owner_staff_id, name, description, forked_from, product)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [actor.id, String(name || s.name).slice(0, 120), s.description, s.id, s.product]);
    // EVERY column that describes a card must be copied, and `grain` is the one that got
    // missed: dropping it turns a trend into a single all-period number that still carries
    // its "Funded by month" title — a confidently WRONG card, not a visibly broken one.
    // Forking is the only way to edit a company dashboard, so this is the main journey.
    // When you add a column to dashboard_cards, add it here in the same commit; the DB test
    // compares the copied rows field-for-field so a future omission fails rather than ships.
    await client.query(
      `INSERT INTO dashboard_cards
         (dashboard_id, position, band, width, title, subtitle, viz, metric_key,
          filter, date_field, period, compare, group_by, grain, target, options)
       SELECT $1, position, band, width, title, subtitle, viz, metric_key,
              filter, date_field, period, compare, group_by, grain, target, options
         FROM dashboard_cards WHERE dashboard_id=$2`,
      [d.rows[0].id, s.id]);
    await client.query('COMMIT');
    return d.rows[0];
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* going back to the pool anyway */ }
    throw e;
  } finally {
    client.release();
  }
}

async function rename(id, { name, description }) {
  const r = await db.query(
    `UPDATE dashboards SET name=COALESCE($2,name), description=COALESCE($3,description),
            updated_at=now() WHERE id=$1 RETURNING *`,
    [id, name ? String(name).slice(0, 120) : null, description === undefined ? null : String(description || '').slice(0, 500)]);
  return r.rows[0] || null;
}

async function archive(id) {
  await db.query(`UPDATE dashboards SET archived_at=now() WHERE id=$1 AND NOT is_system`, [id]);
}

async function addCard(dashboardId, card) {
  const problems = validateCard(card);
  if (problems.length) { const e = new Error(problems.join('; ')); e.status = 400; throw e; }
  const r = await db.query(
    `INSERT INTO dashboard_cards
       (dashboard_id, position, band, width, title, subtitle, viz, metric_key,
        filter, date_field, period, compare, group_by, grain, target, options)
     VALUES ($1,COALESCE($2,0),COALESCE($3,'body'),COALESCE($4,'one'),$5,$6,COALESCE($7,'number'),$8,
             $9,$10,$11,$12,$13,$14,$15,COALESCE($16,'{}'::jsonb))
     RETURNING *`,
    [dashboardId, card.position, card.band, card.width, card.title, card.subtitle || null,
      card.viz, card.metric_key,
      card.filter ? JSON.stringify(card.filter) : null, card.date_field || null,
      card.period ? JSON.stringify(card.period) : null,
      card.compare ? JSON.stringify(card.compare) : null,
      card.group_by || null, card.grain || null,
      card.target ? JSON.stringify(card.target) : null,
      card.options ? JSON.stringify(card.options) : null]);
  return r.rows[0];
}

/**
 * THE DASHBOARD ID IS PART OF THE KEY, NOT DECORATION. The route checks that the caller may
 * edit the dashboard named in the PATH and then acts on a card by id — so if the card is not
 * matched against that same dashboard, "may I edit dashboard X?" silently authorises a write
 * to a card on dashboard Y. Creating a dashboard you own is one unguarded request away, so
 * without the second half of this key ANY staff member could rewrite or delete a card on
 * ANY dashboard, the company defaults included — and that is not recoverable in the product
 * (seed.js only fills a dashboard that has NO cards, and canEdit refuses a system dashboard,
 * so neither the next boot nor an admin can put a deleted company card back).
 *
 * `addCard` takes the dashboard from the path and `reorder` already scopes on it; these two
 * were the gap. A card that exists but belongs elsewhere must read as 404, never 403 —
 * telling a caller "that card is real but not yours" confirms an id they should not have.
 */
async function updateCard(dashboardId, cardId, card) {
  const cur = await db.query(`SELECT * FROM dashboard_cards WHERE id=$1 AND dashboard_id=$2`,
    [cardId, dashboardId]);
  if (!cur.rows[0]) { const e = new Error('That card is gone.'); e.status = 404; throw e; }
  const merged = { ...cur.rows[0], ...card };
  const problems = validateCard(merged);
  if (problems.length) { const e = new Error(problems.join('; ')); e.status = 400; throw e; }
  const r = await db.query(
    `UPDATE dashboard_cards SET
        position=$2, band=$3, width=$4, title=$5, subtitle=$6, viz=$7, metric_key=$8,
        filter=$9, date_field=$10, period=$11, compare=$12, group_by=$13, grain=$14,
        target=$15, options=COALESCE($16,'{}'::jsonb), updated_at=now()
      WHERE id=$1 AND dashboard_id=$17 RETURNING *`,
    [cardId, merged.position || 0, merged.band || 'body', merged.width || 'one',
      merged.title, merged.subtitle || null, merged.viz || 'number', merged.metric_key,
      merged.filter ? JSON.stringify(merged.filter) : null, merged.date_field || null,
      merged.period ? JSON.stringify(merged.period) : null,
      merged.compare ? JSON.stringify(merged.compare) : null,
      merged.group_by || null, merged.grain || null,
      merged.target ? JSON.stringify(merged.target) : null,
      merged.options ? JSON.stringify(merged.options) : null,
      dashboardId]);
  return r.rows[0];
}

// Same key as updateCard, and for the same reason — see the note there. Nothing deleted
// means the card is not on this dashboard, which the caller must read as "gone", not as a
// successful delete of somebody else's card.
async function removeCard(dashboardId, cardId) {
  const r = await db.query(`DELETE FROM dashboard_cards WHERE id=$1 AND dashboard_id=$2`,
    [cardId, dashboardId]);
  if (!r.rowCount) { const e = new Error('That card is gone.'); e.status = 404; throw e; }
}

async function reorder(dashboardId, order) {
  if (!Array.isArray(order) || !order.length) return;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      const o = order[i];
      if (!o || !o.id) continue;
      await client.query(
        `UPDATE dashboard_cards SET position=$2, band=COALESCE($3,band), width=COALESCE($4,width),
                updated_at=now()
          WHERE id=$1 AND dashboard_id=$5`,
        [o.id, i, BANDS.includes(o.band) ? o.band : null, WIDTHS.includes(o.width) ? o.width : null, dashboardId]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* pooled client is released below */ }
    throw e;
  } finally {
    client.release();
  }
}

async function share(dashboardId, actor, { shareKind, staffId, role, canEditShare }) {
  if (!['staff', 'role', 'everyone'].includes(shareKind)) {
    const e = new Error('Share with a person, a role, or everyone.'); e.status = 400; throw e;
  }
  await db.query(
    `INSERT INTO dashboard_shares (dashboard_id, share_kind, staff_id, role, can_edit, shared_by)
     VALUES ($1,$2,$3,$4,COALESCE($5,false),$6)
     ON CONFLICT (dashboard_id, share_kind, COALESCE(staff_id::text,''), COALESCE(role,''))
     DO UPDATE SET can_edit = EXCLUDED.can_edit`,
    [dashboardId, shareKind, shareKind === 'staff' ? staffId : null,
      shareKind === 'role' ? role : null, !!canEditShare, actor.id]);
}

async function unshare(dashboardId, shareId) {
  await db.query(`DELETE FROM dashboard_shares WHERE id=$1 AND dashboard_id=$2`, [shareId, dashboardId]);
}

async function shares(dashboardId) {
  const r = await db.query(
    `SELECT s.id, s.share_kind, s.staff_id, s.role, s.can_edit,
            NULLIF(u.full_name,'') AS staff_name
       FROM dashboard_shares s LEFT JOIN staff_users u ON u.id = s.staff_id
      WHERE s.dashboard_id=$1 ORDER BY s.created_at`, [dashboardId]);
  return r.rows;
}

module.exports = {
  VIZ, BANDS, WIDTHS, validateCard,
  list, get, canSee, canEdit, homeFor, create, fork, rename, archive,
  addCard, updateCard, removeCard, reorder, share, unshare, shares,
};
