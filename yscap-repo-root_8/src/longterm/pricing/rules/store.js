'use strict';
/**
 * LONG-TERM — READING AND WRITING THE PRICING RULE CENTER.
 *
 * Two tables (db/695): the rule as it stands, and the log of what happened to
 * it. Every write here does BOTH in one transaction, because a change nobody can
 * account for is exactly what the owner asked the audit log to prevent.
 *
 * ── NOTHING UNREADABLE REACHES A BOARD THROUGH THIS DOOR ───────────────────
 *
 * Every write validates the condition tree and the action list FIRST and refuses
 * with a plain-English list of problems. The column is deliberately not the
 * validator (db/695 says why); this is.
 *
 * ── THE READ IS THE HOT PATH ───────────────────────────────────────────────
 *
 * `liveRules` runs on every priced board, so it is one indexed statement and it
 * NEVER THROWS: a rule centre that cannot be read must cost a board its rules,
 * never its price. It answers `{rules: [], problem}` and the overlay does
 * nothing, which is the same board an empty centre produces.
 */

const db = require('../../db');
const logic = require('./logic');
const actions = require('./actions');

const MAX_NAME = 160;

/** Row → the shape the overlay and the screen both read. */
function shape(r) {
  return {
    id: r.id,
    name: r.name,
    note: r.note || null,
    engine: r.engine,
    enabled: r.enabled,
    priority: r.priority,
    when: r.when || {},
    then: Array.isArray(r.then) ? r.then : [],
    reason: r.reason || null,
    createdAt: r.created_at,
    createdBy: r.created_by || null,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by || null,
    archivedAt: r.archived_at || null,
    archivedBy: r.archived_by || null,
  };
}

const SELECT = `SELECT id, name, note, engine, enabled, priority, "when", "then", reason,
       created_at, created_by, updated_at, updated_by, archived_at, archived_by
  FROM lt_pricing_rule`;

/**
 * THE RULES IN FORCE, IN ORDER — the one read every board makes.
 *
 * NEVER THROWS. A missing table (a deploy where db/695 has not replayed yet), a
 * statement timeout, a pool with nothing free: each answers "no rules" plus the
 * reason, and the board prices exactly as it does today.
 */
async function liveRules(client) {
  const q = client || db;
  try {
    const { rows } = await q.query(
      `${SELECT} WHERE archived_at IS NULL AND enabled ORDER BY priority, created_at, id`);
    return { rules: rows.map(shape), problem: null };
  } catch (e) {
    return { rules: [], problem: e && e.message ? String(e.message) : 'the rule centre could not be read' };
  }
}

/** Everything, for the centre's own screen. Archived rules last. */
async function listRules(opts) {
  const o = opts || {};
  const where = o.includeArchived ? '' : 'WHERE archived_at IS NULL';
  const { rows } = await db.query(
    `${SELECT} ${where} ORDER BY (archived_at IS NOT NULL), priority, created_at, id`);
  return rows.map(shape);
}

async function getRule(id, client) {
  const q = client || db;
  const { rows } = await q.query(`${SELECT} WHERE id = $1`, [id]);
  return rows.length ? shape(rows[0]) : null;
}

/**
 * WHAT IS WRONG WITH THIS RULE, in words a person can act on. Empty means it is
 * saveable. The tree and the actions go through their own modules, so the screen,
 * this door and the overlay can never disagree about what a valid rule is.
 */
function problemsWith(input) {
  const p = [];
  const name = String((input && input.name) || '').trim();
  if (!name) p.push('A rule needs a name — it is what the board, the audit and the ineligible reason are attributed to.');
  else if (name.length > MAX_NAME) p.push(`The name is longer than ${MAX_NAME} characters.`);

  const engine = String((input && input.engine) || 'all');
  if (!['all', 'general', 'combined'].includes(engine)) p.push(`"${engine}" is not one of the engines.`);

  if (input && input.priority != null && !Number.isFinite(Number(input.priority))) {
    p.push('The order has to be a number.');
  }
  p.push(...logic.validate(input && input.when));
  p.push(...actions.validate(input && input.then));
  return p;
}

