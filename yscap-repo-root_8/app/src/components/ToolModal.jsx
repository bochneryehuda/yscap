import React, { useCallback, useEffect, useRef, useState } from 'react';

/* Full-screen overlay that hosts a static tool (Scope of Work builder) in an
   iframe, connected to a loan-file condition. The tool autosaves while open,
   and CLOSING SAVES TOO: "Save & back to my file" asks the tool to run its
   full save (editable HTML + Excel + PDF onto the condition) via a
   postMessage handshake before the overlay closes — so leaving never loses
   the exports. A timeout guarantees the user is never trapped. */
export default function ToolModal({ url, title, onClose }) {
  const frameRef = useRef(null);
  const [saving, setSaving] = useState(false);

  const saveAndClose = useCallback(() => {
    if (saving) return;
    const win = frameRef.current && frameRef.current.contentWindow;
    if (!win) { onClose(); return; }
    setSaving(true);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('message', onMsg);
      onClose();
    };
    const onMsg = (e) => { if (e.data && e.data.type === 'ys-tool-saved') finish(); };
    window.addEventListener('message', onMsg);
    try { win.postMessage({ type: 'ys-tool-save-close' }, window.location.origin); }
    catch { finish(); return; }
    setTimeout(finish, 30000);   // export generation can take a few seconds; never trap the user
  }, [saving, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') saveAndClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [saveAndClose]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(6,10,12,.88)', display: 'flex', flexDirection: 'column', padding: '2vh 2vw' }}>
      <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
        <h3 style={{ color: '#f3efe6', margin: 0 }}>{title}</h3>
        <span className="muted small tm-hint" style={{ marginLeft: 12 }}>Autosaves as you work — closing also saves the exports.</span>
        <div className="spacer" />
        <button className="btn primary" disabled={saving} onClick={saveAndClose}>
          {saving ? 'Saving to your file…' : 'Done — save & back to my file'}
        </button>
      </div>
      <iframe ref={frameRef} src={url} title={title}
        style={{ flex: 1, width: '100%', border: '1px solid rgba(127,169,176,.35)', borderRadius: 12, background: '#0b1014' }} />
    </div>
  );
}
