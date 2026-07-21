/**
 * NOTIFICATION CATALOG — one entry per distinct notification the system can
 * send. This is the source of truth the Notification Center screen reads to
 * paint the toggle list, and the gate (lo-notification-gate) reads to decide
 * whether a given send is FORCED (regulatory: DocuSign, security, account).
 *
 * KEY resolution:
 *   The gate looks up preferences by `key`. Most entries key on the raw
 *   notification `type` — that's what the notify chokepoint has in hand. A few
 *   entries share a `type` but differ in intent (e.g. a doc_uploaded email
 *   sent from staff-uploads-on-borrower's-behalf vs. from borrower-uploads);
 *   the gate collapses those to the same key.
 *
 * FORCED entries must never be silenced:
 *   - DocuSign / e-signature lifecycle events (regulatory delivery record)
 *   - Security & account events (password reset, MFA, account lockout)
 *   - Escalation-to-super-admin traffic (approval-gated business risk)
 */
'use strict';

const CATALOG = [
  // ─── Borrower onboarding / identity ───────────────────────────────────────
  { key: 'account_welcome',       label: 'Borrower welcome / activation email',
    description: "Sent the moment a borrower registers. Confirms the portal is active and asks them to verify the email on file.",
    category: 'security', audience: 'borrower', forced: true, default_mode: 'automatic' },
  { key: 'account_verify_email',  label: 'Verify email address',
    description: "One-click email verification link — sent when the borrower sets or changes their email.",
    category: 'security', audience: 'borrower', forced: true, default_mode: 'automatic' },
  { key: 'account_password_reset', label: 'Password reset link',
    description: "The reset link when someone clicks 'Forgot password?'. Always sent for account safety.",
    category: 'security', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'account_mfa_code',      label: 'Two-factor sign-in code',
    description: "One-time code sent during two-factor sign-in. Required for account security.",
    category: 'security', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'account_invite',        label: 'Portal invitation',
    description: "Sent when staff invites a new borrower / co-borrower / staff member to the portal.",
    category: 'security', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'security',              label: 'Security alert',
    description: "Alerts the borrower to a security-sensitive change on their account (new device, password change, MFA change).",
    category: 'security', audience: 'borrower', forced: true, default_mode: 'automatic' },
  { key: 'account',               label: 'Account update',
    description: "General account-level confirmations (email change, phone change).",
    category: 'security', audience: 'borrower', forced: true, default_mode: 'automatic' },

  // ─── New application / intake ─────────────────────────────────────────────
  { key: 'new_application',       label: 'New application submitted (to LO)',
    description: "Tells you when a borrower has submitted a brand-new application selecting you as their loan officer.",
    category: 'intake', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'unassigned_application', label: 'Unassigned application (Lead Capture)',
    description: "Alerts admins when a new application comes in with no loan officer selected.",
    category: 'intake', audience: 'admin', forced: false, default_mode: 'automatic' },
  { key: 'new_lead',              label: 'New marketing-tool lead',
    description: "Someone completed a marketing tool (term sheet / rehab budget / track record) on the site — a lead was captured.",
    category: 'intake', audience: 'staff', forced: false, default_mode: 'automatic' },

  // ─── Assignment / team ────────────────────────────────────────────────────
  { key: 'assignment',            label: 'You were assigned to a file',
    description: "Sent to a staff member the moment they're assigned as loan officer / processor / assistant on a file.",
    category: 'assignment', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'officer_assigned',      label: 'Meet your loan officer (to borrower)',
    description: "Introduces the loan officer to the borrower the first time an officer is assigned (or changes).",
    category: 'assignment', audience: 'borrower', forced: false, default_mode: 'automatic' },

  // ─── Status changes ───────────────────────────────────────────────────────
  { key: 'status_change',         label: 'Loan status change',
    description: "Every time your file moves to a new stage (submitted, in processing, underwriting, approved, clear-to-close, funded, etc.). Borrower gets email only on major decisions; the team is always notified in-app.",
    category: 'status', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'closing_date',          label: 'Closing date set / updated',
    description: "Announces or updates the estimated closing date on the file to the borrower.",
    category: 'status', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'milestone',             label: 'Milestone reached (appraisal in, funds released)',
    description: "Real waypoints on the loan — the appraisal arrived, a draw was released, retainage released — sent to the borrower.",
    category: 'status', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'all_caught_up',         label: 'You are all caught up',
    description: "Reassures the borrower when the last outstanding item on their side is signed off (throttled once/day per file).",
    category: 'status', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'clear_to_close',        label: 'Clear to close',
    description: "Announces the file has reached Clear to Close.",
    category: 'status', audience: 'both', forced: false, default_mode: 'automatic' },

  // ─── Product registration & pricing ───────────────────────────────────────
  { key: 'product_registered',    label: 'Product registered on file',
    description: "Fires when a product with its numbers is (re-)registered on the file — sent to the whole assigned team.",
    category: 'pricing', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'term_sheet',            label: 'Term sheet to borrower',
    description: "The borrower-safe term sheet with structure breakdown + the 3-month minimum-interest note. Sent only when a headline number actually changes.",
    category: 'pricing', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'pricing_update',        label: 'Pricing update',
    description: "Notification when pricing inputs (rate, cash-to-close, etc.) change on a registered file.",
    category: 'pricing', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'manual_escalation',     label: 'Manual product / exception (to super-admins)',
    description: "Alerts super-admins that a registration hit a manual-review / exception path and is waiting in Escalations.",
    category: 'pricing', audience: 'admin', forced: true, default_mode: 'automatic' },
  { key: 'manual_escalation_decided', label: 'Manual product / exception decided',
    description: "Confirms the outcome of a manual-review or exception request back to the requester.",
    category: 'pricing', audience: 'staff', forced: true, default_mode: 'automatic' },

  // ─── Conditions ───────────────────────────────────────────────────────────
  { key: 'condition_added',       label: 'New condition added on file',
    description: "Tells the borrower a new item was added they must respond to; tells the team when the borrower fills a condition.",
    category: 'conditions', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'condition_clearing',    label: 'Condition cleared / signed off',
    description: "Confirms a condition has been cleared or waived on the file.",
    category: 'conditions', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'change_request',        label: 'Change request (borrower to team / team to borrower)',
    description: "Borrower proposes a change on a locked file, or staff approves/rejects one. Both sides notified.",
    category: 'conditions', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'finding_escalation',    label: 'Finding routed for your review',
    description: "An underwriting finding was escalated to your workload — action needed.",
    category: 'conditions', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'finding_escalation_decided', label: 'Finding escalation decided',
    description: "A finding you escalated has been decided; tells you the outcome.",
    category: 'conditions', audience: 'staff', forced: false, default_mode: 'automatic' },

  // ─── Documents ────────────────────────────────────────────────────────────
  { key: 'doc_uploaded',          label: 'Document uploaded on file',
    description: "In-app FYI to the team when a borrower uploads a document, or to the borrower when staff uploads on their behalf.",
    category: 'documents', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'doc_accepted',          label: 'Document accepted',
    description: "Internal-only record when staff accepts a document. Never emails the borrower (already visible in checklist).",
    category: 'documents', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'doc_rejected',          label: 'Document rejected — needs a new upload',
    description: "Tells the borrower a document needs to be re-uploaded, with the reason.",
    category: 'documents', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'doc_requested',         label: 'Additional document requested',
    description: "Tells the borrower another document is needed for a condition (e.g. one more page).",
    category: 'documents', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'tool_submitted',        label: 'Borrower submitted a tool (SOW / track record / term sheet)',
    description: "Tells the team a borrower answered a tool-backed task and it's ready to review.",
    category: 'documents', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'order_docs_in',         label: 'Ordered documents came back',
    description: "Nudges the desk when third-party documents (title commit, flood, HOI) arrive in the file inbox.",
    category: 'documents', audience: 'staff', forced: false, default_mode: 'automatic' },

  // ─── Entities & track record ──────────────────────────────────────────────
  { key: 'llc_verified',          label: 'LLC / entity verified',
    description: "Confirms the borrower's LLC has been fully verified by staff.",
    category: 'documents', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'llc_unverified',        label: 'LLC verification revoked',
    description: "Tells the borrower their LLC verification was revoked and what needs to be fixed.",
    category: 'documents', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'track_record_unverified', label: 'Track record project unverified',
    description: "Tells the borrower a previously-verified project on their track record was revoked, with reason.",
    category: 'documents', audience: 'borrower', forced: false, default_mode: 'automatic' },

  // ─── E-signature / DocuSign (regulatory — always forced) ──────────────────
  { key: 'esign_sent',            label: 'DocuSign envelope sent (to signer)',
    description: "DocuSign notification to the signer that a document is ready. FORCED — legally required delivery.",
    category: 'docusign', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'esign_reminder',        label: 'DocuSign signing reminder',
    description: "DocuSign reminder to the signer. FORCED.",
    category: 'docusign', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'esign_completed',       label: 'DocuSign envelope completed',
    description: "DocuSign confirmation to every party that all signatures are in. FORCED.",
    category: 'docusign', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'esign_declined',        label: 'DocuSign envelope declined',
    description: "DocuSign notice that a signer declined. FORCED.",
    category: 'docusign', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'esign_voided',          label: 'DocuSign envelope voided',
    description: "DocuSign notice that the envelope was voided. FORCED.",
    category: 'docusign', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'esign_lifecycle',       label: 'Other DocuSign lifecycle events (viewed, expired, delivered)',
    description: "Any other DocuSign lifecycle event routed through the internal status_change email. FORCED — regulatory audit trail.",
    category: 'docusign', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'esign_countersign',     label: 'DocuSign counter-signature complete',
    description: "Notice when the internal counter-signature is complete on a signed envelope. FORCED.",
    category: 'docusign', audience: 'both', forced: true, default_mode: 'automatic' },
  { key: 'esign_dead_letter',     label: 'DocuSign failed delivery (dead-letter alert)',
    description: "Alerts the team when DocuSign delivery has permanently failed after all retries. FORCED.",
    category: 'docusign', audience: 'staff', forced: true, default_mode: 'automatic' },

  // ─── Draws & construction ─────────────────────────────────────────────────
  { key: 'draw',                  label: 'Draw released',
    description: "Confirms a construction draw has been released to the borrower, with the net wired amount.",
    category: 'draws', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'draw_request',          label: 'Draw request (borrower click)',
    description: "Borrower's 'Request a draw' click — notifies the team to set up draws, acknowledges receipt to the borrower.",
    category: 'draws', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'draw_setup',            label: 'Construction draws are open',
    description: "Tells the borrower the coordinator has finished setting up draws and they can now request funds.",
    category: 'draws', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'draw_started',          label: 'Draw process started (coordinator)',
    description: "In-app note when the coordinator presses 'Start the draw process' on a file.",
    category: 'draws', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'draw_findings',         label: 'Inspection findings ready for borrower',
    description: "Tells the borrower inspection findings are ready for accept/dispute; drives the wire SLA.",
    category: 'draws', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'draw_accepted',         label: 'Borrower accepted findings',
    description: "Notice back to the team that the borrower accepted the inspection findings.",
    category: 'draws', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'draw_disputed',         label: 'Borrower disputed findings',
    description: "Notice back to the team that the borrower disputed a line item (with photo evidence).",
    category: 'draws', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'draw_dispute_resolved', label: 'Dispute resolved (to borrower)',
    description: "Tells the borrower the outcome of their disputed lines once staff decides them.",
    category: 'draws', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'draw_message',          label: 'Coordinator message from the draw desk',
    description: "Direct message from the draw coordinator to the borrower on the draw desk.",
    category: 'draws', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'draw_inbound',          label: 'Draw activity from Sitewire',
    description: "Inbound Sitewire event picked up by the reconcile pass (borrower draw submission, inspector activity).",
    category: 'draws', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'sow_reallocation',      label: 'Scope-of-work reallocation',
    description: "A construction budget reallocation (net-zero) was recorded on the file.",
    category: 'draws', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'sow_change_request',    label: 'Scope-of-work change request',
    description: "Borrower or staff requested a change to the scope of work / rehab budget.",
    category: 'draws', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'draw_findings_reminder', label: 'Findings awaiting borrower acceptance (reminder)',
    description: "Every few business hours, reminds the borrower that inspection findings are still waiting on their accept/dispute.",
    category: 'reminders', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'draw_release_overdue',  label: 'Draw release overdue',
    description: "Alerts the team when an accepted draw's wire due date has passed with no recorded release.",
    category: 'reminders', audience: 'staff', forced: false, default_mode: 'automatic' },

  // ─── Messaging & chat ─────────────────────────────────────────────────────
  { key: 'message',               label: 'Chat message on file',
    description: "New chat message from the other side of the file thread (borrower ↔ team).",
    category: 'messaging', audience: 'both', forced: false, default_mode: 'automatic' },
  { key: 'mention',               label: 'You were @mentioned',
    description: "Someone @mentioned you in a chat or comment.",
    category: 'messaging', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'inbound_reply',         label: 'Borrower replied by email',
    description: "A borrower replied to a notification email; forwarded into the file's chat thread.",
    category: 'messaging', audience: 'staff', forced: false, default_mode: 'automatic' },

  // ─── Reminders & digests ──────────────────────────────────────────────────
  { key: 'reminder',              label: "Manual 'nudge the borrower' reminder",
    description: "You clicked Remind on a file to prod the borrower about outstanding items. Throttled 30 minutes.",
    category: 'reminders', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'digest_weekly_borrower', label: 'Weekly borrower outstanding-items digest',
    description: "Every week the borrower is emailed a summary of what's still needed.",
    category: 'digests', audience: 'borrower', forced: false, default_mode: 'automatic' },
  { key: 'digest_daily_officer',  label: 'Daily officer pipeline snapshot',
    description: "Once a day, the loan officer gets a snapshot of their pipeline (in-progress, aging, needing attention).",
    category: 'digests', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'digest_stale_file',     label: 'Stale-file alert',
    description: "Alert when a file has been idle for more than STALE_FILE_DAYS (default 10).",
    category: 'digests', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'digest_monday_admin',   label: 'Monday admin summary',
    description: "Weekly Monday morning summary of the company pipeline to admins.",
    category: 'digests', audience: 'admin', forced: false, default_mode: 'automatic' },

  // ─── Workflow (staff hand-off) ────────────────────────────────────────────
  { key: 'workflow_submitted',    label: 'File submitted to your Workflow queue',
    description: "Another staffer handed a file to your personal work queue.",
    category: 'status', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'workflow_returned',     label: 'Workflow item returned',
    description: "The staffer you handed a file to has finished it and returned it.",
    category: 'status', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'workflow_ready',        label: 'File is ready for its next step',
    description: "The system detected a file just crossed a workflow-readiness threshold (e.g. all conditions clear).",
    category: 'status', audience: 'staff', forced: false, default_mode: 'automatic' },

  // ─── System / operational ────────────────────────────────────────────────
  { key: 'sync_review',           label: 'Sync review needs your attention',
    description: "A conflict between the portal and ClickUp (or another integration) is waiting for you to resolve.",
    category: 'system', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'integration_alert',     label: 'Integration down / recovered',
    description: "An integration (ClickUp / Sitewire / SharePoint / e-sign / email) went down or came back up.",
    category: 'system', audience: 'admin', forced: false, default_mode: 'automatic' },
  { key: 'sharepoint_backlog_slo', label: 'SharePoint backlog exceeded threshold',
    description: "The SharePoint document mirror backlog exceeded its target — investigate.",
    category: 'system', audience: 'admin', forced: false, default_mode: 'automatic' },
  { key: 'sharepoint_worker_stalled', label: 'SharePoint worker stalled',
    description: "The SharePoint mirror worker has been stalled — investigate.",
    category: 'system', audience: 'admin', forced: false, default_mode: 'automatic' },
  { key: 'inbound_reply_failed',  label: 'Inbound email could not be delivered',
    description: "A borrower reply came in but the system could not route it (no recipients / lookup failed).",
    category: 'system', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'inbound_reply_dropped', label: 'Inbound email dropped (rate limited / archived)',
    description: "A borrower reply was dropped (rate-limited or file archived).",
    category: 'system', audience: 'staff', forced: false, default_mode: 'automatic' },
  { key: 'borrower_dedup',        label: 'Duplicate borrower email flagged',
    description: "Public intake found the email belongs to another borrower profile; flag for a human to reconcile.",
    category: 'system', audience: 'admin', forced: false, default_mode: 'automatic' },
];

