import React, { useCallback, useEffect, useRef, useState } from 'react';

/* Full-screen workspace that hosts a static tool (Scope of Work builder)
   connected to a loan-file condition. It reads as a PAGE of the portal, not a
   popup: an edge-to-edge sheet that slides up with a slim sticky header —
   no dark rim, no box-inside-a-box, safe-area aware on phones.

   The tool autosaves while open, and CLOSING SAVES TOO: both the back arrow
   and "Done" ask the tool to run its full save (editable HTML + Excel + PDF
   onto the condition) via a postMessage handshake before the sheet closes —
   so leaving never loses the exports. A timeout guarantees the user is never
   trapped.

   ALWAYS A WAY OUT (owner-directed 2026-07-26). "Done"/back deliberately do NOT
   close when the save is refused — the user is meant to stay and fix it. But
   when the refusal is one they CAN'T fix from inside the tool (the file is
   frozen, a figure disagrees somewhere else, anything unexpected), that same
   rule turned into a trap: every way out re-ran the same save and bounced them
   back. So there is now a plain "Leave without saving" on the sheet at all
   times — one click, no handshake, straight back to the loan file — and it is
   surfaced prominently the moment a save is refused or a save takes more than a
   few seconds. Nothing is lost by using it: the tool autosaves the working
   draft to the condition as you type (a separate call that is never gated), so
   leaving this way only skips regenerating the Excel/PDF exports. */

// How long a save may run before we assume something is wrong and offer the way
// out inside the saving overlay (owner-directed: a few seconds, not 30).
const STALL_MS = 4000;

