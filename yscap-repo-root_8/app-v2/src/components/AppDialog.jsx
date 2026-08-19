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
  const [text, setText] = useState('');
  const okRef = useRef(null);
  const fieldRef = useRef(null);

  useEffect(() => subscribeDialog(setReq), []);

  const answer = useCallback((v) => resolveTop(v), []);

  // A prompt starts from its default value, re-seeded per request so a queued
  // second prompt never inherits what was typed into the first.
  useEffect(() => {
    if (req && req.kind === 'prompt') setText(req.defaultValue == null ? '' : String(req.defaultValue));
  }, [req && req.id]);

  // Focus the FIELD on a prompt (they are here to type) and the primary button
  // otherwise, so Enter answers and a screen reader lands on the action rather
  // than somewhere in the body text.
  useEffect(() => {
    if (!req) return;
    const el = req.kind === 'prompt' ? fieldRef.current : okRef.current;
    if (el) { el.focus(); if (req.kind === 'prompt' && el.select) el.select(); }
  }, [req && req.id]);

  // Escape dismisses — cancelling a question, acknowledging a message. Bound
  // while a dialog is up so it can never swallow Escape from anything else.
  // NOTE a cancelled PROMPT must answer null, never '' — the two mean different
  // things to the callers (see askPrompt's contract in lib/dialog.js).
  useEffect(() => {
    if (!req) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      answer(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [req, answer]);

  if (!req) return null;
  const isConfirm = req.kind === 'confirm';
  const isPrompt = req.kind === 'prompt';
  // THE TITLE NEVER CLAIMS FAILURE UNLESS THE CALLER SAID SO (owner-reported
  // 2026-08-19: saving the Arena roster showed "PILOT can't do that yet" over
  // the body "Saved." — the save had WORKED, and the headline told the owner it
  // had not). The old rule was backwards: every plain message defaulted to the
  // failure headline unless the caller remembered tone:'info', so every success
  // confirmation anyone ever writes is one forgotten option away from reading
  // as a failure. A neutral default cannot lie in either direction — a refusal's
  // own body text still says what was refused — and a caller that wants the
  // failure headline states it: tone:'error'.
  const isError = !isPrompt && !isConfirm && req.tone === 'error';
  const title = req.title
    || (isPrompt ? 'PILOT needs a note' : isConfirm ? 'Please confirm' : isError ? 'PILOT can’t do that yet' : 'PILOT');

  return (
    <div className="cv-modal-back" role="presentation"
      // A message must be READ, so the backdrop dismisses only a question —
      // clicking past an error is how people miss the reason something failed.
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (isConfirm) answer(false);
        // Clicking past a prompt is backing out — null, the cancel answer, so a
        // half-typed note is never filed as if it had been submitted.
        else if (isPrompt) answer(null);
      }}>
      <div className="cv-modal app-dialog" role={isConfirm || isPrompt ? 'dialog' : 'alertdialog'}
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
        {isPrompt && (
          req.multiline
            ? (
              <textarea ref={fieldRef} className="input app-dialog-field" rows={3}
                value={text} placeholder={req.placeholder || ''}
                onChange={(e) => setText(e.target.value)} />
            ) : (
              <input ref={fieldRef} type="text" className="input app-dialog-field"
                value={text} placeholder={req.placeholder || ''}
                onChange={(e) => setText(e.target.value)}
                // Enter submits a single-line answer, matching the native prompt.
                // A textarea keeps Enter for new lines, so it submits by button.
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answer(text); } }} />
            )
        )}
        <div className="app-dialog-actions">
          {(isConfirm || isPrompt) && (
            <button type="button" className="btn ghost" onClick={() => answer(isPrompt ? null : false)}>
              {req.cancelLabel || 'Cancel'}
            </button>
          )}
          <button type="button" ref={okRef}
            className={`btn ${req.danger ? '' : 'primary'}`}
            // A prompt answers with the TEXT — `''` if they submitted nothing,
            // which is a different answer from the `null` that Cancel gives.
            onClick={() => answer(isPrompt ? text : isConfirm ? true : undefined)}>
            {req.confirmLabel || (isPrompt ? 'Save' : isConfirm ? 'Yes, continue' : 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
