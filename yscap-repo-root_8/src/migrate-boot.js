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
const crypto = require('crypto');
const db = require('./db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- WO-13 (F-M19): migration ledger -------------------------------------
// Every migration is still re-applied idempotently on every boot (belt-and-
// suspenders). The ledger ADDS observability + a loud alarm: it records each
// applied file's checksum, and if a file's content changed since it was last
// applied, it warns that a migration was EDITED after being applied — a real
// hazard, since an edit to an already-applied file may not re-apply cleanly, so
// schema changes must be a NEW numbered file, never an edit to an old one.
function migrationChecksum(sql) {
  return crypto.createHash('sha256').update(String(sql), 'utf8').digest('hex');
}
/** Pure: has this file's content changed since it was last applied? */
function isChecksumDrift(prevSha, curSha) {
  return !!(prevSha && curSha && prevSha !== curSha);
}
async function ensureLedgerTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    last_seen   timestamptz NOT NULL DEFAULT now()
  )`);
}
async function recordMigration(filename, sql) {
  const sha = migrationChecksum(sql);
  try {
    const prev = (await db.query(`SELECT sha256 FROM schema_migrations WHERE filename=$1`, [filename])).rows[0];
    if (isChecksumDrift(prev && prev.sha256, sha)) {
      console.error(`[migrate] CHECKSUM DRIFT: ${filename} was EDITED after it was applied ` +
        `(was ${prev.sha256.slice(0, 8)}…, now ${sha.slice(0, 8)}…). Schema changes must be a NEW numbered ` +
        `migration, never an edit to an applied one — this edit may not have taken effect on existing databases.`);
    }
    await db.query(
      `INSERT INTO schema_migrations (filename, sha256, applied_at, last_seen) VALUES ($1,$2,now(),now())
       ON CONFLICT (filename) DO UPDATE SET sha256=EXCLUDED.sha256, last_seen=now()`,
      [filename, sha]);
  } catch (e) { console.warn(`[migrate] ledger record skipped for ${filename}: ${db.describeError(e)}`); }
}

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

  // WO-13 (F-M19): make sure the ledger table exists before we start recording.
  // Best-effort — a failure here just means the boot proceeds without the ledger.
  try { await ensureLedgerTable(); } catch (e) { console.warn('[migrate] ledger table unavailable:', db.describeError(e)); }

  const ran = [];
  for (const f of files) {
    // schema.sql is NOT idempotent (bare CREATE TABLE). Only run it on a truly
    // empty database; skip it once the base tables exist.
    if (f === 'schema.sql' && hasBase) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    try {
      await db.query(sql);
      ran.push(f);
      await recordMigration(f, sql);   // WO-13: ledger + checksum-drift alarm
      console.log(`[migrate] applied ${f}`);
    } catch (e) {
      // "already exists" style errors mean the file was applied before by hand;
      // that's fine, keep going. Anything else we log but still continue so one
      // bad file can't block the rest / the boot.
      const msg = db.describeError(e);
      if (/already exists|duplicate/i.test(msg)) {
        await recordMigration(f, sql);   // still applied — record it
        console.warn(`[migrate] ${f} already applied (${msg.split(' ')[0]}...) — continuing`);
      } else {
        console.error(`[migrate] ${f} FAILED: ${msg} — continuing`);
      }
    }
  }
  console.log(`[migrate] schema check complete (${ran.length} file(s) applied)`);
  return { ok: true, ran };
}

/**
 * Optionally seed the first super-admin from env vars so the staff console is
 * reachable immediately after a fresh deploy — no manual `create-admin` shell
 * step. Opt-in: only runs when ADMIN_EMAIL and ADMIN_PASSWORD are both set.
 * Idempotent upsert (re-running resets that admin's password to the env value,
 * which is also a convenient lockout recovery). Remove the vars once you're in.
 * Never throws.
 */
async function bootstrapAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) return { ok: true, skipped: true };
  if (String(password).length < 8) {
    console.warn('[admin] ADMIN_PASSWORD too short (min 8) — skipping admin bootstrap.');
    return { ok: false, skipped: true };
  }
  const role = (process.env.ADMIN_ROLE || 'super_admin').trim();
  const fullName = (process.env.ADMIN_NAME || email).trim();
  try {
    const C = require('./lib/crypto');
    const r = await db.query(
      `INSERT INTO staff_users (email, full_name, role, password_hash, is_active)
       VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (email) DO UPDATE
         SET full_name=EXCLUDED.full_name, role=EXCLUDED.role,
             password_hash=EXCLUDED.password_hash, is_active=true,
             failed_attempts=0, locked_until=NULL, updated_at=now()
       RETURNING (xmax = 0) AS created`,
      [email, fullName, role, await C.hashPassword(password)]);
    console.log(`[admin] ${r.rows[0]?.created ? 'created' : 'updated'} staff admin ${email} (${role}). ` +
      'Remove ADMIN_PASSWORD from the environment once you have logged in.');
    return { ok: true };
  } catch (e) {
    console.error('[admin] bootstrap failed:', db.describeError(e));
    return { ok: false, error: db.describeError(e) };
  }
}

module.exports = { ensureSchema, waitForDb, bootstrapAdmin,
  migrationChecksum, isChecksumDrift }; // WO-13: exported for the ledger test
