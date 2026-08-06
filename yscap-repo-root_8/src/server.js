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
// Automatic request-level audit log — writes ONE row per HTTP request into
// `request_audit_log` (see db/252_*.sql + src/lib/request-audit.js), captured
// asynchronously so the request itself is never delayed. Complements the
// semantic audit_log (business actions) with a full request firehose:
// who called what, when, from where, with which status, in how many ms.
// Mounted here so it wraps EVERY route below — webhooks, /auth, /api, /link,
// the pixel, and SPA shell requests — with the redactor stripping tokens /
// passwords / SSNs from query + body summaries.
{
  const ra = require('./lib/request-audit');
  app.use(ra.middleware);
  app.use(ra.attachAuditError);
}
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
// TrustPoint webhook — its OWN small JSON parser + rate limit (never the global 32MB
// parser: unauthenticated callers must not force huge parses), token-authenticated.
app.use('/api/trustpoint/webhook', require('./routes/trustpoint-webhook'));
app.use(express.json({ limit: `${JSON_LIMIT_MB}mb` }));

/* THE NUL BYTE IS REMOVED ONCE, AT THE DOOR (third audit, 2026-08-02).
   Postgres cannot store U+0000 in ANY text or jsonb column — it answers 22021 /
   22P05 and the route's catch-all turns that into a 500. This was fixed three
   times at three different layers and each fix covered only what its author
   enumerated: `fields.textColumn` for a handful of text columns, then
   `fields.jsonbText` for the jsonb binds, and the audit STILL found the public
   lead door 500-ing on a NUL in the visitor's own `name` box, the public intake
   door losing an entire application on a NUL in `firstName`, and both borrower
   profile doors 500-ing on `citizenship` — on the very doors whose jsonb binds
   had just been converted.

   Enumerating binds fails for the same reason enumerating doors failed. A NUL is
   never meaningful in a JSON request to this API: no field wants one, nobody can
   type one, and every storage layer refuses it. So it is stripped from every
   string in every parsed body, once, here — and the two helpers stay as
   belt-and-suspenders for values that arrive some other way (a webhook mounted
   above this line, a ClickUp pull, a parsed document).

   Mounted AFTER express.json (it needs the parsed body) and BEFORE every route.
   The webhook routers above deliberately sit in front of the JSON parser and are
   therefore untouched — they carry external payloads through their own parsers.
   Depth- and breadth-bounded so a hostile body cannot make this the expensive
   part of a request, and never throws: a body it cannot walk is left alone
   rather than turned into a 500 of its own. */
app.use(require('./lib/nul-strip').middleware);

// Rate limits (IP-based, in-memory) on the sensitive/unauthenticated surface.
// The per-account lockout can't stop credential-stuffing across many accounts
// or flooding of the public endpoints; this does, and it shields the scrypt
// threadpool from a login flood. Generous enough never to hit a real user.
const { rateLimit } = require('./lib/rate-limit');
app.use('/auth', rateLimit({ bucket: 'auth', windowMs: 60000, max: 30 }));   // login/register/mfa/reset
app.use('/api/intake', rateLimit({ bucket: 'intake', windowMs: 60000, max: 20 }));
app.use('/api/apply', rateLimit({ bucket: 'apply', windowMs: 60000, max: 10 }));   // public application submit (creates real files)
app.use('/api/leads', rateLimit({ bucket: 'leads', windowMs: 60000, max: 20 }));
// #75 guest chat is magic-link (key) authenticated + public — rate-limit it.
app.use('/api/guest', rateLimit({ bucket: 'guest', windowMs: 60000, max: 90 }));
app.use('/api/address', rateLimit({ bucket: 'address', windowMs: 60000, max: 120 })); // autocomplete is chatty
// The pricing-admin unlock is a PASSWORD door with no login in front of it
// (owner-directed: staff working from a shared term-sheet link must be able to
// open the pricing controls). The password check moved off the browser, so the
// only remaining attack is guessing — rate-limit it hard. Staff type it once.
app.use('/api/pricing-admin', rateLimit({ bucket: 'pricing-admin', windowMs: 60000, max: 10 }));

