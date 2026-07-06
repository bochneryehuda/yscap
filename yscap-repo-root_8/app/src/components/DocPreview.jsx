import React, { useEffect, useRef, useState } from 'react';
import PdfViewer from './PdfViewer.jsx';

/**
 * In-place document preview — see a file without downloading it. Downloads on
 * this platform must send a Bearer token, so we can't point an <iframe src> at
 * the API; we fetch the bytes with the same authenticated loader used for
 * downloads and render them locally by type:
 *
 *   PDF   → PdfViewer (PDF.js): renders each page to <canvas> with zoom + page
 *           nav. This is what fixed the "can't preview" bug — a sandboxed
 *           iframe cannot load a blob: URL (opaque origin), so the old iframe
 *           preview came up blank for every PDF.
 *   image → <img>
 *   text  → <pre> (plain text / CSV / JSON)
 *   html  → sandboxed <iframe srcDoc> — inlined content in an opaque origin
 *           with scripts disabled, so an uploaded HTML file can't run scripts
 *           against the viewer's token (stored XSS) yet still renders.
 *   other → a "download to open" card (Word/Excel/etc. can't render in-browser).
 *
 * Props:
 *   title/filename/contentType — display + type guess
 *   load       () => Promise<{ blob, filename }>  — the authenticated fetcher
 *   onDownload optional () => void
 *   onClose    () => void
 */
export default function DocPreview({ title, filename, contentType, load, onDownload, onClose }) {
  const [state, setState] = useState({ status: 'loading' });   // loading | ready | error
  const urlRef = useRef(null);

  useEffect(() => {
    let alive = true;
    load()
      .then(async ({ blob, filename: fn }) => {
        if (!alive) return;
        const name = (fn || filename || '').toLowerCase();
        const type = (blob.type || contentType || '').toLowerCase();
        const isPdf = type.includes('pdf') || name.endsWith('.pdf');
        const isImg = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
        const isHtml = type.includes('html') || /\.html?$/.test(name);
        const isText = !isHtml && (type.startsWith('text/') || /\.(txt|csv|json|md|log)$/.test(name));
        let kind = 'other', data = null;
        if (isPdf) { kind = 'pdf'; data = await blob.arrayBuffer(); }
        else if (isImg) { kind = 'image'; data = URL.createObjectURL(blob); urlRef.current = data; }
        else if (isHtml) { kind = 'html'; data = await blob.text(); }
        else if (isText) { kind = 'text'; data = await blob.text(); }
        if (!alive) { if (urlRef.current) URL.revokeObjectURL(urlRef.current); return; }
        setState({ status: 'ready', kind, data, filename: fn || filename });
      })
      .catch((e) => { if (alive) setState({ status: 'error', error: e.message || 'Could not load the document.' }); });
    return () => {
      alive = false;
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A PDF that pdfjs can't parse degrades to the download card.
  const pdfFailed = () => setState(s => ({ ...s, kind: 'other' }));
  const previewable = state.kind && state.kind !== 'other';

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal docpreview" style={{ maxWidth: 1040, width: '96%', height: '92vh', display: 'flex', flexDirection: 'column' }}
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
          {state.status === 'ready' && state.kind === 'pdf' && <PdfViewer data={state.data} onError={pdfFailed} />}
          {state.status === 'ready' && state.kind === 'image' && (
            <img src={state.data} alt={state.filename || 'document'} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          )}
          {state.status === 'ready' && state.kind === 'html' && (
            <iframe title={state.filename || 'document'} srcDoc={state.data} sandbox=""
              style={{ width: '100%', height: '100%', border: 0, background: '#fff' }} />
          )}
          {state.status === 'ready' && state.kind === 'text' && (
            <pre style={{ width: '100%', height: '100%', margin: 0, overflow: 'auto', padding: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', color: '#111' }}>{state.data}</pre>
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
