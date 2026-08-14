import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../lib/api';
import { moneyNum } from '../lib/money';
import { askConfirm, askPrompt } from '../lib/dialog.js';
import OrderFailure, { parseOrderFailure } from './OrderFailure.jsx';

/**
 * ONE unified "Appraisal order" section that replaces the two side-by-side panels
 * (AmcAppraisalPanel — AppraisalScope / NAN — and ClassAppraisalPanel — Class
 * Valuation). Built to docs/appraisal-rebuild/UNIFIED-UI-SPEC.md.
 *
 * The principle is OrderFailure's, extended to the whole section: ONE shell, a
 * per-vendor adapter, the vendor's short name STAMPED on everything, so the two
 * desks can never drift. A vendor selector chooses which backend the BUILDER
 * targets; the active-order cards and the one drafts+failed+closed drawer show
 * orders from BOTH vendors together, each carrying its own vendor stamp. The two
 * vendors stay TECHNICALLY SEPARATE — no mixing of backends, each order is its
 * own vendor's order.
 *
 * All text is EXPLICIT dark hex on the white canvas (never a var(--ink*) token,
 * which resolves LIGHT in this portal) — per the white-first HARD RULE.
 */

// Airy, modern palette. Text is always an explicit dark hex (INK primary, MUTED
// secondary, SOFT tertiary) on the white canvas — never a var(--ink*) token,
// which resolves LIGHT in this portal. LINE is a whisper border; surfaces are
// warm-white so nested content reads as a soft panel, not a boxed-in block.
const INK = '#141B22', MUTED = '#54606C', SOFT = '#8A93A0', LINE = '#EFEADF', GOLD = '#AE8746', TEAL = '#2F7F86';
const BAD = '#B4453B', GOOD = '#1E7B4F';
// Amber caution palette — dark amber text on a light amber card, AA on white.
const WARN = '#9A3412', WARN_BG = '#FDF4E7', WARN_LINE = '#EAD4AE';

