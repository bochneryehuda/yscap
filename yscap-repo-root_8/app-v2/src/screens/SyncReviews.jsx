import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDay } from '../lib/dates.js';
import { useAuth } from '../lib/auth.jsx';
import { useFlash } from '../components/FlashToast.jsx';
import { askConfirm } from '../lib/dialog.js';

/* Sync review queue — the human gate for PILOT ⇄ ClickUp disagreements
 * (2026-07-15). The auto-resolution engine settles the provable conflicts by
 * itself; only genuine ambiguity lands here, and the file's loan officer is
 * emailed when it does. Every card is TWO-SIDED: what ClickUp holds vs what
 * PILOT holds. Choosing "Adopt" applies that side's CURRENT value to BOTH
 * systems (re-read live at resolve time, fully audited + journaled). Dismiss
 * keeps both sides exactly as they are. */

const REASON_COPY = {
  dob_one_day_shift_blocked: 'An automated push wanted to move an existing ClickUp DOB by exactly one day — the corruption signature. Nothing was written.',
  dob_change_blocked_pending_review: 'An automated push wanted to change an existing ClickUp date of birth. A DOB change is always a human decision — nothing was written.',
  dob_restore_needs_review: 'The date-repair tooling found the two systems disagreeing on this DOB and could not prove which is right.',
  clickup_year_out_of_range: 'ClickUp holds a date with an impossible year (a mid-typing artifact or a 2-digit year). Nothing was synced.',
  clickup_dob_year_out_of_range: 'ClickUp holds a DOB with an impossible year. Nothing was synced.',
  clickup_dob_implausible: 'ClickUp holds a DOB that cannot belong to an adult borrower. Nothing was synced.',
  clickup_dob_differs_from_portal: 'ClickUp and PILOT carry different dates of birth and neither is provably wrong — a person must decide.',
  dob_same_but_impossible: 'Both systems carry the SAME date of birth — but it cannot be right (see the note next to the value). Correct the DOB on the borrower’s file, then dismiss this row.',
  pii_overwrite_blocked: 'A bulk repush wanted to overwrite this borrower-identity value in ClickUp. Bulk pushes may only fill blanks — nothing was written.',
  file_not_materialized_ambiguous: 'This ClickUp task could not be matched to a PILOT file — its identity signals (loan number / address / stamp) point at more than one existing file or at another borrower’s loan. Fix the conflicting value in ClickUp (usually a loan number copied by the duplicate-a-task workflow) and this row closes itself on a later sync — or resolve it right here: create it as its own new file, or link it to one of the candidate files below.',
  file_not_materialized_duplicate_pending: 'This task looks like a fresh ClickUp duplicate that still shows another ACTIVE deal’s address, so PILOT is deliberately waiting rather than creating a twin file. Update the task’s address in ClickUp and the file appears on the next sync — or, if this genuinely is a second deal at the same address, create it now. (When the earlier deal at this address is already funded or cancelled, the file is created automatically — no action needed.)',
  copied_loan_number_needs_assignment: 'Two of this borrower’s tasks carried the SAME YS loan number (the duplicate-a-task workflow copies it), and this file is the one holding a copy — a loan number belongs to exactly one loan, so it was not kept here. Fix it in ClickUp: enter this deal’s correct number on this task (it syncs in and this row closes itself), or clear the number on whichever task is the duplicate — the system automatically gives a contested number to the task that rightfully owns it (the older task, or the only one still carrying it).',
  loan_number_duplicate_entered: 'Someone tried to put a loan number on this file that is already used somewhere else — either on another of our files or on a different file in ClickUp (even a data-only file we don’t build a loan from, like a DSCR file). A loan number belongs to exactly one file, so it was NOT saved. Enter a unique number for this file, or clear the number off whichever other file is the duplicate — then dismiss this row.',
  task_deleted_needs_decision: 'This file’s ClickUp task was DELETED and no live task for the same deal exists. Decide what the file should do: archive it (reversible, ClickUp untouched), or keep it in PILOT without a task.',
  push_dead_lettered: 'An update from PILOT could not reach ClickUp after every retry (the fields and the last error are shown above). Nothing was lost in PILOT. Retry the push once the cause is fixed — this row also closes itself when any later push for the file succeeds.',
  file_unlinked_no_task: 'This PILOT file has NO ClickUp task, so it does not sync at all (it is older than the automatic recovery window). Link it to the correct existing ClickUp card, create a fresh ClickUp task, or dismiss if this file intentionally lives outside ClickUp.',
  file_dead_unlinked: 'This is a LIVE file that lost its ClickUp card and went orphaned — it no longer syncs, and if another (often near-empty duplicate) file is holding the card, every update has been flowing into that wrong file. Fix it: paste the correct ClickUp card link/id to move the card onto THIS file (if the card is on another file, you’ll be asked to confirm the move), or give it a fresh card, archive it, or keep it as-is.',
  clickup_name_changed_at_source: 'The borrower’s name was CHANGED on the ClickUp card — and both the first AND last name are different from the profile, so this might be a different person rather than a corrected name. PILOT did not rename anybody. Compare the two and adopt the correct one (it is applied to both systems), or type the right name. (When only the FIRST name changes and the surname still matches — a nickname corrected to the real name, “Avi” → “Abraham” — PILOT adopts it automatically and you never see a card.)',
  identity_mismatch_audit: 'The portfolio audit found the two systems carrying DIFFERENT values for this borrower-identity field. Nothing was changed anywhere (identity fields never overwrite silently) — compare the sides and adopt the correct one; it is applied to both systems. If both are fine (e.g. an old phone number), dismiss and this stays closed.',
  sharepoint_match_uncertain: 'The SharePoint mirror was NOT SURE which folder this file’s documents belong in (an ambiguous folder match, or no officer yet), so it filed into a safe, clearly-marked new folder — shown under “In PILOT”. If that is the wrong tree: merge or rename the folders IN SharePoint (the mirror never moves or renames anything itself), then click Re-match. Dismiss keeps the new folder.',
  sharepoint_mirror_failed: 'This document could NOT be mirrored to SharePoint after every automatic retry — the exact error is shown on the “Last error” line above. Fix the cause if it needs a human (a folder problem, an unreadable file), then Retry the document; if the folder match itself is wrong, use Re-match. Nothing is lost — the document is safe in PILOT.',
  borrower_identity_conflict: 'TWO DIFFERENT PEOPLE appear to share ONE borrower profile: this file’s ClickUp task and the PILOT profile disagree on identity (name, phone, or SSN), and the profile also belongs to another officer’s relationship (a lead or owned profile). This usually comes from a family-shared email + the family last name. Do NOT adopt either value — that would change the other person too. Click Split: the file’s person gets their OWN fresh profile (rebuilt from ClickUp), and the other person keeps the original profile untouched. Dismiss only if you are sure it is genuinely the same human.',
  shared_email_needs_reassignment: 'TWO BORROWER PROFILES are using ONE email address (shown under “In ClickUp”; the two people under “In PILOT”). Two ways to settle it: (1) if the sharing is RIGHT — spouses on the same deals, or the same person twice — click Allow: the two profiles are LINKED, whoever logs in with the email sees BOTH sets of files, and this never flags again (nothing is merged; each keeps their own profile and officer). (2) If they are unrelated people, give one of them their OWN email — edit it on their borrower screen in PILOT or on the ClickUp task — and this card closes itself. Until settled, the system deliberately refuses to link files by this email.',
  encompass_address_differs: 'The most recent ENCOMPASS file for this borrower carries a different home address than their PILOT profile. Nothing was changed — a person\u2019s address on file is real data that a stale loan must never overwrite. Encompass is read-only here, so whichever value you pick is written to the PILOT profile (and pushed on to their ClickUp cards); nothing is ever sent back to Encompass. If both are right because they moved, use the Encompass one; if the Encompass file is old, keep PILOT\u2019s.',
  portal_value_not_in_clickup: 'PILOT is holding a value that the matching ClickUp dropdown has no option for (shown above). Because ClickUp cannot store it, the update to the ClickUp card was quietly skipped — and until now the next sync read ClickUp’s old value back and UNDID the change on the file, which is why an edit like Fix & Flip → Fix & Hold kept “bouncing back”. PILOT now KEEPS its value and no longer lets the sync overwrite it. To make both systems agree, add that option to the ClickUp dropdown (then this closes itself on the next sync). If the value was picked by mistake, just set it back on the file. Nothing was lost either way — the file shows what the officer chose.',
  ctc_confirm_needed: 'ClickUp moved this file to Clear to Close, but in PILOT it is still at an earlier status (shown above). Clear to Close is a major milestone — it locks the file and tells the borrower they’re clear to close — so PILOT did NOT advance on its own. Confirm to move the file to Clear to Close in PILOT (the borrower is notified), or dismiss to keep its current status. Everything else from ClickUp still syncs normally; only this one big step waits for you.',
  economics_frozen_conflict: 'ClickUp carries different loan figures than PILOT (each change is listed above), but this file is FROZEN — a term sheet has been sent for signature, or the file is Clear-to-Close / Funded — so the numbers can’t change on their own (they would no longer match the term sheet that already went out). PILOT kept its figures and did NOT apply the ClickUp change. Three ways to settle it: (1) keep PILOT’s figures and push them back to ClickUp so both match; (2) an admin can use ClickUp’s figures and update the locked file right here (best for a reconciled/closed file whose numbers PILOT should now match — this overrides the lock); or (3) simply set the figures back in ClickUp to match the file. You no longer have to clear the term sheet or unlock the file just to accept a change.',
  portal_edit_conflict: 'This deal field (shown above) was changed in BOTH places to different values — someone edited it on the file in PILOT, and it was ALSO changed in ClickUp. To make sure your change was not quietly undone, PILOT KEPT the file’s value and did NOT apply the ClickUp one — it is asking you which to keep instead of deciding on its own. Pick one: “Keep the PILOT value” keeps the file’s value and sends it to ClickUp so both match; “Use ClickUp’s value” puts ClickUp’s value on the file (if it changes a priced number, the pricing / Scope-of-Work steps reopen so they can be re-checked). Nothing was lost — the file still shows what was set in PILOT until you choose.',
};
// Sitewire draw-management parks (field_key='sitewire'). The stored reason is
// "<class>: <detail>"; we key friendly copy by the class and show the detail beneath.
// These are "fix the file, then it re-pushes" rows — never silently applied.
const SITEWIRE_REASON_COPY = {
  sitewire_missing_loan_number: 'This file has no YS loan number, so its construction draws can’t be set up in Sitewire. Add the loan number on the file, and the setup pushes automatically.',
  sitewire_no_budget: 'No frozen construction budget is registered yet. Register the product first, then draws can be set up.',
  sitewire_no_sow: 'There’s no saved Scope of Work to turn into a Sitewire budget. Have the borrower (or staff) complete the Scope of Work.',
  sitewire_budget_mismatch: 'The Scope-of-Work line items don’t add up to the frozen construction budget to the penny, so nothing was pushed. Fix the Scope of Work so it matches the budget exactly.',
  sitewire_capital_partner_unmatched: 'The file’s capital partner couldn’t be matched to a Sitewire partner, so the property wasn’t created. Set the correct capital partner, or add the rule, and it retries.',
  sitewire_address_incomplete: 'The property address is missing part of the street / city / state / ZIP, so Sitewire can’t place it. Complete the address on the file.',
  sitewire_property_rejected: 'Sitewire rejected the property (usually the address wouldn’t geocode). Fix the address and it retries — nothing was guessed.',
  sitewire_loan_already_in_sitewire: 'This loan number is already on a property in Sitewire that PILOT did NOT create. PILOT only manages the draw process for properties it pushes itself, so it will not adopt or follow this one. To manage it here, delete that property in Sitewire and then push a fresh copy from this file (you’ll be warned first). Otherwise, keep them separate.',
  sitewire_borrower_assign_failed: 'The borrower couldn’t be added to the Sitewire property by email. Check the borrower’s email on the file.',
  sitewire_budget_drift: 'The construction budget in Sitewire no longer matches what PILOT set — someone may have edited it directly in Sitewire. Restore PILOT’s budget, or accept Sitewire’s.',
  sitewire_release_drift: 'A draw you already released now shows a different approved amount in Sitewire. The money already wired — this is an alert to reconcile it by hand.',
  sitewire_budget_rejected: 'Sitewire rejected the budget push. The exact reason is in the details below — fix it and it retries.',
  sitewire_bind_missing: 'A budget line we created didn’t come back from Sitewire, so we couldn’t link it. This needs a quick manual check before draws reconcile.',
  sitewire_bind_missing_property: 'Sitewire accepted the property but didn’t return the id we need to link it. Nothing was linked — a person should check the property in Sitewire before draws are set up.',
  sitewire_bind_ambiguous: 'Two budget lines share the same name, so we couldn’t tell which Sitewire line is which. Rename one so every line is unique.',
  sitewire_total_drift: 'After the push, Sitewire’s budget total didn’t match what we sent. Nothing else was changed — a person should reconcile it.',
  sitewire_total_unverified: 'We saved the budget to Sitewire but couldn’t read it back to confirm it stuck (a temporary connection issue). Nothing is wrong yet — please re-check the budget in Sitewire.',
  sitewire_dupe_check_failed: 'We couldn’t check whether this loan is already in Sitewire, so we did NOT create it (to avoid a duplicate). Try again once the connection is back, or check Sitewire by hand.',
  sitewire_unknown_draw_line: 'A draw came in for a budget line PILOT doesn’t recognize (it wasn’t one we created). It was NOT auto-applied — a person needs to reconcile it by hand.',
};
// FILE-LEVEL resolution options per reason (mirrors REASON_ACTIONS in
// src/lib/sync-file-review.js — the server validates; this only renders).
const REASON_FILE_ACTIONS = {
  file_not_materialized_ambiguous: [
    { action: 'create_file', label: 'Create as its own new file', title: 'Materialize this task as a brand-new PILOT file (all guards still apply)' },
    { action: 'link_existing', label: 'Link to selected file', title: 'Bind this task to the selected existing file, then fill it from the task', needsTarget: true },
  ],
  file_not_materialized_duplicate_pending: [
    { action: 'create_file', label: 'Create the file now', title: 'Deliberate override of the duplicate-wait: create the file from the task as it is' },
  ],
  task_deleted_needs_decision: [
    { action: 'archive_file', label: 'Archive the file', title: 'Soft-archive (reversible; ClickUp untouched)' },
    { action: 'keep_file', label: 'Keep the file', title: 'Keep it in PILOT without a ClickUp task' },
  ],
  push_dead_lettered: [
    { action: 'retry_push', label: 'Retry the push', title: 'Re-queue the failed update through the normal guarded push' },
  ],
  file_unlinked_no_task: [
    { action: 'relink_task', label: 'Link an existing card', title: 'Move an existing ClickUp card onto this file (asks to confirm if the card is on another file). Admin only.', needsTaskInput: true, adminOnly: true },
    { action: 'create_task', label: 'Create its ClickUp task', title: 'Create the ClickUp task for this file via the normal create path' },
  ],
  file_dead_unlinked: [
    { action: 'relink_task', label: 'Move the correct card here', title: 'Move an existing ClickUp card onto this file (asks to confirm if the card is currently on another file). Admin only.', needsTaskInput: true, adminOnly: true },
    { action: 'create_task', label: 'Create a fresh card', title: 'Create a brand-new ClickUp task for this file' },
    { action: 'archive_file', label: 'Archive the file', title: 'Soft-archive (reversible; ClickUp untouched)' },
    { action: 'keep_file', label: 'Keep as-is', title: 'Keep it in PILOT without a ClickUp card' },
  ],
  sharepoint_match_uncertain: [
    { action: 'sp_rematch', label: 'Re-match folders now', title: 'Clear the folder match so the next document sync re-runs it — fix the folders in SharePoint first (the mirror never moves anything itself)' },
  ],
  sharepoint_mirror_failed: [
    { action: 'sp_retry_doc', label: 'Retry the document', title: 'Re-arm the document’s mirror retries and kick a sync pass — fix the underlying cause first' },
    { action: 'sp_rematch', label: 'Re-match folders', title: 'Clear the folder match so the next sync re-runs it (when the folder resolution itself is the problem)' },
  ],
  borrower_identity_conflict: [
    { action: 'split_borrower', label: 'Split — give this file’s person their own profile', title: 'Un-merge: rebuild this file’s person from the ClickUp task on a fresh profile and re-point the file; the other person keeps the original profile untouched' },
  ],
  shared_email_needs_reassignment: [
    { action: 'allow_shared_email', label: 'Allow — same email for both', title: 'Link the two profiles: whoever logs in with this email sees BOTH people’s files. Nothing is merged; each keeps their own profile and officer, and this pair never flags again' },
  ],
  // Two of the borrower’s files carry the SAME loan number. Decide which one owns it; PILOT does its
  // side and tells you which ClickUp card still has a leftover copy to delete (PILOT never erases a
  // ClickUp box — that stays a human action in ClickUp).
  copied_loan_number_needs_assignment: [
    { action: 'loan_number_assign_here', label: 'This file owns the number', title: 'Give the loan number to THIS file and take it off the other file in PILOT. Then delete the leftover copy on the OTHER deal’s ClickUp card.' },
    { action: 'loan_number_keep_other', label: 'The other file owns it — this is the copy', title: 'Keep the number on the other deal; this file stays blank. Then delete the leftover copy on THIS file’s ClickUp card.' },
  ],
  economics_frozen_conflict: [
    { action: 'keep_frozen_figures', label: 'Keep PILOT’s figures (push to ClickUp)', title: 'Keep the file’s frozen loan figures and push them back to ClickUp so the two match.' },
    { action: 'accept_clickup_figures', label: 'Use ClickUp’s figures (update the locked file)', title: 'Admin only: pull ClickUp’s figures into this locked file, overriding the lock. Best for a reconciled/closed file whose numbers PILOT should now match. The pricing / Scope-of-Work conditions reopen because the registered numbers changed.', adminOnly: true },
  ],
  ctc_confirm_needed: [
    { action: 'confirm_ctc', label: 'Confirm — move to Clear to Close', title: 'Move this file to Clear to Close in PILOT so it matches ClickUp. This is a major milestone: it locks the file and notifies the borrower. It is refused if the file is not actually finished — anything still outstanding is listed above.' },
    { action: 'confirm_ctc_override', label: 'Override — move it anyway', title: 'Admin only: move the file to Clear to Close even though it is not finished. What was still outstanding is recorded on the file.', adminOnly: true },
  ],
  portal_edit_conflict: [
    { action: 'keep_portal_value', label: 'Keep the PILOT value', title: 'Keep the file’s value and push it to ClickUp so the two match. Use this when the PILOT value is the right one.' },
    { action: 'accept_clickup_value', label: 'Use ClickUp’s value', title: 'Put ClickUp’s value on the file. If it changes a priced number, the pricing / Scope-of-Work steps reopen so they can be re-checked.' },
  ],
};
// The itemized list of frozen-figure changes ClickUp made to a locked file
// (owner-directed 2026-07-27: "open up the box — these three things were changed
// in ClickUp"). The producer stores { lockReason, changes:[{field,label,from,to}] }
// in raw_value; we render each change as its own line (PILOT → ClickUp).
function frozenChanges(r) {
  try {
    const raw = r.raw_value ? JSON.parse(r.raw_value) : null;
    const cs = (raw && raw.changes) || [];
    return cs.filter((c) => c && c.field && c.label).map((c) => ({
      field: String(c.field), label: String(c.label),
      from: c.from == null ? null : String(c.from), to: c.to == null ? null : String(c.to),
    }));
  } catch { return []; }
}
// IS THE FILE ACTUALLY READY for Clear to Close? Captured onto the row when the
// move was held (owner-directed 2026-08-06 — a file reached CTC with conditions
// open and no executed term sheet package). The reviewer is being asked to
// advance a file to a LOCKING milestone, so what is still outstanding belongs on
// the card, not behind a click into the file. The snapshot is from when the pull
// happened; the server re-checks LIVE at confirm time, so this is guidance and
// never the authority — an older row can read "not ready" on a file that has
// since been finished, and the Confirm button will simply work.
function ctcReadiness(r) {
  try {
    const raw = r.raw_value ? JSON.parse(r.raw_value) : null;
    const rd = raw && raw.readiness;
    if (!rd || typeof rd.ready !== 'boolean') return null;   // older row / unreadable — say nothing
    return {
      ready: rd.ready,
      summary: rd.summary ? String(rd.summary) : null,
      outstanding: Array.isArray(rd.outstanding) ? rd.outstanding.map(String) : [],
    };
  } catch { return null; }
}
// The OTHER file that shares the contested loan number (from the row's forensic raw_value).
function otherLoanFile(r) {
  try {
    const raw = r.raw_value ? JSON.parse(r.raw_value) : null;
    const d = raw && (raw.ofApplication ? raw : (raw.detail || null));
    return { otherId: (d && d.ofApplication) || null, number: (raw && raw.number) || r.clickup_value || null };
  } catch { return { otherId: null, number: r.clickup_value || null }; }
}
// The ACTUAL recorded failure for a SharePoint document row (owner-reported
// 2026-07-16: the card said "the last error is recorded on the row" without
// SHOWING it, so every failure read as "a permissions problem"). The error
// travels in raw_value from the producer (recordFailure / the verify pass).
function spError(r) {
  try {
    const raw = r.raw_value ? JSON.parse(r.raw_value) : null;
    if (!raw) return '';
    if (raw.error) return String(raw.error);
    if (raw.kind === 'item-missing') return 'the mirror copy is no longer in SharePoint (deleted or moved by a person) — PILOT looked for it again by name and by its Pilot stamp and could not find it, and will not put it back on its own';
    if (raw.kind === 'local-missing') return 'the portal’s own stored bytes are unreadable — the SharePoint copy may be the only surviving one';
    if (raw.kind === 'source-suspect') return `the file’s content looks like ${raw.sniffed || 'unrecognized data'}, not ${raw.expected || 'its declared type'} — it was already damaged when it was uploaded`;
    return '';
  } catch { return ''; }
}

