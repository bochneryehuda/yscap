'use strict';

// Long-Term's OWN minimal config.
//
// It reads process.env DIRECTLY and deliberately does NOT import src/config.js —
// that is RTL code, and the product-separation gate would (correctly) block the
// import. LT connects to the SAME Postgres as RTL (Option B: one database, two
// namespaces), but through its own pool and only ever touches lt_* tables.

const env = process.env.NODE_ENV || 'development';

// SSL: mirrors src/db.js so LT connects on exactly the same terms as RTL. Managed
// Postgres (Render) presents a cert Node does not have in its trust store, so we
// don't verify the chain in production; locally we connect without SSL. PGSSLMODE
// overrides both.
function sslConfig() {
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable' || mode === 'off') return false;
  if (mode === 'require' || mode === 'prefer' || mode === 'no-verify') return { rejectUnauthorized: false };
  return env === 'production' ? { rejectUnauthorized: false } : false;
}

module.exports = {
  env,
  databaseUrl: process.env.DATABASE_URL || '',
  sslConfig,
};