function money(n) { return n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'); }
function fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-US'); } catch (_) { return String(d); } }
function fmtWhen(d) { if (!d) return ''; try { return new Date(d).toLocaleString('en-US'); } catch (_) { return ''; } }

// ── ONE normalized status vocabulary across both vendors ───────────────────
// NAN STATUS_LABEL and Class ORDER_STATUS collapse into one map + one color fn.
const STATUS_LABEL = {
  draft: 'Draft', placing: 'Placing…', dryrun: 'Test build', ordered: 'Ordered', in_process: 'In process',
  assigned: 'Assigned to appraiser', inspected: 'Inspected', in_review: 'In review',
  product_available: 'Report ready', completed: 'Report ready', on_hold: 'On hold',
  cancel_requested: 'Cancelling…', cancelled: 'Cancelled', rejected: 'Rejected', error: 'Needs attention',
};
function statusColor(s) {
  if (s === 'completed' || s === 'product_available') return GOOD;
  if (s === 'error' || s === 'rejected' || s === 'cancelled') return BAD;
  if (s === 'on_hold' || s === 'cancel_requested') return '#9A7A1E';
  return TEAL;
}

// ── The normalized status timeline (spec §6) — ONE definition ──────────────
// Placed → Inspection scheduled → Inspection completed → In review → Report in,
// with overlay states (on hold / cancelling) rendered as a badge, not a step.
const MILESTONES = ['Placed', 'Inspection scheduled', 'Inspection completed', 'In review', 'Report in'];
function statusToMilestone(vendor, raw, order) {
  const s = String(raw || '');
  // Terminal states never render as an active timeline (they live in the drawer),
  // but map them defensively so one function answers for every status.
  if (s === 'cancelled') return { index: -1, terminal: { label: 'Cancelled', tone: 'bad' } };
  if (s === 'rejected') return { index: -1, terminal: { label: 'Rejected', tone: 'bad' } };
  let overlay = null;
  if (s === 'on_hold') overlay = { label: 'On hold', tone: 'warn' };
  else if (s === 'cancel_requested') overlay = { label: 'Cancelling…', tone: 'warn' };
  let index = 0;                                   // ordered / in_process / placing / dryrun
  if (s === 'assigned') index = 1;                 // + inspection date if any
  else if (s === 'inspected') index = 2;
  else if (s === 'in_review') index = 3;           // NAN has this; Class merges it away
  else if (s === 'product_available' || s === 'completed') index = 4;
  return { index, overlay, terminal: null };
}

// ── Per-vendor adapters (spec §9/§11): name, stamp, api calls, order shape ──
// Everything the SHARED shell needs from a vendor is here; only this data
// differs between the two, the JSX around it is identical.
const ADAPTERS = {
  nan: {
    key: 'nan',
    name: 'AppraisalScope / NAN',
    stamp: 'NAN',
    loadConfig: () => api.amcConfig().then((c) => (c && c.amc) ? c.amc : null),
    loadOrders: (appId) => api.amcOrders(appId).then((o) => (o && o.orders) || []),
    orderTitle: (o) => o.form_description || ('Form ' + (o.product_code || '—')),
    orderNumber: (o) => (o.cdg_order_number ? 'AMC #' + o.cdg_order_number : null),
    orderedAt: (o) => o.ordered_at || o.created_at,
    orderFee: () => null,                          // NAN exposes no per-order fee today
    orderPaid: () => false,                        // NAN exposes no per-order paid flag today
    canCancel: (o) => !!(o.sp_order_number && o.status !== 'cancelled' && o.status !== 'completed'
      && o.status !== 'cancel_requested' && o.status !== 'rejected'),
  },
  // THE THIRD VENDOR, AND A DIFFERENT PRODUCT. Richer Value's Hybrid Appraisal is
  // an EVALUATION: it comes back with an As-Is value AND an After Repair Value on
  // one order, for well under half the price of a full appraisal — and it produces
  // no appraisal data file (XML), which is why ordering one waives that half of
  // the appraisal condition automatically. Its report PDF files itself into the
  // SAME appraisal condition every other vendor's report goes to.
  //
  // IT IS NOT THE DEFAULT AND MUST NOT BECOME ONE (owner-directed 2026-08-14:
  // "whenever they choose, the default should still stay NAN"). The selector below
  // starts on NAN and this is a deliberate third choice.
  rv: {
    key: 'rv',
    name: 'Richer Value (Hybrid Appraisal)',
    stamp: 'Richer Value',
    loadConfig: () => api.rvConfig().then((c) => (c && c.richerValue) ? c.richerValue : null),
    // Returns the whole payload {orders, xmlWaiver}; the caller keeps it.
    loadOrders: (appId) => api.rvOrders(appId),
    orderTitle: (o) => (o.report_type === 'reno-arv' ? 'Hybrid Appraisal (As-Is + ARV)' : `Richer Value ${o.report_type || 'report'}`),
    orderNumber: (o) => (o.order_token ? 'Richer Value #' + String(o.order_token).slice(0, 12) : null),
    orderedAt: (o) => o.placed_at || o.created_at,
    // Their price is a dollar figure on the order row, in cents.
    orderFee: (o) => (o.total_price_cents != null ? o.total_price_cents / 100 : null),
    orderPaid: (o) => !!o.paid_at,
    canCancel: (o) => !!(o.intake_token && !['cancelled', 'completed', 'cancel_requested', 'rejected'].includes(o.status)),
  },
  class: {
    key: 'class',
    name: 'Class Valuation',
    stamp: 'Class',
    loadConfig: () => api.classConfig().then((c) => (c && c.class) ? c.class : null),
    // Returns the whole payload {orders, unread, openAsks, attachments}; the caller keeps it.
    loadOrders: (appId) => api.classOrders(appId),
    orderTitle: (o) => (o.product_title ? o.product_title : (o.class_order_id ? 'Class order ' + o.class_order_id : 'Class order')),
    orderNumber: (o) => (o.class_order_id ? 'Class #' + o.class_order_id : null),
    orderedAt: (o) => o.placed_at || o.created_at,
    orderFee: (o) => (o.client_fee_cents != null ? o.client_fee_cents / 100 : null),
    orderPaid: (o) => !!o.paid_at,
    canCancel: () => false,                        // Class cancel needs a reason-picker not in the old panel
  },
};

/* ======================================================================= *
 *  Section
 * ======================================================================= */
export default function AppraisalOrderSection({ appId, onChanged }) {
  // THE DEFAULT STAYS NAN (owner-directed 2026-08-14: "whenever they choose, the
  // default should still stay NAN"). This is a display start point, not a
  // file-level default — nothing is ordered until a human picks and confirms —
  // and adding a third vendor deliberately did not move it.
  const [vendor, setVendor] = useState('nan');
  const [nanCfg, setNanCfg] = useState(null);
  const [classCfg, setClassCfg] = useState(null);
  const [rvCfg, setRvCfg] = useState(null);
  const [nanOrders, setNanOrders] = useState([]);
  const [classData, setClassData] = useState(null);  // { orders, unread, openAsks, attachments }
  const [rvData, setRvData] = useState(null);        // { orders, xmlWaiver }
  const [card, setCard] = useState(null);            // appraisal payment card on file, or null
  const [loading, setLoading] = useState(true);
  const [payFor, setPayFor] = useState(null);        // the order whose Pay modal is open

  const loadOrders = useCallback(async () => {
    const [nan, cls, rv] = await Promise.all([
      ADAPTERS.nan.loadOrders(appId).catch(() => []),
      ADAPTERS.class.loadOrders(appId).catch(() => ({ orders: [] })),
      ADAPTERS.rv.loadOrders(appId).catch(() => ({ orders: [] })),
    ]);
    setNanOrders(nan || []);
    setClassData(cls || { orders: [] });
    setRvData(rv || { orders: [] });
  }, [appId]);

  const loadCard = useCallback(async () => {
    // 404 = no card on file; anything else, treat as no card so the button falls back to "Pay".
    try { setCard(await api.staffAppraisalCard(appId)); } catch (_) { setCard(null); }
  }, [appId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [nc, cc, rc] = await Promise.all([
        ADAPTERS.nan.loadConfig().catch(() => null),
        ADAPTERS.class.loadConfig().catch(() => null),
        ADAPTERS.rv.loadConfig().catch(() => null),
      ]);
      if (!alive) return;
      setNanCfg(nc); setClassCfg(cc); setRvCfg(rc);
      await loadOrders();
      await loadCard();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [appId, loadOrders, loadCard]);

  // Both vendors' orders together — one list to the user, each stamped with its vendor.
  const allOrders = useMemo(() => {
    const unreadFor = (id) => ((classData && classData.unread || []).find((u) => String(u.class_order_row) === String(id)) || {}).n || 0;
    const asksFor = (id) => (classData && classData.openAsks || []).filter((a) => String(a.class_order_row) === String(id));
    const attFor = (id) => (classData && classData.attachments || []).filter((a) => String(a.class_order_row) === String(id));
    const nan = (nanOrders || []).map((o) => ({ ...o, _vendor: 'nan' }));
    const cls = ((classData && classData.orders) || []).map((o) => ({
      ...o, _vendor: 'class', _unread: unreadFor(o.id), _asks: asksFor(o.id), _attachments: attFor(o.id),
    }));
    const rv = ((rvData && rvData.orders) || []).map((o) => ({ ...o, _vendor: 'rv' }));
    return [...nan, ...cls, ...rv];
  }, [nanOrders, classData, rvData]);

  const ts = (o) => { const d = ADAPTERS[o._vendor].orderedAt(o); return d ? new Date(d).getTime() : 0; };
  const active = useMemo(
    () => allOrders.filter((o) => !['draft', 'error', 'cancelled', 'rejected'].includes(o.status)).sort((a, b) => ts(b) - ts(a)),
    [allOrders]);
  const failed = allOrders.filter((o) => o.status === 'error');
  const drafts = allOrders.filter((o) => o.status === 'draft');
  const closed = allOrders.filter((o) => o.status === 'cancelled' || o.status === 'rejected');
  const drawerCount = failed.length + drafts.length + closed.length;

  const afterChange = useCallback(async () => {
    await loadOrders();
    await loadCard();
    if (onChanged) onChanged();
  }, [loadOrders, loadCard, onChanged]);

  const selectedCfg = vendor === 'nan' ? nanCfg : (vendor === 'class' ? classCfg : rvCfg);
  const adapter = ADAPTERS[vendor];

  if (loading) return <div style={{ color: MUTED, padding: '8px 2px', fontSize: 13 }}>Loading the appraisal order…</div>;

  return (
    <div className="aord">
      {/* ── Active orders first (both vendors, newest first) — the live work is
             what matters; the builder sits quietly below it. */}
      {active.length ? (
        <>
          <div className="aord-eyebrow" style={{ marginTop: 0 }}>Active {active.length > 1 ? 'orders' : 'order'}</div>
          {active.map((o) => (o._vendor === 'rv'
            // Richer Value's order card is its own, because its actions are its
            // own: there are no appraiser messages and no document exchange on an
            // evaluation, and there ARE two figures to read and put on the file.
            // The SHELL around it — the list, the ordering, the drawer — is shared.
            ? <RvOrderCard key={'rv:' + o.id} order={o} onChanged={afterChange} />
            : <ActiveOrderCard key={o._vendor + ':' + o.id} order={o} appId={appId} card={card}
              onChanged={afterChange} onPay={setPayFor} />))}
        </>
      ) : null}

      {/* ── Order builder: a soft card. Header (title + vendor selector) + the
             connection line + the selected vendor's builder body. */}
      <div className="aord-card">
        <div className="aord-h">
          <div className="grow">
            <div className="aord-title">{active.length ? 'Order another appraisal' : 'Order an appraisal'}</div>
            <div className="aord-sub">
              Filled in from the file and shown to you before anything is sent. Pick which vendor handles it.
            </div>
            <VendorStatusChip cfg={selectedCfg} />
          </div>
          <VendorSelector vendor={vendor} onPick={setVendor} />
        </div>

        {vendor === 'nan' ? <NanBuilder appId={appId} cfg={nanCfg} onPlaced={afterChange} /> : null}
        {vendor === 'class' ? <ClassBuilder appId={appId} cfg={classCfg} onPlaced={afterChange} /> : null}
        {vendor === 'rv' ? <RicherValueBuilder appId={appId} cfg={rvCfg} onPlaced={afterChange} /> : null}
      </div>

      {/* ── ONE collapsed drawer for drafts + failed + closed, across both vendors. */}
      {drawerCount ? (
        <PastAndFailedDrawer failed={failed} drafts={drafts} closed={closed}
          defaultOpen={!active.length && !!failed.length} appId={appId} onChanged={afterChange} />
      ) : null}

      {!active.length && !drawerCount ? (
        <div className="aord-empty">No appraisal orders on this file yet — build one above.</div>
      ) : null}

      {payFor ? (
        <PayModal appId={appId} order={payFor} card={card}
          onClose={() => setPayFor(null)}
          onPaid={async () => { await afterChange(); }} />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- header --- */
function VendorSelector({ vendor, onPick }) {
  // NAN IS FIRST AND IS WHERE THIS STARTS. Richer Value is a deliberate third
  // choice for a cheaper, different report — never a default (owner-directed
  // 2026-08-14). Do not reorder these to put a new vendor in front.
  return (
    <div className="seg" role="group" aria-label="Appraisal vendor">
      {[['nan', 'AppraisalScope / NAN'], ['class', 'Class'], ['rv', 'Richer Value']].map(([k, lbl]) => (
        <button key={k} type="button" className={vendor === k ? 'on' : ''} aria-pressed={vendor === k}
          onClick={() => onPick(k)}>{lbl}</button>
      ))}
    </div>
  );
}

function VendorStatusChip({ cfg }) {
  let dot = SOFT, text = 'Not set up yet';
  if (cfg) {
    if (cfg.enabled) {
      dot = cfg.outbound ? GOOD : '#8A5F14';
      text = 'Connected · sending ' + (cfg.outbound ? 'on' : 'off') + (cfg.dryrun ? ' · test mode' : '');
    } else {
      dot = '#8A5F14';
      text = 'Not turned on yet — you can still see what would be sent';
    }
  }
  return (
    <span className="aord-conn">
      <span className="d" style={{ background: dot }} />
      {text}
    </span>
  );
}

/* ============================================================ NAN builder === */
// Ported from AmcAppraisalPanel's PreviewCard + place flow (the strongest NAN
// enhancements — form picker, client-shown picker, field grid, amber caution +
// "what PILOT filled" blocks). Orders / detail / drawer moved to the shared shell.
function NanBuilder({ appId, cfg, onPlaced }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [formOverride, setFormOverride] = useState('');
  const [cdorOverride, setCdorOverride] = useState('');

  const overrideParams = useCallback(() => {
    const o = {};
    if (formOverride) o.productCode = formOverride;
    if (cdorOverride) o.clientDisplayedId = cdorOverride;
    return o;
  }, [formOverride, cdorOverride]);

  const load = useCallback(async () => {
    try {
      const params = overrideParams();
      setPreview(await api.amcPreview(appId, Object.keys(params).length ? params : undefined).catch(() => null));
    } catch (_) { setPreview(null); }
  }, [appId, overrideParams]);

  useEffect(() => { load(); }, [load]);

  const place = useCallback(async (doPlace) => {
    setBusy(true); setNotice(''); setErr('');
    try {
      const out = await api.amcPlaceOrder(appId, { place: doPlace, ...overrideParams() });
      if (!out.ok) setErr(parseOrderFailure(null, out));
      else {
        setNotice(doPlace ? (out.dryrun ? 'Order built in test mode (nothing sent).' : 'Order placed with AppraisalScope / NAN.') : 'Draft saved.');
        await onPlaced();
      }
    } catch (e) { setErr(parseOrderFailure(e, null)); }
    setBusy(false);
  }, [appId, overrideParams, onPlaced]);

  const notConfigured = !cfg || !cfg.enabled;

  return (
    <div style={{ marginTop: 12 }}>
      <OrderFailure info={err} vendor="AppraisalScope / NAN" />
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      {preview ? (
        <PreviewCard preview={preview} busy={busy} onDraft={() => place(false)} onPlace={() => place(true)}
          outbound={!!(cfg && cfg.outbound)}
          formValue={formOverride || (preview.spec && preview.spec.productCode) || ''} onPickForm={setFormOverride}
          cdorValue={cdorOverride || (preview.spec && preview.spec.clientDisplayedId) || ''} onPickCdor={setCdorOverride} />
      ) : (
        <div style={{ color: MUTED, fontSize: 13 }}>
          {notConfigured
            ? 'Once the CoreLogic / AppraisalScope login is set up and switched on, the order preview shows here.'
            : 'This file could not be loaded for an AppraisalScope / NAN order.'}
        </div>
      )}
    </div>
  );
}

function PreviewCard({ preview, busy, onDraft, onPlace, outbound, formValue, onPickForm, cdorValue, onPickCdor }) {
  const spec = preview.spec || {};
  const missing = preview.missing || [];
  const cardOnFile = preview.card || {};
  const prop = spec.property || {};
  const loan = spec.loan || {};
  const forms = preview.forms || [];
  const notifyEmails = preview.notifyEmails || [];
  const assumptions = preview.assumptions || [];
  const code = String(formValue || spec.productCode || '');
  const chosenName = preview.chosenFormName || (forms.find((f) => String(f.id) === code) || {}).name || null;
  const ctx = preview.context || {};
  const cdorOptions = ctx.clientDisplayedOptions || [];
  const cdorCode = String(cdorValue || spec.clientDisplayedId || '');
  const cdorName = (cdorOptions.find((o) => String(o.id) === cdorCode) || {}).name || ctx.clientDisplayedName || null;
  const needsCdorPick = !cdorCode && cdorOptions.length > 1;
  return (
    <div className="aord-inner">
      <div style={{ marginBottom: 12 }}>
        <div className="aord-eyebrow" style={{ margin: '0 0 3px' }}>Form</div>
        <div style={{ fontWeight: 600, color: INK, marginTop: 2 }}>
          {chosenName || (code ? 'Form #' + code : 'No default for this deal — pick one below')}
          {code ? <span style={{ color: MUTED, fontWeight: 400 }}> · #{code}</span> : null}
        </div>
        {forms.length ? (
          <select value={code} onChange={(e) => onPickForm(e.target.value)}
            style={{ marginTop: 6, maxWidth: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
            {!code ? <option value="">Choose a form…</option> : null}
            {forms.map((f) => <option key={f.id} value={String(f.id)}>{f.name ? (f.name + ' (#' + f.id + ')') : ('Form #' + f.id)}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>The form list isn’t loaded yet — it fills in once the appraisal catalog syncs.</div>
        )}
      </div>

      {(cdorOptions.length > 1 || needsCdorPick) ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.3 }}>Client shown on the report</div>
          {cdorName ? <div style={{ fontWeight: 600, color: INK, marginTop: 2 }}>{cdorName}{cdorCode ? <span style={{ color: MUTED, fontWeight: 400 }}> · #{cdorCode}</span> : null}</div> : null}
          <select value={cdorCode} onChange={(e) => onPickCdor(e.target.value)}
            style={{ marginTop: 6, maxWidth: '100%', border: `1px solid ${needsCdorPick ? '#E4B4AE' : LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
            {!cdorCode ? <option value="">Choose the client shown on the report…</option> : null}
            {cdorOptions.map((o) => <option key={o.id} value={String(o.id)}>{o.name ? (o.name + ' (#' + o.id + ')') : ('#' + o.id)}</option>)}
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
        <Field label="Payment card">{cardOnFile.onFile ? ((cardOnFile.brand || 'card') + ' ••' + (cardOnFile.last4 || '')) : 'not on file'}</Field>
      </div>

      {missing.length ? (
        <div style={{ marginTop: 10, color: '#9A3B33', fontSize: 13 }}>
          <strong>Still needed before ordering:</strong> {missing.join(', ')}
        </div>
      ) : <div style={{ marginTop: 10, color: GOOD, fontSize: 13 }}>Ready to order.</div>}

      {notifyEmails.length ? (
        <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
          Update emails from the appraiser will go to: <span style={{ color: INK }}>{notifyEmails.join(', ')}</span>
        </div>
      ) : null}

      {assumptions.some((a) => a.warn) ? (
        <div style={{ marginTop: 10, border: `1px solid ${WARN_LINE}`, borderRadius: 8, padding: '8px 10px', background: WARN_BG }}>
          <div style={{ fontSize: 11, color: WARN, textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>Before you order — please check</div>
          {assumptions.filter((a) => a.warn).map((a) => (
            <div key={a.field} style={{ fontSize: 13, color: INK, marginTop: 4 }}>
              <span style={{ fontWeight: 600, color: WARN }}>⚠ {a.label}:</span> {a.value}
              {a.why ? <span style={{ color: MUTED }}> — {a.why}</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {assumptions.some((a) => !a.warn) ? (
        <details style={{ marginTop: 10, border: `1px solid ${LINE}`, borderRadius: 8, background: '#FBF9F4' }}>
          <summary style={{ cursor: 'pointer', padding: '8px 10px', fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.3, fontWeight: 600 }}>
            Review all fields ({assumptions.filter((a) => !a.warn).length}) — what PILOT filled in for you
          </summary>
          <div style={{ padding: '0 10px 8px' }}>
            {assumptions.filter((a) => !a.warn).map((a) => (
              <div key={a.field} style={{ fontSize: 13, color: INK, marginTop: 6 }}>
                <span style={{ fontWeight: 600 }}>{a.label}:</span> {a.value}
                {a.why ? <span style={{ color: MUTED }}> — {a.why}</span> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div className="aord-acts">
        <button className="aord-btn" disabled={busy} onClick={onDraft}>Save draft</button>
        <button className="aord-btn pri" disabled={busy || missing.length > 0 || !outbound} onClick={onPlace}
          title={!outbound ? 'Turn on sending to the AMC first' : (missing.length ? 'Fill in what’s still needed' : '')}>
          {busy ? 'Working…' : 'Place order'}
        </button>
      </div>
      {!outbound ? (
        <div style={{ marginTop: 10 }}><Banner tone="warn">Sending to the AMC is off — you can save a draft now and place it once it’s turned on.</Banner></div>
      ) : null}
    </div>
  );
}

/* ========================================================== Class builder === */
// Ported from ClassAppraisalPanel's builder (the strongest Class enhancement —
// the server-driven, provenance-coloured, editable field list + legend + "show
// every field" toggle, UAD version picker, product picker, contacts, WhyBox
// block reasons). Placed orders / thread / drawer moved to the shared shell.
const STATE = {
  read: { label: 'From the file', color: MUTED, dot: '#C9C2B2' },
  derived: { label: 'PILOT worked this out', color: GOLD, dot: GOLD },
  overridden: { label: 'You changed this', color: TEAL, dot: TEAL },
  missing: { label: 'Still needed', color: BAD, dot: BAD },
};
const EDITABLE = new Set([
  'apiVersion', 'productId', 'propertyTypeEnum', 'purpose', 'loanType', 'occupancy',
  'referenceNumber', 'street', 'city', 'state', 'zip', 'county', 'dueDate', 'instructions',
]);
const PATH_TO_KEY = { propertyType: 'propertyTypeEnum' };
const overrideKeyFor = (path) => {
  const last = String(path || '').split('.').pop();
  const k = PATH_TO_KEY[last] || last;
  return EDITABLE.has(k) ? k : null;
};
const ENUM_FOR = { propertyTypeEnum: 'propertyTypeEnum', purpose: 'purpose', loanType: 'loanType' };

function ClassBuilder({ appId, cfg, onPlaced }) {
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickedNames, setPickedNames] = useState({});

  const load = useCallback(async (ov) => {
    setErr('');
    try { setPreview(await api.classPreview(appId, ov || {})); }
    catch (e) { setErr(e.message || 'Could not load the order preview.'); }
  }, [appId]);

  useEffect(() => { load({}); }, [load]);

  const setOverride = useCallback((key, value) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value == null || value === '') delete next[key]; else next[key] = value;
      load(next);
      return next;
    });
  }, [load]);

  const clearOverrides = useCallback(() => { setOverrides({}); load({}); }, [load]);

  const place = useCallback(async () => {
    setBusy(true); setErr(''); setNotice('');
    try {
      const out = await api.classPlaceOrder(appId, { confirm: true, overrides });
      if (out && out.ok) {
        setNotice(out.dryrun
          ? 'Test mode — the order was built and written to the log. Nothing was sent to Class.'
          : `Order placed with Class Valuation.${out.orderId ? ' Their order number is ' + out.orderId + '.' : ''}` + (out.warning ? ' ' + out.warning : ''));
        await onPlaced();
        await load(overrides);
      } else setErr(parseOrderFailure(null, out));
    } catch (e) { setErr(parseOrderFailure(e, null)); }
    setBusy(false);
  }, [appId, overrides, load, onPlaced]);

  const options = (preview && preview.options) || {};
  const enums = options.enums || {};
  const occSuggestions = options.occupancySuggestions || [];
  const occIsList = !!options.occupancyIsEnum;
  const fields = (preview && preview.fields) || [];
  const notable = useMemo(
    () => fields.filter((f) => f.state === 'missing' || f.state === 'derived' || f.state === 'overridden'),
    [fields]);
  const shown = showAll ? fields : notable;
  const missing = (preview && preview.missing) || [];
  const canPlace = !!(preview && preview.canPlace);
  const enabled = !!(cfg && cfg.enabled);

  return (
    <div style={{ marginTop: 12 }}>
      <OrderFailure info={err} vendor="Class Valuation" />
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      {preview ? (
        <>
          <VersionRow preview={preview} chosen={overrides.apiVersion} onPick={(v) => setOverride('apiVersion', v)} />
          <ProductRow preview={preview} chosen={overrides.productId} pickedNames={pickedNames} enabled={enabled}
            open={picking} onOpen={() => setPicking((v) => !v)}
            onPick={(id, product) => {
              setPicking(false);
              setOverride('productId', String(id));
              if (product && product.title) setPickedNames((m) => ({ ...m, [String(id)]: product.title }));
            }} />

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <SectionTitle>What we will send to Class</SectionTitle>
            <button type="button" onClick={() => setShowAll((v) => !v)} style={linkBtn}>
              {showAll ? `Show only what needs a look (${notable.length})` : `Show every field (${fields.length})`}
            </button>
            {Object.keys(overrides).length ? <button type="button" onClick={clearOverrides} style={linkBtn}>Undo my changes</button> : null}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            Every line below is a value that goes to the appraiser. Anything PILOT worked out, or still missing, is called out — the rest came straight off the loan file.
          </div>

          <Legend />
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
            {shown.length ? shown.map((f) => (
              <FieldRow key={f.path} field={f} enums={enums} occSuggestions={occSuggestions} occIsList={occIsList}
                value={overrides[overrideKeyFor(f.path)]}
                onChange={(v) => { const k = overrideKeyFor(f.path); if (k) setOverride(k, v); }} />
            )) : (
              <div style={{ padding: 12, color: MUTED, fontSize: 13 }}>Nothing needs a second look — every value came straight off the loan file.</div>
            )}
          </div>

          <Contacts contacts={(preview.body && preview.body.contacts) || []} />

          {(preview.notifyEmails || []).length ? (
            <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
              Update emails from Class will go to: <span style={{ color: INK }}>{(preview.notifyEmails || []).join(', ')}</span>
            </div>
          ) : null}

          {missing.length ? (
            <div style={{ marginTop: 12, color: '#8A2F27', fontSize: 13 }}>
              <strong>Still needed before this can be ordered:</strong>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {missing.map((m) => <li key={m.field} style={{ marginBottom: 2 }}>{m.why || m.field}</li>)}
              </ul>
            </div>
          ) : <div style={{ marginTop: 12, color: GOOD, fontSize: 13 }}>Everything Class needs is filled in.</div>}

          <PlaceOrder cfg={cfg} canPlace={canPlace} busy={busy} onPlace={place} uad={preview.uad}
            derivedCount={fields.filter((f) => f.state === 'derived').length} />
        </>
      ) : (
        <div style={{ color: MUTED, fontSize: 13 }}>This file could not be loaded for a Class Valuation order.</div>
      )}
    </div>
  );
}

function VersionRow({ preview, chosen, onPick }) {
  const versions = preview.versions || [];
  const current = preview.apiVersion;
  const isDefault = !chosen && current === preview.defaultVersion;
  if (versions.length < 2) return null;
  return (
    <div style={{ border: `1px solid ${chosen ? TEAL : LINE}`, borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.03em' }}>Which of their forms</div>
          <div style={{ color: INK, fontWeight: 600 }}>{preview.versionLabel}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {isDefault
              ? 'This is the normal one. The industry is moving to the newer form over the next few months — you can try it on this file without changing anything for anyone else.'
              : 'You picked this for this order only. Everyone else still gets the normal one.'}
          </div>
        </div>
        <div className="seg">
          {versions.map((v) => (
            <button type="button" key={v.version} className={current === v.version ? 'on' : ''}
              aria-pressed={current === v.version}
              onClick={() => onPick(v.version === preview.defaultVersion ? '' : v.version)}>
              UAD {v.uad}{v.version === preview.defaultVersion ? ' (normal)' : ''}
            </button>
          ))}
        </div>
      </div>
      {current !== preview.defaultVersion ? (
        <div style={{ fontSize: 12, color: '#856529', marginTop: 8 }}>
          Heads up: this sends the newer form. Some values below are written differently on it — read them before ordering.
        </div>
      ) : null}
    </div>
  );
}

function ProductRow({ preview, chosen, pickedNames, enabled, open, onOpen, onPick }) {
  const row = (preview.fields || []).find((f) => f.path === 'productId');
  const value = row ? row.value : null;
  const auto = preview.chosenProduct || null;
  const autoName = auto && String(auto.productId) === String(value) && auto.productName ? auto.productName : null;
  const name = autoName || (value != null ? (pickedNames || {})[String(value)] : null) || null;
  return (
    <div style={{ border: `1px solid ${value ? LINE : BAD}`, borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.03em' }}>Which report to order</div>
          <div style={{ color: value ? INK : BAD, fontWeight: 600 }}>
            {value ? (name ? `${name} (#${value})` : `Class product #${value}`) : 'Not chosen yet'}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
            {chosen ? 'You picked this one.'
              : auto ? 'PILOT picked this one for you from the deal — you can change it from their list.'
                : 'Class hasn’t given us a standard report to default to, so this is picked by hand for now.'}
          </div>
        </div>
        <button type="button" className="btn soft" onClick={onOpen} disabled={!enabled}
          title={enabled ? '' : 'Turn the Class Valuation connection on to see their list of reports'}>
          {open ? 'Close the list' : 'Choose from their list'}
        </button>
      </div>
      {open ? <ProductPicker onPick={onPick} /> : null}
    </div>
  );
}

function ProductPicker({ onPick }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.classProducts();
        if (!alive) return;
        if (r && r.available) setRows(r.products || []);
        else { setRows([]); setErr('Their list of reports could not be read right now.'); }
      } catch (e) { if (alive) { setRows([]); setErr(e.message || 'Their list of reports could not be read right now.'); } }
    })();
    return () => { alive = false; };
  }, []);
  const filtered = (rows || []).filter((p) => {
    const t = `${p.title || ''} ${p.alternativeName || ''} ${p.id || ''}`.toLowerCase();
    return !q.trim() || t.includes(q.trim().toLowerCase());
  });
  return (
    <div style={{ marginTop: 10, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
      {rows === null ? <div style={{ color: MUTED, fontSize: 13 }}>Reading their list of reports…</div> : null}
      {err ? <div style={{ color: BAD, fontSize: 13, marginBottom: 6 }}>{err}</div> : null}
      {rows && rows.length ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search their reports…"
            style={{ ...inputStyle, width: '100%', marginBottom: 8 }} />
          <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${LINE}`, borderRadius: 8 }}>
            {filtered.map((p) => (
              <button type="button" key={p.id} onClick={() => onPick(p.id, p)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: '#fff', color: INK, border: 'none', borderTop: `1px solid ${LINE}`, padding: '8px 10px', cursor: 'pointer' }}>
                <span style={{ fontWeight: 550 }}>{p.title || `Product ${p.id}`}</span>
                {p.alternativeName && p.alternativeName !== p.title ? <span style={{ color: MUTED, fontSize: 12 }}> — {p.alternativeName}</span> : null}
                <div style={{ color: MUTED, fontSize: 11 }}>#{p.id}</div>
              </button>
            ))}
            {!filtered.length ? <div style={{ padding: 10, color: MUTED, fontSize: 13 }}>Nothing matches that.</div> : null}
          </div>
        </>
      ) : null}
      {rows && !rows.length && !err ? <div style={{ color: MUTED, fontSize: 13 }}>Class hasn’t given us any reports to choose from.</div> : null}
    </div>
  );
}

function FieldRow({ field, enums, occSuggestions, occIsList, value, onChange }) {
  const st = STATE[field.state] || STATE.read;
  const key = overrideKeyFor(field.path);
  const enumName = key ? ENUM_FOR[key] : null;
  const options = enumName ? (enums[enumName] || []) : null;
  const shownValue = field.value == null || field.value === '' ? '—' : String(field.value);
  return (
    <div style={{ borderTop: `1px solid ${LINE}`, padding: '9px 12px', background: field.state === 'missing' ? '#FDF6F5' : '#fff' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 170, flex: '0 0 auto' }}>
          <div style={{ color: INK, fontWeight: 550 }}>{field.label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <span style={{ width: 7, height: 7, borderRadius: 99, background: st.dot, display: 'inline-block' }} />
            <span style={{ fontSize: 11, color: st.color }}>{st.label}</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          {key ? (
            options ? (
              <select value={value != null ? value : (field.value == null ? '' : String(field.value))}
                onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value="">— not set —</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : key === 'occupancy' ? (
              occIsList ? (
                <select value={value != null ? value : (field.value == null ? '' : String(field.value))}
                  onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                  <option value="">— not set —</option>
                  {occSuggestions.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <>
                  <input list="aord-occ-list" value={value != null ? value : (field.value == null ? '' : String(field.value))}
                    onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
                  <datalist id="aord-occ-list">{occSuggestions.map((o) => <option key={o} value={o} />)}</datalist>
                </>
              )
            ) : (
              <input value={value != null ? value : (field.value == null ? '' : String(field.value))}
                onChange={(e) => onChange(e.target.value)}
                placeholder={field.state === 'missing' ? 'Needed before ordering' : ''}
                style={{ ...inputStyle, width: '100%' }} />
            )
          ) : (
            <div style={{ color: shownValue === '—' ? MUTED : INK, wordBreak: 'break-word' }}>{shownValue}</div>
          )}
          {field.why ? <div style={{ fontSize: 12, color: st.color, marginTop: 4 }}>{field.why}</div> : null}
        </div>
      </div>
    </div>
  );
}

function Contacts({ contacts }) {
  if (!contacts.length) return null;
  const NAME = { Borrower: 'Borrower', Coborrower: 'Co-borrower', PropertyAccess: 'Who lets the appraiser in', LoanOfficer: 'Loan officer' };
  return (
    <div style={{ marginTop: 14 }}>
      <SectionTitle>Who Class will contact</SectionTitle>
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
        {contacts.map((c, i) => (
          <div key={`${c.Type}-${i}`} style={{ borderTop: i ? `1px solid ${LINE}` : 'none', padding: '9px 12px' }}>
            <div style={{ color: INK, fontWeight: 550 }}>
              {[c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name on file)'}
              {c.primaryContact ? <span style={{ color: TEAL, fontSize: 12, fontWeight: 600 }}> · main contact</span> : null}
            </div>
            <div style={{ fontSize: 12, color: MUTED }}>
              {NAME[c.Type] || c.Type}
              {(c.contactMethods || []).length ? ' · ' + c.contactMethods.map((m) => m.value).join(' · ') : ' · no phone or email on file'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WhyBox({ title, children }) {
  return (
    <div style={{ marginTop: 10, border: `1px solid ${GOLD}`, background: '#FBF6EC', borderRadius: 8, padding: '9px 11px' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{title}</div>
      <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3, lineHeight: 1.45 }}>{children}</div>
    </div>
  );
}

function PlaceOrder({ cfg, canPlace, busy, onPlace, uad, derivedCount }) {
  const on = !!(cfg && cfg.enabled);
  const outbound = !!(cfg && cfg.outbound);
  const dry = !!(cfg && cfg.dryrun);
  const block = !canPlace
    ? { title: 'Fill in what’s still needed above first.', help: 'The list just above shows exactly what Class still needs before this can go out.' }
    : !on ? { title: 'Class ordering is switched off.', help: 'On the API Health page, turn ON both “Order appraisals from Class Valuation (reading)” and “Place appraisal orders with Class Valuation (write)”.' }
      : !outbound ? { title: 'This is ready — but sending to Class is still switched off.', help: 'To actually send it, turn ON “Place appraisal orders with Class Valuation (write)” on the API Health page. The reading switch on its own does NOT send orders.' }
        : null;
  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${LINE}`, paddingTop: 14 }}>
      {derivedCount ? (
        <div style={{ fontSize: 13, color: '#856529', marginBottom: 8 }}>
          {derivedCount === 1 ? 'One value was' : `${derivedCount} values were`} worked out by PILOT rather than read off the file. Please read {derivedCount === 1 ? 'it' : 'them'} above before ordering — you can change {derivedCount === 1 ? 'it' : 'them'} on the spot.
        </div>
      ) : null}
      <button className="aord-btn pri" disabled={busy || !!block} onClick={onPlace} title={block ? block.title : ''}>
        {busy ? 'Working…' : dry ? 'Build the order (test mode — nothing is sent)' : 'Place order'}
      </button>
      <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>Goes out on their {uad} form.</div>
      {block ? <WhyBox title={block.title}>{block.help}</WhyBox>
        : dry ? <WhyBox title="Test mode is on — this button will NOT send anything.">To place the order for real, turn OFF “Class Valuation orders — TEST MODE” on the API Health page.</WhyBox>
          : <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>This costs money and sends an appraiser to the property.</div>}
    </div>
  );
}

/* =================================================== Richer Value builder === */
/*
 * The Hybrid Appraisal builder.
 *
 * SAME SHAPE AS THE OTHER TWO: the SERVER builds the order and hands back every
 * field that would be sent, labelled with where its value came from; the screen
 * renders that and posts overrides back. It never decides what is required, never
 * re-derives a value and never keeps its own copy of the vendor's rules — a rule
 * living in two places is a rule that drifts.
 *
 * TWO THINGS ARE SAID BEFORE ANYBODY ORDERS, not after:
 *   • WHAT IT COSTS, priced for THIS property (their pricing moves with the state
 *     and the ZIP), broken into the report, the inspection and the rush fee.
 *   • WHAT IT DOES TO THE APPRAISAL CONDITION — ordering this waives the appraisal
 *     data file, because the product does not produce one. A surprise about a
 *     condition is worse than a slower screen.
 */
function RicherValueBuilder({ appId, cfg, onPlaced }) {
  const [preview, setPreview] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [showAll, setShowAll] = useState(false);
  // How this order gets paid. It starts as whatever the server says it will do,
  // and the staffer can change it before ordering. The card typed here NEVER
  // becomes part of `overrides` — it goes over on its own, to be saved encrypted
  // through the shared card chokepoint and charged, and it is wiped afterwards.
  const [payMethod, setPayMethod] = useState(null);
  const [newCard, setNewCard] = useState({ number: '', cvc: '', expMonth: '', expYear: '', zip: '' });
  const [linkTo, setLinkTo] = useState('');

  const load = useCallback(async (ov) => {
    setErr('');
    try { setPreview(await api.rvPreview(appId, ov || {})); }
    catch (e) { setErr(e.message || 'Could not load the order preview.'); }
  }, [appId]);

  useEffect(() => { load({}); }, [load]);

  // Adopt the server's own choice ONCE, then leave it alone — re-adopting on every
  // preview refresh would undo the staffer's pick on the next keystroke.
  useEffect(() => {
    if (payMethod == null && preview && preview.payment && preview.payment.method) {
      setPayMethod(preview.payment.method);
    }
  }, [preview, payMethod]);

  const setOverride = useCallback((key, value) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value == null || value === '') delete next[key]; else next[key] = value;
      load(next);
      return next;
    });
  }, [load]);

  const clearOverrides = useCallback(() => { setOverrides({}); load({}); }, [load]);

  const place = useCallback(async () => {
    const guard = (preview && preview.loanGuard) || null;
    const pay = (preview && preview.payment) || {};

    // THE DOUBLE CONFIRMATION. The owner asked for two, and they say DIFFERENT
    // things on purpose: the first is about the number, the second is about what
    // it costs us if an investor refuses the report. The server checks the token
    // as well, so a screen that skipped this cannot order anyway.
    const acknowledgements = [];
    if (guard && guard.requiresDoubleConfirm) {
      if (!(await askConfirm(guard.confirmPrompt, { title: guard.title, confirmLabel: 'Order it anyway' }))) return;
      if (!(await askConfirm(guard.secondPrompt, { title: 'Are you sure?', confirmLabel: 'Yes, order it' }))) return;
      acknowledgements.push(guard.ack);
    }

    setBusy(true); setErr(''); setNotice('');
    try {
      const out = await api.rvPlaceOrder(appId, {
        confirm: true,
        acknowledgements,
        payWith: payMethod,
        card: payMethod === 'NEW_CARD' ? newCard : null,
        paymentLinkTo: payMethod === 'PAYMENT_LINK' ? (linkTo || pay.borrowerEmail || null) : null,
        ...overrides,
      });
      if (out && out.ok) {
        const bits = [out.dryrun
          ? 'Test mode — the order was built and written to the log. Nothing was sent to Richer Value.'
          : 'Order placed with Richer Value.'];
        if (out.xmlWaiver && out.xmlWaiver.applied) {
          bits.push('The appraisal data file (XML) is now waived on this file — this report does not produce one.');
        }
        // Whatever paying actually did is on the order row in words — including the
        // fall-through to a payment link, which is a real outcome and not a failure.
        if (out.order && out.order.last_error) bits.push(out.order.last_error);
        else if (out.order && out.order.paid_at) bits.push('It has been paid, so it is a real order now.');
        if (out.scopeOfWork && out.scopeOfWork.warning) bits.push(out.scopeOfWork.warning);
        setNotice(bits.join(' '));
        setNewCard({ number: '', cvc: '', expMonth: '', expYear: '', zip: '' });
        await onPlaced();
        await load(overrides);
      } else setErr(parseOrderFailure(null, out));
    } catch (e) { setErr(parseOrderFailure(e, null)); }
    setBusy(false);
  }, [appId, overrides, load, onPlaced, preview, payMethod, newCard, linkTo]);

  const cat = (preview && preview.catalogue) || {};
  const opts = (preview && preview.options) || {};
  const choices = (preview && preview.choices) || {};
  const rows = (preview && preview.rows) || [];
  const notable = useMemo(() => rows.filter((r) => r.provenance !== 'read'), [rows]);
  const shown = showAll ? rows : notable;
  const enabled = !!(cfg && cfg.enabled);
  const price = (preview && preview.price && preview.price.single_report_amount) || null;
  const waive = (preview && preview.xmlWaiver) || null;

  if (!preview && !err) return <div style={{ marginTop: 12, color: MUTED, fontSize: 13 }}>Loading the order…</div>;

  return (
    <div style={{ marginTop: 12 }}>
      <OrderFailure info={err} vendor="Richer Value" />
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      {preview && preview.blocked ? <Banner tone="warn">{preview.blocked}</Banner> : null}

      {preview ? (
        <>
          {/* ── what we are buying ─────────────────────────────────────── */}
          <div className="aord-row3">
            <Field label="Report">
              <select className="input" value={choices.reportType || ''}
                onChange={(e) => setOverride('reportType', e.target.value)}>
                {(cat.reportTypes || []).map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}{t.baseFee != null ? ` — ${money(t.baseFee)}` : ''}
                  </option>
                ))}
                {!(cat.reportTypes || []).length ? <option value="">(their list is not loaded)</option> : null}
              </select>
            </Field>
            <Field label="Inspection">
              <select className="input" value={choices.inspectionType == null ? '' : choices.inspectionType}
                onChange={(e) => setOverride('inspectionType', e.target.value)}>
                {(cat.inspectionTypes || []).map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}{t.fee ? ` — +${money(t.fee)}` : (t.slug === 'none' ? '' : ' — included')}
                  </option>
                ))}
                {!(cat.inspectionTypes || []).length ? <option value="">(their list is not loaded)</option> : null}
              </select>
            </Field>
            <Field label="How fast">
              <select className="input" value={choices.turnaroundTime || ''}
                onChange={(e) => setOverride('turnaroundTime', e.target.value)}>
                {(cat.turnaroundTimes || []).map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}{t.text ? ` (${t.text})` : ''}{t.fee ? ` — +${money(t.fee)}` : ''}
                  </option>
                ))}
                {!(cat.turnaroundTimes || []).length ? <option value="">(their list is not loaded)</option> : null}
              </select>
            </Field>
          </div>

          {cat.stale ? (
            <div style={{ fontSize: 12, color: WARN, marginTop: 6 }}>
              Richer Value’s list of what we can order could not be refreshed just now, so this is the last one we saw
              {cat.fetchedAt ? ` (${fmtWhen(cat.fetchedAt)})` : ''}. You can still order.
            </div>
          ) : null}

          {/* ── the add-ons ─────────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12, fontSize: 13, color: INK }}>
            <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!choices.glaInclude}
                onChange={(e) => setOverride('glaInclude', e.target.checked ? '1' : '0')} />
              Measure the living area + floor plan
            </label>
            <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!choices.licensingRequired}
                onChange={(e) => setOverride('licensingRequired', e.target.checked ? '1' : '0')} />
              Require a licensed inspector
            </label>
            <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!choices.includeFloodCertification}
                onChange={(e) => setOverride('includeFloodCertification', e.target.checked ? '1' : '0')} />
              Include their flood certificate
            </label>
          </div>
          {choices.includeFloodCertification ? (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 5 }}>
              PILOT already orders a flood determination on every file, so this is usually a second one you do not need.
            </div>
          ) : null}

          {/* ── what it costs, for this property ────────────────────────── */}
          {price ? (
            <div className="aord-figs" style={{ gridTemplateColumns: '1fr' }}>
              <div className="aord-fig">
                <div className="k">Price for this property</div>
                <div className="v">{money(price.total_price)}</div>
                <div className="n">
                  {[
                    price.report_type_fee ? `report ${money(price.report_type_fee)}` : null,
                    price.inspection_fee ? `inspection ${money(price.inspection_fee)}` : null,
                    price.rush_fee ? `rush ${money(price.rush_fee)}` : null,
                    price.gla_surcharge ? `floor plan ${money(price.gla_surcharge)}` : null,
                    price.licensing_surcharge ? `licensed ${money(price.licensing_surcharge)}` : null,
                    price.flood_charge ? `flood ${money(price.flood_charge)}` : null,
                  ].filter(Boolean).join(' · ')}
                  {price.due_date ? ` · report due ${fmtDate(price.due_date)}` : ''}
                </div>
              </div>
            </div>
          ) : preview.priceError ? (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
              Richer Value could not price this right now, so the figure above is not shown. You can still order.
            </div>
          ) : null}

          {/* ── what ordering does to the appraisal condition ───────────── */}
          {waive ? (
            <div className="aord-waive">
              <b>The appraisal data file:</b> {waive.note}
            </div>
          ) : null}

          {/* ── every field that would be sent ──────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
            <SectionTitle>What we will send to Richer Value</SectionTitle>
            <button type="button" onClick={() => setShowAll((v) => !v)} style={linkBtn}>
              {showAll ? `Show only what needs a look (${notable.length})` : `Show every field (${rows.length})`}
            </button>
            {Object.keys(overrides).length ? <button type="button" onClick={clearOverrides} style={linkBtn}>Undo my changes</button> : null}
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            Anything PILOT worked out, or still missing, is called out — the rest came straight off the loan file.
            {preview.context && preview.context.warehouseHit
              ? ' Some of the property details came from an appraisal PILOT has seen of this same property before; please check them.'
              : ''}
          </div>

          <Legend />
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
            {shown.length ? shown.map((r) => (
              <RvFieldRow key={r.field} row={r} options={opts}
                value={overrides[rvOverrideKey(r.field)]}
                onChange={(v) => { const k = rvOverrideKey(r.field); if (k) setOverride(k, v); }} />
            )) : (
              <div style={{ padding: 12, color: MUTED, fontSize: 13 }}>
                Nothing needs a second look — every value came straight off the loan file.
              </div>
            )}
          </div>

          {/* ── things Richer Value refuses on this branch ──────────────── */}
          {(preview.dropped || []).length ? (
            <WhyBox title={`${preview.dropped.length} field${preview.dropped.length === 1 ? '' : 's'} left out on purpose`}>
              {preview.dropped.map((d) => (
                <div key={d.field} style={{ marginTop: 3 }}>
                  <b>{d.field}</b> — {d.why}
                </div>
              ))}
            </WhyBox>
          ) : null}

          <RvScopeOfWork sow={preview.scopeOfWork} />
          <RvPayment
            payment={preview.payment} method={payMethod} onMethod={setPayMethod}
            card={newCard} onCard={setNewCard} linkTo={linkTo} onLinkTo={setLinkTo} />
          <RvLoanGuard guard={preview.loanGuard} />
          <RvPlaceOrder cfg={cfg} preview={preview} busy={busy} onPlace={place} enabled={enabled} price={price} />
        </>
      ) : null}
    </div>
  );
}

