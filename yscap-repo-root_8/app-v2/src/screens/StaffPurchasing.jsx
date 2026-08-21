import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import DropZone from '../components/DropZone.jsx';
import { fullNameOf } from '../lib/personName.js';
import { fmtDate } from '../lib/dates.js';
import { askConfirm } from '../lib/dialog.js';
import { confirmRemoveFromWorkflow } from '../lib/workflowRemove.js';

/* THE PURCHASING DESK (owner-directed 2026-07-26).

   Every file that moved to purchasing AFTER investor delivery. A TABLE-FUNDED
   loan was sold right at closing, so it never lands here.

   Per file you can see what's outstanding, write notes ("what you're still
   missing"), and keep a task list. Admins + closers hold `manage_purchasing`. */

const addrLine = (a) => !a ? '' : (a.oneLine || [a.line1 || a.street, a.city, a.state].filter(Boolean).join(', ') || '');
const day = (v) => fmtDate(v);   // MM/DD/YYYY (industry standard), shift-free
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const t = String(r.result || ''); resolve(t.includes(',') ? t.slice(t.indexOf(',') + 1) : t); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
const FILTERS = [
  { key: 'outstanding', label: 'Outstanding' },
  { key: 'complete', label: 'Completed' },
  { key: 'all', label: 'All' },
  { key: 'removed', label: 'Removed' },
];

/* WHO HEARS THAT A LOAN SOLD (owner-directed 2026-08-13). The moment Encompass shows a purchase
   advice date, PILOT emails these people: come in, upload the advice, enter the same date, mark the
   purchase complete. Seeded with the two the owner named; an admin can change who is on it here.
   Everyone on the desk can SEE the list — knowing who was told is half of not chasing twice. */
function NotifyList() {
  const [state, setState] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.get('/api/staff/purchasing/notify-list').then(setState).catch(() => setState({ people: [], staff: [], can_edit: false }));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function change(staffId, remove) {
    setBusy(true); setErr('');
    try {
      const r = await api.post('/api/staff/purchasing/notify-list', { staff_id: staffId, remove });
      setState((s) => ({ ...s, people: r.people || [] })); setPick('');
    } catch (e) { setErr(e?.data?.error || 'Could not change that.'); }
    finally { setBusy(false); }
  }

  if (!state) return null;
  const people = state.people || [];
  const chosen = new Set(people.map((p) => p.id));
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="panel-b" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ minWidth: 280, flex: 1 }}>
          <div style={{ fontWeight: 700 }}>Told when a loan sells</div>
          <div className="sub" style={{ marginTop: 2 }}>
            As soon as Encompass shows a purchase advice date, these people are emailed to come in,
            upload the advice, enter the same date and mark the purchase complete.
            {' '}
            {people.length
              ? <>Right now: <b>{people.map((p) => p.full_name).join(', ')}</b>.</>
              : <b style={{ color: 'var(--danger,#B4453C)' }}>Nobody is on this list — nobody will be told.</b>}
          </div>
        </div>
        {state.can_edit && (
          <button className="btn btn-sm ghost" onClick={() => setOpen(!open)}>{open ? 'Done' : 'Change who'}</button>
        )}
      </div>
      {open && state.can_edit && (
        <div className="panel-b" style={{ borderTop: '1px solid var(--hairline,#E4E0D6)' }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 280 }}>
              <option value="">Add someone…</option>
              {(state.staff || []).filter((p) => !chosen.has(p.id)).map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={!pick || busy} onClick={() => change(pick, false)}>Add</button>
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
            {people.map((p) => (
              <li key={p.id} className="row" style={{ justifyContent: 'space-between', gap: 10, padding: '4px 0' }}>
                <span>{p.full_name} <span className="muted">· {p.email}</span></span>
                <button className="btn btn-sm soft" disabled={busy} onClick={() => change(p.id, true)}>Remove</button>
              </li>
            ))}
            {!people.length && <li className="muted">Nobody yet.</li>}
          </ul>
          {err ? <div className="notice err" style={{ marginTop: 8 }}>{err}</div> : null}
        </div>
      )}
    </div>
  );
}

