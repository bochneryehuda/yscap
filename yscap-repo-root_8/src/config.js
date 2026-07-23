/** Centralized config — every secret comes from env (Render environment vars). */

// --- zero-dependency .env loader (no dotenv package) ---------------------
// On Render, env vars come from the dashboard and this file may be absent.
// For local runs / self-hosting, a bundled .env at the project root is read
// here so `npm start` works without any extra tooling. Never overrides a
// value already present in the real environment, and never throws.
(function loadDotEnv() {
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) { /* boot must never fail on env parsing */ }
})();

// Resolve a security-critical secret. Production must NEVER run on the public
// dev default: if the env var is missing (or still the placeholder), generate a
// strong random value for this process and warn loudly. That closes the
// forge-anyone's-token / decrypt-any-SSN hole; the trade-off (values reset on
// restart) is surfaced so operators set a stable value.
const generatedSecrets = new Set();   // names we had to auto-generate this boot
function resolveSecret(name) {
  const v = process.env[name];
  const placeholder = !v || v === 'dev-only-change-me' || v === 'change-me-long-random';
  if (!placeholder) return v;
  if ((process.env.NODE_ENV || 'development') === 'production') {
    generatedSecrets.add(name);
    const gen = require('crypto').randomBytes(48).toString('base64url');
    console.error(
      `[config] SECURITY: ${name} is not set — using a random ephemeral value for this process. ` +
      `Set ${name} to a long random string in the environment. ` +
      (name === 'SSN_ENCRYPTION_KEY'
        ? 'Until then, SSNs encrypted now cannot be decrypted after a restart.'
        : 'Until then, all sessions are invalidated on each restart.'));
    return gen;
  }
  return 'dev-only-change-me';
}

// Choose the email provider from env. An explicit EMAIL_PROVIDER wins; otherwise
// infer from whichever credential set is present so a single env var is enough.
function resolveEmailProvider() {
  const explicit = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (explicit && explicit !== 'auto') return explicit;   // honor an explicit choice
  if ((process.env.RESEND_API_KEY || '').trim()) return 'resend';
  if ((process.env.MS_TENANT_ID || '').trim() &&
      (process.env.MS_CLIENT_ID || '').trim() &&
      (process.env.MS_CLIENT_SECRET || '').trim()) return 'graph';
  return 'none';
}

// The public base URL used for EVERY link that leaves the system (emails, reset
// links, redirects) AND for server-to-server callbacks (the DocuSign Connect
// webhook + the embedded-signing return bounce). NEVER emit an onrender.com link —
// the custom domain (yscapgroup.com) is live (owner-directed 2026-07-14). If APP_URL
// is still pointed at the onrender subdomain (e.g. a stale Render dashboard var that
// overrides render.yaml), rewrite it to the custom domain so nothing external ever
// shows onrender. Use the APEX host (yscapgroup.com): `www.` 301/307-redirects to
// the apex, and a redirect on a server-to-server POST (the DocuSign webhook) is not
// reliably followed — so the callback must hit the canonical host DIRECTLY.
function publicBaseUrl() {
  let u = (process.env.APP_URL || 'https://yscapgroup.com').replace(/\/+$/, '');
  if (/onrender\.com/i.test(u)) u = 'https://yscapgroup.com';
  return u;
}

