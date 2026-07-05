/** Postgres pool. Uses DATABASE_URL from Render. */
const { Pool } = require('pg');
const cfg = require('./config');
const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.env === 'production' ? { rejectUnauthorized: false } : false,
});
module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
