import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../lib/api';
import { moneyNum } from '../lib/money';
import { rvOrderTotal, moneyExact } from '../lib/rvPrice.js';
import { askConfirm, askPrompt } from '../lib/dialog.js';
import OrderFailure, { parseOrderFailure } from './OrderFailure.jsx';
import AppraisalCardEntry from './AppraisalCardEntry.jsx';

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
    // THE FEE AND THE PAID FLAG COME FROM THE VENDOR'S OWN RECORD, read by the
    // detail poll (db/567). `client_fee` is what this order costs US — it is NOT
    // the job fee plus the management fee, which on AppraisalScope's own sample
    // sum to $75 beside a $450 client fee.
    orderFee: (o) => (o.client_fee != null ? Number(o.client_fee) : null),
    // PAID means the vendor says nothing is still owed. A PARTIAL payment is
    // deliberately not "Paid ✓" — telling a coordinator an appraisal is paid for
    // when $200 of $450 has been taken is worse than telling them nothing. Until
    // the first detail poll lands both figures are absent, which reads as
    // not-paid: the honest answer, since we have not been told otherwise.
    orderPaid: (o) => {
      const paid = o.paid_amount == null ? null : Number(o.paid_amount);
      const due = o.due_amount == null ? null : Number(o.due_amount);
      if (!Number.isFinite(paid) || paid <= 0) return false;
      return due == null || !Number.isFinite(due) || due <= 0;
    },
    // The vendor's OWN due date, which is the ETA somebody is really asking for.
    // `need_by_date` is the date WE asked for and can differ from it.
    dueDate: (o) => o.vendor_due_date || o.need_by_date || null,
    inspectionDate: (o) => o.inspection_date || null,
    appraiser: (o) => (o.appraiser_name || o.appraiser_company ? {
      name: o.appraiser_name || null,
      company: o.appraiser_company || null,
      phone: o.appraiser_phone || null,
      email: o.appraiser_email || null,
    } : null),
    canCancel: (o) => !!(o.sp_order_number && o.status !== 'cancelled' && o.status !== 'completed'
      && o.status !== 'cancel_requested' && o.status !== 'rejected'),
    // PAYING IT, for real, as of 2026-08-16 (owner-directed: *"I want them to charge
    // the credit card that I'm importing"*). The server owns every money rule —
    // claim before send, never charge a paid order, never release a claim on an
    // answer we could not read — so this is a thin call plus the honest sentence
    // for each of the three outcomes.
    pay: async (order, { method, card, linkTo }) => {
      const r = await api.amcPay(order.id, {
        method,
        card: method === 'NEW_CARD' ? card : undefined,
        // A person may name one address; otherwise the server sends the invoice to
        // the borrower AND the loan officer, which is the pairing the owner asked
        // for and which this screen must not silently narrow.
        emails: method === 'PAYMENT_LINK' && linkTo ? [linkTo] : undefined,
      });
      if (method === 'PAYMENT_LINK') {
        const sent = (r && r.sent) || [];
        const failed = (r && r.failed) || [];
        return {
          ok: sent.length > 0,
          settled: false,   // an invoice is not a payment, and never reads as one
          note: sent.length
            ? `Invoice emailed by AppraisalScope to ${sent.join(' and ')}. It is not paid until they pay it.`
              + (failed.length ? ` It could NOT be sent to ${failed.map((x) => x.email).join(', ')}.` : '')
            : 'AppraisalScope could not send the invoice — nobody was emailed.',
        };
      }
      return {
        ok: !!(r && r.ok),
        settled: !!(r && r.transactionId),
        note: r && r.transactionId
          ? `Paid. AppraisalScope charged the card${r.last4 ? ` ••${r.last4}` : ''} — their receipt is ${r.transactionId}.`
          : ((r && r.detail) || 'AppraisalScope did not take the payment.'),
      };
    },
  },
  // THE THIRD VENDOR, AND A DIFFERENT PRODUCT. Richer Values's Hybrid Appraisal is
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
    name: 'Richer Values (Hybrid Appraisal)',
    stamp: 'Richer Values',
    loadConfig: () => api.rvConfig().then((c) => (c && c.richerValue) ? c.richerValue : null),
    // Returns the whole payload {orders, xmlWaiver}; the caller keeps it.
    loadOrders: (appId) => api.rvOrders(appId),
    orderTitle: (o) => (o.report_type === 'reno-arv' ? 'Hybrid Appraisal (As-Is + ARV)' : `Richer Values ${o.report_type || 'report'}`),
    orderNumber: (o) => (o.order_token ? 'Richer Values #' + String(o.order_token).slice(0, 12) : null),
    orderedAt: (o) => o.placed_at || o.created_at,
    // Their price is a dollar figure on the order row, in cents.
    orderFee: (o) => (o.total_price_cents != null ? o.total_price_cents / 100 : null),
    orderPaid: (o) => !!o.paid_at,
    canCancel: (o) => !!(o.intake_token && !['cancelled', 'completed', 'cancel_requested', 'rejected'].includes(o.status)),
    // Its own route, unchanged — it already reported the three outcomes separately,
    // which is where the shape below came from.
    pay: async (order, { method, card, linkTo }) => {
      const r = await api.rvPay(order.id, {
        method,
        card: method === 'NEW_CARD' ? card : null,
        paymentLinkTo: method === 'PAYMENT_LINK' ? linkTo : null,
      });
      if (!r || r.ok === false) return { ok: false, settled: false, note: (r && r.note) || 'Richer Values did not take the payment.' };
      return {
        ok: true,
        settled: !!r.settled,
        note: r.settled
          ? 'Paid. Richer Values has the money.'
          : 'Done — Richer Values has emailed the borrower their payment page. It is not paid until they pay it.',
      };
    },
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
    // Their OrderPaid callback, OR their payment-details reading a zero balance on a
    // priced order — both are Class saying it is paid.
    orderPaid: (o) => !!o.paid_at || (o.outstanding_cents != null && Number(o.outstanding_cents) <= 0 && Number(o.total_cents || 0) > 0),
    // The balance sentence the server composes from payment-details (src/class/payment.js).
    balanceLine: (o) => o.balance || null,
    // Class's own words for the same three facts, so the card asks the adapter
    // rather than reaching for one vendor's column names on every vendor's row.
    dueDate: (o) => o.due_date || null,
    inspectionDate: (o) => o.appointment_date || null,
    appraiser: (o) => (o.assigned_vendor ? { name: null, company: o.assigned_vendor, phone: null, email: null } : null),
    // A live Class order can be called off. The reason must come from Class's own
    // closed list, which is what ClassCancelButton's picker is for; an order they
    // have already finished or cancelled has nothing left to stop.
    canCancel: (o) => !!(o.class_order_id && !['cancelled', 'completed', 'error'].includes(String(o.status || ''))),
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
    // NAN carries its own unread count on the order row (the AMC's side of the
    // two-way thread); Class carries it in a separate list. Both end up as
    // `_unread` so the messages tab reads the same for either vendor.
    const nan = (nanOrders || []).map((o) => ({ ...o, _vendor: 'nan', _unread: Number(o.unread) || 0 }));
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
            // Richer Values's order card is its own, because its actions are its
            // own: there are no appraiser messages and no document exchange on an
            // evaluation, and there ARE two figures to read and put on the file.
            // The SHELL around it — the list, the ordering, the drawer — is shared.
            ? <RvOrderCard key={'rv:' + o.id} order={o} onChanged={afterChange} />
            : <ActiveOrderCard key={o._vendor + ':' + o.id} order={o} appId={appId} card={card}
              onChanged={afterChange} onPay={setPayFor} />))}
        </>
      ) : null}

      {/* ── Who is buying this loan decides what the appraiser is told. Asked
             (never required) BEFORE the order, because the requirements post the
             moment the order is placed and cannot be un-posted. */}
      <CapitalProviderPrompt appId={appId} onChanged={onChanged} />

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

      <OutsidePilotOrders />

      {payFor ? (
        <PayModal appId={appId} order={payFor} card={card}
          onClose={() => setPayFor(null)}
          onPaid={async () => { await afterChange(); }} />
      ) : null}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   THE CAPITAL PROVIDER, BEFORE THE ORDER (owner-directed 2026-09-01).

   Some capital providers have appraisal requirements that PILOT posts onto the
   order thread the moment the order is placed. Whether that happens is decided
   by the file's note buyer (or the program that implies one). When NOTHING on
   the file decides it, the officer is asked — here, above the builder — to pick
   the provider first. It is OPTIONAL: "Order without choosing" hides the ask
   for this visit and the order proceeds with nothing posted.

   When the provider IS known, the same card shrinks to one quiet line saying
   what the appraiser will be told, with the exact message one click away — so
   nobody has to guess what went out on their order.

   The choice is saved through the ONE existing write path for the note buyer
   (`complete-fields` with `lender`, the same call NoteBuyerCard makes), so it
   re-runs the condition engine and everything else a note-buyer change does.
   Options come from the note-buyer slot endpoint — one list, never a copy.
   STAFF-ONLY: the note-buyer name is never shown to a borrower, and this
   section only renders on the staff file view.
   ════════════════════════════════════════════════════════════════════════════ */
