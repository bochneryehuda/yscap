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

// Encompass (ICE Mortgage Technology / Ellie Mae) — Long-Term's OWN copy of the
// integration config. Owner-authorized 2026-08-14 to bring the RTL Encompass
// integration into Long-Term (recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md).
//
// LT reads its OWN LT_ENCOMPASS_* env vars, FALLING BACK to the shared ENCOMPASS_*
// ones — so LT works out of the box against the same Encompass tenant/credentials
// as RTL ("copy the credentials"), but can be pointed at a separate Encompass or a
// dedicated API user later WITHOUT touching RTL. No secret VALUES ever live in
// code — only the env-var names. LT's Encompass connection is READ-ONLY (see
// src/longterm/encompass/client.js); it has NO flood/write config, deliberately.
const encompass = {
  clientId:     process.env.LT_ENCOMPASS_CLIENT_ID     || process.env.ENCOMPASS_CLIENT_ID,
  clientSecret: process.env.LT_ENCOMPASS_CLIENT_SECRET || process.env.ENCOMPASS_CLIENT_SECRET,
  instanceId:   process.env.LT_ENCOMPASS_INSTANCE_ID   || process.env.ENCOMPASS_INSTANCE_ID,
  username:     process.env.LT_ENCOMPASS_USERNAME      || process.env.ENCOMPASS_USERNAME,
  password:     process.env.LT_ENCOMPASS_PASSWORD      || process.env.ENCOMPASS_PASSWORD,
  baseUrl:      (process.env.LT_ENCOMPASS_API_BASE || process.env.ENCOMPASS_API_BASE || 'https://api.elliemae.com').replace(/\/+$/, ''),
};

module.exports = {
  env,
  databaseUrl: process.env.DATABASE_URL || '',
  sslConfig,
  encompass,
};
