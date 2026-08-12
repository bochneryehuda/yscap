import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { moneyNum } from '../lib/money';
import { askConfirm, askPrompt } from '../lib/dialog.js';
import OrderFailure, { parseOrderFailure } from './OrderFailure.jsx';

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
  cancel_requested: 'Cancelling…', cancelled: 'Cancelled', rejected: 'Rejected', error: 'Needs attention',
};
function statusColor(s) {
  if (s === 'completed' || s === 'product_available') return '#1E7B4F';
  if (s === 'error' || s === 'rejected' || s === 'cancelled') return '#B4453B';
  if (s === 'on_hold' || s === 'cancel_requested') return '#9A7A1E';
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
  // A staff-picked form (productCode) that overrides the auto-pick. '' = use the default.
  const [formOverride, setFormOverride] = useState('');
  // A staff-pinned "client shown on the report" (client_displayed_id). '' = auto-select the
  // account's single profile (the common case); only needed when the account has several.
  const [cdorOverride, setCdorOverride] = useState('');

  // The order overrides both the preview (GET) and the place (POST) send.
  const overrideParams = useCallback(() => {
    const o = {};
    if (formOverride) o.productCode = formOverride;
    if (cdorOverride) o.clientDisplayedId = cdorOverride;
    return o;
  }, [formOverride, cdorOverride]);

  const load = useCallback(async () => {
    setErr(''); setLoading(true);
    try {
      const params = overrideParams();
      const [cfg, pv, od] = await Promise.all([
        api.amcConfig().catch(() => null),
        api.amcPreview(appId, Object.keys(params).length ? params : undefined).catch(() => null),
        api.amcOrders(appId).catch(() => ({ orders: [] })),
      ]);
      setConfig(cfg && cfg.amc ? cfg.amc : null);
      setPreview(pv || null);
      setOrders((od && od.orders) || []);
    } catch (e) { setErr(e.message || 'Could not load appraisal ordering.'); }
    setLoading(false);
  }, [appId, overrideParams]);

  useEffect(() => { load(); }, [load]);

  const place = useCallback(async (doPlace) => {
    setBusy(true); setNotice(''); setErr('');
    try {
      const out = await api.amcPlaceOrder(appId, { place: doPlace, ...overrideParams() });
      if (!out.ok) {
        // A 2xx that still says {ok:false} — surface the full reason, not the bare code.
        setErr(parseOrderFailure(null, out));
      } else {
        setNotice(doPlace ? (out.dryrun ? 'Order built in test mode (nothing sent).' : 'Order placed with AppraisalScope / NAN.') : 'Draft saved.');
        await load();
        if (out.order) setSelected(out.order.id);
      }
    } catch (e) {
      // The usual failure path: a non-2xx makes req() throw with the whole body on
      // e.data. Show the owner the reason, the error code and what the AMC returned.
      setErr(parseOrderFailure(e, null));
    }
    setBusy(false);
  }, [appId, load, overrideParams]);

  if (loading) return <div style={{ color: MUTED, padding: 12 }}>Loading appraisal ordering…</div>;

  const notConfigured = !config || !config.enabled;

  return (
    <div style={{ color: INK }}>
      <OrderFailure info={err} vendor="AppraisalScope / NAN" />
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

      {/* Existing orders — bucketed so the live ones lead and the failed / draft
          orders are tucked into collapsible sections instead of one long messy list. */}
      {orders.length ? (
        <OrdersList orders={orders} selected={selected} onOpen={(id) => setSelected(selected === id ? null : id)} />
      ) : null}

      {selected ? <OrderDetail appId={appId} orderId={selected} order={orders.find((o) => o.id === selected) || null} onChange={load} /> : null}

      {/* Place a new order */}
      {!notConfigured && preview ? (
        <div style={{ marginTop: 14 }}>
          <SectionTitle>Order an appraisal</SectionTitle>
          <PreviewCard preview={preview} busy={busy} onDraft={() => place(false)} onPlace={() => place(true)} outbound={config.outbound}
            formValue={formOverride || (preview.spec && preview.spec.productCode) || ''} onPickForm={setFormOverride}
            cdorValue={cdorOverride || (preview.spec && preview.spec.clientDisplayedId) || ''} onPickCdor={setCdorOverride} />
        </div>
      ) : null}
    </div>
  );
}

