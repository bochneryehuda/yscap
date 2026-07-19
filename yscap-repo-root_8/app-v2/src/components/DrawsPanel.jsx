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

  const { rollup, link, requests = [], ledger = [], findings = [], change_requests = [], retainage = null, waivers = [], lien_waivers_enabled = false } = data;
  // Render draw cards from rollup.draws — it carries the money (requested/approved/net_release),
  // the funded flag, and the merged risk flags + pdf_src. The top-level `draws` array has no
  // money fields, so using it would render $0.00 everywhere.
  const draws = rollup.draws || [];
  const reqsByDraw = {};
  for (const r of requests) (reqsByDraw[r.sitewire_draw_id] = reqsByDraw[r.sitewire_draw_id] || []).push(r);
  const findingByDraw = {};
  for (const f of findings) findingByDraw[f.sitewire_draw_id] = f;

  const notLinked = !link || !link.sitewire_property_id;
  // A draw approval / release / findings write 503s unless BOTH the master switch and the write
  // gate are on. Surface that up front (read-only banner + disabled write buttons) so the coordinator
  // isn't clicking into repeated "writes are turned off" errors while the integration is staged off.
  const sw = data.switches || {};
  const writesOff = !!data.switches && !(sw.enabled && sw.outbound);

  async function act(key, fn) {
    setBusy(key); setMsg('');
    try { const r = await fn(); setMsg(r && r.msg ? r.msg : 'Done.'); load(); }
    catch (e) { setMsg(e?.data?.error || e.message || 'That didn\'t work.'); }
    finally { setBusy(''); }
  }

  return (
    <div>
      {notLinked ? (
        <StartDrawCard appId={appId} onStarted={load} />
      ) : (
        <>
          {msg && <div className="panel" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)' }}>{msg}</div>}

          {/* ---- read-only notice when Sitewire writes are off (the default staged state) ---- */}
          {writesOff && (
            <div className="panel" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)', borderLeft: '3px solid var(--gold,#ae8746)' }}>
              <b>Sitewire is turned off.</b>
              <div className="muted small" style={{ marginTop: 3 }}>
                Approving a draw syncs to Sitewire, so <b>Approve / Amend / Reopen</b> and setting approved amounts are paused until it's switched on{sw.enabled && !sw.outbound ? ' (reads are on; writing is still off)' : ''}. Everything else here — the money ledger, releases, findings and records — is kept in PILOT and still works.
              </div>
            </div>
          )}

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
              finding={findingByDraw[d.sitewire_draw_id]} busy={busy} act={act} reload={load} writesOff={writesOff} />
          ))}

          {/* ---- money ledger ---- */}
          <LedgerPanel appId={appId} ledger={ledger} draws={draws} retainage={retainage} onSaved={load} act={act} busy={busy} />

          {/* ---- lien waivers — OFF by default; opt in per project ---- */}
          <LienWaivers appId={appId} enabled={lien_waivers_enabled} fileOverride={data.lien_waivers_file_override}
            canSetup={can('platform_setup')} waivers={waivers} draws={draws} busy={busy} act={act} onChanged={load} />

          {/* ---- Scope-of-Work reallocations ---- */}
          <ChangeRequests appId={appId} items={change_requests} busy={busy} act={act} />

          {/* ---- audit trail ---- */}
          <ActivityTrail appId={appId} />
        </>
      )}
    </div>
  );
}

/* The Draw Coordinator's first step after funding: review everything that will be sent to
   Sitewire, confirm the inspection method (switching it if the program allows), and press
   ONE button that pushes the property + construction budget + Scope of Work + fees over and
   reads them back. Nothing is guessed — a missing prerequisite disables the button, and any
   error while pushing lands in the review queue instead of being silently applied. */
function CheckRow({ ok, label }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'center', padding: '3px 0' }}>
      <span style={{ color: ok ? 'var(--teal,#2f7f86)' : 'var(--bad,#b04a3f)', fontWeight: 700, width: 16 }}>{ok ? '✓' : '•'}</span>
      <span className={ok ? '' : 'muted'}>{label}</span>
    </div>
  );
}

