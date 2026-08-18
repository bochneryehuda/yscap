import { askConfirm, showMessage } from './dialog.js';
import { api } from './api.js';

// Remove a file from ONE workflow view (owner-directed 2026-08-11; narrowed
// 2026-08-18: the PIPELINE is not a removable view — remove/restore lives on
// the WORKFLOWS only, and the pipeline's off-ramp is Archive). This NEVER
// deletes the file — it only hides it from that desk; it stays on every other
// screen and can be restored. A DOUBLE warning is required before it fires.
const WHERE = {
  closing: 'the closing workflow',
  purchasing: 'the purchasing workflow',
};

/**
 * Double-confirm, then remove `appId` from `workflow`. Returns true on success
 * (the caller reloads its list). Shows PILOT's own dialog on failure.
 */
export async function confirmRemoveFromWorkflow(appId, workflow, name) {
  const where = WHERE[workflow] || 'this workflow';
  const who = name ? `“${name}”` : 'this file';
  // Warning 1 — what it does and, importantly, what it does NOT do.
  if (!(await askConfirm(
    `Remove ${who} from ${where}?\n\nThis does NOT delete the file — it only takes it off this view. The file and all its data stay everywhere else, and it can be restored.`,
    { title: 'Remove from this view', confirmLabel: 'Continue' }))) return false;
  // Warning 2 — the double check the owner asked for.
  if (!(await askConfirm(
    `Are you sure? ${who} will be removed from ${where}.\n\nThe file itself is kept — this only hides it here.`,
    { title: 'Please confirm', confirmLabel: 'Yes, remove it' }))) return false;
  try {
    await api.staffRemoveFromWorkflow(appId, workflow);
    return true;
  } catch (e) {
    await showMessage((e && e.message) || 'Could not remove it — please try again.', { title: "That didn't save" });
    return false;
  }
}

/**
 * Same double warning for a personal-workflow ITEM (Processing / Underwriting /
 * Exception… — the workflow_items queues, owner-directed 2026-08-18). Removes
 * the hand-off from the queue only; the file itself is untouched and the item
 * can be restored from the Removed view.
 */
export async function confirmRemoveWorkflowItem(itemId, queueLabel, name) {
  const where = queueLabel || 'this workflow';
  const who = name ? `“${name}”` : 'this file';
  if (!(await askConfirm(
    `Remove ${who} from ${where}?\n\nThis does NOT delete the file — it only takes this hand-off off the workflow. The file and all its data stay everywhere else, and it can be restored from the Removed view.`,
    { title: 'Remove from this workflow', confirmLabel: 'Continue' }))) return false;
  if (!(await askConfirm(
    `Are you sure? ${who} will be removed from ${where}.\n\nThe file itself is kept — this only takes it off this workflow.`,
    { title: 'Please confirm', confirmLabel: 'Yes, remove it' }))) return false;
  try {
    await api.workflowRemoveItem(itemId);
    return true;
  } catch (e) {
    await showMessage((e && e.message) || 'Could not remove it — please try again.', { title: "That didn't save" });
    return false;
  }
}