module.exports = {
  port:          process.env.PORT || 3000,
  env:           process.env.NODE_ENV || 'development',
  databaseUrl:   process.env.DATABASE_URL,

  // --- auth / crypto ---
  jwtSecret:     resolveSecret('JWT_SECRET'),
  ssnKey:        resolveSecret('SSN_ENCRYPTION_KEY'),
  // Stable HMAC key for SSN matching (borrower identity graph). Derived from the
  // SSN encryption key so it needs no extra env var and stays stable across
  // restarts — an ephemeral key would silently break historical matching.
  // Override with SSN_MATCH_KEY if you ever rotate independently.
  ssnMatchKey:   process.env.SSN_MATCH_KEY ||
                 require('crypto').createHash('sha256')
                   .update('ssn-match:' + (process.env.SSN_ENCRYPTION_KEY || 'dev-only-change-me')).digest('hex'),
  // Exposed on /api/health as jwtStable/ssnKeyStable — when true, the env var
  // is missing and sessions/SSNs won't survive a restart. Fix the env.
  jwtSecretGenerated: generatedSecrets.has('JWT_SECRET'),
  ssnKeyGenerated:    generatedSecrets.has('SSN_ENCRYPTION_KEY'),
  // Session lifetime. Tokens slide: any authenticated request past the halfway
  // point returns a fresh token in X-Refresh-Token (picked up by the SPA), so
  // this is effectively an IDLE timeout, not an absolute one. Revocation still
  // works instantly via token_version (logout / password reset).
  accessTtlSec:  parseInt(process.env.ACCESS_TTL_SEC || '604800', 10),    // 7d idle timeout
  refreshTtlSec: parseInt(process.env.REFRESH_TTL_SEC || '2592000', 10),  // 30d

  // --- site integration ---
  webDir:        process.env.WEB_DIR || 'web',
  intakeApiKey:  process.env.INTAKE_API_KEY,     // shared secret the site sends with submissions

  // --- notifications (email fan-out) ---
  // Provider is auto-detected from the credentials present so email works as
  // soon as a key is added, without also having to flip EMAIL_PROVIDER:
  //   RESEND_API_KEY set            -> resend
  //   MS_* client-credential set    -> graph
  //   nothing / EMAIL_PROVIDER=none -> none (logs only; in-app still works)
  // An explicit EMAIL_PROVIDER always wins.
  emailProvider: resolveEmailProvider(),
  // Owner-directed 2026-07-20: our notification emails ARE repliable, so the
  // sender must not pretend otherwise. Default the From to a real, monitored
  // address (no "no-reply"). For Resend only the DOMAIN must be verified; for
  // Graph this must be a real mailbox UPN in the tenant.
  notifyFrom:    process.env.NOTIFY_FROM || 'PILOT by YS Capital <notifications@yscapgroup.com>',
  // A guaranteed Reply-To for every notification when no more-specific one is
  // set (a per-file file+<id>@ address, or an officer's own inbox). This makes
  // "just hit reply" always reach a human, so no email is ever a dead end.
  // Defaults to the company sales inbox; override with REPLY_TO.
  replyToDefault: (process.env.REPLY_TO || 'sales@yscapgroup.com').trim() || null,
  // Owner-directed 2026-07-20: silently BCC the file's assigned loan officer on
  // every BORROWER notification email, so the LO sees in real time exactly what
  // their borrower received. BCC (not CC) — the borrower's inbox stays clean and
  // the officer's address isn't exposed. On by default; set CC_LO_ON_BORROWER=0
  // to turn off.
  ccLoanOfficerOnBorrowerEmail: process.env.CC_LO_ON_BORROWER !== '0',
  // #75 external chat guests: the domain a unique per-participant reply-to is
  // built on (e.g. "reply.yscapgroup.com" → chat+<key>@reply.yscapgroup.com).
  // When UNSET, external guests still receive chat emails but with no reply-to,
  // and the inbound reply webhook stays dormant until an inbound-email domain is
  // configured in Resend. Never falls back to the marketing domain.
  chatReplyDomain: (process.env.CHAT_REPLY_DOMAIN || '').trim().replace(/^@+/, '').toLowerCase() || null,
  appUrl:        publicBaseUrl(),  // base for links in emails (live custom domain; onrender guarded out)
  // The borrower/staff SPA is mounted under this path (vite base '/portal/',
  // HashRouter). Email + notification deep links must include it, or they land
  // on the marketing site instead of the portal.
  portalPath:    ('/' + (process.env.PORTAL_PATH || 'portal').replace(/^\/+|\/+$/g, '')),
  // Vanity subdomains that route straight to the PILOT client login. A request
  // to the bare root on one of these hosts 302s into the portal (everything
  // else — assets/API/portal deep links — passes through). Override with
  // PILOT_LOGIN_HOSTS (comma-separated) if the subdomain ever changes.
  pilotLoginHosts: (process.env.PILOT_LOGIN_HOSTS ||
                    'pilot.yscapgroup.com,www.pilot.yscapgroup.com')
                    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Public URL of the branded logo shown in email headers. Defaults to the PILOT
  // lockup image (web/(v2/)assets/brand/pilot-lockup-email.png) — the exact site
  // top-left lockup (gold chevron mark + "PILOT" in Fraunces + "by YS Capital"),
  // baked onto white so it reads on the light email header. Override with
  // EMAIL_LOGO_URL if hosted elsewhere.
  emailLogoUrl:  process.env.EMAIL_LOGO_URL ||
                 (publicBaseUrl() + '/assets/brand/pilot-lockup-email.png'),
  notifyAdmins:  (process.env.NOTIFY_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Microsoft Graph (Outlook) provider:
  msTenantId:    process.env.MS_TENANT_ID,
  msClientId:    process.env.MS_CLIENT_ID,
  msClientSecret:process.env.MS_CLIENT_SECRET,
  // Resend provider:
  resendApiKey:  process.env.RESEND_API_KEY,
  // #68 inbound file-email forwarding. RESEND_WEBHOOK_SECRET (whsec_…) verifies
  // that an email.received webhook actually came from Resend (Svix signature over
  // the raw body). RESEND_INBOUND_API_KEY is a FULL-ACCESS key used to retrieve
  // the inbound email body via the Receiving API — a Sending-only key can't read
  // it — and falls back to RESEND_API_KEY when unset (fine if that key already has
  // full access). The inbound route stays dormant until the secret is configured.
  resendWebhookSecret:   (process.env.RESEND_WEBHOOK_SECRET || '').trim() || null,
  resendInboundApiKey:   (process.env.RESEND_INBOUND_API_KEY || process.env.RESEND_API_KEY || '').trim() || null,
  // Hosted card-OCR (appraisal "scan a photo"): OCR.space. Get a free key at
  // https://ocr.space/ocrapi; unset falls back to the public demo key.
  ocrSpaceApiKey: process.env.OCR_SPACE_API_KEY,

  // FEMA flood cross-check (appraisal zone vs the official FEMA map, via the free Census
  // geocoder + FEMA NFHL — no signup/key). Off by default: it makes outbound calls to
  // government APIs, so it must be enabled once the environment's network policy allows egress
  // to geocoding.geo.census.gov + hazards.fema.gov.
  appraisalFloodCheckEnabled: process.env.APPRAISAL_FLOOD_CHECK_ENABLED === '1',

  // --- document storage ---
  storageProvider: process.env.STORAGE_PROVIDER || 'local', // 'local' | 's3' | 'sharepoint'
  // On Render, set STORAGE_DIR to a mounted persistent disk (e.g. /var/data/uploads)
  // so documents survive deploys — the default filesystem is ephemeral.
  storageDir:      process.env.STORAGE_DIR || 'uploads',
  maxUploadMb:     parseInt(process.env.MAX_UPLOAD_MB || '20', 10),   // per-file cap

  // --- SharePoint document sync (one-way mirror into Pipeline Drive) ---
  // Owner-directed design (2026-07-13): every document saved on the server is
  // mirrored into the existing team-site tree at
  //   Pipeline Drive/<Officer>/<Borrower>/<Address>/YS portal syncing/<Condition>/
  // ONE-WAY (write to SharePoint only, never read documents back), NEVER deletes
  // anything anywhere, and only ever moves/renames its OWN previously-uploaded
  // mirror copies within a `YS portal syncing` folder (version shuffling). See
  // docs/SHAREPOINT-POLICY.md + CLAUDE.md. Reuses the Graph app credentials
  // above; also supports certificate auth (MS_CLIENT_CERT_PEM / _B64) with
  // fallback to the client secret when both are configured.
  // Master switch defaults OFF — nothing touches SharePoint until
  // SHAREPOINT_BACKUP_ENABLED=1 and the MS_* creds are set.
  sharepointBackupEnabled: process.env.SHAREPOINT_BACKUP_ENABLED === '1',
  sharepointSiteHost:  process.env.SHAREPOINT_SITE_HOST || 'yscapgroup.sharepoint.com',
  sharepointSitePath:  process.env.SHAREPOINT_SITE_PATH || '/sites/SharedData',
  sharepointDriveName: process.env.SHAREPOINT_DRIVE_NAME || 'Documents', // document library
  // Pin the exact document-library drive id (from Graph). When set, the site
  // host/path/name above are only a fallback — the pin survives library renames.
  sharepointDriveId:   process.env.SHAREPOINT_DRIVE_ID || '',
  // The human tree the mirror files into, and the portal-owned subfolder name it
  // creates inside each address folder. The mirror writes documents ONLY inside
  // `YS portal syncing` folders (folder creation up the chain is allowed).
  sharepointPipelineRoot: process.env.SHAREPOINT_PIPELINE_ROOT || 'Pipeline Drive',
  // PILOT branding (2026-07-14): NEW leaf folders are "Synced by Pilot"; the
  // resolver reuses a LEGACY-named leaf ("YS portal syncing") when one already
  // exists so existing trees are never duplicated (backward-compat aliases).
  sharepointSyncFolderName: process.env.SHAREPOINT_SYNC_FOLDER || 'Synced by Pilot',
  sharepointSyncFolderLegacy: ['YS portal syncing'],
  // Where documents land when no officer/borrower can be determined at all.
  sharepointUnfiledRoot: process.env.SHAREPOINT_UNFILED_ROOT || 'Pilot — Unfiled',
  sharepointUnfiledLegacy: ['YS Portal Syncing - Unfiled'],
  // Certificate auth (preferred when present; falls back to the client secret).
  msClientCertPem: process.env.MS_CLIENT_CERT_PEM
                 || (process.env.MS_CLIENT_CERT_PEM_B64
                     ? Buffer.from(process.env.MS_CLIENT_CERT_PEM_B64, 'base64').toString('utf8') : ''),
  sharepointBackupPollSec: parseInt(process.env.SHAREPOINT_BACKUP_POLL_SEC || '300', 10),
  // Metadata ID stamping (roadmap R1): stamp PilotDocumentId/FileId/Borrower/
  // SyncedAt columns onto each mirrored driveItem so the link survives any
  // human rename/move. Best-effort + gated; DEFAULT ON but a stamp failure
  // never affects the mirror. Set SHAREPOINT_STAMP_METADATA=0 to disable.
  sharepointStampMetadata: process.env.SHAREPOINT_STAMP_METADATA !== '0',

  // --- ClickUp bidirectional sync (server-side token only) ---
  clickupToken:         process.env.CLICKUP_API_TOKEN,
  clickupTeamId:        process.env.CLICKUP_TEAM_ID || '9011888435',
  clickupPipelineSpace: process.env.CLICKUP_PIPELINE_SPACE || '90113223301',
  clickupCrmSpace:      process.env.CLICKUP_CRM_SPACE || '90113224042',
  clickupWebhookSecret: process.env.CLICKUP_WEBHOOK_SECRET,           // persisted after webhook creation
  clickupSyncEnabled:   process.env.CLICKUP_SYNC_ENABLED === '1',     // master switch (default off)
  clickupPollSec:       parseInt(process.env.CLICKUP_POLL_SEC || '300', 10),
  // Staged rollout controls (all default off):
  clickupOutboundEnabled: process.env.CLICKUP_OUTBOUND_ENABLED === '1', // gate portal -> ClickUp writes
  clickupRunDryrun:       process.env.CLICKUP_DRYRUN === '1',           // boot: read-only validation to logs, no loops
  clickupRunBackfill:     (process.env.CLICKUP_RUN_BACKFILL || '').trim(), // boot one-shot: '' | 'data' | 'full'
  // Outbound go-live cutoff (ISO timestamp). When set, the dirty-sweep only
  // pushes apps that are ALREADY linked to a ClickUp task OR were created at/after
  // this time — so enabling outbound never bulk-pushes the pre-existing portal
  // backlog (which would create duplicate ClickUp tasks). Empty = no cutoff.
  clickupOutboundSince:   (process.env.CLICKUP_OUTBOUND_SINCE || '').trim(),
  // Inbound file materialization gate (default off). When off, the reconcile /
  // webhook-inbox loops maintain the identity graph and UPDATE already-linked
  // loan files, but never CREATE new portal loan files from a ClickUp task —
  // which (without identity-based dedup) could duplicate an existing unlinked
  // portal application for the same loan. Turn on only once inbound identity
  // matching is in place, or to deliberately mirror ClickUp files into the portal.
  clickupInboundCreateFiles: process.env.CLICKUP_INBOUND_CREATE_FILES === '1',
  clickupRunAudit:           process.env.CLICKUP_RUN_AUDIT === '1',   // boot: log data-coverage/assignment audit

  // --- Sitewire draw-management integration (server-side token only) ---
  // Auth is a 3-header token pair (access-token + client + uid), created in the
  // Sitewire API tab. Secrets live ONLY here (Render env), never in source. The
  // integration manages ONLY properties PILOT created (the "only-ours" rule) and
  // is BORN on the funded + Request-a-draw click. Staged rollout, all default off:
  //   SITEWIRE_ENABLED         master switch  — read/reconcile loops
  //   SITEWIRE_OUTBOUND_ENABLED separate gate — portal -> Sitewire WRITES
  //   SITEWIRE_DRYRUN           print the exact push bodies to logs, send nothing
  sitewireBaseUrl:      (process.env.SITEWIRE_BASE_URL || 'https://app.sitewire.co').replace(/\/+$/, ''),
  sitewireAccessToken:  process.env.SITEWIRE_ACCESS_TOKEN,
  sitewireClient:       process.env.SITEWIRE_CLIENT,
  sitewireUid:          process.env.SITEWIRE_UID,
  sitewireLenderId:     parseInt(process.env.SITEWIRE_LENDER_ID || '236', 10),
  sitewireEnabled:      process.env.SITEWIRE_ENABLED === '1',           // master switch (default off)
  sitewireOutboundEnabled: process.env.SITEWIRE_OUTBOUND_ENABLED === '1', // gate portal -> Sitewire writes
  sitewireDryrun:       process.env.SITEWIRE_DRYRUN === '1',            // validate-only, no network writes
  sitewirePollSec:      parseInt(process.env.SITEWIRE_POLL_SEC || '300', 10),
  sitewireDefaultCoordinatorId: parseInt(process.env.SITEWIRE_DEFAULT_COORDINATOR_ID || '16146', 10), // Lisa Katz
  sitewireDefaultChecklistTemplateId: parseInt(process.env.SITEWIRE_CHECKLIST_TEMPLATE_ID || '84', 10),
  sitewireMaxWrites10min: parseInt(process.env.SITEWIRE_MAX_WRITES_10MIN || '300', 10), // volume circuit breaker
  // Go-live for the PILOT draw system (owner-directed 2026-07-20): PILOT follows the draw process ONLY for
  // properties IT pushed to Sitewire from this date forward. Pre-existing Sitewire properties are never
  // adopted or followed. Informational (the born-on-push design already makes management go-forward-only).
  sitewireGoLiveDate:   process.env.SITEWIRE_GO_LIVE_DATE || '2026-07-20',
  // --- Sitewire DOCUMENT push (website workaround — no API upload endpoint exists) ---
  // Sitewire's API v2 has NO document-upload endpoint (confirmed against the official swagger).
  // The only way to place a document in a property's Documents tab is the WEBSITE's Rails
  // ActiveStorage direct-upload flow, which needs a logged-in browser SESSION + a CSRF token —
  // things the API token cannot provide. src/sitewire/web-client.js acts as that browser (a
  // "website robot"): it authenticates, does the confirmed 3-step upload, and attaches the blob.
  // Staged like every other write: OFF by default, still gated by SITEWIRE_OUTBOUND_ENABLED +
  // SITEWIRE_DRYRUN. Credentials live in Render env ONLY, never committed, never pasted in chat.
  sitewireDocsEnabled:  process.env.SITEWIRE_DOCS_ENABLED === '1',   // master switch for the doc-push workaround (default off)
  sitewireWebBaseUrl:   (process.env.SITEWIRE_WEB_BASE_URL || process.env.SITEWIRE_BASE_URL || 'https://app.sitewire.co').replace(/\/+$/, ''),
  // Preferred (durable): PILOT logs itself in and refreshes its own session — a lender_owner web login.
  sitewireWebEmail:     process.env.SITEWIRE_WEB_EMAIL || null,
  sitewireWebPassword:  process.env.SITEWIRE_WEB_PASSWORD || null,
  // Fallback (for when MFA/SSO blocks an automated login): a session cookie the owner copies from
  // their browser's logged-in Sitewire tab. Expires — the automated login above is preferred.
  sitewireWebCookie:    process.env.SITEWIRE_WEB_COOKIE || null,
  // Sitewire's real login route (confirmed from a live login capture 2026-07-21): POST /login with
  // authenticity_token + password_step=true + user[email] + user[password]. Overridable if it ever changes.
  sitewireWebSignInPath: process.env.SITEWIRE_WEB_SIGNIN_PATH || '/login',
  sitewireWebTimeoutMs: Math.max(5000, parseInt(process.env.SITEWIRE_WEB_TIMEOUT_MS || '45000', 10) || 45000),
  // --- Sitewire TEST-environment explorer (read-only field discovery) ---
  // A SEPARATE credential set so we can safely READ the Sitewire test system and
  // enumerate every field/button it exposes, WITHOUT ever touching the production
  // creds above or writing anything. The explorer (src/sitewire/test-explorer.js)
  // is GET-only and refuses to run unless these test-specific vars are set — a
  // pasted-in-chat key is never used; the owner sets these in Render. Base URL
  // falls back to the prod base only if the test system shares the same host.
  sitewireTestBaseUrl:     (process.env.SITEWIRE_TEST_BASE_URL || process.env.SITEWIRE_BASE_URL || 'https://app.sitewire.co').replace(/\/+$/, ''),
  sitewireTestAccessToken: process.env.SITEWIRE_TEST_ACCESS_TOKEN,
  sitewireTestClient:      process.env.SITEWIRE_TEST_CLIENT,
  sitewireTestUid:         process.env.SITEWIRE_TEST_UID,
  sitewireTestLenderId:    parseInt(process.env.SITEWIRE_TEST_LENDER_ID || process.env.SITEWIRE_LENDER_ID || '236', 10),

  // --- address autocomplete / verification (server-side proxy) ---
  // The frontend calls OUR /api/address/*; any real key lives only here, never
  // in the public site bundle. Provider auto-detects: Google if a key is set,
  // else Smarty if configured, else 'osm' (OpenStreetMap Nominatim) — which is
  // KEYLESS and works out of the box, so autocomplete is live with zero setup.
  addressProvider: (process.env.ADDRESS_PROVIDER ||
                    (process.env.GOOGLE_PLACES_API_KEY ? 'google'
                     : process.env.SMARTY_AUTH_ID ? 'smarty' : 'osm')).toLowerCase(),
  googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY,
  // Street View property photos (can be the same Google key with the
  // "Street View Static API" enabled, or a dedicated one).
  googleMapsKey:   process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY,
  smartyAuthId:    process.env.SMARTY_AUTH_ID,
  smartyAuthToken: process.env.SMARTY_AUTH_TOKEN,
  // Nominatim asks every app to identify itself (email/URL) in the User-Agent.
  osmContact:      process.env.OSM_CONTACT || 'admin@yscapgroup.com',

  // --- third-party integrations (frameworks; add keys to activate) ---
  // DocuSign eSignature (JWT Grant / server-to-server auth):
  docusign: {
    integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY,   // OAuth client id
    userId:         process.env.DOCUSIGN_USER_ID,           // impersonated user GUID
    accountId:      process.env.DOCUSIGN_ACCOUNT_ID,
    // RSA private key (PEM). M-9: normalize literal "\n" escapes some env UIs
    // introduce — crypto.sign() needs REAL newlines or it throws a decode error.
    privateKey:     (process.env.DOCUSIGN_PRIVATE_KEY || '').replace(/\\n/g, '\n') || undefined,
    baseUri:        process.env.DOCUSIGN_BASE_URI  || 'https://demo.docusign.net/restapi',
    oauthBase:      process.env.DOCUSIGN_OAUTH_BASE || 'account-d.docusign.com', // account.docusign.com in prod
    // Connect webhook HMAC key(s), base64-verified. Comma-separated to support
    // zero-downtime key rotation (DocuSign sends X-DocuSign-Signature-1..N).
    connectHmacKeys: (process.env.DOCUSIGN_CONNECT_HMAC_SECRET || '')
                      .split(',').map(s => s.trim()).filter(Boolean),
    brandId:        process.env.DOCUSIGN_BRAND_ID || null,   // PILOT sending brand (optional)
    // Master send switch — OFF by default. Sending real signature requests is
    // gated behind this so nothing mails a borrower until we deliberately enable it.
    sendEnabled:    process.env.DOCUSIGN_SEND_ENABLED === '1',
    // M-13: only these emails may actually be sent to (comma-separated allow-list).
    testEmailAllowlist: (process.env.DOCUSIGN_TEST_EMAIL_ALLOWLIST || '')
                      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // Test mode gates sending to the allow-list ON ANY host (incl. production), so
    // switching to live creds can't mail a real borrower during testing. Fail-safe:
    // defaults ON — must be EXPLICITLY set to '0' at true go-live to reach anyone.
    testMode:       process.env.DOCUSIGN_TEST_MODE !== '0',
    httpTimeoutMs:  parseInt(process.env.DOCUSIGN_HTTP_TIMEOUT_MS || '30000', 10),
    tokenCacheSec:  parseInt(process.env.DOCUSIGN_TOKEN_CACHE_SEC || '3300', 10), // 55 min (< 1h token life)
    // DB-backed send circuit breaker: more than this many envelopes sent in a
    // rolling 10 min opens the breaker (a runaway loop mailing borrowers stops hard).
    maxSends10min:  parseInt(process.env.DOCUSIGN_MAX_SENDS_10MIN || '100', 10),
    // The admin counter-signer on the term-sheet package (routingOrder 2, signs
    // LAST — the envelope is binding only after this signature). Owner-directed.
    countersignEmail: (process.env.DOCUSIGN_COUNTERSIGN_EMAIL || 'yehuda@yscapgroup.com').toLowerCase(),
    countersignName:  process.env.DOCUSIGN_COUNTERSIGN_NAME || 'YS Capital Group — Lender',
  },
  // Plaid (bank / asset verification):
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID,
    secret:   process.env.PLAID_SECRET,
    env:      (process.env.PLAID_ENV || 'sandbox').toLowerCase(),  // sandbox | development | production
  },
  // Xactus (credit reports) — B2B credentials:
  xactus: {
    username: process.env.XACTUS_USERNAME,
    password: process.env.XACTUS_PASSWORD,
    clientId: process.env.XACTUS_CLIENT_ID,
    endpoint: process.env.XACTUS_ENDPOINT,   // your assigned API base URL
  },
  // USPS Addresses API v3 (OAuth2 client-credentials). Free with a USPS
  // developer account (developer.usps.com) — add the two keys to activate real
  // USPS address standardization + ZIP+4.
  usps: {
    clientId:     process.env.USPS_CLIENT_ID,
    clientSecret: process.env.USPS_CLIENT_SECRET,
    baseUrl:      (process.env.USPS_API_BASE || 'https://apis.usps.com').replace(/\/+$/, ''),
  },
  // Encompass (ICE Mortgage Technology / Ellie Mae) — the loan-origination
  // system. OAuth2 via Developer Connect; access is per-instance, so the field
  // mapping is finalized against YOUR Encompass instance once credentials exist.
  encompass: {
    clientId:     process.env.ENCOMPASS_CLIENT_ID,
    clientSecret: process.env.ENCOMPASS_CLIENT_SECRET,
    instanceId:   process.env.ENCOMPASS_INSTANCE_ID,     // your Encompass instance / smart-client id
    username:     process.env.ENCOMPASS_USERNAME,        // some grants need a user login too
    password:     process.env.ENCOMPASS_PASSWORD,
    baseUrl:      (process.env.ENCOMPASS_API_BASE || 'https://api.elliemae.com').replace(/\/+$/, ''),
  },

  // --- document underwriting: OCR reader + AI analyzer (add keys to activate) ---
  // Microsoft Azure AI Document Intelligence — the "reads even scanned/blurry
  // documents" OCR engine (src/lib/ai/docint.js), running in the owner's existing
  // Azure account. Just an endpoint + resource key (no JWT/SDK). Everything stays
  // dormant until both are set. Default model 'prebuilt-read' = pure OCR.
  docint: {
    endpoint:   (process.env.AZURE_DOCINT_ENDPOINT || '').trim().replace(/\/+$/, ''),
    key:        process.env.AZURE_DOCINT_KEY,
    model:      (process.env.AZURE_DOCINT_MODEL || 'prebuilt-read').trim(),
    apiVersion: (process.env.AZURE_DOCINT_API_VERSION || '2024-11-30').trim(),
  },
  // Microsoft Azure OpenAI (GPT-5) — the AI document analyzer / underwriting brain
  // (src/lib/ai/azure-openai.js), in the owner's existing Azure account. Endpoint +
  // key + the deployment name you give the GPT-5 model. Raw HTTPS via fetch (no SDK).
  azureOpenai: {
    endpoint:   (process.env.AZURE_OPENAI_ENDPOINT || '').trim().replace(/\/+$/, ''),
    key:        process.env.AZURE_OPENAI_KEY,
    deployment: (process.env.AZURE_OPENAI_DEPLOYMENT || '').trim(),
    apiVersion: (process.env.AZURE_OPENAI_API_VERSION || '2025-04-01-preview').trim(),
    // GPT-5 reasoning depth for extraction — 'minimal'|'low'|'medium'|'high'. Low keeps
    // hidden reasoning from consuming the output budget; raise only if accuracy needs it.
    reasoningEffort: (process.env.AZURE_OPENAI_REASONING_EFFORT || 'low').trim(),
  },
  // Anthropic Claude — the INDEPENDENT SECOND reasoning provider for the review
  // committee (#215). A committee that verifies a finding with the SAME model that
  // produced it is not truly independent; a different provider catches what the
  // first one's blind spots miss. OFF until ANTHROPIC_API_KEY is set (Render env
  // only, never source) — the committee runs all-Azure until then, unchanged. Raw
  // HTTPS via fetch (no SDK), same as every other integration.
  anthropic: {
    key: process.env.ANTHROPIC_API_KEY,
    model: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5').trim(),
    apiVersion: (process.env.ANTHROPIC_API_VERSION || '2023-06-01').trim(),
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim().replace(/\/+$/, ''),
  },
  // Google Cloud Document AI — the INDEPENDENT SECOND OCR engine (owner-directed
  // 2026-07-21). Runs as a fallback when Azure Document Intelligence returns no
  // text / very short text / an error. Different failure modes than Azure, so it
  // catches what Azure misses (rotated scans, faxes, low-quality PDFs).
  // Authentication is a service-account JWT → OAuth2 access token (no SDK; pure
  // fetch + Node's built-in crypto). Everything stays dormant until the four
  // Render env vars are set.
  //   GOOGLE_DOCAI_KEY_JSON      the full service-account JSON (the private key
  //                              lives inside it — never commit, only Render env)
  //   GOOGLE_DOCAI_PROJECT_ID    e.g. yscap-docai
  //   GOOGLE_DOCAI_LOCATION      us | eu (matches the processor's region)
  //   GOOGLE_DOCAI_PROCESSOR_ID  the alphanumeric ID of the "Enterprise Document OCR" processor
  docai: {
    keyJson:     process.env.GOOGLE_DOCAI_KEY_JSON || '',
    projectId:   (process.env.GOOGLE_DOCAI_PROJECT_ID || '').trim(),
    location:    (process.env.GOOGLE_DOCAI_LOCATION || 'us').trim(),
    processorId: (process.env.GOOGLE_DOCAI_PROCESSOR_ID || '').trim(),
  },
  // Mistral OCR — the THIRD OCR engine (owner-directed 2026-07-21). Used only
  // when Azure AND Google disagree or both fail on a hard document (dense
  // tables, signatures, multi-column layouts). Single API key, pay-as-you-go.
  //   MISTRAL_API_KEY  the key from console.mistral.ai
  mistralOcr: {
    key:      process.env.MISTRAL_API_KEY || '',
    endpoint: (process.env.MISTRAL_OCR_ENDPOINT || 'https://api.mistral.ai').trim().replace(/\/+$/, ''),
    model:    (process.env.MISTRAL_OCR_MODEL || 'mistral-ocr-latest').trim(),
  },
  // Direct-source verification connectors (Sovereign, blueprint sec. 9) — each
  // one, when configured, feeds the loan digital twin `api_verification`
  // observations that OUTRANK document observations for the same facts. All
  // three ship as stubs today; wiring real HTTP is a one-file change per
  // connector when the vendor accounts are in place.
  //   Plaid — bank account owner + ending balance (assets)
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID || '',
    secret:   process.env.PLAID_SECRET || '',
    env:      (process.env.PLAID_ENV || 'sandbox').trim(),
  },
  //   Property data (CoreLogic / DataTree / ATTOM) — recorded address / units / year built / liens / AVM
  propertyData: {
    provider: (process.env.PROPERTY_DATA_PROVIDER || '').trim(),   // 'corelogic' | 'datatree' | 'attom'
    key:      process.env.PROPERTY_DATA_KEY || '',
  },
  //   Xactus (formerly CreditPlus) — FICO + OFAC/background/fraud
  xactus: {
    account:  process.env.XACTUS_ACCOUNT || '',
    user:     process.env.XACTUS_USER || '',
    password: process.env.XACTUS_PASSWORD || '',
  },
  // Xactus — SHARED PRODUCTION credit login (owner-directed 2026-07-22). The
  // "Import credit" button (internal Credit report condition) pulls/reissues a
  // tri-merge report using ONE company login stored HERE (Render env) — NOT a
  // per-user credential. This block is deliberately SEPARATE from the two legacy
  // `xactus` blocks above (the per-user framework), which are left in place and
  // dormant in case we return to that model. Consumed by src/lib/credit/provider.js.
  //   XACTUS_API_URL          the FULL Credit ReportX request URL Xactus gave you
  //                           to POST reports to (the exact endpoint, NOT a base
  //                           host — the code POSTs to this address verbatim)
  //   XACTUS_API_USERNAME     the one shared login user
  //   XACTUS_API_PASSWORD     the one shared login password
  //   XACTUS_API_ACCOUNT      optional account / subscriber id (if Xactus needs it)
  //   XACTUS_API_CLIENT_ID    optional client id (if Xactus needs it)
  //   XACTUS_INTERFACE_VERSION default report interface version (default '3.4')
  xactusProd: {
    endpoint: (process.env.XACTUS_API_URL || '').trim().replace(/\/+$/, ''),
    username: process.env.XACTUS_API_USERNAME || '',   // Xactus Operator ID / login
    password: process.env.XACTUS_API_PASSWORD || '',   // Xactus login password
    account:  process.env.XACTUS_API_ACCOUNT || '',
    clientId: process.env.XACTUS_API_CLIENT_ID || '',
    version:  (process.env.XACTUS_INTERFACE_VERSION || '3.4').trim(),
    // RequestingParty name printed in the MISMO request (informational).
    requestingParty: (process.env.XACTUS_REQUESTING_PARTY || 'YS Capital Group').trim(),
    // Auth: 'basic' (HTTP Basic header, the documented default) or 'query'
    // (LoginAccountIdentifier/LoginAccountPassword query params, the Postman-
    // collection style). Flip to 'query' only if your Xactus endpoint needs it.
    authMode: /^query$/i.test((process.env.XACTUS_AUTH_MODE || 'basic').trim()) ? 'query' : 'basic',
  },
  //   HouseCanary — AVM + Rent AVM (independent value + rent triangulation)
  houseCanary: {
    key:      process.env.HOUSECANARY_KEY || '',
    secret:   process.env.HOUSECANARY_SECRET || '',
    endpoint: (process.env.HOUSECANARY_ENDPOINT || 'https://api.housecanary.com').trim().replace(/\/+$/, ''),
  },
  //   Clear Capital ClearAVM — second AVM source
  clearCapital: {
    key:      process.env.CLEARCAPITAL_KEY || '',
    endpoint: (process.env.CLEARCAPITAL_ENDPOINT || 'https://api.clearcapital.com').trim().replace(/\/+$/, ''),
  },
  //   ATTOM Data Solutions — third AVM source + property intelligence
  attom: {
    key:      process.env.ATTOM_API_KEY || '',
    endpoint: (process.env.ATTOM_ENDPOINT || 'https://api.gateway.attomdata.com').trim().replace(/\/+$/, ''),
  },

  // --- AI autonomy master switch (owner-directed 2026-07-22, HARD RULE):
  // FALSE by default. When false, every AI agent (cure, committee, twin,
  // promoted-rules, entity chain, assignment fraud, wrong-condition, etc.)
  // routes its output to the ai_suggestions store — a human clicks to
  // escalate / add a note / convert to condition / convert to task /
  // mark important / dismiss / ask super-admin. The AI never writes
  // conditions, never changes file status, never overrides anything.
  // Set AI_AUTONOMOUS_MODE=1 ONLY if the owner explicitly re-opts in.
  aiAutonomousMode: process.env.AI_AUTONOMOUS_MODE === '1',
  // Gate the periodic auto-committee sweep (a scheduled digest run of the
  // multi-model panel over unreviewed findings). Even when the master
  // switch is off, super-admins can still run the committee on demand
  // from the file view. Default OFF (2026-07-22).
  aiAutoCommittee: process.env.AI_AUTO_COMMITTEE === '1',

  // --- Langfuse (owner-directed 2026-07-22): AI observability, free hobby tier.
  // Every AI call in PILOT (Azure OpenAI extraction, committee, docint OCR, azure-custom
  // classification/extraction) is TRACED — prompt + input + output + confidence + cost + latency —
  // and viewable in the Langfuse cloud UI so staff can audit every finding's reasoning.
  // Dormant until the two keys are set. Everything is best-effort + fire-and-forget: a Langfuse
  // outage never blocks a request, never adds latency (batched flush), and never throws.
  //   LANGFUSE_PUBLIC_KEY  starts with pk-lf-
  //   LANGFUSE_SECRET_KEY  starts with sk-lf-
  //   LANGFUSE_HOST        the cloud region base (us or eu). Default US.
  langfuse: {
    publicKey: (process.env.LANGFUSE_PUBLIC_KEY || '').trim(),
    secretKey: (process.env.LANGFUSE_SECRET_KEY || '').trim(),
    host:      (process.env.LANGFUSE_HOST || 'https://us.cloud.langfuse.com').trim().replace(/\/+$/, ''),
    project:   (process.env.LANGFUSE_PROJECT || 'pilot-underwriting').trim(),
  },

  // --- Azure Document Intelligence Custom models (owner-directed 2026-07-22).
  // Uses the SAME endpoint + key as `docint` above (single resource, single bill). Custom
  // Classification IDENTIFIES which of PILOT's document types each page-range of a combined
  // PDF is (bank_statement / insurance_dec / operating_agreement / drivers_license /
  // settlement / purchase_contract), and Custom Neural pulls STRUCTURED FIELDS from each
  // document type (holder name, coverage $, LLC members, etc.) with bounding boxes + confidence
  // per field for the "highlight the page section" finding UI. Dormant until a classifier and/or
  // per-type extractor id is set — each model id is the project name in Doc Intelligence Studio.
  //   AZURE_DOCINT_CLASSIFIER_ID     model id of the trained classifier (e.g. 'pilot-doc-splitter')
  //   AZURE_DOCINT_EXTRACT_*         per-type extractor ids
  azureCustom: {
    classifierId:            (process.env.AZURE_DOCINT_CLASSIFIER_ID || '').trim(),
    extractorBankStatement:  (process.env.AZURE_DOCINT_EXTRACT_BANK_STATEMENT || '').trim(),
    extractorInsurance:      (process.env.AZURE_DOCINT_EXTRACT_INSURANCE || '').trim(),
    extractorOperatingAgmt:  (process.env.AZURE_DOCINT_EXTRACT_OPERATING_AGREEMENT || '').trim(),
    extractorDriversLicense: (process.env.AZURE_DOCINT_EXTRACT_DRIVERS_LICENSE || '').trim(),
    extractorSettlement:     (process.env.AZURE_DOCINT_EXTRACT_SETTLEMENT || '').trim(),
    extractorPurchaseContract:(process.env.AZURE_DOCINT_EXTRACT_PURCHASE_CONTRACT || '').trim(),
    // Blob storage container that Doc Intelligence trains from + reads labeled data out of.
    // Created 2026-07-22 as pilotdocailabels / pilot-doc-ai-labels in East US.
    labelStorageAccount:     (process.env.AZURE_DOCAI_LABEL_STORAGE_ACCOUNT || 'pilotdocailabels').trim(),
    labelContainer:          (process.env.AZURE_DOCAI_LABEL_CONTAINER || 'pilot-doc-ai-labels').trim(),
    // Azure Blob SAS token OR account key so the labeling console can PUT bytes into the container.
    // Prefer a SAS token scoped to the container (least privilege); the account key works too.
    labelStorageSasToken:    (process.env.AZURE_DOCAI_LABEL_SAS_TOKEN || '').trim(),
    labelStorageAccountKey:  (process.env.AZURE_DOCAI_LABEL_ACCOUNT_KEY || '').trim(),
  },
};
