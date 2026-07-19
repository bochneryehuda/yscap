import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';

/* The PILOT document-underwriting desk. For each uploaded document PILOT reads it (best-in-class
   OCR), understands it (AI, constrained to the document type's fields), and checks it against the
   loan file — raising per-document findings (ID vs file, contract vs file, bank-account ownership,
   balance math) and cross-document findings (the seller / price / property address must AGREE
   across the contract, title, and appraisal). The underwriter resolves each finding: post a
   condition, request a document, fix the file, clear it, grant an exception, dismiss, or decline.
   Staff-only actions; nothing is ever written onto the loan file from a document read. */

const DOC_LABEL = {
  government_id: 'Government ID', purchase_contract: 'Purchase contract', title: 'Title report',
  bank_statement: 'Bank statement', appraisal: 'Appraisal', operating_agreement: 'Operating agreement',
};
const label = (t) => DOC_LABEL[t] || String(t || '').replace(/_/g, ' ');

const SEV = {
  fatal: { bg: 'var(--crit-bg,#F6E7E4)', fg: 'var(--crit,#B4483C)', label: 'Fatal' },
  warning: { bg: 'var(--amber-bg,#F6EEDD)', fg: 'var(--amber,#B7791F)', label: 'Warning' },
  info: { bg: 'rgba(47,127,134,.14)', fg: 'var(--teal-deep,#256168)', label: 'Info' },
};

function btn(primary, danger) {
  return {
    fontSize: 12.5, fontWeight: 600, borderRadius: 8, padding: '7px 13px', cursor: 'pointer',
    border: '1px solid ' + (primary ? 'var(--teal,#2F7F86)' : danger ? 'color-mix(in srgb,var(--crit,#B4483C) 35%,var(--line,#E7E1D3))' : 'var(--line,#E7E1D3)'),
    background: primary ? 'var(--teal,#2F7F86)' : 'transparent',
    color: primary ? '#fff' : danger ? 'var(--crit,#B4483C)' : 'var(--ink,#141B22)',
  };
}

