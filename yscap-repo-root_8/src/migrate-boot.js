/**
 * Boot-time schema guard.
 *
 * A fresh Render deploy connects to an EMPTY database — no tables exist yet —
 * so the very first `POST /auth/borrower/register` fails. Historically that
 * required someone to open the Render Shell and run `npm run migrate` by hand,
 * which is easy to forget and was the reason "you can't create an account".
 *
 * This runs the same migrations automatically on startup:
 *   1. wait for the database to accept connections (it can lag a deploy);
 *   2. if the base schema is missing, apply db/schema.sql;
 *   3. always apply the numbered migrations (002+ are all `IF NOT EXISTS`,
 *      so re-running them every boot is a no-op once applied).
 *
 * It NEVER throws — a migration hiccup must not stop the service from booting
 * and serving the static site / health check. It returns a status object the
 * caller logs.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the DB accepts a trivial query, with bounded backoff. */
async function waitForDb({ attempts = 8, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch (e) {
      lastErr = e;
      const delay = Math.min(baseDelayMs * 2 ** (i - 1), 15000);
      console.warn(`[migrate] database not ready (attempt ${i}/${attempts}): ${db.describeError(e)} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  return { ok: false, error: db.describeError(lastErr) };
}

/** Ordered list of migration files: schema.sql first, then 0NN_*.sql ascending. */
function migrationFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => {
      if (a === 'schema.sql') return -1;
      if (b === 'schema.sql') return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

async function ensureSchema() {
  const ready = await waitForDb();
  if (!ready.ok) {
    console.error('[migrate] giving up: database unreachable —', ready.error);
    return { ok: false, ran: [], error: ready.error };
  }

  const dir = path.join(__dirname, '..', 'db');
  let files;
  try {
    files = migrationFiles(dir);
  } catch (e) {
    console.error('[migrate] cannot read db/ directory:', db.describeError(e));
    return { ok: false, ran: [], error: db.describeError(e) };
  }

  // Is the base schema already present? `to_regclass` returns NULL if not.
  let hasBase = false;
  try {
    const r = await db.query(`SELECT to_regclass('public.borrowers') AS t`);
    hasBase = !!(r.rows[0] && r.rows[0].t);
  } catch (_) { /* treat as absent */ }

  const ran = [];
  for (const f of files) {
    // schema.sql is NOT idempotent (bare CREATE TABLE). Only run it on a truly
    // empty database; skip it once the base tables exist.
    if (f === 'schema.sql' && hasBase) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      await db.query(sql);
      ran.push(f);
      console.log(`[migrate] applied ${f}`);
    } catch (e) {
      // "already exists" style errors mean the file was applied before by hand;
      // that's fine, keep going. Anything else we log but still continue so one
      // bad file can't block the rest / the boot.
      const msg = db.describeError(e);
      if (/already exists|duplicate/i.test(msg)) {
        console.warn(`[migrate] ${f} already applied (${msg.split(' ')[0]}...) — continuing`);
      } else {
        console.error(`[migrate] ${f} FAILED: ${msg} — continuing`);
      }
    }
  }
  console.log(`[migrate] schema check complete (${ran.length} file(s) applied)`);
  return { ok: true, ran };
}

module.exports = { ensureSchema, waitForDb };
