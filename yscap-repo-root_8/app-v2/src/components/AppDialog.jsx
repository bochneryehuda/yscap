import React, { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeDialog, resolveTop } from '../lib/dialog.js';

/**
 * The one message box PILOT draws itself (see lib/dialog.js for WHY — the
 * browser's native dialog is titled with the origin hostname, so our own plain
 * English refusals were arriving stamped "yscap.onrender.com says").
 *
 * Mounted ONCE per app shell. It reuses `.cv-modal-back` / `.cv-modal`, so it
 * inherits the solid card surface and the phone bottom-sheet behaviour every
 * other modal here already has, and it cannot render transparent.
 *
 * Text colours are explicit darks per the HARD RULE — never an `--ink*` token,
 * which is a LIGHT paper colour in this palette and would render white on white.
 */
export default function AppDialogHost() {
  const [req, setReq] = useState(null);
  const okRef = useRef(null);

  useEffect(() => subscribeDialog(setReq), []);

  const answer = useCallback((v) => resolveTop(v), []);

  // Focus the primary button so Enter answers and a screen reader lands on the
  // action rather than somewhere in the body text.
  useEffect(() => { if (req && okRef.current) okRef.current.focus(); }, [req && req.id]);

  // Escape dismisses — cancelling a question, acknowledging a message. Bound
  // while a dialog is up so it can never swallow Escape from anything else.
  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      answer(req.kind === 'confirm' ? false : undefined);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req, answer]);

  if (!req) return null;
  const isConfirm = req.kind === 'confirm';
  const isError = req.tone !== 'info';
  const title = req.title || (isConfirm ? 'Please confirm' : isError ? 'PILOT can’t do that yet' : 'PILOT');

  return (
    <div className="cv-modal-back" role="presentation"
      // A message must be READ, so the backdrop dismisses only a question —
      // clicking past an error is how people miss the reason something failed.
      onMouseDown={(e) => { if (e.target === e.currentTarget && isConfirm) answer(false); }}>
      <div className="cv-modal app-dialog" role={isConfirm ? 'dialog' : 'alertdialog'}
        aria-modal="true" aria-labelledby={`dlg-t-${req.id}`} aria-describedby={`dlg-b-${req.id}`}>
        <div className="app-dialog-head">
          <span className={`app-dialog-mark ${isError && !isConfirm ? 'bad' : ''}`} aria-hidden="true" />
          <div>
            <p className="app-dialog-kicker">PILOT</p>
            <h3 id={`dlg-t-${req.id}`} className="app-dialog-title">{title}</h3>
          </div>
        </div>
        {/* pre-wrap: these messages are written with real line breaks (the
            sign-off refusals are two paragraphs) and must keep them. */}
        <p id={`dlg-b-${req.id}`} className="app-dialog-body">{req.message}</p>
        <div className="app-dialog-actions">
          {isConfirm && (
            <button type="button" className="btn ghost" onClick={() => answer(false)}>
              {req.cancelLabel || 'Cancel'}
            </button>
          )}
          <button type="button" ref={okRef}
            className={`btn ${req.danger ? '' : 'primary'}`}
            onClick={() => answer(isConfirm ? true : undefined)}>
            {req.confirmLabel || (isConfirm ? 'Yes, continue' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