/**
 * Their field name → the override key the server accepts. A field with no key is
 * one the screen may SHOW but not change (the vendor tokens, the derived booleans
 * that have their own checkbox above) — returning null is what makes those rows
 * read-only rather than a control that silently does nothing.
 */
const RV_OVERRIDE_KEYS = {
  property_address: 'propertyAddress', property_address_line_2: 'propertyAddressLine2',
  unit_number: 'unitNumber', city: 'city', state: 'state', postal_code: 'postalCode',
  residential_property_type: 'residentialPropertyType', residential_prop_type_units: 'residentialPropTypeUnits',
  property_condition: 'propertyCondition',
  above_grade_sqft: 'aboveGradeSqft', below_grade_sqft: 'belowGradeSqft',
  bedrooms: 'bedrooms', bathrooms: 'bathrooms', year_built: 'yearBuilt',
  lot_size_square_feet: 'lotSizeSquareFeet', stories: 'stories', garage_spaces: 'garageSpaces',
  proposed_above_grade_sqft: 'proposedAboveGradeSqft', proposed_below_grade_sqft: 'proposedBelowGradeSqft',
  proposed_bedrooms: 'proposedBedrooms', proposed_bathrooms: 'proposedBathrooms',
  borrower_budget: 'borrowerBudget', borrower_name: 'borrowerName',
  closing_date: 'closingDate', effective_date: 'effectiveDate',
  lockbox_code: 'lockboxCode', lockbox_location: 'lockboxLocation', lockbox_entrance: 'lockboxEntrance',
  gate_code: 'gateCode',
  report_contact_name: 'reportContactName', report_contact_email: 'reportContactEmail',
  report_contact_phone: 'reportContactPhone',
  inspection_notes_or_instruction: 'inspectionNotes',
  valuation_commentary_or_instruction: 'valuationNotes',
  notes: 'notes',
};
function rvOverrideKey(field) { return RV_OVERRIDE_KEYS[field] || null; }

