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
// ClickUp webhook is mounted BEFORE the JSON parser — it needs the RAW body to
// verify the HMAC signature (it applies its own express.raw()).
app.use('/api/clickup/webhook', require('./routes/clickup-webhook'));
// #75 — inbound email → chat: an external guest's email reply lands back in the
// conversation (dormant until an inbound-email domain is configured in Resend).
app.use('/api/inbound/chat', require('./routes/inbound-chat'));
// #68 — inbound email → per-file forward: a reply to file+<appId>@<domain> is
// verified (Svix signature over the RAW body) and fanned out to every assignee.
// Mounted BEFORE the JSON parser for the same raw-body reason as the chat/ClickUp
// webhooks. Separate URL from /api/inbound/chat (which is unchanged).
app.use('/api/inbound/file-email', require('./routes/inbound-file-email'));
// DocuSign Connect webhook — RAW body for the base64 HMAC verification, mounted
// BEFORE the JSON parser for the same reason as the ClickUp/inbound webhooks.
app.use('/api/esign/webhook', require('./routes/esign-webhook'));
app.use(express.json({ limit: `${JSON_LIMIT_MB}mb` }));

// Rate limits (IP-based, in-memory) on the sensitive/unauthenticated surface.
// The per-account lockout can't stop credential-stuffing across many accounts
// or flooding of the public endpoints; this does, and it shields the scrypt
// threadpool from a login flood. Generous enough never to hit a real user.
const { rateLimit } = require('./lib/rate-limit');
app.use('/auth', rateLimit({ bucket: 'auth', windowMs: 60000, max: 30 }));   // login/register/mfa/reset
app.use('/api/intake', rateLimit({ bucket: 'intake', windowMs: 60000, max: 20 }));
app.use('/api/leads', rateLimit({ bucket: 'leads', windowMs: 60000, max: 20 }));
// #75 guest chat is magic-link (key) authenticated + public — rate-limit it.
app.use('/api/guest', rateLimit({ bucket: 'guest', windowMs: 60000, max: 90 }));
app.use('/api/address', rateLimit({ bucket: 'address', windowMs: 60000, max: 120 })); // autocomplete is chatty