// Map a raw notification `type` (what the notify chokepoint has in hand) to the
// catalog key the LO's preferences store. Most types map 1:1; a few are group
// aliases (draw_reminder → draw_findings_reminder; digest → the digest bucket
// most likely to be firing on this call).
const TYPE_TO_KEY = {
  // Identity 1:1 defaults — filled programmatically below for every entry
  // whose key === a known type. Special aliases:
  digest: 'digest_weekly_borrower',
  // Draw findings reminder is a separate schedule-driven wrapper for draw_findings
  // in notification-digests.js — we still key it by the underlying type when it
  // arrives; when scheduled digests want to key differently they pass notif_key
  // explicitly via opts.notifKey.
};

for (const entry of CATALOG) TYPE_TO_KEY[entry.key] = entry.key;

function keyForType(type, opts) {
  if (opts && typeof opts.notifKey === 'string' && opts.notifKey) return opts.notifKey;
  return TYPE_TO_KEY[type] || type || null;
}

function entryForKey(key) {
  if (!key) return null;
  return CATALOG.find((e) => e.key === key) || null;
}

// A key is FORCED if either the catalog says so OR the type is DocuSign /
// security / account. Belt-and-suspenders against a new call site that fires
// an esign type before the catalog gets an entry.
const FORCED_KEYS = new Set(CATALOG.filter((e) => e.forced).map((e) => e.key));
const FORCED_TYPE_PREFIXES = ['esign_', 'docusign_', 'account_', 'security'];

function isForced(key, type) {
  if (key && FORCED_KEYS.has(key)) return true;
  if (type) {
    for (const p of FORCED_TYPE_PREFIXES) if (String(type).startsWith(p)) return true;
    if (type === 'security' || type === 'account') return true;
  }
  return false;
}

// User-facing category order for the settings screen.
const CATEGORIES = [
  { id: 'intake',     label: 'Intake & new applications' },
  { id: 'assignment', label: 'Assignment' },
  { id: 'status',     label: 'Loan status & workflow' },
  { id: 'pricing',    label: 'Pricing, term sheet & registration' },
  { id: 'conditions', label: 'Conditions & change requests' },
  { id: 'documents',  label: 'Documents & uploads' },
  { id: 'docusign',   label: 'DocuSign / e-signature (always on)' },
  { id: 'draws',      label: 'Construction draws' },
  { id: 'messaging',  label: 'Messages & mentions' },
  { id: 'reminders',  label: 'Reminders' },
  { id: 'digests',    label: 'Scheduled digests' },
  { id: 'security',   label: 'Security & account (always on)' },
  { id: 'system',     label: 'System & integrations' },
];

module.exports = { CATALOG, CATEGORIES, keyForType, entryForKey, isForced };
