/**
 * YS Capital Portal — Express entrypoint.
 * Serves the existing static site (web/) UNTOUCHED and exposes the API.
 * The site's pricing/guideline engines are never imported or altered here;
 * they keep running client-side. We only add /api endpoints + hooks.
 */
const express = require('express');
const path = require('path');
const cfg = require('./config');

// A single failed request (e.g. a momentary DB outage) must never crash the
// whole service. Log and keep serving; health checks and the static site stay up.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException',  (e) => console.error('uncaughtException:',  e && e.message ? e.message : e));

const app = express();
app.use(express.json({ limit: '25mb' }));   // room for base64 document uploads

// --- API ---
// Health check probes the database so a green check means the portal can
// actually serve requests (account creation, login, etc.) — not just that the
// process is up. Returns 200 when the DB is reachable, 503 when it isn't.
app.get('/api/health', async (req, res) => {
  const db = require('./db');
  let dbStatus = 'up';
  let dbError;
  try {
    await db.query('SELECT 1');
  } catch (e) {
    dbStatus = 'down';
    dbError = db.describeError(e);
  }
  res.status(dbStatus === 'up' ? 200 : 503).json({
    ok: dbStatus === 'up',
    env: cfg.env,
    db: dbStatus,
    ...(dbError ? { dbError } : {}),
    emailProvider: cfg.emailProvider,
    emailConfigured: cfg.emailProvider === 'resend' ? !!cfg.resendApiKey
                   : cfg.emailProvider === 'graph'  ? !!(cfg.msTenantId && cfg.msClientId && cfg.msClientSecret)
                   : false,
    storage: cfg.storageProvider,
    ts: Date.now(),
  });
});
app.use('/auth', require('./auth').router);
app.use('/api/roster', require('./routes/roster'));   // public team roster (site dropdown + ?lo branding)
app.use('/api/intake', require('./routes/intake'));
app.use('/api/borrower', require('./routes/borrower'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/admin', require('./routes/admin'));

// --- Static site (your existing build drops into web/) ---
const webDir = path.join(__dirname, '..', cfg.webDir);
app.use(express.static(webDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
  res.sendFile(path.join(webDir, 'index.html'), (err) => err && next());
});

// 404 for unmatched API routes
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// One-line summary of the email configuration + a warning when it's off or
// half-configured, so a glance at the boot logs tells you if email will send.
function logEmailConfig() {
  const p = cfg.emailProvider;
  if (p === 'none') {
    console.warn('[email] EMAIL_PROVIDER=none — emails are logged only, not sent. ' +
      'Set RESEND_API_KEY (Resend) or the MS_* vars (Graph) to enable delivery.');
    return;
  }
  console.log(`[email] provider=${p} from="${cfg.notifyFrom}" appUrl=${cfg.appUrl}`);
  if (p === 'resend' && !cfg.resendApiKey)
    console.warn('[email] provider=resend but RESEND_API_KEY is empty — sends will fail.');
  if (p === 'graph' && !(cfg.msTenantId && cfg.msClientId && cfg.msClientSecret))
    console.warn('[email] provider=graph but MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET are incomplete — sends will fail.');
  const m = /<([^>]+)>|([^\s<>]+@[^\s<>]+)/.exec(cfg.notifyFrom || '');
  const fromAddr = m ? (m[1] || m[2]) : '';
  const domain = fromAddr.split('@')[1];
  if (p === 'resend' && domain)
    console.log(`[email] Resend will only deliver if "${domain}" is a verified domain in your Resend account.`);
}

if (require.main === module) {
  app.listen(cfg.port, async () => {
    console.log(`YS Capital Portal on :${cfg.port} (${cfg.env}) — email:${cfg.emailProvider} storage:${cfg.storageProvider}`);
    logEmailConfig();
    // Bring the schema up to date before anything tries to read/write it. This
    // makes a fresh database usable without a manual `npm run migrate` step.
    if (cfg.databaseUrl) {
      try {
        const { ensureSchema, bootstrapAdmin } = require('./migrate-boot');
        await ensureSchema();
        await bootstrapAdmin();   // opt-in: seeds first admin when ADMIN_EMAIL/PASSWORD set
      } catch (e) {
        console.error('[migrate] unexpected error (continuing):', require('./db').describeError(e));
      }
    }
    if (cfg.env === 'production' || process.env.RUN_SYNC === '1') {
      try { require('./sync/queue').start(); } catch (e) { console.warn('sync queue not started:', e.message); }
    }
  });
}
module.exports = app;
