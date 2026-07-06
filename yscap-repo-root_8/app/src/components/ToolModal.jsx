import React, { useEffect } from 'react';

/* Full-screen overlay that hosts a static tool (Scope of Work builder) in an
   iframe, connected to a loan-file condition. The tool autosaves while open;
   closing simply returns to the file (the caller refreshes its data). */
export default function ToolModal({ url, title, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(6,10,12,.88)', display: 'flex', flexDirection: 'column', padding: '2vh 2vw' }}>
      <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
        <h3 style={{ color: '#f3efe6', margin: 0 }}>{title}</h3>
        <span className="muted small" style={{ marginLeft: 12 }}>Autosaves to your loan file — close anytime.</span>
        <div className="spacer" />
        <button className="btn primary" onClick={onClose}>Done — back to my file</button>
      </div>
      <iframe src={url} title={title}
        style={{ flex: 1, width: '100%', border: '1px solid rgba(127,169,176,.35)', borderRadius: 12, background: '#0b1014' }} />
    </div>
  );
}
