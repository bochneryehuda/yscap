'use strict';
/**
 * Integration HEALTH registry — the single source of truth for the admin "API Health" page.
 *
 * Every external API / third-party service the platform talks to has ONE descriptor here: what it
 * is (plain English), the env vars it needs (names only — a value is NEVER read or returned), its
 * on/off switches, and a `probe()` that reports whether it is configured and (where a cheap, safe
 * check exists) reachable RIGHT NOW. Adding a new API = one entry in INTEGRATIONS; it then appears
 * on the page automatically with its status and fix guidance.
 *
 * SECURITY: this module reads config PRESENCE only (is a key set? is a switch on?) and performs
 * read-only reachability checks. It never returns, logs, or accepts a secret value. Keys are set
 * and rotated in the hosting dashboard (Render env), never in the app — so a compromise of the app
 * can never leak a key. Every probe is time-boxed and NEVER throws.
 */
const cfg = require('../../config');

const PROBE_TIMEOUT_MS = 8000;

// Race any promise against a timeout so the page can never hang on a slow/unreachable service.
function timebox(promise, ms = PROBE_TIMEOUT_MS) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}
// Is an env var present (non-empty)? Presence only — the value is never read out.
function envSet(name) { const v = process.env[name]; return !!(v && String(v).trim()); }

// A tiny direct client-credentials token check for Microsoft Graph (SharePoint / Outlook email).
// Proves the tenant + client id + secret authenticate. Only attempted when a client SECRET is set
// (the certificate path is proven by the sync's own last pass, so we don't re-implement it here).
async function graphTokenReachable() {
  if (!(cfg.msTenantId && cfg.msClientId && cfg.msClientSecret)) return null; // can't cheaply probe (e.g. cert-only)
  const body = new URLSearchParams({
    client_id: cfg.msClientId, client_secret: cfg.msClientSecret,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  });
  const r = await timebox(fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.msTenantId)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }));
  if (r.ok) return true;
  return false;
}

