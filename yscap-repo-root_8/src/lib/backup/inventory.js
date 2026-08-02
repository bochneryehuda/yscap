'use strict';
/**
 * Database INVENTORY — the count of what a backup is supposed to contain, taken from the live
 * database at the moment the dump starts, and stored beside the dump.
 *
 * WHY: "we have a backup" is a claim about a file. "this backup contains 214 tables and 1,880,443
 * rows, and a test restore produced 214 tables and 1,880,443 rows" is a claim about the DATA, and
 * it is the only one worth anything. Without an inventory a restore can only be eyeballed; with
 * one, `scripts/backup-verify.js` can prove a restored copy matches the original table for table
 * and row for row, automatically, every week, and shout when it does not.
 *
 * IT IS ALSO HOW NEW TABLES TAKE CARE OF THEMSELVES. Nothing here (and nothing in the dump) names
 * a table: the inventory asks the database what exists, and pg_dump dumps whatever exists. Add a
 * table tomorrow and it is in that night's backup, counted and verified, with nothing to configure.
 * The one thing worth watching is a table that DISAPPEARS or empties out, which is why the
 * inventory is compared against the previous run.
 */

/** Schemas we never back up — they are PostgreSQL's own, recreated by the server itself. */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

/** Rows this many or fewer get an EXACT count; above it the planner estimate is used first and only
 *  refined if it is cheap. An exact COUNT(*) reads the whole table, and doing that to every table
 *  every night on a live database is a self-inflicted outage. */
const EXACT_COUNT_CEILING = 5_000_000;

/**
 * Take the full inventory. Read-only — issues nothing but SELECTs.
 *
 * @param {{query:Function}} db  the pg pool wrapper (src/db.js) OR a single checked-out client.
 *   PASS A CLIENT when the caller has opened a repeatable-read transaction and exported its
 *   snapshot to pg_dump: the counts are then taken from the EXACT snapshot the dump contains, so
 *   the restore drill can compare them to the row and never has to tolerate drift.
 * @param {boolean} inTransaction  true when `db` is a client already inside a transaction — the
 *   per-table savepoints below are only legal (and only necessary) there.
 */