// A PER-USER API answer must never be STORED by the browser.
//
// Express answers a GET with an ETag and no Cache-Control, which makes these
// responses heuristically cacheable in the browser's PRIVATE cache (a shared
// cache would refuse them because the request carries Authorization — a private
// one is allowed to keep them). The browser then revalidates with If-None-Match,
// and on a 304 it hands JavaScript the STORED response's HEADERS, not the 304's.
// Two things followed from that, both owner-reported:
//   • the stored response's `X-Refresh-Token` (see the sliding session in
//     src/auth/index.js) was replayed on every later 304 and overwrote the LIVE
//     token with the one minted in some earlier session. Once that replayed
//     token aged past its 30-day life the next request answered `bad_token` and
//     the SPA signed the user out — seconds after they signed in, on a correct
//     password. It is also why "it works after I clear my site data" kept being
//     the only cure: clearing the cache drops the poisoned entry.
//   • on a shared device the cache could serve one person's JSON to the next.
// `no-store` ends both. It is a DEFAULT, not a law: the deliberately public
// endpoints (/api/roster, /api/address, /api/pricing-defaults) set their own
// Cache-Control inside their handlers, which run after this and win.
app.use(['/api', '/auth'], (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

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
    // Log the full detail (host:port, pg message) server-side only; the health
    // endpoint is publicly reachable, so the client body carries just a generic
    // signal — never the DB host/port or pg internals.
    console.warn('[health] db probe failed:', db.describeError(e));
    dbError = 'database unreachable';
  }
  let storageInfo;
  try { storageInfo = require('./lib/storage').probe(); } catch (e) { storageInfo = { ok: false, error: e.message }; }
  // Storage CARD (owner-directed 2026-07-26, after the R2 cutover). The flat storage* fields
  // below only say whether the settings are present; for an object store that is not the same
  // as "the bucket answers". This does a real, time-bounded round-trip when the provider
  // supports one, so a revoked token surfaces here instead of on a borrower's upload.
  let storageCard;
  try {
    // `swr` — serve the last known verdict instantly and refresh in the background. Only the very
    // first caller (no verdict yet) ever waits. This endpoint is Render's health check AND is
    // polled by every open tab, so it must never pay a full storage timeout on a TTL boundary.
    storageCard = await require('./lib/storage-health')
      .readStorageHealth(require('./lib/storage'), cfg.storageProvider, { swr: true });
    // Shape parity on failure: return the canonical 8-field card (all-null) rather than a partial
    // object, so a consumer reading e.g. `.configured` never gets `undefined`.
    // Shape parity on failure: the canonical 8-field card, and carry the FAILURE as the reason —
    // a bare card would read back the reassuring "local disk" line even though the read threw.
  } catch (e) {
    storageCard = require('./lib/storage-health')
      .buildStorageCard({ provider: cfg.storageProvider, probe: { ok: false, error: 'storage health unavailable' } });
  }
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
    } catch (e) { console.warn('[health] conditions guard failed:', db.describeError(e)); conditionsGuard = { error: 'unavailable' }; }
  }
  // Off-site backup status (owner-directed 2026-08-02). "Are we protected right now?" has to be
  // answerable without opening a bucket — a backup job that quietly stopped is the failure this
  // whole system exists to prevent, and it is invisible by nature. Read-only, time-bounded, and
  // deliberately WITHOUT sizes, table counts or bucket names: this endpoint is public.
  let backupStatus;
  if (dbStatus === 'up') {
    try {
      const s = await Promise.race([
        require('./lib/backup/report').protectionStatusCached(db),
        new Promise((_, rej) => setTimeout(() => rej(new Error('backup status timeout')), 2500)),
      ]);
      backupStatus = {
        protected: s.protected,
        lastBackupAt: s.lastBackupAt,
        lastBackupAgeHours: s.lastBackupAgeHours,
        lastVerifiedAt: s.lastVerifiedAt,
        verificationFresh: s.verificationFresh,
      };
    } catch (e) { backupStatus = { protected: null, error: 'unavailable' }; }
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
    // The full card (provider, live reachability, dual-read migration state). The four flat
    // fields above are kept verbatim for back-compat with anything already reading them.
    storageHealth: storageCard,
    // `protected:false` means the nightly off-site backup has not succeeded recently — act on it.
    backup: backupStatus,
    // `ok:false` means the database-level rule that keeps a Google-sourced coordinate
    // out of the permanent property warehouse (db/459) is not confirmed installed.
    // A licensing control, so it is reported rather than assumed.
    //
    // DELIBERATELY ONLY THE VERDICT. This endpoint is PUBLIC (see the storage and
    // backup blocks above, scrubbed for the same reason), and the guard's own
    // `why` carries a database error verbatim — host, port, role name — plus a
    // count of violating rows. "The licensing control is OFF and 37 rows breach
    // it" is a sentence for the boot log and for staff, not for anonymous callers.
    //
    // BUT A QUALIFIED YES MUST NOT READ AS A PLAIN ONE. `ok:true` alone is
    // published for two different states: the database was ASKED to store a Google
    // coordinate and refused, and the constraint's TEXT merely reads right while
    // the write probe could not run (an unrelated CHECK, a new NOT NULL column, a
    // read-only replica). The boot log and the staff card already distinguish
    // them — this endpoint flattened both to green, which was measured on a
    // shadowed `lower()` where a Google coordinate was in fact being STORED.
    // `confirmedByWrite` is one boolean and leaks nothing: no `why`, no counts, no
    // host names, no constraint names.
    researchGeoLicensing: (() => {
      try {
        const h = require('./lib/research/licensing-guard').health();
        // `confirmedByWrite` answers ONE question — "did the database itself confirm
        // the rule is on?" — so it is only ever true alongside `ok`. The probe ran on
        // the NOT-INSTALLED path too (that is how it proves nothing stops a Google
        // coordinate), and reporting `confirmedByWrite:true` there said a write had
        // confirmed a warehouse that has no licensing constraint at all. `ok:false`
        // already dominates every screen, so nobody was shown green — but the boolean
        // itself was untrue, and a boolean nobody can read literally is worse than no
        // boolean.
        return { ok: !!h.ok, checked: !!h.checked,
          confirmedByWrite: h.ok === true && h.probeTested === true,
          at: h.at || null };
      } catch (_e) { return { ok: false, checked: false, confirmedByWrite: false, at: null }; }
    })(),
    // SharePoint one-way sync status (config + last reconciliation pass; cheap —
    // no live Graph call on the health path).
    sharepointSync: (() => { try { return require('./lib/sharepoint-backup').health(); } catch (e) { return { enabled: false, error: e.message }; } })(),
    // Document-AI (PILOT underwriting) reachability: whether the reader + analyzer are configured,
    // plus each endpoint's circuit-breaker state (closed = healthy; open = paused after repeated
    // failures — a sustained Azure outage or a bad key shows here instead of failing silently).
    documentAi: (() => {
      try {
        return {
          reader: require('./lib/ai/docint').configured(),
          analyzer: require('./lib/ai/azure-openai').available(),
          breakers: require('./lib/ai/resilience').snapshotBreakers(),
        };
      } catch (e) { return { error: e.message }; }
    })(),
    ...(conditionsGuard ? { conditionsGuard } : {}),
    bundle: v2BundleHash(),   // deployed V2 bundle hash — the stale-build watchdog's truth
    ts: Date.now(),
  });
});
// BORROWER VIEW guard (owner-directed 2026-07-26) — mounted GLOBALLY, ABOVE
// every router (including /auth), so the handful of actions a staffer may not
// perform while standing inside a borrower's portal are refused STRUCTURALLY:
// executing an e-signature in the borrower's name, changing their two-factor
// settings, signing the REAL borrower out of their own devices (/auth/logout
// bumps their token_version), or nesting another borrower view. Position
// matters — mounted after /auth it would not cover the /auth routes at all.
// A borrower route added tomorrow inherits the guard automatically; there is no
// per-handler check to forget. Inert for every ordinary request: it returns on
// the first line unless the bearer token actually carries a borrower-view
// envelope. See src/lib/borrower-view.js.
app.use(require('./lib/borrower-view').guard);
// Same shape for a BORROWER ASSISTANT — a standing helper login the borrower
// authorized. Mounted above /auth so it can refuse the borrower credential
// routes (/auth/logout bumps the BORROWER's token_version; /auth/mfa changes the
// borrower's second factor). Inert unless the bearer token carries the assistant
// envelope. See src/lib/borrower-assistant.js.
app.use(require('./lib/borrower-assistant').guard);
app.use('/auth', require('./auth').router);
app.use('/api/roster', require('./routes/roster'));   // public team roster (site dropdown + ?lo branding)
// Public company pricing defaults — the marketing term-sheet generator + the
// portal studio read these live so a company-wide fee/markup change reaches
// every not-yet-registered term sheet. Never 500s the site (empty → the tool
// keeps its literals).
//
// WHY THE MARKUP IS STILL IN THIS RESPONSE (audited 2026-08-03; do not "fix" it
// by deleting the field). The static tool computes the borrower NOTE RATE in the
// browser — `syncAdminMarkup()` pushes these percentages into the frozen engines
// via YSP/GSP/SVP.setMarkup() on every recompute — so the number has to reach the
// page or the quoted rate is wrong. Dropping it here would NOT make it secret
// either: the same figures are compiled into the shipped engines (MARKUP = 0.005)
// and into termsheet.js's own `CO` literals. All it would do is sever the owner's
// central control (Pricing Admin Center → every new term sheet), which is the one
// thing this endpoint exists for. The real fix is moving quoting server-side so
// only the OUTPUT rate crosses the wire; until then:
//   • `private` (not `public`) so CDNs, proxies and crawlers can't store and
//     re-serve the margin — the browser still caches it for 60s, so the tool is
//     exactly as fast as before.
//   • noindex so it can never turn up in a search result.
app.get('/api/pricing-defaults', async (req, res) => {
  try {
    const d = await require('./lib/pricing-settings').load();
    res.set('X-Robots-Tag', 'noindex');
    res.set('Cache-Control', 'private, max-age=60').json(d);
  } catch (e) { res.set('Cache-Control', 'no-store').json({}); }
});
// Pricing-admin unlock (see src/routes/pricing-admin.js). Deliberately mounted
// with the PUBLIC routes and deliberately unauthenticated: the password is the
// credential, so a staffer on a shared term-sheet link can still open the panel.
app.use('/api/pricing-admin', require('./routes/pricing-admin'));
app.use('/api/address', require('./routes/address')); // address autocomplete/verification proxy (key stays server-side)
app.use('/api/leads', require('./routes/leads'));     // public marketing-tool submissions (saved + emailed server-side)
app.use('/api/guest', require('./routes/guest-chat')); // #75 magic-link guest chat (key-authenticated, public)
app.use('/api/intake', require('./routes/intake'));
// The site's OWN application submit (public, bot-defended with the shared form
// token + honeypot) — same intake core as /api/intake, plus the immediate
// create-your-login step. No more mail-client fallbacks on the marketing site.
app.use('/api/apply', require('./routes/apply'));
// Public e-signature bounce endpoint (/api/esign/return) — where a signer lands
// after signing; resolves the real destination from our DB and 302s into the
// portal. The Connect webhook (/api/esign/webhook) is mounted above, pre-JSON.
app.use('/api/esign', require('./routes/esign-public'));
// Public token-authenticated draw-findings accept (the one-click "Accept" link we email the
// borrower — the reply_token is the capability; no login needed to release their own money).
app.use('/api/public/draw-findings', rateLimit({ bucket: 'draw-public', windowMs: 60000, max: 60 }), require('./routes/draw-findings-public'));
// Start / leave / audit a borrower view. Mounted outside /api/staff because the
// leave + status calls are made while holding a BORROWER-kind token.
app.use('/api/borrower-view', require('./routes/borrower-view'));
app.use('/api/borrower', require('./routes/borrower'));
app.use('/api/borrower', require('./routes/borrower-draws')); // borrower draw status + findings accept/dispute + change requests
app.use('/api/staff', require('./routes/staff'));
// Sitewire construction-draw desk + admin. The router applies requireAuth +
// requireStaff + per-route capability gates (manage_draws / platform_setup) itself.
app.use('/api/sitewire', require('./routes/sitewire'));

