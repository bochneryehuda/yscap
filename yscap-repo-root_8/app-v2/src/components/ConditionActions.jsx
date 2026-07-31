import React, { useEffect } from 'react';
import { nextStep, docNextStep, canComplete, canDeleteDoc } from '../lib/condition-actions.js';
import { canOverride, askOverride } from '../lib/condition-override.js';
import { CONDITION_STATUSES, conditionStatusLabel } from '../lib/conditions-vocab.js';

/* THE CONDITION ACTION BAR — one prominent next step, everything else behind
 * "More". Owner-directed 2026-07-27: "we don't need to remove features but we
 * need to find a way to make it more simplified, more user friendly."
 *
 * NOTHING IS REMOVED. Every action that was on the row is still on the row —
 * status, assignee, waive, override, send back, note — one click away instead of
 * competing with the one that matters. What the flat list cost was a hierarchy:
 * a processor scanning forty conditions had to read seven same-weight buttons on
 * each to find the one that moves it forward.
 *
 * Which step is primary is decided in lib/condition-actions.js — pure, tested
 * without a browser, and shared, so the two row shapes on this screen can never
 * disagree about what comes next. They had already drifted on wording ("Not
 * required" here, "Waive" there), which is the same class of bug as the inline
 * entry boxes that existed in one shape and not the other.
 *
 * "More" is a native <details>: no focus trap, no portal, no open/close state to
 * keep in React, keyboard-accessible for free, and the pattern this codebase
 * already uses for collapsible detail (AppraisalPanel's ApprSection). The one
 * thing it does not give you is closing on an outside click, which on a list of
 * forty rows matters — that is the single shared listener below, not a
 * per-row hand-rolled dropdown.
 *
 * Every text colour is an explicit dark hex — `var(--ink*)` is a LIGHT token in
 * this palette and would render invisible on the white card.
 */
/* A native <details> stays open until you click its own summary again, so on a
   list of forty conditions you would leave a trail of open menus behind you.
   ONE document-level listener closes any menu you have clicked away from — one
   listener for the whole page, installed once, rather than one per row. Kept
   here beside the markup it manages. `pointerdown` (not `click`) so the menu is
   already gone by the time a click lands on whatever is underneath. */
let menuCloserInstalled = false;
function useMenuAutoClose() {
  useEffect(() => {
    if (menuCloserInstalled || typeof document === 'undefined') return undefined;
    menuCloserInstalled = true;
    const onDown = (e) => {
      document.querySelectorAll('details.cond-more[open]').forEach((d) => {
        if (!d.contains(e.target)) d.open = false;
      });
    };
    document.addEventListener('pointerdown', onDown, true);
    // Deliberately never removed: it is a single passive listener for the whole
    // page, and unmounting one row must not take the behaviour away from the
    // other thirty-nine still on screen.
    return undefined;
  }, []);
}

/* Acting from inside the menu closes it — the action is done, and leaving it
   hanging open over the row you just changed reads as "did that work?". */
const closeMenu = (e) => {
  if (!e.target.closest('button')) return;      // a select or a label: stay open
  const d = e.currentTarget.closest('details.cond-more');
  if (d) d.open = false;
};