/** The values a write puts on the row, normalised once. */
function normalize(input) {
  return {
    name: String(input.name).trim(),
    note: input.note == null || String(input.note).trim() === '' ? null : String(input.note).trim(),
    engine: String(input.engine || 'all'),
    enabled: input.enabled === undefined ? true : !!input.enabled,
    priority: Number.isFinite(Number(input.priority)) ? Math.trunc(Number(input.priority)) : 100,
    when: input.when,
    then: input.then,
    reason: input.reason == null || String(input.reason).trim() === '' ? null : String(input.reason).trim(),
  };
}

/**
 * WRITE THE AUDIT LINE.
 *
 * ⛔ IT IS NOT BEST-EFFORT AND IT IS NOT CAUGHT. The owner asked for the audit
 * log; a save that lands with no line saying who made it is precisely the state
 * this table exists to make impossible, so it rides in the SAME transaction and
 * a failure takes the save down with it.
 */
async function logEvent(client, { ruleId, ruleName, action, byStaff, before, after, note }) {
  await client.query(
    `INSERT INTO lt_pricing_rule_event (rule_id, rule_name, action, by_staff, before, after, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ruleId || null, ruleName || null, action, byStaff || null,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      note == null || String(note).trim() === '' ? null : String(note).trim()]);
}

/**
 * One transaction, or the rule and its history can disagree.
 *
 * ⛔ `getClient`, NOT `connect`. Long-Term's pool exports `{query, getClient,
 * pool}` — there is no `connect`, and the first cut called one. It threw on the
 * very first save with `db.connect is not a function`, which no pure test could
 * see and which the database suite caught on its first run. When you take a
 * client here, take it the way `src/longterm/db.js` actually offers one.
 */
async function inTx(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* the error below is the one worth reporting */ }
    throw e;
  } finally {
    client.release();
  }
}

async function createRule(input, staffId, note) {
  const problems = problemsWith(input);
  if (problems.length) return { ok: false, problems };
  const v = normalize(input);
  return inTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO lt_pricing_rule (name, note, engine, enabled, priority, "when", "then", reason, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       RETURNING id, name, note, engine, enabled, priority, "when", "then", reason,
                 created_at, created_by, updated_at, updated_by, archived_at, archived_by`,
      [v.name, v.note, v.engine, v.enabled, v.priority, JSON.stringify(v.when), JSON.stringify(v.then), v.reason, staffId || null]);
    const rule = shape(rows[0]);
    await logEvent(client, { ruleId: rule.id, ruleName: rule.name, action: 'created', byStaff: staffId, before: null, after: rule, note });
    return { ok: true, rule };
  });
}

/**
 * EDIT A RULE.
 *
 * The action recorded is the one that DESCRIBES the change — enabling a rule is
 * `enabled`, moving it is `reordered`, anything else is `updated` — because "what
 * happened to this rule" is a question somebody asks of the log, and answering
 * every change with `updated` makes the log a list nobody can filter.
 */
async function updateRule(id, input, staffId, note) {
  const problems = problemsWith(input);
  if (problems.length) return { ok: false, problems };
  const v = normalize(input);
  return inTx(async (client) => {
    const before = await getRule(id, client);
    if (!before || before.archivedAt) return { ok: false, notFound: true };
    const { rows } = await client.query(
      `UPDATE lt_pricing_rule
          SET name=$2, note=$3, engine=$4, enabled=$5, priority=$6, "when"=$7, "then"=$8, reason=$9,
              updated_at=now(), updated_by=$10
        WHERE id=$1 AND archived_at IS NULL
       RETURNING id, name, note, engine, enabled, priority, "when", "then", reason,
                 created_at, created_by, updated_at, updated_by, archived_at, archived_by`,
      [id, v.name, v.note, v.engine, v.enabled, v.priority, JSON.stringify(v.when), JSON.stringify(v.then), v.reason, staffId || null]);
    if (!rows.length) return { ok: false, notFound: true };
    const after = shape(rows[0]);

    const onlyEnabled = before.enabled !== after.enabled;
    const onlyPriority = before.priority !== after.priority;
    const sameOtherwise = before.name === after.name && before.note === after.note
      && before.engine === after.engine && before.reason === after.reason
      && JSON.stringify(before.when) === JSON.stringify(after.when)
      && JSON.stringify(before.then) === JSON.stringify(after.then);
    const action = sameOtherwise && onlyEnabled && !onlyPriority ? (after.enabled ? 'enabled' : 'disabled')
      : sameOtherwise && onlyPriority && !onlyEnabled ? 'reordered'
        : 'updated';

    await logEvent(client, { ruleId: id, ruleName: after.name, action, byStaff: staffId, before, after, note });
    return { ok: true, rule: after };
  });
}

