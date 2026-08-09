import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
// A due date is a calendar 'YYYY-MM-DD' STRING end-to-end — rendered through the
// shared formatter, never `new Date('2026-08-07')`, which parses as UTC midnight
// and prints the day BEFORE for anybody west of Greenwich.
import { fmtDay } from '../lib/dates.js';
// Why an order's clock is stopped, worded in ONE place and shared with the file's
// own order card — the decision itself is the server's (order-sla.orderState).
import { dormantMarker } from '../lib/orderDormant.js';
import { askConfirm } from '../lib/dialog.js';

/* ════════════════════════════════════════════════════════════════════════════
   ORDERS QUEUE — every title, insurance & attorney closing-prep order across the
   files the viewer can see, WORST FIRST.

   This is the screen that answers the three questions the Orders desk exists for
   and could not answer before: which orders are late, who is chasing each one,
   and what is waiting on us. The lateness, the due date and the owner are all
   computed on the SERVER (order-sla.orderState) and handed down whole — the same
   figures the file's own card and the aging nudge use, so this queue can never
   call an order late that the file screen calls on time.

   THE THREE ORDER KINDS ARE LISTED ONCE, HERE. `GET /orders` returns one
   sub-object per kind (title / insurance / attorney) and this screen is the only
   consumer — so a fourth kind is one entry in KINDS, never a fourth hand-written
   column plus three filter predicates that each have to remember it. The attorney
   order shipped server-side (and tested) while this screen still rendered two
   columns, which is exactly the drift a list prevents.
   ════════════════════════════════════════════════════════════════════════════ */

const KINDS = [
  { key: 'title', label: 'Title order', section: 'sec-order-title' },
  { key: 'insurance', label: 'Insurance order', section: 'sec-order-insurance' },
  { key: 'attorney', label: 'Attorney closing prep', section: 'sec-order-closing' },
];
const orderOf = (f) => KINDS.map(k => f[k.key]).filter(Boolean);

