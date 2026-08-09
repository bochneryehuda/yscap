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
// The USPS keys, resolved once, whichever env name they are under (lib/usps-env).
const uspsEnv = require('./lib/usps-env').credentials();

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
/** A megabyte env value as bytes, with a real fallback. A blank/typo'd/non-finite
    or non-positive value falls back to the DEFAULT rather than to NaN (which would
    disable every size comparison that reads it) or to a near-zero floor. */
function mbBytes(v, defaultMb) {
  const n = Number(String(v == null ? '' : v).trim());
  const mb = Number.isFinite(n) && n > 0 ? n : defaultMb;
  return Math.max(1, Math.round(mb * 1024 * 1024));
}

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
  // Session lifetime. Tokens SLIDE: an authenticated request on a token older
  // than sessionRefreshAfterSec hands back a fresh one in X-Refresh-Token
  // (picked up by the SPA), so this is an IDLE timeout, not an absolute one —
  // someone who uses PILOT at least once a month is never signed out by the
  // clock. Raised 7d -> 30d (owner-directed 2026-07-26: "we need longer
  // sessions available; it should not automatically log out once you're logged
  // in"). Revocation is unaffected and still instant: per-device via the token's
  // sid (db/318, plain sign-out) and account-wide via token_version (password
  // change/reset, admin deactivation, "sign out everywhere").
  accessTtlSec:  parseInt(process.env.ACCESS_TTL_SEC || '2592000', 10),   // 30d idle timeout
  // How stale a token may get before an authenticated request renews it. Small
  // enough that an active user always rides a fresh token; large enough that we
  // aren't re-signing a JWT on every single request. Also capped at half the
  // token's life, so a deliberately SHORT ACCESS_TTL_SEC still slides properly.
  sessionRefreshAfterSec: parseInt(process.env.SESSION_REFRESH_AFTER_SEC || '43200', 10),  // 12h
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
  // The SALES desk inbox — the To: recipient for every marketing-site
  // submission that has NO routed loan officer (owner-directed 2026-07-24: a
  // branded ?lo= link or an explicit pick always goes to that officer INSTEAD;
  // nothing picked → sales). Covers applications, term-sheet events, track
  // record, rehab budget, quote/contact. A plain routing address like
  // SUBSCRIBE_NOTIFY_TO, not a secret; set SALES_NOTIFY_TO="" to fall back to
  // the admin desk fan-out instead.
  salesNotifyTo: (process.env.SALES_NOTIFY_TO != null ? process.env.SALES_NOTIFY_TO : 'sales@yscapgroup.com').trim() || null,
  // Owner-directed 2026-07-20: silently BCC the file's assigned loan officer on
  // every BORROWER notification email, so the LO sees in real time exactly what
  // their borrower received. BCC (not CC) — the borrower's inbox stays clean and
  // the officer's address isn't exposed. On by default; set CC_LO_ON_BORROWER=0
  // to turn off.
  ccLoanOfficerOnBorrowerEmail: process.env.CC_LO_ON_BORROWER !== '0',
  // The closing-attorney GROUP inbox the "file ready for closing prep" order is
  // addressed to (owner-directed 2026-07-28; the same address the rtl_p5_atty
  // condition has named by hand since db/005). Env-backed rather than a literal
  // so a firm change is a config edit, not a deploy. A routing address, not a secret.
  //
  // THIS IS THE ONLY RECIPIENT of a closing-prep order, so it must be set for the
  // feature to work. It used to say `ATTORNEY_GROUP_EMAIL=""` would "require an
  // attorney contact on the file instead" — that stopped being true the moment the
  // file's `attorney` contact was correctly removed from the recipient list (it is
  // the BORROWER'S counsel, handed over in the body, never copied). Blanking this
  // now blocks every closing-prep order with a message no staffer can act on, so
  // the guidance is gone rather than left as a trap.
  attorneyGroupEmail: (process.env.ATTORNEY_GROUP_EMAIL != null
    ? process.env.ATTORNEY_GROUP_EMAIL : 'teamag@privatelenderlaw.com').trim().toLowerCase() || null,
  // Total attachment budget for one closing-prep email. Resend accepts ~40 MB per
  // message; Microsoft Graph rejects inline attachments over ~3 MB (it needs an
  // upload session we don't implement), so the Graph budget is deliberately tiny.
  // Nothing is ever silently dropped — whatever doesn't fit is NAMED in the email
  // and reported back to the sender.
  // Both parsed through one helper: a typo'd value used to become NaN, and
  // `total + len > NaN` is always false — which silently turned the budget OFF
  // instead of falling back to the default. The megabyte multiply is inside the
  // clamp for both, so a 0 can never mean "one byte" (every document skipped).
  closingAttachBudgetBytes: mbBytes(process.env.CLOSING_ATTACH_BUDGET_MB, 20),
  closingAttachBudgetGraphBytes: mbBytes(process.env.CLOSING_ATTACH_BUDGET_GRAPH_MB, 2.5),
  // The ceiling on ONE MESSAGE AS IT TRAVELS. Attachments go base64 (4 characters
  // per 3 bytes), and it is that inflated size a receiving mail server measures —
  // Google Workspace and most corporate gateways refuse a message over 25 MB. A
  // 20 MB raw package is 26.7 MB on the wire, so the budget above alone would let
  // us hand Resend a message the attorney's own server bounces. 24 MB keeps every
  // message under that line with room to spare (and far under Resend's own 40 MB).
  closingAttachWireBytes: mbBytes(process.env.CLOSING_ATTACH_WIRE_MB, 24),
  // How many messages one closing-prep package may be split across when it does not
  // fit in a single email (owner-directed 2026-08-02: a document too big to attach
  // must still REACH the attorney). Six is far more than any real package needs —
  // it is a runaway backstop, not a target — and anything still over it is NAMED in
  // the email and reported to the sender rather than silently dropped.
  closingAttachMaxParts: Math.max(1, Math.min(20, Number(process.env.CLOSING_ATTACH_MAX_PARTS) || 6)),
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

  // Automatic As-Is update from the appraisal (owner-directed 2026-07-28): PILOT reads the As-Is —
  // the data file first, then the report PDF with the strongest OCR + AI — and, when it is CONFIDENT
  // and the value is BELOW the purchase price, lowers the file's As-Is and opens the "Confirm the
  // As-Is value" condition for a human to re-review. ON by default because the owner asked for it;
  // `APPRAISAL_ASIS_AUTO=0` (or the switch on the API Health page) turns the WRITE off instantly
  // without a deploy — the reading still runs and still surfaces on the condition, it just never
  // touches the file.
  appraisalAsIsAutoEnabled: process.env.APPRAISAL_ASIS_AUTO !== '0',
  // How many previously-imported appraisals the boot sweep may read per boot with the paid OCR/AI
  // path (the free XML-only tier is unbounded). Small on purpose — reading a 30 MB appraisal PDF
  // costs real money, and the sweep drains a little on every deploy.
  appraisalAsIsBackfillFiles: Math.max(0, parseInt(process.env.APPRAISAL_ASIS_BACKFILL_FILES || '5', 10) || 0),
  // GOING FORWARD ONLY (owner-directed 2026-07-28). Reading the back book WRITES loan values, so the
  // retroactive sweep is OFF by default and is not called at boot at all — new appraisal imports are
  // read, previously-imported ones are left alone. Set APPRAISAL_ASIS_SWEEP_FILES to a small number
  // and invoke desk.backfillAsIsReadsOnce() by hand to run a bounded pass deliberately.
  appraisalAsIsSweepFiles: Math.max(0, parseInt(process.env.APPRAISAL_ASIS_SWEEP_FILES || '0', 10) || 0),

  // Auto-clear the "Credit report" condition once every borrower on the file has a
  // report imported AND its PDF filed (never a false-clear — see src/lib/credit/completeness.js).
  // OFF by default: clearing a condition without a human sign-off is a sensitive action,
  // so it stays a deliberate opt-in per environment.
  creditAutoclearEnabled: process.env.CREDIT_AUTOCLEAR_ENABLED === '1',

  // Auto-clear the "Government-issued ID" condition once PILOT has AI-READ the ID on
  // this file and every checked field lines up (no open ID finding). Never a
  // false-clear — see src/lib/underwriting/gov-id-autoclear.js. OFF by default:
  // clearing an identity condition without a human is sensitive, so it's opt-in.
  govIdAutoclearEnabled: process.env.GOVID_AUTOCLEAR_ENABLED === '1',

  // Auto-clear the "Background check / OFAC" condition once PILOT has AI-read the
  // background report on the file and it comes back clean (no open background/OFAC
  // finding). Never a false-clear — see src/lib/underwriting/fraud-autoclear.js.
  // OFF by default: OFAC/BSA-AML is compliance-sensitive, so it's opt-in.
  fraudAutoclearEnabled: process.env.FRAUD_AUTOCLEAR_ENABLED === '1',

  // Auto-clear the "Bank statements / liquid assets" condition once PILOT has AI-read
  // the statements on the file AND the borrower's (and verified entity's) liquid assets
  // provably cover what the registered deal requires — stricter than the human gate,
  // never a false-clear. See src/lib/underwriting/assets-autoclear.js. OFF by default.
  assetsAutoclearEnabled: process.env.ASSETS_AUTOCLEAR_ENABLED === '1',

  // Auto-clear the "SSN verification" condition (cond_ssn_verify_corrfirst, db/398) —
  // CorrFirst note buyer ONLY —
  // once an imported credit report's SSN provably matches the SSN on file for every
  // borrower. Note-buyer-specific (CorrFirst verifies the SSN off the credit report),
  // stricter than a blind clear, never a false-clear. See src/lib/underwriting/ssn-autoclear.js.
  // OFF by default.
  ssnAutoclearEnabled: process.env.SSN_AUTOCLEAR_ENABLED === '1',

  // "PILOT verified — ready to clear" advisory STAMP (owner-directed 2026-07-24). When a
  // per-domain completeness check (credit / gov-ID / SSN / assets / purchase-contract /
  // background) verifies a Condition Center condition is met, PILOT does NOT sign it off —
  // it puts an advisory stamp on the condition (the pilot_advice / pilot_advice_note /
  // pilot_advice_at columns, db/295) and a human still clears it. The stamp is safe (it never
  // clears anything), so it is ON by default; set PILOT_READY_STAMP=0 to turn the advisory off
  // entirely. This is the go-forward replacement for the old per-domain *_AUTOCLEAR_ENABLED
  // flags below, which stay OFF by default (=== '1'); a follow-up removes those sign-off paths.
  pilotReadyStampEnabled: process.env.PILOT_READY_STAMP !== '0',

  // Auto-clear the "Executed purchase contract" condition (rtl_p1_contract) once PILOT has
  // read the purchase contract (and, on an assignment, the assignment agreement) on this file
  // AND its economics reconcile — no open FATAL contract/assignment finding remains (price,
  // address, buyer entity, assignment fee, and seller/underlying price all tie out to the loan).
  // Stricter than a blind clear, symmetric (self-reopens when a re-read or an economics change
  // no longer reconciles), never a false-clear. See src/lib/underwriting/contract-autoclear.js.
  // OFF by default.
  contractAutoclearEnabled: process.env.CONTRACT_AUTOCLEAR_ENABLED === '1',

  // --- document storage ---
  storageProvider: process.env.STORAGE_PROVIDER || 'local', // 'local' | 's3' | 'sharepoint'
  // On Render, set STORAGE_DIR to a mounted persistent disk (e.g. /var/data/uploads)
  // so documents survive deploys — the default filesystem is ephemeral.
  storageDir:      process.env.STORAGE_DIR || 'uploads',
  maxUploadMb:     parseInt(process.env.MAX_UPLOAD_MB || '20', 10),   // per-file cap
  // S3-compatible object storage (AWS S3 / Cloudflare R2 / Backblaze B2 / …). Used only when
  // STORAGE_PROVIDER=s3. Credentials come from Render env ONLY (never source). The adapter signs
  // requests itself (AWS SigV4, Node crypto — no SDK, no new deps). `region` defaults to 'auto'
  // (R2 uses 'auto'); `forcePathStyle` defaults ON (bucket in the URL path — what R2 + most
  // S3-compatibles want). With STORAGE_PROVIDER unset (=local) every S3 var is ignored.
  s3: {
    bucket:         (process.env.S3_BUCKET || '').trim(),
    endpoint:       (process.env.S3_ENDPOINT || '').trim(),   // e.g. https://<acct>.r2.cloudflarestorage.com
    accessKeyId:    (process.env.S3_ACCESS_KEY_ID || '').trim(),
    secretAccessKey:(process.env.S3_SECRET_ACCESS_KEY || '').trim(),
    region:         (process.env.S3_REGION || 'auto').trim() || 'auto',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE == null) ? true
                      : /^(1|true|yes)$/i.test(String(process.env.S3_FORCE_PATH_STYLE).trim()),
  },

  // --- OFF-SITE BACKUP (owner-directed 2026-08-02) ---
  // The nightly encrypted dump of the whole database into an object-storage vault that is NOT
  // Render — see docs/DATABASE-BACKUP-AND-RESTORE.md. Only the switches live here; the per-vault
  // settings (BACKUP_S3_* / BACKUP_S3_SECONDARY_*) are read by src/lib/backup/vault.js and the
  // retention window by src/lib/backup/retention.js, each from one place, so a new vault is
  // env-only and touches no code.
  //
  // INERT until configured: with no key and no bucket, `npm run backup` refuses politely and the
  // app itself is completely unaffected — nothing in the request path ever loads these modules.
  backup: {
    // The master key that encrypts every backup BEFORE it leaves this machine. Generate with
    // `openssl rand -base64 32`. Without it the job refuses to run rather than writing borrower
    // data to a third-party bucket in the clear.
    encryptionKey:   (process.env.BACKUP_ENCRYPTION_KEY || '').trim(),
    // Normally the live database. Point it somewhere else to back up a copy (e.g. a read replica)
    // without the job needing the production connection string.
    databaseUrl:     (process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL || '').trim(),
    // Scratch space for the encrypted dump before it is uploaded. It is deleted afterwards, always
    // (including when the job fails). Needs room for the compressed dump — roughly a quarter of the
    // database size, but size it generously.
    tempDir:         (process.env.BACKUP_TEMP_DIR || '').trim(),
    // Skip the scratch file and pipe pg_dump straight into the upload. Uses almost no disk, but a
    // failed upload means re-running the whole dump, and a second vault means a second dump — so
    // it is off by default and exists for databases too big for the cron job's disk.
    streamDirect:    /^(1|true|yes)$/i.test(String(process.env.BACKUP_STREAM_DIRECT || '').trim()),
    // Also copy the DOCUMENT objects (loan PDFs) into the vault. A database restored without them
    // has every loan file and no paperwork, so this defaults ON whenever S3 documents are in use.
    documents:       process.env.BACKUP_DOCUMENTS == null
                       ? true : /^(1|true|yes)$/i.test(String(process.env.BACKUP_DOCUMENTS).trim()),
    // Ceiling on how many document objects one nightly run will copy, so the first run after a big
    // import cannot run for hours. The rest are picked up by the next run — the state table makes
    // the copy resumable.
    documentsPerRun: Math.max(1, parseInt(process.env.BACKUP_DOCUMENTS_PER_RUN || '5000', 10) || 5000),
    // Where "the backup failed" is emailed. Falls back to NOTIFY_ADMINS. A backup system that fails
    // quietly is worse than none, because it is believed.
    alertEmail:      (process.env.BACKUP_ALERT_EMAIL || process.env.NOTIFY_ADMINS || '').trim(),
    // Email on a clean run too. Off by default — a nightly "all good" becomes noise nobody reads,
    // and the health page already shows the last successful run.
    alertOnSuccess:  /^(1|true|yes)$/i.test(String(process.env.BACKUP_ALERT_ON_SUCCESS || '').trim()),
    // The scratch database used by the weekly restore DRILL. It is DROPPED and recreated on every
    // drill, so it must never point at anything real — the drill refuses if it equals DATABASE_URL.
    verifyDatabaseUrl: (process.env.BACKUP_VERIFY_DATABASE_URL || '').trim(),
    // How old the newest backup may be before the weekly drill treats it as an INCIDENT rather
    // than a clean pass. The nightly job only emails on failure, and a job that never runs never
    // fails — so a stopped cron is silent, and the drill would keep restoring an ever-older backup
    // and reporting "passed". 48h clears one late run without excusing a missed night.
    // 0 disables the check (not recommended — it is the only detector of a stopped nightly).
    verifyMaxAgeHours: Number.isFinite(parseFloat(process.env.BACKUP_VERIFY_MAX_AGE_HOURS))
      ? parseFloat(process.env.BACKUP_VERIFY_MAX_AGE_HOURS) : 48,
    // The DAILY watch, run by the WEB service (src/lib/notification-digests.js), not by either cron.
    //
    // The drill above is the only thing that reports a stopped nightly — and it runs WEEKLY, so a
    // backup that stops on Monday is not noticed until Sunday. Six unprotected days is the gap; the
    // web service is already awake every 30 minutes and can read the same ledger, so it checks daily.
    // 36h = one missed night plus half a day of slack, so a merely LATE run never cries wolf.
    // 0 disables it.
    watchMaxAgeHours: Number.isFinite(parseFloat(process.env.BACKUP_WATCH_MAX_AGE_HOURS))
      ? parseFloat(process.env.BACKUP_WATCH_MAX_AGE_HOURS) : 36,
    // How many days a passing restore DRILL stays believable before the watch mentions it. The drill
    // is weekly, so this must clear a missed week without nagging — it is a heads-up, never an alarm.
    watchVerifyStaleDays: Number.isFinite(parseFloat(process.env.BACKUP_WATCH_VERIFY_STALE_DAYS))
      ? parseFloat(process.env.BACKUP_WATCH_VERIFY_STALE_DAYS) : 10,
  },

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
  // ---- TrustPoint (the note buyer's draw administrator — Blue Lake physical files; ----
  // ---- blueprint docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md). Read-mostly:  ----
  // ---- phase 2 is a mirror (GET + webhooks); the ONLY write is webhook registration. ----
  trustpointEnabled:    process.env.TRUSTPOINT_ENABLED === '1',       // master switch (default off)
  trustpointDryrun:     process.env.TRUSTPOINT_DRYRUN === '1',        // log intended calls, send nothing
  trustpointApiKey:     process.env.TRUSTPOINT_API_KEY || null,       // 'Authorization: Api-Key <key>' — Render env ONLY
  trustpointBaseUrl:    (process.env.TRUSTPOINT_BASE_URL || 'https://api.trustpoint.ai').replace(/\/+$/, ''),
  // Spec paths use /public-api/, prose uses /v1/ — verify on sandbox; configurable so a flip is env-only.
  trustpointPathPrefix: process.env.TRUSTPOINT_PATH_PREFIX || '/public-api',
  trustpointPollSec:    parseInt(process.env.TRUSTPOINT_POLL_SEC || '300', 10),      // draw watermark poll
  trustpointSweepSec:   parseInt(process.env.TRUSTPOINT_SWEEP_SEC || '1800', 10),    // project discovery sweep
  // The shared token PILOT issues to TrustPoint at webhook registration; inbound deliveries
  // must present it (Authorization: Bearer <token> or X-Api-Key). Render env ONLY.
  trustpointWebhookToken: process.env.TRUSTPOINT_WEBHOOK_TOKEN || null,

  // ---- Elementix (recorded deeds / mortgages, reached over MCP). READ-ONLY. ----
  // No API key is bought: the endpoint uses the standard MCP OAuth flow, so PILOT
  // signs in on the seat the owner already pays for, approved once in a browser.
  // Auth lives in src/elementix/oauth.js; the guarded client is src/elementix/client.js.
  // Capability map + the county-by-county coverage caveats: docs/ELEMENTIX-RESEARCH.md.
  elementix: {
    url:          (process.env.ELEMENTIX_URL || 'https://app.elementix.com/api/mcp').replace(/\/+$/, ''),
    enabled:      process.env.ELEMENTIX_ENABLED === '1',   // master switch (default off)
    dryrun:       process.env.ELEMENTIX_DRYRUN === '1',    // log the intended call, send nothing
    // Only needed if Elementix declines self-registration and hands us a client id
    // instead. Render env ONLY, never committed.
    clientId:     process.env.ELEMENTIX_CLIENT_ID || null,
    clientSecret: process.env.ELEMENTIX_CLIENT_SECRET || null,
    // Escape hatch for when the endpoint publishes no discoverable metadata.
    authServer:   process.env.ELEMENTIX_AUTH_SERVER || null,
    // At-rest key for the stored tokens; falls back to the SSN key. Changing it
    // does not lose anything dangerous — somebody re-approves once.
    tokenKey:     process.env.ELEMENTIX_TOKEN_KEY || null,
    // THE OWNER'S MONEY CAP: "I have only 1,000 per month." This is the number
    // of CREDIT-SPENDING contact look-ups allowed in a calendar month, counted
    // in the database (db/503) so it survives a deploy and spans every instance.
    // PILOT never spends one on its own — see src/lib/elementix/lookups.js.
    paidPerMonth: Math.max(0, Number(process.env.ELEMENTIX_PAID_PER_MONTH || 1000)),
    // Self-cap well under the platform ceiling of 1,000 requests/hour, which is
    // shared by the WHOLE organization across every connected client — every
    // officer's session and every background job draw from the same bucket.
    maxPerHour:   parseInt(process.env.ELEMENTIX_MAX_PER_HOUR || '400', 10),
    maxPerSec:    parseInt(process.env.ELEMENTIX_MAX_PER_SEC || '3', 10),
  },

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
    // THE KEYS, WHICHEVER NAME THEY ARE UNDER. `USPS_CLIENT_ID` /
    // `USPS_CLIENT_SECRET` are the documented names and are read first, but USPS's
    // own portal labels the same v3 OAuth pair "Consumer Key" / "Consumer Secret"
    // on some screens — so a value set as `USPS_CONSUMER_KEY` was invisible here
    // and the integration reported "not connected" forever with no way to tell
    // that from genuinely-not-configured. `lib/usps-env` owns the list and the
    // diagnostic (which names variables, never values). It deliberately does NOT
    // accept a Web Tools user id: that is the older XML API and would fail
    // authentication in a way that reads as "your key is wrong".
    clientId:     uspsEnv.clientId,
    clientSecret: uspsEnv.clientSecret,
    baseUrl:      (process.env.USPS_API_BASE || 'https://apis.usps.com').replace(/\/+$/, ''),
    // OPTIONAL OAuth scope for the token request (`USPS_OAUTH_SCOPE`, default unset).
    // USPS gates each API by an "API product" attached to the app on the developer
    // portal, so a 403 on /addresses/v3/address is almost always a missing Addresses
    // API license — NOT a scope problem — and this will not fix that. It exists only
    // for the rarer case where USPS support says the token must name the scope (e.g.
    // "addresses"). Inert unless set. CAUTION: a wrong value can make the SIGN-IN itself
    // fail (invalid_scope) and take verification down — leave it unset unless USPS support
    // says otherwise. See docs/USPS-ADDRESS-VERIFICATION.md (Troubleshooting).
    oauthScope:   (process.env.USPS_OAUTH_SCOPE || '').trim(),
    // Burst brake for the FREE tier (60 lookups/hour, shared across USPS APIs): once
    // this many lookups happen in a rolling hour, further LIVE verifies are skipped
    // (the form still works) and the backfill pauses until the window clears, so the
    // hour's quota is never burned. Defaults to 55 (safe for the free tier, a little
    // headroom) — set 0 for NO cap once you're on a paid Enhanced Addresses tier.
    // NOTE: the counter is per-process, so with N app instances the effective cap is
    // N × this value; on the free tier run a single instance or lower this.
    maxPerHour:   process.env.USPS_MAX_PER_HOUR != null ? Number(process.env.USPS_MAX_PER_HOUR) : 55,
    // Previous-files backfill (off by default). When on, a paced boot pass stamps
    // each existing file with its USPS-standardized subject address (non-destructive
    // — it never overwrites property_address).
    backfillEnabled: /^(1|true|yes)$/i.test(String(process.env.USPS_BACKFILL_ENABLED || '')),
    backfillPerTick: Number(process.env.USPS_BACKFILL_PER_TICK || 40),   // lookups per pass; keep ≤ your hourly quota
    backfillEveryMin: Number(process.env.USPS_BACKFILL_EVERY_MIN || 60), // minutes between passes (floor 15)
    conditionRequired: !/^(0|false|no)$/i.test(String(process.env.USPS_CONDITION_REQUIRED || '1')),
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
  // Encompass FLOOD ordering — the ONE owner-authorized WRITE into Encompass
  // (order a Life-of-Loan flood determination from ICE's own flood service, and
  // nothing else). Isolated in src/encompass/flood-order.js; the read-only module
  // is untouched. Staged rollout, all default OFF:
  //   ENCOMPASS_FLOOD_ENABLED          master (reads + poll worker) — via switches.js
  //   ENCOMPASS_FLOOD_OUTBOUND_ENABLED separate write gate (place an order) — via switches.js
  //   ENCOMPASS_FLOOD_DRYRUN           build + log the order body, send nothing
  // Credentials default to the tenant's existing Encompass creds; a dedicated
  // flood-authorized API user can be dropped into the ENCOMPASS_FLOOD_* overrides.
  encompassFlood: {
    clientId:     process.env.ENCOMPASS_FLOOD_CLIENT_ID || null,
    clientSecret: process.env.ENCOMPASS_FLOOD_CLIENT_SECRET || null,
    instanceId:   process.env.ENCOMPASS_FLOOD_INSTANCE_ID || null,
    username:     process.env.ENCOMPASS_FLOOD_USERNAME || null,
    password:     process.env.ENCOMPASS_FLOOD_PASSWORD || null,
    dryrun:       process.env.ENCOMPASS_FLOOD_DRYRUN === '1',
    framework:    process.env.ENCOMPASS_FLOOD_FRAMEWORK || null,   // 'serviceOrders' (default) | 'partnerTransactions'
    partnerId:    process.env.ENCOMPASS_FLOOD_PARTNER_ID || null,
    serviceId:    process.env.ENCOMPASS_FLOOD_SERVICE_ID || null,
    product:      process.env.ENCOMPASS_FLOOD_PRODUCT || null,
    // The tenant's configured flood "service setup" id — REQUIRED by the Encompass
    // v3 serviceOrders API (a place-order without it returns "SOO-1125:
    // serviceSetupId is required"). It identifies WHICH configured service/vendor
    // to order from (the owner's ICE flood service). Ask the Encompass admin for it.
    serviceSetupId: process.env.ENCOMPASS_FLOOD_SERVICE_SETUP_ID || null,
    // The remaining serviceOrders body fields — all overridable so the exact
    // contract can be dialed in against the live tenant (dry-run to inspect) with
    // NO redeploy. Defaults match the documented EPC service-order shape.
    reason:       process.env.ENCOMPASS_FLOOD_REASON || null,        // default 'Manually Requested'
    requestType:  process.env.ENCOMPASS_FLOOD_REQUEST_TYPE || null,  // default 'Flood'
    scope:        process.env.ENCOMPASS_FLOOD_SCOPE || null,         // optional (e.g. 'application:<id>')
    optionsJson:  process.env.ENCOMPASS_FLOOD_OPTIONS_JSON || null,  // optional raw JSON for request.options
  },
  // Owner-directed 2026-07-30 ("turn everything on"): flood ordering is ON by
  // default (button + polling AND the write). Set the env var to '0' — or flip the
  // switch OFF on the API-Health page — to pause it. TEST MODE (dryrun) stays off.
  encompassFloodEnabled: process.env.ENCOMPASS_FLOOD_ENABLED !== '0',            // master (default ON)
  encompassFloodOutboundEnabled: process.env.ENCOMPASS_FLOOD_OUTBOUND_ENABLED !== '0', // write gate (default ON)

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
  //   Xactus "Flood ReportX" (MISMO 2.4) — the ACTIVE flood-cert provider
  //   (owner-directed 2026-07-30, "much cheaper for us to use"). The Encompass
  //   flood provider is parked; FLOOD_ORDER_PROVIDER picks which the button uses.
  //   USES THE SAME XACTUS LOGIN AS CREDIT — no separate flood credentials
  //   (owner-directed 2026-07-30: "it's the same credentials, we don't need extra
  //   credentials for flood"). The LOGIN falls back to the credit connection
  //   (XACTUS_API_USERNAME/PASSWORD) — same Xactus account. The WEB ADDRESS does
  //   NOT fall back: Flood ReportX is MISMO 2.4 and credit is MISMO 3.4, which are
  //   DIFFERENT endpoints on the Xactus360 gateway (credit …/uaweb/mismo3, flood
  //   …/uaweb/mismo2), so XACTUS_FLOOD_API_URL MUST be set to the flood endpoint —
  //   posting a 2.4 flood order to the 3.4 credit endpoint is rejected with no
  //   reason (owner-reported 2026-08-02). It does NOT fall back to XACTUS_API_URL.
  xactusFlood: {
    endpoint: (process.env.XACTUS_FLOOD_API_URL || '').trim().replace(/\/+$/, ''),
    username: (process.env.XACTUS_FLOOD_USERNAME || process.env.XACTUS_API_USERNAME || '').trim(),
    password: process.env.XACTUS_FLOOD_PASSWORD || process.env.XACTUS_API_PASSWORD || '',
    version:  (process.env.XACTUS_FLOOD_VERSION || '2.4').trim(),
    // 'life' = Life-of-Loan (monitored for the life of the loan) — the default for
    // a mortgage; 'basic' = a one-time determination (cheaper, no monitoring).
    product:  (process.env.XACTUS_FLOOD_PRODUCT || 'life').trim(),
    requestingParty: (process.env.XACTUS_REQUESTING_PARTY || 'YS Capital Group').trim(),
    // Explicitly ask Xactus to embed the certificate PDF in every response (their
    // _UseEmbeddedFileIndicator toggle can otherwise EXCLUDE it). ON by default —
    // set XACTUS_FLOOD_REQUEST_PDF=0 ONLY if Xactus ever rejects the element, which
    // restores flood ordering without a redeploy.
    requestPdf: process.env.XACTUS_FLOOD_REQUEST_PDF !== '0',
    // Test mode is REMOVED (owner-directed 2026-08-02: "remove the test mode, go live
    // right away"). A staff click ALWAYS places a REAL, billable order — there is no
    // dry-run gate (flood.js dryrun() is hard-false), because a stored runtime override
    // kept surviving deploys and pinning the button in test mode. The master switch
    // XACTUS_FLOOD_ENABLED is the kill switch; nothing is ever ordered automatically.
    // Flood ReportX authenticates via URL QUERY PARAMS — LoginAccountIdentifier /
    // LoginAccountPassword in the URL, with only a Content-Type header — NOT an HTTP
    // Basic header. This is exactly what the Xactus Flood ReportX Postman collection
    // does (every action posts to {baseUrl}?LoginAccountIdentifier=…&LoginAccountPassword=…).
    // Default 'query'; set XACTUS_FLOOD_AUTH_MODE=basic ONLY if Xactus tells you this
    // account uses a Basic header instead.
    authMode: /^basic$/i.test((process.env.XACTUS_FLOOD_AUTH_MODE || 'query').trim()) ? 'basic' : 'query',
  },
  // Which flood provider the "Order flood certificate" button uses.
  floodProvider: (process.env.FLOOD_ORDER_PROVIDER || 'xactus').trim().toLowerCase(),
  // Xactus flood master switch (default ON; the configured-check still gates any
  // real order until the flood endpoint + login are set). Off = pause the button.
  xactusFloodEnabled: process.env.XACTUS_FLOOD_ENABLED !== '0',
  //   HouseCanary — AVM + Rent AVM (independent value + rent triangulation)
  houseCanary: {
    key:      process.env.HOUSECANARY_KEY || '',
    secret:   process.env.HOUSECANARY_SECRET || '',
    endpoint: (process.env.HOUSECANARY_ENDPOINT || 'https://api.housecanary.com').trim().replace(/\/+$/, ''),
  },
  //   Clear Capital ClearAVM — third independent AVM source (ATTOM + HouseCanary + Clear Capital → real triangulation)
  clearCapital: {
    key:      process.env.CLEARCAPITAL_KEY || '',
    endpoint: (process.env.CLEARCAPITAL_ENDPOINT || 'https://api.clearcapital.com').trim().replace(/\/+$/, ''),
    // The ClearAVM value endpoint PATH — env-overridable so the exact contract path
    // can be confirmed against Clear Capital's docs at onboarding without a code change.
    avmPath:  (process.env.CLEARCAPITAL_AVM_PATH || '/uve/v1.0.0/avm').trim(),
  },
  //   ATTOM Data Solutions — AVM source + property intelligence
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
    // A human-readable LABEL only — attached to trace metadata so traces are easy to find.
    project:   (process.env.LANGFUSE_PROJECT || 'pilot-underwriting').trim(),
    // The OPAQUE project identifier Langfuse itself generates, which its web URLs are addressed by.
    // Optional: when unset it is looked up from Langfuse's own API using the keys above. Never
    // guessed from the label — building a link out of the label is what made every "AI reasoning
    // trace" link 404 (owner-reported 2026-07-26).
    projectId: (process.env.LANGFUSE_PROJECT_ID || '').trim(),
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

  // ── Pipeline V2 (owner-directed 2026-07-26) — the durable, evidence-first document
  // pipeline restructure. ADDITIVE + OFF by default: with these env vars unset, everyone
  // stays on Pipeline V1 and the background worker does nothing. The owner flips them on in
  // Render one document family at a time after shadow testing proves the new path is better.
  // Accepts '1' or 'true' (the owner's Render checklist uses =true).
  pipeline: (() => {
    const on = (v) => { const s = String(v || '').trim().toLowerCase(); return s === '1' || s === 'true'; };
    const csv = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return {
      // There is intentionally NO `version` / UNDERWRITING_PIPELINE_VERSION selector (VSLICE-8):
      // Pipeline V2 is ADVISORY-ONLY, so V1 is ALWAYS the exposed pipeline and V2 only ever runs in
      // shadow. A settable "exposed pipeline = v1|v2" flag implied a V2-exposure capability that does
      // not (and must not yet) exist — flipping it changed nothing, which was the defect. The real
      // switches below are the only controls; the go-live exposure switch will be introduced
      // deliberately as part of the eventual cutover, never left as a dead knob.
      v2Enabled:         on(process.env.UW_PIPELINE_V2_ENABLED),   // build/run v2 at all (default OFF)
      v2Shadow:          on(process.env.UW_PIPELINE_V2_SHADOW),    // run v2 beside v1, never expose (default OFF)
      v2Families:        csv(process.env.UW_PIPELINE_V2_FAMILIES), // families promoted to v2, e.g. bank_statement,insurance ('all'/'*' = every family)
      // Phase 3b — actually READ the shadow documents (load real bytes → primary OCR adapter).
      // Default OFF: even with the worker + shadow on, the shadow line only PLANS a route until
      // this is set. ADVISORY — a real read still writes ONLY the V2 audit tables, never a loan
      // file. Turning it on spends real vendor OCR budget on every shadow document, so it is a
      // deliberate, separate switch (UW_PIPELINE_V2_READ=1).
      v2ReadEnabled:     on(process.env.UW_PIPELINE_V2_READ),
      // RS-2 — CLASSIFY the shadow documents (a SECOND full-document Azure Document Intelligence
      // call, on top of the OCR read above). Default OFF, and deliberately its own switch for the
      // same reason `v2ReadEnabled` is: without it, an owner who has trained the classifier for
      // V1's package splitter (AZURE_DOCINT_CLASSIFIER_ID) would silently start paying for a
      // second vendor call on every shadow document, having opted into nothing. ADVISORY either
      // way — the classification writes only V2 audit tables and never gates a job.
      v2ClassifyEnabled: on(process.env.UW_PIPELINE_V2_CLASSIFY),
      workerEnabled:     on(process.env.UW_WORKER_ENABLED),        // start the durable-job background worker (default OFF)
      workerConcurrency: Math.max(1, parseInt(process.env.UW_WORKER_CONCURRENCY || '2', 10) || 2),
      jobMaxAttempts:    Math.max(1, parseInt(process.env.UW_JOB_MAX_ATTEMPTS || '5', 10) || 5),
      jobLeaseSeconds:   Math.max(30, parseInt(process.env.UW_JOB_LEASE_SECONDS || '300', 10) || 300),
    };
  })(),

  // --- AMC appraisal ordering (AppraisalScope / CoreLogic Digital Gateway) ---
  // The outbound appraisal-ordering integration: place the order directly with the
  // AMC, track its lifecycle, message the AMC back and forth, request revisions /
  // ROV reconsiderations, push + pull documents, and pull the finished report back
  // into the file. It talks to CoreLogic's Digital Gateway (CDG), a synchronous
  // "pull" gateway in front of AppraisalScope — WE always initiate, and it never
  // pushes to us, so status / comments / revisions / documents are all polled.
  //
  // Modeled on the Sitewire draw integration. Staged rollout, ALL default OFF:
  //   AMC_ENABLED          master switch — the lookups cache + the poll worker (reads)
  //   AMC_OUTBOUND_ENABLED separate gate — actually place / message / upload (WRITES)
  //   AMC_DRYRUN           build + log the exact request body, send nothing
  // Credentials come from Render env ONLY (never source, never chat). CoreLogic/the
  // vendor provide: the OAuth client id/secret (GetToken), the DoLogin account
  // id/password, the ServiceProviderSubDomain, the DigitalGatewayLenderIdentifier
  // (a CoreLogic reporting id), and the sourceClientIdentifier. Nothing talks to the
  // AMC until AMC_ENABLED=1 and these are set.
  amc: {
    enabled:        process.env.AMC_ENABLED === '1',            // master (default OFF)
    outboundEnabled: process.env.AMC_OUTBOUND_ENABLED === '1',  // write gate (default OFF)
    dryrun:         process.env.AMC_DRYRUN === '1',             // build + log, send nothing

    // ---- endpoints (UAT vs PROD). CoreLogic assigns these; overridable so an env
    // flip needs no redeploy. Defaults are the documented UAT hosts. ----
    // OAuth2 token endpoint (client_credentials grant).
    oauthUrl:  (process.env.AMC_OAUTH_URL
                 || 'https://api-uat.corelogic.com/order-gateway-oauth2/token?grant_type=client_credentials')
                 .trim(),
    // DoLogin endpoint (returns the AppraisalScope api_key).
    loginUrl:  (process.env.AMC_LOGIN_URL
                 || 'https://uat1.globalgateway.corelogic.com/direct/appraisal_service/request/appraisalscope/client')
                 .trim().replace(/\/+$/, ''),
    // Order + lookup endpoint (the ?orderId= is appended for order-specific updates).
    orderUrl:  (process.env.AMC_ORDER_URL
                 || 'https://uat1.globalgateway.corelogic.com/order/appraisal_service/request/appraisalscope/client')
                 .trim().replace(/\/+$/, ''),
    // Document multipart-upload endpoint (returns a getdocument retrieval URL).
    postDocumentsUrl: (process.env.AMC_POSTDOCUMENTS_URL
                 || 'https://uat1.globalgateway.corelogic.com/postdocuments')
                 .trim().replace(/\/+$/, ''),

    // ---- credentials (Render env ONLY) ----
    clientId:      process.env.AMC_CLIENT_ID || null,          // OAuth GetToken client id
    clientSecret:  process.env.AMC_CLIENT_SECRET || null,      // OAuth GetToken client secret
    loginAccount:  process.env.AMC_LOGIN_ACCOUNT || null,      // DoLogin loginAccountIdentifier
    loginPassword: process.env.AMC_LOGIN_PASSWORD || null,     // DoLogin loginAccountPassword

    // ---- required message identifiers (provided by CoreLogic / the vendor) ----
    subdomain:       process.env.AMC_SUBDOMAIN || null,        // ServiceProviderSubDomain (e.g. integrations.uat)
    lenderIdentifier: process.env.AMC_LENDER_IDENTIFIER || null, // DigitalGatewayLenderIdentifier (CoreLogic reporting id)
    sourceClientId:  process.env.AMC_SOURCE_CLIENT_ID || null, // clientSystem.sourceInformation.sourceClientIdentifier

    // Lower-env fallback API key when OAuth creds have not been issued yet (UAT only,
    // never available in production). Sent as an `apikey` HTTP header. Optional.
    fallbackApiKey:  process.env.AMC_FALLBACK_APIKEY || null,

    pollSec:   Math.max(60, parseInt(process.env.AMC_POLL_SEC || '600', 10) || 600),  // status/comment poll cadence
    lookupRefreshHours: Math.max(1, parseInt(process.env.AMC_LOOKUP_REFRESH_HOURS || '24', 10) || 24),
  },

  // ---------------------------------------------------------------------------
  // Class Valuation — the SECOND appraisal vendor (owner-directed 2026-08-07).
  //
  // It is NOT a variant of the AMC/CoreLogic integration and must not be folded
  // into it. Three differences decide the whole shape:
  //   • AUTH is ONE call, not two. OAuth2 PASSWORD grant — client id + secret +
  //     username + password, all four issued by Class (their guide, p.9, marks
  //     every one [Required] and "supplied by Class Valuation"). There is no
  //     second login and no per-message api key.
  //   • It is REST, not one action-typed endpoint. POST /orders, GET /orders/{id},
  //     GET /orders/{id}/attachments — each its own path.
  //   • It PUSHES. Class calls a webhook of ours on every change; CoreLogic is
  //     poll-only. So there is no poll cadence here — there is a callback URL and
  //     the Basic-auth credentials WE issue to them.
  //
  // Switches mirror the AMC ones exactly, and for the same reason:
  //   CLASS_ENABLED          master — token + reads (products, orders, attachments)
  //   CLASS_OUTBOUND_ENABLED separate gate — actually PLACE an order / write
  //   CLASS_DRYRUN           build + log the exact body, send nothing
  //
  // Credentials come from Render env ONLY (never source, never chat). Nothing
  // reaches Class until CLASS_ENABLED=1 and the four values are set.
  //
  // WE ARE ON THE **V1** ORDERS API — the guide YS Capital was given ("Class Orders
  // API Guide", rev 0.17, 08-03-2026). Its order hosts are
  // `api{,.uat,.test}.classvaluation.com` (p.3, with a verbatim call at p.13), which
  // is ALSO what their onboarding email gave — the two agree, so the order hosts are
  // confirmed. A separate V2 document uses `orders-external.*` and different field
  // spellings; do not mix them. Both guides only ever show the TEST identity host, so
  // the UAT/production identity hosts are still INFERRED — confirm before switching
  // on. Everything stays overridable by env.
  class: {
    enabled:         process.env.CLASS_ENABLED === '1',           // master (default OFF)
    outboundEnabled: process.env.CLASS_OUTBOUND_ENABLED === '1',  // write gate (default OFF)
    dryrun:          process.env.CLASS_DRYRUN === '1',            // build + log, send nothing

    // ---- credentials (Render env ONLY) — all four required by the password grant ----
    clientId:     process.env.CLASS_CLIENT_ID || null,
    clientSecret: process.env.CLASS_CLIENT_SECRET || null,
    username:     process.env.CLASS_USERNAME || null,   // the API user, NOT necessarily the portal login
    password:     process.env.CLASS_PASSWORD || null,

    // ---- which UAD version we order on (owner-directed 2026-08-07) ----
    // 'v1' = UAD 2.6 (POST /orders) — the DEFAULT, and what the industry is on today.
    // 'v2' = UAD 3.6 (POST /v2/orders) — built and ready for the shift.
    // Both live on the SAME hosts and the SAME credentials; only the path and the
    // body shape differ. Staff can also pick the version for ONE order on the screen,
    // so 3.6 can be tried on a single file before this default is moved.
    apiVersion: (process.env.CLASS_API_VERSION || 'v1').trim().toLowerCase(),

    // ---- hosts (all overridable; see the note above) ----
    // environment: 'uat' (default) | 'test' | 'production'
    environment: (process.env.CLASS_ENVIRONMENT || 'uat').trim().toLowerCase(),
    tokenUrl:  (process.env.CLASS_TOKEN_URL || '').trim().replace(/\/+$/, '') || null,
    ordersUrl: (process.env.CLASS_ORDERS_URL || '').trim().replace(/\/+$/, '') || null,

    // ---- the org scoping Class puts in the POST /orders query string ----
    orgId:       process.env.CLASS_ORG_ID || null,
    lenderOrgId: process.env.CLASS_LENDER_ORG_ID || null,

    // ---- the callback (webhook) half: credentials WE issue to Class ----
    // Class POSTs to us with HTTP Basic auth using exactly these. Registered via
    // POST /callbacks; the URL defaults to APP_URL + the mounted route.
    callbackUrl:      (process.env.CLASS_CALLBACK_URL || '').trim() || null,
    callbackUser:     process.env.CLASS_CALLBACK_USER || null,
    callbackPassword: process.env.CLASS_CALLBACK_PASSWORD || null,
    // Their registration also allows an ApiToken mode (a token in a header we name)
    // instead of Basic. We register Basic; these exist so the mode can be switched at
    // Class's end without a deploy. Unset = that mode is simply off.
    callbackToken:       process.env.CLASS_CALLBACK_TOKEN || null,
    callbackTokenHeader: (process.env.CLASS_CALLBACK_TOKEN_HEADER || 'x-api-key').trim(),

    timeoutMs: Math.max(1000, parseInt(process.env.CLASS_TIMEOUT_MS || '60000', 10) || 60000),
  },
};