/**
 * ARCHIVE — the screen's delete.
 *
 * A rule that priced a loan last week is the explanation for that loan's price,
 * so the row is kept and marked. `restore` is the way back.
 */
async function archiveRule(id, staffId, note) {
  return inTx(async (client) => {
    const before = await getRule(id, client);
    if (!before) return { ok: false, notFound: true };
    const { rows } = await client.query(
      `UPDATE lt_pricing_rule SET archived_at=now(), archived_by=$2, enabled=false, updated_at=now(), updated_by=$2
        WHERE id=$1 AND archived_at IS NULL
       RETURNING id, name, note, engine, enabled, priority, "when", "then", reason,
                 created_at, created_by, updated_at, updated_by, archived_at, archived_by`,
      [id, staffId || null]);
    if (!rows.length) return { ok: false, notFound: true };
    const after = shape(rows[0]);
    await logEvent(client, { ruleId: id, ruleName: after.name, action: 'archived', byStaff: staffId, before, after, note });
    return { ok: true, rule: after };
  });
}

/**
 * RESTORE — deliberately brings a rule back SWITCHED OFF.
 *
 * Somebody archived it for a reason. Bringing it back already in force would
 * re-price every board the moment it is restored, before anybody has read it.
 */
async function restoreRule(id, staffId, note) {
  return inTx(async (client) => {
    const before = await getRule(id, client);
    if (!before) return { ok: false, notFound: true };
    const { rows } = await client.query(
      `UPDATE lt_pricing_rule SET archived_at=NULL, archived_by=NULL, enabled=false, updated_at=now(), updated_by=$2
        WHERE id=$1 AND archived_at IS NOT NULL
       RETURNING id, name, note, engine, enabled, priority, "when", "then", reason,
                 created_at, created_by, updated_at, updated_by, archived_at, archived_by`,
      [id, staffId || null]);
    if (!rows.length) return { ok: false, notFound: true };
    const after = shape(rows[0]);
    await logEvent(client, { ruleId: id, ruleName: after.name, action: 'restored', byStaff: staffId, before, after, note });
    return { ok: true, rule: after };
  });
}

/** The history — one rule's, or the centre's. */
async function events(opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(Number(o.limit) || 100, 1), 500);
  const params = [limit];
  let where = '';
  if (o.ruleId) { params.push(o.ruleId); where = `WHERE rule_id = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT id, rule_id, rule_name, action, at, by_staff, before, after, note
       FROM lt_pricing_rule_event ${where} ORDER BY at DESC, id DESC LIMIT $1`, params);
  return rows.map((r) => ({
    id: String(r.id), ruleId: r.rule_id, ruleName: r.rule_name, action: r.action,
    at: r.at, byStaff: r.by_staff, before: r.before, after: r.after, note: r.note,
  }));
}

/**
 * WHAT EVERY RULE HAS ACTUALLY DONE — the firing ledger (db/696), rolled up.
 *
 * Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
 * is actually firing."*
 *
 * ⛔ NEVER THROWS, for the same reason `liveRules` never throws: this feeds a
 * screen ABOUT the rules, and an audit that cannot be read must cost the officer
 * the numbers, never the page. A failure answers an empty map plus the problem,
 * and the screen says it could not read the ledger rather than drawing an
 * all-zero table that reads as "nothing has ever fired".
 *
 * ⛔ THE WINDOW IS A FLOOR, NOT A FILTER ON `first_at`/`last_at`. Rows are
 * bucketed by DAY, so a rule that last fired six months ago has no row inside a
 * 90-day window at all — and `firstAt`/`lastAt` are therefore the first and last
 * moments WITHIN the window, which is what the screen must say. "Has this ever
 * fired?" is answered by the separate all-time query below, never by inspecting
 * a windowed total.
 */