export default function ConditionActions({
  it, role, team, onPatch, size = 'small',
  // The borrower-facing rows always offer "send back"; an internal row only
  // does when the condition is something the borrower can see.
  canSendBack,
  // This condition's current documents — only used to say whether one is still
  // waiting to be accepted, never rendered here.
  docs,
  // Rendered inside the More menu, under a divider — for the one-off actions a
  // particular condition carries (waive an appraisal card, open a tool).
  extra,
}) {
  useMenuAutoClose();
  const completer = canComplete(role);
  const step = nextStep(it, { role, docs });
  const signed = !!it.signed_off_at;
  const cleared = signed || !!it.waived_at;
  const btn = size === 'small' ? ' small' : '';
  const sendBack = canSendBack === undefined ? it.audience !== 'staff' : canSendBack;

  const pushBack = () => {
    const reason = window.prompt(signed || it.status === 'satisfied'
      ? 'Reopen and send this back to the borrower — what needs to change? (they will see this)'
      : 'Send this back to the borrower — what needs to change? (they will see this)');
    if (reason == null || !reason.trim()) return;
    onPatch(it.id, { pushBack: true, issueReason: reason.trim() });
  };

  return (
    <div className="cond-act">
      <div className="cond-act-row">
        <button className={`btn ${step.tone === 'primary' ? 'primary' : 'ghost'}${btn}`}
          title={step.title} onClick={() => onPatch(it.id, step.patch)}>{step.label}</button>

        <details className="cond-more">
          <summary className={`btn ghost${btn} cond-more-btn`}
            title="Every other action on this condition">More ▾</summary>
          <div className="cond-more-menu" onClick={closeMenu}>

            {/* STATUS + ASSIGNEE. Both are already SHOWN on the row (the badge,
                and the "Assigned to …" line), so only the controls move here —
                no information is hidden. They were also the two widest controls
                and both truncated to "Not sta…" / "Unassig…" on the flat row. */}
            <label className="cond-more-field">
              <span>Status</span>
              <select className="input" value={it.status}
                onChange={(e) => onPatch(it.id, { status: e.target.value })}>
                {CONDITION_STATUSES
                  .filter(s => completer || s !== 'satisfied' || it.status === 'satisfied')
                  .map(s => <option key={s} value={s}>{conditionStatusLabel(s)}</option>)}
              </select>
            </label>
            {Array.isArray(team) && (
              <label className="cond-more-field">
                <span>Assigned to</span>
                <select className="input" value={it.assignee_staff_id || ''}
                  onChange={(e) => onPatch(it.id, { assigneeStaffId: e.target.value || null })}>
                  <option value="">Unassigned</option>
                  {team.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
                </select>
              </label>
            )}

            <div className="cond-more-sep" />

            {/* The step this viewer is NOT being shown as primary. A processor's
                primary is Sign off, so their Done still belongs here; a loan
                officer's primary is Done and they have no sign-off at all. */}
            {completer && !cleared && (
              it.reviewed_at
                ? <button className="btn ghost small" onClick={() => onPatch(it.id, { reviewed: false })}
                    title="Undo the loan-officer 'done' mark">Undo done</button>
                : <button className="btn ghost small" onClick={() => onPatch(it.id, { reviewed: true })}
                    title="Mark the loan-officer step done without signing off">Mark done</button>
            )}
            {completer && cleared && (
              <button className="btn ghost small"
                onClick={() => onPatch(it.id, it.waived_at ? { waived: false } : { signedOff: false })}>
                {it.waived_at ? 'Undo not required' : 'Undo sign-off'}
              </button>
            )}
            {completer && !cleared && it.is_required === false && (
              <button className="btn ghost small"
                title="This optional condition doesn't apply to this file — clear it without a document. Optional conditions only."
                onClick={() => onPatch(it.id, { waived: true })}>Not required</button>
            )}
            {sendBack && (
              <button className="btn ghost small"
                title="Send this condition back to the borrower with a reason (reopens it, clears any sign-off)"
                onClick={pushBack}>
                {signed || it.status === 'satisfied' ? 'Reopen / send back' : 'Send back to borrower'}
              </button>
            )}

            {extra ? <><div className="cond-more-sep" />{extra}</> : null}

            {/* Super admin only: clear this condition without what it asks for.
                Kept offered UP-FRONT (not only after a refusal) exactly as
                before — moving it into More does not put it behind a failure. */}
            {canOverride(role) && !cleared && (
              <>
                <div className="cond-more-sep" />
                <button className="btn ghost small" style={{ color: '#8A6D3B' }}
                  title="Super admin: clear this condition WITHOUT a document / without meeting its requirement. Your reason is saved on the file."
                  onClick={() => { const x = askOverride(it.label); if (x) onPatch(it.id, { signedOff: true, ...x }); }}>
                  Override — clear without meeting it
                </button>
              </>
            )}
          </div>
        </details>
      </div>

      {/* The half a button alone never had: what happens if you press it, or
          what to do first. This is the direct answer to "the accept button and
          the sign off button and the done button — it's too complicated." */}
      <div className="cond-act-hint">{step.hint}</div>
    </div>
  );
}

/* THE DOCUMENT ROW's actions — same shape, one line down. Accept is the only
   prominent one; preview, download, replace, accept-and-ask-for-more, reject and
   delete all keep working from More. */
export function DocActions({ doc, role, onReviewDoc, onDownloadDoc, onPreview, onReplace, dlBusy, fullscreen = false }) {
  useMenuAutoClose();
  const rs = doc.review_status || 'pending';
  const completer = canComplete(role);
  const step = docNextStep(doc, { role });
  // In full screen the Preview button sits right next to the document (owner-directed):
  // you're working through the file on a big screen and want to open a PDF in one
  // click, so it comes out of the "More" menu and the menu keeps only the rest
  // (download, replace, reject, delete…).
  return (
    <div className="cond-act-row">
      {step && (
        <button className="btn primary small" title={step.title}
          onClick={() => onReviewDoc(doc, 'accept')}>{step.label}</button>
      )}
      {fullscreen && onPreview && (
        <button className="btn ghost small" title="Preview without downloading"
          onClick={() => onPreview(doc)}>Preview</button>
      )}
      <details className="cond-more">
        <summary className="btn ghost small cond-more-btn" title="Everything else for this document">More ▾</summary>
        <div className="cond-more-menu" onClick={closeMenu}>
          {!fullscreen && onPreview && <button className="btn ghost small" title="Preview without downloading"
            onClick={() => onPreview(doc)}>Preview</button>}
          <button className="btn ghost small" disabled={dlBusy === doc.id}
            onClick={() => onDownloadDoc(doc)}>{dlBusy === doc.id ? '…' : 'Download'}</button>
          {onReplace && <button className="btn ghost small" title="Replace this document with a new version"
            onClick={onReplace}>Replace</button>}
          {completer && rs !== 'accepted' && (
            <button className="btn ghost small"
              title="Accept this document but keep the condition open and ask the borrower for one more"
              onClick={() => onReviewDoc(doc, 'accept_more')}>Accept, and ask for one more</button>
          )}
          {rs !== 'rejected' && <button className="btn ghost small"
            onClick={() => onReviewDoc(doc, 'reject')}>Reject</button>}
          {canDeleteDoc(role) && <button className="btn ghost small" style={{ color: '#A32A2A' }}
            title="Permanently delete — for a mistake upload (never synced to SharePoint)"
            onClick={() => onReviewDoc(doc, 'delete')}>Delete</button>}
        </div>
      </details>
    </div>
  );
}