// ---- the integrations, in display order, grouped ----
// group: 'core' (the AI/document brain), 'workflow' (pipeline/docs/draws/esign), 'comms' (email),
//        'data' (address/flood/ocr lookups), 'framework' (coded, awaiting keys), 'planned' (not built yet).
const INTEGRATIONS = [
  {
    key: 'azure_openai', name: 'Azure OpenAI (ChatGPT / GPT-5)', group: 'core',
    purpose: 'The document-analysis brain — reads a document’s text and pulls out the underwriting facts.',
    direction: 'Outbound', auth: 'Azure resource key',
    env: [{ name: 'AZURE_OPENAI_ENDPOINT', required: true }, { name: 'AZURE_OPENAI_KEY', required: true },
      { name: 'AZURE_OPENAI_DEPLOYMENT', required: true }, { name: 'AZURE_OPENAI_API_VERSION', required: false },
      { name: 'AZURE_OPENAI_REASONING_EFFORT', required: false }],
    switches: [], liveProbe: true,
    async probe() {
      const m = require('../ai/azure-openai');
      if (!m.available()) return { configured: false, live: null, detail: 'Endpoint, key, or deployment not set.' };
      try { const p = await timebox(m.ping()); return { configured: true, live: !!p.ok, detail: p.ok ? 'Reached Azure OpenAI and it replied.' : (p.reason || 'Not reachable.') }; }
      catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching Azure OpenAI.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'azure_docint', name: 'Azure Document Intelligence (OCR)', group: 'core',
    purpose: 'Turns scanned or blurry document pages into clean text for the analyzer to read.',
    direction: 'Outbound', auth: 'Azure resource key',
    env: [{ name: 'AZURE_DOCINT_ENDPOINT', required: true }, { name: 'AZURE_DOCINT_KEY', required: true },
      { name: 'AZURE_DOCINT_MODEL', required: false }, { name: 'AZURE_DOCINT_API_VERSION', required: false }],
    switches: [], liveProbe: true,
    async probe() {
      const m = require('../ai/docint');
      if (!m.configured()) return { configured: false, live: null, detail: 'Endpoint or key not set.' };
      try { const p = await timebox(m.ping()); return { configured: true, live: !!p.ok, detail: p.ok ? 'Reached the OCR reader.' : (p.reason || 'Not reachable.') }; }
      catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching the OCR reader.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'docusign', name: 'DocuSign (e-signatures)', group: 'workflow',
    purpose: 'Sends term sheets and disclosures for e-signature and receives the signed documents back.',
    direction: 'Two-way', auth: 'OAuth JWT (RSA key)',
    env: [{ name: 'DOCUSIGN_INTEGRATION_KEY', required: true }, { name: 'DOCUSIGN_USER_ID', required: true },
      { name: 'DOCUSIGN_ACCOUNT_ID', required: true }, { name: 'DOCUSIGN_PRIVATE_KEY', required: true },
      { name: 'DOCUSIGN_CONNECT_HMAC_SECRET', required: false }],
    switches: [{ name: 'DOCUSIGN_SEND_ENABLED', label: 'Sending' }, { name: 'DOCUSIGN_TEST_MODE', label: 'Test mode', invert: true }],
    liveProbe: true,
    async probe() {
      const ds = require('./docusign');
      if (!ds.configured()) return { configured: false, live: null, detail: 'DocuSign keys not set.' };
      try {
        const p = await timebox(ds.ping());
        return { configured: true, live: true, detail: `Connected to ${p.accountName || 'DocuSign'}${p.demo ? ' — practice/sandbox account' : ' — live account'}.` };
      } catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching DocuSign.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'sitewire', name: 'Sitewire (construction draws)', group: 'workflow',
    purpose: 'Runs the post-funding draw process — inspections, photos, and releases for renovation loans.',
    direction: 'Two-way', auth: '3-part access token',
    env: [{ name: 'SITEWIRE_ACCESS_TOKEN', required: true }, { name: 'SITEWIRE_CLIENT', required: true },
      { name: 'SITEWIRE_UID', required: true }, { name: 'SITEWIRE_LENDER_ID', required: false }],
    switches: [{ name: 'SITEWIRE_ENABLED', label: 'Reading' }, { name: 'SITEWIRE_OUTBOUND_ENABLED', label: 'Writing' }],
    liveProbe: true,
    async probe() {
      const configured = !!(cfg.sitewireAccessToken && cfg.sitewireClient && cfg.sitewireUid);
      if (!configured) return { configured: false, live: null, detail: 'The Sitewire 3-part token is not set.' };
      if (!cfg.sitewireEnabled) return { configured: true, enabled: false, live: null, detail: 'Keys are set, but the master switch (SITEWIRE_ENABLED) is off, so nothing syncs yet.' };
      try { const c = require('../../sitewire/client'); await timebox(c.getLender(cfg.sitewireLenderId)); return { configured: true, enabled: true, live: true, detail: 'Reached Sitewire.' }; }
      catch (e) { return { configured: true, enabled: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching Sitewire.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'clickup', name: 'ClickUp (pipeline / CRM)', group: 'workflow',
    purpose: 'Keeps loan-file data (status, borrower details, dates) in sync with the team’s ClickUp pipeline.',
    direction: 'Two-way', auth: 'API token',
    env: [{ name: 'CLICKUP_API_TOKEN', required: true }, { name: 'CLICKUP_WEBHOOK_SECRET', required: false }],
    switches: [{ name: 'CLICKUP_SYNC_ENABLED', label: 'Sync' }, { name: 'CLICKUP_OUTBOUND_ENABLED', label: 'Writing' }],
    liveProbe: true,
    async probe() {
      if (!cfg.clickupToken) return { configured: false, live: null, detail: 'The ClickUp API token is not set.' };
      try { const c = require('../../clickup/client'); await timebox(c.getTeams()); return { configured: true, live: true, detail: 'Reached ClickUp with the token.' }; }
      catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching ClickUp.' : (e.message || 'Not reachable — the token may be wrong.') }; }
    },
  },
  {
    key: 'sharepoint', name: 'SharePoint (document mirror)', group: 'workflow',
    purpose: 'Copies every saved document into the team SharePoint site (one-way; it never deletes anything).',
    direction: 'One-way (write)', auth: 'Microsoft Graph app (certificate or secret)',
    env: [{ name: 'MS_TENANT_ID', required: true }, { name: 'MS_CLIENT_ID', required: true },
      { name: 'MS_CLIENT_SECRET', required: false }, { name: 'MS_CLIENT_CERT_PEM', required: false },
      { name: 'SHAREPOINT_SITE_HOST', required: false }],
    switches: [{ name: 'SHAREPOINT_BACKUP_ENABLED', label: 'Mirroring' }],
    liveProbe: true,
    async probe() {
      const sp = require('../sharepoint');
      if (!sp.configured()) return { configured: false, live: null, detail: 'Microsoft Graph credentials (tenant + client id + secret or certificate) are not set.' };
      if (!cfg.sharepointBackupEnabled) return { configured: true, enabled: false, live: null, detail: 'Credentials are set, but mirroring (SHAREPOINT_BACKUP_ENABLED) is off.' };
      try {
        const reach = await graphTokenReachable();
        if (reach === true) return { configured: true, enabled: true, live: true, detail: 'Microsoft Graph credentials authenticate.' };
        if (reach === false) return { configured: true, enabled: true, live: false, detail: 'Microsoft Graph rejected the credentials (check the client secret / permissions).' };
        // cert-only: fall back to the sync’s own last-pass signal rather than re-implementing cert auth.
        const h = require('../sharepoint-backup').health ? require('../sharepoint-backup').health() : null;
        if (h && h.lastPass) return { configured: true, enabled: true, live: true, detail: `Using a certificate; last mirror pass ${h.stalled ? 'looks stalled' : 'succeeded'}.` };
        return { configured: true, enabled: true, live: null, detail: 'Using a certificate — no cheap live check; watch the mirror’s last pass.' };
      } catch (e) { return { configured: true, enabled: true, live: false, detail: e.message || 'Not reachable.' }; }
    },
  },
  {
    key: 'graph_email', name: 'Microsoft Outlook email (Graph)', group: 'comms',
    purpose: 'An alternative way to send notification emails, through a Microsoft 365 mailbox.',
    direction: 'Outbound', auth: 'Microsoft Graph app (secret)',
    env: [{ name: 'MS_TENANT_ID', required: true }, { name: 'MS_CLIENT_ID', required: true },
      { name: 'MS_CLIENT_SECRET', required: true }, { name: 'NOTIFY_FROM', required: false }],
    switches: [], liveProbe: true,
    async probe() {
      if (cfg.emailProvider !== 'graph') return { configured: false, live: null, detail: `Not the active email provider (currently "${cfg.emailProvider}"). Set EMAIL_PROVIDER=graph to use Outlook.` };
      if (!(cfg.msTenantId && cfg.msClientId && cfg.msClientSecret)) return { configured: false, live: null, detail: 'Microsoft Graph credentials not set.' };
      try { const reach = await graphTokenReachable(); return { configured: true, live: reach === true, detail: reach ? 'Microsoft Graph credentials authenticate.' : 'Microsoft Graph rejected the credentials.' }; }
      catch (e) { return { configured: true, live: false, detail: e.message || 'Not reachable.' }; }
    },
  },
  {
    key: 'resend', name: 'Resend (email)', group: 'comms',
    purpose: 'The main service that sends the platform’s emails and receives replies to file emails.',
    direction: 'Two-way', auth: 'API key',
    env: [{ name: 'RESEND_API_KEY', required: true }, { name: 'RESEND_WEBHOOK_SECRET', required: false }, { name: 'REPLY_TO', required: false }],
    switches: [], liveProbe: true,
    async probe() {
      if (cfg.emailProvider !== 'resend') return { configured: false, live: null, detail: `Not the active email provider (currently "${cfg.emailProvider}"). Set EMAIL_PROVIDER=resend to use Resend.` };
      if (!cfg.resendApiKey) return { configured: false, live: null, detail: 'The Resend API key is not set.' };
      try {
        const r = await timebox(fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${cfg.resendApiKey}` } }));
        if (r.ok) return { configured: true, live: true, detail: 'Reached Resend with the key.' };
        if (r.status === 401 || r.status === 403) return { configured: true, live: false, detail: `Resend rejected the key (HTTP ${r.status}).` };
        return { configured: true, live: false, detail: `Resend returned HTTP ${r.status}.` };
      } catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching Resend.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'google_maps', name: 'Google Maps (address + property photos)', group: 'data',
    purpose: 'Address autocomplete / verification and Street View property photos.',
    direction: 'Outbound', auth: 'API key',
    env: [{ name: 'GOOGLE_PLACES_API_KEY', required: false }, { name: 'GOOGLE_MAPS_API_KEY', required: false }],
    switches: [], liveProbe: true,
    async probe() {
      if (!cfg.googlePlacesKey) return { configured: false, live: null, detail: 'No Google key set — address lookup falls back to the free OpenStreetMap service.' };
      try {
        const u = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=1600+Amphitheatre&types=address&key=${encodeURIComponent(cfg.googlePlacesKey)}`;
        const r = await timebox(fetch(u));
        const j = await r.json().catch(() => ({}));
        if (j.status === 'OK' || j.status === 'ZERO_RESULTS') return { configured: true, live: true, detail: 'Reached Google Places with the key.' };
        return { configured: true, live: false, detail: `Google returned "${j.status || 'an error'}"${j.error_message ? ` — ${j.error_message}` : ''}.` };
      } catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching Google.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'smarty', name: 'Smarty (address autocomplete)', group: 'data',
    purpose: 'An alternative US address autocomplete service (used only if configured instead of Google).',
    direction: 'Outbound', auth: 'Auth id + token',
    env: [{ name: 'SMARTY_AUTH_ID', required: false }, { name: 'SMARTY_AUTH_TOKEN', required: false }],
    switches: [], liveProbe: false,
    async probe() {
      const configured = !!(cfg.smartyAuthId && cfg.smartyAuthToken);
      return configured
        ? { configured: true, live: null, detail: `Configured${cfg.addressProvider === 'smarty' ? ' and active' : ' (Google/OSM is currently the active address provider)'}.` }
        : { configured: false, live: null, detail: 'Not configured (optional — address lookup works via Google or OpenStreetMap).' };
    },
  },
  {
    key: 'fema_flood', name: 'FEMA flood + Census geocoder', group: 'data',
    purpose: 'Checks the appraisal’s flood zone against the official FEMA flood map (free government service).',
    direction: 'Outbound (read-only)', auth: 'None (public)',
    env: [], switches: [{ name: 'APPRAISAL_FLOOD_CHECK_ENABLED', label: 'Flood check' }],
    liveProbe: true,
    async probe() {
      if (!cfg.appraisalFloodCheckEnabled) return { configured: true, enabled: false, live: null, detail: 'Free service (no key needed), but the flood check (APPRAISAL_FLOOD_CHECK_ENABLED) is off.' };
      try {
        const r = await timebox(fetch('https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28?f=json'));
        return { configured: true, enabled: true, live: r.ok, detail: r.ok ? 'Reached the FEMA flood map service.' : `FEMA returned HTTP ${r.status}.` };
      } catch (e) { return { configured: true, enabled: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching FEMA.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'ocr_space', name: 'OCR.space (general OCR)', group: 'data',
    purpose: 'A lightweight OCR used for the credit-card scan and an advisory read of appraisal PDFs.',
    direction: 'Outbound', auth: 'API key (free demo key as fallback)',
    env: [{ name: 'OCR_SPACE_API_KEY', required: false }], switches: [], liveProbe: false,
    async probe() {
      return cfg.ocrSpaceApiKey
        ? { configured: true, live: null, detail: 'Your own OCR.space key is set.' }
        : { configured: true, live: null, detail: 'No key set — using OCR.space’s free shared demo key (rate-limited). Add OCR_SPACE_API_KEY for reliable use.' };
    },
  },
  {
    key: 'plaid', name: 'Plaid (bank / asset verification)', group: 'framework',
    purpose: 'Bank-account and asset verification. Fully coded, waiting for credentials to switch on.',
    direction: 'Outbound', auth: 'Client id + secret',
    env: [{ name: 'PLAID_CLIENT_ID', required: true }, { name: 'PLAID_SECRET', required: true }, { name: 'PLAID_ENV', required: false }],
    switches: [], liveProbe: false,
    async probe() { const m = require('./plaid'); return m.configured() ? { configured: true, live: null, detail: `Configured (${cfg.plaid && cfg.plaid.env ? cfg.plaid.env : 'sandbox'}).` } : { configured: false, live: null, detail: 'Coded and ready — add the Plaid credentials to activate.' }; },
  },
  {
    key: 'xactus', name: 'Xactus (credit reports)', group: 'framework',
    purpose: 'Credit-report pulls. Framework in place, awaiting the vendor onboarding packet + credentials.',
    direction: 'Outbound', auth: 'Username + password',
    env: [{ name: 'XACTUS_USERNAME', required: true }, { name: 'XACTUS_PASSWORD', required: true }, { name: 'XACTUS_ENDPOINT', required: true }],
    switches: [], liveProbe: false,
    async probe() { const m = require('./xactus'); return m.configured() ? { configured: true, live: null, detail: 'Credentials set — the request/response mapping is still a placeholder pending the vendor packet.' } : { configured: false, live: null, detail: 'Not connected — awaiting the Xactus onboarding packet + credentials.' }; },
  },
  {
    key: 'usps', name: 'USPS (address validation)', group: 'data',
    purpose: 'Official USPS address standardization + ZIP+4 (free with a USPS developer account).',
    direction: 'Outbound', auth: 'OAuth2 client credentials',
    env: [{ name: 'USPS_CLIENT_ID', required: true }, { name: 'USPS_CLIENT_SECRET', required: true }],
    switches: [], liveProbe: true,
    async probe() {
      const m = require('./usps');
      if (!m.configured()) return { configured: false, live: null, detail: 'Not connected. The connector is built — add a free USPS developer key (USPS_CLIENT_ID / USPS_CLIENT_SECRET from developer.usps.com) to turn on official USPS address checking. Until then, address lookup runs through Google / OpenStreetMap.' };
      try { const p = await timebox(m.ping()); return { configured: true, live: !!p.ok, detail: p.ok ? 'USPS credentials authenticate.' : (p.reason || 'Not reachable.') }; }
      catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching USPS.' : (e.message || 'Not reachable.') }; }
    },
  },
  {
    key: 'encompass', name: 'Encompass (loan origination system)', group: 'framework',
    purpose: 'The loan-origination system (ICE / Ellie Mae). The connector is built; it needs your instance credentials, then the loan field-mapping is finalized against your instance.',
    direction: 'Two-way (planned)', auth: 'OAuth2 (Developer Connect)',
    env: [{ name: 'ENCOMPASS_CLIENT_ID', required: true }, { name: 'ENCOMPASS_CLIENT_SECRET', required: true },
      { name: 'ENCOMPASS_INSTANCE_ID', required: true }, { name: 'ENCOMPASS_USERNAME', required: false }, { name: 'ENCOMPASS_PASSWORD', required: false }],
    switches: [], liveProbe: true,
    async probe() {
      const m = require('./encompass');
      if (!m.configured()) return { configured: false, live: null, detail: 'Not connected. The connector is built — add your Encompass Developer Connect credentials (client id + secret + instance id) to authenticate. The loan field-mapping is the next step, finalized against your instance. (Today an Encompass status field only rides in read-only via ClickUp.)' };
      try { const p = await timebox(m.ping()); return { configured: true, live: !!p.ok, detail: p.ok ? 'Encompass credentials authenticate — loan field-mapping is the next step.' : (p.reason || 'Not reachable.') }; }
      catch (e) { return { configured: true, live: false, detail: e.message === 'timed out' ? 'Timed out reaching Encompass.' : (e.message || 'Not reachable.') }; }
    },
  },
];

// Turn a probe result + descriptor into the resolved shape the page renders. `state` is the single
// status word the light is keyed on. Never throws.
function computeState(entry, r) {
  if (entry.notBuilt) return 'planned';
  if (entry.group === 'framework') return r.configured ? 'configured' : 'framework';
  if (!r.configured) return 'not_configured';
  if (r.enabled === false) return 'disabled';
  if (r.live === true) return 'live';
  if (r.live === false) return 'unreachable';
  return 'configured'; // configured but no live confirmation available
}

async function resolveOne(entry) {
  let r;
  try { r = await entry.probe(); } catch (e) { r = { configured: false, live: false, detail: e && e.message ? e.message : 'probe failed' }; }
  r = r || {};
  return {
    key: entry.key, name: entry.name, group: entry.group, purpose: entry.purpose,
    direction: entry.direction, auth: entry.auth, liveProbe: !!entry.liveProbe, notBuilt: !!entry.notBuilt,
    env: (entry.env || []).map((e) => ({ name: e.name, required: !!e.required, set: envSet(e.name) })),
    // A switch reports only its on/off state (an env flag). `invert` marks a switch whose ON state is
    // the CAUTIOUS one (e.g. DOCUSIGN_TEST_MODE on = sends are held to an allow-list).
    switches: (entry.switches || []).map((s) => ({ name: s.name, label: s.label, on: envSet(s.name), invert: !!s.invert })),
    configured: !!r.configured, enabled: r.enabled === undefined ? null : r.enabled,
    live: r.live === undefined ? null : r.live, detail: r.detail || '',
    state: computeState(entry, r),
  };
}

// Run every probe in parallel (each already time-boxed + non-throwing) and return the resolved list.
async function probeAll() {
  return Promise.all(INTEGRATIONS.map((e) => resolveOne(e)));
}
// Run a single integration by key (the "Test now" button). Returns null for an unknown key.
async function probeOne(key) {
  const entry = INTEGRATIONS.find((e) => e.key === key);
  if (!entry) return null;
  return resolveOne(entry);
}

module.exports = { INTEGRATIONS, probeAll, probeOne, _internals: { computeState, envSet } };
