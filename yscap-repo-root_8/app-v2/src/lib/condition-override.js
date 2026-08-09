/* SUPER-ADMIN CONDITION OVERRIDE — the client half, in one place
   (owner-directed 2026-07-27).

   "If we're unable to clear it, the admin should be able to overwrite and clear
    the condition without a document attached to it or without fulfilling the
    requirement of that condition. Only super admin."

   Every screen that can complete a condition — the file's conditions list, the
   borrower-facing conditions block, the personal task queue — asks for an
   override through THESE helpers, so the wording of the warning, the wording of
   the reason prompt, and the way an override is displayed can never drift apart
   between them. The server (src/lib/conditions/admin-override.js) is the
   authority on who may do it; everything here is presentation.

   Pure — no React, no api client, so it can be reasoned about (and reused) on
   its own. */

import { askConfirm } from './dialog.js';

/* UI hint only: hide a button the server would refuse. Never a control — the
   server re-checks the role on every request. */
export const canOverride = (role) => role === 'super_admin';

/* Does this PATCH body complete a condition? Mirrors isCompletionAction() on the
   server, so "was this a completion that got refused?" has one answer. */
export const isCompletion = (body) =>
  !!body && (body.signedOff === true || body.waived === true || body.status === 'satisfied');

/* The override ask: confirm what is about to happen (carrying the gate's own
   explanation when we have it), then require the reason the server requires.
   Returns the extra PATCH fields to merge, or null if the super admin backs out
   at either step.

   ASYNC because the confirm is PILOT's own dialog rather than the browser's
   (which stamps the hosting provider's hostname on the box). Every call site
   MUST await it: without the await the caller receives a Promise, which is
   truthy, and would clear the condition on a click the super admin never
   confirmed. `window.prompt` has no branded replacement yet and is unchanged. */
export async function askOverride(label, { blocked } = {}) {
  const what = label ? `“${String(label).slice(0, 90)}”` : 'this condition';
  const why = blocked ? `\n\nWhat it is still missing:\n${blocked}` : '';
  if (!(await askConfirm(
    `Clear ${what} WITHOUT what it asks for?${why}\n\n` +
    'Only a super admin can do this. The condition is marked complete for the whole file — ' +
    'and your name, the time and your reason are saved on it permanently.',
    { title: 'Clear without what it asks for?', confirmLabel: 'Continue' }))) return null;
  const reason = window.prompt(
    'Why is this condition being cleared without what it asks for? ' +
    '(required — saved on the file and visible to the team)');
  if (reason == null || !reason.trim()) return null;
  return { adminOverride: true, overrideReason: reason.trim() };
}

/* What a row SAYS about an override it carries. One sentence, so a condition
   cleared without what it asks for is never silently indistinguishable from one
   that was actually satisfied. */
export function overrideLine(it) {
  if (!it || !it.override_at) return null;
  const who = it.override_by_name || 'a super admin';
  const when = new Date(it.override_at).toLocaleDateString();
  return `Cleared by super-admin override — ${who} · ${when}` +
    `${it.override_reason ? ` · ${it.override_reason}` : ''}` +
    `${it.override_blocked_reason ? ` (was missing: ${it.override_blocked_reason})` : ''}`;
}
