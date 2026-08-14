'use strict';
/**
 * LONG-TERM (LT) — the Encompass API SURFACE, as this tenant actually answers it.
 *
 * "Knows which requests work, and which requests error." Every entry below is a
 * real read-only GET made against the live tenant on 2026-08-14 with our own
 * credentials — not a reading of the documentation. 111 paths were probed;
 * 36 answered.
 *
 * WHY THIS MATTERS. Three different failure shapes look alike from the outside and
 * mean completely different things:
 *   • 403 — the call is right, our ACCESS is not (see ACCESS_NOTES).
 *   • 404 — the path does not exist in this API generation. Usually the wrong
 *           version: conditions are v3-only, loan associates are v1-only.
 *   • 200 with an empty array — the call worked and this tenant simply does not use
 *           that module. The legacy condition endpoints do this on every loan, which
 *           is the single most dangerous result in the whole surface: it reads as
 *           "no conditions" when 348 conditions exist one endpoint away.
 */

const SURFACE = require('./dictionary/api-surface.json');

// What we learned about why the blocked calls are blocked.
const ACCESS_NOTES = {
  summary:
    'The 403s are NOT a persona misconfiguration on the user. They are a SCOPE limit on the API '
    + 'CLIENT. Our token is issued with scope "lp". Requesting "encompass_admin" — the scope ICE '
    + 'documents for administrative and settings endpoints — is refused at the token endpoint '
    + 'itself, before any resource is touched: '
    + '"The requested scope is invalid, unknown, malformed, or exceeds that which the client is '
    + 'permitted". A persona problem cannot produce that error; only the client registration can.',
  tokenGrant: 'resource-owner password grant, username <user>@encompass:<instanceId>, scope lp',
  whatWeVerified: [
    'scope "lp"                → token issued, 403 on every /settings/* admin path tried',
    'scope "lp encompass_admin" → token REFUSED (400 invalid_scope)',
    'scope "encompass_admin"    → token REFUSED (400 invalid_scope)',
  ],
  toUnlock: [
    'The API client (Client ID) must be entitled to the encompass_admin scope. That entitlement '
      + 'lives with the client registration in ICE Developer Connect, not in the Encompass UI — it '
      + 'is requested from ICE for the app/integration.',
    'Separately, the API user\'s persona must allow the underlying feature. ICE\'s rule is that '
      + '"the features and data users can access with the APIs is determined by their assigned '
      + 'Encompass persona" — the API key grants nothing beyond it. At least one persona on the '
      + 'user must have LO Connect access enabled (Settings → Company/User Setup → Personas → '
      + 'Access tab → tick both "Microsoft Windows Encompass Client" and "Encompass Mobile").',
    'Re-run scripts/lt-encompass-probe (or the probe in this module\'s notes) afterwards to '
      + 'confirm which of the 65 blocked paths opened up.',
  ],
  worthUnlocking: [
    '/encompass/v3/settings/loan/programs — the program definitions behind field 1401',
    '/encompass/v3/settings/businessRules/milestoneCompletion — the 91 completion rules we '
      + 'currently only know from screen recordings (69 of them are still uncaptured)',
    '/encompass/v1|v3/loans/{id}/milestoneLogs — who moved a file and when',
    '/encompass/v3/settings/loan/conditions/categories and .../priorTo — the condition vocabulary',
    '/encompass/v3/settings/efolder/documentTemplates — document templates '
      + '(the v1 form of this one already answers, so this is a nice-to-have)',
    '/encompass/v3/settings/users and /settings/loanTeamTemplates — team assignment',
  ],
};

// The traps: calls that succeed but do not mean what they look like.
const FALSE_NEGATIVES = [
  { path: 'GET /encompass/v1/loans/{loanId}/conditions/underwriting',
    answers: '200 []', truth: 'This tenant uses Enhanced Conditions. Use GET /encompass/v3/loans/{loanId}/conditions.' },
  { path: 'POST /encompass/v3/loanPipeline (field Loan.CurrentMilestone)',
    answers: 'blank for every loan', truth: 'Read loan.milestoneCurrentName or field MS.STATUS instead.' },
  { path: 'GET /encompass/v3/schemas/loan/standardFields',
    answers: 'paginates past any limit you set', truth: '23,704 standard fields exist; a loop bounded at 20,000 silently truncates.' },
];

function working() { return SURFACE.working; }
function blocked() { return SURFACE.blocked; }
function byStatus(status) { return SURFACE.blocked.filter((e) => String(e.status) === String(status)); }
function summary() {
  return {
    ...SURFACE.meta,
    probed: SURFACE.working.length + SURFACE.blocked.length,
    working: SURFACE.working.length,
    forbidden403: byStatus('403').length,
    notFound404: byStatus('404').length,
    falseNegatives: FALSE_NEGATIVES.length,
  };
}

module.exports = { SURFACE, ACCESS_NOTES, FALSE_NEGATIVES, working, blocked, byStatus, summary };