export default function StaffPurchasing() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('outstanding');
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setRows(null);
    const params = filter === 'removed' ? { status: 'all', removed: '1' } : { status: filter };
    api.purchasingQueue(params)
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch((e) => setErr((e && e.message) || 'Could not load the purchasing desk.'));
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const removeRow = async (r) => {
    setBusy(r.id);
    const ok = await confirmRemoveFromWorkflow(r.id, 'purchasing', fullNameOf(r));
    if (ok) load();
    setBusy(null);
  };
  const restoreRow = async (r) => {
    setBusy(r.id);
    try { await api.staffRestoreToWorkflow(r.id, 'purchasing'); load(); }
    catch (e) { setErr((e && e.message) || 'Could not restore the file.'); }
    finally { setBusy(null); }
  };

  const totals = useMemo(() => {
    const all = rows || [];
    return { files: all.length, tasks: all.reduce((n, r) => n + (Number(r.open_tasks) || 0), 0) };
  }, [rows]);

  if (err && !rows) return <div role="alert" className="notice err">{err}</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Purchasing</h1>
          <div className="sub">
            Files delivered to the investor and now going through purchasing. A table-funded loan
            is sold at closing, so it never shows up here.
          </div>
        </div>
        <div className="page-head-actions">
          <div className="tabs">
            {FILTERS.map((f) => (
              <button key={f.key} className={`tab ${filter === f.key ? 'on' : ''}`}
                onClick={() => { setFilter(f.key); setOpenId(null); }}>{f.label}</button>
            ))}
          </div>
        </div>
      </div>

      {err && rows && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}
        <button className="btn link small" onClick={() => setErr('')}>Dismiss</button></div>}

      <NotifyList />

      {!rows ? <div className="panel pad muted">Loading…</div> : rows.length === 0 ? (
        <div className="panel"><div className="panel-b"><div className="empty-state">
          <h3>{filter === 'outstanding' ? 'Nothing outstanding in purchasing 🎉' : 'Nothing here'}</h3>
          <p>A file arrives here the moment the closer signs off investor delivery — unless it was table funded.</p>
        </div></div></div>
      ) : (
        <div className="stack">
          {filter === 'outstanding' && (
            <div className="kpi-grid">
              <div className="kpi"><div className="v">{totals.files}</div><div className="k">Files outstanding</div><div className="d">Waiting to finish purchasing</div></div>
              <div className="kpi"><div className="v">{totals.tasks}</div><div className="k">Open tasks</div><div className="d">Across every file here</div></div>
            </div>
          )}

          <div className="panel">
            <div className="cl-table-wrap">
              <table className="cl-table">
                <thead>
                  <tr>
                    <th>Borrower / property</th><th>Loan #</th><th>Investor</th>
                    <th>Entered</th><th>Open tasks</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <React.Fragment key={r.id}>
                      <tr>
                        <td>
                          <Link to={`/internal/app/${r.id}`}>{fullNameOf(r) || '—'}</Link>
                          <div className="muted small">{addrLine(r.property_address) || '—'}</div>
                          {/* A file goes to purchasing the moment investor delivery is
                              signed off — "even if it's not removed yet from the closing
                              workload because it's waiting for reconciliation". So it can
                              legitimately be on BOTH desks, and the closer needs to see
                              which ones those are. The queue already fetched this; it was
                              simply never rendered. */}
                          {r.closing_retired === false && (
                            <div className="small" style={{ color: '#8A6D1F', marginTop: 2 }}>
                              Still on the closing desk — waiting for reconciliation
                              {r.closer_name ? ` (${r.closer_name})` : ''}
                            </div>
                          )}
                        </td>
                        <td className="mono">{r.ys_loan_number || '—'}</td>
                        <td>{r.lender || '—'}</td>
                        <td>{day(r.entered_at)}</td>
                        <td>{Number(r.open_tasks) > 0
                          ? <span className="pill">{r.open_tasks} open</span>
                          : <span className="muted small">none</span>}</td>
                        <td><span className={`pill ${r.status === 'complete' ? 'ok' : ''}`}>
                          {r.status === 'complete' ? 'Complete' : 'Outstanding'}</span></td>
                        <td>
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <button className="btn ghost small"
                              onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                              {openId === r.id ? 'Hide' : 'Open'}
                            </button>
                            {filter === 'removed'
                              ? <button className="btn ghost small" disabled={busy === r.id} onClick={() => restoreRow(r)}>Restore</button>
                              : <button className="btn ghost small" disabled={busy === r.id} title="Remove this file from the purchasing view (does not delete it)" onClick={() => removeRow(r)}>Remove</button>}
                          </div>
                        </td>
                      </tr>
                      {openId === r.id && (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--ink-2)' }}>
                            <PurchasingDetail appId={r.id} status={r.status} onChanged={load} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* Per-file purchasing detail: what's still missing (notes) + the task list. */
function PurchasingDetail({ appId, status, onChanged }) {
  const [ws, setWs] = useState(null);
  const [note, setNote] = useState('');
  const [task, setTask] = useState('');
  const [cond, setCond] = useState('');
  const [condDetail, setCondDetail] = useState('');
  const [advice, setAdvice] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.purchasingGet(appId)
      .then((d) => {
        setWs(d);
        // Re-seed the date input from the server, so a save is reflected and a
        // concurrent edit by someone else is not silently overwritten by a stale
        // local value.
        setAdvice(((d && d.advice && d.advice.advice_date) || '').slice(0, 10));
      })
      .catch((e) => setErr((e && e.message) || 'Could not load this file.'));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    if (busy) return;
    setBusy(true); setErr('');
    try { await fn(); load(); if (onChanged) onChanged(); }
    catch (e) { setErr((e && e.message) || 'That did not save.'); }
    finally { setBusy(false); }
  };

  /* ONE reader for both doors — the picker and a dragged file (owner item 6, 2026-08-21).
     Uploaded STAFF-ONLY and designated in one action, so the advice is never borrower-visible
     at any point — not even for the window between upload and designation. A purchase advice
     names the note buyer and the price the loan sold for. */
  const uploadAdvice = (f) => {
    if (!f) return;
    run(async () => {
      const up = await api.purchasingAdviceUpload(appId, {
        filename: f.name, contentType: f.type, dataBase64: await fileToBase64(f),
      });
      if (up && up.documentId) await api.purchasingAdvice(appId, { documentId: up.documentId });
    });
  };

  if (!ws) return <div className="muted small" style={{ padding: 10 }}>Loading…</div>;
  // Advice lives in its OWN record and OUTLIVES a withdrawal from the desk.
  const adv = ws.advice || {};

  return (
    <div className="pu-detail">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="pu-cols">
        {/* What's still missing */}
        <div className="pu-col">
          <div className="pu-h">What's still missing</div>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <input className="input" style={{ flex: 1 }} placeholder="e.g. final title policy not received"
              value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn primary small" disabled={busy || !note.trim()}
              onClick={() => run(async () => { await api.purchasingAddNote(appId, note.trim()); setNote(''); })}>
              Add note
            </button>
          </div>
          {(ws.notes || []).length === 0 ? <div className="muted small">No notes yet.</div>
            : (ws.notes || []).map((n) => (
              <div key={n.id} className="pu-note">
                <div className="pu-note-body">{n.body}</div>
                <div className="muted small">{n.author_name || 'Someone'} · {day(n.created_at)}</div>
              </div>
            ))}
        </div>

        {/* Tasks */}
        <div className="pu-col">
          <div className="pu-h">Tasks</div>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <input className="input" style={{ flex: 1 }} placeholder="e.g. chase the recorded mortgage"
              value={task} onChange={(e) => setTask(e.target.value)} />
            <button className="btn primary small" disabled={busy || !task.trim()}
              onClick={() => run(async () => { await api.purchasingAddTask(appId, task.trim()); setTask(''); })}>
              Add task
            </button>
          </div>
          {(ws.tasks || []).length === 0 ? <div className="muted small">No tasks yet.</div>
            : (ws.tasks || []).map((t) => (
              <div key={t.id} className="pu-task">
                <label className="row" style={{ gap: 8, alignItems: 'center', flex: 1 }}>
                  <input type="checkbox" checked={!!t.done} disabled={busy}
                    onChange={(e) => run(() => api.purchasingTaskDone(appId, t.id, e.target.checked))} />
                  <span className={t.done ? 'pu-task-done' : ''}>{t.label}</span>
                </label>
                {t.done && t.done_by_name && <span className="muted small">{t.done_by_name}</span>}
                <button className="btn link small" disabled={busy}
                  onClick={() => run(() => api.purchasingTaskDelete(appId, t.id))}>Remove</button>
              </div>
            ))}
        </div>
      </div>

      {/* Conditions — what the buyer still needs before they will purchase. */}
      <div className="pu-col" style={{ marginTop: 14 }}>
        <div className="pu-h">Conditions to purchase</div>
        <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <input className="input" style={{ flex: 2, minWidth: 180 }} placeholder="e.g. recorded mortgage returned from the county"
            value={cond} onChange={(e) => setCond(e.target.value)} />
          <input className="input" style={{ flex: 3, minWidth: 180 }} placeholder="Detail (optional)"
            value={condDetail} onChange={(e) => setCondDetail(e.target.value)} />
          <button className="btn primary small" disabled={busy || !cond.trim()}
            onClick={() => run(async () => {
              await api.purchasingAddCondition(appId, cond.trim(), condDetail.trim() || null);
              setCond(''); setCondDetail('');
            })}>Add condition</button>
        </div>
        {(ws.conditions || []).length === 0 ? <div className="muted small">No conditions yet.</div>
          : (ws.conditions || []).map((x) => (
            <div key={x.id} className="pu-cond">
              <div className="pu-cond-main">
                <span className={x.status === 'open' ? '' : 'pu-task-done'}>{x.label}</span>
                {x.detail && <span className="muted small">{x.detail}</span>}
                {x.status !== 'open' && (
                  <span className="muted small">
                    {x.status === 'waived' ? 'Waived' : 'Cleared'}
                    {x.resolved_by_name ? ` by ${x.resolved_by_name}` : ''} · {day(x.resolved_at)}
                    {x.resolution_note ? ` — ${x.resolution_note}` : ''}
                  </span>
                )}
              </div>
              <div className="row" style={{ gap: 6, flex: '0 0 auto' }}>
                {x.status === 'open' ? (
                  <>
                    <button className="btn ghost small" disabled={busy}
                      onClick={() => run(() => api.purchasingConditionStatus(appId, x.id, 'cleared'))}>Clear</button>
                    <button className="btn link small" disabled={busy}
                      onClick={() => run(() => api.purchasingConditionStatus(appId, x.id, 'waived'))}>Waive</button>
                  </>
                ) : (
                  <button className="btn ghost small" disabled={busy}
                    onClick={() => run(() => api.purchasingConditionStatus(appId, x.id, 'open'))}>Re-open</button>
                )}
                <button className="btn link small" disabled={busy}
                  onClick={() => run(() => api.purchasingConditionDelete(appId, x.id))}>Remove</button>
              </div>
            </div>
          ))}
      </div>

      {/* Purchase advice — the date, and the advice document (re-issued post
          closing and again post purchase, so it is an ordinary update). */}
      <div className="pu-col" style={{ marginTop: 14 }}>
        <div className="pu-h">Purchase advice</div>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="small muted">Purchase advice date</span>
            <input className="input" type="date" value={advice} disabled={busy}
              onChange={(e) => setAdvice(e.target.value)} />
          </label>
          <button className="btn primary small" disabled={busy || advice === (adv.advice_date || '').slice(0, 10)}
            onClick={() => run(() => api.purchasingAdvice(appId, { date: advice || null }))}>Save date</button>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 200 }}>
            <span className="small muted">Purchase advice document</span>
            <select className="input" value={adv.document_id || ''} disabled={busy}
              onChange={async (e) => {
                const id = e.target.value || null;
                const doc = (ws.documents || []).find((d) => String(d.id) === String(id));
                // Designating HIDES the document from the borrower, permanently
                // as far as this screen is concerned. The list is every document
                // on the file, so confirm before hiding one they can see today.
                if (doc && doc.is_current !== false && doc.visibility === 'borrower'
                  && !(await askConfirm(`"${doc.filename}" is currently visible to the borrower.\n\nMaking it the purchase advice will hide it from them — a purchase advice names the note buyer and the price the loan sold for, so it is staff-only.\n\nContinue?`))) {
                  e.target.value = adv.document_id || '';
                  return;
                }
                run(() => api.purchasingAdvice(appId, { documentId: id }));
              }}>
              <option value="">— none selected —</option>
              {(ws.documents || []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filename}{d.visibility === 'borrower' ? ' — the borrower can see this' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        {/* Drag-and-drop as well as the picker (owner item 6, 2026-08-21). A purchase advice
            is ONE document, so a multi-file drop takes the first. */}
        <DropZone className="row dz-inline" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}
          enabled={!busy} title="Drop the purchase advice here"
          onFiles={(list) => uploadAdvice(Array.from(list || [])[0])}>
          <label className="btn ghost small" style={{ cursor: busy ? 'default' : 'pointer' }}>
            Upload the advice…
            <input type="file" style={{ display: 'none' }} disabled={busy}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                e.target.value = '';
                uploadAdvice(f);
              }} />
          </label>
          <span className="muted small">Uploaded here it is staff-only from the outset — drag it on if you prefer.</span>
        </DropZone>

        <div className="muted small" style={{ marginTop: 6 }}>
          {adv.document_filename
            ? <>Current: <b>{adv.document_filename}</b> · uploaded {day(adv.document_uploaded_at)}. Upload a newer copy here to replace it post purchase — the previous one stays hidden from the borrower.</>
            : <>Upload it here and it is staff-only from the outset. A purchase advice names the note buyer and the price the loan sold for, so the borrower never sees it.</>}
        </div>
      </div>

      <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
        {status === 'complete' ? (
          <button className="btn ghost small" disabled={busy}
            onClick={() => run(() => api.purchasingStatus(appId, 'outstanding'))}>Re-open purchasing</button>
        ) : (
          <button className="btn primary small" disabled={busy}
            onClick={() => run(() => api.purchasingStatus(appId, 'complete'))}>Mark purchasing complete</button>
        )}
        <Link className="btn ghost small" to={`/internal/app/${appId}`}>Open the file</Link>
      </div>
    </div>
  );
}