// One finding card — its own action menu comes from the server (availableActions), so the UI
// never hard-codes which actions a finding allows. An action that needs a note or a corrected
// value reveals an inline input before it will submit.
function Finding({ appId, f, onChange, resolvable }) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // the action awaiting its note/value
  const [text, setText] = useState('');
  const s = SEV[f.severity] || SEV.info;
  const actions = Array.isArray(f.availableActions) ? f.availableActions : [];
  const docVal = f.doc_value != null ? f.doc_value : f.docValue;
  const fileVal = f.file_value != null ? f.file_value : f.fileValue;
  const howTo = f.how_to != null ? f.how_to : f.howTo;

  const submit = async (action, extra = {}) => {
    setBusy(true);
    try { await api.underwritingResolveFinding(appId, f.id, { action, ...extra }); onChange && onChange(); }
    catch (e) { alert(e.message || 'Could not resolve the finding'); }
    finally { setBusy(false); }
  };
  const click = (a) => {
    if (a.needs === 'note' || a.needs === 'value') { setPending(a); setText(''); return; }
    if (a.key === 'decline' && !window.confirm('Decline this file on this finding?')) return;
    submit(a.key);
  };
  const confirmPending = () => {
    if (!pending) return;
    const extra = pending.needs === 'value' ? { value: text } : { note: text };
    submit(pending.key, extra); setPending(null);
  };

  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderLeft: `4px solid ${s.fg}`, borderRadius: 12, background: 'var(--card,#fff)', padding: '14px 16px', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.06em', color: s.fg, background: s.bg, padding: '3px 8px', borderRadius: 6 }}>{s.label}</span>
        <strong style={{ fontSize: 14 }}>{f.title}</strong>
        {(f.source || f.doc_type) && <span style={{ fontSize: 11, color: 'var(--muted,#4B585C)' }}>· {label(f.source || f.doc_type)}</span>}
      </div>
      {(docVal != null || fileVal != null) && (
        <div style={{ display: 'flex', gap: 24, fontSize: 13, margin: '6px 0', flexWrap: 'wrap' }}>
          {docVal != null && <span>Document: <b style={{ color: 'var(--teal-deep,#256168)' }}>{String(docVal)}</b></span>}
          {fileVal != null && <span>Our file: <b>{String(fileVal)}</b></span>}
        </div>
      )}
      {howTo && <div style={{ fontSize: 12.5, color: 'var(--muted,#4B585C)', marginBottom: resolvable ? 10 : 0 }}>{howTo}</div>}
      {resolvable && actions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {actions.map((a) => (
            <button key={a.key} disabled={busy} onClick={() => click(a)} title={a.desc}
              style={btn(a.key === 'post_condition' || a.key === 'request_document', a.key === 'decline')}>{a.label}</button>
          ))}
        </div>
      )}
      {resolvable && pending && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmPending(); }}
            placeholder={pending.needs === 'value' ? 'corrected value' : `note — ${pending.label.toLowerCase()}`}
            style={{ flex: 1, minWidth: 180, padding: '7px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, fontSize: 14 }} />
          <button disabled={busy || !text.trim()} onClick={confirmPending} style={btn(true)}>{pending.label}</button>
          <button disabled={busy} onClick={() => setPending(null)} style={btn()}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// What PILOT read off one document — the extracted fields, shown compact + collapsible so the
// underwriter can confirm the read. Sensitive identifiers are already masked to last-4 server-side.
function ExtractionCard({ e }) {
  const [open, setOpen] = useState(false);
  const fields = e.fields && typeof e.fields === 'object' ? e.fields : {};
  const keys = Object.keys(fields).filter((k) => fields[k] != null && fields[k] !== '' && k !== 'readable' && k !== 'notes');
  const bad = e.status === 'error' || e.confidence === 'unreadable';
  return (
    <div style={{ border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, background: 'var(--card,#fff)', padding: '10px 14px', marginBottom: 8 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{label(e.doc_type)}</span>
        <span style={{ fontSize: 11, color: bad ? 'var(--amber,#B7791F)' : 'var(--muted,#4B585C)' }}>
          {bad ? 'could not be read — verify by hand' : `read by ${e.ocr_engine || 'AI'}${e.ai_model ? ' + ' + e.ai_model : ''}`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted,#4B585C)' }}>{open ? 'hide' : `${keys.length} fields`}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 10 }}>
          {keys.length === 0 && <span style={{ fontSize: 12, color: 'var(--muted,#4B585C)' }}>No fields were read.</span>}
          {keys.map((k) => (
            <div key={k} style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--muted,#4B585C)' }}>{k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}</div>
              <div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : String(fields[k])}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function UnderwritingPanel({ appId, docs = [], readOnly = false, onSummary }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState('');       // documentId to analyze
  const [pickType, setPickType] = useState(''); // docType to analyze it as
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const d = await api.underwritingGet(appId);
      setData(d);
      if (onSummary) onSummary(d && d.summary ? d.summary : null);
    } catch (e) { setErr(e.message || 'Could not load the underwriting review'); }
    finally { setLoading(false); }
  }, [appId, onSummary]);

  useEffect(() => { load(); }, [load]);

  const analyze = async () => {
    if (!pick || !pickType) return;
    setAnalyzing(true); setErr('');
    try { await api.underwritingAnalyze(appId, pick, { docType: pickType }); setPick(''); setPickType(''); await load(); }
    catch (e) { setErr(e.message || 'Could not analyze the document'); }
    finally { setAnalyzing(false); }
  };

  if (loading) return <p style={{ color: 'var(--muted,#4B585C)' }}>Loading the underwriting review…</p>;

  const sum = (data && data.summary) || { fatal: 0, warning: 0, info: 0, blocksCtc: false };
  const findings = (data && data.findings) || [];
  const cross = (data && data.crossDocument) || [];
  const exts = (data && data.extractions) || [];
  const docTypes = (data && data.docTypes) || [];
  const analyzers = (data && data.analyzers) || {};
  const currentDocs = (docs || []).filter((d) => d.is_current && d.id && d.source_type !== 'chat_attachment');
  const resolvable = !readOnly;

  return (
    <div>
      {err && <p style={{ color: 'var(--crit,#B4483C)', fontSize: 13 }}>{err}</p>}

      {/* analyzer availability — plain language if a key is missing */}
      {!readOnly && (!analyzers.reader || !analyzers.ai) && (
        <div style={{ background: 'var(--amber-bg,#F6EEDD)', color: 'var(--amber,#B7791F)', border: '1px solid var(--line,#E7E1D3)', borderRadius: 10, padding: '9px 14px', marginBottom: 14, fontSize: 12.5 }}>
          The automatic document reader is not fully switched on yet{analyzers.reader ? '' : ' (OCR reader)'}{analyzers.ai ? '' : ' (AI analyzer)'}.
          Add the Azure keys in the site settings to turn it on. Until then, documents can be reviewed by hand and findings still recorded.
        </div>
      )}

      {/* analyze a document — staff only */}
      {!readOnly && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={sel}>
            <option value="">Choose a document…</option>
            {currentDocs.map((d) => <option key={d.id} value={d.id}>{d.filename}</option>)}
          </select>
          <select value={pickType} onChange={(e) => setPickType(e.target.value)} style={sel}>
            <option value="">as document type…</option>
            {docTypes.map((t) => <option key={t} value={t}>{label(t)}</option>)}
          </select>
          <button disabled={analyzing || !pick || !pickType} onClick={analyze} style={btn(true)}>{analyzing ? 'Reading…' : 'Read & check'}</button>
        </div>
      )}

      {/* roll-up */}
      {(sum.fatal > 0 || sum.warning > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          {sum.fatal > 0 && <span style={{ fontWeight: 700, color: SEV.fatal.fg, background: SEV.fatal.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.fatal} fatal</span>}
          {sum.warning > 0 && <span style={{ fontWeight: 700, color: SEV.warning.fg, background: SEV.warning.bg, borderRadius: 999, padding: '4px 12px', fontSize: 12.5 }}>{sum.warning} warning</span>}
          {sum.blocksCtc && <span style={{ fontSize: 12.5, color: SEV.fatal.fg }}>Clear-to-close is blocked until every fatal is resolved.</span>}
        </div>
      )}

      {/* cross-document findings first — they're the marquee reconciliation across the file */}
      {cross.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>Across the file — documents that don’t agree</h4>
          {cross.map((f, i) => <Finding key={f.id || `x${i}`} appId={appId} f={f} onChange={load} resolvable={false} />)}
        </div>
      )}

      {/* per-document findings */}
      {findings.length > 0 ? (
        <div style={{ marginBottom: 22 }}>
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>Document findings</h4>
          {findings.map((f) => <Finding key={f.id} appId={appId} f={f} onChange={load} resolvable={resolvable} />)}
        </div>
      ) : (
        cross.length === 0 && <p style={{ color: 'var(--good,#3F7A5B)', fontSize: 13, marginBottom: 20 }}>✓ No open findings{exts.length ? ' — every analyzed document matches the file.' : ' yet — analyze a document to start the review.'}</p>
      )}

      {/* what was read */}
      {exts.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <h4 style={{ fontFamily: 'var(--serif,Georgia,serif)', margin: '0 0 12px' }}>What PILOT read</h4>
          {exts.map((e) => <ExtractionCard key={e.id} e={e} />)}
        </div>
      )}
    </div>
  );
}

const sel = { padding: '7px 10px', border: '1px solid var(--line,#E7E1D3)', borderRadius: 8, fontSize: 13.5, background: 'var(--card,#fff)', color: 'var(--ink,#141B22)', maxWidth: 280 };