async function takeInventory(db, { statementTimeoutMs = 60000, inTransaction = false } = {}) {
  /**
   * Run a query whose failure is TOLERATED, without poisoning the caller's transaction.
   *
   * This is the whole reason the helper exists: inside a transaction a failed statement aborts
   * EVERYTHING after it, so a plain `.catch(() => {})` around an optional query does not "ignore"
   * it — it leaves the transaction dead while the code carries on believing it recovered. That
   * silently invalidated the snapshot shared with pg_dump, and the dump then failed with
   * "the source process is not running anymore". Every optional query goes through here.
   */
  const attempt = async (sql, params, fallback) => {
    if (!inTransaction) {
      try { return await db.query(sql, params); } catch (_) { return fallback; }
    }
    await db.query('SAVEPOINT inv_step');
    try {
      const r = await db.query(sql, params);
      await db.query('RELEASE SAVEPOINT inv_step');
      return r;
    } catch (_) {
      await db.query('ROLLBACK TO SAVEPOINT inv_step').catch(() => {});
      return fallback;
    }
  };

  // A table that cannot be counted in time must not sink the inventory.
  if (inTransaction) {
    await attempt(`SET LOCAL statement_timeout = ${Math.max(1000, statementTimeoutMs)}`, undefined, null);
  }

  const server = (await db.query(
    `SELECT current_database() AS database,
            version() AS version,
            current_setting('server_version_num') AS version_num,
            pg_database_size(current_database()) AS size_bytes`)).rows[0];

  // Every ordinary table in every non-system schema. Partitions ('p') are listed too: pg_dump
  // dumps the parent and the children, and a missing partition is missing data.
  const tables = (await db.query(
    `SELECT n.nspname                          AS schema,
            c.relname                          AS name,
            c.relkind                          AS kind,
            GREATEST(c.reltuples, 0)::bigint   AS estimated_rows,
            pg_total_relation_size(c.oid)      AS size_bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND n.nspname <> ALL($1::text[])
        AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname, c.relname`, [SYSTEM_SCHEMAS])).rows;

  const counted = [];
  for (const t of tables) {
    // A partitioned parent's rows are counted through the parent, so counting the children too
    // would double them. reltuples on a parent is 0 by design; COUNT(*) on it aggregates.
    const est = Number(t.estimated_rows) || 0;
    let rows = est;
    let exact = false;
    if (est <= EXACT_COUNT_CEILING) {
      // A locked or huge table must not fail the whole backup — the estimate is recorded and
      // flagged, so the verifier compares it loosely instead of failing on a number it never had.
      const r = await attempt(`SELECT COUNT(*)::bigint AS n FROM "${t.schema}"."${t.name}"`, undefined, null);
      if (r) { rows = Number(r.rows[0].n); exact = true; }
      else console.warn(`[backup] could not count "${t.schema}"."${t.name}" exactly; using the estimate`);
    }
    counted.push({
      schema: t.schema, name: t.name, kind: t.kind,
      rows, exact, sizeBytes: Number(t.size_bytes) || 0,
    });
  }

  const sequences = (await db.query(
    `SELECT schemaname AS schema, sequencename AS name, last_value
       FROM pg_sequences
      WHERE schemaname <> ALL($1::text[])
      ORDER BY schemaname, sequencename`, [SYSTEM_SCHEMAS])).rows
    .map((s) => ({ schema: s.schema, name: s.name, lastValue: s.last_value == null ? null : String(s.last_value) }));

  const extensions = (await db.query(`SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`)).rows;

  // Views, functions and triggers are DATA-SHAPING objects: a restore that brings back every row
  // but loses a trigger is not a restored system. pg_dump carries them; counting them here means
  // the verifier notices if it did not.
  const objects = (await db.query(
    `SELECT
       (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relkind IN ('v','m') AND n.nspname <> ALL($1::text[]))                       AS views,
       (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relkind='i' AND n.nspname <> ALL($1::text[]))                                AS indexes,
       (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname <> ALL($1::text[]))                                                  AS functions,
       (SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal)                               AS triggers,
       (SELECT COUNT(*) FROM pg_constraint)                                                   AS constraints`,
    [SYSTEM_SCHEMAS])).rows[0];

  // The schema version the dump was taken at. On restore this is what tells you whether the code
  // you are restoring ALONGSIDE it is the code that wrote it.
  // A database that predates the ledger — or a scratch database being inventoried after a test
  // restore — simply has no such table, and that must not disturb anything.
  let migrations = { count: 0, latest: null, available: false };
  const m = await attempt(
    `SELECT COUNT(*)::int AS n, MAX(filename) AS latest, MAX(applied_at) AS applied_at FROM schema_migrations`,
    undefined, null);
  if (m) {
    migrations = {
      count: m.rows[0].n, latest: m.rows[0].latest,
      appliedAt: m.rows[0].applied_at ? new Date(m.rows[0].applied_at).toISOString() : null,
      available: true,
    };
  }

  const totals = counted.reduce((a, t) => ({
    tables: a.tables + 1,
    rows: a.rows + t.rows,
    sizeBytes: a.sizeBytes + t.sizeBytes,
    estimatedTables: a.estimatedTables + (t.exact ? 0 : 1),
  }), { tables: 0, rows: 0, sizeBytes: 0, estimatedTables: 0 });

  return {
    takenAt: new Date().toISOString(),
    server: {
      database: server.database,
      version: server.version,
      versionNum: parseInt(server.version_num, 10),
      majorVersion: Math.floor(parseInt(server.version_num, 10) / 10000),
      sizeBytes: Number(server.size_bytes) || 0,
    },
    tables: counted,
    sequences,
    extensions,
    objects: {
      views: Number(objects.views), indexes: Number(objects.indexes),
      functions: Number(objects.functions), triggers: Number(objects.triggers),
      constraints: Number(objects.constraints),
    },
    migrations,
    totals,
  };
}