// TrustPoint mirror (physical-draw workflow phases 2-3): the STAFF router (auth wall
// + per-route capability gates). The public webhook is mounted earlier, pre-parser.
app.use('/api/trustpoint', require('./routes/trustpoint'));
// Appraisal desk: import the appraisal XML, reconcile it against the file, and resolve
// PILOT findings. The router applies requireAuth + requireStaff + per-file scoping itself.
app.use('/api/appraisal', require('./routes/appraisal'));
// AMC appraisal-ordering desk (AppraisalScope / CoreLogic Digital Gateway): the new
// "Order an appraisal" section beside the Title / Insurance / Attorney orders. Same
// auth wall + per-file scoping as the draw desk. Inert until the AMC switches are on
// (src/amc/**, db/477); RTL only.
app.use('/api/amc', require('./routes/amc'));
// The research desk: the cross-file property / comparable / appraiser database built
// out of every appraisal XML we have ever imported (db/415), its search engine, and
// the build-your-own valuation grid (db/410). Staff-wide by design — it holds
// addresses, property characteristics and recorded sale prices, no borrower data —
// so the router applies requireAuth + requireStaff itself and does NOT scope per file.
app.use('/api/research', require('./routes/research'));
// Dashboards: the KPI screen every staff member lands on, and the builder they use to make
// their own. Staff-only as a whole router; every card's query is scoped to the CALLER's
// files inside the compiler (src/lib/dashboards/compile.js), so a shared dashboard shares
// the question and never the answer.
app.use('/api/dashboards', require('./routes/dashboards'));
// Document-underwriting desk: read + understand each uploaded document (Azure Document
// Intelligence + Azure OpenAI), raise per-document and cross-document findings, and let an
// underwriter post conditions / request documents / clear them. Same auth + per-file scoping.
app.use('/api/underwriting', require('./routes/underwriting'));
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
  // API Health — the status of every external API / integration (config presence + live reach).
  // The router applies its own requireAuth + platform_setup guards.
  app.use('/api/admin/integrations', requireAuth, requireStaff, require('./routes/admin-integrations'));
  // Encompass READ-ONLY admin routes (owner-directed 2026-07-22): the cached
  // tenant field catalog + per-file cached raw loan JSON + refresh triggers.
  // The router applies its own requireAuth + platform_setup guards, and every
  // "pull" endpoint is structurally read-only (see src/lib/integrations/encompass.js).
  app.use('/api/admin/encompass', requireAuth, requireStaff, require('./routes/admin-encompass'));
  // Manual Program admin config + the super-admin escalation box. Each route
  // adds its own capability/role gate (manage_pricing for settings, super_admin
  // to decide an escalation).
  app.use('/api/admin/manual-programs', requireAuth, requireStaff, require('./routes/admin-manual-programs'));
  // Loan policy exceptions — the super-admin review box (owner-directed 2026-07-22).
  // Today: co-borrower guaranty waivers. list/count = manage_pricing; decide = super_admin.
  app.use('/api/admin/exceptions', requireAuth, requireStaff, require('./routes/admin-exceptions'));
  // Sovereign 4/4 admin surface — training proposals queue (owner-directed 2026-07-21).
  app.use('/api/admin/training', requireAuth, requireStaff, require('./routes/admin-training'));
  // Azure Custom labeling console — super-admins tag past documents to train
  // the classifier + neural extractors (owner-directed 2026-07-22, R3.3).
  app.use('/api/admin/labeling', requireAuth, requireStaff, require('./routes/admin-labeling'));
  // Sovereign Insights portfolio dashboard (owner-directed 2026-07-22, R2.6).
  app.use('/api/admin/insights', requireAuth, requireStaff, require('./routes/admin-insights'));
  // Pipeline V2 vendor health (owner-directed 2026-07-26, Phase 1e): a LIVE reachability
  // check for every document/AI vendor reached through the new Layer-2 adapter contract, so
  // the owner can prove each key works once entered. Read-only; the router adds requireStaff.
  app.use('/api/admin/pipeline', requireAuth, requireStaff, require('./routes/admin-pipeline'));
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

