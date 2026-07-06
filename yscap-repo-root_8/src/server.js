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
// Behind Render's proxy: trust the first hop so req.ip / req.secure reflect the
// real client (needed for correct rate-limiting and HSTS gating).
app.set('trust proxy', 1);
// Baseline security headers on every response (nosniff, anti-clickjacking, HSTS…).
app.use(require('./lib/security').securityHeaders);
// Body limit must comfortably exceed a max-size upload AFTER base64 inflation:
// a MAX_UPLOAD_MB-byte file becomes ~1.37x that as base64 inside the JSON body,
// plus envelope. A flat 25mb limit silently 413'd legitimate ~19-20MB uploads.
const JSON_LIMIT_MB = Math.max(25, Math.ceil(cfg.maxUploadMb * 1.4) + 4);
app.use(express.json({ limit: `${JSON_LIMIT_MB}mb` }));

// Rate limits (IP-based, in-memory) on the sensitive/unauthenticated surface.
// The per-account lockout can't stop credential-stuffing across many accounts
// or flooding of the public endpoints; this does, and it shields the scrypt
// threadpool from a login flood. Generous enough never to hit a real user.
const { rateLimit } = require('./lib/rate-limit');
app.use('/auth', rateLimit({ bucket: 'auth', windowMs: 60000, max: 30 }));   // login/register/mfa/reset
app.use('/api/intake', rateLimit({ bucket: 'intake', windowMs: 60000, max: 20 }));
app.use('/api/leads', rateLimit({ bucket: 'leads', windowMs: 60000, max: 20 }));
app.use('/api/address', rateLimit({ bucket: 'address', windowMs: 60000, max: 120 })); // autocomplete is chatty

// --- API ---
// LIVENESS health check (Render points healthCheckPath here). It reports 200 as
// long as THIS PROCESS can answer — it does NOT fail on a database blip. That is
// deliberate: a transient DB hiccup must not make the platform kill a perfectly
// healthy process (which would drop every in-flight request and surface to users
// as a wall of 502s — turning a 5-second DB blip into a full restart storm).
// Per-request handlers already answer a friendly 503 when the DB is unreachable.
// The DB is probed with a SHORT timeout so a slow/hung DB can never stall this
// endpoint itself. For a STRICT probe that fails on DB-down, call /api/health?strict=1.
app.get('/api/health', async (req, res) => {
  const db = require('./db');
  const strict = req.query.strict === '1' || req.query.deep === '1';
  let dbStatus = 'up';
  let dbError;
  try {
    // Bound the probe so this endpoint always answers fast, even if the DB hangs.
    await Promise.race([
      db.query('SELECT 1'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('health db probe timeout')), 2500)),
    ]);
  } catch (e) {
    dbStatus = 'down';
    dbError = db.describeError(e);
  }
  let storageInfo;
  try { storageInfo = require('./lib/storage').probe(); } catch (e) { storageInfo = { ok: false, error: e.message }; }
  // Liveness: 200 unless the caller explicitly asked for a strict DB gate.
  const code = (strict && dbStatus !== 'up') ? 503 : 200;
  res.status(code).json({
    ok: dbStatus === 'up',
    env: cfg.env,
    db: dbStatus,
    ...(dbError ? { dbError } : {}),
    emailProvider: cfg.emailProvider,
    emailConfigured: cfg.emailProvider === 'resend' ? !!cfg.resendApiKey
                   : cfg.emailProvider === 'graph'  ? !!(cfg.msTenantId && cfg.msClientId && cfg.msClientSecret)
                   : false,
    // False when the secret was auto-generated at boot (env var not set): every
    // restart/deploy then invalidates all sessions (jwt) or orphans encrypted
    // SSNs (ssnKey). If either is false in production, set the env var NOW.
    jwtStable: !cfg.jwtSecretGenerated,
    ssnKeyStable: !cfg.ssnKeyGenerated,
    storage: cfg.storageProvider,
    storageWritable: storageInfo && storageInfo.ok,
    storagePersistent: storageInfo && storageInfo.persistent,
    storageBase: storageInfo && storageInfo.base,
    ts: Date.now(),
  });
});
app.use('/auth', require('./auth').router);
app.use('/api/roster', require('./routes/roster'));   // public team roster (site dropdown + ?lo branding)
app.use('/api/address', require('./routes/address')); // address autocomplete/verification proxy (key stays server-side)
app.use('/api/leads', require('./routes/leads'));     // public marketing-tool submissions (saved + emailed server-side)
app.use('/api/intake', require('./routes/intake'));
app.use('/api/borrower', require('./routes/borrower'));
app.use('/api/staff', require('./routes/staff'));
// The Condition Center studio is gated by the manage_conditions capability (not
// admin-only), so an underwriter or software-setup persona granted it can author
// the library. Mounted before /api/admin so it isn't shadowed by requireRole.
{
  const { requireAuth, requirePermission } = require('./auth');
  app.use('/api/admin/conditions', requireAuth, requirePermission('manage_conditions'), require('./routes/admin-conditions'));
}
app.use('/api/admin', require('./routes/admin'));
// SSE stream (live chat/presence/receipts). Mounted OUTSIDE the authenticated
// routers: EventSource can't send an Authorization header, so this route does
// its own token verification from a query parameter.
app.use('/api/events', require('./routes/events'));

