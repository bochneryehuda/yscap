import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* Per-file construction-draw desk (staff). One place tying draws ↔ Scope of Work ↔
   construction budget: the unified per-line/per-unit rollup, each draw's per-line
   requested/approved with set-approved + approve/amend/reopen, the advisory risk
   flags, the money ledger (fee → net release → date), inspection-findings delivery,
   and Scope-of-Work reallocations. Gated by the manage_draws capability. */

const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usd2 = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDay = (v) => (v ? String(v).slice(0, 10) : '—');
const STATUS = {
  drafting: 'Drafting', pending_borrower: 'With borrower', inspecting: 'Inspecting',
  pending: 'Awaiting your approval', pending_capital_partner: 'With capital partner', approved: 'Approved',
};
const RISK = { high: { label: 'High risk', cls: 'sw-pending' }, medium: { label: 'Review', cls: 'sw-insp' }, low: { label: 'Minor', cls: 'sw-draft' }, clear: { label: 'Clear', cls: 'sw-approved' } };

export default function DrawsPanel({ appId }) {
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/api/sitewire/files/${appId}/rollup`)
      .then((d) => { setData(d); setErr(''); })
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load draws'))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  const canManage = can('manage_draws');
  if (!canManage) return null;
  if (loading) return <div className="panel" style={{ marginTop: 12 }}>Loading draws…</div>;
  if (err) return <div className="panel" style={{ marginTop: 12, color: 'var(--bad,#b04a3f)' }}>{err}</div>;
  if (!data) return null;

  const { rollup, link, requests = [], ledger = [], findings = [], change_requests = [] } = data;
  // Render draw cards from rollup.draws — it carries the money (requested/approved/net_release),
  // the funded flag, and the merged risk flags + pdf_src. The top-level `draws` array has no
  // money fields, so using it would render $0.00 everywhere.
  const draws = rollup.draws || [];
  const reqsByDraw = {};
  for (const r of requests) (reqsByDraw[r.sitewire_draw_id] = reqsByDraw[r.sitewire_draw_id] || []).push(r);
  const findingByDraw = {};
  for (const f of findings) findingByDraw[f.sitewire_draw_id] = f;

  const notLinked = !link || !link.sitewire_property_id;

  async function act(key, fn) {
    setBusy(key); setMsg('');
    try { const r = await fn(); setMsg(r && r.msg ? r.msg : 'Done.'); load(); }
    catch (e) { setMsg(e?.data?.error || e.message || 'That didn\'t work.'); }
    finally { setBusy(''); }
  }

  return (
    <div>
      {notLinked ? (
        <div className="panel" style={{ marginTop: 12 }}>
          <b>This file isn't in Sitewire yet.</b>
          <div className="muted" style={{ marginTop: 4 }}>The construction-draw setup is created when the borrower requests their first draw on a funded file. Until then there's nothing to manage here.</div>
        </div>
      ) : (
        <>
          {msg && <div className="panel" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)' }}>{msg}</div>}

          {/* ---- rollup summary tiles ---- */}
          <div className="grid cols-4" style={{ marginTop: 12, gap: 12 }}>
            <Tile label="Construction budget" value={usd(rollup.project.budget)} />
            <Tile label="Drawn (released)" value={usd(rollup.project.drawn)} sub={`${rollup.project.pct_complete}% complete`} />
            <Tile label="Remaining" value={usd(rollup.project.remaining)} accent />
            <Tile label="In the pipeline" value={usd(rollup.project.approved_pending + rollup.project.requested_open)} sub="awaiting approval" />
          </div>

          {/* ---- the unified per-line / per-unit rollup ---- */}
          <RollupTable rollup={rollup} />

          {/* ---- draws ---- */}
          <h3 style={{ marginTop: 22, marginBottom: 6 }}>Draws</h3>
          {draws.length === 0 && <div className="muted">No draws yet on this file.</div>}
          {draws.map((d) => (
            <DrawCard key={d.sitewire_draw_id} appId={appId} draw={d} requests={reqsByDraw[d.sitewire_draw_id] || []}
              finding={findingByDraw[d.sitewire_draw_id]} busy={busy} act={act} reload={load} />
          ))}

          {/* ---- money ledger ---- */}
          <LedgerPanel appId={appId} ledger={ledger} draws={draws} onSaved={load} />

          {/* ---- Scope-of-Work reallocations ---- */}
          <ChangeRequests appId={appId} items={change_requests} busy={busy} act={act} />
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, accent }) {
  return (
    <div className="panel" style={{ padding: '12px 14px' }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 3, color: accent ? 'var(--gold,#ae8746)' : 'inherit' }}>{value}</div>
      {sub && <div className="muted small" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Bar({ pct }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return (
    <div style={{ height: 6, background: 'var(--line,#e6e0d4)', borderRadius: 4, overflow: 'hidden', minWidth: 60 }}>
      <div style={{ width: p + '%', height: '100%', background: p >= 100 ? 'var(--bad,#b04a3f)' : 'var(--teal,#2f7f86)' }} />
    </div>
  );
}

function RollupTable({ rollup }) {
  const [openKey, setOpenKey] = useState(null);
  const lines = rollup.lines.filter((l) => l.kind === 'line');
  const extras = rollup.lines.filter((l) => l.kind === 'contingency' || l.kind === 'gc');
  return (
    <div className="panel" style={{ marginTop: 14, overflowX: 'auto', padding: 0 }}>
      <table className="table" style={{ width: '100%', minWidth: 640 }}>
        <thead><tr>
          <th>Scope-of-Work line</th><th style={{ textAlign: 'right' }}>Budget</th><th style={{ textAlign: 'right' }}>Drawn</th>
          <th style={{ textAlign: 'right' }}>Remaining</th><th style={{ width: 130 }}>Progress</th><th></th>
        </tr></thead>
        <tbody>
          {lines.map((l) => (
            <React.Fragment key={l.sow_line_key}>
              <tr>
                <td>{l.label}{l.units.length > 1 && <span className="muted small"> · {l.units.length} units</span>}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.budgeted)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.drawn)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.remaining)}</td>
                <td><div className="row" style={{ gap: 6, alignItems: 'center' }}><Bar pct={l.pct_complete} /><span className="muted small">{l.pct_complete}%</span></div></td>
                <td>{l.units.length > 1 && <button className="btn btn-sm ghost" onClick={() => setOpenKey(openKey === l.sow_line_key ? null : l.sow_line_key)}>{openKey === l.sow_line_key ? 'Hide' : 'Units'}</button>}</td>
              </tr>
              {openKey === l.sow_line_key && l.units.map((u) => (
                <tr key={l.sow_line_key + ':u' + u.unit_index} style={{ background: 'var(--paper,#f6f3ec)' }}>
                  <td style={{ paddingLeft: 24 }} className="muted">Unit {u.unit_index}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(u.budgeted)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(u.drawn)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(u.remaining)}</td>
                  <td><Bar pct={u.pct_complete} /></td><td></td>
                </tr>
              ))}
            </React.Fragment>
          ))}
          {extras.map((l) => (
            <tr key={l.sow_line_key} className="muted">
              <td>{l.kind === 'contingency' ? 'Contingency' : 'GC fee'}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.budgeted)}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.drawn)}</td>
              <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(l.remaining)}</td>
              <td colSpan={2}></td>
            </tr>
          ))}
          <tr style={{ fontWeight: 700, borderTop: '2px solid var(--line,#e6e0d4)' }}>
            <td>Total</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(rollup.project.budget)}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(rollup.project.drawn)}</td>
            <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd(rollup.project.remaining)}</td>
            <td colSpan={2}></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function DrawCard({ appId, draw, requests, finding, busy, act, reload }) {
  const isOpen = draw.status !== 'approved';
  const flags = Array.isArray(draw.risk_flags) ? draw.risk_flags : [];
  const risk = RISK[draw.risk_level] || null;
  const [edits, setEdits] = useState({}); // reqId -> approved dollars string

  async function setApproved(r) {
    const dollars = edits[r.sitewire_request_id];
    const cents = Math.round(Number(String(dollars).replace(/[^0-9.]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents < 0) return;
    await act('appr:' + r.sitewire_request_id, async () => {
      await api.post(`/api/sitewire/requests/${r.sitewire_request_id}/approve`, { approved_cents: cents });
      return { msg: 'Approved amount saved.' };
    });
  }
  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <b>Draw #{draw.number ?? '—'}</b>
          <span className="pill sw-insp">{STATUS[draw.status] || draw.status}</span>
          {risk && flags.length > 0 && <span className={'pill ' + risk.cls}>{risk.label} · {flags.length}</span>}
        </div>
        <div className="muted small">Requested {usd2(draw.requested_cents)} · Approved {usd2(draw.approved_cents)} · Net {usd2(draw.net_release_cents)}</div>
      </div>

      {flags.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {flags.map((f, i) => (
            <li key={i} className="small" style={{ color: f.severity === 'high' ? 'var(--bad,#b04a3f)' : 'var(--muted,#4b585c)' }}>{f.message}</li>
          ))}
        </ul>
      )}

      {requests.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="table" style={{ width: '100%', minWidth: 560 }}>
            <thead><tr><th>Line</th><th style={{ textAlign: 'right' }}>Requested</th><th style={{ textAlign: 'right' }}>Approved</th><th>Photos</th>{isOpen && <th>Set approved</th>}</tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.sitewire_request_id}>
                  <td>{r.job_item_name || `Line ${r.sitewire_job_item_id}`}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(r.requested_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.approved_cents == null ? '—' : usd2(r.approved_cents)}</td>
                  <td className="muted small">{r.inspection_count || 0}</td>
                  {isOpen && (
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <input className="input" style={{ width: 100 }} placeholder="$" value={edits[r.sitewire_request_id] ?? ''} onChange={(e) => setEdits((s) => ({ ...s, [r.sitewire_request_id]: e.target.value }))} />
                        <button className="btn btn-sm ghost" disabled={busy === 'appr:' + r.sitewire_request_id} onClick={() => setApproved(r)}>Save</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {isOpen && ['approve', 'amend', 'reopen'].map((a) => (
          <button key={a} className={'btn btn-sm ' + (a === 'approve' ? 'primary' : 'ghost')} disabled={busy === a + draw.sitewire_draw_id}
            onClick={() => act(a + draw.sitewire_draw_id, async () => { await api.post(`/api/sitewire/draws/${draw.sitewire_draw_id}/${a}`, {}); return { msg: `Draw ${a}d.` }; })}>
            {a[0].toUpperCase() + a.slice(1)}
          </button>
        ))}
        <button className="btn btn-sm ghost" disabled={busy === 'deliver' + draw.sitewire_draw_id}
          onClick={() => act('deliver' + draw.sitewire_draw_id, async () => { const r = await api.post(`/api/sitewire/files/${appId}/findings/${draw.sitewire_draw_id}/deliver`, {}); return { msg: `Findings delivered to the borrower (${r.lines} items).` }; })}>
          {finding ? 'Re-send findings' : 'Deliver findings to borrower'}
        </button>
        {draw.pdf_src && <a className="btn btn-sm ghost" href={draw.pdf_src} target="_blank" rel="noreferrer">Sitewire PDF</a>}
      </div>

      {finding && <FindingStatus appId={appId} finding={finding} reload={reload} />}
    </div>
  );
}

function FindingStatus({ appId, finding, reload }) {
  const [detail, setDetail] = useState(null);
  const badge = { delivered: 'Awaiting the borrower', accepted: 'Accepted', disputed: 'Disputed — needs review', resolved: 'Resolved' }[finding.status] || finding.status;
  useEffect(() => { if (finding.status === 'disputed') api.get(`/api/sitewire/findings/${finding.id}`).then(setDetail).catch(() => {}); }, [finding.id, finding.status]);
  async function decide(lineId, decision) {
    try { await api.post(`/api/sitewire/findings/${finding.id}/lines/${lineId}/decide`, { decision }); const d = await api.get(`/api/sitewire/findings/${finding.id}`); setDetail(d); reload(); } catch (e) { /* surfaced by parent on reload */ }
  }
  return (
    <div style={{ marginTop: 8, borderTop: '1px dashed var(--line,#e6e0d4)', paddingTop: 8 }}>
      <div className="small"><b>Inspection findings:</b> {badge}{finding.wire_due_at && finding.status === 'accepted' ? ` · release due ${new Date(finding.wire_due_at).toLocaleString('en-US')}` : ''}</div>
      {detail && detail.lines && detail.lines.filter((l) => l.dispute_status === 'open').map((l) => (
        <div key={l.id} className="row between" style={{ marginTop: 6, gap: 8, flexWrap: 'wrap' }}>
          <div className="small">{l.name}: borrower wants {l.dispute_desired_cents == null ? '(review)' : usd2(l.dispute_desired_cents)}{l.dispute_note ? ` — "${l.dispute_note}"` : ''}</div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm primary" onClick={() => decide(l.id, 'approved')}>Approve</button>
            <button className="btn btn-sm ghost" onClick={() => decide(l.id, 'rejected')}>Reject</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function LedgerPanel({ appId, ledger, draws, onSaved }) {
  const [f, setF] = useState({ sitewire_draw_id: '', approved: '', fee: '', fee_kind: 'virtual', release_date: '', funded_status: 'released' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const net = Math.round(Number(f.approved || 0) * 100) - Math.round(Number(f.fee || 0) * 100);
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.post('/api/sitewire/disbursements', {
        application_id: appId, sitewire_draw_id: f.sitewire_draw_id || null,
        approved_cents: Math.round(Number(f.approved || 0) * 100), fee_cents: Math.round(Number(f.fee || 0) * 100),
        fee_kind: f.fee_kind, release_date: f.release_date || null, funded_status: f.funded_status,
      });
      setF({ sitewire_draw_id: '', approved: '', fee: '', fee_kind: 'virtual', release_date: '', funded_status: 'released' });
      onSaved();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3 style={{ marginTop: 0 }}>Money ledger</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>Record what was released after approval — our fee comes off the approved amount, the borrower nets the rest.</div>
      {ledger.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', minWidth: 560 }}>
            <thead><tr><th>Draw</th><th style={{ textAlign: 'right' }}>Approved</th><th style={{ textAlign: 'right' }}>Fee</th><th style={{ textAlign: 'right' }}>Net release</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>
              {ledger.map((d) => (
                <tr key={d.id}>
                  <td>{d.sitewire_draw_id ? '#' + d.sitewire_draw_id : '—'}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.approved_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.fee_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.net_release_cents)}</td>
                  <td className="muted">{fmtDay(d.release_date)}</td>
                  <td><span className="pill sw-approved">{d.funded_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="small">Draw
          <select className="input" value={f.sitewire_draw_id} onChange={(e) => setF({ ...f, sitewire_draw_id: e.target.value })}>
            <option value="">—</option>
            {draws.map((d) => <option key={d.sitewire_draw_id} value={d.sitewire_draw_id}>#{d.number}</option>)}
          </select>
        </label>
        <label className="small">Approved $<input className="input" style={{ width: 110 }} value={f.approved} onChange={(e) => setF({ ...f, approved: e.target.value })} /></label>
        <label className="small">Our fee $<input className="input" style={{ width: 90 }} value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></label>
        <label className="small">Kind
          <select className="input" value={f.fee_kind} onChange={(e) => setF({ ...f, fee_kind: e.target.value })}><option value="virtual">Virtual</option><option value="physical">Physical</option></select>
        </label>
        <label className="small">Release date<input type="date" className="input" value={f.release_date} onChange={(e) => setF({ ...f, release_date: e.target.value })} /></label>
        <div className="small" style={{ alignSelf: 'center' }}>Net: <b>{usd2(net)}</b></div>
        <button className="btn btn-sm primary" disabled={busy || net < 0} onClick={save}>Record release</button>
      </div>
      {err && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function ChangeRequests({ appId, items, busy, act }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3 style={{ marginTop: 0 }}>Scope-of-Work reallocations</h3>
      {items.map((cr) => (
        <div key={cr.id} className="row between" style={{ padding: '8px 0', borderTop: '1px solid var(--line,#e6e0d4)', gap: 8, flexWrap: 'wrap' }}>
          <div>
            <div><b>{cr.net_zero ? 'Net-zero move' : 'Total change'}</b> {cr.reason ? <span className="muted">· {cr.reason}</span> : null}</div>
            <div className="muted small">
              {cr.status === 'approved' ? 'Applied' : 'Pending'}
              {cr.needs_capital_partner ? ` · capital partner: ${cr.capital_partner_status || 'pending'}` : ''}
              {cr.after_ctc ? ' · after clear-to-close' : ' · before clear-to-close'}
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm ghost" onClick={() => api.sitewireExportReallocation(cr.id).catch(() => {})}>Export</button>
            {cr.status !== 'approved' && cr.needs_capital_partner && cr.capital_partner_status !== 'approved' && (
              <button className="btn btn-sm ghost" disabled={busy === 'cp' + cr.id} onClick={() => act('cp' + cr.id, async () => { await api.post(`/api/sitewire/change-requests/${cr.id}/capital-partner`, { status: 'approved' }); return { msg: 'Capital-partner approval recorded.' }; })}>Mark CP approved</button>
            )}
            {cr.status !== 'approved' && (
              <button className="btn btn-sm primary" disabled={busy === 'apply' + cr.id} onClick={() => act('apply' + cr.id, async () => { const r = await api.post(`/api/sitewire/change-requests/${cr.id}/apply`, {}); return { msg: r.applied ? 'Reallocation applied and pushing to Sitewire.' : 'Recorded — needs product re-registration on the new budget.' }; })}>Apply</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