// Candidate files the matcher surfaced (enriched into raw_value at queue time).
function linkCandidates(r) {
  try {
    const raw = r.raw_value ? JSON.parse(r.raw_value) : null;
    const cs = (raw && raw.candidates) || [];
    return cs.filter((c) => c && c.id).map((c) => ({ id: String(c.id), address: c.address || '(no address)', loanNumber: c.loanNumber || null }));
  } catch { return []; }
}

// COMMON-SENSE annotation for a DOB value (owner-directed 2026-07-15): a review
// row must SAY what is wrong — "born in the future", "would be 3 years old" —
// not just that something needs review.
function dobNote(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return '';
  const today = new Date().toISOString().slice(0, 10);
  const y = Number(String(v).slice(0, 4));
  const nowY = new Date().getUTCFullYear();
  if (String(v) > today) return ' — not born yet (a birth date in the future)';
  if (y > nowY - 18) return ` — would make the borrower about ${Math.max(0, nowY - y)} years old (a minor)`;
  if (y < nowY - 120) return ` — would make the borrower over 120 years old`;
  return '';
}
const FIELD_LABELS = {
  date_of_birth: 'Date of birth', expected_closing: 'Expected closing',
  actual_closing: 'Actual closing', acquisition_date: 'Acquisition date',
  ssn: 'Social Security number', first_name: 'Borrower name', email: 'Borrower email',
  cell_phone: 'Borrower cell', current_address: 'Borrower home address', status: 'File status',
  file_link: 'File not syncing', ys_loan_number: 'YS loan number', push_job: 'ClickUp push failed',
  co_first_name: 'Co-borrower name', co_cell_phone: 'Co-borrower cell',
  sharepoint_folder: 'SharePoint filing', sharepoint_doc: 'SharePoint document sync',
  borrower_identity: 'Borrower identity — one profile, two people',
  co_borrower_identity: 'Co-borrower identity — one profile, two people',
  shared_email: 'Shared email — two borrowers',
  sitewire: 'Construction draws (Sitewire)',
  economics_frozen: 'Loan figures — frozen (term sheet sent / file locked)',
  status_ctc: 'Clear to Close — confirm the move',
  enum_unmappable: 'A value ClickUp has no option for',
  portal_edit_conflict: 'A change was made in both places — pick which to keep',
};
// Field keys the two-sided resolver can apply to BOTH systems today.
// 'file_link' / 'ys_loan_number' rows are deliberately NOT here: they are
// visibility rows — the fix happens in ClickUp (or the Control Center
// force-create) and the row closes itself on the next sync.
const RESOLVABLE = new Set(['date_of_birth', 'expected_closing', 'actual_closing', 'acquisition_date', 'ssn', 'status',
  'email', 'cell_phone', 'first_name', 'current_address']);