/** The picker a field gets, when the vendor's vocabulary is a closed list. */
const RV_PICKERS = {
  property_condition: (o) => o.propertyConditions,
  residential_property_type: (o) => o.residentialTypes,
  lockbox_location: (o) => o.lockboxLocations,
  lockbox_entrance: (o) => o.lockboxEntrances,
};

function RvFieldRow({ row, options, value, onChange }) {
  const key = rvOverrideKey(row.field);
  const picker = RV_PICKERS[row.field] ? RV_PICKERS[row.field](options || {}) : null;
  const tone = row.provenance === 'missing' ? BAD
    : row.provenance === 'derived' ? '#8A5F14'
      : row.provenance === 'overridden' ? TEAL : SOFT;
  const tag = row.provenance === 'missing' ? 'needed'
    : row.provenance === 'derived' ? 'PILOT filled this in'
      : row.provenance === 'overridden' ? 'you changed this' : '';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 1fr) minmax(160px, 1.2fr)', gap: 10,
      alignItems: 'center', padding: '9px 11px', borderTop: `1px solid ${LINE}` }}>
      <div>
        <div style={{ fontSize: 13, color: INK, fontWeight: 550 }}>{row.label}</div>
        {tag ? <div style={{ fontSize: 11, color: tone, marginTop: 1 }}>{tag}</div> : null}
        {row.why ? <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2, lineHeight: 1.4 }}>{row.why}</div> : null}
      </div>
      <div>
        {key ? (
          picker ? (
            <select className="input" value={value != null ? value : ''} onChange={(e) => onChange(e.target.value)}>
              <option value="">{row.value != null ? String(row.value) : '— pick one —'}</option>
              {picker.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          ) : (
            <input className="input" value={value != null ? value : ''}
              placeholder={row.value != null ? String(row.value) : 'not set'}
              onChange={(e) => onChange(e.target.value)} />
          )
        ) : (
          <div style={{ fontSize: 13, color: row.value == null ? SOFT : INK }}>
            {row.value == null ? '—' : String(row.value)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── the scope of work, which decides "Ordered" vs "On Hold" ─────────────── */
/*
 * MEASURED against Richer Value's own training tenant: the same order WITH a scope
 * of work came back "Ordered" and WITHOUT one came back "On Hold". So this is not a
 * nicety on the screen — it is the difference between an appraiser starting today
 * and the file sitting in their queue, and it is said BEFORE the button.
 */
function RvScopeOfWork({ sow }) {
  if (!sow) return null;
  return (
    <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10,
      border: `1px solid ${sow.present ? LINE : WARN}`,
      background: sow.present ? 'transparent' : '#FDF7EC' }}>
      <div style={{ fontSize: 13, color: INK, fontWeight: 550 }}>
        {sow.present ? 'The scope of work goes with this order' : 'No scope of work on this file yet'}
      </div>
      <div style={{ fontSize: 12, color: MUTED, marginTop: 3, lineHeight: 1.45 }}>
        {sow.present
          ? <>PILOT attaches <b>{sow.filename}</b> automatically, so Richer Value can value the property after the work.</>
          : sow.why}
      </div>
      {sow.warning ? <div style={{ fontSize: 12, color: WARN, marginTop: 4 }}>{sow.warning}</div> : null}
    </div>
  );
}

/* ── how it gets paid ────────────────────────────────────────────────────── */
/*
 * Exactly the three ways the owner allows. Add to Invoice and ACH are not shown
 * because they are not offered at all — a control for something the server refuses
 * is worse than no control.
 */
const RV_PAY_LABEL = {
  CARD_ON_FILE: 'Charge the card on this file',
  NEW_CARD: 'Enter a card now',
  PAYMENT_LINK: 'Send the borrower a payment link',
};

function RvPayment({ payment, method, onMethod, card, onCard, linkTo, onLinkTo }) {
  if (!payment) return null;
  const methods = payment.methods || ['CARD_ON_FILE', 'NEW_CARD', 'PAYMENT_LINK'];
  const chosen = method || payment.method || 'CARD_ON_FILE';
  const set = (k, v) => onCard({ ...card, [k]: v });

  return (
    <div style={{ marginTop: 14 }}>
      <SectionTitle>How this order gets paid</SectionTitle>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 13, color: INK }}>
        {methods.map((m) => (
          <label key={m} style={{ display: 'inline-flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" name="rv-pay" checked={chosen === m} onChange={() => onMethod(m)} />
            {RV_PAY_LABEL[m] || m}
          </label>
        ))}
      </div>

      {chosen === 'CARD_ON_FILE' ? (
        <div style={{ fontSize: 12, color: payment.card && payment.card.expired ? WARN : MUTED, marginTop: 6, lineHeight: 1.45 }}>
          {payment.note}
        </div>
      ) : null}

      {chosen === 'NEW_CARD' ? (
        <>
          <div style={{ fontSize: 12, color: MUTED, margin: '6px 0 8px', lineHeight: 1.45 }}>
            This card is saved onto the file’s appraisal-card condition first — encrypted, the same way every card here
            is — and then charged. So entering it also answers that condition.
          </div>
          <div className="aord-row3">
            <Field label="Card number">
              <input className="input" inputMode="numeric" autoComplete="off" value={card.number}
                onChange={(e) => set('number', e.target.value)} />
            </Field>
            <Field label="Expiry month">
              <input className="input" inputMode="numeric" placeholder="MM" value={card.expMonth}
                onChange={(e) => set('expMonth', e.target.value)} />
            </Field>
            <Field label="Expiry year">
              <input className="input" inputMode="numeric" placeholder="YYYY" value={card.expYear}
                onChange={(e) => set('expYear', e.target.value)} />
            </Field>
          </div>
          <div className="aord-row3">
            <Field label="Security code">
              <input className="input" inputMode="numeric" autoComplete="off" value={card.cvc}
                onChange={(e) => set('cvc', e.target.value)} />
            </Field>
            <Field label="Billing ZIP">
              <input className="input" inputMode="numeric" value={card.zip}
                onChange={(e) => set('zip', e.target.value)} />
            </Field>
          </div>
        </>
      ) : null}

      {chosen === 'PAYMENT_LINK' ? (
        <Field label="Email the payment link to">
          <input className="input" type="email" value={linkTo}
            placeholder={payment.borrowerEmail || 'the borrower’s email'}
            onChange={(e) => onLinkTo(e.target.value)} />
        </Field>
      ) : null}

      {chosen === 'PAYMENT_LINK' ? (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 5, lineHeight: 1.45 }}>
          The order is placed either way — Richer Value starts work once the borrower has paid.
        </div>
      ) : null}
    </div>
  );
}

