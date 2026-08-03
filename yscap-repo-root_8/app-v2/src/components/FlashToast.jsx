import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A confirmation is a MESSAGE — it must never be a LAYOUT CHANGE.
 *
 * Every list screen used to confirm an action by rendering a `notice ok`
 * banner in the normal document flow at the TOP of the page. Acting on a row
 * far down the list (Send welcome / Send password reset on the Team screen —
 * owner-reported 2026-08-03: "the entire screen gives a blink and it moves
 * like it takes me somewhere else") therefore inserted ~58px above everything
 * the user was looking at: the row jumped DOWN the moment the confirmation
 * appeared and back UP when it auto-cleared four seconds later. The browser
 * does not compensate — measured in Chromium, scrollY is unchanged while the
 * clicked button moves 58px under the cursor, and `.notice`'s ys-rise
 * animation makes the shove read as a blink. On top of that the confirmation
 * for a row action rendered somewhere the user could not even see.
 *
 * A toast is OUT of the document flow, so it can never move what you are
 * reading, and it appears in the same place whatever you clicked and wherever
 * you are scrolled. Use it for every transient action result (success OR the
 * failure of a row action). A persistent banner is still the right shape for a
 * FORM's own error, which renders next to the form the user is already at.
 *
 * Dark text on the white canvas per the hard rule — `.notice.ok` / `.notice.err`
 * already resolve dark in the light theme; never an --ink* token here.
 */

const DEFAULT_OK_MS = 4000;
// A failure is worth reading twice, so it stays up longer than a confirmation.
const DEFAULT_ERR_MS = 9000;

export function FlashToast({ note, onDismiss }) {
  if (!note) return null;
  return (
    <div className="flash-dock" role="status" aria-live="polite">
      {/* keyed on seq so a second message re-runs the entrance animation
          instead of silently swapping text in place */}
      <div key={note.seq} className={`notice ${note.kind === 'err' ? 'err' : 'ok'}`}>
        <span className="flash-text">{note.text}</span>
        <button type="button" className="flash-x" onClick={onDismiss} aria-label="Dismiss">×</button>
      </div>
    </div>
  );
}

/**
 * Drop-in replacement for the old per-screen `flash()` helper.
 *
 *   const { flash, flashErr, toast } = useFlash();
 *   ...
 *   {toast}
 *
 * `flash`/`flashErr` take the same message string the old helper did, so a
 * screen converts by swapping the helper and rendering {toast} where the banner
 * used to be. Passing an empty message clears the toast (some callers used
 * setMsg('') that way).
 */
export function useFlash(okMs = DEFAULT_OK_MS) {
  const [note, setNote] = useState(null);
  const timer = useRef(null);
  const seq = useRef(0);

  // A screen can unmount while a toast is still counting down.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const show = useCallback((kind, text, holdMs) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const t = text == null ? '' : String(text);
    if (!t) { setNote(null); return; }
    seq.current += 1;
    setNote({ kind, text: t, seq: seq.current });
    const hold = Number.isFinite(holdMs) ? holdMs : (kind === 'err' ? DEFAULT_ERR_MS : okMs);
    if (hold > 0) timer.current = setTimeout(() => { timer.current = null; setNote(null); }, hold);
  }, [okMs]);

  const flash = useCallback((text, holdMs) => show('ok', text, holdMs), [show]);
  const flashErr = useCallback((text, holdMs) => show('err', text, holdMs), [show]);
  const clearFlash = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setNote(null);
  }, []);

  const toast = <FlashToast note={note} onDismiss={clearFlash} />;
  return { flash, flashErr, clearFlash, toast };
}

export default FlashToast;