// Advisory rows that are DISMISS-ONLY: there is nothing to "approve" — the value
// was already rejected at entry and never saved, so the only action is to fix the
// value on the file and close this reminder. A duplicate loan number a staffer
// tried to type is one of these (it shows an Approve that would be a confusing
// no-op otherwise).
const DISMISS_ONLY = new Set(['loan_number_duplicate_entered']);
// Re-check result copy, keyed by the backend outcome `reason` (src/lib/sync-review-recheck.js).
// The engine now re-derives EVERY row type it can prove — value fields, the loan-number
// clash, co-borrower fields, file status, a failed ClickUp push, a SharePoint document,
// a shared-email pair, and a two-people-one-profile split — so each gets a plain line.
const RECHECK_CLOSED_MSG = {
  adopt: 'PILOT confirmed the correct value and cleared this review (applied to both systems).',
  file_removed: 'the file was removed from the portal, so this no longer applies. Cleared.',
  no_longer_duplicated: 'that loan number is no longer on any other file, so PILOT cleared this on its own.',
  mirrored: 'the document is now saved to SharePoint, so PILOT cleared this.',
  doc_gone: 'that document no longer exists, so there was nothing left to save. Cleared.',
  linked: 'the two profiles are now linked (a login on either sees both), so PILOT cleared this.',
  separate_emails: 'the two people now have their own separate emails, so PILOT cleared this.',
  split_done: 'this file now points at a separate profile for that person, so PILOT cleared this.',
  push_healthy: 'the update reached ClickUp — no failed pushes remain — so PILOT cleared this.',
  no_co_borrower: 'this file no longer has a co-borrower, so PILOT cleared this.',
};
const RECHECK_OPEN_MSG = {
  still_duplicated: 'that loan number is still on another file too, so this still needs you.',
  not_mirrored: 'the document still hasn’t saved to SharePoint, so this still needs you.',
  still_shared: 'the two profiles still share one email, so this still needs you.',
  still_merged: 'this file still points at the shared profile, so this still needs you.',
  push_pending: 'there are still failed or pending ClickUp updates for this file, so this still needs you.',
};
const RECHECK_UNSUPPORTED_MSG = {
  sitewire_use_actions: 'Re-checked — a construction-draw setup clears when you fix the cause and use this card’s Retry (or Acknowledge) button; Re-check can’t settle a draw setup on its own.',
  sharepoint_folder_use_actions: 'Re-checked — fix or merge the folders in SharePoint, then use this card’s Re-match; Re-check can’t settle a folder match on its own.',
};
// Which file SECTION each review is about — so the reviewer can jump straight to
// where the value is edited (owner-directed 2026-07-22: "a button to open the
// exact file section the review is about"). Borrower/co-borrower identity lives in
// Application details; dates/status/loan-number on the Overview; draws in Draws;
// SharePoint filing in Documents. A field not listed (a stuck-file row) shows no
// jump button — its fix isn't at a single section.
const FIELD_SECTION = {
  // Primary-borrower identity is shown + inline-edited in the Overview "Borrower"
  // panel (name / email / SSN / DOB), as are file status + the closing dates.
  first_name: 'sec-overview', email: 'sec-overview', ssn: 'sec-overview', date_of_birth: 'sec-overview',
  borrower_identity: 'sec-overview', shared_email: 'sec-overview',
  status: 'sec-overview', status_ctc: 'sec-overview', expected_closing: 'sec-overview', actual_closing: 'sec-overview',
  // Address, phone, the acquisition date, the loan number, and the whole
  // co-borrower live in Application details (address panel / Completeness /
  // co-borrower completeness / EditFileDetails).
  current_address: 'sec-application', cell_phone: 'sec-application',
  acquisition_date: 'sec-application', ys_loan_number: 'sec-application',
  co_first_name: 'sec-application', co_cell_phone: 'sec-application', co_borrower_identity: 'sec-application',
  sitewire: 'sec-draws',
  sharepoint_folder: 'sec-documents', sharepoint_doc: 'sec-documents',
};
const showVal = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? fmtDay(v) : (v == null || v === '' ? '—' : String(v)));