function CapitalProviderPrompt({ appId, onChanged }) {
  const [summary, setSummary] = useState(null);   // { investor, noteBuyer, message, needsProvider }
  const [options, setOptions] = useState([]);     // [{ value, label }] from the note-buyer slot
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [skipped, setSkipped] = useState(false);
  const [showMsg, setShowMsg] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try { setSummary(await api.get(`/api/staff/applications/${appId}/appraisal-requirements`)); }
    catch (_) { setSummary(null); }
  }, [appId]);

  useEffect(() => { let live = true; load(); return () => { live = false; }; }, [load]);

  // The provider list is only fetched when the ask is actually shown.
  useEffect(() => {
    if (!summary || !summary.needsProvider || skipped) return;
    let live = true;
    api.get(`/api/staff/applications/${appId}/note-buyer`)
      .then((r) => { if (live) setOptions((r && r.options) || []); })
      .catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [appId, summary, skipped]);

  async function save() {
    const opt = options.find((o) => o.value === choice);
    if (!opt) return;
    setBusy(true); setErr('');
    try {
      await api.post(`/api/staff/applications/${appId}/complete-fields`, { lender: opt.label });
      setSaved(true);
      await load();
      if (onChanged) onChanged();
    } catch (e) {
      setErr((e && e.message) || 'Could not save the capital provider.');
    } finally { setBusy(false); }
  }

  if (!summary) return null;

  // ── The ask: nothing on the file decides the provider yet.
  if (summary.needsProvider && !skipped) {
    return (
      <div className="aord-card" style={{ borderColor: WARN_LINE, background: WARN_BG }}>
        <div className="aord-title" style={{ fontSize: 15 }}>Which capital provider is this file going to?</div>
        <div className="aord-sub" style={{ color: MUTED, maxWidth: 680 }}>
          Optional, but worth a moment: some providers have appraisal requirements that PILOT posts
          to the appraiser the moment the order is placed. This file has no provider yet, so nothing
          would be posted. Pick one now and the order will carry that provider’s requirements
          automatically — or order without choosing.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}
            style={{ font: 'inherit', fontSize: 13.5, padding: '8px 10px', borderRadius: 10, border: `1px solid ${LINE}`, background: '#fff', color: INK, minWidth: 240 }}>
            <option value="">Choose a capital provider…</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button className="aord-btn pri" disabled={busy || !choice} onClick={save}>
            {busy ? 'Saving…' : 'Save to the file'}
          </button>
          <button className="aord-btn" disabled={busy} onClick={() => setSkipped(true)} style={{ color: MUTED }}>
            Order without choosing
          </button>
        </div>
        {err ? <div style={{ color: BAD, fontSize: 12.5, marginTop: 8 }}>{err}</div> : null}
      </div>
    );
  }

  // ── The provider is known and has requirements: say so, show them on request.
  if (summary.investor && summary.message) {
    return (
      <div className="aord-card" style={{ padding: '12px 16px' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13, color: INK }}>
            <span style={{ fontWeight: 650 }}>{saved ? 'Saved. ' : ''}This order will carry the loan’s appraisal requirements</span>
            <span style={{ color: MUTED }}> — posted to the appraiser automatically right after the order is placed.</span>
          </div>
          <button className="aord-btn" style={{ color: TEAL, padding: '2px 8px' }} onClick={() => setShowMsg((v) => !v)}>
            {showMsg ? 'Hide the message' : 'Show the message'}
          </button>
        </div>
        {showMsg ? (
          <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', fontSize: 12.5, lineHeight: 1.5, color: INK, background: '#FAF8F3',
            border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px', margin: '10px 0 0' }}>{summary.message}</pre>
        ) : null}
      </div>
    );
  }

  // ── A provider is named (or implied) but has no appraisal requirements: one quiet line.
  if (summary.noteBuyer || (!summary.needsProvider && !summary.investor)) {
    return (
      <div style={{ color: MUTED, fontSize: 12.5, padding: '2px 4px 8px' }}>
        {saved ? 'Saved. ' : ''}No appraisal requirements are posted to the appraiser for this file’s capital provider.
      </div>
    );
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════════════════
   ORDERS THE APPRAISAL COMPANY HAS THAT PILOT DOES NOT (2026-08-16).

   An appraisal ordered on AppraisalScope's own website — around an outage, out of
   habit, or re-issued by them under a new number — exists at the vendor and not
   here: nothing polls it, its report never files itself onto the condition, and
   the file reads as though no appraisal was ever ordered.

   IT REPORTS, IT DOES NOT ADOPT. Deciding that one of their orders IS a given
   file's appraisal is a judgement whose wrong answer files a stranger's report
   onto a loan, so this shows the evidence and leaves the decision with a person.

   ADMIN-ONLY BY SELF-HIDING. The route is `platform_setup`; anybody else gets a
   403 and this renders nothing at all rather than an error nobody can act on.
   Nothing is fetched until it is opened, because it reads the whole account.
   ════════════════════════════════════════════════════════════════════════════ */
function OutsidePilotOrders() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);   // null = never asked
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try { setState(await api.amcReconcile({ days: 90 })); }
    catch (e) {
      if (e && (e.status === 403 || /forbidden/i.test(e.message || ''))) { setDenied(true); setOpen(false); }
      else setState({ ok: false, error: 'error', message: (e && e.message) || 'Could not check.' });
    }
    setBusy(false);
  }, []);

  if (denied) return null;

  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <button className="aord-more" onClick={() => { setOpen(true); if (!state) check(); }}>
          Check for appraisals ordered outside PILOT
        </button>
      </div>
    );
  }

  const unknown = (state && state.unknown) || [];
  return (
    <div style={{ marginTop: 14, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div className="aord-eyebrow" style={{ margin: 0 }}>Ordered outside PILOT</div>
        <button className="btn ghost small" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check again'}</button>
        <button className="aord-more" style={{ marginLeft: 'auto' }} onClick={() => setOpen(false)}>Hide</button>
      </div>

      {busy && !state ? <div style={{ color: MUTED, fontSize: 13, marginTop: 8 }}>Asking the appraisal company…</div> : null}

      {state && !state.ok ? (
        <div style={{ marginTop: 8, fontSize: 13.5, color: MUTED }}>
          {state.error === 'not_enabled' ? 'The appraisal-company connection is switched off, so there is nothing to compare against.'
            : state.error === 'not_configured' ? 'The appraisal-company login is not set up yet.'
              : `Could not check: ${state.message || 'the appraisal company did not answer'}.`}
        </div>
      ) : null}

      {state && state.ok ? (
        <>
          <div style={{ marginTop: 8, fontSize: 13.5, color: MUTED }}>
            Checked {state.checked} order{state.checked === 1 ? '' : 's'} they placed in the last {state.days} days.
            {unknown.length === 0 ? ' Everything they hold is already tracked here.' : ''}
          </div>
          {unknown.length ? (
            <div style={{ marginTop: 10, overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13.5 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: MUTED }}>
                    <th style={{ padding: '4px 10px 4px 0' }}>Their order</th>
                    <th style={{ padding: '4px 10px 4px 0' }}>Loan #</th>
                    <th style={{ padding: '4px 10px 4px 0' }}>Property</th>
                    <th style={{ padding: '4px 10px 4px 0' }}>Their status</th>
                    <th style={{ padding: '4px 0' }}>Our file</th>
                  </tr>
                </thead>
                <tbody>
                  {unknown.map((u) => (
                    <tr key={u.spOrderNumber} style={{ borderTop: `1px solid ${LINE}`, color: INK }}>
                      <td style={{ padding: '6px 10px 6px 0' }}>{u.fileNumber || u.spOrderNumber}</td>
                      <td style={{ padding: '6px 10px 6px 0' }}>{u.loanNumber || '—'}</td>
                      <td style={{ padding: '6px 10px 6px 0' }}>{u.address || '—'}</td>
                      <td style={{ padding: '6px 10px 6px 0' }}>{u.status || '—'}</td>
                      <td style={{ padding: '6px 0', color: u.file ? INK : '#9A3B33' }}>
                        {u.file ? u.file.loanNumber : 'no matching file'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 8, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
                These are at the appraisal company and not in PILOT, so nothing here is chasing them and
                their reports will not file themselves onto a condition. Re-place the order from the right
                file, or ask the appraisal company to cancel it — PILOT will not adopt one on its own,
                because attaching the wrong property’s report to a loan is not a mistake it can undo.
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- header --- */
function VendorSelector({ vendor, onPick }) {
  // NAN IS FIRST AND IS WHERE THIS STARTS. Richer Values is a deliberate third
  // choice for a cheaper, different report — never a default (owner-directed
  // 2026-08-14). Do not reorder these to put a new vendor in front.
  return (
    <div className="seg" role="group" aria-label="Appraisal vendor">
      {[['nan', 'AppraisalScope / NAN'], ['class', 'Class'], ['rv', 'Richer Values']].map(([k, lbl]) => (
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
  // A payment failure on an order that WAS placed — kept apart from `err`, which
  // is the order-failure box, because "placed but not paid" and "not placed" are
  // different facts and must never render as the same one.
  const [payErr, setPayErr] = useState('');
  const [formOverride, setFormOverride] = useState('');
  const [cdorOverride, setCdorOverride] = useState('');
  // WHICH ADD-ONS THIS ORDER ASKS FOR. `null` means "nobody touched it", so the
  // form rule's own default still applies — and an EMPTY ARRAY means "none of
  // them", which is a different answer and has to survive as one, or unticking the
  // last box would silently put the rule's default back.
  const [addOnOverride, setAddOnOverride] = useState(null);

  // HOW THIS ORDER GETS PAID, chosen at the moment it goes out (owner-directed
  // 2026-08-16). `null` means "not now" and is the default, so an order can still
  // be placed exactly as before and paid later from its own card — nobody is ever
  // stuck because a card is wrong on the day.
  const [payMethod, setPayMethod] = useState(null);
  const [payCard, setPayCard] = useState({ number: '', expMonth: '', expYear: '', cvc: '', zip: '' });
  const [payOpts, setPayOpts] = useState(null);

  // The ways this company can be paid come from the SHARED table, never a list
  // typed into this screen — that table is what keeps the desk, the server and the
  // recorded instruction agreeing about what the ways are called.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.staffAppraisalPayment(appId);
        if (alive && s && s.vendors && s.vendors.nan) setPayOpts(s.vendors.nan.options || []);
      } catch (_) { if (alive) setPayOpts(null); }
    })();
    return () => { alive = false; };
  }, [appId]);

  // PRE-FILLED FROM THE CARD ON FILE, and editable — the owner's own words for
  // option 1: *"pre-filled with the credit card on file. You can manually change
  // it if you want."* So "enter a card now" starts as the card we already hold
  // rather than as five empty boxes, and typing over it is the change.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await api.staffAppraisalCard(appId);
        if (alive && c && c.number) {
          setPayCard({
            number: c.number,
            expMonth: c.expMonth != null ? String(c.expMonth) : '',
            expYear: c.expYear != null ? String(c.expYear) : '',
            cvc: c.cvc || '',
            zip: c.zip || '',
          });
        }
      } catch (_) { /* no card yet — the boxes stay empty, which is the truth */ }
    })();
    return () => { alive = false; };
  }, [appId]);

  const overrideParams = useCallback(() => {
    const o = {};
    if (formOverride) o.productCode = formOverride;
    if (cdorOverride) o.clientDisplayedId = cdorOverride;
    // Sent as a comma-joined string on BOTH the preview (a GET, where an array
    // cannot survive the query string) and the place (a POST) — the server reads
    // either shape, so there is one thing to get right rather than two.
    if (addOnOverride) o.subproductCodes = addOnOverride.join(',');
    return o;
  }, [formOverride, cdorOverride, addOnOverride]);

  const load = useCallback(async () => {
    try {
      const params = overrideParams();
      setPreview(await api.amcPreview(appId, Object.keys(params).length ? params : undefined).catch(() => null));
    } catch (_) { setPreview(null); }
  }, [appId, overrideParams]);

  useEffect(() => { load(); }, [load]);

  const place = useCallback(async (doPlace) => {
    setBusy(true); setNotice(''); setErr(''); setPayErr('');
    try {
      const out = await api.amcPlaceOrder(appId, {
        place: doPlace,
        ...overrideParams(),
        // Only when a way was actually chosen. No `payment` block is the old
        // behaviour, byte for byte.
        payment: (doPlace && payMethod)
          ? { method: payMethod, card: payMethod === 'NEW_CARD' ? payCard : undefined }
          : undefined,
      });
      if (!out.ok) setErr(parseOrderFailure(null, out));
      else {
        const placed = doPlace
          ? (out.dryrun ? 'Order built in test mode (nothing sent).' : 'Order placed with AppraisalScope / NAN.')
          : 'Draft saved.';
        // TWO OUTCOMES, REPORTED SEPARATELY. The order has been placed and cannot
        // be unsent, so a payment that failed is said out loud beside a successful
        // placement — never folded into it, and never reported as a failed order,
        // which is how somebody ends up placing a second one for the same
        // appraisal.
        const p = out.payment;
        if (!p) setNotice(placed);
        else if (p.ok && p.transactionId) setNotice(`${placed} Paid — AppraisalScope's receipt is ${p.transactionId}.`);
        else if (p.ok && Array.isArray(p.sent)) setNotice(`${placed} Invoice emailed to ${p.sent.join(' and ')} — it is not paid until they pay it.`);
        else {
          setNotice(placed);
          // A WARNING, NOT the order-failure box — that box's headline reads
          // "AppraisalScope could not place this order", which would be a lie
          // about the one fact that matters most here.
          setPayErr(p.detail || p.error || 'The payment did not go through.');
        }
        await onPlaced();
      }
    } catch (e) { setErr(parseOrderFailure(e, null)); }
    setBusy(false);
  }, [appId, overrideParams, onPlaced, payMethod, payCard]);

  const notConfigured = !cfg || !cfg.enabled;

  return (
    <div style={{ marginTop: 12 }}>
      <OrderFailure info={err} vendor="AppraisalScope / NAN" />
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      {payErr ? (
        <Banner tone="warn">
          <strong>The order is placed — the payment is not.</strong> {payErr} Pay it from the order card below.
        </Banner>
      ) : null}
      {preview ? (
        <PreviewCard preview={preview} busy={busy} onDraft={() => place(false)} onPlace={() => place(true)}
          outbound={!!(cfg && cfg.outbound)} appId={appId} onCardSaved={load}
          formValue={formOverride || (preview.spec && preview.spec.productCode) || ''}
          /* An add-on belongs to a FORM, so picking a different form throws the
             selection away rather than carrying codes across to a form that may
             not offer them. */
          onPickForm={(v) => { setFormOverride(v); setAddOnOverride(null); }}
          cdorValue={cdorOverride || (preview.spec && preview.spec.clientDisplayedId) || ''} onPickCdor={setCdorOverride}
          addOnValue={addOnOverride} onPickAddOns={setAddOnOverride}
          payOptions={payOpts} payMethod={payMethod} onPayMethod={setPayMethod}
          payCard={payCard} onPayCard={setPayCard} />
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

/* WHAT IT WILL COST, shown before the order goes out (2026-08-16).
 *
 * TWO NUMBERS, NEVER ONE. AppraisalScope answers two different questions and each
 * is misleading on its own: `form` is what this FORM costs on our account, and
 * `location` is what appraisers actually charge WHERE the property is. Showing
 * only the list price hides a rural premium; showing only the market rate hides
 * what we have agreed to pay.
 *
 * SILENT WHEN THERE IS NOTHING TO SAY. The quote is read from a cache and
 * refreshed behind the scenes, so the first preview on a cold cache has no
 * numbers — and an empty "Fee: —" row teaches people the figures are unreliable.
 * It appears when there is something real to show.
 */
function FeeQuote({ quote }) {
  if (!quote) return null;
  const q = (h) => (h && h.typical != null ? h : null);
  const form = q(quote.form);
  const loc = q(quote.location);
  if (!form && !loc) return null;
  const usd = (n) => `$${Math.round(Number(n)).toLocaleString('en-US')}`;
  const range = (h) => (h.low != null && h.high != null && h.high !== h.low
    ? ` (${usd(h.low)}–${usd(h.high)})` : '');
  return (
    <div style={{
      marginTop: 12, padding: '10px 12px', border: `1px solid ${LINE}`, borderRadius: 10,
      background: '#fff', display: 'flex', flexDirection: 'column', gap: 5,
    }}>
      <div className="aord-eyebrow" style={{ margin: 0 }}>What it should cost</div>
      {form ? (
        <div style={{ fontSize: 14, color: INK }}>
          <strong>{usd(form.typical)}</strong>
          <span style={{ color: MUTED }}> — this form, on our account{range(form)}</span>
        </div>
      ) : null}
      {loc ? (
        <div style={{ fontSize: 14, color: INK }}>
          <strong>{usd(loc.typical)}</strong>
          <span style={{ color: MUTED }}> — what appraisers charge around this property{range(loc)}</span>
        </div>
      ) : null}
      <div style={{ fontSize: 12, color: MUTED }}>
        Quoted by the appraisal company{quote.stale ? ' — refreshing' : ''}. The invoice is theirs; this is a guide.
      </div>
    </div>
  );
}

/* WHAT ELSE THIS FORM OFFERS (owner-directed 2026-08-17).
 *
 * AppraisalScope calls these "job type add-ons" — the extras that ride an order as
 * `products[].subproducts[].identifier`. PILOT has been able to SEND them since the
 * integration was written (a form rule can carry `subproduct_codes`), but the lookup
 * that says WHICH ones a form offers was being asked without the form, so it
 * answered nothing and no screen ever showed one. A staffer could only order an
 * add-on by already knowing its number.
 *
 * SILENT WHEN THERE IS NOTHING TO SAY — same discipline as the fee quote. The list
 * is read from a cache and refreshed behind the scenes, so the first preview on a
 * cold cache has nothing to show, and an empty "Add-ons: —" row would teach people
 * the section is broken.
 *
 * A CODE THE ACCOUNT NO LONGER OFFERS IS NAMED, NOT HIDDEN. A form rule can carry a
 * subproduct the vendor has since retired; sending it comes back as a refusal
 * nobody can explain, and this is the one moment it can be fixed before the order
 * goes out.
 */
function AddOns({ addOns, value, onChange }) {
  if (!addOns) return null;
  const available = addOns.available || [];
  const unknown = addOns.unknownSelected || [];
  if (!available.length && !unknown.length) return null;
  // `value` is the staffer's own selection once they touch it; before that, what
  // the order already carries.
  const selected = value || (addOns.selected || []).map((a) => a.id);
  const toggle = (id) => {
    const has = selected.includes(id);
    onChange(has ? selected.filter((x) => x !== id) : selected.concat(id));
  };
  return (
    <div style={{ marginTop: 12 }}>
      <div className="aord-eyebrow" style={{ margin: '0 0 4px' }}>Add-ons for this form</div>
      {available.map((a) => (
        <label key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: INK, padding: '3px 0' }}>
          <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} />
          <span>{a.name}<span style={{ color: MUTED }}> · #{a.id}</span></span>
        </label>
      ))}
      {unknown.length ? (
        <div style={{ marginTop: 6, fontSize: 12, color: WARN }}>
          This order asks for {unknown.length === 1 ? 'an add-on' : 'add-ons'} the appraisal company
          doesn’t list for this form ({unknown.join(', ')}). Check the form rule before ordering.
        </div>
      ) : null}
      {available.length ? (
        <div style={{ marginTop: 4, fontSize: 12, color: MUTED }}>
          Each add-on is charged on top of the form. Leave them all off unless the deal needs one.
        </div>
      ) : null}
    </div>
  );
}

function PreviewCard({ preview, busy, onDraft, onPlace, outbound, appId, onCardSaved, formValue, onPickForm, cdorValue, onPickCdor,
  addOnValue, onPickAddOns, payOptions, payMethod, onPayMethod, payCard, onPayCard }) {
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

      <AddOns addOns={preview.addOns} value={addOnValue} onChange={onPickAddOns} />

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
        {/* THE CARD IS ENTERABLE HERE, not only on the condition (owner-directed
            2026-08-05: "one card, entered once, both places"). It saves through the
            shared chokepoint, so typing it here fills the appraisal-card condition
            too — and a card the borrower typed on the condition already shows here.
            Payment stays manual; nothing is charged. */}
        <div>
          <Field label="Payment card">{cardOnFile.onFile ? ((cardOnFile.brand || 'card') + ' ••' + (cardOnFile.last4 || '')) : 'not on file'}</Field>
          {appId ? (
            <AppraisalCardEntry appId={appId} align="flex-start"
              label={cardOnFile.onFile ? 'Replace card' : 'Enter card'}
              onSaved={onCardSaved} />
          ) : null}
        </div>
      </div>

      <FeeQuote quote={preview.feeQuote} />

      <AmcPayment options={payOptions} method={payMethod} onMethod={onPayMethod}
        card={payCard} onCard={onPayCard} cardOnFile={cardOnFile}
        notifyEmails={notifyEmails} outbound={outbound} />

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
  'paymentMethod', 'paymentEmail',
]);
const PATH_TO_KEY = { propertyType: 'propertyTypeEnum', recipientEmail: 'paymentEmail' };
const overrideKeyFor = (path) => {
  const last = String(path || '').split('.').pop();
  const k = PATH_TO_KEY[last] || last;
  return EDITABLE.has(k) ? k : null;
};
const ENUM_FOR = { propertyTypeEnum: 'propertyTypeEnum', purpose: 'purpose', loanType: 'loanType', paymentMethod: 'paymentMethod' };

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
  // The payment methods ride alongside Class's own enums so the field row renders a
  // picker of their three values rather than a free text box.
  const enums = useMemo(() => ({ ...(options.enums || {}), paymentMethod: options.paymentMethods || ['Invoice', 'PaymentLink', 'Prepay'] }), [options]);
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
          <PaymentRow preview={preview} methods={enums.paymentMethod} overrides={overrides}
            onMethod={(v) => setOverride('paymentMethod', v)} onEmail={(v) => setOverride('paymentEmail', v)} />

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

/* ---- how the appraisal is paid — chosen HERE because Class's API only lets it be
   chosen when the order is placed (src/class/payment.js): Invoice bills our account,
   PaymentLink makes Class email the borrower their hosted payment page, Prepay is
   paid up front. There is no card charge in their API, so no card is asked for. ---- */
const PAYMENT_WORDS = {
  Invoice: { head: 'Bill YS Capital', sub: 'Class invoices our account. The back office settles it, or charges the card on file by hand and records it on the order.' },
  PaymentLink: { head: 'Email the borrower a payment link', sub: 'Class emails the borrower their own payment page when the order is placed. The order proceeds once they pay.' },
  Prepay: { head: 'Prepaid', sub: 'Paid up front, outside Class\'s system.' },
};
function PaymentRow({ preview, methods, overrides, onMethod, onEmail }) {
  const rows = (preview && preview.fields) || [];
  const methodRow = rows.find((f) => f.path === 'paymentDetails.paymentMethod');
  const emailRow = rows.find((f) => f.path === 'paymentDetails.recipientEmail');
  const current = (overrides.paymentMethod || (methodRow && methodRow.value) || 'Invoice');
  const words = PAYMENT_WORDS[current] || { head: current, sub: '' };
  const chosen = !!overrides.paymentMethod;
  const list = Array.isArray(methods) && methods.length ? methods : ['Invoice', 'PaymentLink', 'Prepay'];
  return (
    <div style={{ border: `1px solid ${chosen ? TEAL : LINE}`, borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: '.03em' }}>How it is paid</div>
          <div style={{ color: INK, fontWeight: 600 }}>{words.head}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{words.sub}</div>
        </div>
        <div className="seg">
          {list.map((m) => (
            <button type="button" key={m} className={current === m ? 'on' : ''} aria-pressed={current === m}
              onClick={() => onMethod(m === 'Invoice' && !overrides.paymentMethod ? '' : m)}>
              {(PAYMENT_WORDS[m] || {}).head || m}
            </button>
          ))}
        </div>
      </div>
      {current === 'PaymentLink' ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12.5, color: INK, minWidth: 160 }}>Send the payment link to</label>
          <input type="email" style={{ ...inputStyle, flex: 1, minWidth: 220 }}
            value={overrides.paymentEmail != null ? overrides.paymentEmail : ((emailRow && emailRow.value) || '')}
            placeholder="borrower@example.com"
            onChange={(e) => onEmail(e.target.value)} />
          <div style={{ width: '100%', fontSize: 12, color: MUTED }}>
            The borrower&apos;s email from the file is used unless you change it. The loan officer and processor follow the order in PILOT, not through Class&apos;s link.
          </div>
        </div>
      ) : null}
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
                {/* THE FEE BEFORE ORDERING, as far as Class allows: their API has no
                    quote, so this is what they LAST charged us for this product. */}
                {p.recentFee && p.recentFee.lastCents != null ? (
                  <span style={{ color: MUTED, fontSize: 12 }}>
                    {' · last time '}{money(p.recentFee.lastCents / 100)}
                    {p.recentFee.count > 1 && p.recentFee.lowCents !== p.recentFee.highCents ? ` (${money(p.recentFee.lowCents / 100)}–${money(p.recentFee.highCents / 100)} over ${p.recentFee.count})` : ''}
                  </span>
                ) : null}
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

/* =================================================== Richer Values builder === */
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

  /* WHAT WILL THEY CHARGE FOR *THIS* ORDER — asked live before it is placed
     (2026-08-16: their pricing endpoint was built and nothing ever called it).
     The preview carries a price for the DEFAULT product; the moment a staffer
     changes the report, the inspection or the turnaround, that number describes a
     different order from the one about to be placed. This asks them again with
     the choices as they stand.

     It never blocks and never orders: a re-price that fails leaves the preview's
     own figure showing, which is stale rather than wrong. */
  const [priceNow, setPriceNow] = useState(null);
  const [pricing, setPricing] = useState(false);
  const reprice = useCallback(async () => {
    setPricing(true);
    try { setPriceNow(await api.rvPrice(appId, overrides)); }
    catch (e) { setPriceNow({ error: (e && e.message) || 'Could not get a price.' }); }
    setPricing(false);
  }, [appId, overrides]);
  // A changed choice makes the last quote about a different order. Drop it rather
  // than leave a number on screen that no longer describes what would be ordered.
  useEffect(() => { setPriceNow(null); }, [overrides]);

  /* WHAT WE WOULD SEND THEM AS THE SCOPE OF WORK — their own read of the file's
     budget, so somebody can look BEFORE sending rather than after. */
  const [sowPreview, setSowPreview] = useState(null);
  const showScopeOfWork = useCallback(async () => {
    if (sowPreview) { setSowPreview(null); return; }
    try { setSowPreview(await api.rvScopeOfWork(appId)); }
    catch (e) { setSowPreview({ error: (e && e.message) || 'Could not read the scope of work.' }); }
  }, [appId, sowPreview]);

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
          ? 'Test mode — the order was built and written to the log. Nothing was sent to Richer Values.'
          : 'Order placed with Richer Values.'];
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
      <OrderFailure info={err} vendor="Richer Values" />
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
              Richer Values’s list of what we can order could not be refreshed just now, so this is the last one we saw
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

          {/*
            AFTER THE WORK — the answer Richer Values need in order to price an ARV.
            Their own screen offers a "same-unchanged" option; their API has no such
            value (their proposed_* fields take numbers and nothing else, measured),
            so ticking this sends the property's figures as they stand today. Only
            offered on a report that asks for after-work figures AND knows the
            figures today — on a ground-up there is no "now" to be the same as.
          */}
          {preview.choices && preview.choices.asksProposedStats !== false
            && preview.choices.asksCurrentStats !== false ? (
              <div style={{ marginTop: 10, fontSize: 13, color: INK }}>
                <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!choices.proposedSameAsCurrent}
                    onChange={(e) => setOverride('proposedSameAsCurrent', e.target.checked ? '1' : '0')} />
                  After the work it is the same — no change to the size, bedrooms or bathrooms
                </label>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.45 }}>
                  {choices.proposedSameAsCurrent
                    ? 'The property’s figures as they stand today will be sent as the figures after the work.'
                    : 'Otherwise fill in what the property will be after the work below. Richer Values cannot produce an after-repair value without it — an order left blank, or sent as zero, sits with them and never starts.'}
                </div>
              </div>
            ) : null}

          {/* ── what it costs, for this property ────────────────────────── */}
          {price ? (
            <div className="aord-figs" style={{ gridTemplateColumns: '1fr' }}>
              <div className="aord-fig">
                {/*
                  THE HEADLINE IS THE ALL-IN FIGURE — what is actually charged, and
                  what the desk quotes the borrower (owner-directed 2026-08-16).
                  Their `cc_surcharge` sits OUTSIDE `total_price`, so before this the
                  number on this screen was the one figure nobody ever pays.
                */}
                <div className="k">Price for this property</div>
                <div className="v">{moneyExact(rvOrderTotal(price))}</div>
                <div className="n">
                  {[
                    price.report_type_fee ? `report ${moneyExact(price.report_type_fee)}` : null,
                    price.inspection_fee ? `inspection ${moneyExact(price.inspection_fee)}` : null,
                    price.rush_fee ? `rush ${moneyExact(price.rush_fee)}` : null,
                    price.gla_surcharge ? `floor plan ${moneyExact(price.gla_surcharge)}` : null,
                    price.licensing_surcharge ? `licensed ${moneyExact(price.licensing_surcharge)}` : null,
                    price.flood_charge ? `flood ${moneyExact(price.flood_charge)}` : null,
                    Number(price.cc_surcharge) > 0 ? `card fee ${moneyExact(price.cc_surcharge)}` : null,
                  ].filter(Boolean).join(' · ')}
                  {price.due_date ? ` · report due ${fmtDate(price.due_date)}` : ''}
                </div>
                {/*
                  THE CARD FEE IS NAMED, not merely folded in. The breakdown above
                  already lists it, and this line says plainly that the headline
                  INCLUDES it — a total that silently differs from the vendor's own
                  invoice line is how somebody comes to think we were overcharged.
                */}
                {Number(price.cc_surcharge) > 0 ? (
                  <div className="n" style={{ marginTop: 4 }}>
                    Includes the {moneyExact(price.cc_surcharge)} card fee Richer Values adds
                    (their own report price is {moneyExact(price.total_price)}). Quote the borrower the total above.
                  </div>
                ) : null}
              </div>
            </div>
          ) : preview.priceError ? (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 10 }}>
              Richer Values could not price this right now, so the figure above is not shown. You can still order.
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
            <SectionTitle>What we will send to Richer Values</SectionTitle>
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

          {/* ── things Richer Values refuses on this branch ──────────────── */}
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
          {/* THEIR OWN READ of what we would send as the scope of work — asked
              live, so somebody can check it before it goes rather than after. */}
          <div style={{ marginTop: 8 }}>
            <button className="aord-more" onClick={showScopeOfWork}>
              {sowPreview ? 'Hide what we would send them' : 'See exactly what we would send them'}
            </button>
            {sowPreview ? (
              <div style={{ marginTop: 8, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, background: '#fff' }}>
                {sowPreview.error ? (
                  <div style={{ color: MUTED, fontSize: 13 }}>{sowPreview.error}</div>
                ) : (
                  <>
                    <div style={{ fontSize: 13.5, color: INK }}>
                      {sowPreview.file ? `${sowPreview.file.filename || 'The scope of work'}` : 'The scope of work on this file'}
                      {sowPreview.total != null ? ` — ${money(sowPreview.total)}` : ''}
                    </div>
                    {sowPreview.error || sowPreview.reason ? (
                      <div style={{ fontSize: 12.5, color: WARN, marginTop: 4 }}>{sowPreview.reason || sowPreview.error}</div>
                    ) : null}
                    {Array.isArray(sowPreview.lines) && sowPreview.lines.length ? (
                      <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto', fontSize: 13, color: MUTED }}>
                        {sowPreview.lines.slice(0, 60).map((l, i) => (
                          <div key={i}>{l.name || l.label || l.category || '—'}{l.amount != null ? ` · ${money(l.amount)}` : ''}</div>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
          {/* WHAT THEY WOULD CHARGE FOR THE ORDER AS IT NOW STANDS. The preview's
              price is for the DEFAULT product; a changed report or inspection makes
              it a price for a different order, so it can be asked again here. */}
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <button className="aord-more" disabled={pricing} onClick={reprice}>
              {pricing ? 'Asking them…' : 'Price this exact order'}
            </button>
            {priceNow && !priceNow.error ? (
              <span style={{ fontSize: 13.5, color: INK }}>
                Richer Values quote: <strong>{money(priceNow.total_price != null ? priceNow.total_price : (priceNow.price && priceNow.price.total_price))}</strong>
              </span>
            ) : null}
            {priceNow && priceNow.error ? <span className="muted small">{priceNow.error}</span> : null}
          </div>
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
 * MEASURED against Richer Values's own training tenant: the same order WITH a scope
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
          ? <>PILOT attaches <b>{sow.filename}</b> automatically, so Richer Values can value the property after the work.</>
          : sow.why}
      </div>
      {sow.warning ? <div style={{ fontSize: 12, color: WARN, marginTop: 4 }}>{sow.warning}</div> : null}
    </div>
  );
}

/* ── how it gets paid ────────────────────────────────────────────────────── */
/*
 * Exactly the four ways the owner allows. Add to Invoice and ACH are not shown
 * because they are not offered at all — a control for something the server refuses
 * is worse than no control.
 *
 * OUR OWN CARD IS FIRST AND IS THE DEFAULT, because the owner's answer was "we pay
 * in-house, payment link as the backup". It is also the one card route that works:
 * Richer Values' Stripe account refuses a raw card number, so both of the card
 * routes underneath it can only end in a refusal today.
 */
const RV_PAY_LABEL = {
  COMPANY_CARD: 'Charge our card with Richer Values',
  CARD_ON_FILE: 'Charge the card on this file',
  NEW_CARD: 'Enter a card now',
  PAYMENT_LINK: 'Send the borrower a payment link',
};

/**
 * HOW THIS APPRAISALSCOPE ORDER GETS PAID — chosen as it goes out.
 *
 * The owner's three (2026-08-16), in the owner's own words:
 *   1. charge a card, PRE-FILLED with the card on file, editable
 *   2. if there is no card on file, type one in
 *   3. send a payment link to the borrower and the loan officer
 *
 * Note that 1 and 2 are the SAME control here, which is deliberate rather than a
 * shortcut: "the card on file, which you may change" and "a card typed in" differ
 * only by whether the boxes started full, and splitting them into two radio
 * buttons would ask a person to classify their own intent before they have looked
 * at the number. "Use the card on file" charges what we hold; "enter a card now"
 * opens those same boxes pre-filled with it, and typing over them is the change.
 *
 * THE WAYS COME FROM THE SHARED TABLE, never a list typed here — a hard-coded set
 * is how a screen ends up offering a way the server refuses, or hiding one it
 * added. `options` being null (the read failed, or the desk has not answered yet)
 * renders NOTHING rather than a guessed set: an order placed with no payment is a
 * recoverable state, and one placed against an invented option is not.
 *
 * NOT NOW IS ALWAYS AVAILABLE and is the default. A card can be wrong on the day,
 * a fee can be in dispute, and an order that cannot be placed because payment is
 * insisted upon is a dead end — the Pay button on the order card is still there.
 */
function AmcPayment({ options, method, onMethod, card, onCard, cardOnFile, notifyEmails, outbound }) {
  if (!Array.isArray(options) || !options.length) return null;
  const set = (k, v) => onCard({ ...card, [k]: v });
  const chosen = options.find((o) => o.method === method) || null;
  const officerLine = (notifyEmails || []).filter(Boolean);

  return (
    <div style={{ marginTop: 14 }}>
      <SectionTitle>How this order gets paid</SectionTitle>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 13, color: INK }}>
        <label style={{ display: 'inline-flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
          <input type="radio" name="amc-pay" checked={!method} onChange={() => onMethod(null)} />
          Not now
        </label>
        {options.map((o) => (
          <label key={o.method} title={o.disabled || o.says}
            style={{ display: 'inline-flex', gap: 7, alignItems: 'center', cursor: o.available ? 'pointer' : 'not-allowed',
              color: o.available ? INK : MUTED }}>
            <input type="radio" name="amc-pay" disabled={!o.available}
              checked={method === o.method} onChange={() => onMethod(o.method)} />
            {o.label}
          </label>
        ))}
      </div>

      {/* WHY a way cannot be used, kept on screen rather than hiding the option —
          a greyed row with a reason teaches what to do next; a vanished one just
          looks like the feature is missing. */}
      {options.filter((o) => !o.available && o.disabled).map((o) => (
        <div key={o.method} style={{ fontSize: 12, color: WARN, marginTop: 6, lineHeight: 1.45 }}>
          <b>{o.label}:</b> {o.disabled}
        </div>
      ))}

      {chosen ? (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 6, lineHeight: 1.45 }}>
          {chosen.says}
          {chosen.caveat ? <div style={{ color: WARN, marginTop: 3 }}>{chosen.caveat}</div> : null}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 6, lineHeight: 1.45 }}>
          Nothing is charged when the order goes out. You can pay it from the order card afterwards.
        </div>
      )}

      {method === 'CARD_ON_FILE' && cardOnFile && cardOnFile.onFile ? (
        <div style={{ fontSize: 12.5, color: INK, marginTop: 6 }}>
          AppraisalScope will charge <b>{cardOnFile.brand || 'the card'} ••{cardOnFile.last4 || '????'}</b>.
        </div>
      ) : null}

      {method === 'PAYMENT_LINK' ? (
        <div style={{ fontSize: 12.5, color: INK, marginTop: 6, lineHeight: 1.5 }}>
          AppraisalScope emails their invoice to the borrower and the loan officer.
          {officerLine.length ? <> Order updates already go to <span style={{ color: MUTED }}>{officerLine.join(', ')}</span>.</> : null}
        </div>
      ) : null}

      {method === 'NEW_CARD' ? (
        <>
          <div style={{ fontSize: 12, color: MUTED, margin: '6px 0 8px', lineHeight: 1.45 }}>
            Pre-filled with the card already on this file — change anything you need to. It is saved onto the
            appraisal-card condition first, encrypted the same way every card here is, and then charged. The security
            code is required: AppraisalScope will not charge a card without it.
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

      {method && !outbound ? (
        <div style={{ fontSize: 12, color: WARN, marginTop: 8, lineHeight: 1.45 }}>
          Sending to AppraisalScope is switched off, so this will be saved as a draft and nothing will be charged.
        </div>
      ) : null}
    </div>
  );
}

function RvPayment({ payment, method, onMethod, card, onCard, linkTo, onLinkTo }) {
  if (!payment) return null;
  const methods = payment.methods || ['COMPANY_CARD', 'CARD_ON_FILE', 'NEW_CARD', 'PAYMENT_LINK'];
  const chosen = method || payment.method || 'COMPANY_CARD';
  const cc = payment.companyCard || null;
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

      {/* OUR CARD — what it will charge, or exactly what a human has to go and do
          about it, said here rather than at the moment of payment. */}
      {chosen === 'COMPANY_CARD' ? (
        <div style={{ fontSize: 12, color: cc && cc.known && !cc.ready ? WARN : MUTED, marginTop: 6, lineHeight: 1.45 }}>
          {!cc || !cc.known
            ? 'PILOT will charge the card YS Capital keeps with Richer Values. It could not check which card that is right now — if the charge does not go through, the payment link below still works.'
            : cc.ready
              ? (cc.card && cc.card.last4
                ? <>The card YS Capital keeps with Richer Values (<b>{cc.card.brand || 'card'} ending {cc.card.last4}</b>) will be charged. The borrower is not asked to pay.</>
                : 'The card YS Capital keeps with Richer Values will be charged. The borrower is not asked to pay.')
              : cc.why}
        </div>
      ) : null}

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
          The order is placed either way — Richer Values starts work once the borrower has paid.
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
  if (!enabled) block = { title: 'Richer Values is not turned on yet.', help: 'You can see exactly what would be sent. Turn on “Order Hybrid Appraisals from Richer Values” on the API Health page to order for real.' };
  else if (cfg && !cfg.orderReady) block = { title: 'Richer Values is not fully set up yet.', help: 'A sign-in or an API token is set, but PILOT still needs to know which of their companies to order for. See the API Health page.' };
  else if (preview && preview.blocked) block = { title: 'This property cannot be ordered on this product.', help: preview.blocked };
  else if (missing.length) {
    block = {
      title: `${missing.length} thing${missing.length === 1 ? '' : 's'} still needed before this can be ordered.`,
      help: missing.map((m) => `${m.label}${m.why ? ` — ${m.why}` : ''}`).join(' · '),
    };
  } else if (!outbound && !dry) block = { title: 'Ordering is switched off.', help: 'Turn on “Place Hybrid Appraisal orders with Richer Values” on the API Health page.' };

  return (
    <div style={{ marginTop: 16 }}>
      <button className="btn primary" disabled={busy || !canPlace || (!outbound && !dry)}
        aria-disabled={busy || !canPlace} onClick={onPlace}>
        {busy ? 'Ordering…' : dry ? 'Build the order (test mode)'
          : price ? `Order the Hybrid Appraisal — ${moneyExact(rvOrderTotal(price))}` : 'Order the Hybrid Appraisal'}
      </button>
      {block ? <WhyBox title={block.title}>{block.help}</WhyBox>
        : dry ? <WhyBox title="Test mode is on — this button will NOT send anything.">To place the order for real, turn OFF “Richer Values orders — TEST MODE” on the API Health page.</WhyBox>
          : (
            <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>
              This costs money{price ? ` (${moneyExact(rvOrderTotal(price))})` : ''} and sends an inspector to the property.
              It also waives the appraisal data file on this file — this report does not produce one.
            </div>
          )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   EVERYTHING ELSE RICHER VALUES CAN DO (2026-08-16).

   Eleven of their controls were fully built on the server — routed, validated,
   journalled and audited — with no button anywhere, so an order could be placed
   and then not paused, not resumed, not set aside, not brought back, not
   reopened, its product not changed, its documents never sent, and its payment
   picture never read. This is that surface.

   IT IS ONE CONTROL, NOT ELEVEN MORE BUTTONS. These are the exceptions to a
   normal order's life; putting them in the main row would bury "check with them"
   and "put these on the file" among things almost nobody presses.

   EACH ACTION APPEARS ONLY WHERE IT MEANS SOMETHING. Their own rules decide:
   a hold can only be released on a held order, a finished report is the only
   thing there is to reopen, and the product can only be changed while the order
   is still live. A button that is always there and usually errors teaches people
   to distrust the whole panel.

   THE SERVER IS THE AUTHORITY ON ALL OF IT. Every refusal here mirrors a check
   the route already makes (a reason of at least eight characters, one of their
   five reopen reasons); the point of repeating it is a plain sentence instead of
   a 400, never a second rule that could drift from theirs.
   ════════════════════════════════════════════════════════════════════════════ */
const RV_REOPEN_REASONS = [
  ['edits', 'Corrections to the report'],
  ['new-budget', 'The renovation budget changed'],
  ['new-specs', 'The scope or specs changed'],
  ['dispute', 'We disagree with the value'],
  ['market-update', 'The market has moved'],
];

function RvMoreActions({ order, detail, busy, run }) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState('');          // '' | 'hold' | 'reopen' | 'product' | 'documents' | 'payment'
  const [reason, setReason] = useState('');
  const [reopenType, setReopenType] = useState('');
  const [catalogue, setCatalogue] = useState(null);
  const [pick, setPick] = useState({ reportType: '', inspectionType: '' });
  const [docs, setDocs] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [field, setField] = useState('other_files');
  const [payment, setPayment] = useState(null);
  const [localErr, setLocalErr] = useState('');

  const status = String(order.status || '');
  const held = status === 'on_hold';
  const finished = status === 'completed';
  const setAside = ['cancelled', 'dismissed'].includes(status);
  const live = !setAside && !finished;

  const openPane = async (p) => {
    setPane(pane === p ? '' : p); setLocalErr(''); setReason('');
    if (p === 'product' && !catalogue) {
      try { setCatalogue(await api.rvCatalogue({})); } catch (_) { setCatalogue({ available: false, reportTypes: [], inspectionTypes: [] }); }
    }
    if (p === 'documents' && !docs) {
      try {
        const r = await api.amcDocuments(order.application_id);
        setDocs((r && r.documents) || []);
      } catch (_) { setDocs([]); }
    }
    if (p === 'payment' && !payment) {
      try { setPayment(await api.rvPaymentState(order.application_id)); } catch (_) { setPayment({ error: true }); }
    }
  };

  if (!open) {
    return <button className="aord-btn" onClick={() => setOpen(true)}>More…</button>;
  }

  const need = (s, n, what) => {
    if (String(s || '').trim().length < n) { setLocalErr(`Add a short ${what} — at least ${n} characters, so the record says why.`); return false; }
    return true;
  };

  return (
    <div style={{ flexBasis: '100%', marginTop: 8, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, background: '#fff' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span className="aord-eyebrow" style={{ margin: 0 }}>More Richer Values actions</span>
        <button className="aord-more" style={{ marginLeft: 'auto' }} onClick={() => { setOpen(false); setPane(''); }}>Close</button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        {live ? (
          <button className="aord-btn" onClick={() => openPane('hold')} aria-pressed={pane === 'hold'}>
            {held ? 'Take the hold off' : 'Put the order on hold'}
          </button>
        ) : null}
        {finished ? (
          <button className="aord-btn" onClick={() => openPane('reopen')} aria-pressed={pane === 'reopen'}>Reopen the report</button>
        ) : null}
        {live ? (
          <button className="aord-btn" onClick={() => openPane('product')} aria-pressed={pane === 'product'}>Change the report or inspection</button>
        ) : null}
        {live ? (
          <button className="aord-btn" onClick={() => openPane('documents')} aria-pressed={pane === 'documents'}>Send them documents</button>
        ) : null}
        <button className="aord-btn" onClick={() => openPane('payment')} aria-pressed={pane === 'payment'}>Payment</button>
        {live && !order.paid_at ? (
          <button className="aord-btn" disabled={!!busy}
            onClick={async () => {
              if (!(await askConfirm('Set this order aside at Richer Values? It stops being worked; it can be brought back afterwards.',
                { title: 'Set the order aside', confirmLabel: 'Set it aside' }))) return;
              await run('dismiss', () => api.rvDismiss(order.id), 'Richer Values has set the order aside.');
            }}>
            {busy === 'dismiss' ? 'Setting aside…' : 'Set the order aside'}
          </button>
        ) : null}
        {setAside ? (
          <button className="aord-btn" disabled={!!busy}
            onClick={() => run('reactivate', () => api.rvReactivate(order.id), 'Richer Values has brought the order back.')}>
            {busy === 'reactivate' ? 'Bringing back…' : 'Bring the order back'}
          </button>
        ) : null}
      </div>

      {localErr ? <div style={{ marginTop: 8 }}><Banner tone="bad">{localErr}</Banner></div> : null}

      {/* ---- hold / release ---- */}
      {pane === 'hold' ? (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input className="input" style={{ flex: 1, minWidth: 220 }}
            placeholder={held ? 'Note (optional) — what changed?' : 'Why is this going on hold?'}
            value={reason} onChange={(e) => { setReason(e.target.value); setLocalErr(''); }} />
          <button className="btn small" disabled={!!busy} onClick={async () => {
            if (held) { await run('hold', () => api.rvReleaseHold(order.id, reason.trim()), 'The hold is off — Richer Values is working it again.'); setPane(''); return; }
            if (!need(reason, 8, 'reason')) return;
            await run('hold', () => api.rvHold(order.id, reason.trim()), 'Richer Values has put the order on hold.');
            setPane('');
          }}>{busy === 'hold' ? 'Working…' : held ? 'Take the hold off' : 'Put it on hold'}</button>
        </div>
      ) : null}

      {/* ---- reopen a finished report ---- */}
      {pane === 'reopen' ? (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <select value={reopenType} onChange={(e) => { setReopenType(e.target.value); setLocalErr(''); }}
            style={{ minWidth: 230, border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
            <option value="">Why is it being reopened…</option>
            {RV_REOPEN_REASONS.map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
          </select>
          <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="What needs to change?"
            value={reason} onChange={(e) => { setReason(e.target.value); setLocalErr(''); }} />
          <button className="btn small" disabled={!!busy} onClick={async () => {
            if (!reopenType) { setLocalErr('Pick why it is being reopened — Richer Values only accepts their own five reasons.'); return; }
            if (!need(reason, 8, 'note')) return;
            await run('reopen', () => api.rvReopen(order.id, { reopenType, notes: reason.trim() }),
              'Richer Values is redoing the report.');
            setPane('');
          }}>{busy === 'reopen' ? 'Reopening…' : 'Reopen it'}</button>
        </div>
      ) : null}

      {/* ---- change the product ---- */}
      {pane === 'product' ? (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {!catalogue ? <span className="muted small">Loading what they offer…</span> : null}
          {catalogue && !catalogue.available ? <span className="muted small">Their catalogue is not readable right now.</span> : null}
          {catalogue && catalogue.available ? (
            <>
              <select value={pick.reportType} onChange={(e) => setPick((p) => ({ ...p, reportType: e.target.value }))}
                style={{ minWidth: 190, border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
                <option value="">Change the report…</option>
                {(catalogue.reportTypes || []).map((r) => (
                  <option key={r.value || r.id || r} value={r.value || r.id || r}>{r.label || r.name || r.value || r}</option>
                ))}
              </select>
              <select value={pick.inspectionType} onChange={(e) => setPick((p) => ({ ...p, inspectionType: e.target.value }))}
                style={{ minWidth: 190, border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
                <option value="">Change the inspection…</option>
                {(catalogue.inspectionTypes || []).map((r) => (
                  <option key={r.value || r.id || r} value={r.value || r.id || r}>{r.label || r.name || r.value || r}</option>
                ))}
              </select>
              <button className="btn small" disabled={!!busy || (!pick.reportType && !pick.inspectionType)} onClick={async () => {
                // Changing the REPORT re-prices, so it is confirmed; changing the
                // inspection is the cheaper of the two and is not.
                if (pick.reportType) {
                  if (!(await askConfirm('Change the report Richer Values is producing? This re-prices the order.',
                    { title: 'Change the report', confirmLabel: 'Change it' }))) return;
                  await run('product', () => api.rvSetReportType(order.id, pick.reportType), 'Richer Values has the new report type.');
                }
                if (pick.inspectionType) {
                  await run('product', () => api.rvSetInspection(order.id, pick.inspectionType), 'Richer Values has the new inspection type.');
                }
                setPane(''); setPick({ reportType: '', inspectionType: '' });
              }}>{busy === 'product' ? 'Changing…' : 'Send the change'}</button>
              <div className="muted small" style={{ flexBasis: '100%' }}>
                Changing the report re-prices the order. Today it is {order.report_type || 'their default report'}
                {order.inspection_type ? ` with a ${order.inspection_type} inspection` : ''}.
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* ---- send them documents off this file ---- */}
      {pane === 'documents' ? (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!docs ? <span className="muted small">Loading this file’s documents…</span> : null}
          {docs && !docs.length ? <span className="muted small">There is nothing on this file to send yet.</span> : null}
          {docs && docs.length ? (
            <>
              <select value={field} onChange={(e) => setField(e.target.value)}
                style={{ maxWidth: 260, border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
                {[['budget_files', 'Renovation budget'], ['photo_files', 'Photos'], ['video_files', 'Video'],
                  ['inspection_files', 'A prior inspection'], ['plan_files', 'Plans'], ['contract_files', 'The contract'],
                  ['other_files', 'Something else']].map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
              </select>
              <div style={{ maxHeight: 190, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {docs.map((d) => (
                  <label key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, color: INK }}>
                    <input type="checkbox" checked={chosen.includes(d.id)}
                      onChange={(e) => setChosen((c) => (e.target.checked ? c.concat(d.id) : c.filter((x) => x !== d.id)))} />
                    <span>{d.filename}</span>
                  </label>
                ))}
              </div>
              <div>
                <button className="btn small" disabled={!!busy || !chosen.length} onClick={async () => {
                  await run('senddocs', () => api.rvSendDocuments(order.id, chosen, field),
                    `Sent ${chosen.length} document${chosen.length === 1 ? '' : 's'} to Richer Values.`);
                  setChosen([]); setPane('');
                }}>{busy === 'senddocs' ? 'Sending…' : `Send ${chosen.length || ''} to Richer Values`}</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* ---- the payment picture ---- */}
      {pane === 'payment' ? (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          {!payment ? <span className="muted small">Loading…</span> : null}
          {payment && payment.error ? <span className="muted small">The payment picture could not be read.</span> : null}
          {payment && !payment.error ? (
            <>
              <span style={{ fontSize: 13.5, color: INK }}>
                {order.paid_at ? 'This order is paid.' : 'This order has not been paid yet.'}
                {payment.card && payment.card.last4 ? ` Card on file ••${payment.card.last4}.` : ''}
                {payment.sources && payment.sources.length ? ` ${payment.sources.length} saved payment source(s) at Richer Values.` : ''}
              </span>
              {!order.paid_at ? (
                <button className="aord-btn" disabled={!!busy}
                  onClick={() => run('paylink', () => api.rvSendPaymentLink(order.id, {}),
                    'Richer Values has emailed the borrower their payment link.')}>
                  {busy === 'paylink' ? 'Sending…' : 'Email the borrower a payment link'}
                </button>
              ) : null}
              {order.payment_link ? (
                <a href={order.payment_link} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: TEAL }}>Open the payment link</a>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {detail && detail.order && detail.order.status_reason ? (
        <div className="muted small" style={{ marginTop: 10 }}>Their last note: {detail.order.status_reason}</div>
      ) : null}
    </div>
  );
}

/* =============================================== Richer Values order card === */
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
      // case that matters: a card charge Richer Values refuses falls through to the
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
          Richer Values says: {order.vendor_status || '—'}
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
          onClick={() => run('refresh', () => api.rvRefresh(order.id), 'Checked with Richer Values.')}>
          {busy === 'refresh' ? 'Checking…' : 'Check with Richer Values'}
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
            {/* OUR CARD FIRST. It falls through to the payment link on the server if
                the charge cannot be made, so this button can never be a dead end. */}
            <button className="aord-btn" disabled={!!busy}
              onClick={() => run('pay', () => api.rvPay(order.id, { method: 'COMPANY_CARD' }),
                'Paid with our card at Richer Values — it is a real order now.')}>
              {busy === 'pay' ? 'Charging…' : 'Pay with our card'}
            </button>
            <button className="aord-btn" disabled={!!busy}
              onClick={() => run('link', () => api.rvPay(order.id, { method: 'PAYMENT_LINK' }),
                'Richer Values has emailed the borrower their payment link.')}>
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
              'Send Richer Values the scope of work as it stands on this file now? If they have already finished the report, '
              + 'they will be asked to redo the after-repair value against the new one.',
              { title: 'Send the updated scope of work', confirmLabel: 'Send it' }))) return;
            await run('sow', () => api.rvSendScopeOfWork(order.id), 'Richer Values has the updated scope of work.');
          }}>
            {busy === 'sow' ? 'Sending…' : 'Send the updated scope of work'}
          </button>
        ) : null}
        {/* MORE THINGS RICHER VALUES CAN DO — every one of these was built on the
            server and had no button anywhere (audit, 2026-08-16), so an order could
            be placed and then not paused, not set aside, not brought back, not
            reopened, and its product not changed. They are grouped behind one
            control rather than added to this row: they are the exceptions, and a
            row of eleven equal buttons is how the two people use most stop being
            findable. */}
        {order.intake_token && !order.dryrun ? (
          <RvMoreActions order={order} detail={detail} busy={busy} run={run} />
        ) : null}
        <span className="sep" />
        {ad.canCancel(order) ? (
          <button className="aord-btn" disabled={!!busy} onClick={async () => {
            const reason = await askPrompt('Why is this order being cancelled? It goes to Richer Values and onto the file.',
              { title: 'Cancel the Hybrid Appraisal' });
            if (reason == null) return;
            if (String(reason).trim().length < 8) { setErr('Add a slightly longer reason — Richer Values is told what it says.'); return; }
            await run('cancel', () => api.rvCancel(order.id, String(reason).trim()), 'Cancellation asked for. It shows as cancelled once Richer Values confirms.');
          }}>Cancel</button>
        ) : null}
        <button className="aord-more" style={{ marginLeft: 'auto' }} onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide details' : 'Details'}
        </button>
      </div>

      {open ? <RvOrderDetail order={order} detail={detail} /> : null}

      <RvMessages appId={order.application_id} />
    </div>
  );
}

/**
 * Talking to the Richer Values team.
 *
 * Their API has no messaging at all, so this is EMAIL to the desk they answer on —
 * and the reason it belongs on the order rather than in somebody's mail client is
 * that their reply comes back HERE, onto the file, with its attachments filed.
 *
 * Collapsed until asked for: most orders never need a conversation, and an empty
 * message box on every card is noise. The count is on the header so a waiting reply
 * is visible without opening anything.
 */
function RvMessages({ appId }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!appId) return;
    try { setState(await api.rvMessages(appId)); } catch (_) { /* the card still renders */ }
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const msgs = (state && state.messages) || [];
  const send = async () => {
    const text = body.trim();
    if (!text) { setErr('Write a message first.'); return; }
    setBusy(true); setErr(''); setNotice('');
    try {
      const out = await api.rvSendMessage(appId, text);
      setBody('');
      // Say plainly whether their answer will come back to the file. When no inbound
      // address is configured the message still goes — it just replies to the sender —
      // and a desk that is not told that will wait here for an answer that never lands.
      setNotice(out && out.routedBack
        ? 'Sent. Their reply will come back onto this order.'
        : 'Sent — but their reply will go to your own inbox, not this order.');
      await load();
    } catch (e) { setErr(e.message || 'Could not send the message.'); }
    setBusy(false);
  };

  return (
    <div className="aord-msgs">
      <button className="aord-more" onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide messages' : 'Messages'}{msgs.length ? ` (${msgs.length})` : ''}
      </button>

      {open ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 12, color: '#4B585C', marginBottom: 8 }}>
            Goes to <strong style={{ color: '#141B22' }}>{(state && state.vendorEmail) || 'their team'}</strong>.
            {state && state.routedBack === false
              ? ' Replies will not come back to this order — inbound email is not switched on.'
              : ' Their reply comes back here, with anything they attach.'}
          </div>

          {msgs.length ? (
            <div className="aord-msg-list">
              {msgs.map((m) => (
                <div key={m.id} className="aord-msg" style={{
                  borderLeft: `3px solid ${m.direction === 'inbound' ? '#2F7F86' : '#AE8746'}`,
                  padding: '6px 10px', marginBottom: 6, background: '#F6F3EC', borderRadius: 4,
                }}>
                  <div style={{ fontSize: 11, color: '#4B585C' }}>
                    {m.direction === 'inbound' ? (m.from_email || 'Richer Values') : 'Us'}
                    {' · '}{fmtDate(m.created_at)}
                    {m.attachments && m.attachments.length ? ` · ${m.attachments.length} attached` : ''}
                  </div>
                  <div style={{ color: '#141B22', whiteSpace: 'pre-wrap', marginTop: 2 }}>
                    {m.preview || '(no preview)'}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#4B585C', marginBottom: 8 }}>Nothing sent yet.</div>
          )}

          {state && state.canSend === false ? (
            <Banner tone="warn">Place the order first — their team looks it up by its reference.</Banner>
          ) : (
            <>
              <textarea
                className="input"
                rows={3}
                style={{ width: '100%', fontSize: 16 }}
                placeholder="Ask their team something about this order…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <button className="aord-btn" disabled={busy} onClick={send} style={{ marginTop: 6 }}>
                {busy ? 'Sending…' : 'Send to Richer Values'}
              </button>
            </>
          )}

          {err ? <Banner tone="bad">{err}</Banner> : null}
          {notice ? <Banner tone="good">{notice}</Banner> : null}
        </div>
      ) : null}
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
          <div style={{ marginTop: 12 }}><SectionTitle>What Richer Values found</SectionTitle></div>
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
  // Each vendor names these two facts in its own columns, so the adapter answers
  // for its own rows rather than the card reaching for one vendor's column names
  // on every vendor's order (which is why the AppraisalScope due date and
  // inspection date never once appeared here — those two reads are Class's).
  const dueOn = ad.dueDate ? ad.dueDate(order) : null;
  const inspectOn = ad.inspectionDate ? ad.inspectionDate(order) : null;
  const appraiser = ad.appraiser ? ad.appraiser(order) : null;
  if (dueOn) numberBits.push('due ' + fmtDate(dueOn));
  if (inspectOn) numberBits.push('inspection ' + fmtDate(inspectOn));
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

      <StatusTimeline ms={ms} order={order} inspectOn={inspectOn} asks={order._asks} />

      {/* WHO IS ACTUALLY DOING IT. Renders only once the vendor has told us —
          an absent block reads as "they have not said yet", never as "nobody is
          assigned", which is why there is no placeholder row here. */}
      {appraiser ? <AppraiserLine who={appraiser} /> : null}

      {/* WHAT IS OWED, in the vendor's own numbers, when the vendor tells us. */}
      {ad.balanceLine && ad.balanceLine(order) ? (
        <div style={{ fontSize: 12.5, color: MUTED, margin: '4px 0 6px' }}>{ad.balanceLine(order)}</div>
      ) : null}

      {/* Quiet action row: communicate · pay · cancel */}
      <div className="aord-acts">
        <button className="aord-btn" onClick={() => toggle('messages')} aria-pressed={open === 'messages'}>
          Messages{order._unread ? <span className="n">{order._unread}</span> : null}
        </button>
        <button className="aord-btn" onClick={() => toggle('documents')} aria-pressed={open === 'documents'}>Documents</button>
        <button className="aord-btn" onClick={() => toggle('revision')} aria-pressed={open === 'revision'}>Revision</button>
        {/* ORDER ANOTHER FORM ON THIS ORDER. AppraisalScope's `AddForm` action —
            a 1004D final inspection after the 1004, a 1007 rent schedule — has
            been wired end to end since the integration was written and had no
            button, so it was only reachable by hand-posting the request. NAN
            only: Class has no equivalent action. */}
        {order._vendor === 'nan' ? (
          <button className="aord-btn" onClick={() => toggle('addform')} aria-pressed={open === 'addform'}>Add a form</button>
        ) : null}
        <span className="sep" />
        {/* THE BUTTON SAYS WHAT IT DOES. Payment on these two vendors is MANUAL
            (owner-directed 2026-08-05: the back office charges the card by hand;
            the vendors' own Payment* actions are deliberately unused). This
            control stores the card on the file — it does not charge anything —
            so it must not read "Pay $299" and leave somebody believing the
            appraisal is paid for. "Paid ✓" on a Class order is their OWN
            callback telling us they took payment, which is a different fact and
            still worth showing. */}
        {paid ? (
          <button className="aord-btn paid" onClick={() => onPay(order)}>Paid ✓{card && card.last4 ? ` · ••${card.last4}` : ''}</button>
        ) : (
          <button className="aord-btn pri" onClick={() => onPay(order)}>
            {card && card.last4 ? `Card ••${card.last4}` : 'Add the payment card'}
            {fee != null ? ` · ${money(fee)}` : ''}
          </button>
        )}
        {/* Each vendor cancels through its OWN door — CDG takes free text, Class
            takes a code from their closed list. Never one button for both. */}
        {ad.canCancel(order) ? (
          order._vendor === 'class'
            ? <ClassCancelButton appId={appId} order={order} onChanged={onChanged} />
            : <NanCancelButton orderId={order.id} onChanged={onChanged} />
        ) : null}
        <button className="aord-more" style={{ marginLeft: 'auto' }} onClick={() => setShowDetails((v) => !v)}>
          {showDetails ? 'Hide details' : 'Details'}
        </button>
      </div>

      {showDetails ? <WhatWasOrdered order={order} fee={fee} /> : null}
      {open === 'messages' ? <SubMessages order={order} appId={appId} onChanged={onChanged} /> : null}
      {open === 'documents' ? <SubDocuments order={order} appId={appId} onChanged={onChanged} /> : null}
      {open === 'revision' ? <SubRevision order={order} appId={appId} onChanged={onChanged} /> : null}
      {open === 'addform' ? <NanAddForm appId={appId} order={order} onChanged={onChanged} /> : null}
    </div>
  );
}

/* ---- ADD ANOTHER FORM TO AN ORDER (AppraisalScope `AddForm`) ----------------
 *
 * The whole path has been built since the integration was written — `order-build`
 * carries `requestAction`, `cdg.buildCreateAppraisal` switches the action,
 * `order-service` resolves the parent's own CDG order number and rides it as
 * ?orderId=, and the route accepts `parentOrderId`. Nothing offered it, so the one
 * thing missing was a button, and an appraiser could not be asked for a 1004D
 * final inspection or a 1007 rent schedule without hand-posting the request.
 *
 * IT IS A REAL ORDER, so it says so before it goes: an extra form is charged like
 * any other, and it is placed against THIS order rather than as a new one.
 */
function NanAddForm({ appId, order, onChanged }) {
  const [forms, setForms] = useState([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const p = await api.amcPreview(appId);
        if (alive) setForms((p && p.forms) || []);
      } catch (_) { /* the list simply stays empty, and the copy below says so */ }
    })();
    return () => { alive = false; };
  }, [appId]);

  const send = async () => {
    if (!code) return;
    const name = (forms.find((f) => String(f.id) === code) || {}).name || ('form #' + code);
    if (!(await askConfirm(`Order ${name} on this appraisal?\n\nIt is an extra form on order ${order.sp_order_number || order.id}, and the appraisal company charges for it.`))) return;
    setBusy(true); setErr(''); setNotice('');
    try {
      const out = await api.amcPlaceOrder(appId, {
        place: true, requestAction: 'AddForm', parentOrderId: order.id, productCode: code,
      });
      if (!out.ok) setErr(parseOrderFailure(null, out));
      else {
        setNotice(out.dryrun ? 'Built in test mode — nothing was sent.' : 'The extra form was ordered.');
        setCode('');
        if (onChanged) onChanged();
      }
    } catch (e) { setErr((e && e.message) || 'Could not order the extra form.'); }
    setBusy(false);
  };

  return (
    <div style={surfaceWrap}>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      {notice ? <Banner tone="good">{notice}</Banner> : null}
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
        Adds a form to this order — a final inspection, a rent schedule — rather than starting a new appraisal.
      </div>
      {forms.length ? (
        <select value={code} onChange={(e) => setCode(e.target.value)}
          style={{ ...inputStyle, width: '100%', marginBottom: 8 }}>
          <option value="">Choose a form…</option>
          {forms.map((f) => <option key={f.id} value={String(f.id)}>{f.name ? (f.name + ' (#' + f.id + ')') : ('Form #' + f.id)}</option>)}
        </select>
      ) : (
        <div style={{ fontSize: 13, color: MUTED, marginBottom: 8 }}>
          The form list isn’t loaded yet — it fills in once the appraisal catalog syncs.
        </div>
      )}
      <button className="btn primary" disabled={busy || !code} onClick={send}>
        {busy ? 'Ordering…' : 'Order this form'}
      </button>
    </div>
  );
}

/* The appraiser, in one quiet line: who, where they are from, and how to reach
   them. It is the APPRAISER and never the AMC — both ride in AppraisalScope's one
   `appraisers[]` array under different roles, and telling a loan officer that the
   management company is inspecting their property would be worse than telling
   them nothing (src/amc/detail.js keeps the two apart). Dark text on the white
   card per the standing rule — never an `--ink*` token, which is a LIGHT paper
   colour in this palette. */
function AppraiserLine({ who }) {
  const bits = [];
  if (who.name && who.company) bits.push(`${who.name} · ${who.company}`);
  else if (who.name || who.company) bits.push(who.name || who.company);
  if (who.phone) bits.push(who.phone);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 6, fontSize: 13 }}>
      <span style={{ color: '#4B585C', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em', fontSize: 11 }}>Appraiser</span>
      <span style={{ color: '#141B22' }}>{bits.join(' · ')}</span>
      {who.email ? <a href={`mailto:${who.email}`} style={{ color: '#256168' }}>{who.email}</a> : null}
    </div>
  );
}

function StatusTimeline({ ms, order, inspectOn, asks }) {
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
                {i === 1 && inspectOn ? <><br />{fmtDate(inspectOn)}</> : null}
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
    ? <NanMessages orderId={order.id} onChanged={onChanged} />
    : <ClassMessages appId={appId} order={order} onChanged={onChanged} />;
}
function SubDocuments({ order, appId, onChanged }) {
  return order._vendor === 'nan'
    ? <NanDocuments appId={appId} orderId={order.id} onChanged={onChanged} />
    : <ClassDocuments appId={appId} order={order} onChanged={onChanged} />;
}
function SubRevision({ order, appId, onChanged }) {
  return order._vendor === 'nan'
    ? <NanRevisions appId={appId} orderId={order.id} order={order} />
    : <ClassAsk appId={appId} order={order} onChanged={onChanged} />;
}

const surfaceWrap = { border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginTop: 10, background: '#fff' };

/* ---- NAN messages ---- */
function NanMessages({ orderId, onChanged }) {
  const [rows, setRows] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const r = await api.amcComments(orderId); setRows((r && r.comments) || []); } catch (_) { /* ignore */ }
  }, [orderId]);
  useEffect(() => { load(); }, [load]);
  // The AMC's own messages that nobody has marked read. The "mark read" door has
  // existed on the server since this integration shipped and nothing ever called
  // it, so an inbound message stayed unread for ever.
  const unread = rows.filter((c) => c.direction === 'inbound' && !c.read_at);
  const markRead = async () => {
    setBusy(true); setErr('');
    try {
      for (const c of unread) await api.amcReadComment(orderId, c.id);
      await load();
      if (onChanged) await onChanged();
    } catch (e) { setErr((e && e.message) || 'Could not mark these read.'); }
    setBusy(false);
  };
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
      {unread.length ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
          <button className="btn ghost small" disabled={busy} onClick={markRead}>
            {busy ? '…' : `Mark ${unread.length} read`}
          </button>
        </div>
      ) : null}
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
  // SEND IT AS THE CONTRACT. AppraisalScope has a dedicated `UploadContract` action
  // and nothing here ever used it, so a purchase contract went up as a generic
  // supporting document — filed where the appraiser has to go looking for it rather
  // than in the slot their own system keeps for it.
  const [asContract, setAsContract] = useState(false);
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
      const o = await api.amcUploadDocs(orderId, ids, asContract ? 'UploadContract' : undefined);
      if (!o.ok) setErr(o.message || 'Could not upload.');
      else {
        setNotice('Sent ' + (o.uploaded ? o.uploaded.length : 0) + ' document(s) to the order'
          + (asContract ? ' as the purchase contract.' : '.'));
        setPick({}); setAsContract(false); await load(); if (onChanged) onChanged();
      }
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
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: INK, margin: '0 0 8px' }}>
        <input type="checkbox" checked={asContract} onChange={(e) => setAsContract(e.target.checked)} />
        <span>Send as the purchase contract<span style={{ color: MUTED }}> — files it in their contract slot instead of as a supporting document</span></span>
      </label>
      <button className="btn primary" disabled={busy || !ids.length} onClick={send}>{busy ? 'Sending…' : ('Send ' + (ids.length || '') + ' to the order')}</button>
      <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>The scope of work and contract are sent automatically when they change or arrive.</div>
    </div>
  );
}

/* ---- Class documents: what they sent back, and OUR documents up to them ----
   The mirror of NanDocuments (owner-directed 2026-09-02). Until then this tab was
   read-only AND claimed the scope of work and contract were "sent automatically",
   which was false — nothing could be sent to Class at all. Now the poller sends
   those two on its own and this picker sends anything else. */
function ClassDocuments({ appId, order, onChanged }) {
  const back = (order._attachments || []).filter((a) => a.direction !== 'outbound');
  const sent = (order._attachments || []).filter((a) => a.direction === 'outbound');
  const [rows, setRows] = useState([]);
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [asContract, setAsContract] = useState(false);
  const numbered = !!order.class_order_id;
  const load = useCallback(async () => {
    try { const r = await api.classDocuments(appId, order.id); setRows((r && r.documents) || []); } catch (_) { /* ignore */ }
  }, [appId, order.id]);
  useEffect(() => { load(); }, [load]);
  const toggle = (id) => setPick((p) => ({ ...p, [id]: !p[id] }));
  const ids = Object.keys(pick).filter((k) => pick[k]);
  const send = async () => {
    if (!ids.length) return;
    setBusy(true); setErr(''); setNotice('');
    try {
      const o = await api.classUploadDocs(appId, order.id, ids, asContract ? 'SalesContract' : undefined);
      if (!o.ok) setErr(o.message || 'Could not send.');
      else {
        const n = o.uploaded ? o.uploaded.length : 0;
        const skipped = (o.skipped || []).length;
        setNotice(`Sent ${n} document(s) to Class${asContract ? ' as the sales contract' : ''}.`
          + (skipped ? ` ${skipped} could not go (${(o.skipped || []).map((s) => s.reason.replace(/_/g, ' ')).join(', ')}).` : '')
          + (o.uploaded && o.uploaded.some((u) => u.dryrun) ? ' Test mode — nothing left the building.' : ''));
        setPick({}); setAsContract(false); await load(); if (onChanged) onChanged();
      }
    } catch (e) { setErr(e.message || 'Could not send.'); }
    setBusy(false);
  };
  return (
    <div style={surfaceWrap}>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      {notice ? <Banner tone="good">{notice}</Banner> : null}

      <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Documents Class has sent back on this order.</div>
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
        {back.length ? back.map((a, i) => (
          <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderTop: i ? `1px solid ${LINE}` : 'none' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: INK, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || 'Document'}</div>
              <div style={{ fontSize: 12, color: MUTED }}>{a.content_type || 'file'}{a.fetched_at ? ' · filed on the file' : (a.announced_at ? ' · announced' : '')}</div>
            </div>
          </div>
        )) : <div style={{ padding: 10, color: MUTED, fontSize: 13 }}>Class hasn’t sent any documents back on this order yet.</div>}
      </div>

      <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
        Send the file&apos;s documents to Class.{numbered ? '' : ' Class has not numbered this order yet — nothing can be attached until it has.'}
      </div>
      <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden', marginBottom: 8 }}>
        {rows.length ? rows.map((d) => {
          const off = d.alreadyUploaded || !d.sendable || !numbered;
          return (
            <label key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderTop: `1px solid ${LINE}`, cursor: off ? 'default' : 'pointer', opacity: off ? 0.6 : 1 }}>
              <input type="checkbox" disabled={off} checked={!!pick[d.id]} onChange={() => toggle(d.id)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: INK, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</div>
                <div style={{ fontSize: 12, color: MUTED }}>
                  {d.category}{d.alreadyUploaded ? ' · already sent' : (!d.sendable ? ' · Class takes PDF, XML and image files only' : ` · goes as ${d.classCategory}`)}
                </div>
              </div>
            </label>
          );
        }) : <div style={{ padding: 10, color: MUTED, fontSize: 13 }}>No documents on this file yet.</div>}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: INK, margin: '0 0 8px' }}>
        <input type="checkbox" checked={asContract} onChange={(e) => setAsContract(e.target.checked)} />
        <span>Send as the sales contract<span style={{ color: MUTED }}> — files it in their contract slot instead of as a supporting document</span></span>
      </label>
      <button className="btn primary" disabled={busy || !ids.length || !numbered} onClick={send}>{busy ? 'Sending…' : ('Send ' + (ids.length || '') + ' to Class')}</button>
      <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>The scope of work and the purchase contract are sent on their own when they arrive or change.</div>

      {sent.length ? (
        <>
          <div style={{ fontSize: 12, color: MUTED, margin: '14px 0 6px' }}>Already sent to Class on this order.</div>
          <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
            {sent.map((a, i) => (
              <div key={a.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 10px', borderTop: i ? `1px solid ${LINE}` : 'none' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: INK, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name || 'Document'}</div>
                  <div style={{ fontSize: 12, color: a.upload_error ? '#8A2F27' : MUTED }}>
                    {a.category || 'Miscellaneous'}
                    {a.upload_error ? ` · could not be sent: ${a.upload_error}` : (a.uploaded_at ? ` · sent ${fmtDate(a.uploaded_at)}` : ' · test mode, not sent')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
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
/**
 * CANCELLING A CLASS ORDER — the reason picker the old panel never had.
 *
 * The whole back end has existed since the Class integration shipped
 * (`POST /files/:id/orders/:o/cancel` → `messages.requestCancel`, validating the
 * chosen codes against Class's OWN closed reason list), and the screen had no way
 * to reach it — the adapter's `canCancel` returned a hard `false` with a note
 * saying a reason picker was missing. So a Class order could be placed and never
 * called off from PILOT.
 *
 * Class refuses a free-typed reason, which is why this is a picker and not a text
 * box: the codes come from `classReasons('cancel')` — their list, read live, never
 * a copy typed here that could drift out of their vocabulary. The note is the
 * human sentence that rides along with it.
 *
 * Asking is not agreeing: the order is NOT marked cancelled here. It moves when
 * Class's own StatusChanged callback says Cancelled — the same rule the NAN side
 * follows while it waits for CDG's 1051.
 */
function ClassCancelButton({ appId, order, onChanged }) {
  const [open, setOpen] = useState(false);
  const [reasons, setReasons] = useState(null);
  const [picked, setPicked] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!open || reasons) return;
    let alive = true;
    (async () => {
      try { const r = await api.classReasons('cancel'); if (alive) setReasons(r); }
      catch (_) { if (alive) setReasons({ common: [], all: [] }); }
    })();
    return () => { alive = false; };
  }, [open, reasons]);

  const list = (reasons && (reasons.common && reasons.common.length ? reasons.common : reasons.all)) || [];
  const codeOf = (r) => (typeof r === 'string' ? r : (r.code || r.reasonType || ''));
  const labelOf = (r) => (typeof r === 'string' ? r : (r.label || r.name || r.code || r.reasonType || ''));

  const submit = async () => {
    if (!picked) { setErr('Pick a reason — Class only accepts one from their own list.'); return; }
    const ok = await askConfirm('Ask Class to cancel this appraisal order?', {
      title: 'Cancel appraisal order', confirmLabel: 'Cancel the order', cancelLabel: 'Keep it',
    });
    if (!ok) return;
    setBusy(true); setErr('');
    try {
      const out = await api.classCancelOrder(appId, order.id, {
        confirm: true, reasons: [{ reasonType: picked }], note: note.trim() || undefined,
      });
      if (out && out.ok) { setOpen(false); setPicked(''); setNote(''); if (onChanged) await onChanged(); }
      else setErr(parseOrderFailure(null, out));
    } catch (e) { setErr(parseOrderFailure(e, null)); }
    setBusy(false);
  };

  if (!open) return <button className="aord-btn danger" onClick={() => setOpen(true)}>Cancel order</button>;
  return (
    <div style={{ flexBasis: '100%', marginTop: 8, border: `1px solid ${LINE}`, borderRadius: 10, padding: 10, background: '#fff' }}>
      {err ? <Banner tone="bad">{err}</Banner> : null}
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 6 }}>
        Class only takes a reason from their own list. Pick the closest one; the note goes with it.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={picked} onChange={(e) => { setPicked(e.target.value); setErr(''); }}
          style={{ minWidth: 240, border: `1px solid ${LINE}`, borderRadius: 8, padding: '7px 8px', color: INK, background: '#fff', fontSize: 14 }}>
          <option value="">{reasons ? 'Choose a reason…' : 'Loading Class’s reasons…'}</option>
          {list.map((r) => <option key={codeOf(r)} value={codeOf(r)}>{labelOf(r)}</option>)}
        </select>
        <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Note (optional)"
          value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn small" disabled={busy || !picked} onClick={submit}>{busy ? 'Cancelling…' : 'Send cancellation'}</button>
        <button className="btn ghost small" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Keep it</button>
      </div>
    </div>
  );
}

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

function DrawerRow({ order, kind, appId, onChanged }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [delErr, setDelErr] = useState('');
  const ad = ADAPTERS[order._vendor];
  const prop = (order.summary || []).find((s) => s.label === 'Property');
  const reason = order.last_error || order.status_reason || null;
  /* Delete a draft / failed attempt (owner-directed 2026-08-18: "they're just
     sitting around like crazy"). Only offered on draft/failed rows — a CLOSED
     (cancelled/rejected) order is a vendor-side fact and stays. The server
     re-judges through lib/appraisal/order-delete (placed / paid / filed-document
     attempts refuse there whatever the screen shows). */
  const canDelete = (kind === 'failed' || kind === 'draft') && !!onChanged;
  const doDelete = async () => {
    const sure = await askConfirm(kind === 'draft'
      ? 'Delete this draft order? It was never sent to the vendor — nothing is cancelled, the draft just goes away.'
      : 'Delete this failed attempt? It never went through at the vendor — the record of the failure is kept in the audit trail.');
    if (!sure) return;
    setBusy(true); setDelErr('');
    try {
      if (order._vendor === 'amc') await api.amcDeleteOrder(order.id);
      else if (order._vendor === 'class') await api.classDeleteOrder(appId, order.id);
      else if (order._vendor === 'rv') await api.rvDeleteOrder(order.id);
      await onChanged();
    } catch (e) { setDelErr((e && e.message) || 'Could not delete this attempt.'); }
    setBusy(false);
  };
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
          {canDelete ? (
            <div style={{ marginTop: 10 }}>
              {delErr ? <div style={{ fontSize: 12.5, color: BAD, marginBottom: 6 }}>{delErr}</div> : null}
              <button className="btn ghost small" disabled={busy} onClick={doDelete} style={{ color: '#8A322B' }}>
                {busy ? 'Deleting…' : (kind === 'draft' ? 'Delete this draft' : 'Delete this failed attempt')}
              </button>
            </div>
          ) : null}
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

/* ============================================================= pay panel === */
/* THE THREE WAYS TO PAY FOR AN APPRAISAL.
 *
 * Owner-directed 2026-08-16: *"We're gonna keep it manual. We're gonna have all
 * the options over there … send the payment link … use the card on file … use the
 * card manually. We should keep all the options open."*
 *
 * NOTHING IS RESTATED HERE. Which options exist, what each one does at this
 * particular appraisal company, and which of them are pressable right now all come
 * from the server (`GET …/appraisal-payment` → `lib/appraisal/payment-options.js`).
 * A capability table copied into a screen is how a button ends up promising to
 * charge something the back end cannot charge.
 *
 * TWO DESTINATIONS, ON PURPOSE. Richer Values genuinely takes the payment, so its
 * own proven route does it (`api.rvPay` — reveal, add, charge, remove). The other
 * two companies have no payment API we have verified, so the choice is RECORDED
 * for the back office. The screen tells you plainly which of those two just
 * happened rather than showing one confident "Paid" for both.
 */
function PayModal({ appId, order, card, onClose, onPaid }) {
  const ad = ADAPTERS[order._vendor];
  const fee = ad.orderFee(order);
  const paid = ad.orderPaid(order);
  const prop = (order.summary || []).find((s) => s.label === 'Property');

  const [state, setState] = useState(null);       // null = still loading
  const [pick, setPick] = useState(null);
  const [f, setF] = useState({ number: '', expMonth: '', expYear: '', cvc: '', zip: '' });
  const [linkTo, setLinkTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const load = useCallback(async () => {
    try {
      const s = await api.staffAppraisalPayment(appId);
      setState(s);
      return s;
    } catch (e) { setErr((e && e.message) || 'Could not read the payment options.'); return null; }
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  // Prefill the card fields from the file so "Enter a card now" starts from
  // whatever is already there — the same prefill this modal has always done.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await api.staffAppraisalCard(appId);
        if (alive && c && c.number) {
          setF({
            number: c.number, expMonth: c.expMonth != null ? String(c.expMonth) : '',
            expYear: c.expYear != null ? String(c.expYear) : '', cvc: c.cvc || '', zip: c.zip || '',
          });
        }
      } catch (_) { /* no card on file — the option says so on its own */ }
    })();
    return () => { alive = false; };
  }, [appId]);

  // WHAT THE VENDOR ITSELF SAYS ABOUT THIS ORDER'S PAYMENT — asked only of the
  // company that can answer. AppraisalScope's own charge needs the card's security
  // code, so a card saved without one cannot be charged, and that is a fact about
  // THIS file that the shared options list has no way to know. Read here so the
  // button is refused on the screen with a reason, rather than pressed and declined
  // at the vendor for something nobody in this building can see.
  const [vendorPay, setVendorPay] = useState(null);
  useEffect(() => {
    let alive = true;
    if (order._vendor !== 'nan') { setVendorPay(null); return undefined; }
    (async () => {
      try { const s = await api.amcPayment(order.id); if (alive) setVendorPay(s); }
      catch (_) { /* the shared options still render — this only ever ADDS a reason */ }
    })();
    return () => { alive = false; };
  }, [order._vendor, order.id]);

  // CLASS'S OWN MONEY PICTURE — the live fee / paid / owed off their payment-details,
  // and the one write their API allows: RECORDING a card charge the back office ran
  // on the card on file, so Class marks the order paid and stops chasing the
  // borrower. Nothing here charges a card; src/class/payment.js says why.
  const [classPay, setClassPay] = useState(null);
  const [rec, setRec] = useState({ nameCardHolder: '', amount: '', last4: '', authorizationCode: '' });
  const [recOpen, setRecOpen] = useState(false);
  const loadClassPay = useCallback(async () => {
    if (order._vendor !== 'class' || !order.class_order_id) { setClassPay(null); return; }
    try { setClassPay(await api.classPayment(appId, order.id)); } catch (_) { /* the balance line is a bonus, never a blocker */ }
  }, [appId, order._vendor, order.id, order.class_order_id]);
  useEffect(() => { loadClassPay(); }, [loadClassPay]);
  const recordCharge = async () => {
    setBusy('record'); setErr(''); setDone('');
    try {
      const r = await api.classRecordPayment(appId, order.id, {
        nameCardHolder: rec.nameCardHolder, amount: rec.amount, last4: rec.last4 || (card && card.last4) || '', authorizationCode: rec.authorizationCode,
      });
      if (!r || r.ok === false) setErr((r && r.message) || 'Class did not accept the record.');
      else {
        setDone(r.dryrun ? 'Test mode — the record was built and logged, nothing was sent to Class.'
          : `Recorded at Class.${r.balance ? ' ' + r.balance : ''}`);
        setRecOpen(false);
        await loadClassPay(); await load(); await onPaid();
      }
    } catch (e) { setErr((e && e.message) || 'Could not record the charge at Class.'); }
    setBusy('');
  };

  const vendorBlock = state && state.vendors ? state.vendors[order._vendor] : null;
  const rawOpts = (vendorBlock && vendorBlock.options) || [];
  // The overlay can only ever DISABLE, never enable — a screen must not open a
  // button the shared table says is shut.
  const opts = rawOpts.map((o) => {
    if (o.method !== 'CARD_ON_FILE' || !vendorPay || !vendorPay.ok) return o;
    if (vendorPay.cardChargeable !== false || !vendorPay.cardReason) return o;
    return { ...o, disabled: o.disabled || vendorPay.cardReason, available: false };
  });
  const intent = state && state.intents ? state.intents[`${order._vendor}:${order.id}`] : null;
  const chosen = opts.find((o) => o.method === pick) || null;

  const submit = async () => {
    if (!chosen || !chosen.available) return;
    setBusy('pay'); setErr(''); setDone('');
    try {
      if (chosen.does === 'vendor') {
        // THE COMPANY TAKES THE MONEY, and WHICH company decides which route is
        // called — so it is asked of the adapter rather than hard-coded here. This
        // branch called Richer Values by name until 2026-08-16, when AppraisalScope
        // gained real payment requests; a second `if` on the vendor key would have
        // been the start of a per-vendor ladder in a component, which is exactly
        // where "who charges what" goes to drift.
        //
        // Every adapter answers the same three things, because a payment has three
        // distinct outcomes and collapsing them lies to somebody: did the press
        // work, did the MONEY actually move, and what to tell the person. A sent
        // payment link is a success that is NOT a payment.
        if (typeof ad.pay !== 'function') {
          setErr(`${ad.name} takes its own payments, but this screen has no way to ask it to.`);
        } else {
          const r = await ad.pay(order, {
            method: chosen.method,
            card: chosen.method === 'NEW_CARD' ? f : null,
            linkTo: linkTo.trim() || null,
          });
          if (!r || r.ok === false) setErr((r && r.note) || `${ad.name} did not take the payment.`);
          else setDone(r.note);
        }
      } else {
        const r = await api.staffChooseAppraisalPayment(appId, {
          vendor: order._vendor, orderId: order.id, method: chosen.method,
          card: chosen.method === 'NEW_CARD' ? f : undefined,
          note: note.trim() || undefined,
        });
        setDone(chosen.method === 'NEW_CARD'
          ? 'Card saved on the file, and recorded as the one to charge. Nothing has been charged yet.'
          : 'Recorded. Nothing has been charged yet — the back office settles it from here.');
        if (r && r.intent) setState((s) => (s ? { ...s, intents: { ...s.intents, [`${order._vendor}:${order.id}`]: r.intent } } : s));
      }
      await load();
      await onPaid();
    } catch (e) { setErr((e && e.message) || 'Could not record how this is being paid.'); }
    setBusy('');
  };

  const markPaid = async (undo) => {
    setBusy(undo ? 'undo' : 'settle'); setErr(''); setDone('');
    try {
      await api.staffSettleAppraisalPayment(appId, { vendor: order._vendor, orderId: order.id, undo: undo || undefined });
      setDone(undo ? 'Put back — it reads as still to be paid.' : 'Marked as paid.');
      await load();
      await onPaid();
    } catch (e) { setErr((e && e.message) || 'Could not update it.'); }
    setBusy('');
  };

  return (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ padding: 20, color: INK, maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17, color: INK }}>How is this appraisal being paid for?</div>
        <div style={{ fontSize: 13, color: MUTED, marginTop: 4 }}>
          {ad.name}{ad.orderTitle(order) ? ` · ${ad.orderTitle(order)}` : ''}{prop ? ` · ${prop.value}` : ''}
        </div>
        <div style={{ fontSize: 14, color: INK, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
          {paid
            ? <span style={{ color: GOOD, fontWeight: 600 }}>Paid ✓{card && card.last4 ? ` · ••${card.last4}` : ''}</span>
            : fee != null ? <>Fee: <strong>{money(fee)}</strong></> : 'The fee is confirmed by the appraisal company.'}
        </div>

        {/* THE VENDOR'S OWN ANSWER, FIRST, on a company that really charges.
            Three states worth interrupting for, and the middle one is the reason
            this block exists: a charge whose outcome we could not read leaves the
            order deliberately locked, and somebody has to be TOLD that rather than
            finding a button that quietly does nothing. */}
        {vendorPay && vendorPay.ok && (vendorPay.paid || vendorPay.charging) ? (
          <div style={{ marginTop: 12, borderRadius: 10, padding: '10px 12px',
            border: `1px solid ${vendorPay.paid ? '#CFE6D8' : WARN_LINE}`,
            background: vendorPay.paid ? '#EEF7F1' : WARN_BG }}>
            <div style={{ fontWeight: 650, color: vendorPay.paid ? '#1E5E3C' : WARN }}>
              {vendorPay.paid
                ? `Paid — ${ad.name}'s receipt is ${vendorPay.transactionId}`
                : 'A payment on this order is going through'}
            </div>
            {!vendorPay.paid ? (
              <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3, lineHeight: 1.45 }}>
                {vendorPay.lastError
                  || 'Give it a moment and reload. Nothing else can be charged on this order until it settles.'}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* CLASS: what they say is owed, and the record-a-charge form. */}
        {classPay && classPay.ok ? (
          <div style={{ marginTop: 12, borderRadius: 10, padding: '10px 12px', border: `1px solid ${classPay.outstandingCents != null && Number(classPay.outstandingCents) <= 0 && Number(classPay.totalCents || 0) > 0 ? '#CFE6D8' : LINE}`, background: '#fff' }}>
            <div style={{ fontWeight: 650, color: INK }}>{classPay.balance || 'Class has not priced this order yet.'}</div>
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3, lineHeight: 1.45 }}>
              {classPay.paymentMethod === 'PaymentLink'
                ? `Ordered with a payment link${classPay.recipientEmail ? ' to ' + classPay.recipientEmail : ''}${classPay.linkSentAt ? ', sent ' + fmtDate(classPay.linkSentAt) : ', not sent yet'}.`
                : (classPay.paymentMethod === 'Invoice' ? 'Ordered as an invoice to YS Capital.' : (classPay.paymentMethod ? `Ordered as ${classPay.paymentMethod}.` : ''))}
              {classPay.recordedAt ? ` A card charge was recorded at Class on ${fmtDate(classPay.recordedAt)}.` : ''}
              {' '}{classPay.note}
            </div>
            {!(classPay.outstandingCents != null && Number(classPay.outstandingCents) <= 0 && Number(classPay.totalCents || 0) > 0) ? (
              recOpen ? (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <input placeholder="Name on the card" style={inputStyle} value={rec.nameCardHolder} onChange={(e) => setRec((p) => ({ ...p, nameCardHolder: e.target.value }))} />
                  <input placeholder="Amount charged ($)" style={inputStyle} value={rec.amount} onChange={(e) => setRec((p) => ({ ...p, amount: e.target.value }))} />
                  <input placeholder={card && card.last4 ? `Last four (••${card.last4})` : 'Last four digits'} style={inputStyle} value={rec.last4} onChange={(e) => setRec((p) => ({ ...p, last4: e.target.value }))} />
                  <input placeholder="Authorization code" style={inputStyle} value={rec.authorizationCode} onChange={(e) => setRec((p) => ({ ...p, authorizationCode: e.target.value }))} />
                  <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
                    <button className="btn primary" disabled={!!busy || !rec.amount} onClick={recordCharge}>{busy === 'record' ? 'Recording…' : 'Tell Class it was charged'}</button>
                    <button className="btn soft" disabled={!!busy} onClick={() => setRecOpen(false)}>Cancel</button>
                  </div>
                  <div style={{ gridColumn: '1 / -1', fontSize: 12, color: MUTED }}>Only for a charge the back office already ran on the card. This records it at Class — it does not charge anything.</div>
                </div>
              ) : (
                <button className="btn soft" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => setRecOpen(true)}>
                  The back office charged the card — record it at Class
                </button>
              )
            ) : null}
          </div>
        ) : null}

        {/* WHAT WAS ALREADY DECIDED. Shown before the options, because the first
            question on reopening this is "did somebody already deal with it?" */}
        {intent && intent.describe ? (
          <div style={{ marginTop: 12, border: `1px solid ${intent.describe.settled ? '#CFE6D8' : WARN_LINE}`,
            background: intent.describe.settled ? '#EEF7F1' : WARN_BG, borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontWeight: 650, color: intent.describe.settled ? '#1E5E3C' : WARN }}>
              {intent.describe.head}
            </div>
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3 }}>
              {intent.chosen_by_name ? `Chosen by ${intent.chosen_by_name}` : 'Chosen'}
              {intent.chosen_at ? ` · ${new Date(intent.chosen_at).toLocaleDateString()}` : ''}
              {intent.settled_by_name ? ` · marked paid by ${intent.settled_by_name}` : ''}
            </div>
            {intent.describe.awaitingBackOffice ? (
              <button className="btn soft" style={{ marginTop: 8 }} disabled={!!busy}
                onClick={() => markPaid(false)}>
                {busy === 'settle' ? 'Saving…' : 'Mark it paid'}
              </button>
            ) : null}
            {intent.describe.settled ? (
              <button className="aord-more" style={{ marginTop: 8 }} disabled={!!busy}
                onClick={() => markPaid(true)}>
                {busy === 'undo' ? 'Saving…' : 'Not actually paid — put it back'}
              </button>
            ) : null}
          </div>
        ) : null}

        {err ? <div style={{ marginTop: 10 }}><OrderFailure info={err} vendor={ad.name} action="record the payment" /></div> : null}
        {done ? <div style={{ marginTop: 10 }}><Banner tone="good">{done}</Banner></div> : null}

        {state === null ? (
          <div style={{ marginTop: 14, color: MUTED, fontSize: 13 }}>Reading the options…</div>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
            {opts.map((o) => {
              const on = pick === o.method;
              return (
                <div key={o.method}>
                  <button
                    onClick={() => o.available && setPick(on ? null : o.method)}
                    aria-pressed={on}
                    disabled={!o.available}
                    style={{
                      width: '100%', textAlign: 'left', cursor: o.available ? 'pointer' : 'not-allowed',
                      border: `1px solid ${on ? TEAL : LINE}`, borderRadius: 10, padding: '10px 12px',
                      background: on ? '#F2F8F8' : '#fff', opacity: o.available ? 1 : 0.62,
                    }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 650, color: INK }}>{o.label}</span>
                      {/* WHO PERFORMS IT, never blurred: pressing a Richer Values
                          option does it; the others are written down for a person. */}
                      <span style={{
                        fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.04em',
                        border: `1px solid ${LINE}`, borderRadius: 999, padding: '1px 7px', color: MUTED,
                      }}>{o.does === 'vendor' ? 'Done here' : 'By hand'}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: MUTED, marginTop: 3, lineHeight: 1.45 }}>{o.says}</div>
                    {o.disabled ? (
                      <div style={{ fontSize: 12.5, color: WARN, marginTop: 4 }}>{o.disabled}</div>
                    ) : null}
                  </button>

                  {on && o.caveat ? (
                    <div style={{ fontSize: 12.5, color: WARN, background: WARN_BG, border: `1px solid ${WARN_LINE}`,
                      borderRadius: 8, padding: '8px 10px', marginTop: 6, lineHeight: 1.45 }}>{o.caveat}</div>
                  ) : null}

                  {on && o.method === 'NEW_CARD' ? (
                    <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                      <input className="input" inputMode="numeric" placeholder="Card number" value={f.number} onChange={set('number')} />
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <input className="input" style={{ maxWidth: 70 }} inputMode="numeric" placeholder="MM" value={f.expMonth} onChange={set('expMonth')} />
                        <input className="input" style={{ maxWidth: 90 }} inputMode="numeric" placeholder="YYYY" value={f.expYear} onChange={set('expYear')} />
                        <input className="input" style={{ maxWidth: 80 }} inputMode="numeric" placeholder="CVC" value={f.cvc} onChange={set('cvc')} />
                        <input className="input" style={{ maxWidth: 110 }} inputMode="numeric" placeholder="ZIP" value={f.zip} onChange={set('zip')} />
                      </div>
                    </div>
                  ) : null}

                  {on && o.method === 'PAYMENT_LINK' && o.does === 'vendor' ? (
                    <input className="input" style={{ marginTop: 8 }} type="email"
                      placeholder="Send it to (leave blank for the borrower on file)"
                      value={linkTo} onChange={(e) => setLinkTo(e.target.value)} />
                  ) : null}

                  {on && o.does !== 'vendor' ? (
                    <input className="input" style={{ marginTop: 8 }}
                      placeholder="Anything the back office should know (optional)"
                      value={note} onChange={(e) => setNote(e.target.value)} />
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
          <button className="btn ghost" disabled={!!busy} onClick={onClose}>Close</button>
          <button className="btn primary" disabled={!!busy || !chosen || !chosen.available} onClick={submit}>
            {busy === 'pay' ? 'Saving…'
              : chosen && chosen.does === 'vendor' ? 'Do it now'
                : 'Record it'}
          </button>
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