// The orders on a file, grouped: the live ones lead; failed ("needs attention") and
// draft orders collapse into their own sections so the list is never one long, messy
// wall. You open a section to work the failed / draft orders inside it.
function OrdersList({ orders, selected, onOpen }) {
  const failed = orders.filter((o) => o.status === 'error');
  const drafts = orders.filter((o) => o.status === 'draft');
  const live = orders.filter((o) => o.status !== 'error' && o.status !== 'draft');
  return (
    <div style={{ marginBottom: 14 }}>
      {live.length ? (
        <>
          <SectionTitle>Orders</SectionTitle>
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
            {live.map((o) => <OrderRow key={o.id} o={o} open={selected === o.id} onOpen={onOpen} />)}
          </div>
        </>
      ) : null}
      {failed.length ? (
        <CollapseSection tone="bad" defaultOpen={!live.length}
          title={`⚠ Needs attention — ${failed.length} order${failed.length > 1 ? 's' : ''} didn’t go through`}>
          {failed.map((o) => <OrderRow key={o.id} o={o} open={selected === o.id} onOpen={onOpen} />)}
        </CollapseSection>
      ) : null}
      {drafts.length ? (
        <CollapseSection title={`Drafts — ${drafts.length} not sent yet`}>
          {drafts.map((o) => <OrderRow key={o.id} o={o} open={selected === o.id} onOpen={onOpen} />)}
        </CollapseSection>
      ) : null}
    </div>
  );
}

function OrderRow({ o, open, onOpen }) {
  const prop = (o.summary || []).find((s) => s.label === 'Property');
  return (
    <div onClick={() => onOpen(o.id)}
      style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderTop: `1px solid ${LINE}`, cursor: 'pointer', background: open ? '#FBF9F4' : '#fff' }}>
      <Pill color={statusColor(o.status)}>{STATUS_LABEL[o.status] || o.status}</Pill>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: INK }}>{o.form_description || ('Form ' + (o.product_code || '—'))} {o.request_action === 'AddForm' ? '(added form)' : ''}</div>
        <div style={{ fontSize: 12, color: MUTED }}>
          {prop ? prop.value + ' · ' : ''}{o.cdg_order_number ? ('AMC #' + o.cdg_order_number + ' · ') : ''}Ordered {fmtDate(o.ordered_at || o.created_at)}{o.dryrun ? ' · test' : ''}
        </div>
        {o.status === 'error' && o.last_error ? (
          <div style={{ fontSize: 12, color: '#B4453B', marginTop: 4 }}>
            <strong>Why it didn’t go through:</strong> {o.last_error}
          </div>
        ) : null}
      </div>
      <span style={{ color: TEAL, fontSize: 13 }}>{open ? 'Hide' : 'Open'}</span>
    </div>
  );
}

// A collapsible section (native <details>) for the failed / draft buckets.
function CollapseSection({ title, tone, defaultOpen, children }) {
  const bad = tone === 'bad';
  return (
    <details open={!!defaultOpen} style={{ marginTop: 10, border: `1px solid ${bad ? '#E4B4AE' : LINE}`, borderRadius: 10, overflow: 'hidden', background: bad ? '#FDF6F5' : '#fff' }}>
      <summary style={{ cursor: 'pointer', padding: '9px 12px', fontWeight: 600, color: bad ? '#8A2F27' : INK, fontSize: 13 }}>
        {title}
      </summary>
      <div style={{ borderTop: `1px solid ${bad ? '#E4B4AE' : LINE}` }}>{children}</div>
    </details>
  );
}