// Per-reason resolution actions for a Sitewire draw review (mirror of the server's map in
// src/sitewire/review-actions.js — kept in exact sync, enforced by test-sitewire-review-actions.js):
// an advisory note only "acknowledges" (never re-pushes — that looped); everything else, INCLUDING the
// "loan already in Sitewire" collision, offers "retry" (for a collision, a warned "delete it in Sitewire
// then push a fresh copy" — PILOT never adopts a pre-existing property) or dismiss.
const SW_ADVISORY = new Set(['sitewire_units_note', 'sitewire_type_unmapped', 'sitewire_reconcile_draw_error', 'sitewire_unknown_op']);
const SW_DUPE = 'sitewire_loan_already_in_sitewire';
// Two-sided DRIFT reviews (bidirectional Phase 2): a PILOT-owned value diverged from Sitewire.
const SW_DRIFT_RESTORABLE = new Set(['sitewire_budget_drift']);   // restore PILOT's value OR accept Sitewire's
const SW_DRIFT_ALERT = new Set(['sitewire_release_drift']);       // money already moved → acknowledge only
const swIsDrift = (rc) => SW_DRIFT_RESTORABLE.has(rc) || SW_DRIFT_ALERT.has(rc);
const swReasonClass = (reason) => String(reason || '').split(':')[0];
const usdMaybe = (v) => { const n = Number(v); return Number.isFinite(n) ? '$' + Math.round(n / 100).toLocaleString('en-US') : v; };

// Two-sided values: rows written since the upgrade carry clickup_value /
// portal_value explicitly; older rows derive them from direction (inbound:
// the proposal came FROM ClickUp, current is PILOT's; outbound the reverse).
function sides(r) {
  const cu = r.clickup_value != null ? r.clickup_value : (r.direction === 'inbound' ? r.proposed_value : r.current_value);
  const p = r.portal_value != null ? r.portal_value : (r.direction === 'inbound' ? r.current_value : r.proposed_value);
  return { cu, p };
}

