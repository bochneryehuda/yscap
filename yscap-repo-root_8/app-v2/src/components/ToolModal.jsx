import React, { useCallback, useEffect, useRef, useState } from 'react';

/* Full-screen workspace that hosts a static tool (Scope of Work builder)
   connected to a loan-file condition. It reads as a PAGE of the portal, not a
   popup: an edge-to-edge sheet that slides up with a slim sticky header —
   no dark rim, no box-inside-a-box, safe-area aware on phones.

   The tool autosaves while open, and CLOSING SAVES TOO: both the back arrow
   and "Done" ask the tool to run its full save (editable HTML + Excel + PDF
   onto the condition) via a postMessage handshake before the sheet closes —
   so leaving never loses the exports. A timeout guarantees the user is never
   trapped. */
export default function ToolModal({ url, title, onClose }) {
  const frameRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const saveAndClose = useCallback(() => {
    if (saving) return;
    setSaveError(null);
    const win = frameRef.current && frameRef.current.contentWindow;
    if (!win) { onClose(); return; }
    setSaving(true);
    let finished = false;
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      onClose();
    };
    // The tool saves before it closes. If the save is REFUSED (e.g. the Scope of
    // Work total doesn't match the file's required rehab budget — a fatal, #75),
    // we do NOT close: the tool shows the reason inline and the user stays put to
    // fix it. Only a clean save (or a hard timeout) closes the sheet.
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === 'ys-tool-saved') finish();
      else if (e.data.type === 'ys-tool-save-error') {
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        setSaving(false);
        setSaveError(e.data.message || 'This couldn’t be saved — please review and try again.');
      }
    };
    window.addEventListener('message', onMsg);
    try { win.postMessage({ type: 'ys-tool-save-close' }, window.location.origin); }
    catch { finish(); return; }
    timer = setTimeout(finish, 30000);   // export generation can take a few seconds; never trap the user
  }, [saving, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') saveAndClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [saveAndClose]);

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
        <button className="btn primary toolsheet-done" disabled={saving} onClick={saveAndClose}>
          {saving ? 'Saving to your file…' : 'Done'}
        </button>
      </header>
      {saveError && (
        <div role="alert" style={{
          margin: '10px 16px 0', padding: '12px 14px', borderRadius: 10,
          border: '1px solid var(--danger)', background: 'var(--danger-soft)', color: 'var(--danger)',
          fontWeight: 600, lineHeight: 1.45,
        }}>
          <span style={{ marginRight: 8 }}>⛔</span>
          Not saved — {saveError}
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
        <div className="toolsheet-savewash" aria-hidden="true">
          <span className="toolframe-spinner" />
          Saving your work to the loan file…
        </div>
      )}
    </div>
  );
}
