import { askConfirm, showMessage } from './dialog.js';
import { api } from './api.js';

// Remove a file from ONE workflow view (owner-directed 2026-08-11). This NEVER
// deletes the file — it only hides it from that desk; it stays on every other
// screen and can be restored. A DOUBLE warning is required before it fires.
const WHERE = {
  pipeline: 'the pipeline (row coordinator) view',
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