export default function SyncReviews() {
  const { role, can } = useAuth();
  // relink_task (moving a ClickUp card between files) is admin-only — hide it
  // from processors/LOs/underwriters (the server also enforces this).
  const isAdmin = role === 'admin' || role === 'super_admin';
  const [status, setStatus] = useState('open');
  const [mine, setMine] = useState(false);   // "My changes" — reviews caused by MY PILOT edits (owner-directed 2026-08-11)
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [linkTarget, setLinkTarget] = useState({});   // rowId -> chosen candidate application id
  const [relinkInput, setRelinkInput] = useState({}); // rowId -> pasted ClickUp card link/id (relink_task)
  const [customVal, setCustomVal] = useState({});     // rowId -> reviewer-typed correct value
  const [selected, setSelected] = useState({});       // rowId -> checked (bulk actions)
  // A review row sits anywhere down a long queue, so its result rides the fixed
  // toast — the same reason rowErr already exists for failures (FlashToast.jsx).
  const { flash, clearFlash, toast } = useFlash();
  const [rowErr, setRowErr] = useState({});           // rowId -> error shown INLINE at the row (the top banner scrolls off-screen in a long list)
  const [recheckMsg, setRecheckMsg] = useState({});   // rowId -> "look again" result message

  async function bulk(action, winner) {
    const ids = Object.keys(selected).filter((id) => selected[id]);
    if (!ids.length) return;
    setBusyId('bulk'); setErr(''); clearFlash();
    try {
      const r = await api.post('/api/staff/sync-reviews/bulk', { ids, action, winner });
      const ok = (r.results || []).filter((x) => x.ok).length;
      const bad = (r.results || []).filter((x) => !x.ok);
      flash(`${ok} done${bad.length ? `, ${bad.length} failed (${bad.slice(0, 3).map((b) => b.error).join('; ')}${bad.length > 3 ? '…' : ''})` : ''}`);
      setSelected({});
      await load();
    } catch (e) { setErr(e.message || 'Bulk action failed'); }
    finally { setBusyId(null); }
  }
  // Last-request-wins: a slow response for a PREVIOUS status tab must never
  // overwrite the current tab's rows (vanishing-search bug class, 2026-07-16).
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setErr('');
    try {
      const rows = (await api.get(`/api/staff/sync-reviews?status=${status}${mine ? '&mine=1' : ''}`)).reviews || [];
      if (seq === loadSeq.current) setRows(rows);
    } catch (e) { if (seq === loadSeq.current) { setErr(e.message || 'Could not load the review queue'); setRows([]); } }
  }, [status, mine]);
  useEffect(() => { load(); }, [load]);

  async function sitewireAct(id, action) {
    setBusyId(id); setErr('');
    try { await api.post(`/api/sitewire/reviews/${id}/${action}`, {}); await load(); }
    catch (e) { setErr(e?.data?.error || e.message || 'That didn\'t work.'); }
    finally { setBusyId(null); }
  }

  // Say plainly what actually happened — a "push to ClickUp" that wrote nothing
  // must never read as success (owner-reported 2026-07-27: "I pushed and ClickUp
  // didn't update"). The server now returns a `pushed` outcome and a `note`.
  function actionResultMessage(verb, out) {
    if (!out) return '';
    if (out.pushed) {
      const o = out.pushed.outcome;
      if (o === 'written') return '✓ ClickUp was updated.';
      if (o === 'already_matched') return '✓ ClickUp already had that value — nothing needed changing.';
      if (o === 'failed') return '⚠ ClickUp didn’t accept the change — nothing was lost in PILOT; try again in a moment.';
      if (o === 'skipped') return '⚠ Nothing was sent to ClickUp (sync is off, or this file has no ClickUp card).';
    }
    if (verb === 'resolve-file' && out.note) return '✓ ' + out.note;
    return '';
  }
  async function act(id, verb, body) {
    setBusyId(id); setErr(''); clearFlash(); setRowErr((m) => ({ ...m, [id]: '' }));
    try {
      const out = await api.post(`/api/staff/sync-reviews/${id}/${verb}`, body || {});
      const msg = actionResultMessage(verb, out);
      if (msg) flash(msg);
      await load();
    }
    // Show the failure BOTH at the top and INLINE at the row: for a row deep in a
    // long queue the top banner is off-screen, so a failed action reads as
    // "nothing happened" (owner-reported for the accept-figures button).
    catch (e) { const m = (e && (e.data?.error || e.message)) || `Could not ${verb}`; setErr(m); setRowErr((mm) => ({ ...mm, [id]: m })); }
    finally { setBusyId(null); }
  }

  // "Look again" — ask the backend to RE-RUN the underlying comparison (re-read
  // both systems live) and clear this review by itself if the data was already
  // fixed by hand. It never blind-dismisses: a row that still genuinely differs
  // stays open. Owner-directed 2026-07-22.
  async function recheck(id) {
    setBusyId(id); setErr('');
    setRecheckMsg((m) => ({ ...m, [id]: '' }));
    try {
      const out = await api.post(`/api/staff/sync-reviews/${id}/recheck`, {});
      if (out.outcome === 'closed') {
        // Each proven-resolved reason gets its own plain line (never claim "already
        // fixed" when PILOT itself wrote the value); anything new falls back to the
        // generic "the two sides already match" line.
        flash('✓ Re-checked — ' + (RECHECK_CLOSED_MSG[out.reason]
          || 'the two sides already match, so PILOT cleared this review on its own.'));
        await load();
      } else if (out.outcome === 'still_open') {
        setRecheckMsg((m) => ({ ...m, [id]: 'Checked just now — ' + (RECHECK_OPEN_MSG[out.reason]
          || 'the two sides still don’t match, so this still needs you.') }));
        await load();
      } else if (out.outcome === 'error') {
        setRecheckMsg((m) => ({ ...m, [id]: 'Couldn’t reach ClickUp to re-check just now — try again in a moment.' }));
      } else {
        // 'unsupported' — a row PILOT can't prove from a re-read. Draw + folder-match
        // rows get a specific "use this card's actions" line; everything else points
        // to the card's own options rather than dead-ending.
        setRecheckMsg((m) => ({ ...m, [id]: RECHECK_UNSUPPORTED_MSG[out.reason]
          || 'Re-checked — this one isn’t a simple value match, so PILOT can’t auto-clear it here. Use the options on this card to resolve it.' }));
        await load();
      }
    } catch (e) { setErr(e.message || 'Could not re-check'); }
    finally { setBusyId(null); }
  }

  // relink_task: move an EXISTING ClickUp card onto this orphaned file. If the
  // card is currently on another file, the server returns needsConfirm + the
  // holder so we can confirm the move (admin-only; enforced server-side).
  async function relinkFromRow(id, confirmMove) {
    const taskInput = (relinkInput[id] || '').trim();
    if (!taskInput) { setErr('Paste the correct ClickUp card link or id first.'); return; }
    setBusyId(id); setErr('');
    try {
      await api.post(`/api/staff/sync-reviews/${id}/resolve-file`, { action: 'relink_task', targetTaskId: taskInput, confirmMove: !!confirmMove });
      await load();
    } catch (e) {
      if (e && e.data && e.data.needsConfirm) {
        const h = e.data.holder || {};
        const who = [h.borrower, h.address].filter(Boolean).join(' — ') || 'another file';
        if (await askConfirm(`That ClickUp card is currently linked to:\n\n${who}\n\nMove it to THIS file? The other file will be unlinked (nothing is deleted) and left for you to review.`)) {
          setBusyId(null);
          return relinkFromRow(id, true);
        }
        setErr('Move cancelled — nothing changed.');
      } else { setErr(e.message || 'Could not link the card'); }
    } finally { setBusyId(null); }
  }

  return (
    <div className="page">
      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <h2>Sync review</h2>
        <div className="spacer" />
        <select className="input" style={{ maxWidth: 180 }} value={status}
          onChange={(e) => { setStatus(e.target.value); setRecheckMsg({}); clearFlash(); }}
          aria-label="Filter by status">
          <option value="open">Needs review</option>
          <option value="resolved">Resolved</option>
          <option value="approved">Approved (legacy)</option>
          <option value="rejected">Dismissed</option>
        </select>
        <label className="row small" style={{ gap: 6, alignItems: 'center', marginLeft: 10, cursor: 'pointer', whiteSpace: 'nowrap' }}
          title="Show only the reviews caused by a change YOU made in PILOT">
          <input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); clearFlash(); }} />
          My changes
        </label>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        PILOT and ClickUp disagreed and the system could not prove which side is right, so nothing was written anywhere.
        Compare both sides and <strong>adopt the correct one — it is applied to BOTH systems</strong> (re-read live, fully audited).
        Dismiss keeps both sides as they are.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      {toast}
      {status === 'open' && Object.values(selected).some(Boolean) && (
        <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{Object.values(selected).filter(Boolean).length} selected</strong>
          <button className="btn primary btn-sm" disabled={busyId === 'bulk'}
            title="Apply ClickUp's current value to BOTH systems for every selected row that supports it"
            onClick={() => bulk('resolve', 'clickup')}>Adopt ClickUp for selected</button>
          <button className="btn primary btn-sm" disabled={busyId === 'bulk'}
            title="Apply PILOT's current value to BOTH systems for every selected row that supports it"
            onClick={() => bulk('resolve', 'portal')}>Adopt PILOT for selected</button>
          <button className="btn ghost btn-sm" disabled={busyId === 'bulk'}
            onClick={() => bulk('reject')}>Dismiss selected</button>
          <button className="btn ghost btn-sm" onClick={() => setSelected({})}>Clear</button>
        </div>
      )}
      {rows == null ? <p className="muted small">Loading…</p> : rows.length === 0 ? (
        <div className="panel"><p className="muted small" style={{ margin: 0 }}>
          {status === 'open' ? 'Nothing needs review — provable conflicts are auto-resolved, and no ambiguous ones are waiting.' : `No ${status} items.`}
        </p></div>
      ) : rows.map((r) => {
        const { cu, p } = sides(r);
        // Adopting a side only makes sense when the sides actually DIFFER —
        // for an equal-but-impossible pair the fix is correcting the value on
        // the file (the resolver would refuse to re-apply nonsense anyway).
        const sidesEqual = cu != null && p != null && String(cu) === String(p);
        const canResolve = RESOLVABLE.has(r.field_key) && !sidesEqual;
        const isDob = r.field_key === 'date_of_birth';
        const isSitewire = r.field_key === 'sitewire';
        // A frozen-economics hold lists EACH figure ClickUp changed on the locked
        // file, itemized (owner-directed 2026-07-27: "open up the box").
        const isEconFrozen = r.field_key === 'economics_frozen';
        const econChanges = isEconFrozen ? frozenChanges(r) : [];
        // A row raised by the weekly READ-ONLY Encompass enrichment pass (db/324).
        // There is no ClickUp task behind it and NOTHING is ever written back to
        // Encompass — the only question is what PILOT should hold, so the labels
        // and the buttons are different from a two-way ClickUp row.
        const isEncompass = r.source === 'encompass';
        const fileActions = (REASON_FILE_ACTIONS[r.reason] || null)?.filter((a) => !a.adminOnly || isAdmin) || null;
        const candidates = fileActions && fileActions.some((a) => a.needsTarget) ? linkCandidates(r) : [];
        return (
          <div className="panel" key={r.id} style={{ marginBottom: 10 }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              {status === 'open' && (
                <input type="checkbox" checked={!!selected[r.id]} aria-label="Select for bulk action"
                  onChange={(e) => setSelected((m) => ({ ...m, [r.id]: e.target.checked }))} />
              )}
              <strong>{FIELD_LABELS[r.field_key] || r.field_key}</strong>
              <span className={`pill ${r.direction === 'outbound' ? '' : 'done'}`}>{isSitewire ? 'PILOT → Sitewire' : isEncompass ? 'Encompass → PILOT (read-only)' : (r.direction === 'outbound' ? 'PILOT → ClickUp' : 'ClickUp → PILOT')}</span>
              <span className="muted small">{new Date(r.created_at).toLocaleString()}</span>
              <div className="spacer" />
              {status === 'open' && !isEncompass && (
                <button className="btn ghost btn-sm" disabled={busyId === r.id}
                  title="Look again — re-run the check in the background and clear this review if it was already fixed on either side (nothing is written unless the data proves it resolved)"
                  onClick={() => recheck(r.id)}>{busyId === r.id ? '…' : '↻ Re-check'}</button>
              )}
              {r.application_id && <Link className="btn ghost btn-sm" to={`/internal/app/${r.application_id}`}>Open file</Link>}
              {r.application_id && FIELD_SECTION[r.field_key]
                // The Draws section only renders for staff with manage_draws, so a
                // sitewire jump would silently no-op for anyone else — hide it there.
                && (r.field_key !== 'sitewire' || can('manage_draws')) && (
                <Link className="btn ghost btn-sm" to={`/internal/app/${r.application_id}#${FIELD_SECTION[r.field_key]}`}
                  title="Open the file at the exact section this review is about">Jump to the section</Link>
              )}
            </div>
            {status === 'open' && (recheckMsg[r.id] || r.last_checked_at) && (
              <p className="muted small" style={{ margin: '2px 0 0' }}>
                {recheckMsg[r.id] || `Last re-checked ${new Date(r.last_checked_at).toLocaleString()} — still open.`}
              </p>
            )}
            <div className="metrow"><span className="k">Who</span><span className="v">{r.borrower_name || '—'}{r.property ? ` — ${r.property}` : ''}</span></div>
            {r.changed_by && <div className="metrow"><span className="k">Changed by</span><span className="v">{r.changed_by}</span></div>}
            {isSitewire ? (
              (cu != null || p != null) && <div className="metrow"><span className="k">Details</span><span className="v">{p != null ? <>expected <strong>{showVal(p)}</strong></> : null}{p != null && cu != null ? ' · ' : ''}{cu != null ? <>found <strong>{showVal(cu)}</strong></> : null}</span></div>
            ) : isEconFrozen && econChanges.length ? (
              // Itemized: one row per figure ClickUp changed on this locked file.
              <div style={{ margin: '4px 0 2px' }}>
                <div className="metrow" style={{ fontWeight: 600, color: '#141B22' }}>
                  <span className="k">What changed in ClickUp</span>
                  <span className="v" style={{ color: '#4B585C', fontWeight: 400 }}>on file &amp; in ClickUp</span>
                </div>
                {econChanges.map((c) => (
                  <div className="metrow" key={c.field}>
                    <span className="k">{c.label}</span>
                    <span className="v" style={{ color: '#141B22' }}>
                      <strong>{c.from == null ? '—' : c.from}</strong>
                      <span style={{ color: '#4B585C' }}> (our file) → </span>
                      <strong>{c.to == null ? '—' : c.to}</strong>
                      <span style={{ color: '#4B585C' }}> (ClickUp)</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="metrow"><span className="k">{isEncompass ? 'In Encompass' : 'In ClickUp'}</span><span className="v"><strong>{showVal(cu)}</strong>{isDob ? <em className="muted small">{dobNote(cu)}</em> : null}</span></div>
                <div className="metrow"><span className="k">In PILOT</span><span className="v"><strong>{showVal(p)}</strong>{isDob ? <em className="muted small">{dobNote(p)}</em> : null}</span></div>
              </>
            )}
            {(r.field_key === 'sharepoint_doc' || r.field_key === 'sharepoint_folder') && spError(r) ? (
              <div className="metrow"><span className="k">Last error</span><span className="v"><em className="muted">{spError(r)}</em></span></div>
            ) : null}
            {r.reason === 'copied_loan_number_needs_assignment' && (() => {
              const o = otherLoanFile(r);
              return (o.otherId || o.number) ? (
                <div className="metrow"><span className="k">The clash</span><span className="v">
                  {o.number ? <>loan number <strong>{o.number}</strong> is on both this file and </> : <>the same loan number is on both this file and </>}
                  {o.otherId ? <Link className="btn ghost btn-sm" to={`/internal/app/${o.otherId}`}>the other file</Link> : <em className="muted">the other deal</em>}
                </span></div>
              ) : null;
            })()}
            {r.reason === 'ctc_confirm_needed' && (() => {
              const rd = ctcReadiness(r);
              if (!rd) return null;
              return (
                <div className="metrow"><span className="k">Is it ready?</span><span className="v">
                  {rd.ready ? (
                    <strong style={{ color: '#2F7F86' }}>Everything on this file is cleared — it is ready for Clear to Close.</strong>
                  ) : (
                    <>
                      <strong style={{ color: '#b04a3f' }}>Not ready — these were still outstanding when ClickUp moved it:</strong>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: '#3A4550' }}>
                        {rd.outstanding.map((t, i) => <li key={i} className="small">{t}</li>)}
                      </ul>
                      <em className="muted small">Finish these on the file, then Confirm. (Checked again when you confirm, so this list may already be out of date.)</em>
                    </>
                  )}
                </span></div>
              );
            })()}
            <p className="muted small" style={{ margin: '8px 0' }}>
              {isSitewire
                ? (SITEWIRE_REASON_COPY[String(r.reason || '').split(':')[0]] || r.reason)
                : (sidesEqual && r.reason === 'clickup_dob_differs_from_portal'
                  ? REASON_COPY.dob_same_but_impossible   /* legacy rows queued before the common-sense reasons */
                  // Some reasons carry a ':'-separated detail tail (the Encompass
                  // rows do) — fall back to the slug before the colon so they
                  // get real copy instead of the raw machine string.
                  : (REASON_COPY[r.reason] || REASON_COPY[String(r.reason || '').split(':')[0]] || r.reason))}
            </p>
            {isSitewire && String(r.reason || '').includes(':') && (
              <p className="muted small" style={{ margin: '0 0 8px', fontStyle: 'italic' }}>{String(r.reason).split(':').slice(1).join(':').trim()}</p>
            )}
            {status === 'open' && isSitewire && swReasonClass(r.reason) === SW_DUPE && (
              <div style={{ margin: '0 0 4px' }}>
                <p className="muted small" style={{ margin: '0 0 8px' }}>
                  PILOT manages the draw process only for properties it pushed itself, so it will <b>not</b> follow this
                  pre-existing Sitewire property{r.current_value ? ` (#${r.current_value})` : ''}. Keep them separate, or —
                  if you want PILOT to run the draws — delete that property in Sitewire first, then push a fresh copy.
                </p>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn btn-sm" disabled={busyId === r.id}
                    title="Recommended: leave the existing Sitewire property alone; PILOT will not manage this file’s draws."
                    onClick={() => sitewireAct(r.id, 'dismiss')}>Keep separate</button>
                  <button className="btn ghost btn-sm" disabled={busyId === r.id} style={{ color: 'var(--bad,#b04a3f)' }}
                    title="Only after you have DELETED the property in Sitewire — this pushes a brand-new copy PILOT will manage."
                    onClick={async () => { if (await askConfirm(`Push a fresh copy to Sitewire?\n\nOnly do this if you have ALREADY deleted the existing property${r.current_value ? ` (#${r.current_value})` : ''} in Sitewire. Otherwise you will create a DUPLICATE.\n\nPILOT will then create and manage a brand-new property for this file.`)) sitewireAct(r.id, 'retry'); }}>
                    {busyId === r.id ? '…' : 'I removed it in Sitewire — push a fresh copy'}</button>
                </div>
              </div>
            )}
            {status === 'open' && isSitewire && SW_ADVISORY.has(swReasonClass(r.reason)) && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="This is an informational note — nothing to re-push. Acknowledge to clear it."
                  onClick={() => sitewireAct(r.id, 'acknowledge')}>{busyId === r.id ? '…' : 'Acknowledge'}</button>
                <button className="btn btn-sm" disabled={busyId === r.id}
                  title="Close this without action" onClick={() => sitewireAct(r.id, 'dismiss')}>Dismiss</button>
              </div>
            )}
            {/* Two-sided DRIFT: show BOTH systems' values, then the right resolution. */}
            {isSitewire && swIsDrift(swReasonClass(r.reason)) && (r.portal_value != null || r.clickup_value != null) && (
              <div className="row" style={{ gap: 14, flexWrap: 'wrap', margin: '2px 0 8px' }}>
                <span className="small"><span className="muted">In PILOT: </span><b>{usdMaybe(r.portal_value)}</b></span>
                <span className="small"><span className="muted">In Sitewire: </span><b style={{ color: 'var(--bad,#b04a3f)' }}>{usdMaybe(r.clickup_value)}</b></span>
              </div>
            )}
            {status === 'open' && isSitewire && SW_DRIFT_RESTORABLE.has(swReasonClass(r.reason)) && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Re-push PILOT's budget to Sitewire, overwriting the change made there."
                  onClick={async () => { if (await askConfirm('Restore PILOT’s budget in Sitewire?\n\nThis re-pushes the budget PILOT set, overwriting the change made directly in Sitewire.')) sitewireAct(r.id, 'restore'); }}>{busyId === r.id ? '…' : 'Restore PILOT’s budget'}</button>
                <button className="btn btn-sm" disabled={busyId === r.id}
                  title="Keep Sitewire's value — close this without pushing. Handle any downstream (e.g. re-register) yourself."
                  onClick={() => sitewireAct(r.id, 'accept')}>Accept Sitewire’s value</button>
                <button className="btn btn-sm" disabled={busyId === r.id}
                  title="Close this without action" onClick={() => sitewireAct(r.id, 'dismiss')}>Dismiss</button>
              </div>
            )}
            {status === 'open' && isSitewire && SW_DRIFT_ALERT.has(swReasonClass(r.reason)) && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="The money already wired — this is an alert to reconcile it by hand. Acknowledge once you have."
                  onClick={() => sitewireAct(r.id, 'acknowledge')}>{busyId === r.id ? '…' : 'Acknowledge — I’ll reconcile the wire'}</button>
                <button className="btn btn-sm" disabled={busyId === r.id}
                  title="Close this without action" onClick={() => sitewireAct(r.id, 'dismiss')}>Dismiss</button>
              </div>
            )}
            {status === 'open' && isSitewire && swReasonClass(r.reason) !== SW_DUPE && !SW_ADVISORY.has(swReasonClass(r.reason)) && !swIsDrift(swReasonClass(r.reason)) && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Re-attempt the Sitewire push for this file (after fixing the cause above)"
                  onClick={() => sitewireAct(r.id, 'retry')}>{busyId === r.id ? '…' : 'Retry push'}</button>
                <button className="btn btn-sm" disabled={busyId === r.id}
                  title="Close this without action" onClick={() => sitewireAct(r.id, 'dismiss')}>Dismiss</button>
              </div>
            )}
            {status === 'open' && isEncompass && canResolve && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <p className="small" style={{ width: '100%', margin: '0 0 4px', color: '#3A4550' }}>
                  Encompass is read-only — whichever you pick is written to the PILOT profile (and pushed
                  on to the borrower’s ClickUp cards). Nothing is ever sent back to Encompass.
                </p>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Put the address Encompass has on the borrower's PILOT profile"
                  onClick={() => act(r.id, 'resolve', { winner: 'encompass' })}>{busyId === r.id ? '…' : 'Use the Encompass value'}</button>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Keep what PILOT already has — nothing is written anywhere"
                  onClick={() => act(r.id, 'resolve', { winner: 'portal' })}>{busyId === r.id ? '…' : 'Keep the PILOT value'}</button>
                <button className="btn ghost btn-sm" disabled={busyId === r.id}
                  title="Close this without writing anything anywhere"
                  onClick={() => act(r.id, 'reject')}>Dismiss</button>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input className="input" style={{ maxWidth: 220 }} type="text"
                    placeholder="Or type the correct address…" aria-label="Type the correct address"
                    value={customVal[r.id] || ''} disabled={busyId === r.id}
                    onChange={(e) => setCustomVal((m) => ({ ...m, [r.id]: e.target.value }))} />
                  <button className="btn ghost btn-sm" disabled={busyId === r.id || !(customVal[r.id] || '').trim()}
                    title="Put the typed address on the profile (validated, audited)"
                    onClick={() => act(r.id, 'resolve', { winner: 'custom', value: customVal[r.id] })}>Apply typed</button>
                </span>
              </div>
            )}
            {status === 'open' && !isSitewire && !isEncompass && canResolve && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Apply ClickUp's current value to BOTH systems (re-read live, audited)"
                  onClick={() => act(r.id, 'resolve', { winner: 'clickup' })}>{busyId === r.id ? '…' : 'Adopt ClickUp value → both'}</button>
                <button className="btn primary btn-sm" disabled={busyId === r.id}
                  title="Apply PILOT's current value to BOTH systems (re-read live, audited)"
                  onClick={() => act(r.id, 'resolve', { winner: 'portal' })}>{busyId === r.id ? '…' : 'Adopt PILOT value → both'}</button>
                <button className="btn ghost btn-sm" disabled={busyId === r.id}
                  title="Close this without writing anything anywhere"
                  onClick={() => act(r.id, 'reject')}>Dismiss</button>
                {/* THIRD OPTION: neither side is right — type the correct value;
                    it runs the same sanitizers and applies to BOTH systems. */}
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <input className="input" style={{ maxWidth: 180 }}
                    type={isDob || /closing|acquisition/.test(r.field_key) ? 'date' : 'text'}
                    placeholder="Or type the correct value…" aria-label="Type the correct value"
                    value={customVal[r.id] || ''} disabled={busyId === r.id}
                    onChange={(e) => setCustomVal((m) => ({ ...m, [r.id]: e.target.value }))} />
                  <button className="btn ghost btn-sm" disabled={busyId === r.id || !(customVal[r.id] || '').trim()}
                    title="Apply the typed value to BOTH systems (validated, audited)"
                    onClick={() => act(r.id, 'resolve', { winner: 'custom', value: customVal[r.id] })}>Apply typed → both</button>
                </span>
              </div>
            )}
            {status === 'open' && !isSitewire && !canResolve && fileActions && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {fileActions.map((a) => {
                  const needsPick = a.needsTarget;
                  const needsTask = a.needsTaskInput;
                  const picked = linkTarget[r.id] || '';
                  const typed = (relinkInput[r.id] || '').trim();
                  if (needsPick && !candidates.length) return null;   // no linkable candidates surfaced
                  return (
                    <React.Fragment key={a.action}>
                      {needsPick && (
                        <select className="input" style={{ maxWidth: 320 }} value={picked} aria-label="File to link this task to"
                          onChange={(e) => setLinkTarget((m) => ({ ...m, [r.id]: e.target.value }))}>
                          <option value="">Choose an existing file…</option>
                          {candidates.map((c) => (
                            <option key={c.id} value={c.id}>{c.address}{c.loanNumber ? ` — ${c.loanNumber}` : ''}</option>
                          ))}
                        </select>
                      )}
                      {needsTask && (
                        <input className="input" style={{ maxWidth: 280 }} placeholder="Correct ClickUp card link or id…"
                          value={relinkInput[r.id] || ''} aria-label="ClickUp card to link to this file"
                          onChange={(e) => setRelinkInput((m) => ({ ...m, [r.id]: e.target.value }))} />
                      )}
                      {/* An admin OVERRIDE is never the expected next step — it is the
                          escape hatch beside it, so it never renders as the primary button. */}
                      <button className={`btn btn-sm ${(a.adminOnly || a.action === 'accept_clickup_figures') ? '' : 'primary'}`} title={a.title}
                        disabled={busyId === r.id || (needsPick && !picked) || (needsTask && !typed)}
                        onClick={async () => {
                          if (needsTask) return relinkFromRow(r.id, false);
                          // Overriding the lock is consequential — confirm first.
                          if (a.action === 'accept_clickup_figures' && !(await askConfirm(
                            'Use ClickUp’s figures and update this LOCKED file?\n\n' +
                            'This overrides the lock and changes the loan figures on the file to match ClickUp. ' +
                            'The pricing / Scope-of-Work conditions will reopen because the registered numbers changed.\n\n' +
                            'Only do this for a file that was reconciled/closed in ClickUp and should now match.'))) return;
                          // Moving to Clear to Close locks the file + notifies the borrower — confirm first.
                          if (a.action === 'confirm_ctc' && !(await askConfirm(
                            'Move this file to Clear to Close in PILOT?\n\n' +
                            'This is a major milestone: it locks the file’s loan structure and notifies the borrower ' +
                            'that they’re clear to close. Only confirm if the file really is clear to close.'))) return;
                          // The override advances a file PILOT has judged UNFINISHED — the
                          // exact thing the gate exists to stop happening by accident. Name
                          // the consequence, and say plainly that it is recorded.
                          if (a.action === 'confirm_ctc_override' && !(await askConfirm(
                            'Move this file to Clear to Close even though it is NOT finished?\n\n' +
                            'PILOT checked and things are still outstanding on this file (listed above) — that can ' +
                            'include the signed term sheet package never having been executed.\n\n' +
                            'This locks the file’s loan structure and tells the borrower they’re clear to close. ' +
                            'Your name and everything that was still outstanding are recorded on the file.'))) return;
                          return act(r.id, 'resolve-file', { action: a.action, targetApplicationId: needsPick ? picked : undefined });
                        }}>
                        {busyId === r.id ? '…' : a.label}
                      </button>
                    </React.Fragment>
                  );
                })}
                <button className="btn ghost btn-sm" disabled={busyId === r.id}
                  title="Close this row without doing anything (it will not come back for this task)"
                  onClick={() => act(r.id, 'reject')}>Dismiss</button>
              </div>
            )}
            {status === 'open' && !isSitewire && !canResolve && !fileActions && (
              <div className="row" style={{ gap: 8 }}>
                {!DISMISS_ONLY.has(r.reason) && (
                  <button className="btn primary btn-sm" disabled={busyId === r.id || !r.proposed_value}
                    title={r.proposed_value ? 'Apply the proposed value (audited)' : 'No valid proposal to apply — dismiss or fix manually'}
                    onClick={() => act(r.id, 'approve')}>{busyId === r.id ? '…' : 'Approve'}</button>
                )}
                <button className="btn ghost btn-sm" disabled={busyId === r.id} onClick={() => act(r.id, 'reject')}>Dismiss</button>
              </div>
            )}
            {status !== 'open' && (
              <p className="muted small" style={{ margin: 0 }}>
                {/* The record of WHAT settled it (owner-directed): auto-closed
                    rows say so explicitly with the value that resolved them —
                    "fixed outside PILOT" still leaves a visible explanation. */}
                {r.auto_resolved ? '✓ Resolved automatically — no clicks needed. ' :
                  r.winner === 'custom' ? 'A reviewer typed the correct value; it was applied to both systems. ' :
                  r.winner ? `Adopted the ${r.winner === 'clickup' ? 'ClickUp' : r.winner === 'encompass' ? 'Encompass' : r.winner === 'custom' ? 'typed' : 'PILOT'} value${r.source === 'encompass' ? ' on the profile' : ' on both systems'}. ` : ''}
                {r.resolution_note ? `${r.resolution_note}` : ''}
              </p>
            )}
            {rowErr[r.id] && (
              <div role="alert" className="notice err" style={{ marginTop: 8, marginBottom: 0 }}>{rowErr[r.id]}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
