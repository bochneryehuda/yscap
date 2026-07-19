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
// links, redirects). NEVER emit an onrender.com link — the custom domain
// (yscapgroup.com) is live (owner-directed 2026-07-14). If APP_URL is still
// pointed at the onrender subdomain (e.g. a stale Render dashboard var that
// overrides render.yaml), rewrite it to the custom domain so nothing external
// ever shows onrender.
function publicBaseUrl() {
  let u = (process.env.APP_URL || 'https://www.yscapgroup.com').replace(/\/+$/, '');
  if (/onrender\.com/i.test(u)) u = 'https://www.yscapgroup.com';
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
  notifyFrom:    process.env.NOTIFY_FROM || 'YS Capital Group <no-reply@yscapgroup.com>',
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
    privateKey:     process.env.DOCUSIGN_PRIVATE_KEY,       // RSA private key (PEM)
    baseUri:        process.env.DOCUSIGN_BASE_URI  || 'https://demo.docusign.net/restapi',
    oauthBase:      process.env.DOCUSIGN_OAUTH_BASE || 'account-d.docusign.com', // account.docusign.com in prod
  },
  // Plaid (bank / asset verification):
  plaid: {
    clientId: process.env.PLAID_CLIENT_ID,
    secret:   process.env.PLAID_SECRET,
    env:      (process.env.PLAID_ENV || 'sandbox').toLowerCase(),  // sandbox | development | production
  },
  // Xactus (credit reports). The LOGIN is PER-USER, not here: each loan officer
  // stores their own LoginAccountIdentifier + password (encrypted) in
  // user_credit_credentials — this block is only the platform-level wiring the
  // adapter needs (the assigned API endpoint, the party names echoed in the
  // MISMO envelope, timeouts). The legacy username/password/clientId remain as an
  // optional platform fallback for a single-login deployment, but the portal
  // orders under the acting staffer's own credential.
  xactus: {
    // Assigned Xactus360 API base URL (e.g. https://<host>/...). No default —
    // the integration stays dormant until this is set in the environment.
    endpoint:            (process.env.XACTUS_ENDPOINT || '').trim().replace(/\/+$/, '') || null,
    // Names echoed into the MISMO REQUEST envelope.
    requestingPartyName: process.env.XACTUS_REQUESTING_PARTY || 'YS Capital Group',
    submittingPartyName: process.env.XACTUS_SUBMITTING_PARTY || 'YS Capital Group LOS',
    // Network budget for a single order/reissue POST (billable — never blind-retry).
    timeoutMs:           parseInt(process.env.XACTUS_TIMEOUT_MS || '45000', 10),
    // Verify a newly-saved credential by attempting a lightweight auth probe.
    // Off by default so saving a credential never accidentally bills; flip on
    // once the endpoint is live.
    verifyOnSave:        process.env.XACTUS_VERIFY_ON_SAVE === '1',
    // Optional platform-level fallback login (single-login deployments only).
    username:            process.env.XACTUS_USERNAME,
    password:            process.env.XACTUS_PASSWORD,
    clientId:            process.env.XACTUS_CLIENT_ID,
  },
};
