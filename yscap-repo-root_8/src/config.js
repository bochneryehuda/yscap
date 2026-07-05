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

module.exports = {
  port:          process.env.PORT || 3000,
  env:           process.env.NODE_ENV || 'development',
  databaseUrl:   process.env.DATABASE_URL,

  // --- auth / crypto ---
  jwtSecret:     process.env.JWT_SECRET || 'dev-only-change-me',
  ssnKey:        process.env.SSN_ENCRYPTION_KEY || 'dev-only-change-me',
  accessTtlSec:  parseInt(process.env.ACCESS_TTL_SEC || '3600', 10),      // 1h access token
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
  appUrl:        (process.env.APP_URL || 'https://portal.yscapgroup.com').replace(/\/+$/,''),  // base for links in emails
  // Public URL of the branded logo shown in email headers. Defaults to the
  // app's own statically-served asset (web/assets/brand/lockup-dark.png) so it
  // renders on the dark email canvas. Override with EMAIL_LOGO_URL if you host
  // it elsewhere (e.g. the marketing site).
  emailLogoUrl:  process.env.EMAIL_LOGO_URL ||
                 ((process.env.APP_URL || 'https://portal.yscapgroup.com').replace(/\/+$/,'') + '/assets/brand/lockup-dark.png'),
  notifyAdmins:  (process.env.NOTIFY_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Microsoft Graph (Outlook) provider:
  msTenantId:    process.env.MS_TENANT_ID,
  msClientId:    process.env.MS_CLIENT_ID,
  msClientSecret:process.env.MS_CLIENT_SECRET,
  // Resend provider:
  resendApiKey:  process.env.RESEND_API_KEY,

  // --- document storage ---
  storageProvider: process.env.STORAGE_PROVIDER || 'local', // 'local' | 's3' | 'sharepoint'
  storageDir:      process.env.STORAGE_DIR || 'uploads',

  // --- ClickUp (deferred; server-side token only) ---
  clickupToken:  process.env.CLICKUP_API_TOKEN,
};
