'use strict';
/**
 * LONG-TERM (LT) — CONDITIONS and the eFOLDER.
 *
 * WHAT THIS IS. The model behind a Condition Center: how conditions and documents
 * are really shaped in this tenant, which endpoints reach them, and which do not.
 * Verified live against the tenant on 2026-08-14, read-only.
 *
 * THE FIRST THING TO KNOW — THIS TENANT USES **ENHANCED CONDITIONS**.
 * The legacy condition endpoints exist and answer 200, but they answer with an
 * EMPTY ARRAY on every loan, which reads like "no conditions" and is a trap:
 *     GET /encompass/v1/loans/{id}/conditions/underwriting   → 200 []  ← always empty
 *     GET /encompass/v1/loans/{id}/conditions/preliminary    → 200 []  ← always empty
 *     GET /encompass/v1/loans/{id}/conditions/postclosing    → 200 []  ← always empty
 *     GET /encompass/v1/loans/{id}/underwritingConditions    → 200 []  ← always empty
 * Scanning all 772 loans through those paths found ZERO conditions. The real data
 * lives on the Enhanced Conditions resource:
 *     GET /encompass/v3/loans/{id}/conditions                → the conditions
 * which returned 348 conditions across 12 loans. Same tenant, same loans.
 *
 * READ-ONLY. This module describes and reads. It performs no writes; the authorized
 * write path is specified in WRITE_PATH below and is not implemented here.
 */

// ── Where conditions actually live ───────────────────────────────────────────
const ENDPOINTS = {
  verifiedWorking: {
    list: 'GET /encompass/v3/loans/{loanId}/conditions',
    one: 'GET /encompass/v3/loans/{loanId}/conditions/{conditionId}',
    comments: 'GET /encompass/v3/loans/{loanId}/conditions/{conditionId}/comments',
    tracking: 'GET /encompass/v3/loans/{loanId}/conditions/{conditionId}/tracking',
    types: 'GET /encompass/v3/settings/loan/conditions/types',
    templates: 'GET /encompass/v3/settings/loan/conditions/templates',
    sets: 'GET /encompass/v3/settings/loan/conditions/sets',
    documents: 'GET /encompass/v3/loans/{loanId}/documents',
    attachments: 'GET /encompass/v3/loans/{loanId}/attachments',
  },
  misleadinglyEmpty: [
    'GET /encompass/v1/loans/{loanId}/conditions/underwriting',
    'GET /encompass/v1/loans/{loanId}/conditions/preliminary',
    'GET /encompass/v1/loans/{loanId}/conditions/postclosing',
    'GET /encompass/v1/loans/{loanId}/underwritingConditions',
  ],
  notFound: [
    'GET /encompass/v3/loans/{loanId}/conditions/underwriting  (404 — v3 has no sub-path form)',
    'GET /encompass/v1/loans/{loanId}/conditions               (404 — v1 has no collection form)',
  ],
  personaBlocked: [
    'GET /encompass/v3/settings/loan/conditions            (403)',
    'GET /encompass/v3/settings/loan/conditions/categories (403)',
    'GET /encompass/v3/settings/loan/conditions/priorTo    (403)',
  ],
};

// ── The condition object ─────────────────────────────────────────────────────
const CONDITION_SHAPE = {
  id: 'condition GUID',
  conditionType: 'Underwriting | Closing | Preliminary | Investor Delivery | Post-Closing',
  title: "short name, e.g. 'Appraisal', 'Title', 'LLC Documents'",
  internalDescription: 'what staff see (may embed an external reference like E-[4240954])',
  externalDescription: 'what the borrower / TPO sees — this is the text to surface outward',
  category: 'Property | Credit | Miscellaneous | Income | Assets | Legal',
  priorTo: 'Approval | Docs | Funding | Closing | Submittal | Purchase — the gate it blocks',
  status: 'Added | Cleared | Fulfilled | Waived | Rejected | Received | Requested',
  statusOpen: 'boolean — the single field that answers "is this still outstanding?"',
  statusDate: 'when the status last changed',
  source: 'Borrowers | Title / Settlement Agent | Appraiser / AMC | Insurance Agent | Internal | Other',
  sourceOfCondition: 'ConditionList | User | AutomatedByUser | Manual — how it got on the file',
  printDefinitions: 'InternalPrint and/or ExternalPrint — controls whether it appears on the borrower-facing list',
  application: "which borrower pair it belongs to ('All' for file-level)",
  owner: 'the role that owns clearing it',
  assignedTo: 'the user it is assigned to',
  recipient: 'who it is addressed to',
  daysToReceive: 'SLA in days',
  commentsCount: 'number of comments (fetch via the comments endpoint)',
  isRemoved: 'soft-delete flag — filter these out',
  createdBy: 'entityId + entityName',
  createdDate: 'ISO timestamp',
  lastModifiedBy: 'entityId', lastModifiedDate: 'ISO timestamp',
  internalId: "the template's short code, e.g. 'UW'",
};

