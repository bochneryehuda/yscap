import React, { useEffect, useRef, useState } from 'react';

/**
 * In-place document preview (PDF / image / text) — see a file without
 * downloading it. Downloads on this platform must send a Bearer token, so we
 * can't just point an <iframe src> at the API; instead we fetch the bytes with
 * the same authenticated loader used for downloads and render an object URL.
 *
 * Props:
 *   title    heading shown in the modal
 *   filename original filename (drives the type guess + download fallback)
 *   contentType optional MIME type
 *   load     () => Promise<{ blob, filename }>  — the authenticated fetcher
 *   onDownload optional () => void  — "Download instead" action
 *   onClose  () => void
 */
export default function DocPreview({ title, filename, contentType, load, onDownload, onClose }) {
  const [state, setState] = useState({ status: 'loading' });   // loading | ready | error
  const urlRef = useRef(null);

  useEffect(() => {
    let alive = true;
    load()
      .then(({ blob, filename: fn }) => {
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setState({ status: 'ready', url, type: blob.type || contentType || '', filename: fn || filename });
      })
      .catch((e) => { if (alive) setState({ status: 'error', error: e.message || 'Could not load the document.' }); });
    return () => {
      alive = false;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = (state.filename || filename || '').toLowerCase();
  const type = (state.type || contentType || '').toLowerCase();
  const isPdf = type.includes('pdf') || name.endsWith('.pdf');
  const isImg = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
  const isText = type.startsWith('text/') || type.includes('html') || /\.(txt|csv|html?|json)$/.test(name);
  const previewable = isPdf || isImg || isText;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal docpreview" style={{ maxWidth: 980, width: '96%', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '2px 2px 10px' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title || 'Document preview'}</h3>
            {(state.filename || filename) && <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.filename || filename}</div>}
          </div>
          <div className="row" style={{ gap: 8, flexShrink: 0 }}>
            {onDownload && <button className="btn ghost small" onClick={onDownload}>Download</button>}
            <button className="btn ghost small" onClick={onClose}>Close ✕</button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 320, background: 'var(--ink-2)', borderRadius: 10, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {state.status === 'loading' && <span className="muted">Loading preview…</span>}
          {state.status === 'error' && <span className="notice err" style={{ margin: 16 }}>{state.error}</span>}
          {state.status === 'ready' && previewable && (isImg
            ? <img src={state.url} alt={state.filename || 'document'} style={{ maxWidth: '100%', maxHeight: '78vh', objectFit: 'contain' }} />
            // SANDBOXED: a blob: URL made from a same-origin fetch is same-origin,
            // so an uploaded HTML file would otherwise run scripts with access to
            // the viewer's token/localStorage (stored XSS). `sandbox` with no
            // allow-scripts/allow-same-origin neutralizes that; the browser's PDF
            // viewer and static HTML/images still render fine.
            : <iframe title={state.filename || 'document'} src={state.url} sandbox=""
                style={{ width: '100%', height: '78vh', border: 0, background: '#fff' }} />
          )}
          {state.status === 'ready' && !previewable && (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <p className="muted">This file type can’t be previewed in the browser.</p>
              {onDownload && <button className="btn primary" onClick={onDownload}>Download to open it</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