function StartDrawCard({ appId, onStarted }) {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/api/sitewire/files/${appId}/draw-setup`)
      .then((d) => { setS(d); setErr(''); setMethod(''); })
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load draw setup'))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="panel" style={{ marginTop: 12 }}>Loading draw setup…</div>;
  if (err) return <div className="panel" style={{ marginTop: 12, color: 'var(--bad,#b04a3f)' }}>{err}</div>;
  if (!s) return null;

  const insp = s.inspection || {};
  const cp = s.capital_partner || {};
  const p = s.prereqs || {};
  // the method actually in effect (the coordinator's live switch, else the resolved default)
  const effMethod = method || insp.method;
  const effKind = effMethod === 'traditional' ? 'physical' : 'virtual';
  // per-kind fee if the rule sets it, else the other kind, else the resolved default
  // (insp.fee_cents — what the server WILL actually charge when no rule exists). Never blank
  // out the fee when a real amount ($299 default) will be applied.
  const perKind = effKind === 'physical'
    ? (insp.fee_physical_cents != null ? insp.fee_physical_cents : insp.fee_virtual_cents)
    : insp.fee_virtual_cents;
  const effFee = perKind != null ? perKind : insp.fee_cents;
  const alreadyStarted = !!s.started_at; // coordinator pressed Start earlier; awaiting the switch/push

  async function start() {
    setBusy(true); setMsg('');
    try {
      const body = method && method !== insp.method ? { inspection_method: method } : {};
      const r = await api.post(`/api/sitewire/files/${appId}/start-draw`, body);
      setMsg(r && r.note ? r.note : 'Draw process started — everything was sent to Sitewire.');
      load();
      if (onStarted) setTimeout(onStarted, 400);
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn\'t work.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Start the draw process</h3>
          <div className="muted small" style={{ marginTop: 3 }}>This sends the property, construction budget, Scope of Work and fees to Sitewire, then reads them back to confirm. Do this once, after the loan is funded.</div>
        </div>
        {!s.switches?.enabled && <span className="pill" style={{ background: 'var(--paper,#f6f3ec)' }}>Sitewire is off — this will be queued</span>}
        {s.switches?.enabled && s.switches?.dryrun && <span className="pill" style={{ background: 'var(--paper,#f6f3ec)' }}>Dry-run (nothing sent yet)</span>}
        {s.switches?.enabled && !s.switches?.dryrun && !s.switches?.outbound && <span className="pill" style={{ background: 'var(--paper,#f6f3ec)' }}>Read-only mode</span>}
      </div>

      {alreadyStarted && (
        <div className="small" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, background: 'var(--paper,#f6f3ec)', color: 'var(--teal,#256168)' }}>
          ✓ Draw setup was started on {fmtDay(s.started_at)}{insp.chosen_override ? ` (${insp.chosen_override === 'traditional' ? 'on-site' : 'virtual'} inspection)` : ''}.
          {s.switches?.enabled ? ' You can re-send it below if needed.' : ' It will push to Sitewire automatically the moment Sitewire is turned on — nothing more to do.'}
        </div>
      )}

      <div className="grid cols-2" style={{ gap: 16, marginTop: 12 }}>
        <div>
          <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Before we can start</div>
          <CheckRow ok={p.funded} label="Loan is funded" />
          <CheckRow ok={p.loan_number} label="YS loan number set" />
          <CheckRow ok={p.capital_partner} label={cp.name ? `Capital partner: ${cp.name}` : 'Capital partner matched'} />
          <CheckRow ok={p.budget} label="Construction budget frozen" />
          <CheckRow ok={p.scope_of_work} label="Scope of Work saved" />
          <CheckRow ok={p.address} label="Property address complete" />
          {!p.capital_partner && cp.ambiguous && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 4 }}>The capital-partner name matches more than one — fix the lender label on the file.</div>}
          {!p.capital_partner && cp.candidate_name && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 4 }}>Closest match is “{cp.candidate_name}”, but it isn't exact — it needs confirming before we can push.</div>}
        </div>
        <div>
          <div className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Inspection & fee</div>
          {insp.can_switch ? (
            <label className="small">Inspection method
              <select className="input" value={effMethod} onChange={(e) => setMethod(e.target.value)}>
                <option value="mobile">Virtual (mobile){insp.default_method === 'mobile' ? ' — default' : ''}</option>
                <option value="traditional">On-site (traditional){insp.default_method === 'traditional' ? ' — default' : ''}</option>
              </select>
            </label>
          ) : (
            <div>{effMethod === 'traditional' ? 'On-site (traditional)' : 'Virtual (mobile)'}<span className="muted small"> — set by the program, can't switch</span></div>
          )}
          <div style={{ marginTop: 8 }}>Draw fee: <b>{effFee != null ? usd(effFee) : '—'}</b> <span className="muted small">per draw ({effKind})</span></div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {s.requires?.sitewire_inspector ? 'A Sitewire inspector must sign off each draw.' : 'No Sitewire inspector required.'}<br />
            {s.requires?.capital_partner_approval ? 'Approved draws route to the capital partner.' : 'No capital-partner approval step.'}
          </div>
        </div>
      </div>

      {s.open_reviews > 0 && (
        <div className="small" style={{ marginTop: 10, color: 'var(--bad,#b04a3f)' }}>
          {s.open_reviews} item{s.open_reviews === 1 ? '' : 's'} on this file need review before it will go through cleanly. <a href="#/internal/sync-reviews">Open the review list</a>.
        </div>
      )}

      <div className="row" style={{ gap: 10, marginTop: 14, alignItems: 'center' }}>
        {/* When started while Sitewire is off, there's nothing more to press — the worker pushes on switch-on. */}
        {!(alreadyStarted && !s.switches?.enabled) && (
          <button className="btn primary" disabled={busy || !s.can_start} onClick={start}>
            {busy ? 'Starting…' : alreadyStarted ? 'Re-send to Sitewire' : s.switches?.enabled ? 'Start the draw process' : 'Start (queue for Sitewire)'}
          </button>
        )}
        {!s.can_start && <span className="muted small">Finish the checklist above first.</span>}
        {msg && <span className="small" style={{ color: 'var(--teal,#2f7f86)' }}>{msg}</span>}
      </div>
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

function DrawCard({ appId, draw, requests, finding, busy, act, reload, writesOff }) {
  const offTip = writesOff ? 'Sitewire is turned off — available once it\'s switched on' : undefined;
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
                        <input className="input" style={{ width: 100 }} placeholder="$" disabled={writesOff} value={edits[r.sitewire_request_id] ?? ''} onChange={(e) => setEdits((s) => ({ ...s, [r.sitewire_request_id]: e.target.value }))} />
                        <button className="btn btn-sm ghost" title={offTip} disabled={writesOff || busy === 'appr:' + r.sitewire_request_id} onClick={() => setApproved(r)}>Save</button>
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
          <button key={a} className={'btn btn-sm ' + (a === 'approve' ? 'primary' : 'ghost')} title={offTip} disabled={writesOff || busy === a + draw.sitewire_draw_id}
            onClick={() => act(a + draw.sitewire_draw_id, async () => { await api.post(`/api/sitewire/draws/${draw.sitewire_draw_id}/${a}`, {}); return { msg: `Draw ${a}d.` }; })}>
            {a[0].toUpperCase() + a.slice(1)}
          </button>
        ))}
        <button className="btn btn-sm ghost" disabled={busy === 'deliver' + draw.sitewire_draw_id}
          onClick={() => act('deliver' + draw.sitewire_draw_id, async () => { const r = await api.post(`/api/sitewire/files/${appId}/findings/${draw.sitewire_draw_id}/deliver`, {}); return { msg: `Findings delivered to the borrower (${r.lines} items).` }; })}>
          {finding ? 'Re-send findings' : 'Deliver findings to borrower'}
        </button>
        <button className="btn btn-sm ghost" onClick={() => api.sitewireExportPacket(appId, draw.sitewire_draw_id).catch(() => {})}>Draw packet</button>
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

function LedgerPanel({ appId, ledger, draws, retainage, onSaved, act, busy: parentBusy }) {
  // map the Sitewire draw id -> the friendly draw number so the ledger reads "Draw #1", not "#8001"
  const numByDraw = {};
  for (const d of draws) if (d.number != null) numByDraw[String(d.sitewire_draw_id)] = d.number;
  const [f, setF] = useState({ sitewire_draw_id: '', approved: '', fee: '', fee_kind: 'virtual', release_date: '', funded_status: 'released' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pct = retainage ? Number(retainage.pct) || 0 : 0;
  const approvedC = Math.round(Number(f.approved || 0) * 100);
  const feeC = Math.round(Number(f.fee || 0) * 100);
  const retC = Math.round(approvedC * pct / 100);
  const net = approvedC - feeC - retC;
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.post('/api/sitewire/disbursements', {
        application_id: appId, sitewire_draw_id: f.sitewire_draw_id || null,
        approved_cents: approvedC, fee_cents: feeC, fee_kind: f.fee_kind, release_date: f.release_date || null, funded_status: f.funded_status,
      });
      setF({ sitewire_draw_id: '', approved: '', fee: '', fee_kind: 'virtual', release_date: '', funded_status: 'released' });
      onSaved();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not save.'); } finally { setBusy(false); }
  }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row between" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Money ledger</h3>
        <button className="btn btn-sm ghost" onClick={() => api.sitewireExportGl(appId).catch(() => {})}>GL export</button>
      </div>
      <div className="muted small" style={{ margin: '4px 0 8px' }}>Our fee comes off the approved amount{pct > 0 ? `, ${pct}% is held as retainage,` : ''} and the borrower nets the rest.</div>
      {retainage && (retainage.held_cents > 0 || pct > 0) && (
        <div className="row" style={{ gap: 12, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="small">Retainage held: <b>{usd2(retainage.holding_cents)}</b>{retainage.released_cents > 0 ? <span className="muted"> · released {usd2(retainage.released_cents)}</span> : null}</span>
          {retainage.holding_cents > 0 && (
            <button className="btn btn-sm ghost" disabled={parentBusy === 'retrel'}
              onClick={() => act('retrel', async () => { const r = await api.post(`/api/sitewire/files/${appId}/retainage-release`, {}); return { msg: `Retainage released: ${usd2(r.released_cents)}.` }; })}>Release retainage</button>
          )}
        </div>
      )}
      {ledger.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', minWidth: 620 }}>
            <thead><tr><th>Draw</th><th style={{ textAlign: 'right' }}>Approved</th><th style={{ textAlign: 'right' }}>Fee</th><th style={{ textAlign: 'right' }}>Retainage</th><th style={{ textAlign: 'right' }}>Net release</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>
              {ledger.map((d) => (
                <tr key={d.id}>
                  <td>{d.kind === 'retainage_release' ? 'Retainage' : (d.sitewire_draw_id ? 'Draw #' + (numByDraw[String(d.sitewire_draw_id)] ?? d.sitewire_draw_id) : '—')}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.approved_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.fee_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.retainage_held_cents)}</td>
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
        <div className="small" style={{ alignSelf: 'center' }}>{pct > 0 ? <>Retainage: <b>{usd2(retC)}</b> · </> : null}Net: <b>{usd2(net)}</b></div>
        <button className="btn btn-sm primary" disabled={busy || net < 0} onClick={save}>Record release</button>
      </div>
      {err && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function LienWaivers({ appId, enabled, fileOverride, canSetup, waivers, draws, busy, act, onChanged }) {
  // Hidden entirely unless turned on for this project (or globally), or already in use — most
  // projects don't use lien waivers, so this stays out of the workflow until it's opted in.
  // Turning the compliance gate on/off is a setup-level action.
  if (!enabled && waivers.length === 0) {
    return (
      <div className="muted small" style={{ marginTop: 14 }}>
        Lien waivers are off for this project.{canSetup ? ' ' : ' A setup admin can enable them.'}
        {canSetup && (
          <button className="btn btn-sm ghost" disabled={busy === 'lwon'}
            onClick={() => act('lwon', async () => { await api.post(`/api/sitewire/files/${appId}/lien-waivers-setting`, { enabled: true }); return { msg: 'Lien-waiver workflow turned on for this project.' }; })}>
            Enable for this project
          </button>
        )}
      </div>
    );
  }
  return (
    <div>
      {fileOverride === true && canSetup && (
        <div className="muted small" style={{ marginTop: 14, marginBottom: -6 }}>
          Lien waivers are on for this project.{' '}
          <button className="btn btn-sm ghost" disabled={busy === 'lwoff'}
            onClick={() => act('lwoff', async () => { await api.post(`/api/sitewire/files/${appId}/lien-waivers-setting`, { enabled: false }); return { msg: 'Lien-waiver workflow turned off for this project.' }; })}>Turn off</button>
        </div>
      )}
      <WaiversPanel appId={appId} waivers={waivers} draws={draws} onChanged={onChanged} />
    </div>
  );
}

function WaiversPanel({ appId, waivers, draws, onChanged }) {
  const [f, setF] = useState({ sitewire_draw_id: '', tier: 'subcontractor', kind: 'conditional', scope: 'progress', party_name: '', amount: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const STA = { required: { label: 'Outstanding', cls: 'sw-pending' }, received: { label: 'Received', cls: 'sw-approved' }, waived: { label: 'Waived', cls: 'sw-approved' }, na: { label: 'N/A', cls: 'sw-draft' } };
  async function add() {
    setBusy(true); setErr('');
    try {
      await api.post(`/api/sitewire/files/${appId}/waivers`, { sitewire_draw_id: f.sitewire_draw_id || null, tier: f.tier, kind: f.kind, scope: f.scope, party_name: f.party_name || null, amount_cents: Math.round(Number(f.amount || 0) * 100) });
      setF({ sitewire_draw_id: '', tier: 'subcontractor', kind: 'conditional', scope: 'progress', party_name: '', amount: '' }); onChanged();
    } catch (e) { setErr(e?.data?.error || e.message || 'Could not add.'); } finally { setBusy(false); }
  }
  async function setStatus(id, status) { try { await api.patch(`/api/sitewire/waivers/${id}`, { status }); onChanged(); } catch (e) { setErr(e?.data?.error || e.message); } }
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <h3 style={{ marginTop: 0 }}>Lien waivers</h3>
      <div className="muted small" style={{ marginBottom: 8 }}>Track the waivers each draw needs. When the release gate is on, a draw can’t be released until every required waiver is received or waived.</div>
      {waivers.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', minWidth: 620 }}>
            <thead><tr><th>Draw</th><th>Party</th><th>Tier</th><th>Type</th><th style={{ textAlign: 'right' }}>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {waivers.map((w) => {
                const s = STA[w.status] || { label: w.status, cls: '' };
                return (
                  <tr key={w.id}>
                    <td>{w.sitewire_draw_id ? '#' + w.sitewire_draw_id : '—'}</td>
                    <td>{w.party_name || '—'}</td>
                    <td className="muted">{w.tier}</td>
                    <td className="muted small">{w.kind} · {w.scope}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(w.amount_cents)}</td>
                    <td><span className={'pill ' + s.cls}>{s.label}</span></td>
                    <td>
                      {w.status === 'required' && <span className="row" style={{ gap: 4 }}>
                        <button className="btn btn-sm ghost" onClick={() => setStatus(w.id, 'received')}>Received</button>
                        <button className="btn btn-sm ghost" onClick={() => setStatus(w.id, 'waived')}>Waive</button>
                      </span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="small">Draw
          <select className="input" value={f.sitewire_draw_id} onChange={(e) => setF({ ...f, sitewire_draw_id: e.target.value })}>
            <option value="">—</option>{draws.map((d) => <option key={d.sitewire_draw_id} value={d.sitewire_draw_id}>#{d.number}</option>)}
          </select>
        </label>
        <label className="small">Party<input className="input" style={{ width: 130 }} value={f.party_name} onChange={(e) => setF({ ...f, party_name: e.target.value })} /></label>
        <label className="small">Tier<select className="input" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}><option value="gc">GC</option><option value="subcontractor">Sub</option><option value="supplier">Supplier</option></select></label>
        <label className="small">Type<select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="conditional">Conditional</option><option value="unconditional">Unconditional</option></select></label>
        <label className="small">Scope<select className="input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="progress">Progress</option><option value="final">Final</option></select></label>
        <label className="small">Amount $<input className="input" style={{ width: 90 }} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <button className="btn btn-sm primary" disabled={busy} onClick={add}>Add waiver</button>
      </div>
      {err && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function ActivityTrail({ appId }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  useEffect(() => { if (open && rows === null) api.get(`/api/sitewire/files/${appId}/activity`).then((d) => setRows(d.activity || [])).catch(() => setRows([])); }, [open, rows, appId]);
  const KIND = { write: 'Sitewire', draw: 'Draw', money: 'Release', findings: 'Findings', reallocation: 'Budget' };
  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <div className="row between" style={{ alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Draw activity (audit trail)</h3>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm ghost" onClick={() => api.sitewireExportActivity(appId).catch(() => {})}>Export</button>
          <button className="btn btn-sm ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</button>
        </div>
      </div>
      {open && rows === null && <div className="muted small" style={{ marginTop: 8 }}>Loading…</div>}
      {open && rows && rows.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>No activity recorded yet.</div>}
      {open && rows && rows.length > 0 && (
        <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
          {rows.map((a, i) => (
            <div key={i} className="row" style={{ gap: 8, padding: '5px 0', borderTop: i ? '1px solid var(--line,#e6e0d4)' : 'none', alignItems: 'baseline' }}>
              <span className="muted small" style={{ minWidth: 130, fontVariantNumeric: 'tabular-nums' }}>{new Date(a.at).toLocaleString('en-US')}</span>
              <span className="pill sw-draft" style={{ flex: 'none' }}>{KIND[a.kind] || a.kind}</span>
              <span className="small">{a.summary}{a.actor ? <span className="muted"> · {a.actor}</span> : null}</span>
            </div>
          ))}
        </div>
      )}
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
