import React, { useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import DocPreview from './DocPreview.jsx';

/* Conditions / document-requests tagged to a loan exception (owner-directed
   2026-07-22). A super-admin (or the requester) can attach a DOCUMENT REQUEST to
   the exception so the paperwork it depends on is tracked with it; the condition
   still lives on the file's normal checklist (the borrower sees it where they
   expect). This panel shows those tagged conditions + any documents uploaded
   against them (previewable in-app), and lets a reviewer request another.
   Rendered inside ExceptionCard, so it appears on both the super-admin box and the
   loan-officer "My exceptions" queue. Lazily loads on first expand. */

const STATUS_TONE = { satisfied: 'ok', received: 'warn', requested: 'warn', outstanding: '', issue: 'err', waived: '' };
function statusLabel(c) {
  if (c.signed_off_at) return 'Signed off';
  const s = String(c.status || 'outstanding').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ExceptionConditions({ exceptionId, appId }) {
  const [open, setOpen] = useState(false);
  const [conditions, setConditions] = useState(null);   // null = not loaded yet
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);          // { documentId, title }

  const load = () => api.exceptionConditions(exceptionId)
    .then((d) => setConditions(d.conditions || []))
    .catch((e) => setErr((e && e.message) || 'could not load the attached items'));

  useEffect(() => { if (open && conditions === null) load(); /* eslint-disable-next-line */ }, [open]);

  const request = async () => {
    const label = name.trim();
    if (!label) return;
    setBusy(true); setErr('');
    try {
      // A borrower-facing DOCUMENT request, tagged to this exception. The borrower
      // sees it on their checklist; here it's grouped under the exception.
      await api.staffAddCustomCondition(appId, {
        conditionType: 'document', label, borrowerLabel: label,
        audience: 'borrower', loanExceptionId: exceptionId,
      });
      setName(''); await load();
    } catch (e) { setErr((e && e.message) || 'could not add the request'); }
    finally { setBusy(false); }
  };

  const count = conditions === null ? null : conditions.length;

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--hair,#e7e2d6)', paddingTop: 8 }}>
      <button className="btn ghost small" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide documents & conditions' : (count == null ? 'Documents & conditions' : count ? `Documents & conditions (${count})` : 'Request a document')}
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {conditions === null && <div className="muted small">Loading…</div>}
          {conditions && conditions.length === 0 && (
            <div className="muted small">Nothing attached yet — request a document below and it will be tracked with this exception.</div>
          )}
          {conditions && conditions.map((c) => (
            <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--hair,#f0ece2)' }}>
              <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                {/* Staff-facing box → show the INTERNAL label (what the reviewer typed),
                    not the borrower-scrubbed one, so it never looks garbled to them. */}
                <span>{c.label || c.borrower_label}</span>
                <span className={`ts-badge ${STATUS_TONE[c.status] || ''}`}>{statusLabel(c)}</span>
                {c.item_kind === 'document' && <span className="muted small">document</span>}
              </div>
              {c.documents && c.documents.length > 0 ? (
                <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {c.documents.map((d) => (
                    <button key={d.id} type="button" className="btn ghost small"
                      title={`Preview ${d.filename}`}
                      onClick={() => setPreview({ documentId: d.id, title: d.filename })}>
                      📄 {d.filename}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="muted small" style={{ marginTop: 2 }}>No document uploaded yet.</div>
              )}
            </div>
          ))}

          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: 1, minWidth: 200 }}
              placeholder="Request a document (e.g. “Signed net-worth statement”)…"
              value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') request(); }} />
            <button className="btn primary small" disabled={busy || !name.trim()} onClick={request}>
              {busy ? 'Adding…' : 'Request document'}
            </button>
          </div>
          {err && <div role="alert" className="notice err" style={{ marginTop: 6 }}>{err}</div>}
        </div>
      )}

      {preview && (
        <DocPreview
          key={preview.documentId}
          title={preview.title}
          load={() => api.staffDownloadDoc(preview.documentId)}
          onDownload={async () => {
            try { const { blob, filename } = await api.staffDownloadDoc(preview.documentId); saveBlob(blob, filename); }
            catch (e) { setErr(e.message || 'could not download the document'); }
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