// --- Email OPEN tracking pixel -----------------------------------------------
// A per-recipient notification email embeds <img src="/e/o/<notificationId>.gif">.
// When the recipient's email client loads it, we stamp the open (email_opens,
// db/194) so the Email Center can show whether/when the borrower opened it.
// PUBLIC + best-effort: it reveals nothing, always returns a 1x1 transparent GIF,
// and the FK to notifications means a guessed/bogus id can't create a junk row.
const OPEN_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Generous per-IP cap so a pathological flood can't hammer the DB, but high enough
// that a shared email-image proxy (Gmail routes many users' opens through a few
// IPs) never suppresses a legitimate open. Best-effort: real open volume for this
// shop is far below this.
app.use('/e/o', rateLimit({ bucket: 'open-pixel', windowMs: 60000, max: 600 }));
app.get('/e/o/:token', async (req, res) => {
  const sendPixel = () => {
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.end(OPEN_GIF);
  };
  const id = String(req.params.token || '').replace(/\.(gif|png|jpg|jpeg)$/i, '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return sendPixel();
  try {
    await require('./db').query(
      `INSERT INTO email_opens (notification_id, first_opened_at, last_opened_at, open_count, first_ua, last_ip)
       VALUES ($1, now(), now(), 1, $2, $3)
       ON CONFLICT (notification_id)
         DO UPDATE SET last_opened_at = now(), open_count = email_opens.open_count + 1,
                       last_ip = EXCLUDED.last_ip`,
      [id, String(req.get('user-agent') || '').slice(0, 300), String(req.ip || '').slice(0, 60)]);
  } catch (_) { /* bogus/absent id (FK) or a DB blip — never fail the pixel */ }
  sendPixel();
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
        // ensureSchema NEVER throws — a failed migration logs and continues, which
        // is right for a schema change and wrong for a CONTROL. Ask the database
        // out loud whether the Google-coordinate licensing rule (db/459) is
        // actually installed, so it can never be silently absent. Reports only;
        // never blocks the boot — and its OWN try/catch, because a throw from the
        // `require` itself would otherwise skip bootstrapAdmin() and every boot
        // backfill queued after it.
        try { await require('./lib/research/licensing-guard').assertGeoLicensing(); }
        catch (e) { console.error('[research] licensing check could not run:', e.message); }
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
        // Previous-files fix: appraisals imported before the photo feature (or before a PDF was
        // available) have empty galleries. Re-extract photos from each current appraisal's
        // recoverable PDF (embedded XML or the uploaded PDF slot). Bounded per boot, self-draining,
        // idempotent, fire-and-forget.
        require('./lib/appraisal/desk').backfillAppraisalPhotosOnce()
          .then((r) => r && r.filled && console.log('[boot] appraisal photo backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] appraisal photo backfill failed:', e.message));
        // The dashboards every staff member lands on are ordinary rows, so they are seeded
        // rather than hardcoded — which is what makes them inspectable and forkable. Keyed
        // on slug, so this reaches EXISTING staff on the next boot, not only new ones, and
        // a dashboard an admin has since edited is left exactly as they left it.
        require('./lib/dashboards/seed').seedDefaults()
          .catch((e) => console.error('[boot] dashboard seed failed:', e.message));
        // Previous-files fix (owner-reported 2026-08-02): galleries extracted before photographs
        // were told apart from the form's own artwork are stored in raw page order, so the
        // appraiser's signature outranks the subject front photo and shows as the property's main
        // picture. Re-extract + re-order those. Bounded per boot, self-draining, fire-and-forget.
        require('./lib/appraisal/desk').backfillAppraisalPhotoKindsOnce()
          .then((r) => r && r.refreshed && console.log('[boot] appraisal photo re-classify:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] appraisal photo re-classify failed:', e.message));
        // Previous-files fix: appraisals imported before the As-Is/ARV comp-grid split have every
        // comp stored as 'unknown', so the report shows one mixed grid instead of two. Re-run the
        // extractor on each pre-split appraisal's stored XML and write back the per-comp grid.
        require('./lib/appraisal/desk').backfillAppraisalCompSplitOnce()
          .then((r) => r && r.split && console.log('[boot] appraisal comp-split backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] appraisal comp-split backfill failed:', e.message));
        // RE-KEY THE WAREHOUSE BEFORE ANYTHING ELSE TOUCHES IT. `address_key` IS a
        // property's identity, so a change to how it is computed does not fail
        // loudly — it silently MINTS A DUPLICATE the next time a report arrives
        // about a house we already hold. Runs ahead of the research back-fill for
        // that reason. Bounded per boot, self-draining, never throws.
        require('./lib/research/rekey').rekeyOnce(require('./db'))
          .then((r) => (r.rekeyed || r.merged || r.errors.length)
            && console.log('[boot] property re-key:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] property re-key failed:', e.message));
        // THE ONLY THING THAT HEALS A PARSER BUG ON A REPORT ALREADY IMPORTED.
        // Re-ingesting the warehouse cannot: it reads the STORED comparable rows,
        // which are the ones the parser wrote wrong. Re-parses the source XML and
        // rewrites the grid fields, drained by `comp_parse_version` (db/427).
        require('./lib/appraisal/desk').backfillComparableParseOnce()
          // ALWAYS LOG WHEN IT LOOKED AT ANYTHING. Gating on `rewritten` printed
          // NOTHING for a sweep that read fifty reports and repaired none — an
          // operator sees silence and reads it as "nothing to do", which is the
          // no-silent-caps rule this codebase already learned once.
          .then((r) => r && r.scanned && console.log('[boot] comparable grid re-parse:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] comparable grid re-parse failed:', e.message));
        // Previous files (owner-directed 2026-07-30): evaluate the note-buyer appraisal checks
        // (EMCAP) for open EMCAP files that already have an imported appraisal but no note-buyer
        // findings yet. Bounded per boot, idempotent (the sync diffs by code), fire-and-forget.
        require('./lib/appraisal/desk').backfillNoteBuyerFindingsOnce()
          .then((r) => r && r.synced && console.log('[boot] note-buyer appraisal checks backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] note-buyer appraisal checks backfill failed:', e.message));
        // PREVIOUS FILES for the email-signature filter (owner-reported 2026-08-03:
        // the tiny pictures out of a title / insurance agent's signature "still
        // coming in as documents … we still need to manually reject it on every
        // file"). The July filter stops NEW ones; db/420 then pulled every OLD one
        // into its condition, where the team has been rejecting them by hand. This
        // retires them — is_current=false, nothing deleted, decided by the SAME
        // classifier the inbound sinks run. Bounded, self-draining, idempotent.
        // Off with ORDER_SIGNATURE_RETIRE_DISABLED=1.
        require('./lib/order-signature-retire')
          .retireSignatureImagesOnce({ limit: Number(process.env.ORDER_SIGNATURE_RETIRE_BOOT || 200) })
          .then((r) => r && r.retired && console.log('[boot] email-signature image retirement:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] email-signature image retirement failed:', e.message));
        // BACK-DATE THE RESEARCH DATABASE (owner-directed 2026-08-02: "open and back date
        // this database — on every single file that we have already in XML, all the
        // comparables that he used should be saved into that database"). Folds every
        // appraisal we have ever imported into the cross-file property / comparable /
        // appraiser warehouse (db/415). Oldest report first, so the final state matches
        // what we would have reached by filing each report as it arrived.
        //
        // Bounded per boot and SELF-DRAINING: the ingest ledger records each report, so
        // each boot picks up where the last one stopped and a fully-folded corpus makes
        // this a single empty query. Idempotent, never throws, fire-and-forget.
        require('./lib/research/ingest').backfill(require('./db'), { limit: 400 })
          .then((r) => r && r.ingested && console.log('[boot] research warehouse backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] research warehouse backfill failed:', e.message));
        // THE XMLs THAT ARE ALREADY ON THE FILES (db/462, owner-directed 2026-08-04).
        // The backfill above walks `appraisals` — reports that imported CLEANLY onto a
        // loan file. It cannot see an appraisal data file that only ever existed as a
        // stored document: attached by a borrower, filed on a condition other than the
        // appraisal one, dropped in an unnamed slot, or belonging to an import that
        // failed. Every one of those still carries a full grid of comparable sales we
        // have already paid for. `xml-catch` closes those doors going forward; this is
        // the previous half. Bounded, self-draining (each document is stamped whatever
        // the verdict — but NEVER when the read itself failed), never touches a loan
        // file, never throws. Off with RESEARCH_XML_SWEEP_DISABLED=1.
        require('./lib/research/xml-sweep').sweepOnBoot(require('./db'))
          .catch((e) => console.error('[boot] research XML sweep failed:', e.message));
        // PUTTING THOSE PROPERTIES ON THE MAP (db/412) — what makes "find me every
        // comparable within half a mile" possible. Only comparables the appraiser's
        // own software happened to geocode carry coordinates, and a SUBJECT property
        // never does, so the radius search had almost nothing to filter.
        //
        // Two free, keyless services (US Census, then OpenStreetMap) and the answer
        // is stored permanently — deliberately not Google, whose terms cap a stored
        // coordinate at 30 days and would turn a one-off lookup into a monthly bill
        // for a number that never moves (docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md).
        //
        // Paced and bounded per boot, ordered by how often a property actually turns
        // up in the reports so the useful ones are placed first, and SELF-DRAINING
        // (every row it looks at is stamped, so an address nobody can place is not
        // re-asked forever). Off-switch RESEARCH_GEOCODE_DISABLED=1.
        require('./lib/research/geocode').backfillGeocodes(require('./db'),
          { limit: Number(process.env.RESEARCH_GEOCODE_BOOT || 120) })
          .then((r) => r && r.looked && console.log('[boot] research geocoding:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] research geocoding failed:', e.message));
        // PREVIOUS AND FUTURE for the warehouse's own roll-up (db/414). `properties`
        // is derived from the observations, but the roll-up only runs when a report
        // TOUCHES a property — so widening what rolls up (the facts the reports have
        // always stated and the search could not reach) would leave every property
        // already in the database behind, with a NULL in each new column and a
        // filter that quietly returns almost nothing. This drains that through the
        // ONE definition of the roll-up. Bounded, most-observed first, self-draining
        // via `rollup_version`; a future fact is a column, a mapping and a bump.
        require('./lib/research/ingest').rerollStaleProperties(require('./db'),
          { limit: Number(process.env.RESEARCH_REROLL_BOOT || 500) })
          .then((r) => r && r.rerolled && console.log('[boot] research roll-up refresh:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] research roll-up refresh failed:', e.message));
        // PLACE THE PROPERTIES WE LENT ON. Every subject in the warehouse is
        // unplaced — appraisers give coordinates for their COMPARABLES, not for
        // the subject — so the property the loan is secured against is the one
        // no radius search or map can find. Three comparables with coordinates
        // and a stated distance fix it; measured on the real corpus, 98 of 102
        // reports resolve to within a median of 17 feet. Fill-only, stamped
        // `geo_source='comp_trilateration'` so nothing mistakes an estimate for
        // a measurement, bounded and self-draining. Off with
        // RESEARCH_PLACE_SUBJECTS_BOOT=0.
        (() => {
          const ps = require('./lib/research/place-subjects');
          return ps.placeSubjectsOnce(require('./db'),
            { limit: Number(process.env.RESEARCH_PLACE_SUBJECTS_BOOT || 200) })
            .then((r) => { const s = ps.describePass(r); if (s) console.log('[boot] subject placement:', s); });
        })().catch((e) => console.error('[boot] subject placement failed:', e.message));
        // db/440 — the adjustment lines as rows, for observations already stored.
        // Reads the jsonb each observation already carries, so it needs no
        // re-parse; bounded and self-draining (an observation with rows is never
        // picked again).
        require('./lib/research/ingest').backfillAdjustmentRowsOnce(require('./db'),
          { limit: Number(process.env.RESEARCH_ADJUSTMENT_BACKFILL || 2000) })
          // GATED ON `scanned`, NOT `written`. A pass that looked at 2,000 rows and
          // wrote none is the single most important thing an operator can be told,
          // and gating on `written` printed silence — which reads as "nothing to
          // do". The comparable re-parse three blocks up documents this exact
          // lesson; this call had not learned it.
          .then((r) => r && r.scanned && console.log('[boot] adjustment corpus backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] adjustment corpus backfill failed:', e.message));
        // NOTE: the As-Is / ARV read is GOING FORWARD ONLY (owner-directed 2026-07-28) — a deliberate
        // exception to the previous-AND-future rule, because that sweep WRITES loan values and
        // re-reading the back book would rewrite numbers on files people have already worked, all at
        // once, unwatched. New appraisal imports are read; old ones are left alone. The sweep still
        // exists (desk.backfillAsIsReadsOnce) behind APPRAISAL_ASIS_SWEEP_FILES for a deliberate,
        // bounded, hand-run pass — it is intentionally NOT booted here.
        // Email Center history (owner-directed 2026-07-20): mirror the prior
        // notification + inbound-reply history into the email_messages store so
        // every file's new Email Center shows its BACKDATED history. Lightweight
        // rows (body rendered on demand); bounded per boot, idempotent, self-
        // resuming (WHERE NOT EXISTS + unique indexes) until fully drained.
        require('./lib/email-log').backfillEmailHistoryOnce()
          .then((r) => r && (r.notifs || r.inbound) && console.log('[boot] email history backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] email history backfill failed:', e.message));
        // Investor-Specific Soft Guidelines (ISG-2, owner-directed 2026-07-23): seed the
        // per-note-buyer condition guidelines from the checked-in CorrFirst "Fix & Flip
        // Purchase" spec into note_buyer_conditions. Idempotent (ON CONFLICT), never throws.
        // Previous-files fix (owner-reported 2026-07-26): addresses that the
        // keyless geocode fallback overwrote with the raw OpenStreetMap display
        // name ("26, South 10th Street, Williamsburg, Brooklyn, Kings County,
        // New York, 11249, United States") are rewritten to the mailing form
        // ClickUp shows ("26 S 10th St, Brooklyn, NY 11249, USA"). Only touches
        // records that ARE in the long form; idempotent, bounded, self-draining.
        // Owner-reported 2026-07-26 evening: the sync-review queue filled with
        // "Borrower home address" rows where both sides were the SAME address
        // written differently (", USA", "Apt 4d" vs "4D", "Avenue" vs "Ave", the
        // municipality vs the mailing city). Retire those; a real difference —
        // house number, street, ZIP, state, unit — stays open for a human.
        require('./lib/address-review-close').closeEquivalentAddressReviewsOnce()
          .then((r) => r && r.closed && console.log('[boot] address reviews auto-closed:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] address review close failed:', e.message));
        // Owner-reported 2026-07-28: rows a reviewer had ALREADY dismissed came
        // back, and one conflict could hold two open cards, because the guard was
        // keyed on the Encompass LOAN the conflict arrived on rather than on the
        // person + the address. The producer is fixed; this retires the rows that
        // already piled up. Exactly one card per question always survives.
        require('./lib/address-review-close').closeSupersededAddressReviewsOnce()
          .then((r) => r && (r.closedDecided || r.closedDuplicate)
            && console.log('[boot] superseded address reviews retired:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] superseded address review close failed:', e.message));
        require('./lib/address-heal').healProviderLongAddressesOnce()
          .then((r) => r && r.fixed && console.log('[boot] address format repair:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] address format repair failed:', e.message));
        // Previous-files fix (owner-reported 2026-08-02: "one track record has twice
        // the same address"). Four writers each invented their own dedupe key, so the
        // same property arriving from two sources became two lines. The CAUSE is fixed
        // at the shared chokepoint (lib/track-record-key); this re-keys every existing
        // row from that one function and RAISES A REVIEW CARD for each duplicate it
        // finds. It merges NOTHING on its own — owner-directed 2026-08-02, "never
        // before human review" — the merge runs only when a reviewer approves the
        // card. Runs AFTER the address repair on purpose: that pass rewrites the
        // addresses this one reads. Bounded, resumable, idempotent; never blocks boot.
        require('./lib/track-record-heal').healOnce()
          .then((r) => r && (r.rekeyed || r.proposed)
            && console.log('[boot] track-record duplicates for review:', JSON.stringify({ ...r, left: r.left.length })))
          .catch((e) => console.error('[boot] track-record dedupe failed:', e.message));
        // Previous files (owner-reported 2026-08-02: the borrower's own deals with
        // US were the ones missing from their track record). Both funded doors now
        // record the deal going forward; this walks the loans already funded, once,
        // from a durable cursor. Idempotent — a property already on the record is
        // filled, never duplicated.
        require('./lib/track-record-from-file').backfillFundedOnce()
          .then((r) => r && (r.added || r.filled)
            && console.log('[boot] funded deals onto track records:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] funded track-record backfill failed:', e.message));
        // GOOGLE COORDINATES ARE KEPT ONLY AS LONG AS GOOGLE ALLOWS (db/413,
        // owner-authorized 2026-08-02). Maps Platform permits keeping a `place_id`
        // indefinitely and caps a stored latitude/longitude at 30 days; this cache
        // was holding them permanently. The sweep blanks the lapsed COORDINATES and
        // keeps the place_id, so `samePlace()` — the whole reason db/124 exists — is
        // untouched: no extra API call, no behaviour change, nothing slower. An
        // `osm:` row never expires (its licence permits keeping the result), and the
        // research warehouse's own coordinates (db/412) are Census/OSM-sourced and
        // are not affected. Bounded, idempotent, self-draining, never throws.
        require('./lib/address-canon').expireGoogleCoordsOnce()
          .then((r) => r && r.expired && console.log('[boot] google coordinate expiry:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] google coordinate expiry failed:', e.message));
        // Previous-files fix (owner-directed 2026-07-27): a borrower's name is now
        // THREE fields (first / middle / last, + suffix) so it lines up with the way
        // Encompass, MISMO and every closing document model a person. This splits the
        // names already stored merged by the old one-line ClickUp splitter
        // ("Issac Michael" / "Grunzweig" -> "Issac" / "Michael" / "Grunzweig"). It only
        // ever REARRANGES a name, never restates one, and flags the judgement calls for
        // a human to confirm. Bounded, resumable, idempotent; never blocks boot.
        require('./lib/name-heal').healBorrowerNamesOnce()
          .then((r) => r && r.split && console.log('[boot] borrower name split:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] borrower name split failed:', e.message));
        // Previous-files fix (owner-reported 2026-08-02): every appraisal imported before db/405
        // stored the MISMO attachment STYLE ("Detached") in its property-type column, so the
        // Appraisal tab, the tie-out matrix and the Data comparison all printed a word that is not
        // an answer to "what is this property". This re-reads the real category (single family /
        // 2–4 / condo / …) from what the row already holds and parks the style in its own column.
        // Bounded, self-draining, idempotent; never blocks boot.
        require('./lib/appraisal/property-category-heal').healAppraisalPropertyCategoriesOnce()
          .then((r) => r && r.looked && console.log('[boot] appraisal property category repair:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] appraisal property category repair failed:', e.message));
        require('./lib/underwriting/investor-guidelines/seed').seedNoteBuyerConditions()
          .then((r) => r && r.ok && console.log('[boot] note-buyer conditions seed:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] note-buyer conditions seed failed:', e.message));
        // Retract stale guideline findings on files nobody has re-opened (owner 2026-07-26: "fix
        // this also for all the previous files"). Retraction otherwise only runs on a file view, so
        // a corrected rule left its now-wrong notice open on un-viewed files. Retract-only — never
        // raises, so no boot-time notification burst. Best-effort; never blocks boot.
        require('./lib/underwriting/investor-guidelines/desk-sync').backfillGuidelineRetractions()
          .then((r) => r && r.retracted && console.log('[boot] guideline-retraction backfill:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] guideline-retraction backfill failed:', e.message));
        // Retire stale "fatal AI finding" NOTIFICATIONS on previous files (owner-reported
        // 2026-08-06, seen "on a lot of files"). #1034 fixed the loan_amount / silver
        // findings in the grounding, and the findings self-heal on the next file view — but
        // the notification each one wrote had no link to the finding's lifecycle and lived
        // on forever as an unread fatal. This marks those read (never deletes). Bounded,
        // self-draining, idempotent; never blocks boot.
        require('./lib/underwriting/ai-finding-notify').retireStaleFatalNotificationsOnce()
          .then((r) => r && (r.retiredStale || r.retiredSettled) && console.log('[boot] stale AI-fatal notifications retired:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] stale AI-fatal notification retire failed:', e.message));
        // Previous AND future draws (owner-directed 2026-08-06): the draw-packet Excel
        // is now filed as a document so it mirrors into the per-draw SharePoint folder
        // ("Draws/Draw N") alongside the inspection reports. This files a packet for any
        // draw that doesn't already carry a current one, so previous draws get theirs on
        // the next boot. Bounded, best-effort, self-draining; never blocks boot.
        // Off-switch: DRAW_PACKET_BACKFILL_DISABLED=1.
        require('./sitewire/draw-packet').backfillDrawPacketsOnce()
          .then((r) => r && r.filed && console.log('[boot] draw-packet documents filed:', JSON.stringify(r)))
          .catch((e) => console.error('[boot] draw-packet backfill failed:', e.message));
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
    // One-shot EMD refolder (owner-directed 2026-07-31): renames the mirror's
    // OWN all-EMD condition folders to the clean "EMD" category name so files
    // mirrored before the categorizer change match it. Marker-gated, guarded,
    // kill switch SHAREPOINT_EMD_REFOLDER_DISABLED=1; inert when sync is off.
    try { require('./lib/sharepoint-emd-refolder').kickoff(); } catch (e) { console.warn('emd refolder not scheduled:', e.message); }
    // DocuSign e-sign heartbeat: drains the Connect event inbox + send queue and
    // reconciles any in-flight envelope that went quiet (missed-webhook recovery).
    // Self-gated — inert until the DocuSign credentials are configured.
    try { require('./lib/esign/poller').start(); } catch (e) { console.warn('esign poller not started:', e.message); }
    // Sitewire draw-management sync — drains the outbound queue + reconcile poll.
    // Self-gated by SITEWIRE_ENABLED (+ SITEWIRE_OUTBOUND_ENABLED for writes); inert
    // otherwise. Manages ONLY properties PILOT created (only-ours rule).
    try { require('./sync/sitewire-sync').start(); } catch (e) { console.warn('sitewire sync not started:', e.message); }
    // TrustPoint mirror poller (physical-draw workflow phase 2): webhook inbox drain +
    // draw watermark poll + project discovery sweep. Self-gated by TRUSTPOINT_ENABLED
    // + the API key; read-only toward TrustPoint (webhook registration is the one
    // journaled write, and it only happens from the admin route).
    try { require('./trustpoint/poller').start(); } catch (e) { console.warn('trustpoint poller not started:', e.message); }
    // Encompass READ-ONLY pull worker (owner-directed 2026-07-22). Self-gates on
    // ENCOMPASS_ENABLED=1 + ENCOMPASS_* env creds. Never writes to Encompass
    // (structurally impossible via src/lib/integrations/encompass.js); writes ONLY
    // to PILOT's own DB — encompass_field_catalog + applications.encompass_extra.
    try { require('./sync/encompass-sync').start(); } catch (e) { console.warn('encompass sync not started:', e.message); }
    // Flood-order poll worker (the one owner-authorized Encompass WRITE — flood
    // only). Runs independently of ENCOMPASS_ENABLED; self-gates on the
    // ENCOMPASS_FLOOD_ENABLED switch, so an idle tick is a cheap no-op.
    try { require('./sync/encompass-sync').startFloodPoller(); } catch (e) { console.warn('encompass flood poller not started:', e.message); }
    // AMC appraisal-order poll worker (AppraisalScope / CoreLogic Digital Gateway is a
    // PULL API — CDG never pushes, so status + finished documents are polled). Self-gates
    // on AMC_ENABLED per tick, so an idle tick is a cheap no-op and flipping the switch on
    // starts polling with no redeploy. On product-available it files the report back into
    // the Document Center and runs the appraisal import automatically.
    try { require('./amc/sync').start(); } catch (e) { console.warn('amc sync not started:', e.message); }
    // Scheduled notification digests (owner-directed 2026-07-20): weekly borrower
    // "what's still needed", daily per-officer pipeline snapshot, stale-file
    // alerts, and the Monday admin summary. Each self-gates via audit_log so it
    // sends at most once per period; timed to the morning/business-hours window in
    // the team's timezone. Kill-switch NOTIFY_DIGESTS_ENABLED=0.
    // Runtime feature-flag cache (the API Health "working switches"): load overrides once, refresh
    // periodically. Gates fall back to their env default until this loads, so it's safe if it lags.
    try { require('./lib/flags').start(); } catch (e) { console.warn('flags cache not started:', e.message); }
    try { require('./lib/notification-digests').start(); } catch (e) { console.warn('notification digests not started:', e.message); }
    // Pipeline V2 durable document-processing worker (owner-directed 2026-07-26). Drains the
    // document_pipeline_jobs queue through the packet-control processor (records the stage manifest
    // + routing decision). It is a NO-OP unless UW_WORKER_ENABLED — so this boot call is inert by
    // default and everyone stays on Pipeline V1. Nothing enqueues shadow jobs until the shadow gate
    // (enqueue-on-upload) is also switched on, so the worker simply finds an empty queue.
    // The start-up sequence lives in ONE shared helper so the web service and the standalone worker
    // service (src/worker.js) can never drift into reading documents differently. Once the separate
    // Render worker is running, this service sets UW_WORKER_ENABLED=false and the call below becomes
    // a no-op — the reader no longer competes with borrower page loads for this process.
    try {
      require('./pipeline/start').startPipelineWorker({ db: require('./db'), cfg });
    } catch (e) { console.warn('pipeline worker not started:', e.message); }
    // Loan-officer Notification Center drainer — schedules parked drafts,
    // auto-sends the untouched ones past the SLA, wakes snoozed rows. Kill-switch
    // NOTIFY_WORKER_ENABLED=0.
    try { require('./lib/lo-notification-worker').start(); } catch (e) { console.warn('lo notification worker not started:', e.message); }
    // API Health down-alerts (owner-directed 2026-07-21): probe every integration on a
    // schedule and email the admins when one that was reachable goes DOWN (and when it
    // recovers). Alerts only on a real transition, never on intentional states. OFF by
    // default — set INTEGRATIONS_MONITOR_ENABLED=1 to turn on.
    try { require('./lib/integrations/monitor').start(); } catch (e) { console.warn('integrations monitor not started:', e.message); }
    // USPS previous-files backfill (owner-directed: "every file should have the correct
    // address according to USPS"). Paced + non-destructive — stamps each existing file
    // with its USPS-standardized subject address. OFF unless USPS_BACKFILL_ENABLED=1 and
    // USPS keys are set (developer.usps.com).
    try { require('./lib/address-usps-verify').startUspsBackfill(); } catch (e) { console.warn('usps backfill not started:', e.message); }
    // Previous files: put back the USPS stamps the "it bounces back" bug wiped
    // (owner-reported 2026-08-02; db/415). Cache-only, so it spends no USPS quota,
    // and it only ever re-asserts an import a human already made on the same place.
    try { require('./lib/usps-stamp-heal').startUspsStampHeal(); } catch (e) { console.warn('usps stamp heal not started:', e.message); }
  });
}
module.exports = app;