/**
 * PURE — compare a restored database's inventory against the one taken when the dump was made.
 * This is the actual pass/fail of a restore drill.
 *
 * Row counts taken from an ESTIMATE on either side are compared with a tolerance, because a
 * planner estimate is not a fact. Exact-vs-exact must match to the row.
 */
function compareInventories(expected, actual, { estimateTolerance = 0.1 } = {}) {
  const keyOf = (t) => `${t.schema}.${t.name}`;
  const exp = new Map((expected.tables || []).map((t) => [keyOf(t), t]));
  const act = new Map((actual.tables || []).map((t) => [keyOf(t), t]));

  const missingTables = [...exp.keys()].filter((k) => !act.has(k));
  const extraTables = [...act.keys()].filter((k) => !exp.has(k));
  const rowMismatches = [];
  for (const [k, e] of exp) {
    const a = act.get(k);
    if (!a) continue;
    if (e.exact && a.exact) {
      if (e.rows !== a.rows) rowMismatches.push({ table: k, expected: e.rows, actual: a.rows, basis: 'exact' });
    } else {
      const tol = Math.max(1, Math.ceil(e.rows * estimateTolerance));
      if (Math.abs(e.rows - a.rows) > tol) {
        rowMismatches.push({ table: k, expected: e.rows, actual: a.rows, basis: 'estimated', tolerance: tol });
      }
    }
  }

  const seqExp = new Map((expected.sequences || []).map((s) => [`${s.schema}.${s.name}`, s]));
  const missingSequences = [...seqExp.keys()].filter(
    (k) => !(actual.sequences || []).some((s) => `${s.schema}.${s.name}` === k));

  // An index/trigger/constraint SHORTFALL is a failure; a surplus is not (a newer schema on the
  // scratch database can legitimately have more).
  const objectShortfalls = [];
  for (const kind of ['views', 'indexes', 'functions', 'triggers', 'constraints']) {
    const e = (expected.objects || {})[kind] || 0;
    const a = (actual.objects || {})[kind] || 0;
    if (a < e) objectShortfalls.push({ kind, expected: e, actual: a });
  }

  const ok = missingTables.length === 0 && rowMismatches.length === 0 &&
             missingSequences.length === 0 && objectShortfalls.length === 0;

  return {
    ok, missingTables, extraTables, rowMismatches, missingSequences, objectShortfalls,
    summary: ok
      ? `restore verified: ${actual.totals ? actual.totals.tables : act.size} tables, ` +
        `${(actual.totals ? actual.totals.rows : 0).toLocaleString('en-US')} rows — matches the backup`
      : `restore MISMATCH: ${missingTables.length} missing tables, ${rowMismatches.length} row-count ` +
        `differences, ${missingSequences.length} missing sequences, ${objectShortfalls.length} object shortfalls`,
  };
}

/**
 * PURE — what changed in the SHAPE of the database since the last backup. New tables are the happy
 * path (they are already backed up — that is the point); a table that VANISHED or lost most of its
 * rows is the line worth reading in the morning.
 */
function diffInventories(previous, current) {
  if (!previous) return { firstRun: true, newTables: [], droppedTables: [], bigRowDrops: [] };
  const keyOf = (t) => `${t.schema}.${t.name}`;
  const prev = new Map((previous.tables || []).map((t) => [keyOf(t), t]));
  const cur = new Map((current.tables || []).map((t) => [keyOf(t), t]));
  const newTables = [...cur.keys()].filter((k) => !prev.has(k));
  const droppedTables = [...prev.keys()].filter((k) => !cur.has(k));
  const bigRowDrops = [];
  for (const [k, p] of prev) {
    const c = cur.get(k);
    if (!c || p.rows < 100) continue;
    if (c.rows < p.rows * 0.5) bigRowDrops.push({ table: k, was: p.rows, now: c.rows });
  }
  return { firstRun: false, newTables, droppedTables, bigRowDrops };
}

module.exports = { takeInventory, compareInventories, diffInventories, SYSTEM_SCHEMAS, EXACT_COUNT_CEILING };