// --- API ---
// The DEPLOYED V2 bundle hash, read from the portal's index.html on disk (the
// file changes atomically on deploy). Cached ~60s. The stale-build watchdog in
// StaffLayout compares this against the bundle a tab is RUNNING — it must come
// from /api/* because the service worker never intercepts /api/ (its
// cache-first asset branch was silently answering a direct index.html fetch
// from cache, defeating the watchdog — post-merge audit #271).
let _v2Bundle = null;
function v2BundleHash() {
  if (_v2Bundle && Date.now() - _v2Bundle.at < 60000) return _v2Bundle.hash;
  let hash = null;
  try {
    const html = require('fs').readFileSync(path.join(__dirname, '..', 'web', 'v2', 'portal', 'index.html'), 'utf8');
    const m = html.match(/index-([\w-]+)\.js/);
    hash = m ? m[1] : null;
  } catch (_) { /* portal bundle absent (bare API deploy) */ }
  _v2Bundle = { hash, at: Date.now() };
  return hash;
}

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
  // Missing-conditions tripwire (owner-directed 2026-07-14, after the breach):
  // a LIVE file sitting at zero checklist items, or an RTL file without its
  // purchase-contract condition, must be impossible — if it ever happens again
  // this surfaces it loudly instead of waiting for a human to notice.
  let conditionsGuard;
  if (dbStatus === 'up') {
    try {
      const g = await Promise.race([
        db.query(
          `SELECT
             count(*) FILTER (WHERE NOT EXISTS
               (SELECT 1 FROM checklist_items ci WHERE ci.application_id=a.id))::int AS zero_items,
             count(*) FILTER (WHERE
               (COALESCE(a.program,'')||' '||COALESCE(a.loan_type,'')) !~* 'dscr|rental|\\mrent\\M|long[- ]?term|30[- ]?year'
               AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                                JOIN checklist_templates t ON t.id=ci.template_id
                               WHERE ci.application_id=a.id AND t.code='rtl_p1_contract'))::int AS no_contract
             FROM applications a
            WHERE a.deleted_at IS NULL AND a.status NOT IN ('declined','withdrawn','cancelled','funded','file_intake')`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('guard timeout')), 2500)),
      ]);
      conditionsGuard = { filesZeroItems: g.rows[0].zero_items, rtlFilesMissingContract: g.rows[0].no_contract };
    } catch (e) { conditionsGuard = { error: e.message }; }
  }
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
    // SharePoint one-way sync status (config + last reconciliation pass; cheap —
    // no live Graph call on the health path).
    sharepointSync: (() => { try { return require('./lib/sharepoint-backup').health(); } catch (e) { return { enabled: false, error: e.message }; } })(),
    ...(conditionsGuard ? { conditionsGuard } : {}),
    bundle: v2BundleHash(),   // deployed V2 bundle hash — the stale-build watchdog's truth
    ts: Date.now(),
  });
});
app.use('/auth', require('./auth').router);
app.use('/api/roster', require('./routes/roster'));   // public team roster (site dropdown + ?lo branding)
// Public company pricing defaults — the marketing term-sheet generator + the
// portal studio read these live so a company-wide fee/markup change reaches
// every not-yet-registered term sheet. Never 500s the site (empty → the tool
// keeps its literals).
app.get('/api/pricing-defaults', async (req, res) => {
  try {
    const d = await require('./lib/pricing-settings').load();
    res.set('Cache-Control', 'public, max-age=60').json(d);
  } catch (e) { res.set('Cache-Control', 'no-store').json({}); }
});
app.use('/api/address', require('./routes/address')); // address autocomplete/verification proxy (key stays server-side)
app.use('/api/leads', require('./routes/leads'));     // public marketing-tool submissions (saved + emailed server-side)
app.use('/api/guest', require('./routes/guest-chat')); // #75 magic-link guest chat (key-authenticated, public)
app.use('/api/intake', require('./routes/intake'));
// Public e-signature bounce endpoint (/api/esign/return) — where a signer lands
// after signing; resolves the real destination from our DB and 302s into the
// portal. The Connect webhook (/api/esign/webhook) is mounted above, pre-JSON.
app.use('/api/esign', require('./routes/esign-public'));
// Public token-authenticated draw-findings accept (the one-click "Accept" link we email the
// borrower — the reply_token is the capability; no login needed to release their own money).
app.use('/api/public/draw-findings', rateLimit({ bucket: 'draw-public', windowMs: 60000, max: 60 }), require('./routes/draw-findings-public'));
app.use('/api/borrower', require('./routes/borrower'));
app.use('/api/borrower', require('./routes/borrower-draws')); // borrower draw status + findings accept/dispute + change requests
app.use('/api/staff', require('./routes/staff'));
// Sitewire construction-draw desk + admin. The router applies requireAuth +
// requireStaff + per-route capability gates (manage_draws / platform_setup) itself.
app.use('/api/sitewire', require('./routes/sitewire'));
// Appraisal desk: import the appraisal XML, reconcile it against the file, and resolve
// PILOT findings. The router applies requireAuth + requireStaff + per-file scoping itself.
app.use('/api/appraisal', require('./routes/appraisal'));
// The Condition Center studio is gated by the manage_conditions capability (not
// admin-only), so an underwriter or software-setup persona granted it can author
// the library. Mounted before /api/admin so it isn't shadowed by requireRole.
{
  const { requireAuth, requirePermission } = require('./auth');
  app.use('/api/admin/conditions', requireAuth, requirePermission('manage_conditions'), require('./routes/admin-conditions'));
  app.use('/api/admin/pricing', requireAuth, requirePermission('manage_pricing'), require('./routes/admin-pricing'));
}
// S1-16: a single blanket "must be authenticated staff" wall at the admin
// entrance. Each admin router still gates internally (role/permission), but this
// ensures no admin route can ever be reachable by a borrower or an anonymous
// caller — defense-in-depth so a newly-added admin route is staff-only by default.
{
  const { requireAuth, requireStaff } = require('./auth');
  // ClickUp Control Center (health, dry-run/backfill, activity, per-file re-sync).
  // The router also applies its own requireAuth + platform_setup guards.
  app.use('/api/admin/clickup', requireAuth, requireStaff, require('./routes/admin-clickup'));
  app.use('/api/admin/sharepoint', requireAuth, requireStaff, require('./routes/admin-sharepoint'));
  app.use('/api/admin', requireAuth, requireStaff, require('./routes/admin'));
}
// SSE stream (live chat/presence/receipts). Mounted OUTSIDE the authenticated
// routers: EventSource can't send an Authorization header, so this route does
// its own token verification from a query parameter.
app.use('/api/events', require('./routes/events'));