async function firingSummary(opts) {
  const o = opts || {};
  const days = Number.isFinite(Number(o.days)) && Number(o.days) > 0 ? Math.min(3650, Math.floor(Number(o.days))) : 90;
  const out = new Map();
  try {
    const { rows } = await db.query(
      `SELECT rule_id,
              engine,
              SUM(boards_seen)      AS boards_seen,
              SUM(boards_matched)   AS boards_matched,
              SUM(quotes_reached)   AS quotes_reached,
              SUM(quotes_adjusted)  AS quotes_adjusted,
              SUM(quotes_refused)   AS quotes_refused,
              SUM(rows_blocked)     AS rows_blocked,
              SUM(unreadable)       AS unreadable,
              MIN(first_at)         AS first_at,
              MAX(last_at)          AS last_at
         FROM lt_pricing_rule_firing
        WHERE day >= (CURRENT_DATE - ($1::int - 1))
        GROUP BY rule_id, engine`,
      [days]);
    for (const r of rows) {
      const id = String(r.rule_id);
      if (!out.has(id)) out.set(id, { ruleId: id, engines: {}, total: blankFiring() });
      const cur = out.get(id);
      const one = readFiring(r);
      cur.engines[r.engine] = one;
      addFiring(cur.total, one);
    }
    /* HAS IT *EVER* FIRED — asked over the WHOLE table, deliberately outside the
       window. A rule that fired last year and not since is a very different
       finding from one that has never fired at all, and the window cannot tell
       them apart. */
    const { rows: ever } = await db.query(
      `SELECT rule_id, MAX(last_at) AS last_at
         FROM lt_pricing_rule_firing
        WHERE last_at IS NOT NULL
        GROUP BY rule_id`);
    for (const r of ever) {
      const id = String(r.rule_id);
      if (!out.has(id)) out.set(id, { ruleId: id, engines: {}, total: blankFiring() });
      out.get(id).everFiredAt = r.last_at || null;
    }
    return { days, byRule: out, problem: null };
  } catch (e) {
    return { days, byRule: new Map(), problem: e && e.message ? String(e.message) : 'the firing ledger could not be read' };
  }
}

/* `bigint` comes back from pg as a STRING (it does not fit a JS number), so every
   counter is read through Number() rather than used as it arrives — a template
   would otherwise print "12" + "3" as "123". */
const bigNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function blankFiring() {
  return { boardsSeen: 0, boardsMatched: 0, quotesReached: 0, quotesAdjusted: 0, quotesRefused: 0, rowsBlocked: 0, unreadable: 0, firstAt: null, lastAt: null };
}

function readFiring(r) {
  return {
    boardsSeen: bigNum(r.boards_seen),
    boardsMatched: bigNum(r.boards_matched),
    quotesReached: bigNum(r.quotes_reached),
    quotesAdjusted: bigNum(r.quotes_adjusted),
    quotesRefused: bigNum(r.quotes_refused),
    rowsBlocked: bigNum(r.rows_blocked),
    unreadable: bigNum(r.unreadable),
    firstAt: r.first_at || null,
    lastAt: r.last_at || null,
  };
}

function addFiring(acc, one) {
  acc.boardsSeen += one.boardsSeen;
  acc.boardsMatched += one.boardsMatched;
  acc.quotesReached += one.quotesReached;
  acc.quotesAdjusted += one.quotesAdjusted;
  acc.quotesRefused += one.quotesRefused;
  acc.rowsBlocked += one.rowsBlocked;
  acc.unreadable += one.unreadable;
  if (one.firstAt && (!acc.firstAt || one.firstAt < acc.firstAt)) acc.firstAt = one.firstAt;
  if (one.lastAt && (!acc.lastAt || one.lastAt > acc.lastAt)) acc.lastAt = one.lastAt;
}

module.exports = {
  liveRules, listRules, getRule, createRule, updateRule, archiveRule, restoreRule, events,
  firingSummary,
  problemsWith, shape, MAX_NAME, _internals: { normalize, logEvent, inTx, blankFiring, readFiring, addFiring },
};