/* ── the $400,000 rule ───────────────────────────────────────────────────── */
/*
 * Owner-directed: over $400,000 we do not recommend this product and our investors
 * might not accept it, so the warning is STRICT and ordering asks twice (the second
 * confirmation is enforced on the server too). With no loan amount registered it is
 * advice, not a refusal — a brand-new file must still be able to order.
 */
function RvLoanGuard({ guard }) {
  if (!guard || guard.level === 'ok') return null;
  const strict = guard.level === 'warn';
  return (
    <div style={{ marginTop: 14, padding: '11px 13px', borderRadius: 10,
      border: `1px solid ${strict ? BAD : WARN}`,
      background: strict ? '#FDF1F1' : '#FDF7EC' }}>
      <div style={{ fontSize: 13.5, color: strict ? BAD : INK, fontWeight: 650 }}>{guard.title}</div>
      <div style={{ fontSize: 12.5, color: INK, marginTop: 4, lineHeight: 1.5 }}>{guard.message}</div>
      {strict ? (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 5 }}>
          You will be asked to confirm this twice before the order goes.
        </div>
      ) : null}
    </div>
  );
}

function RvPlaceOrder({ cfg, preview, busy, onPlace, enabled, price }) {
  const missing = (preview && preview.missing) || [];
  const canPlace = !!(preview && preview.canPlace);
  const dry = !!(cfg && cfg.dryrun);
  const outbound = !!(cfg && cfg.outbound);

  let block = null;
  if (!enabled) block = { title: 'Richer Value is not turned on yet.', help: 'You can see exactly what would be sent. Turn on “Order Hybrid Appraisals from Richer Value” on the API Health page to order for real.' };
  else if (cfg && !cfg.orderReady) block = { title: 'Richer Value is not fully set up yet.', help: 'A sign-in or an API token is set, but PILOT still needs to know which of their companies to order for. See the API Health page.' };
  else if (preview && preview.blocked) block = { title: 'This property cannot be ordered on this product.', help: preview.blocked };
  else if (missing.length) {
    block = {
      title: `${missing.length} thing${missing.length === 1 ? '' : 's'} still needed before this can be ordered.`,
      help: missing.map((m) => `${m.label}${m.why ? ` — ${m.why}` : ''}`).join(' · '),
    };
  } else if (!outbound && !dry) block = { title: 'Ordering is switched off.', help: 'Turn on “Place Hybrid Appraisal orders with Richer Value” on the API Health page.' };

  return (
    <div style={{ marginTop: 16 }}>
      <button className="btn primary" disabled={busy || !canPlace || (!outbound && !dry)}
        aria-disabled={busy || !canPlace} onClick={onPlace}>
        {busy ? 'Ordering…' : dry ? 'Build the order (test mode)'
          : price ? `Order the Hybrid Appraisal — ${money(price.total_price)}` : 'Order the Hybrid Appraisal'}
      </button>
      {block ? <WhyBox title={block.title}>{block.help}</WhyBox>
        : dry ? <WhyBox title="Test mode is on — this button will NOT send anything.">To place the order for real, turn OFF “Richer Value orders — TEST MODE” on the API Health page.</WhyBox>
          : (
            <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>
              This costs money{price ? ` (${money(price.total_price)})` : ''} and sends an inspector to the property.
              It also waives the appraisal data file on this file — this report does not produce one.
            </div>
          )}
    </div>
  );
}

/* =============================================== Richer Value order card === */
/*
 * An evaluation has no appraiser to message and no documents to exchange, so this
 * card shows what the other two do not have: THE TWO FIGURES. It also carries the
 * one action that exists because the automatic write can legitimately be refused —
 * "Put these on the file" — which is what a frozen file or a value somebody has
 * already decided by hand leaves for a human to settle.
 */
function RvOrderCard({ order, onChanged }) {
  const ad = ADAPTERS.rv;
  const [detail, setDetail] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try { setDetail(await api.rvOrder(order.id)); } catch (_) { setDetail(null); }
  }, [order.id]);
  useEffect(() => { if (open && !detail) load(); }, [open, detail, load]);

  const run = useCallback(async (what, fn, okMsg) => {
    setBusy(what); setErr(''); setNotice('');
    try {
      const out = await fn();
      // A ROUTE THAT ANSWERS 200 HAS NOT NECESSARILY DONE THE THING. Paying is the
      // case that matters: a card charge Richer Value refuses falls through to the
      // payment link and comes back `ok:false` with the reason in `note` — and
      // announcing "charged, it is a real order now" over that would be a false
      // success on a MONEY action, which is the one place it must never happen.
      // Every other action here answers `ok:true`, so they are unaffected.
      if (out && out.ok === false) setErr(out.note || out.detail || 'That did not go through.');
      else setNotice((out && out.note) || okMsg || 'Done.');
      if (out && out.order) setDetail(out);
      await onChanged();
    } catch (e) { setErr(e.message || 'That did not work.'); }
    setBusy('');
  }, [onChanged]);

  const statusLabel = RV_STATUS_LABEL[order.status] || STATUS_LABEL[order.status] || order.status;
  const sc = statusColor(order.status === 'intake' ? 'ordered' : order.status);
  const report = detail && detail.report;
  // Through the shared money parser, never a bare Number(): these arrive from a
  // numeric column as a STRING, and the one rule for what a money string means
  // lives in `lib/money.js` — a second reading here is how two screens come to
  // disagree about one figure.
  const asIs = order.as_is_value != null ? moneyNum(order.as_is_value) : (report ? report.asIs : null);
  const arv = order.arv != null ? moneyNum(order.arv) : (report ? report.arv : null);
  const applied = !!order.values_applied_at;

  const bits = [];
  if (order.client_loan_number) bits.push(order.client_loan_number);
  const numLabel = ad.orderNumber(order);
  if (numLabel) bits.push(numLabel);
  bits.push('ordered ' + fmtDate(ad.orderedAt(order)));
  if (order.due_date) bits.push('due ' + fmtDate(order.due_date));
  if (order.dryrun) bits.push('test');

  return (
    <div className="aord-card">
      <div className="aord-h">
        <span className="aord-tag rv"><span className="d" />{ad.stamp}</span>
        <div className="grow">
          <div className="aord-title">{ad.orderTitle(order)}</div>
          <div className="aord-sub">{bits.join(' · ')}</div>
        </div>
        <span className="aord-pill" style={{ background: sc + '18', color: sc }}>{statusLabel}</span>
      </div>

      {order.vendor_status || order.vendor_inspection_status ? (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
          Richer Value says: {order.vendor_status || '—'}
          {order.vendor_inspection_status ? ` · inspection ${order.vendor_inspection_status}` : ''}
          {order.inspection_scheduled_date ? ` · booked ${fmtDate(order.inspection_scheduled_date)}` : ''}
        </div>
      ) : null}

      {err ? <Banner tone="bad">{err}</Banner> : null}
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      {order.last_error ? <Banner tone="warn">{order.last_error}</Banner> : null}

      {/* THE TWO FIGURES — the whole reason this product was bought. */}
      {(asIs != null || arv != null) ? (
        <div className="aord-figs">
          <div className="aord-fig">
            <div className="k">As-Is value</div>
            <div className="v">{money(asIs)}</div>
            <div className="n">{applied ? 'on the loan file' : 'not on the file yet'}</div>
          </div>
          <div className="aord-fig">
            <div className="k">After repair value</div>
            <div className="v">{money(arv)}</div>
            <div className="n">
              {order.arv_basis && order.arv_basis !== 'best'
                ? `their ${order.arv_basis} renovation strategy`
                : 'their recommended renovation strategy'}
            </div>
          </div>
        </div>
      ) : null}

      <div className="aord-acts">
        <button className="aord-btn" disabled={!!busy}
          onClick={() => run('refresh', () => api.rvRefresh(order.id), 'Checked with Richer Value.')}>
          {busy === 'refresh' ? 'Checking…' : 'Check with Richer Value'}
        </button>
        {asIs != null && arv != null && !applied ? (
          <button className="aord-btn pri" disabled={!!busy}
            onClick={() => run('apply', () => api.rvApplyValues(order.id), 'The As-Is value and the ARV are now on the file.')}>
            {busy === 'apply' ? 'Putting them on the file…' : 'Put these on the file'}
          </button>
        ) : null}
        {!order.pdf_document_id && (order.status === 'completed') ? (
          <button className="aord-btn" disabled={!!busy}
            onClick={() => run('report', () => api.rvFetchReport(order.id), 'The report is now on the appraisal condition.')}>
            {busy === 'report' ? 'Fetching…' : 'Fetch the report'}
          </button>
        ) : null}
        {!order.paid_at && order.intake_token ? (
          <>
            <button className="aord-btn" disabled={!!busy}
              onClick={() => run('pay', () => api.rvPay(order.id, { method: 'CARD_ON_FILE' }),
                'Charged the card on this file — it is a real order now.')}>
              {busy === 'pay' ? 'Charging…' : 'Charge the card on file'}
            </button>
            <button className="aord-btn" disabled={!!busy}
              onClick={() => run('link', () => api.rvPay(order.id, { method: 'PAYMENT_LINK' }),
                'Richer Value has emailed the borrower their payment link.')}>
              {busy === 'link' ? 'Sending…' : 'Send the borrower a payment link'}
            </button>
          </>
        ) : null}
        {/* THE REVISION: our scope of work changed, so theirs has to. What it will
            actually do — update the order, send the file, or reopen a finished
            report — is decided by the order's own state on the server. */}
        {order.intake_token && !order.dryrun && !['cancelled', 'rejected'].includes(order.status) ? (
          <button className="aord-btn" disabled={!!busy} onClick={async () => {
            if (!(await askConfirm(
              'Send Richer Value the scope of work as it stands on this file now? If they have already finished the report, '
              + 'they will be asked to redo the after-repair value against the new one.',
              { title: 'Send the updated scope of work', confirmLabel: 'Send it' }))) return;
            await run('sow', () => api.rvSendScopeOfWork(order.id), 'Richer Value has the updated scope of work.');
          }}>
            {busy === 'sow' ? 'Sending…' : 'Send the updated scope of work'}
          </button>
        ) : null}
        <span className="sep" />
        {ad.canCancel(order) ? (
          <button className="aord-btn" disabled={!!busy} onClick={async () => {
            const reason = await askPrompt('Why is this order being cancelled? It goes to Richer Value and onto the file.',
              { title: 'Cancel the Hybrid Appraisal' });
            if (reason == null) return;
            if (String(reason).trim().length < 8) { setErr('Add a slightly longer reason — Richer Value is told what it says.'); return; }
            await run('cancel', () => api.rvCancel(order.id, String(reason).trim()), 'Cancellation asked for. It shows as cancelled once Richer Value confirms.');
          }}>Cancel</button>
        ) : null}
        <button className="aord-more" style={{ marginLeft: 'auto' }} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>

      {open ? <RvOrderDetail order={order} detail={detail} /> : null}
    </div>
  );
}