// --- Auth email link bounce -------------------------------------------------
// One-time auth links (reset / verify / accept) live in the SPA's HASH route
// (/portal/#/reset?token=…). Email click-tracking (e.g. Resend) rewrites every
// link through a tracking domain and DROPS the #fragment — so the token never
// arrives and the reset/verify page shows "link missing/expired". The email
// therefore points at a PLAIN path+query URL (which trackers preserve),
// /link/<kind>?token=…, and we bounce it into the hash route HERE, server-side,
// after the tracker is out of the loop. Never an open redirect — it only ever
// sends the browser to /portal/#/<whitelisted route>. The Location is set
// manually because res.redirect()/res.location() run encodeurl(), which would
// turn the '#' into '%23' and break the fragment.
const LINK_BOUNCE = { reset: '/reset', verify: '/verify', accept: '/accept' };
app.get('/link/:kind', (req, res, next) => {
  const portal = (cfg.portalPath || '/portal').replace(/\/+$/, '');
  // Generic route bounce (owner-reported broken notification links,
  // 2026-07-14): EVERY email deep link now travels as /link/r?to=<route> so
  // click-trackers can't eat the #fragment. Never an open redirect: the
  // Location is ALWAYS our own portal + '/#' + a sanitized route path —
  // an absolute URL or a header-injection attempt cannot survive the checks.
  if (req.params.kind === 'r') {
    let to = String(req.query.to || '/');
    if (!to.startsWith('/')) to = '/' + to;
    // printable ASCII only (kills CR/LF header injection), no protocol-relative
    // '//host' escapes, bounded length.
    if (to.startsWith('//') || to.length > 600 || !/^[\x20-\x7E]+$/.test(to) || /[<>"'\\]/.test(to)) to = '/';
    res.set('Location', `${portal}/#${to}`).status(302).end();
    return;
  }
  const route = LINK_BOUNCE[req.params.kind];
  if (!route) return next();
  const params = new URLSearchParams();
  for (const k of ['token', 'email', 'code']) {
    const v = req.query[k];
    if (v != null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  res.set('Location', `${portal}/#${route}${qs ? '?' + qs : ''}`).status(302).end();
});

// --- Static site ---
// V2 / PILOT IS THE DEFAULT (owner-directed 2026-07-14): the V2 tree (web/v2 —
// reskinned marketing, tools, and the PILOT portal bundle) serves at the ROOT,
// so every visitor lands on version 2 — homepage, /tools/*, /suite.html, and
// the /portal SPA. Version 1 is NOT deleted:
//   • /v1/**  — the original design, browsable in full (incl. /v1/portal/).
//   • the plain web/ mount stays as a fallthrough, so any file V2 doesn't
//     carry (v1 portal assets, legacy /v2/* bookmark URLs, uploads under
//     web/…) keeps resolving exactly as before.
const webDir = path.join(__dirname, '..', cfg.webDir);
const v2Dir = path.join(webDir, 'v2');

// Vanity login subdomain (owner-directed 2026-07-14): pilot.yscapgroup.com (and
// www.pilot.…) route STRAIGHT to the PILOT client login. Only the bare root on
// those hosts is redirected into the portal; assets, /api, and /portal deep
// links fall through so the SPA + API work normally under the subdomain. On the
// main domain this is a no-op. Runs before the static mounts so root doesn't
// serve the marketing homepage on the login subdomain.
const PILOT_LOGIN_HOSTS = new Set(cfg.pilotLoginHosts || []);
if (PILOT_LOGIN_HOSTS.size) {
  const portal = (cfg.portalPath || '/portal').replace(/\/+$/, '');
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];
    if (PILOT_LOGIN_HOSTS.has(host) && (req.path === '/' || req.path === '/index.html')) {
      return res.redirect(302, `${portal}/`);
    }
    next();
  });
}

// HTML entry points must NEVER be cached (owner-reported 2026-07-15 night:
// an officer's long-lived tab / cached shell ran YESTERDAY'S bundle — old
// date rendering displayed a shifted DOB, and the new screens were missing —
// while an admin who reloaded saw today's. Hashed build assets stay
// long-cached (their names change every build); the HTML that POINTS at them
// must always revalidate so a reload always lands on the current build).
const staticOpts = {
  setHeaders(res, filePath) {
    if (/\.html?$/.test(filePath)) res.set('Cache-Control', 'no-cache, must-revalidate');
    // ONLY the portal's build assets are content-hashed (safe to cache forever).
    // web/(v2/)assets/* are FIXED-NAME brand files regenerated in place (e.g.
    // the email lockup PNG) — immutable there would pin the old file for a
    // year (post-merge audit #271).
    else if (/[/\\]portal[/\\]assets[/\\]/.test(filePath)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
  },
};
app.use(express.static(v2Dir, staticOpts));            // V2 wins at the root
app.use('/v1', express.static(webDir, staticOpts));    // version 1, kept browsable
app.use(express.static(webDir, staticOpts));           // fallthrough: v1 assets + legacy /v2/* URLs
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
  // A missing FILE (anything with an extension — .css/.js/.png…) must 404, not
  // silently receive the homepage HTML. Serving HTML as a stylesheet is how a
  // stale index.html referencing a purged bundle "unstyled" the whole portal —
  // and service workers then cache that poisoned response.
  if (/\.[a-z0-9]{2,8}$/i.test(req.path)) return res.status(404).type('text/plain').send('not found');
  // A deep link under /portal/ (hard refresh, or a link without the #) must
  // boot the matching SPA shell, not a marketing homepage. /portal (and legacy
  // /v2/portal) boot the PILOT shell; /v1/portal boots the version-1 shell.
  const shell = req.path.startsWith('/v1/portal')
    ? path.join(webDir, 'portal', 'index.html')
    : (req.path.startsWith('/portal') || req.path.startsWith('/v2/portal'))
      ? path.join(v2Dir, 'portal', 'index.html')
      : req.path.startsWith('/v1')
        ? path.join(webDir, 'index.html')
        : path.join(v2Dir, 'index.html');
  res.set('Cache-Control', 'no-cache, must-revalidate');   // HTML entries never cache (same rule as staticOpts)
  res.sendFile(shell, (err) => err && res.sendFile(path.join(v2Dir, 'index.html'), (e2) => e2 && next()));
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
        // One-shot: ensure every active/closed RTL file (imported or manual) has
        // its full condition set + internal checklist. Idempotent + marker-guarded,
        // so it fills gaps once and is a fast no-op on later boots. Fire-and-forget
        // so it never delays the server coming up.
        require('./routes/borrower').backfillRtlChecklists('v3')
          .then((r) => r && !r.skipped && console.log('[boot] RTL checklist backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] RTL checklist backfill failed:', e.message));
        // One-shot: write the detailed liquidity breakdown onto files whose product
        // was registered BEFORE that logic existed (#96), so the assets condition
        // shows the required-liquidity detail without needing a re-register. Never
        // reopens an already-cleared condition. Idempotent; fire-and-forget.
        require('./lib/liquidity').backfillLiquidityConditions()
          .then((n) => n && console.log('[boot] liquidity condition backfill:', n))
          .catch((e) => console.error('[boot] liquidity backfill failed:', e.message));
        // One-shot: recompute the experience condition on co-borrower files so it
        // carries the per-borrower breakdown + each borrower's track-record link
        // (#103). Idempotent, preserves sign-offs; fire-and-forget.
        require('./lib/experience').backfillCoBorrowerExperience()
          .then((n) => n && console.log('[boot] co-borrower experience backfill:', n))
          .catch((e) => console.error('[boot] experience backfill failed:', e.message));
      } catch (e) {
        console.error('[migrate] unexpected error (continuing):', require('./db').describeError(e));
      }
    }
    // NOTE (2026-07-12 audit): the legacy `sync/queue.js` worker is intentionally
    // NOT started. It was superseded by the ClickUp sync worker below (outbound =
    // orchestrator.createForNewFile at file-start + the scoped `pushOutboxOnce`
    // drain; nothing enqueues the legacy `op='create'` job it handled). Left
    // running, its unfiltered `SELECT ... WHERE status='queued'` would grab the
    // modern `op='update'` ClickUp push jobs and mark them `done` WITHOUT pushing
    // — silently dropping outbound edits (and letting the next inbound pull revert
    // them). The ClickUp queue is now owned solely by `pushOutboxOnce`.
    // ClickUp bidirectional sync worker (self-gated by CLICKUP_SYNC_ENABLED;
    // a no-op until the master switch is on, so it's safe to wire now).
    try { require('./sync/clickup-sync').start(); } catch (e) { console.warn('clickup sync not started:', e.message); }
    // Chat's deferred-notification sweeper (email-if-still-unread + urgent
    // re-pings). Cheap interval; safe to run alongside everything else.
    try { require('./lib/chat').startSweeper(); } catch (e) { console.warn('chat sweeper not started:', e.message); }
    // Reminder/task dispatcher (#93): fires scheduled reminders at their due
    // moment via the notify fan-out. Minute cadence; self-gated + idempotent.
    try { require('./lib/reminders').startDispatcher(); } catch (e) { console.warn('reminder dispatcher not started:', e.message); }
    // SharePoint one-way sync (owner-directed 2026-07-13): mirrors every
    // document into Pipeline Drive/<Officer>/<Borrower>/<Address>/YS portal
    // syncing/<Condition>/ — write-only, never deletes, versions on supersede.
    // Self-gated by SHAREPOINT_BACKUP_ENABLED + MS_* creds; inert otherwise.
    // First run performs the full-history backfill (oldest-first).
    try { require('./lib/sharepoint-backup').start(); } catch (e) { console.warn('sharepoint sync not started:', e.message); }
    // DocuSign e-sign heartbeat: drains the Connect event inbox + send queue and
    // reconciles any in-flight envelope that went quiet (missed-webhook recovery).
    // Self-gated — inert until the DocuSign credentials are configured.
    try { require('./lib/esign/poller').start(); } catch (e) { console.warn('esign poller not started:', e.message); }
    // Sitewire draw-management sync — drains the outbound queue + reconcile poll.
    // Self-gated by SITEWIRE_ENABLED (+ SITEWIRE_OUTBOUND_ENABLED for writes); inert
    // otherwise. Manages ONLY properties PILOT created (only-ours rule).
    try { require('./sync/sitewire-sync').start(); } catch (e) { console.warn('sitewire sync not started:', e.message); }
  });
}
module.exports = app;
