import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';

/**
 * AMC appraisal ordering (AppraisalScope / CoreLogic Digital Gateway) — the staff desk
 * for the "Order an appraisal" section. Order directly from the AMC with every field
 * auto-filled, track the status, message the AMC back and forth, request revisions /
 * ROV disputes, and push documents up. Everything is off until the AMC is switched on;
 * the panel then renders live. STAFF-ONLY (it names the AMC / form details).
 *
 * All colors are EXPLICIT dark hex on the white canvas (never a var(--ink*) token,
 * which resolves LIGHT in this portal) — per the white-first HARD RULE.
 */

const INK = '#141B22', MUTED = '#4B585C', LINE = '#E7E1D4', GOLD = '#AE8746', TEAL = '#2F7F86';

const STATUS_LABEL = {
  draft: 'Draft', placing: 'Placing…', ordered: 'Ordered', in_process: 'In process',
  assigned: 'Assigned to appraiser', inspected: 'Inspected', in_review: 'In review',
  product_available: 'Report ready', completed: 'Completed', on_hold: 'On hold',
  cancelled: 'Cancelled', rejected: 'Rejected', error: 'Needs attention',
};
function statusColor(s) {
  if (s === 'completed' || s === 'product_available') return '#1E7B4F';
  if (s === 'error' || s === 'rejected' || s === 'cancelled') return '#B4453B';
  if (s === 'on_hold') return '#9A7A1E';
  return TEAL;
}
function money(n) { return n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-US'); } catch (_) { return String(d); } }

export default function AmcAppraisalPanel({ appId }) {
  const [config, setConfig] = useState(null);
  const [preview, setPreview] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setErr(''); setLoading(true);
    try {
      const [cfg, pv, od] = await Promise.all([
        api.amcConfig().catch(() => null),
        api.amcPreview(appId).catch(() => null),
        api.amcOrders(appId).catch(() => ({ orders: [] })),
      ]);
      setConfig(cfg && cfg.amc ? cfg.amc : null);
      setPreview(pv || null);
      setOrders((od && od.orders) || []);
    } catch (e) { setErr(e.message || 'Could not load appraisal ordering.'); }
    setLoading(false);
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const place = useCallback(async (doPlace) => {
    setBusy(true); setNotice(''); setErr('');
    try {
      const out = await api.amcPlaceOrder(appId, { place: doPlace });
      if (!out.ok) {
        setErr(out.missing && out.missing.length ? ('Still needed: ' + out.missing.join(', ')) : (out.message || 'Could not place the order.'));
      } else {
        setNotice(doPlace ? (out.dryrun ? 'Order built in test mode (nothing sent).' : 'Appraisal order placed.') : 'Draft saved.');
        await load();
        if (out.order) setSelected(out.order.id);
      }
    } catch (e) { setErr(e.message || 'Could not place the order.'); }
    setBusy(false);
  }, [appId, load]);

  if (loading) return <div style={{ color: MUTED, padding: 12 }}>Loading appraisal ordering…</div>;

  const notConfigured = !config || !config.enabled;

  return (
    <div style={{ color: INK }}>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      {notice ? <Banner tone="good">{notice}</Banner> : null}

      {notConfigured ? (
        <div style={{ border: `1px dashed ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 12, color: MUTED, background: '#FBF9F4' }}>
          <strong style={{ color: INK }}>Appraisal ordering isn’t turned on yet.</strong>{' '}
          Once the CoreLogic / AppraisalScope login is set up and switched on, you’ll be able to order the appraisal here — with every field filled in and the right form picked automatically.
          {config ? <div style={{ marginTop: 6, fontSize: 12 }}>Connection: {config.ready ? 'credentials present' : 'not configured'} · outbound {config.outbound ? 'on' : 'off'}{config.dryrun ? ' · test mode' : ''}</div> : null}
        </div>
      ) : (
        <div style={{ marginBottom: 10, fontSize: 12, color: MUTED }}>
          Connected · outbound {config.outbound ? 'on' : 'off'}{config.dryrun ? ' · test mode' : ''}
        </div>
      )}

      {/* Existing orders */}
      {orders.length ? (
        <div style={{ marginBottom: 14 }}>
          <SectionTitle>Orders</SectionTitle>
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
            {orders.map((o) => (
              <div key={o.id} onClick={() => setSelected(selected === o.id ? null : o.id)}
                style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderTop: `1px solid ${LINE}`, cursor: 'pointer', background: selected === o.id ? '#FBF9F4' : '#fff' }}>
                <Pill color={statusColor(o.status)}>{STATUS_LABEL[o.status] || o.status}</Pill>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: INK }}>{o.form_description || ('Form ' + (o.product_code || '—'))} {o.request_action === 'AddForm' ? '(added form)' : ''}</div>
                  <div style={{ fontSize: 12, color: MUTED }}>
                    {o.cdg_order_number ? ('AMC #' + o.cdg_order_number + ' · ') : ''}Ordered {fmtDate(o.ordered_at || o.created_at)}{o.dryrun ? ' · test' : ''}
                  </div>
                </div>
                <span style={{ color: TEAL, fontSize: 13 }}>{selected === o.id ? 'Hide' : 'Open'}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {selected ? <OrderDetail appId={appId} orderId={selected} onChange={load} /> : null}

      {/* Place a new order */}
      {!notConfigured && preview ? (
        <div style={{ marginTop: 14 }}>
          <SectionTitle>Order an appraisal</SectionTitle>
          <PreviewCard preview={preview} busy={busy} onDraft={() => place(false)} onPlace={() => place(true)} outbound={config.outbound} />
        </div>
      ) : null}
    </div>
  );
}

function PreviewCard({ preview, busy, onDraft, onPlace, outbound }) {
  const spec = preview.spec || {};
  const form = preview.chosenForm || {};
  const missing = preview.missing || [];
  const card = preview.card || {};
  const prop = spec.property || {};
  const loan = spec.loan || {};
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <Field label="Form">{form.productCode ? ('#' + form.productCode) : 'auto-select pending'}</Field>
        <Field label="Loan #">{spec.clientOrderNumber || '—'}</Field>
        <Field label="Property">{[prop.addressLine, prop.city, prop.state].filter(Boolean).join(', ') || '—'}</Field>
        <Field label="Type">{prop.titleCategory || '—'}</Field>
        <Field label="Purpose">{loan.loanPurpose || '—'}</Field>
        <Field label="Loan amount">{money(loan.baseLoanAmount)}</Field>
        <Field label="Borrowers">{(spec.borrowers || []).map((b) => b.fullName || [b.firstName, b.lastName].filter(Boolean).join(' ') || b.legalEntityName).filter(Boolean).join(', ') || '—'}</Field>
        <Field label="Payment card">{card.onFile ? ((card.brand || 'card') + ' ••' + (card.last4 || '')) : 'not on file'}</Field>
      </div>

      {missing.length ? (
        <div style={{ marginTop: 10, color: '#9A3B33', fontSize: 13 }}>
          <strong>Still needed before ordering:</strong> {missing.join(', ')}
        </div>
      ) : (
        <div style={{ marginTop: 10, color: '#1E7B4F', fontSize: 13 }}>Ready to order.</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn soft" disabled={busy} onClick={onDraft}>Save draft</button>
        <button className="btn primary" disabled={busy || missing.length > 0 || !outbound} onClick={onPlace}
          title={!outbound ? 'Turn on sending to the AMC first' : (missing.length ? 'Fill in what’s still needed' : '')}>
          {busy ? 'Working…' : 'Place order with the AMC'}
        </button>
      </div>
      {!outbound ? <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>Sending to the AMC is off — you can save a draft now and place it once it’s turned on.</div> : null}
    </div>
  );
}

function OrderDetail({ appId, orderId, onChange }) {
  const [tab, setTab] = useState('messages');
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 14, background: '#fff' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {[['messages', 'Messages'], ['revisions', 'Revisions & disputes'], ['documents', 'Documents']].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ border: `1px solid ${tab === k ? TEAL : LINE}`, background: tab === k ? '#EAF3F3' : '#fff', color: INK, borderRadius: 8, padding: '5px 10px', fontWeight: 550, cursor: 'pointer' }}>
            {lbl}
          </button>
        ))}
      </div>
      {tab === 'messages' ? <Messages orderId={orderId} /> : null}
      {tab === 'revisions' ? <Revisions appId={appId} orderId={orderId} /> : null}
      {tab === 'documents' ? <Documents appId={appId} orderId={orderId} onChange={onChange} /> : null}
    </div>
  );
}

function Messages({ orderId }) {
  const [rows, setRows] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const r = await api.amcComments(orderId); setRows((r && r.comments) || []); } catch (_) { /* ignore */ }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try { const o = await api.amcPostComment(orderId, text.trim()); if (!o.ok) setErr(o.message || 'Could not send.'); else { setText(''); await load(); } }
    catch (e) { setErr(e.message || 'Could not send.'); }
    setBusy(false);
  };
  return (
    <div>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {rows.length ? rows.map((c) => (
          <div key={c.id} style={{ alignSelf: c.direction === 'outbound' ? 'flex-end' : 'flex-start', maxWidth: '80%',
            background: c.direction === 'outbound' ? '#EAF3F3' : '#F4F1EA', border: `1px solid ${LINE}`, borderRadius: 10, padding: '7px 10px' }}>
            <div style={{ fontSize: 11, color: MUTED }}>{c.direction === 'outbound' ? (c.author_name || 'Us') : (c.author_name || 'AMC')} · {fmtDate(c.created_at)}</div>
            <div style={{ color: INK, whiteSpace: 'pre-wrap' }}>{c.body}</div>
          </div>
        )) : <div style={{ color: MUTED, fontSize: 13 }}>No messages yet.</div>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Message the AMC…"
          style={{ flex: 1, border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, color: INK, resize: 'vertical' }} />
        <button className="btn primary" disabled={busy || !text.trim()} onClick={send}>{busy ? '…' : 'Send'}</button>
      </div>
    </div>
  );
}

function Revisions({ appId, orderId }) {
  const [rows, setRows] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rov, setRov] = useState(null);   // { appraisedValue, opinionValue, comps }
  const load = useCallback(async () => {
    try { const r = await api.amcRevisions(orderId); setRows((r && r.revisions) || []); } catch (_) { /* ignore */ }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const sendRevision = async (kind) => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try { const o = await api.amcPostRevision(orderId, { kind, body: text.trim() }); if (!o.ok) setErr(o.message || 'Could not send.'); else { setText(''); await load(); } }
    catch (e) { setErr(e.message || 'Could not send.'); }
    setBusy(false);
  };
  const openRov = async () => {
    setBusy(true); setErr('');
    try { const c = await api.amcRovComps(appId); setRov({ appraisedValue: '', opinionValue: '', comps: (c && c.comps) || [] }); }
    catch (e) { setErr(e.message || 'Could not load comps.'); }
    setBusy(false);
  };
  const sendRov = async () => {
    setBusy(true); setErr('');
    try {
      const o = await api.amcPostRov(orderId, {
        appraisedValue: rov.appraisedValue ? Number(rov.appraisedValue) : null,
        opinionValue: rov.opinionValue ? Number(rov.opinionValue) : null,
        comps: rov.comps, note: rov.note || null,
      });
      if (!o.ok) setErr(o.message || 'Could not send the dispute.'); else { setRov(null); await load(); }
    } catch (e) { setErr(e.message || 'Could not send the dispute.'); }
    setBusy(false);
  };

  return (
    <div>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      {rows.length ? (
        <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 8 }}>
              <div style={{ fontSize: 11, color: MUTED }}>{({ rov: 'Value dispute (ROV)', revision: 'Revision', sow_change: 'Scope-of-work change', other: 'From the AMC' }[r.kind] || r.kind)} · {r.status} · {fmtDate(r.created_at)}</div>
              <div style={{ color: INK, whiteSpace: 'pre-wrap', fontSize: 13 }}>{r.body}</div>
            </div>
          ))}
        </div>
      ) : <div style={{ color: MUTED, fontSize: 13, marginBottom: 10 }}>No revisions yet.</div>}

      {rov ? (
        <div style={{ border: `1px solid ${GOLD}`, borderRadius: 10, padding: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6, color: INK }}>Reconsideration of value</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: MUTED }}>Appraised value<br />
              <input value={rov.appraisedValue} onChange={(e) => setRov({ ...rov, appraisedValue: e.target.value })} inputMode="numeric"
                style={{ border: `1px solid ${LINE}`, borderRadius: 6, padding: 6, color: INK, width: 130 }} /></label>
            <label style={{ fontSize: 12, color: MUTED }}>Value you’re asking for<br />
              <input value={rov.opinionValue} onChange={(e) => setRov({ ...rov, opinionValue: e.target.value })} inputMode="numeric"
                style={{ border: `1px solid ${LINE}`, borderRadius: 6, padding: 6, color: INK, width: 130 }} /></label>
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Supporting sales from the Property Research Center ({rov.comps.length}):</div>
          <div style={{ maxHeight: 150, overflowY: 'auto', marginBottom: 8 }}>
            {rov.comps.length ? rov.comps.map((c, i) => (
              <div key={i} style={{ fontSize: 12, color: INK, padding: '2px 0' }}>{i + 1}. {c.address || 'Comparable'} — {money(c.salePrice)} {c.saleDate ? ('on ' + c.saleDate) : ''}</div>
            )) : <div style={{ fontSize: 12, color: MUTED }}>No comparable sales found in the research warehouse for this property yet.</div>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={busy} onClick={sendRov}>{busy ? '…' : 'Send dispute'}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setRov(null)}>Cancel</button>
          </div>
        </div>
      ) : null}

      <div style={{ marginTop: 6 }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Describe the revision or scope-of-work change…"
          style={{ width: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, color: INK, resize: 'vertical', boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button className="btn soft" disabled={busy || !text.trim()} onClick={() => sendRevision('revision')}>Request revision</button>
          <button className="btn soft" disabled={busy || !text.trim()} onClick={() => sendRevision('sow_change')}>Scope-of-work change</button>
          <button className="btn ghost" disabled={busy} onClick={openRov}>Dispute the value (ROV)…</button>
        </div>
      </div>
    </div>
  );
}

function Documents({ appId, orderId, onChange }) {
  const [rows, setRows] = useState([]);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try { const r = await api.amcDocuments(appId, orderId); setRows((r && r.documents) || []); } catch (_) { /* ignore */ }
  }, [appId, orderId]);
  useEffect(() => { load(); }, [load]);
  const toggle = (id) => setPick((p) => ({ ...p, [id]: !p[id] }));
  const ids = Object.keys(pick).filter((k) => pick[k]);
  const send = async () => {
    if (!ids.length) return;
    setBusy(true); setErr(''); setNotice('');
    try {
      const o = await api.amcUploadDocs(orderId, ids);
      if (!o.ok) setErr(o.message || 'Could not upload.'); else { setNotice('Sent ' + (o.uploaded ? o.uploaded.length : 0) + ' document(s) to the order.'); setPick({}); await load(); if (onChange) onChange(); }
    } catch (e) { setErr(e.message || 'Could not upload.'); }
    setBusy(false);
  };
  return (
    <div>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', marginBottom: 8 }}>
        {rows.length ? rows.map((d) => (
          <label key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderTop: `1px solid ${LINE}`, cursor: d.alreadyUploaded ? 'default' : 'pointer', opacity: d.alreadyUploaded ? 0.6 : 1 }}>
            <input type="checkbox" disabled={d.alreadyUploaded} checked={!!pick[d.id]} onChange={() => toggle(d.id)} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: INK, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</div>
              <div style={{ fontSize: 12, color: MUTED }}>{d.category}{d.alreadyUploaded ? ' · already sent' : ''}</div>
            </div>
          </label>
        )) : <div style={{ padding: 10, color: MUTED, fontSize: 13 }}>No documents on this file yet.</div>}
      </div>
      <button className="btn primary" disabled={busy || !ids.length} onClick={send}>{busy ? 'Sending…' : ('Send ' + (ids.length || '') + ' to the order')}</button>
      <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>The scope of work and contract are sent automatically when they change or arrive.</div>
    </div>
  );
}

/* ---- little shared bits ---- */
function Banner({ tone, children }) {
  const bad = tone === 'bad';
  return <div style={{ border: `1px solid ${bad ? '#E4B4AE' : '#B7D8C4'}`, background: bad ? '#FBEEEC' : '#EEF7F1', color: bad ? '#8A2F27' : '#1E5E3C', borderRadius: 8, padding: '8px 10px', marginBottom: 10, fontSize: 13 }}>{children}</div>;
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', color: MUTED, marginBottom: 6 }}>{children}</div>;
}
function Pill({ color, children }) {
  return <span style={{ border: `1px solid ${color}`, color, borderRadius: 999, padding: '2px 9px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{children}</span>;
}
function Field({ label, children }) {
  return <div style={{ minWidth: 120 }}><div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</div><div style={{ color: INK, fontWeight: 550 }}>{children}</div></div>;
}