// The states an evaluation goes through, in their words rather than an appraisal's.
const RV_STATUS_LABEL = {
  placing: 'Placing…',
  intake: 'Submitted — not paid yet',
  ordered: 'Ordered',
  in_process: 'Being worked on',
  in_review: 'In review',
  revision: 'Revision',
  completed: 'Report ready',
  on_hold: 'On hold',
  cancel_requested: 'Cancelling…',
  cancelled: 'Cancelled',
  error: 'Needs attention',
  dryrun: 'Test build',
};

function RvOrderDetail({ order, detail }) {
  const report = detail && detail.report;
  const timeline = (detail && detail.timeline) || [];
  return (
    <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
      <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.6 }}>
        <div><b style={{ color: INK }}>What was ordered:</b> {order.report_type}
          {order.inspection_type && order.inspection_type !== 'none' ? ` · ${order.inspection_type}` : ' · no inspection'}
          {order.turnaround_time ? ` · ${order.turnaround_time}` : ''}
          {order.gla_include ? ' · floor plan' : ''}
          {order.licensing_required ? ' · licensed inspector' : ''}
          {order.include_flood_certification ? ' · flood certificate' : ''}
        </div>
        {order.xml_waiver_applied ? (
          <div><b style={{ color: INK }}>The appraisal data file:</b> waived on this file because this report does not produce one.</div>
        ) : null}
        {order.pdf_document_id ? (
          <div><b style={{ color: INK }}>The report:</b> filed on the appraisal condition.</div>
        ) : null}
        {order.payment_link && !order.paid_at ? (
          <div><b style={{ color: INK }}>Not settled yet.</b> Their payment page: <a href={order.payment_link} target="_blank" rel="noreferrer">open it</a>.</div>
        ) : null}
      </div>

      {/* Their renovation-strategy grid — what the property is worth under each
          plan. It is the point of the report, so it is shown in full. */}
      {report && report.strategies && report.strategies.length ? (
        <>
          <div style={{ marginTop: 12 }}><SectionTitle>What Richer Value found</SectionTitle></div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', minWidth: 460, borderCollapse: 'collapse', fontSize: 12.5, color: INK }}>
              <thead>
                <tr style={{ textAlign: 'left', color: MUTED }}>
                  <th style={{ padding: '5px 8px' }} />
                  <th style={{ padding: '5px 8px' }}>Minimum</th>
                  <th style={{ padding: '5px 8px' }}>Partial</th>
                  <th style={{ padding: '5px 8px' }}>Full</th>
                  <th style={{ padding: '5px 8px' }}>Recommended</th>
                </tr>
              </thead>
              <tbody>
                {report.strategies.filter((s) => s.title).map((s) => (
                  <tr key={s.title} style={{ borderTop: `1px solid ${LINE}` }}>
                    <td style={{ padding: '5px 8px', fontWeight: 600 }}>{s.title}</td>
                    <td style={{ padding: '5px 8px' }}>{s.min || '—'}</td>
                    <td style={{ padding: '5px 8px' }}>{s.partial || '—'}</td>
                    <td style={{ padding: '5px 8px' }}>{s.full || '—'}</td>
                    <td style={{ padding: '5px 8px', fontWeight: 600 }}>{s.best || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.confidence && report.confidence.reliability ? (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
              Their confidence: {report.confidence.reliability}
              {report.confidence.rvConfidence != null ? ` · ${report.confidence.rvConfidence}%` : ''}
              {report.market && report.market.demandLevel ? ` · market demand ${report.market.demandLevel}` : ''}
            </div>
          ) : null}
          {report.commentary && report.commentary.valuation ? (
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 8, lineHeight: 1.5 }}>{report.commentary.valuation}</div>
          ) : null}
        </>
      ) : null}

      {timeline.length ? (
        <>
          <div style={{ marginTop: 12 }}><SectionTitle>What has happened</SectionTitle></div>
          <div style={{ fontSize: 12.5, color: MUTED }}>
            {timeline.slice(0, 12).map((t, i) => (
              <div key={i} style={{ padding: '3px 0' }}>
                {fmtWhen(t.occurred_at)} — {t.status}{t.event_type === 'inspection' ? ' (inspection)' : ''}
                {t.comment ? ` · ${t.comment}` : ''}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ======================================================= active order card === */
function ActiveOrderCard({ order, appId, card, onChanged, onPay }) {
  const ad = ADAPTERS[order._vendor];
  const [open, setOpen] = useState(null);          // 'messages' | 'documents' | 'revision' | null
  const [showDetails, setShowDetails] = useState(false);
  const ms = statusToMilestone(order._vendor, order.status, order);
  const fee = ad.orderFee(order);
  const paid = ad.orderPaid(order);
  const toggle = (k) => setOpen(open === k ? null : k);
  const numberBits = [];
  const num = ad.orderNumber(order);
  const prop = (order.summary || []).find((s) => s.label === 'Property');
  if (prop) numberBits.push(prop.value);
  if (num) numberBits.push(num);
  numberBits.push('ordered ' + fmtDate(ad.orderedAt(order)));
  if (order.due_date) numberBits.push('due ' + fmtDate(order.due_date));
  if (order.appointment_date) numberBits.push('inspection ' + fmtDate(order.appointment_date));
  if (order.dryrun) numberBits.push('test');

  const statusLabel = STATUS_LABEL[order.status] || order.status;
  const sc = statusColor(order.status);

  return (
    <div className="aord-card">
      {/* Header: vendor tag · title/details · status pill */}
      <div className="aord-h">
        <span className={'aord-tag ' + order._vendor}><span className="d" />{ad.stamp}</span>
        <div className="grow">
          <div className="aord-title">
            {ad.orderTitle(order)}{order._vendor === 'class' && order.uad ? ` · UAD ${order.uad}` : ''}
          </div>
          <div className="aord-sub">{numberBits.join(' · ')}</div>
        </div>
        <span className="aord-pill" style={{ background: sc + '18', color: sc }}>{statusLabel}</span>
      </div>

      <StatusTimeline ms={ms} order={order} asks={order._asks} />

      {/* Quiet action row: communicate · pay · cancel */}
      <div className="aord-acts">
        <button className="aord-btn" onClick={() => toggle('messages')} aria-pressed={open === 'messages'}>
          Messages{order._vendor === 'class' && order._unread ? <span className="n">{order._unread}</span> : null}
        </button>
        <button className="aord-btn" onClick={() => toggle('documents')} aria-pressed={open === 'documents'}>Documents</button>
        <button className="aord-btn" onClick={() => toggle('revision')} aria-pressed={open === 'revision'}>Revision</button>
        <span className="sep" />
        {paid ? (
          <button className="aord-btn paid" onClick={() => onPay(order)}>Paid ✓{card && card.last4 ? ` · ••${card.last4}` : ''}</button>
        ) : (
          <button className="aord-btn pri" onClick={() => onPay(order)}>{fee != null ? `Pay ${money(fee)}` : 'Pay'}</button>
        )}
        {ad.canCancel(order) ? <NanCancelButton orderId={order.id} onChanged={onChanged} /> : null}
        <button className="aord-more" style={{ marginLeft: 'auto' }} onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Details'}
        </button>
      </div>

      {showDetails ? <WhatWasOrdered order={order} fee={fee} /> : null}
      {open === 'messages' ? <SubMessages order={order} appId={appId} onChanged={onChanged} /> : null}
      {open === 'documents' ? <SubDocuments order={order} appId={appId} onChanged={onChanged} /> : null}
      {open === 'revision' ? <SubRevision order={order} appId={appId} onChanged={onChanged} /> : null}
    </div>
  );
}

function StatusTimeline({ ms, order, asks }) {
  const cur = ms.index;
  return (
    <div>
      <div className="aord-rail" role="list">
        {MILESTONES.map((label, i) => {
          const cls = i < cur ? 'done' : i === cur ? 'now' : '';
          return (
            <div key={i} className={'aord-node ' + cls} role="listitem">
              <i />
              <span>
                {label}
                {i === 1 && order.appointment_date ? <><br />{fmtDate(order.appointment_date)}</> : null}
              </span>
            </div>
          );
        })}
      </div>
      {(ms.overlay || (asks && asks.length)) ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {ms.overlay ? <TimelineChip tone={ms.overlay.tone}>{ms.overlay.label}</TimelineChip> : null}
          {asks && asks.length ? <TimelineChip tone="gold">{asks.some((a) => a.kind === 'rov') ? 'Value disputed' : 'Revision requested'}</TimelineChip> : null}
        </div>
      ) : null}
    </div>
  );
}

function TimelineChip({ tone, children }) {
  const c = tone === 'warn' ? { fg: WARN, bg: WARN_BG, bd: WARN_LINE }
    : tone === 'gold' ? { fg: '#856529', bg: '#FBF6EC', bd: GOLD }
      : { fg: '#8A2F27', bg: '#FBEEEC', bd: '#E4B4AE' };
  return <span style={{ border: `1px solid ${c.bd}`, background: c.bg, color: c.fg, borderRadius: 999, padding: '1px 9px', fontSize: 12, fontWeight: 600 }}>{children}</span>;
}

function WhatWasOrdered({ order, fee }) {
  const summary = Array.isArray(order.summary) ? order.summary : [];
  return (
    <div className="aord-inner">
      <div className="aord-eyebrow" style={{ margin: '0 0 10px' }}>What was ordered</div>
      {summary.length ? (
        <dl className="aord-figs" style={{ marginTop: 0 }}>
          {summary.map((s, i) => (
            <React.Fragment key={i}>
              <dt style={{ textAlign: 'left' }}>{s.label}</dt>
              <dd style={{ wordBreak: 'break-word' }}>{s.value}</dd>
            </React.Fragment>
          ))}
          {fee != null ? (
            <>
              <div className="rule" />
              <dt className="tot" style={{ textAlign: 'left' }}>Appraisal fee</dt><dd className="tot">{money(fee)}</dd>
            </>
          ) : null}
        </dl>
      ) : <div style={{ color: MUTED, fontSize: 13 }}>No order summary available.</div>}
    </div>
  );
}

/* ---------------------------------------------------- sub-surfaces (adapted) */
function SubMessages({ order, appId, onChanged }) {
  return order._vendor === 'nan'
    ? <NanMessages orderId={order.id} />
    : <ClassMessages appId={appId} order={order} onChanged={onChanged} />;
}
function SubDocuments({ order, appId, onChanged }) {
  return order._vendor === 'nan'
    ? <NanDocuments appId={appId} orderId={order.id} onChanged={onChanged} />
    : <ClassAttachments order={order} />;
}
function SubRevision({ order, appId, onChanged }) {
  return order._vendor === 'nan'
    ? <NanRevisions appId={appId} orderId={order.id} order={order} />
    : <ClassAsk appId={appId} order={order} onChanged={onChanged} />;
}

const surfaceWrap = { border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginTop: 10, background: '#fff' };

/* ---- NAN messages ---- */
function NanMessages({ orderId }) {
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
    <div style={surfaceWrap}>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {rows.length ? rows.map((c) => (
          <div key={c.id} style={{ alignSelf: c.direction === 'outbound' ? 'flex-end' : 'flex-start', maxWidth: '80%', background: c.direction === 'outbound' ? '#EAF3F3' : '#F4F1EA', border: `1px solid ${LINE}`, borderRadius: 10, padding: '7px 10px' }}>
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

/* ---- Class messages (with Check for replies + Mark read) ---- */
function ClassMessages({ appId, order, onChanged }) {
  const [thread, setThread] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try { setThread(await api.classThread(appId, order.id)); } catch (e) { setErr(e.message || 'Could not load the conversation.'); }
  }, [appId, order.id]);
  useEffect(() => { load(); }, [load]);
  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true); setErr(''); setNotice('');
    try {
      const out = await api.classNote(appId, order.id, draft);
      setDraft('');
      setNotice(out && out.ok ? (out.dryrun ? 'Saved. Test mode, so nothing was sent.' : 'Sent to Class.') : '');
      if (!(out && out.ok)) setErr(parseOrderFailure(null, out));
      await load();
    } catch (e) { setErr(parseOrderFailure(e, null)); await load(); }
    setBusy(false);
  };
  const pull = async () => {
    setBusy(true); setErr('');
    try { const out = await api.classThreadSync(appId, order.id); if (!(out && out.ok)) setErr((out && out.message) || 'Could not check with Class right now.'); await load(); }
    catch (e) { setErr(e.message || 'Could not check with Class right now.'); }
    setBusy(false);
  };
  const markRead = async () => { try { await api.classMarkRead(appId, order.id); await load(); if (onChanged) onChanged(); } catch (_) { /* cosmetic */ } };
  const notes = (thread && thread.notes) || [];
  return (
    <div style={surfaceWrap}>
      <OrderFailure info={err} vendor="Class Valuation" action="send that message" />
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff', maxHeight: 320, overflowY: 'auto', padding: 10, marginBottom: 8 }}>
        {notes.length ? notes.map((n) => {
          const ours = n.direction === 'FromClient';
          return (
            <div key={n.id} style={{ marginBottom: 10, textAlign: ours ? 'right' : 'left' }}>
              <div style={{ display: 'inline-block', maxWidth: '80%', textAlign: 'left', background: ours ? '#EAF3F3' : '#F4F1EA', border: `1px solid ${LINE}`, borderRadius: 10, padding: '7px 10px', color: INK, whiteSpace: 'pre-wrap' }}>
                {n.content || <span style={{ color: MUTED }}>(no text)</span>}
              </div>
              <div style={{ fontSize: 11, color: n.send_error ? BAD : MUTED, marginTop: 2 }}>
                {ours ? 'Us' : 'Class'} · {fmtWhen(n.vendor_created_at || n.created_at)}
                {n.send_error ? ` · not delivered: ${n.send_error}` : ''}
                {ours && !n.send_error && !n.sent_at ? ' · sending…' : ''}
              </div>
            </div>
          );
        }) : <div style={{ color: MUTED, fontSize: 13 }}>Nothing said yet.</div>}
      </div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} placeholder="Write to Class about this order…"
        style={{ ...inputStyle, width: '100%', resize: 'vertical', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || !draft.trim()} onClick={send}>{busy ? 'Working…' : 'Send'}</button>
        <button className="btn soft" disabled={busy} onClick={pull}>Check for replies</button>
        {thread && thread.unread ? <button className="btn ghost" onClick={markRead}>Mark read</button> : null}
      </div>
    </div>
  );
}

/* ---- NAN documents (send the file's documents up to the order) ---- */
function NanDocuments({ appId, orderId, onChanged }) {
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
      if (!o.ok) setErr(o.message || 'Could not upload.');
      else { setNotice('Sent ' + (o.uploaded ? o.uploaded.length : 0) + ' document(s) to the order.'); setPick({}); await load(); if (onChanged) onChanged(); }
    } catch (e) { setErr(e.message || 'Could not upload.'); }
    setBusy(false);
  };
  return (
    <div style={surfaceWrap}>
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

/* ---- Class documents (the vendor's returned attachments — read-only) ---- */
function ClassAttachments({ order }) {
  const rows = order._attachments || [];
  return (
    <div style={surfaceWrap}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
        Documents Class has sent back on this order. Their scope of work and contract are sent to them automatically.
      </div>
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
        {rows.length ? rows.map((a, i) => (
          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderTop: i ? `1px solid ${LINE}` : 'none' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: INK, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || 'Document'}</div>
              <div style={{ fontSize: 12, color: MUTED }}>{a.content_type || 'file'}{a.fetched_at ? ' · filed on the file' : (a.announced_at ? ' · announced' : '')}</div>
            </div>
          </div>
        )) : <div style={{ padding: 10, color: MUTED, fontSize: 13 }}>Class hasn’t sent any documents back on this order yet.</div>}
      </div>
    </div>
  );
}

/* ---- NAN revisions + ROV builder ---- */
function NanRevisions({ appId, orderId, order }) {
  const [rows, setRows] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [rovOpen, setRovOpen] = useState(false);
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
    <div style={surfaceWrap}>
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

      <div className="seg" style={{ marginBottom: 10 }}>
        <button type="button" className={!rovOpen ? 'on' : ''} aria-pressed={!rovOpen} onClick={() => setRovOpen(false)}>Ask for a fix</button>
        <button type="button" className={rovOpen ? 'on' : ''} aria-pressed={rovOpen} onClick={() => setRovOpen(true)}>Dispute the value</button>
      </div>

      {!rovOpen ? (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
          <div style={{ fontWeight: 600, color: INK, marginBottom: 2 }}>Ask for a revision or a fix</div>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            For a mistake the appraiser made, a correction, or a change to the scope of work. This does not change the value.
          </div>
          {!reportIn ? (
            <WhyBox title="The appraisal isn’t back yet.">
              A <strong>fix</strong> can’t be requested until the report is in — this opens up once the order shows <strong>Report ready</strong>. (A scope-of-work change can still be sent while the order is in progress.)
            </WhyBox>
          ) : null}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Describe what needs to be fixed or changed…"
            style={{ width: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: 8, color: INK, resize: 'vertical', boxSizing: 'border-box', marginTop: 8 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <button className="btn soft" disabled={busy || !text.trim() || !reportIn} onClick={() => sendRevision('revision')} title={reportIn ? '' : 'Available once the report is in'}>Request a revision</button>
            <button className="btn soft" disabled={busy || !text.trim()} onClick={() => sendRevision('sow_change')}>Scope-of-work change</button>
          </div>
        </div>
      ) : (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
          <div style={{ fontWeight: 600, color: INK, marginBottom: 2 }}>Dispute the value (ROV)</div>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
            If the appraised value is too low, ask for a reconsideration. Search the Property Research Center for comps, add them, or type one in.
          </div>
          {!reportIn ? (
            <WhyBox title="You can dispute the value once the report is in.">
              There’s no value to dispute until the appraiser sends the finished report back (<strong>Report ready</strong>).
            </WhyBox>
          ) : (
            <RovBuilder appId={appId} orderId={orderId} onSent={async () => { await load(); }} />
          )}
        </div>
      )}
    </div>
  );
}

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

function RovBuilder({ appId, orderId, onSent }) {
  const [appraisedValue, setAppraisedValue] = useState('');
  const [opinionValue, setOpinionValue] = useState('');
  const [note, setNote] = useState('');
  const [selected, setSelected] = useState([]);
  const [suggested, setSuggested] = useState([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
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
      propertyId: null, manual: true, address: m.address.trim() || null,
      salePrice: m.salePrice ? moneyNum(m.salePrice) : null, saleDate: m.saleDate || null,
      gla: m.gla ? Number(m.gla) : null, beds: m.beds ? Number(m.beds) : null, bathsFull: m.bathsFull ? Number(m.bathsFull) : null,
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
    <div style={{ border: `1px solid ${GOLD}`, borderRadius: 10, padding: 10, marginTop: 8 }}>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 12, color: MUTED }}>Appraised value<br />
          <input value={appraisedValue} onChange={(e) => setAppraisedValue(e.target.value)} inputMode="numeric" style={{ ...inp, width: 140 }} /></label>
        <label style={{ fontSize: 12, color: MUTED }}>Value you’re asking for<br />
          <input value={opinionValue} onChange={(e) => setOpinionValue(e.target.value)} inputMode="numeric" style={{ ...inp, width: 140 }} /></label>
      </div>

      <div style={{ fontWeight: 600, color: INK, fontSize: 13, marginBottom: 2 }}>Comparable sales you’re using ({selected.length})</div>
      {selected.length ? (
        <div style={{ marginBottom: 10 }}>
          {selected.map((c) => <CompLine key={keyOf(c)} c={c} action={<button className="btn ghost" style={{ minHeight: 0, padding: '2px 8px', fontSize: 12 }} onClick={() => removeComp(c)}>Remove</button>} />)}
        </div>
      ) : <div style={{ color: MUTED, fontSize: 12, marginBottom: 10 }}>None yet — search below and add the sales you want to use, or type one in.</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by address or town…"
          onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }} style={{ ...inp, flex: 1 }} />
        <button className="btn soft" disabled={searching} onClick={runSearch}>{searching ? '…' : 'Search'}</button>
      </div>

      <div style={{ fontSize: 11, color: MUTED, marginBottom: 2 }}>{listLabel}</div>
      <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 10, borderBottom: `1px solid ${LINE}` }}>
        {list.length ? list.map((c) => (
          <CompLine key={keyOf(c)} c={c}
            action={isPicked(c) ? <span style={{ color: TEAL, fontSize: 12, whiteSpace: 'nowrap' }}>✓ Added</span>
              : <button className="btn soft" style={{ minHeight: 0, padding: '2px 8px', fontSize: 12 }} onClick={() => addComp(c)}>Add</button>} />
        )) : <div style={{ fontSize: 12, color: MUTED, padding: '6px 0' }}>
          {results == null ? 'No comparable sales found near the property yet — search a town or add one manually.' : 'Nothing found. Try a different address or town, or add the property manually.'}
        </div>}
      </div>

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
      ) : <button className="btn ghost" style={{ marginBottom: 10 }} onClick={() => setManualOpen(true)}>＋ Add a property manually</button>}

      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything to add for the appraiser (optional)…"
        style={{ width: '100%', ...inp, resize: 'vertical', marginBottom: 8 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={busy || !selected.length} onClick={send}>{busy ? '…' : 'Send dispute'}</button>
      </div>
      {!selected.length ? <div style={{ fontSize: 11, color: MUTED, marginTop: 6 }}>Add at least one comparable sale to send the dispute.</div> : null}
    </div>
  );
}

/* ---- Class ask (fix / value dispute reason-picker) ---- */
function ClassAsk({ appId, order, onChanged }) {
  const [kind, setKind] = useState('revision');   // 'revision' | 'rov'
  const reportIn = order.status === 'completed';
  return (
    <div style={surfaceWrap}>
      <div className="seg" style={{ marginBottom: 10 }}>
        <button type="button" className={kind === 'revision' ? 'on' : ''} aria-pressed={kind === 'revision'} onClick={() => setKind('revision')}>Ask for a fix</button>
        <button type="button" className={kind === 'rov' ? 'on' : ''} aria-pressed={kind === 'rov'} onClick={() => setKind('rov')}>Dispute the value</button>
      </div>
      <AskForm appId={appId} order={order} kind={kind} reportIn={reportIn}
        onDone={async () => { if (onChanged) await onChanged(); }} />
    </div>
  );
}

function AskForm({ appId, order, kind, reportIn, onDone }) {
  const [reasons, setReasons] = useState(null);
  const [picked, setPicked] = useState([]);
  const [why, setWhy] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [problems, setProblems] = useState([]);
  const [done, setDone] = useState('');

  useEffect(() => {
    let alive = true;
    if (reportIn === false) { setReasons({ common: [], all: [] }); return () => {}; }
    (async () => {
      try { const r = await api.classReasons(kind); if (alive) setReasons(r); }
      catch (_) { if (alive) setReasons({ common: [], all: [] }); }
    })();
    return () => { alive = false; };
  }, [kind, reportIn]);

  if (reportIn === false) {
    return (
      <WhyBox title={kind === 'rov' ? 'You can dispute the value once the report is in.' : 'You can ask for a fix once the report is in.'}>
        The appraiser hasn’t sent the finished report back yet, so there’s nothing to
        {kind === 'rov' ? ' dispute' : ' fix'} — and Class won’t take the request until it’s done.
        This opens up on its own the moment the order shows <strong>Report ready</strong>.
      </WhyBox>
    );
  }

  const list = reasons ? (showAll ? reasons.all : reasons.common) : [];
  const toggle = (code) => setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : p.concat(code)));

  const submit = async () => {
    setBusy(true); setErr(''); setProblems([]); setDone('');
    try {
      const out = await api.classRevision(appId, order.id, {
        kind, reasons: picked.map((code) => ({ reasonType: code, reason: why.trim() || undefined })),
      });
      if (out && out.ok) { setDone(out.dryrun ? 'Recorded. Test mode, so nothing was sent.' : 'Sent to Class.'); setPicked([]); setWhy(''); }
      else if (out && out.problems) setProblems(out.problems);
      else setErr(parseOrderFailure(null, out));
      if (onDone) await onDone();
    } catch (e) {
      if (e && e.data && Array.isArray(e.data.problems)) setProblems(e.data.problems);
      else setErr(parseOrderFailure(e, null));
      if (onDone) await onDone();
    }
    setBusy(false);
  };

  return (
    <div>
      <OrderFailure info={err} vendor="Class Valuation" action="send that request" />
      {done ? <Banner tone="good">{done}</Banner> : null}
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
        {kind === 'rov'
          ? 'Tell Class you disagree with the value. Pick what the problem is and explain it — this goes to the appraiser as a formal request to reconsider.'
          : 'Ask Class to correct something on the report. Pick what is wrong and explain it.'}
      </div>
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, background: '#fff', maxHeight: 240, overflowY: 'auto', marginBottom: 8 }}>
        {list.map((r, i) => (
          <label key={r.code} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 10px', borderTop: i ? `1px solid ${LINE}` : 'none', cursor: 'pointer' }}>
            <input type="checkbox" checked={picked.includes(r.code)} onChange={() => toggle(r.code)} />
            <span style={{ color: INK }}>{r.label}</span>
          </label>
        ))}
        {!list.length ? <div style={{ padding: 10, color: MUTED, fontSize: 13 }}>Loading their list…</div> : null}
      </div>
      <button type="button" onClick={() => setShowAll((v) => !v)} style={{ ...linkBtn, marginBottom: 8 }}>
        {showAll ? 'Show just the usual reasons' : `Show every reason Class accepts (${reasons ? reasons.all.length : 0})`}
      </button>
      <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={3}
        placeholder={kind === 'rov' ? 'What supports a different value? (e.g. three closer sales at $410,000)' : 'What needs fixing?'}
        style={{ ...inputStyle, width: '100%', resize: 'vertical', marginBottom: 8 }} />
      {problems.length ? <ul style={{ margin: '0 0 8px 18px', padding: 0, color: BAD, fontSize: 13 }}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
      <button className="btn primary" disabled={busy || !picked.length} onClick={submit}>
        {busy ? 'Working…' : kind === 'rov' ? 'Send the value dispute' : 'Send the fix request'}
      </button>
      <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>Class handles both of these the same way — a value dispute is a fix request about the value.</div>
    </div>
  );
}

