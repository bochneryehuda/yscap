import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api.js';

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.street, a.city, a.state].filter(Boolean).join(', ') || '—');
const FLOW = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded'];
const LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded' };

// Borrower-facing tools that satisfy a checklist task. The vanilla tools live in
// the static bundle at /tools/… — we launch them, not rebuild them.
const TOOLS = {
  rehab_budget: { name: 'Rehab Budget', url: '/tools/rehab-budget.html', blurb: 'Build your construction budget and Scope of Work, then export it.' },
  track_record: { name: 'Track Record', url: '/tools/track-record.html', blurb: 'Enter your prior deals (REO / experience): LLC, address, price, dates.' },
};
const isDone = (s) => s === 'received' || s === 'satisfied' || s === 'done';

export default function Application() {
  const { id } = useParams();
  const [app, setApp] = useState(null);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const fileRef = useRef(null);
  const [target, setTarget] = useState(null);

  const load = () => Promise.all([api.application(id), api.checklist(id)])
    .then(([a, c]) => { setApp(a); setItems(c || []); }).catch(e => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setMsg('Uploading…');
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
      });
      await api.uploadDoc({
        applicationId: id, checklistItemId: target || undefined,
        filename: file.name, contentType: file.type, size: file.size, dataUrl,
      });
      setMsg('Uploaded ✓'); setTarget(null); await load();
      setTimeout(() => setMsg(''), 2500);
    } catch (e2) { setMsg(''); setErr(e2.message || 'Upload failed'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }
  const pick = (itemId) => { setTarget(itemId || null); fileRef.current && fileRef.current.click(); };

  async function markToolDone(it) {
    setMsg('Saving…');
    try {
      await api.completeTool(id, it.id, { tool: it.tool_key, completedAt: new Date().toISOString() });
      setMsg('Marked complete ✓ — your coordinator will review it.');
      await load(); setTimeout(() => setMsg(''), 3000);
    } catch (e) { setMsg(''); setErr(e.message || 'Could not save'); }
  }

  if (err) return <div className="notice err">{err}</div>;
  if (!app) return <div className="panel muted">Loading…</div>;
  const idx = Math.max(0, FLOW.indexOf(app.status));

  const toolTasks = items.filter(it => it.tool_key && TOOLS[it.tool_key]);
  const docs = items.filter(it => !(it.tool_key && TOOLS[it.tool_key]));

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <Link to="/dashboard" className="btn link">← All loans</Link>
        <div className="spacer" />
        <span className={`pill ${app.status}`}>{LABEL[app.status] || app.status}</span>
      </div>
      <h1 style={{ marginBottom: 4 }}>{addrLine(app.property_address)}</h1>
      <p className="muted small" style={{ marginBottom: 20 }}>{app.ys_loan_number || 'Loan # pending'} · {app.program || '—'} · {app.loan_type || '—'}</p>

      {msg && <div className="notice ok">{msg}</div>}

      <div className="grid cols-2">
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Status</h3>
          <ul className="timeline">
            {FLOW.map((s, i) => (
              <li key={s} className={i <= idx ? 'on' : ''}>{LABEL[s]}</li>
            ))}
          </ul>
        </div>
        <div className="panel">
          <h3 style={{ marginBottom: 12 }}>Loan snapshot</h3>
          <div className="metrow"><span className="k">Officer</span><span className="v">{app.loan_officer_name || 'Lead Capture'}</span></div>
          <div className="metrow"><span className="k">Purchase price</span><span className="v">{money(app.purchase_price)}</span></div>
          <div className="metrow"><span className="k">As-is value</span><span className="v">{money(app.as_is_value)}</span></div>
          <div className="metrow"><span className="k">ARV</span><span className="v">{money(app.arv)}</span></div>
          <div className="metrow"><span className="k">Rehab budget</span><span className="v">{money(app.rehab_budget)}</span></div>
          <div className="metrow"><span className="k">Loan amount</span><span className="v">{money(app.loan_amount)}</span></div>
        </div>
      </div>

      {toolTasks.length > 0 && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 4 }}>Your tasks to complete</h3>
          <p className="muted small" style={{ marginBottom: 12 }}>
            These are part of your file. Open each tool, complete and export it, then mark it done —
            your coordinator verifies and signs off.
          </p>
          {toolTasks.map(it => {
            const t = TOOLS[it.tool_key]; const done = isDone(it.status) || it.tool_submitted;
            return (
              <div className="checkitem" key={it.id} style={{ alignItems: 'flex-start' }}>
                <span className={`dot ${done ? 'done' : 'outstanding'}`} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{it.label}</div>
                  <div className="muted small">{t.blurb}{it.hint ? ` · ${it.hint}` : ''}</div>
                  <div className="row" style={{ gap: 8, marginTop: 8 }}>
                    <a className="btn" href={t.url} target="_blank" rel="noopener noreferrer">Open {t.name} ↗</a>
                    {!done && <button className="btn ghost" onClick={() => markToolDone(it)}>Mark complete</button>}
                    {!done && <button className="btn link" onClick={() => pick(it.id)}>Attach export</button>}
                  </div>
                </div>
                <span className="muted small" style={{ textTransform: 'capitalize' }}>
                  {done ? 'Submitted' : (it.status || 'to do')}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="panel" style={{ marginTop: 18 }}>
        <div className="row" style={{ marginBottom: 6 }}>
          <h3>Documents &amp; conditions</h3>
          <div className="spacer" />
          <button className="btn ghost" onClick={() => pick(null)}>Upload a document</button>
        </div>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={onFile} />
        {docs.length === 0
          ? <p className="muted small">No items requested yet. Your coordinator will post your checklist here.</p>
          : docs.map(it => (
            <div className="checkitem" key={it.id}>
              <span className={`dot ${isDone(it.status) ? 'done' : 'outstanding'}`} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{it.label}</div>
                <div className="muted small">{it.item_kind}{it.hint ? ` · ${it.hint}` : ''}{it.notes ? ` · ${it.notes}` : ''}</div>
              </div>
              <span className="muted small" style={{ textTransform: 'capitalize' }}>{it.status || 'outstanding'}</span>
              <button className="btn link" onClick={() => pick(it.id)}>Upload</button>
            </div>
          ))}
      </div>
    </>
  );
}