// What the live population looks like (12 loans, 348 conditions, 2026-08-14).
const OBSERVED = {
  loansWithConditions: 12,
  conditionsSeen: 348,
  perLoanRange: '5 – 67 conditions',
  byType: { Underwriting: 333, Closing: 14, Preliminary: 1 },
  byStatus: { Added: 195, Cleared: 124, Fulfilled: 12, Waived: 11, Rejected: 4, Received: 1, Requested: 1 },
  openVsClosed: { open: 213, closed: 135 },
  byCategory: { Miscellaneous: 128, Property: 91, Credit: 84, Legal: 15, Assets: 13, Income: 6 },
  byPriorTo: { Docs: 207, Funding: 102, Approval: 34, Submittal: 3 },
  authors: 'Mostly in-house underwriters; 66 conditions were written by the delegated '
    + "underwriting service that logs in as 'evolveapi' (Underwriter, Evolve).",
  note:
    'Conditions are rare in this tenant because most long-term files are underwritten by the '
    + 'investor rather than in Encompass. The 12 loans that DO have them are the delegated files, '
    + 'and they are the template for what a full Condition Center has to handle.',
};

// ── The eFolder ──────────────────────────────────────────────────────────────
const EFOLDER = {
  what:
    'The eFolder is the document side of the file. A DOCUMENT is a placeholder with a title, a '
    + 'status and a milestone; an ATTACHMENT is an actual file. A document holds zero or more '
    + 'attachments, and an attachment belongs to exactly one document at a time.',
  observed: {
    loansWithDocuments: 673,
    documentRows: 20569,
    attachments: 28822,
    documentToConditionLinks: 179,
    documentTypesConfigured: 230,
  },
  documentShape: {
    documentId: 'GUID',
    title: "e.g. 'Appraisal', 'Credit Report', 'Entity documents'",
    titleWithIndex: 'title plus an index when the same type repeats',
    applicationId: "which borrower pair — '_borrower1', '_borrower2' …",
    applicationName: 'the borrower the document belongs to',
    milestoneId: 'the milestone the document is expected at (Docs Out, Submittal, LO Prep …)',
    status: 'needed | received | ordered | reordered | expected | expected! | expired! | '
      + 'ready to ship | ready for UW | reviewed',
    attachments: 'the files under this document',
    conditions: 'THE LINK — [{ entityId, entityType: "EnhancedCondition", entityName, entityUri }]',
    roles: 'which roles can see it (LC, LP, UW, CL …)',
    comments: 'threaded comments',
    webCenterAllowed: 'visible in the borrower portal',
    tpoAllowed: 'visible to the TPO',
    thirdPartyAllowed: 'visible to third parties',
    isProtected: 'locked from edits',
    daysDue: 'SLA', daysTillExpire: 'expiry window',
    dateCreated: 'ISO', createdBy: 'user id',
  },
  howDocumentsLinkToConditions:
    'The link lives on the DOCUMENT, not on the condition: document.conditions[] holds one entry '
    + 'per linked condition, each with entityType "EnhancedCondition" and an entityUri of '
    + '/v3/loans/{loanId}/conditions/{conditionId}. To build "show me the documents that satisfy '
    + 'this condition", read the documents and invert the mapping — there is no '
    + 'condition→documents endpoint.',
  statusDistribution: { received: 16744, reordered: 1207, needed: 1277, ordered: 699,
    'expired!': 276, 'ready to ship': 185, 'expected!': 79, 'ready for UW': 79, reviewed: 18, expected: 5 },
  milestoneDistribution: { 'Docs Out': 6293, Submittal: 5083, 'LO Prep': 2378,
    'Ready for Docs': 1826, 'Loan Setup': 1310, Funding: 1055, 'Cond. Approval': 916, Started: 448 },
};

// ── The authorized write path — SPECIFIED, NOT IMPLEMENTED ───────────────────
// Owner-authorized 2026-08-14 (recorded in docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md):
// upload a document into the eFolder and link it to a condition. Nothing in
// src/longterm/** performs this write today. It is written down here so the
// implementation starts from verified endpoints instead of a guess — the pad's rule
// 3 forbids guessing a write, and the exact request/response contract for the
// upload still needs to be confirmed against ICE's reference before we send one.
const WRITE_PATH = {
  status: 'AUTHORIZED — NOT YET IMPLEMENTED',
  authorizedBy: 'owner, 2026-08-14',
  padEntry: 'docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md',
  steps: [
    { step: 1, action: 'Ask Encompass for a cloud upload URL',
      endpoint: 'POST /encompass/v3/loans/{loanId}/attachmentUploadUrl',
      confirmed: 'endpoint name confirmed from ICE documentation; request/response body NOT yet verified' },
    { step: 2, action: 'PUT the file bytes to the returned cloud-storage URL',
      note: 'the upload goes to storage, not to api.elliemae.com' },
    { step: 3, action: 'Attach the uploaded file to an eFolder document',
      endpoint: 'PATCH /encompass/v3/loans/{loanId}/documents',
      confirmed: 'NOT yet verified' },
    { step: 4, action: 'Link the document to the condition',
      endpoint: 'PATCH /encompass/v3/loans/{loanId}/conditions',
      note: 'or set document.conditions[] in step 3 — needs verification' },
  ],
  deprecationWarning:
    'The v1 attachment endpoints (GET/PUT/POST /encompass/v1/loans/{id}/attachments…) are '
    + 'being sunset in ICE release 26.3. Build on v3 only.',
  beforeImplementing: [
    'Confirm each request/response body against ICE\'s Developer Connect reference or a sandbox.',
    'Confirm the API client is permitted the scope these writes need (see api-surface.js — '
      + 'encompass_admin is currently REFUSED for this client id).',
    'Isolate in its own module with its own endpoint allowlist, super-admin gated, audited, '
      + 'and default-off behind a setting — the flood-order module is the house pattern.',
    'Test against a non-production loan first. These writes touch live borrower files.',
  ],
};

module.exports = { ENDPOINTS, CONDITION_SHAPE, OBSERVED, EFOLDER, WRITE_PATH };