/* ---- NAN cancel ---- */
function NanCancelButton({ orderId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const doCancel = async () => {
    const reason = await askPrompt('Why are you cancelling this appraisal order? This reason is sent to the AMC.', {
      title: 'Cancel appraisal order', confirmLabel: 'Continue', multiline: true,
    });
    if (reason == null) return;
    if (!String(reason).trim()) return;
    const ok = await askConfirm(`Ask the AMC to cancel this order?\n\nReason: ${reason.trim()}`, {
      title: 'Cancel appraisal order', confirmLabel: 'Cancel the order', cancelLabel: 'Keep it',
    });
    if (!ok) return;
    setBusy(true);
    try { const out = await api.amcCancelOrder(orderId, reason.trim()); if (out && out.ok) await onChanged(); }
    catch (_) { /* surfaced by re-fetch */ }
    setBusy(false);
  };
  return <button className="aord-btn danger" disabled={busy} onClick={doCancel}>{busy ? 'Cancelling…' : 'Cancel order'}</button>;
}

/* ================================================ drafts + failed drawer === */
function PastAndFailedDrawer({ failed, drafts, closed, defaultOpen, appId, onChanged }) {
  const total = failed.length + drafts.length + closed.length;
  return (
    <details open={defaultOpen} style={{ marginTop: 16, border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <summary style={{ cursor: 'pointer', padding: '10px 12px', fontWeight: 600, color: INK, fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center' }}>
        Past &amp; failed orders ({total})
        {failed.length ? <span style={{ background: '#FBEEEC', border: '1px solid #E4B4AE', color: '#8A2F27', borderRadius: 999, padding: '1px 8px', fontSize: 12, fontWeight: 700 }}>{failed.length} need attention</span> : null}
      </summary>
      <div style={{ borderTop: `1px solid ${LINE}`, padding: 12 }}>
        {failed.length ? (
          <DrawerGroup title={`⚠ Needs attention (${failed.length})`} tone="bad">
            {failed.map((o) => <DrawerRow key={o._vendor + ':' + o.id} order={o} kind="failed" appId={appId} onChanged={onChanged} />)}
          </DrawerGroup>
        ) : null}
        {drafts.length ? (
          <DrawerGroup title={`Drafts (${drafts.length} not sent yet)`}>
            {drafts.map((o) => <DrawerRow key={o._vendor + ':' + o.id} order={o} kind="draft" appId={appId} onChanged={onChanged} />)}
          </DrawerGroup>
        ) : null}
        {closed.length ? (
          <DrawerGroup title={`Closed (${closed.length})`}>
            {closed.map((o) => <DrawerRow key={o._vendor + ':' + o.id} order={o} kind="closed" appId={appId} onChanged={onChanged} />)}
          </DrawerGroup>
        ) : null}
      </div>
    </details>
  );
}

function DrawerGroup({ title, tone, children }) {
  const bad = tone === 'bad';
  return (
    <div style={{ marginBottom: 12, border: `1px solid ${bad ? '#E4B4AE' : LINE}`, borderRadius: 10, overflow: 'hidden', background: bad ? '#FDF6F5' : '#fff' }}>
      <div style={{ padding: '8px 12px', fontWeight: 600, fontSize: 12.5, color: bad ? '#8A2F27' : MUTED, borderBottom: `1px solid ${bad ? '#E4B4AE' : LINE}`, textTransform: 'uppercase', letterSpacing: '.03em' }}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function DrawerRow({ order, kind }) {
  const [open, setOpen] = useState(false);
  const ad = ADAPTERS[order._vendor];
  const prop = (order.summary || []).find((s) => s.label === 'Property');
  const reason = order.last_error || order.status_reason || null;
  return (
    <div style={{ borderTop: `1px solid ${LINE}` }}>
      <div onClick={() => setOpen((v) => !v)} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '9px 12px', cursor: 'pointer' }}>
        <span style={{ width: 4, height: 30, borderRadius: 2, background: GOLD, flex: '0 0 auto' }} />
        <span style={{ fontWeight: 700, color: INK, fontSize: 12, minWidth: 40 }}>{ad.stamp}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, color: INK }}>{ad.orderTitle(order)}</div>
          <div style={{ fontSize: 12, color: MUTED }}>
            {prop ? prop.value + ' · ' : ''}
            {kind === 'draft' ? 'Draft — not sent yet' : kind === 'closed' ? (STATUS_LABEL[order.status] || order.status) : 'Needs attention'}
          </div>
          {kind === 'failed' && reason ? <div style={{ fontSize: 12, color: BAD, marginTop: 3 }}><strong>Why it didn’t go through:</strong> {reason}</div> : null}
          {kind === 'closed' && order.cancel_reason ? <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>{order.cancel_reason}</div> : null}
        </div>
        <span style={{ color: TEAL, fontSize: 13 }}>{open ? 'Hide' : 'Open'}</span>
      </div>
      {open ? (
        <div style={{ borderTop: `1px solid ${LINE}`, padding: 12, background: '#FBF9F4' }}>
          {kind === 'failed' ? <DrawerFailedDetail order={order} /> : null}
          <WhatWasOrdered order={order} fee={ADAPTERS[order._vendor].orderFee(order)} />
        </div>
      ) : null}
    </div>
  );
}

// The full vendor rejection on a failed order — reason, "what their system reported",
// and a copyable raw-details expander (the model OrderError set on the AMC panel).
function DrawerFailedDetail({ order }) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = order.last_status_response || order.request_body || null;
  const rawText = raw ? (typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(rawText); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (_) { /* ignore */ }
  };
  return (
    <div style={{ border: '1px solid #E7C4C0', background: '#FCF4F3', borderRadius: 10, padding: 12, marginBottom: 10 }}>
      <div style={{ fontWeight: 700, color: '#8A322B' }}>{ADAPTERS[order._vendor].name} could not place this order.</div>
      <div style={{ color: '#8A322B', marginTop: 4 }}>{order.last_error || order.status_reason || 'The appraisal gateway did not accept the order.'}</div>
      {rawText ? (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowRaw((v) => !v)} style={{ border: 'none', background: 'none', color: '#256168', textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 13 }}>
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

/* ============================================================= pay modal === */
// Reuses the existing appraisal card-entry fields in the .cv-modal shell.
// staffAppraisalCard prefill → staffSaveAppraisalCard save (which clears the
// appraisal_card condition). The actual vendor CHARGE is a later phase.
function PayModal({ appId, order, card, onClose, onPaid }) {
  const ad = ADAPTERS[order._vendor];
  const fee = ad.orderFee(order);
  const paid = ad.orderPaid(order);
  const [f, setF] = useState({ number: '', expMonth: '', expYear: '', cvc: '', zip: '' });
  const [prefilled, setPrefilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const prop = (order.summary || []).find((s) => s.label === 'Property');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await api.staffAppraisalCard(appId);
        if (alive && c && c.number) {
          setF({
            number: c.number || '', expMonth: c.expMonth != null ? String(c.expMonth) : '',
            expYear: c.expYear != null ? String(c.expYear) : '', cvc: c.cvc || '', zip: c.zip || '',
          });
          setPrefilled(true);
        }
      } catch (_) { /* no card on file */ }
    })();
    return () => { alive = false; };
  }, [appId]);

  const pay = async () => {
    setBusy(true); setErr(''); setDone('');
    try {
      await api.staffSaveAppraisalCard(appId, f);
      // TODO(payment-phase): submit card to vendor + record paid status
      setDone('Card saved — the appraisal payment condition is cleared.');
      await onPaid();
      setTimeout(onClose, 1000);
    } catch (e) { setErr((e && e.message) || 'Could not save the card.'); }
    setBusy(false);
  };

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ padding: 20, color: INK }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17, color: INK }}>{paid ? 'Update the payment card' : 'Pay the appraisal order'}</div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
          {ad.name}{ad.orderTitle(order) ? ` · ${ad.orderTitle(order)}` : ''}{prop ? ` · ${prop.value}` : ''}
        </div>
        <div style={{ fontSize: 14, color: INK, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
          {paid
            ? <span style={{ color: GOOD, fontWeight: 600 }}>Paid ✓{card && card.last4 ? ` · ••${card.last4}` : ''} — update the card on file below if you need to.</span>
            : fee != null ? <>Amount: <strong>{money(fee)}</strong></> : 'Amount is confirmed by the vendor.'}
        </div>

        {err ? <div style={{ marginTop: 10 }}><OrderFailure info={err} vendor={ad.name} action="save the card" /></div> : null}
        {done ? <div style={{ marginTop: 10 }}><Banner tone="good">{done}</Banner></div> : null}
        {prefilled && !done ? <div style={{ marginTop: 10, fontSize: 12.5, color: MUTED }}>A card is already on file — update it below if you need to.</div> : null}

        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          <input className="input" inputMode="numeric" placeholder="Card number" value={f.number} onChange={set('number')} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input className="input" style={{ maxWidth: 70 }} inputMode="numeric" placeholder="MM" value={f.expMonth} onChange={set('expMonth')} />
            <input className="input" style={{ maxWidth: 90 }} inputMode="numeric" placeholder="YYYY" value={f.expYear} onChange={set('expYear')} />
            <input className="input" style={{ maxWidth: 80 }} inputMode="numeric" placeholder="CVC" value={f.cvc} onChange={set('cvc')} />
            <input className="input" style={{ maxWidth: 110 }} inputMode="numeric" placeholder="ZIP" value={f.zip} onChange={set('zip')} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy} onClick={pay}>{busy ? 'Saving…' : paid ? 'Save card' : (fee != null ? `Pay ${money(fee)}` : 'Pay')}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- shared --- */
const inputStyle = { border: `1px solid ${LINE}`, borderRadius: 8, padding: '6px 8px', color: INK, background: '#fff', fontSize: 14 };
const linkBtn = { border: 'none', background: 'none', color: TEAL, cursor: 'pointer', padding: 0, fontSize: 12, fontWeight: 550 };

function Banner({ tone, children }) {
  const c = tone === 'bad' ? { bd: '#EBC9C4', bg: '#FBEEEC', fg: '#8A2F27' }
    : tone === 'warn' ? { bd: WARN_LINE, bg: WARN_BG, fg: WARN }
      : { bd: '#CFE6D8', bg: '#EEF7F1', fg: '#1E5E3C' };
  return <div style={{ border: `1px solid ${c.bd}`, background: c.bg, color: c.fg, borderRadius: 10, padding: '9px 12px', marginBottom: 10, fontSize: 13 }}>{children}</div>;
}
function SectionTitle({ children }) {
  return <div className="aord-eyebrow" style={{ margin: '0 0 6px' }}>{children}</div>;
}
function Field({ label, children }) {
  return <div style={{ minWidth: 120 }}><div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</div><div style={{ color: INK, fontWeight: 550 }}>{children}</div></div>;
}
function Legend() {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
      {['read', 'derived', 'overridden', 'missing'].map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: STATE[k].color }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: STATE[k].dot, display: 'inline-block' }} />
          {STATE[k].label}
        </span>
      ))}
    </div>
  );
}