const STATUS_LABEL = {
  not_ordered: 'Not ordered', ordered: 'Ordered', documents_in: 'Documents in',
  completed: 'Completed', cancelled: 'Cancelled',
};
function addrLine(pa) {
  pa = pa || {};
  if (pa.oneLine) return pa.oneLine;
  const street = pa.street || pa.line1 || '';
  const tail = [pa.city, [pa.state, pa.zip || pa.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, tail].filter(Boolean).join(', ') || '—';
}

function OrderCell({ o, appId, kind, onChased, fileStatus }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!o) return <span className="muted small">—</span>;

  /* WHY THIS ORDER IS NOT BEING CHASED — READ OFF THE SERVER'S OWN ANSWER.
     `o.dormant` / `o.dormantReason` come from `order-sla.orderState`, which is the
     one place that decides whether an order's clock is running. Re-deriving it here
     from the file status was a second copy of the rule inside the very module whose
     stated purpose is that a second copy cannot exist: add a status to
     DORMANT_FILE_STATUSES and the server would stop the clock while this desk went
     on offering "Chase now", firing a follow-up at a vendor on a dead deal. */
  const dormantLabel = dormantMarker(o);
  const onHold = !!dormantLabel;
  const tone = o.overdue ? { color: '#B3261E', borderColor: '#B3261E' }
    : o.status === 'completed' ? { color: 'var(--ok)', borderColor: 'var(--ok)' }
    : (o.status === 'documents_in' || o.status === 'ordered') ? { color: 'var(--teal,#2F7F86)', borderColor: 'var(--teal,#2F7F86)' }
    : { color: 'var(--gold)', borderColor: 'var(--gold)' };

  /* ONE-CLICK CHASE. The whole reason somebody opens this queue is to do something
     about a late order, and the only thing they could do before was open the file
     and find their way back to it. The attorney order has its own door (its
     recipients and package share nothing with a vendor order), so it links across
     instead of pretending one button fits both. */
  /* IT SAYS WHO IT REACHES BEFORE IT SENDS. This fired straight into
     `staffOrderFollowup` with no preview and no confirmation, from a queue row —
     and an insurance follow-up CC's the BORROWER by default (owner-directed: they
     usually chose the agent). So one click from a cross-file list sent a full
     re-statement of the order — property, loan number, transaction type — to the
     borrower, on a screen that never named them. The file's own order card has
     always shown its CC list; this is that same disclosure, asked for at the
     moment of sending. The recipients come from the server's own preview, so this
     screen can never describe a different audience from the one that receives it. */
  const chase = async () => {
    setBusy(true); setMsg('');
    try {
      let to = [];
      try {
        const d = await api.staffOrders(appId);
        const rec = d && d.orders && d.orders[kind] && d.orders[kind].recipients;
        to = rec ? [...(rec.to || []), ...(rec.cc || [])] : [];
      } catch (_) { to = []; }
      const who = to.length
        ? `This follow-up goes to:\n\n${to.join('\n')}\n\nSend it?`
        : 'Send the follow-up on this order?\n\n(The recipient list could not be loaded — open the file to see it.)';
      if (!(await askConfirm(who))) { setBusy(false); return; }
      const r = await api.staffOrderFollowup(appId, kind, {});
      setMsg(r.unconfirmed ? 'Sent — but unconfirmed, check the thread' : 'Chased');
      onChased && onChased();
    } catch (e) { setMsg((e && e.message) || 'Could not send'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span className="pill" style={tone}>
        {o.overdue ? `${o.daysLate} day${o.daysLate === 1 ? '' : 's'} late` : (STATUS_LABEL[o.status] || o.status)}
      </span>
      <span className="muted small">
        {o.vendorName ? `${o.vendorName} · ` : ''}
        {o.daysOut != null ? `out ${o.daysOut}d` : 'not sent'}
        {o.dueOn ? ` · due ${fmtDay(o.dueOn)}` : ''}
        {o.followupCount > 0 ? ` · ${o.followupCount} chase${o.followupCount === 1 ? '' : 's'}` : ''}
      </span>
      {/* WHOSE MOVE IT IS. A vendor that has already replied must never be shown as
          owing us something — that is how a queue teaches people to ignore it. */}
      {o.pendingOn === 'us' && <span className="small" style={{ color: '#8A5A00', fontWeight: 600 }}>waiting on us</span>}
      <span className="muted small">{o.assignedName ? `${o.assignedName} has it` : 'nobody assigned'}</span>
      {o.unassignedDocs > 0 && <span className="pill" style={{ color: 'var(--gold)', borderColor: 'var(--gold)' }}>{o.unassignedDocs} to assign</span>}
      {o.unassignedDocs === 0 && o.returnedDocs > 0 && <span className="muted small">{o.returnedDocs} doc{o.returnedDocs === 1 ? '' : 's'} back</span>}
      {o.notes && <span className="small" style={{ color: '#4B585C', fontStyle: 'italic' }}>“{String(o.notes).slice(0, 80)}”</span>}
      {/* A HELD FILE IS SHOWN BUT NOT CHASED. The desk lists it so its returned
          documents still appear in "Needs classifying" and so an order placed on a
          held file does not vanish the moment it is sent — but the overdue sweep
          deliberately will not chase a paused file, and a one-click Chase here
          would have the desk doing what the system has decided not to do. */}
      {dormantLabel && <span className="small" style={{ color: '#8A5A00', fontWeight: 600 }}>{dormantLabel}</span>}
      {!onHold && o.status === 'ordered' && o.pendingOn === 'vendor' && (
        kind === 'attorney'
          ? <Link className="btn ghost small" to={`/internal/app/${appId}#sec-order-closing`}>Chase on the chain</Link>
          : <button className="btn ghost small" disabled={busy} onClick={chase} style={{ alignSelf: 'flex-start' }}>
              {busy ? 'Sending…' : 'Chase now'}
            </button>
      )}
      {msg && <span className="muted small">{msg}</span>}
    </div>
  );
}

export default function StaffOrders() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('all');
  const [mine, setMine] = useState('');   // '' = anyone, or a staff id
  const [me, setMe] = useState(null);

  const [capped, setCapped] = useState(null);
  const load = useCallback(() => {
    // Tolerant of BOTH shapes: the desk now answers {files, capped, cap} so a
    // truncated read can say so, and a bare array is still accepted so an older
    // cached bundle talking to a newer server does not render an empty queue.
    api.staffAllOrders().then((r) => {
      const list = Array.isArray(r) ? r : (r && Array.isArray(r.files) ? r.files : []);
      setRows(list);
      setCapped(!Array.isArray(r) && r && r.capped ? (r.cap || list.length) : null);
    }).catch(e => setErr((e && e.message) || 'Could not load orders.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.me().then(setMe).catch(() => setMe(null)); }, []);

  // Everyone who currently has an order, built from the rows themselves so the
  // picker can only ever offer somebody who really is on this queue.
  /* AN ORDER OWNED BY SOMEBODY WHO HAS LEFT IS AN UNOWNED ORDER — everywhere on
     this screen, not just in the cell text. The server joins the assignee with
     `AND su.is_active = true`, so a departed staffer leaves the id set and the
     name NULL. Keying off the id meant the picker listed those people under the
     literal label "Someone", and "Chased by → Nobody yet" EXCLUDED exactly the
     orders it exists to surface, while the same row's text read "nobody
     assigned". One definition, used by the picker and both filters. */
  const ownerOf = (o) => (o.assignedName ? o.assignedTo : null);

  const owners = useMemo(() => {
    const seen = new Map();
    for (const f of rows || []) {
      for (const o of orderOf(f)) { const id = ownerOf(o); if (id && !seen.has(id)) seen.set(id, o.assignedName); }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows || [];
    if (mine === '__none') list = list.filter(f => orderOf(f).some(o => !ownerOf(o) && o.open));
    else if (mine) list = list.filter(f => orderOf(f).some(o => ownerOf(o) === mine));
    if (filter === 'late') return list.filter(f => f.anyOverdue);
    if (filter === 'to_assign') return list.filter(f => orderOf(f).some(o => o.unassignedDocs > 0));
    if (filter === 'open') return list.filter(f => orderOf(f).some(o => o.open));
    return list;
  }, [rows, filter, mine]);

  const toAssign = useMemo(
    () => (rows || []).reduce((n, f) => n + (Number(f.toAssign) || 0), 0), [rows]);
  const lateCount = useMemo(() => (rows || []).filter(f => f.anyOverdue).length, [rows]);

  if (err) return <div className="notice err">{err}</div>;
  if (!rows) return <div className="panel"><p className="muted small">Loading orders…</p></div>;

  return (
    <div>
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Orders</h1>
        <div className="spacer" />
        {lateCount > 0 && <span className="pill" style={{ color: '#B3261E', borderColor: '#B3261E' }}>{lateCount} file{lateCount === 1 ? '' : 's'} late</span>}
        {toAssign > 0 && <span className="pill" style={{ color: 'var(--gold)', borderColor: 'var(--gold)', marginLeft: 8 }}>{toAssign} document{toAssign === 1 ? '' : 's'} to classify</span>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Every title, insurance and attorney closing-prep order across your files, the latest first.
        Chase a vendor from here, or open the file to order, reassign or classify what came back.
      </p>
      {/* NO SILENT CAPS. A queue that quietly stops at N reads as "that is
          everything", which is the one thing this screen must never imply. */}
      {capped && (
        <div className="notice" style={{ marginTop: 0, marginBottom: 10 }}>
          This is the oldest {capped} orders, and there are more. Work these off, or narrow
          the list with the filters above, and the rest will appear.
        </div>
      )}

      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="cond-tabs" role="tablist">
          {[{ k: 'all', label: 'All' },
            { k: 'late', label: `Late${lateCount ? ` (${lateCount})` : ''}` },
            { k: 'open', label: 'In progress' },
            { k: 'to_assign', label: `Needs classifying${toAssign ? ` (${toAssign})` : ''}` }].map(t => (
            <button key={t.k} type="button" role="tab" aria-selected={filter === t.k}
              className={`cond-tab${filter === t.k ? ' active' : ''}`} onClick={() => setFilter(t.k)}>{t.label}</button>
          ))}
        </div>
        <div className="spacer" />
        <label className="muted small" htmlFor="ord-owner">Chased by</label>
        <select id="ord-owner" className="small" value={mine} onChange={(e) => setMine(e.target.value)}>
          <option value="">Anyone</option>
          {me && me.id && owners.some(o => o.id === me.id) ? <option value={me.id}>Me</option> : null}
          <option value="__none">Nobody yet</option>
          {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>

      {filtered.length === 0
        ? <div className="panel"><p className="muted small">No orders match.</p></div>
        : (
          <div className="panel" style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', minWidth: 980 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>File</th>
                  {KINDS.map(k => <th key={k.key} style={{ textAlign: 'left' }}>{k.label}</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map(f => (
                  <tr key={f.applicationId} style={f.anyOverdue ? { background: '#FDF4F4' } : undefined}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{f.loanNumber || 'Loan # pending'}</div>
                      <div className="muted small">{f.borrowerName || '—'} · {addrLine(f.propertyAddress)}</div>
                    </td>
                    {KINDS.map(k => (
                      <td key={k.key}>
                        <OrderCell o={f[k.key]} appId={f.applicationId} kind={k.key} onChased={load} fileStatus={f.fileStatus} />
                      </td>
                    ))}
                    <td style={{ textAlign: 'right' }}>
                      {/* Straight to the order that needs attention, not the top of
                          the Orders room. The retired #sec-orders still lands, but a
                          link written today should be precise. */}
                      <Link className="btn ghost small"
                        to={`/internal/app/${f.applicationId}#${(KINDS.find(k => f[k.key] && f[k.key].overdue) || KINDS[0]).section}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
