#!/usr/bin/env node
/**
 * Bootstrap / reset a staff account (the first super-admin).
 *
 * Staff are invite-only and invites require an existing admin, so the very
 * first account has to be seeded directly. Run this once from the Render Shell
 * (after `npm run migrate`) to create your super-admin, then log in at
 * /portal/#/staff/login and invite everyone else from inside the app.
 *
 * Usage (args):
 *   node db/create-admin.js <email> <password> [role] [full name...]
 *   npm run create-admin -- you@yscapgroup.com "S0mePass!" super_admin "Yehuda Bochner"
 *
 * Usage (env — handy on Render):
 *   ADMIN_EMAIL=you@yscapgroup.com ADMIN_PASSWORD="S0mePass!" \
 *   ADMIN_ROLE=super_admin ADMIN_NAME="Yehuda Bochner" node db/create-admin.js
 *
 * Re-running with the same email RESETS the password (and role/name) — a safe
 * way to recover a locked-out admin.
 */
const db = require('../src/db');
const C  = require('../src/lib/crypto');

const ROLES = ['super_admin', 'admin', 'loan_officer', 'processor', 'underwriter'];

async function main() {
  const a = process.argv.slice(2);
  const email    = (a[0] || process.env.ADMIN_EMAIL    || '').trim();
  const password =  a[1] || process.env.ADMIN_PASSWORD || '';
  const role     = (a[2] || process.env.ADMIN_ROLE     || 'super_admin').trim();
  const fullName = (a.slice(3).join(' ') || process.env.ADMIN_NAME || email).trim();

  if (!email || !password) {
    console.error('Usage: node db/create-admin.js <email> <password> [role] [full name]');
    console.error('   or: ADMIN_EMAIL=.. ADMIN_PASSWORD=.. [ADMIN_ROLE=super_admin] [ADMIN_NAME=..] node db/create-admin.js');
    process.exit(1);
  }
  if (!ROLES.includes(role)) {
    console.error(`Bad role "${role}". Must be one of: ${ROLES.join(', ')}`);
    process.exit(1);
  }
  if (String(password).length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = await C.hashPassword(password);
  const r = await db.query(
    `INSERT INTO staff_users (email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (email) DO UPDATE
       SET full_name = EXCLUDED.full_name,
           role      = EXCLUDED.role,
           password_hash = EXCLUDED.password_hash,
           is_active = true,
           failed_attempts = 0,
           locked_until = NULL,
           updated_at = now()
     RETURNING id, email, role, (xmax = 0) AS created`,
    [email, fullName, role, hash]);

  const row = r.rows[0];
  console.log(`${row.created ? 'Created' : 'Updated'} staff account:`);
  console.log(`  id:    ${row.id}`);
  console.log(`  email: ${row.email}`);
  console.log(`  role:  ${row.role}`);
  console.log('');
  console.log('Log in at:  /portal/#/staff/login');
  await db.pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('create-admin failed:', e.message);
  process.exit(1);
});
