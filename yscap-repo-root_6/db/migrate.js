/**
 * Runs every db/*.sql file in filename order inside one transaction each.
 * Safe to re-run: schema.sql uses CREATE ... (fails only if you edit it to be
 * non-idempotent) and 002+ use IF NOT EXISTS. Usage: `npm run migrate`.
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

(async () => {
  const dir = __dirname;
  // schema.sql defines the base tables and MUST run first; the numbered
  // migrations (002_, 003_, …) alter those tables and run after, in order.
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort((a, b) => {
    if (a === 'schema.sql') return -1;
    if (b === 'schema.sql') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    process.stdout.write(`→ ${f} ... `);
    try {
      await pool.query(sql);
      console.log('ok');
    } catch (e) {
      console.log('FAILED');
      console.error(e.message);
      process.exit(1);
    }
  }
  console.log('migrations complete');
  process.exit(0);
})();
