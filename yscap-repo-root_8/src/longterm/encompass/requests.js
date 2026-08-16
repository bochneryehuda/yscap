'use strict';
/**
 * LONG-TERM (LT) — Encompass request & authorization catalog (reference).
 *
 * The complete map of how Long-Term authenticates to Encompass and every request
 * it can make. All READ-ONLY (return data, mutate nothing). This is documentation
 * data — the live client is src/longterm/encompass/client.js. Verified against the
 * live tenant in the 2026-08-14 audit; the two paths RTL had wrong are CORRECTED
 * here (marked ✅ corrected).
 */

// ── Authorization (OAuth 2.0, Developer Connect) ──────────────────────────────
const AUTH = {
  endpoint: 'POST /oauth2/v1/token',
  host: 'https://api.elliemae.com',
  // Most Encompass tenants (including this one) use the resource-owner PASSWORD
  // grant. Client-credentials is the fallback when no user login is provided.
  passwordGrant: {
    grant_type: 'password',
    username: '<username>@encompass:<instance-id>',   // the instance rides in the username
    password: '<password>',
    client_id: '<client id>',
    client_secret: '<client secret>',
    scope: 'lp',
  },
  clientCredentialsGrant: {
    grant_type: 'client_credentials',
    client_id: '<client id>',
    client_secret: '<client secret>',
    scope: 'lp instance:<instance-id>',
  },
  contentType: 'application/x-www-form-urlencoded',
  returns: 'access_token (Bearer) + expires_in; the client caches it until ~60s before expiry',
  credentialsEnv: [
    'LT_ENCOMPASS_CLIENT_ID     (fallback ENCOMPASS_CLIENT_ID)',
    'LT_ENCOMPASS_CLIENT_SECRET (fallback ENCOMPASS_CLIENT_SECRET)',
    'LT_ENCOMPASS_INSTANCE_ID   (fallback ENCOMPASS_INSTANCE_ID)',
    'LT_ENCOMPASS_USERNAME      (fallback ENCOMPASS_USERNAME)',
    'LT_ENCOMPASS_PASSWORD      (fallback ENCOMPASS_PASSWORD)',
    'LT_ENCOMPASS_API_BASE      (fallback ENCOMPASS_API_BASE, default https://api.elliemae.com)',
  ],
  note: 'No secret VALUES live in code — only env-var names. Credentials sit in Render env, same as RTL.',
};

// ── Requests (all READ-ONLY; all Bearer-authenticated except the token call) ──
const REQUESTS = [
  // Loan-level reads
  { method: 'GET',  path: '/encompass/v3/loans/{loanId}', purpose: 'Retrieve a full loan JSON.', shape: null, client: 'getLoan' },
  { method: 'POST', path: '/encompass/v3/loanPipeline', purpose: 'Pipeline SEARCH — find loans by field (e.g. Loan.LoanNumber) without the GUID. READ-SHAPED.',
    shape: { loanFolders: ['<folder>'], filter: { canonicalName: 'Loan.LoanNumber', value: '<n>', matchType: 'Exact' }, sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }], fields: ['Loan.LoanNumber'] },
    client: 'pipelineSearch',
    notes: 'One of loanIds / loanFolders / filter is required. sortOrder is TOP-LEVEL; order is PascalCase. A single-term filter list must NOT carry an operator.' },
  { method: 'POST', path: '/encompass/v3/loans/{loanId}/fieldReader', purpose: 'Read selected loan FIELDS BY FIELD NUMBER. READ-SHAPED — the id list travels in the body.',
    shape: ['1859', '388', 'CX.CAPITALPROVIDER'], client: 'fieldReader',
    notes: 'Response is an object map {"388":"1.000"} (v3) OR an array of {fieldId,value} (v1). The authoritative way to read a value — the same field number lives at different JSON paths on different loans.' },
  { method: 'GET',  path: '/encompass/v3/loans/{loanId}/milestones', purpose: "Retrieve a loan's live milestone state.", client: 'getLoanMilestones' },
  { method: 'GET',  path: '/encompass/v3/loans/{loanId}/milestoneLogs', purpose: 'Retrieve a loan\'s milestone log history.', client: 'getLoanMilestoneLogs' },
  // Settings / catalog reads
  { method: 'GET',  path: '/encompass/v3/settings/milestones', purpose: 'Milestone SETTINGS (the 19-row catalog — identity, status, role, duration).',
    corrected: 'RTL used /encompass/v3/settings/loan/milestones (403). This is the current path (200).', client: 'getMilestoneSettings' },
  { method: 'GET',  path: '/encompass/v3/schemas/loan/standardFields?ids=<csv>', purpose: 'Resolve standard field ids → description, format, data type, contract path.',
    corrected: 'RTL used /encompass/v3/settings/loan/standardFields (403). This is the current path (200).', client: 'getStandardFieldSchema' },
  { method: 'GET',  path: '/encompass/v3/settings/loan/customFields', purpose: 'The tenant\'s custom (CX.*) field definitions.', client: 'getCustomFieldSettings' },
  // Other catalogs RTL reads (paths need a version review before LT relies on them)
  { method: 'GET',  path: '/encompass/v3/settings/loan/<enums|folders|templates>', purpose: 'Enumerations / loan folders / loan templates.',
    notes: 'RTL reads these; the audit did not re-verify their current paths. Confirm against Developer Connect before use.', client: null },
];

// ── What the Encompass API does NOT expose ────────────────────────────────────
const NOT_AVAILABLE_VIA_API = [
  'Milestone Completion business-RULE definitions (required fields/tasks per milestone, activation conditions).',
  'These live in Encompass Desktop → Settings → Business Rules → Milestone Completion, and must be exported from there or via an ICE-supported SDK/system-settings export.',
];

module.exports = { AUTH, REQUESTS, NOT_AVAILABLE_VIA_API };