// --- Static site (your existing build drops into web/) ---
const webDir = path.join(__dirname, '..', cfg.webDir);
app.use(express.static(webDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
  // A missing FILE (anything with an extension — .css/.js/.png…) must 404, not
  // silently receive the homepage HTML. Serving HTML as a stylesheet is how a
  // stale index.html referencing a purged bundle "unstyled" the whole portal —
  // and service workers then cache that poisoned response.
  if (/\.[a-z0-9]{2,8}$/i.test(req.path)) return res.status(404).type('text/plain').send('not found');
  // A deep link under /portal/ (e.g. a hard refresh, or a link without the #)
  // must boot the SPA shell, not the marketing homepage — otherwise the portal
  // "disappears" into the public site on refresh.
  const shell = req.path.startsWith('/portal')
    ? path.join(webDir, 'portal', 'index.html')
    : path.join(webDir, 'index.html');
  res.sendFile(shell, (err) => err && res.sendFile(path.join(webDir, 'index.html'), (e2) => e2 && next()));
});

// 404 for unmatched API routes
app.use((req, res) => res.status(404).json({ error: 'not found' }));

// Final JSON error handler. Everything routed through safe-router lands here on
// a rejected promise; body-parser errors (bad JSON, payload too large) and sync
// throws land here too. Without this, Express answers with an HTML error page —
// or, for async rejections, never answers at all and the gateway returns 502.
const DB_DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P03', '53300', '08006', '08001']);
function isDbUnavailable(e) {
  if (!e) return false;
  if (DB_DOWN_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors)) return e.errors.some(isDbUnavailable);  // AggregateError
  return /terminat|timeout exceeded when trying to connect|Connection terminated/i.test(e.message || '');
}
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;   // a partial response is already on the wire
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
  if (err.type === 'entity.too.large')  return res.status(413).json({ error: 'upload too large' });
  // Postgres 22P02 = a malformed id (usually a non-UUID :id param) reached a
  // query — the request is bad, not the server.
  if (err.code === '22P02') return res.status(400).json({ error: 'invalid id' });
  if (isDbUnavailable(err)) {
    console.error(`[api] DB unavailable during ${req.method} ${req.path}:`, require('./db').describeError(err));
    return res.status(503).json({ error: 'The service is briefly unavailable — please try again in a moment.' });
  }
  console.error(`[api] unhandled error in ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
  res.status(err.status || err.statusCode || 500).json({ error: 'Something went wrong on our end — please try again.' });
});

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
    // Resolve + report the storage base up front so a bad disk mount is obvious
    // in the boot logs (rather than a surprise EACCES on the first upload).
    try {
      const sp = require('./lib/storage').probe();
      if (sp.ok) console.log(`[storage] writable at "${sp.base}"` +
        (sp.persistent ? ' (persistent disk)' : ' — TEMPORARY, NOT persistent: fix STORAGE_DIR / disk mount so uploads survive deploys'));
      else console.error(`[storage] NOT writable (configured "${sp.configured}") — uploads will fail: ${sp.error || ''}`);
    } catch (e) { console.error('[storage] probe failed:', e.message); }
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
    // Chat's deferred-notification sweeper (email-if-still-unread + urgent
    // re-pings). Cheap interval; safe to run alongside everything else.
    try { require('./lib/chat').startSweeper(); } catch (e) { console.warn('chat sweeper not started:', e.message); }
  });
}
module.exports = app;
