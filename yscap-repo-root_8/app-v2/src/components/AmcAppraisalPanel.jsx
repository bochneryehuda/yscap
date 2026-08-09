import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { moneyNum } from '../lib/money';

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
// A refused order, in the words the server used. `missing` first (it is the actionable
// list), then the route's own sentence; never the bare error CODE, which is for us.
function refusal(out) {
  if (!out) return '';
  if (Array.isArray(out.missing) && out.missing.length) return 'Still needed: ' + out.missing.join(', ');
  return out.message || '';
}
// The form the appraiser fills in. The NAME is the point — a bare product code is the
// appraisal company's internal id and says nothing about what was ordered.
function formLabel(name, code) {
  if (name) return name;
  return code ? ('Form #' + code) : 'auto-select pending';
}
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
    } catch (e) { setErr(refusal(e.data) || e.message || 'Could not load appraisal ordering.'); }
    setLoading(false);
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const place = useCallback(async (doPlace) => {
    setBusy(true); setNotice(''); setErr('');
    try {
      const out = await api.amcPlaceOrder(appId, { place: doPlace });
      if (!out.ok) {
        setErr(refusal(out));
      } else {
        setNotice(doPlace ? (out.dryrun ? 'Order built in test mode (nothing sent).' : 'Appraisal order placed.') : 'Draft saved.');
        await load();
        if (out.order) setSelected(out.order.id);
      }
    } catch (e) {
      // A refused order comes back as a non-2xx, so `api` throws and the SERVER's own
      // sentence is on `e.data` — `e.message` is only the short code. Reading the
      // body is what turns "order_failed" back into the plain explanation the route
      // wrote (and, before that, the generic "Something went wrong on our end").
      setErr(refusal(e.data) || e.message || 'Could not place the order.');
    }
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
  // BOTH READ FROM THE SAME PAIR. `preview.formName` is the name of the form that
  // would actually be ordered; `chosenForm.formName` is the name of the AUTO-PICKED
  // one, and on a staff override those are two different forms. Falling back from one
  // to the other printed the auto-picked form's NAME above the overridden form's
  // NUMBER — the "confidently describes the wrong report" failure, on the screen
  // instead of on the wire. With no name at all, formLabel() shows "Form #<code>".
  const code = preview.productCode || spec.productCode || form.productCode || null;
  const formName = preview.formName || null;
  const contacts = spec.contacts || [];
  const contactNotes = preview.contactNotes || [];
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <Field label="Form">
          <div>{formLabel(formName, code)}</div>
          {formName && code ? <div style={{ fontSize: 11, color: MUTED, fontWeight: 400 }}>Their form #{code}</div> : null}
        </Field>
        <Field label="Loan #">{spec.clientOrderNumber || '—'}</Field>
        <Field label="Property">{[prop.addressLine, prop.city, prop.state].filter(Boolean).join(', ') || '—'}</Field>
        <Field label="Type">{prop.titleCategory || '—'}</Field>
        <Field label="Purpose">{loan.loanPurpose || '—'}</Field>
        <Field label="Loan amount">{money(loan.baseLoanAmount)}</Field>
        <Field label="Borrowers">{(spec.borrowers || []).map((b) => b.fullName || [b.firstName, b.lastName].filter(Boolean).join(' ') || b.legalEntityName).filter(Boolean).join(', ') || '—'}</Field>
        <Field label="Payment card">{card.onFile ? ((card.brand || 'card') + ' ••' + (card.last4 || '')) : 'not on file'}</Field>
      </div>

      <ContactList contacts={contacts} notes={contactNotes} />

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

// Who the appraiser gets, by role — the same four people the Class Valuation order
// carries. HOW each one travels differs (the borrower rides their own record, the
// property-access person is sent as a named contact, our loan officer is copied on
// the appraisal company's notices), so each line says which — otherwise the screen
// implies our loan officer is somebody the appraiser will phone.
const ROLE_LABEL = {
  Borrower: 'Borrower', Coborrower: 'Co-borrower',
  PropertyAccess: 'Property access', LoanOfficer: 'Loan officer (us)',
};
const SENT_AS = {
  borrower: 'sent with the borrower',
  party: 'sent as the property contact',
  notification: 'copied on updates',
};
function ContactList({ contacts, notes }) {
  if (!contacts.length && !notes.length) return null;
  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
      <SectionTitle>Contacts sent with the order</SectionTitle>
      {contacts.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {contacts.map((c, i) => (
            <div key={c.role + i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span style={{ color: MUTED, fontSize: 12, minWidth: 130 }}>{ROLE_LABEL[c.role] || c.role}</span>
              <span style={{ color: INK, fontWeight: 550 }}>{c.name || '—'}</span>
              <span style={{ color: MUTED, fontSize: 12 }}>
                {[c.company, c.email, c.phone].filter(Boolean).join(' · ') || 'no email or phone on file'}
              </span>
              <span style={{ color: TEAL, fontSize: 11 }}>{SENT_AS[c.sentAs] || ''}</span>
            </div>
          ))}
        </div>
      ) : null}
      {notes.map((n, i) => (
        <div key={i} style={{ marginTop: 6, fontSize: 12, color: MUTED }}>{n}</div>
      ))}
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
    try { const o = await api.amcPostComment(orderId, text.trim()); if (!o.ok) setErr(refusal(o) || 'Could not send.'); else { setText(''); await load(); } }
    catch (e) { setErr(refusal(e.data) || e.message || 'Could not send.'); }
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
  const [rovOpen, setRovOpen] = useState(false);
  const load = useCallback(async () => {
    try { const r = await api.amcRevisions(orderId); setRows((r && r.revisions) || []); } catch (_) { /* ignore */ }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  const sendRevision = async (kind) => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try { const o = await api.amcPostRevision(orderId, { kind, body: text.trim() }); if (!o.ok) setErr(refusal(o) || 'Could not send.'); else { setText(''); await load(); } }
    catch (e) { setErr(refusal(e.data) || e.message || 'Could not send.'); }
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
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Describe what needs to be fixed or changed…"
          style={{ width: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, color: INK, resize: 'vertical', boxSizing: 'border-box' }} />
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <button className="btn soft" disabled={busy || !text.trim()} onClick={() => sendRevision('revision')}>Request a revision</button>
          <button className="btn soft" disabled={busy || !text.trim()} onClick={() => sendRevision('sow_change')}>Scope-of-work change</button>
        </div>
      </div>

      {/* ── Feature 2: a reconsideration of value (ROV), backed by comps ── */}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
        <div style={{ fontWeight: 600, color: INK, marginBottom: 2 }}>Dispute the value (ROV)</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          If you think the appraised value is too low, ask for a reconsideration of value. Search the Property Research Center for the comparable sales you want to use, add them, and PILOT fills in all their details automatically. You can also type in a property that isn’t in the research yet.
        </div>
        {rovOpen ? (
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
    catch (e) { setErr(refusal(e.data) || e.message || 'Search failed.'); setResults([]); }
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
      if (!o.ok) setErr(refusal(o) || 'Could not send the dispute.'); else onSent();
    } catch (e) { setErr(refusal(e.data) || e.message || 'Could not send the dispute.'); }
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
      if (!o.ok) setErr(refusal(o) || 'Could not upload.'); else { setNotice('Sent ' + (o.uploaded ? o.uploaded.length : 0) + ' document(s) to the order.'); setPick({}); await load(); if (onChange) onChange(); }
    } catch (e) { setErr(refusal(e.data) || e.message || 'Could not upload.'); }
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
