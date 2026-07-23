import React, { useEffect, useRef, useState } from 'react';
import PdfViewer from './PdfViewer.jsx';
import { api } from '../lib/api.js';

/**
 * "This document vs. that document" — a side-by-side comparison of the sources
 * that disagree on a fact (owner-directed 2026-07-22, Findings deep features).
 * A tie-out discrepancy carries the specific conflicting `sources`
 * ({ label, value, documentId }); this opens the two that have a real document
 * behind them next to each other, each headed with WHAT it claims, so an
 * underwriter can see the contradiction with their own eyes instead of trusting
 * a summary string.
 *
 * Loads bytes the same authenticated way DocPreview does (downloads must send a
 * Bearer token, so an <iframe src> to the API can't work). PDF → PdfViewer with
 * the browser-native fallback; image/text render inline; anything else shows a
 * "download to open" note.
 *
 * Props:
 *   title    heading (e.g. "Purchase price — documents disagree")
 *   field    the fact key (for the sub-line)
 *   sources  [{ label, value, documentId }] — only those with a documentId are
 *            openable; the loan-file "source" (documentId null) is shown as a
 *            value chip, not a pane.
 *   onClose  () => void
 */

function usePaneDoc(documentId) {
  const [state, setState] = useState({ status: 'loading' });
  const urlRef = useRef(null);
  useEffect(() => {
    let alive = true;
    api.staffDownloadDoc(documentId)
      .then(async ({ blob, filename }) => {
        if (!alive) return;
        const name = (filename || '').toLowerCase();
        const type = (blob.type || '').toLowerCase();
        const isPdf = type.includes('pdf') || name.endsWith('.pdf');
        const isImg = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
        const isText = type.startsWith('text/') || /\.(txt|csv|json|md|log)$/.test(name);
        let kind = 'other', data = null, pdfUrl = null;
        if (isPdf) { kind = 'pdf'; data = await blob.arrayBuffer(); pdfUrl = URL.createObjectURL(blob); urlRef.current = pdfUrl; }
        else if (isImg) { kind = 'image'; data = URL.createObjectURL(blob); urlRef.current = data; }
        else if (isText) { kind = 'text'; data = await blob.text(); }
        if (!alive) { if (urlRef.current) URL.revokeObjectURL(urlRef.current); return; }
        setState({ status: 'ready', kind, data, pdfUrl, filename });
      })
      .catch((e) => { if (alive) setState({ status: 'error', error: (e && e.message) || 'Could not load the document.' }); });
    return () => { alive = false; if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; } };
  }, [documentId]);
  return [state, setState];
}

function Pane({ src }) {
  const [state, setState] = usePaneDoc(src.documentId);
  const pdfFailed = () => setState((s) => (s.pdfUrl ? { ...s, kind: 'pdf-native' } : { ...s, kind: 'other' }));
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--line,#E7E1D3)', background: 'var(--ink-2,#F4F2EC)' }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{src.label}</div>
        {src.value != null && <div className="small" style={{ color: 'var(--teal-deep,#256168)' }}>says: <b>{String(src.value)}</b></div>}
      </div>
      <div style={{ flex: 1, minHeight: 240, background: 'var(--ink-2,#F4F2EC)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {state.status === 'loading' && <span className="muted small">Loading…</span>}
        {state.status === 'error' && <span className="notice err" style={{ margin: 12 }}>{state.error}</span>}
        {state.status === 'ready' && state.kind === 'pdf' && <PdfViewer data={state.data} onError={pdfFailed} highlight={src.value != null ? String(src.value) : undefined} />}
        {state.status === 'ready' && state.kind === 'pdf-native' && (
          <iframe title={state.filename || 'document'} src={state.pdfUrl} style={{ width: '100%', height: '100%', border: 0, background: '#fff' }} />
        )}
        {state.status === 'ready' && state.kind === 'image' && (
          <img src={state.data} alt={state.filename || 'document'} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        )}
        {state.status === 'ready' && state.kind === 'text' && (
          <pre style={{ width: '100%', height: '100%', margin: 0, overflow: 'auto', padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#fff', color: '#111' }}>{state.data}</pre>
        )}
        {state.status === 'ready' && state.kind === 'other' && (
          <span className="muted small" style={{ padding: 16, textAlign: 'center' }}>This file type can’t be previewed here.</span>
        )}
      </div>
    </div>
  );
}

export default function DocCompare({ title, field, sources, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all = Array.isArray(sources) ? sources : [];
  const openable = all.filter((s) => s && s.documentId);   // only sources with a real PDF
  const noDoc = all.filter((s) => s && !s.documentId);      // the loan file / appraisal — shown as chips
  const panes = openable.slice(0, 2);                       // side by side compares two at a time

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ maxWidth: 1240, width: '97%', height: '93vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', padding: '2px 2px 10px' }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title || 'Compare documents'}</h3>
            <div className="muted small">
              {noDoc.length > 0
                ? <>Also on file — {noDoc.map((s) => `${s.label}: ${s.value}`).join(' · ')}</>
                : (field ? `Comparing what each document says for ${String(field).replace(/_/g, ' ')}.` : 'Comparing the conflicting documents.')}
            </div>
          </div>
          <button className="btn ghost small" onClick={onClose} style={{ flexShrink: 0 }}>Close ✕</button>
        </div>
        {panes.length >= 2 ? (
          <div className="doc-compare-panes" style={{ flex: 1, minHeight: 320, display: 'flex', gap: 10 }}>
            {panes.map((s, i) => <Pane key={s.documentId || i} src={s} />)}
          </div>
        ) : panes.length === 1 ? (
          <div style={{ flex: 1, minHeight: 320, display: 'flex' }}><Pane src={panes[0]} /></div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="muted" style={{ padding: 24, textAlign: 'center' }}>
              The conflicting values are on the loan file / appraisal, which don’t have a source PDF to open side by side.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