function PreviewCard({ preview, busy, onDraft, onPlace, outbound, formValue, onPickForm, cdorValue, onPickCdor }) {
  const spec = preview.spec || {};
  const missing = preview.missing || [];
  const card = preview.card || {};
  const prop = spec.property || {};
  const loan = spec.loan || {};
  const forms = preview.forms || [];
  const notifyEmails = preview.notifyEmails || [];
  const assumptions = preview.assumptions || [];
  const code = String(formValue || spec.productCode || '');
  const chosenName = preview.chosenFormName || (forms.find((f) => String(f.id) === code) || {}).name || null;
  // The "client shown on the report" (client_displayed_id). Auto-selected when the account
  // has one profile; a picker appears only when the account has several to choose from.
  const ctx = preview.context || {};
  const cdorOptions = ctx.clientDisplayedOptions || [];
  const cdorCode = String(cdorValue || spec.clientDisplayedId || '');
  const cdorName = (cdorOptions.find((o) => String(o.id) === cdorCode) || {}).name || ctx.clientDisplayedName || null;
  const needsCdorPick = !cdorCode && cdorOptions.length > 1;
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
      {/* Which appraisal form — shown by NAME, and changeable (default is auto-picked). */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.3 }}>Form</div>
        <div style={{ fontWeight: 600, color: INK, marginTop: 2 }}>
          {chosenName || (code ? 'Form #' + code : 'No default for this deal — pick one below')}
          {code ? <span style={{ color: MUTED, fontWeight: 400 }}> · #{code}</span> : null}
        </div>
        {forms.length ? (
          <select value={code} onChange={(e) => onPickForm(e.target.value)}
            style={{ marginTop: 6, maxWidth: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
            {!code ? <option value="">Choose a form…</option> : null}
            {forms.map((f) => (
              <option key={f.id} value={String(f.id)}>{f.name ? (f.name + ' (#' + f.id + ')') : ('Form #' + f.id)}</option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>The form list isn’t loaded yet — it fills in once the appraisal catalog syncs.</div>
        )}
      </div>

      {/* Which client the report is issued under (client_displayed_id). A picker only when
          the account has more than one profile; otherwise it's auto-selected silently. */}
      {(cdorOptions.length > 1 || needsCdorPick) ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.3 }}>Client shown on the report</div>
          {cdorName ? <div style={{ fontWeight: 600, color: INK, marginTop: 2 }}>{cdorName}{cdorCode ? <span style={{ color: MUTED, fontWeight: 400 }}> · #{cdorCode}</span> : null}</div> : null}
          <select value={cdorCode} onChange={(e) => onPickCdor(e.target.value)}
            style={{ marginTop: 6, maxWidth: '100%', border: `1px solid ${needsCdorPick ? '#E4B4AE' : LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
            {!cdorCode ? <option value="">Choose the client shown on the report…</option> : null}
            {cdorOptions.map((o) => (
              <option key={o.id} value={String(o.id)}>{o.name ? (o.name + ' (#' + o.id + ')') : ('#' + o.id)}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
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

      {notifyEmails.length ? (
        <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
          Update emails from the appraiser will go to: <span style={{ color: INK }}>{notifyEmails.join(', ')}</span>
        </div>
      ) : null}

      {/* What PILOT auto-filled that staff should eyeball before ordering (defaults /
          rule-picked form / derived mappings) — the NAN mirror of the Class assumptions. */}
      {assumptions.length ? (
        <div style={{ marginTop: 10, border: `1px solid ${LINE}`, borderRadius: 8, padding: '8px 10px', background: '#FBF9F4' }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>What PILOT filled in for you</div>
          {assumptions.map((a) => (
            <div key={a.field} style={{ fontSize: 13, color: INK, marginTop: 4 }}>
              <span style={{ fontWeight: 600 }}>{a.label}:</span> {a.value}
              {a.why ? <span style={{ color: MUTED }}> — {a.why}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

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

// Shows the vendor's real rejection on a failed order + copyable technical detail,
// so the reason is visible on the file and easy to hand off for a deeper look.
function OrderError({ order }) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = order.last_status_response;
  const rawText = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(rawText); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) { /* ignore */ }
  };
  return (
    <div style={{ border: '1px solid #E7C4C0', background: '#FCF4F3', borderRadius: 10, padding: 12, marginBottom: 12 }}>
      <div style={{ fontWeight: 700, color: '#8A322B' }}>This order didn’t go through</div>
      <div style={{ color: '#8A322B', marginTop: 4 }}>{order.last_error || 'The appraisal gateway did not accept the order.'}</div>
      {rawText ? (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowRaw((v) => !v)}
            style={{ border: 'none', background: 'none', color: TEAL, cursor: 'pointer', padding: 0, fontSize: 13 }}>
            {showRaw ? 'Hide technical details' : 'Show technical details'}
          </button>
          {showRaw ? (
            <div style={{ marginTop: 6 }}>
              <pre style={{ maxHeight: 200, overflow: 'auto', background: '#fff', border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, fontSize: 11, color: INK, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{rawText}</pre>
              <button className="btn soft" onClick={copy} style={{ marginTop: 4 }}>{copied ? 'Copied' : 'Copy details'}</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OrderDetail({ appId, orderId, order, onChange }) {
  const [tab, setTab] = useState('messages');
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState('');
  // Cancellable = it reached the AMC and isn't already done/cancelling. Key on the
  // ServiceProviderOrderNumber ONLY, matching the backend's not_placed guard (a cancel
  // needs the sp number for the envelope AND the poll confirmation) — so the button never
  // shows on an order the backend would refuse with "never placed".
  const canCancel = !!(order && order.sp_order_number
    && order.status !== 'cancelled' && order.status !== 'completed' && order.status !== 'cancel_requested');

  const doCancel = async () => {
    setCancelErr('');
    const reason = await askPrompt('Why are you cancelling this appraisal order? This reason is sent to the AMC.', {
      title: 'Cancel appraisal order', confirmLabel: 'Continue', multiline: true,
    });
    if (reason == null) return;                                   // backed out
    if (!String(reason).trim()) { setCancelErr('Add a short reason for the cancellation.'); return; }
    const ok = await askConfirm(`Ask the AMC to cancel this order?\n\nReason: ${reason.trim()}`, {
      title: 'Cancel appraisal order', confirmLabel: 'Cancel the order', cancelLabel: 'Keep it',
    });
    if (!ok) return;
    setCancelBusy(true);
    try {
      const out = await api.amcCancelOrder(orderId, reason.trim());
      if (!out || !out.ok) setCancelErr((out && out.message) || 'Could not cancel the order.');
      else await onChange();
    } catch (e) { setCancelErr((e && e.message) || 'Could not cancel the order.'); }
    setCancelBusy(false);
  };

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 14, background: '#fff' }}>
      {order && order.status === 'error' ? <OrderError order={order} /> : null}
      {order && order.status === 'cancel_requested' ? (
        <div style={{ border: '1px solid #E4D3A8', background: '#FBF6E9', borderRadius: 10, padding: 10, marginBottom: 12, color: '#7A5E17', fontSize: 13 }}>
          <strong>Cancellation requested.</strong>{order.cancel_reason ? ` ${order.cancel_reason}` : ''} Waiting for the AMC to confirm.
        </div>
      ) : null}
      {order && Array.isArray(order.summary) && order.summary.length ? (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 12, background: '#FBF9F4' }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8, fontWeight: 600 }}>
            What was ordered · <span style={{ color: statusColor(order.status) }}>{STATUS_LABEL[order.status] || order.status}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '5px 14px' }}>
            {order.summary.map((s, i) => (
              <React.Fragment key={i}>
                <div style={{ color: MUTED, fontSize: 12.5 }}>{s.label}</div>
                <div style={{ color: INK, fontSize: 12.5, wordBreak: 'break-word' }}>{s.value}</div>
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {[['messages', 'Messages'], ['revisions', 'Revisions & disputes'], ['documents', 'Documents']].map(([k, lbl]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ border: `1px solid ${tab === k ? TEAL : LINE}`, background: tab === k ? '#EAF3F3' : '#fff', color: INK, borderRadius: 8, padding: '5px 10px', fontWeight: 550, cursor: 'pointer' }}>
            {lbl}
          </button>
        ))}
        {canCancel ? (
          <button className="btn ghost" disabled={cancelBusy} onClick={doCancel} style={{ marginLeft: 'auto', color: '#B4453B' }}>
            {cancelBusy ? 'Cancelling…' : 'Cancel order'}
          </button>
        ) : null}
      </div>
      {cancelErr ? <div style={{ color: '#B4453B', fontSize: 13, marginBottom: 8 }}>{cancelErr}</div> : null}
      {tab === 'messages' ? <Messages orderId={orderId} /> : null}
      {tab === 'revisions' ? <Revisions appId={appId} orderId={orderId} order={order} /> : null}
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

function Revisions({ appId, orderId, order }) {
  const [rows, setRows] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rovOpen, setRovOpen] = useState(false);
  // A fix or a value dispute only makes sense once the report is IN (report ready or
  // completed). A scope-of-work change is about the order in progress, so it stays open.
  const reportIn = !!(order && (order.status === 'completed' || order.status === 'product_available'));
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

  return (
    <div>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      {rows.length ? (
        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.id} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 8 }}>
              <div style={{ fontSize: 11, color: MUTED }}>{({ rov: 'Value dispute (ROV)', revision: 'Revision request', sow_change: 'Scope-of-work change', other: 'From the AMC' }[r.kind] || r.kind)} · {r.status} · {fmtDate(r.created_at)}</div>
              <div style={{ color: INK, whiteSpace: 'pre-wrap', fontSize: 13 }}>{r.body}</div>
            </div>
          ))}
        </div>
      ) : <div style={{ color: MUTED, fontSize: 13, marginBottom: 12 }}>Nothing asked for yet.</div>}

      {/* ── Feature 1: an ordinary revision / fix (a mistake, a correction, a scope change) ── */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 10 }}>
        <div style={{ fontWeight: 600, color: INK, marginBottom: 2 }}>Ask for a revision or a fix</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          For a mistake the appraiser made, a correction, or a change to the scope of work. The appraiser fixes the report and sends it back — this does not change the value.
        </div>
        {!reportIn ? (
          <div style={{ border: `1px solid ${GOLD}`, background: '#FBF6EC', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: MUTED, marginBottom: 8 }}>
            The appraisal isn’t back yet, so a <strong>fix</strong> can’t be requested — there’s nothing to fix until the report is in. This opens up once the order shows <strong>Report ready</strong>. (A scope-of-work change can still be sent while the order is in progress.)
          </div>
        ) : null}
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Describe what needs to be fixed or changed…"
          style={{ width: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, color: INK, resize: 'vertical', boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button className="btn soft" disabled={busy || !text.trim() || !reportIn} onClick={() => sendRevision('revision')}
            title={reportIn ? '' : 'Available once the report is in'}>Request a revision</button>
          <button className="btn soft" disabled={busy || !text.trim()} onClick={() => sendRevision('sow_change')}>Scope-of-work change</button>
        </div>
      </div>

      {/* ── Feature 2: a reconsideration of value (ROV), backed by comps ── */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 600, color: INK, marginBottom: 2 }}>Dispute the value (ROV)</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          If you think the appraised value is too low, ask for a reconsideration of value. Search the Property Research Center for the comparable sales you want to use, add them, and PILOT fills in all their details automatically. You can also type in a property that isn’t in the research yet.
        </div>
        {!reportIn ? (
          <div style={{ border: `1px solid ${GOLD}`, background: '#FBF6EC', borderRadius: 8, padding: '8px 10px', fontSize: 12.5, color: MUTED }}>
            You can dispute the value once the report is in. There’s no value to dispute until the appraiser sends the finished report back (<strong>Report ready</strong>).
          </div>
        ) : rovOpen ? (
          <RovBuilder appId={appId} orderId={orderId}
            onCancel={() => setRovOpen(false)}
            onSent={async () => { setRovOpen(false); await load(); }} />
        ) : (
          <button className="btn ghost" disabled={busy} onClick={() => setRovOpen(true)}>Start a value dispute…</button>
        )}
      </div>
    </div>
  );
}

// A comparable sale line — its full detail, one row. Used in the picker and the
// "using these" list; `action` is the Add/Remove control on the right.
function CompLine({ c, action }) {
  const specs = [];
  if (c.gla != null) specs.push(`${Math.round(c.gla).toLocaleString('en-US')} sq ft`);
  if (c.beds != null) specs.push(`${c.beds} bd`);
  if (c.bathsFull != null) specs.push(`${c.bathsFull}${c.bathsHalf ? '.' + c.bathsHalf : ''} ba`);
  if (c.yearBuilt != null) specs.push(`built ${c.yearBuilt}`);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderTop: `1px solid ${LINE}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: INK, fontSize: 13, fontWeight: 500 }}>
          {c.address || 'Comparable sale'}{c.manual ? <span style={{ color: TEAL, fontSize: 11, marginLeft: 6 }}>typed in</span> : null}
        </div>
        <div style={{ color: MUTED, fontSize: 12 }}>
          {c.salePrice != null ? `Sold ${money(c.salePrice)}` : 'Sale price not on file'}
          {c.saleDate ? ` on ${fmtDate(c.saleDate)}` : ''}
          {specs.length ? ` · ${specs.join(', ')}` : ''}
          {c.distanceMiles != null ? ` · ${c.distanceMiles} mi away` : ''}
        </div>
      </div>
      {action}
    </div>
  );
}

// The value-dispute (ROV) builder: pick comps from the Property Research Center,
// add them to the dispute, or type in one that isn't in the research. All the
// comp's details fill in automatically when it's selected.
function RovBuilder({ appId, orderId, onCancel, onSent }) {
  const [appraisedValue, setAppraisedValue] = useState('');
  const [opinionValue, setOpinionValue] = useState('');
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState([]);   // comps chosen for the dispute
  const [suggested, setSuggested] = useState([]);  // starting set near the property
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);    // null = no search run yet
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manual, setManual] = useState({ address: '', salePrice: '', saleDate: '', gla: '', beds: '', bathsFull: '' });

  useEffect(() => { (async () => {
    try { const c = await api.amcRovComps(appId); setSuggested((c && c.comps) || []); } catch (_) { /* ignore */ }
  })(); }, [appId]);

  const keyOf = (c) => (c.propertyId ? 'p:' + c.propertyId : 'm:' + (c.address || '') + ':' + (c.salePrice || ''));
  const isPicked = (c) => selected.some((s) => keyOf(s) === keyOf(c));
  const addComp = (c) => setSelected((cur) => (cur.some((s) => keyOf(s) === keyOf(c)) ? cur : [...cur, c]));
  const removeComp = (c) => setSelected((cur) => cur.filter((s) => keyOf(s) !== keyOf(c)));

  const runSearch = async () => {
    setSearching(true); setErr('');
    try { const r = await api.amcRovCompSearch(appId, { q: q.trim() }); setResults((r && r.comps) || []); }
    catch (e) { setErr(e.message || 'Search failed.'); setResults([]); }
    setSearching(false);
  };

  const addManual = () => {
    const m = manual;
    if (!m.address.trim() && !m.salePrice) return;
    addComp({
      propertyId: null, manual: true,
      address: m.address.trim() || null,
      salePrice: m.salePrice ? moneyNum(m.salePrice) : null,
      saleDate: m.saleDate || null,
      gla: m.gla ? Number(m.gla) : null,
      beds: m.beds ? Number(m.beds) : null,
      bathsFull: m.bathsFull ? Number(m.bathsFull) : null,
    });
    setManual({ address: '', salePrice: '', saleDate: '', gla: '', beds: '', bathsFull: '' });
    setManualOpen(false);
  };

  const send = async () => {
    setBusy(true); setErr('');
    try {
      const o = await api.amcPostRov(orderId, {
        appraisedValue: appraisedValue ? Number(appraisedValue) : null,
        opinionValue: opinionValue ? Number(opinionValue) : null,
        comps: selected, note: note.trim() || null,
      });
      if (!o.ok) setErr(o.message || 'Could not send the dispute.'); else onSent();
    } catch (e) { setErr(e.message || 'Could not send the dispute.'); }
    setBusy(false);
  };

  const inp = { border: `1px solid ${LINE}`, borderRadius: 6, padding: 6, color: INK, boxSizing: 'border-box' };
  const list = results == null ? suggested : results;
  const listLabel = results == null ? 'Suggested comparable sales near the property' : `Search results (${results.length})`;

  return (
    <div style={{ border: `1px solid ${GOLD}`, borderRadius: 10, padding: 10 }}>
      {err ? <Banner tone="bad">{err}</Banner> : null}

      {/* the two values being disputed */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: MUTED }}>Appraised value<br />
          <input value={appraisedValue} onChange={(e) => setAppraisedValue(e.target.value)} inputMode="numeric"
            style={{ ...inp, width: 140 }} /></label>
        <label style={{ fontSize: 12, color: MUTED }}>Value you’re asking for<br />
          <input value={opinionValue} onChange={(e) => setOpinionValue(e.target.value)} inputMode="numeric"
            style={{ ...inp, width: 140 }} /></label>
      </div>

      {/* comps chosen for THIS dispute (the payload) */}
      <div style={{ fontWeight: 600, color: INK, fontSize: 13, marginBottom: 2 }}>
        Comparable sales you’re using ({selected.length})
      </div>
      {selected.length ? (
        <div style={{ marginBottom: 10 }}>
          {selected.map((c) => (
            <CompLine key={keyOf(c)} c={c}
              action={<button className="btn ghost" style={{ minHeight: 0, padding: '2px 8px', fontSize: 12 }} onClick={() => removeComp(c)}>Remove</button>} />
          ))}
        </div>
      ) : (
        <div style={{ color: MUTED, fontSize: 12, marginBottom: 10 }}>None yet — search below and add the sales you want to use, or type one in.</div>
      )}

      {/* search the research center */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by address or town…"
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
          style={{ ...inp, flex: 1 }} />
        <button className="btn soft" disabled={searching} onClick={runSearch}>{searching ? '…' : 'Search'}</button>
      </div>

      <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>{listLabel}</div>
      <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 10, borderBottom: `1px solid ${LINE}` }}>
        {list.length ? list.map((c) => (
          <CompLine key={keyOf(c)} c={c}
            action={isPicked(c)
              ? <span style={{ color: TEAL, fontSize: 12, whiteSpace: 'nowrap' }}>✓ Added</span>
              : <button className="btn soft" style={{ minHeight: 0, padding: '2px 8px', fontSize: 12 }} onClick={() => addComp(c)}>Add</button>} />
        )) : <div style={{ fontSize: 12, color: MUTED, padding: '6px 0' }}>
          {results == null ? 'No comparable sales found near the property yet — search a town or add one manually.' : 'Nothing found. Try a different address or town, or add the property manually.'}
        </div>}
      </div>

      {/* type in a property that isn't in the research */}
      {manualOpen ? (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Add a property that isn’t in the research yet:</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
            <input value={manual.address} onChange={(e) => setManual({ ...manual, address: e.target.value })} placeholder="Address" style={{ ...inp, gridColumn: '1 / -1' }} />
            <input value={manual.salePrice} onChange={(e) => setManual({ ...manual, salePrice: e.target.value })} placeholder="Sale price" inputMode="numeric" style={inp} />
            <input value={manual.saleDate} onChange={(e) => setManual({ ...manual, saleDate: e.target.value })} placeholder="Sale date (YYYY-MM-DD)" style={inp} />
            <input value={manual.gla} onChange={(e) => setManual({ ...manual, gla: e.target.value })} placeholder="Sq ft" inputMode="numeric" style={inp} />
            <input value={manual.beds} onChange={(e) => setManual({ ...manual, beds: e.target.value })} placeholder="Beds" inputMode="numeric" style={inp} />
            <input value={manual.bathsFull} onChange={(e) => setManual({ ...manual, bathsFull: e.target.value })} placeholder="Baths" inputMode="numeric" style={inp} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn soft" onClick={addManual}>Add this property</button>
            <button className="btn ghost" onClick={() => setManualOpen(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn ghost" style={{ marginBottom: 10 }} onClick={() => setManualOpen(true)}>＋ Add a property manually</button>
      )}

      {/* optional note + send */}
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything to add for the appraiser (optional)…"
        style={{ width: '100%', ...inp, resize: 'vertical', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={busy || !selected.length} onClick={send}>{busy ? '…' : 'Send dispute'}</button>
        <button className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {!selected.length ? <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>Add at least one comparable sale to send the dispute.</div> : null}
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
