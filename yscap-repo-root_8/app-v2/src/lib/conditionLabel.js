// Client mirror of src/lib/conditions/label-sanity.js (server) — KEEP IN LOCK-STEP.
//
// Guards the "add a condition" box against a stray value (a property ZIP like
// "08759", a phone number, a one-key blip) being saved as a real condition — the
// 2026-07-22 root cause. Returns a reason string when the label clearly is NOT a
// condition, else null. The server enforces the same rule; this just lets the box
// show a one-click "add anyway?" confirm instead of a round-trip error.

const NUMERICISH = /^[\d\s().+\-\/#$,.]+$/;
const ZIP = /^\d{5}(-\d{4})?$/;

export function strayConditionReason(rawLabel) {
  const label = String(rawLabel == null ? '' : rawLabel).trim();
  if (!label) return null;
  const letters = (label.match(/[A-Za-z]/g) || []).length;
  if (letters === 0) {
    if (ZIP.test(label)) return 'looks_like_zip';
    if (NUMERICISH.test(label)) return 'looks_numeric';
    return 'no_words';
  }
  if (label.replace(/\s+/g, '').length < 3) return 'too_short';
  return null;
}

// Short confirm-dialog text for a flagged label.
export function strayConfirmText(reason, label) {
  const shown = label ? `“${String(label).trim()}”` : 'This';
  if (reason === 'looks_like_zip') return `${shown} looks like a ZIP code, not a condition. Add it as a condition anyway?`;
  if (reason === 'looks_numeric') return `${shown} looks like a number, not a condition. Add it as a condition anyway?`;
  if (reason === 'too_short') return `${shown} is very short for a condition. Add it anyway?`;
  return `${shown} doesn’t look like a condition. Add it anyway?`;
}