export default function ToolModal({ url, title, onClose }) {
  const frameRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [stalled, setStalled] = useState(false);
  // Cleanup for whatever save handshake is currently in flight, so a force-exit
  // can tear it down instead of leaving a listener/timer running after unmount.
  const inFlight = useRef(null);

  const clearInFlight = useCallback(() => {
    if (inFlight.current) { try { inFlight.current(); } catch (_) { /* already gone */ } }
    inFlight.current = null;
  }, []);

  /* The escape hatch: leave RIGHT NOW, no save, no handshake, no waiting on the
     tool to answer. Never disabled and never conditional — that is the whole
     point of it. */
  const forceExit = useCallback(() => {
    clearInFlight();
    setSaving(false);
    setStalled(false);
    onClose();
  }, [clearInFlight, onClose]);

  const saveAndClose = useCallback(() => {
    if (saving) return;
    setSaveError(null);
    setStalled(false);
    const win = frameRef.current && frameRef.current.contentWindow;
    if (!win) { onClose(); return; }
    setSaving(true);
    let finished = false;
    let timer = null;
    let stallTimer = null;
    const teardown = () => {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      window.removeEventListener('message', onMsg);
      inFlight.current = null;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      teardown();
      onClose();
    };
    // The tool saves before it closes. If the save is REFUSED (e.g. the Scope of
    // Work total doesn't match the file's required rehab budget — a fatal, #75),
    // we do NOT close: the tool shows the reason inline and the user stays put to
    // fix it. Only a clean save (or a hard timeout) closes the sheet — and the
    // "Leave without saving" button is always there for a refusal they can't fix.
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === 'ys-tool-saved') finish();
      else if (e.data.type === 'ys-tool-save-error') {
        finished = true;
        teardown();
        setSaving(false);
        setStalled(false);
        setSaveError(e.data.message || 'This couldn’t be saved — please review and try again.');
      }
    };
    window.addEventListener('message', onMsg);
    inFlight.current = () => { finished = true; teardown(); };
    try { win.postMessage({ type: 'ys-tool-save-close' }, window.location.origin); }
    catch { finish(); return; }
    // Surface the way out early; still close on the long backstop if the tool
    // never answers at all.
    stallTimer = setTimeout(() => setStalled(true), STALL_MS);
    timer = setTimeout(finish, 30000);   // export generation can take a few seconds; never trap the user
  }, [saving, onClose]);

  // Esc saves and closes, as it always has — EXCEPT once a save has been refused
  // or has stalled, where the user is trying to get out and pressing it again
  // would just re-run the save that already refused. Then Esc simply leaves.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (saveError || stalled) forceExit();
      else saveAndClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [saveAndClose, forceExit, saveError, stalled]);

  // Tear the handshake down if the sheet unmounts mid-save (a parent-driven
  // close, a route change) so no listener or timer outlives the component.
  useEffect(() => () => clearInFlight(), [clearInFlight]);

  // Scroll-lock the page behind the sheet, but REMEMBER the list position we
  // opened from and RESTORE it on exit (#108) — otherwise closing the tool
  // re-renders the file and the condition list jumps back to the top, losing the
  // borrower/officer's place. Mount-only so it captures the position once (before
  // overflow:hidden) and restores after the close re-render (rAF = next paint).
  useEffect(() => {
    const y = window.scrollY || window.pageYOffset || 0;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
      requestAnimationFrame(() => window.scrollTo(0, y));
    };
  }, []);

  // Theme + reveal on DOM-ready rather than the full `load` event — a stalled
  // third-party resource (fonts CDN) must not leave the tool hidden/unthemed.
  // White-first: the embed matches the portal's white coloring around it.
  useEffect(() => {
    let done = false;
    const tick = setInterval(() => {
      if (done) { clearInterval(tick); return; }
      try {
        const doc = frameRef.current && frameRef.current.contentWindow && frameRef.current.contentWindow.document;
        if (!doc || doc.readyState === 'loading' || !doc.body || (doc.location && doc.location.href === 'about:blank')) return;
        doc.documentElement.setAttribute('data-theme', 'light');
        if (!doc.getElementById('ys-portal-embed-style')) {
          const style = doc.createElement('style');
          style.id = 'ys-portal-embed-style';
          // Hide the tool's OWN marketing header (both header variants) + footer
          // so the embed looks standalone — no double header inside the portal.
          style.textContent = '.ys-theme-toggle,.topbar,.tool-bar,.suite-footer{display:none!important}html,body{background:#F4F0E7!important}';
          doc.head.appendChild(style);
        }
        done = true;
        clearInterval(tick);
        setLoaded(true);
      } catch (_) { done = true; clearInterval(tick); setLoaded(true); }   // cross-origin: show as-is
    }, 150);
    return () => clearInterval(tick);
  }, []);

  return (
    <div className="toolsheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="toolsheet-head">
        <button className="toolsheet-back" aria-label="Save and go back to your file"
          disabled={saving} onClick={saveAndClose}>←</button>
        <div className="toolsheet-titles">
          <strong>{title}</strong>
          <span className="muted small">Autosaves as you work — leaving saves to your file too.</span>
        </div>
        {/* The way out. NEVER disabled — not while saving, not while refused. */}
        <button className="btn ghost small toolsheet-exit" onClick={forceExit}
          aria-label="Leave without saving and go back to the loan file"
          title="Go straight back to the loan file. Your typing is already autosaved; only the Excel/PDF exports are skipped.">
          {/* The label shortens on a phone so three buttons still fit the header. */}
          <span className="toolsheet-exit-long">Leave without saving</span>
          <span className="toolsheet-exit-short">Leave</span>
        </button>
        <button className="btn primary toolsheet-done" disabled={saving} onClick={saveAndClose}>
          {saving ? 'Saving to your file…' : 'Done'}
        </button>
      </header>
      {saveError && (
        <div role="alert" style={{
          margin: '10px 16px 0', padding: '12px 14px', borderRadius: 10,
          border: '1px solid var(--danger)', background: 'var(--danger-soft)', color: '#8A1C13',
          fontWeight: 600, lineHeight: 1.45,
        }}>
          <div><span style={{ marginRight: 8 }}>⛔</span>Not saved — {saveError}</div>
          {/* If it's a refusal they can't fix from in here, this gets them out. */}
          <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn ghost small" onClick={forceExit}>Leave without saving →</button>
            <span style={{ color: '#3A4550', fontWeight: 400, fontSize: 13 }}>
              Your typing is already autosaved to the file — only the Excel/PDF exports are skipped.
            </span>
          </div>
        </div>
      )}
      <div className="toolsheet-body">
        {!loaded && (
          <div className="toolframe-loading" aria-live="polite">
            <span className="toolframe-spinner" aria-hidden="true" />
            Loading…
          </div>
        )}
        <iframe ref={frameRef} src={url} title={title} onLoad={() => setLoaded(true)}
          style={{ flex: 1, width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent', opacity: loaded ? 1 : 0, transition: 'opacity .25s ease' }} />
      </div>
      {saving && (
        // Not aria-hidden once it carries a real button — a screen-reader user
        // needs the way out as much as anyone.
        <div className="toolsheet-savewash" aria-live="polite">
          <span className="toolframe-spinner" aria-hidden="true" />
          Saving your work to the loan file…
          {stalled && (
            <>
              <span style={{ fontWeight: 400, fontSize: 13, maxWidth: 320, textAlign: 'center' }}>
                This is taking longer than it should.
              </span>
              <button className="btn ghost small" onClick={forceExit}>Leave without saving →</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
