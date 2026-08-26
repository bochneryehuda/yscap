import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { moneyCents } from '../lib/money.js';
import { useLightbox } from './MediaLightbox.jsx';
import { useReportOpener } from './ReportOpener.jsx';

/* LOAN-OFFICER VIEW-ONLY DRAW VIEW (owner-directed 2026-08-12).
   A loan officer holds `view_draws`, not `manage_draws`, so on their own files they SEE the whole
   draw picture — the construction budget vs. what's released, each draw, the inspector's results,
   notes and photos, and the branded PDF reports — but run NONE of the draw desk: there are no edit
   buttons here. The ONE thing they may DO is act on the BORROWER's behalf on an inspection result —
   accept it (which starts our release clock) or dispute a line — because the officer is often the
   person on the phone with the borrower. Both write through the two `requireDrawView` POSTs
   (mark-accepted / dispute), stamped `*_via='staff'` so it is recorded as staff-on-behalf.

   Every endpoint here is one the loan officer can actually reach (relaxed to `requireDrawView`):
   the file rollup, the per-finding detail, the durable inspection photos, and the report PDFs. The
   coordinator's desk tools (reconcile, approve, release, deliver, reallocate, GL/packet exports,
   investor delivery, lifecycle) are NOT here — those stay `manage_draws`. */

const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
const usd2 = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Staff-voice draw status (the coordinator's stages — the officer sees the same picture the desk does).
const DRAW_STATUS = {
  drafting: { label: 'Being prepared', cls: 'sw-draft' }, pending_borrower: { label: 'With borrower', cls: 'sw-pending' },
  inspecting: { label: 'Inspecting', cls: 'sw-insp' }, pending: { label: 'Needs approval', cls: 'sw-insp' },
  pending_capital_partner: { label: 'With capital partner', cls: 'sw-insp' }, approved: { label: 'Approved & released', cls: 'sw-approved' },
};
const FINDING_BADGE = {
  delivered: { label: 'Awaiting borrower', cls: 'sw-pending' }, accepted: { label: 'Accepted', cls: 'sw-approved' },
  disputed: { label: 'Disputed — under review', cls: 'sw-insp' }, resolved: { label: 'Resolved', cls: 'sw-approved' },
};

/* One inspection photo/video, fetched WITH the bearer token (an <img src> can't carry it) and handed
   the browser an object URL. Mirrors the staff desk's AuthImg — the durable copy in PILOT storage, so
   it never breaks when Sitewire's pre-signed link expires. */
function AuthMedia({ appId, drawId, media, onOpen }) {
  const [src, setSrc] = useState(null);
  const path = `/api/sitewire/files/${appId}/draws/${drawId}/media/${media.id}`;
  useEffect(() => {
    let live = true; let url = null;
    api.authedBlob(path).then((b) => { if (!live) { return; } url = URL.createObjectURL(b); setSrc(url); }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  /* OPENS THE IN-APP VIEWER, not a new browser tab (owner-reported 2026-08-23).
     Navigating a blank tab to a blob URL left the user outside PILOT looking at one
     raw file, with no way back and no next — which is exactly what was reported. */
  if (media.kind === 'video') {
    return <button type="button" className="btn btn-xs ghost" onClick={onOpen} title="Play inspection video" style={{ padding: '3px 7px' }}>▶ video</button>;
  }
  if (!src) return <span style={{ display: 'inline-block', width: 34, height: 34, borderRadius: 6, background: 'var(--line)' }} />;
  return <button type="button" onClick={onOpen} title="Open full size" style={{ padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}>
    <img src={src} alt="Inspection photo" loading="lazy" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', verticalAlign: 'middle' }} />
  </button>;
}

/* Durable inspection photos for one draw's line, grouped by the Sitewire request (draw line) they belong
   to. Prefers PILOT's archived copies (the desk pattern); shows the count when nothing is archived yet. */
function LineMedia({ appId, drawId, line, byReq }) {
  const lb = useLightbox('Draw inspection media');
  const items = (byReq.get(String(line.sitewire_request_id)) || []).filter((m) => m.kind === 'image' || m.kind === 'video').slice(0, 8);
  if (!items.length) return <span className="muted small">{(Number(line.photo_count) || 0) + (Number(line.video_count) || 0) || '—'}</span>;
  const viewerItems = items.map((m) => ({
    id: m.id, kind: m.kind === 'video' ? 'video' : 'image',
    path: `/api/sitewire/files/${appId}/draws/${drawId}/media/${m.id}`,
    title: line.name || line.job_item_name || 'Inspection', meta: 'Saved to PILOT',
  }));
  return (
    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
      {items.map((m, i) => <AuthMedia key={m.id} appId={appId} drawId={drawId} media={m} onOpen={() => lb.open(viewerItems, i)} />)}
      {lb.node}
    </div>
  );
}

/* SUBMIT A DRAW REQUEST — the one thing an officer may START (owner-directed 2026-08-17:
   *"the rule was that the loan officer can only do stuff that a borrower can do"*).

   A borrower can submit a draw request, so an officer can too — they are frequently the
   person on the phone walking the borrower through it. Nothing here approves, releases or
   decides anything: this composes the SAME `portal_draw_requests` row the borrower's own
   screen composes, and it then runs through the coordinator's desk exactly as it always
   has. That is why it sits in the VIEW-ONLY component without contradicting it.

   TWO DESK-ONLY JUDGEMENTS ARE DELIBERATELY ABSENT, and the server refuses them from an
   officer regardless of what this screen sends: going ABOVE a line's remaining budget, and
   opening a second draw while one is already running. A borrower could make neither call.

   "Remaining" is whatever the server says (`lines[].remaining_cents`) — never computed
   here. It already nets off money approved on a physical draw that has not reached
   Sitewire's ledger yet, which is precisely the money a second screen doing its own
   arithmetic would offer twice. */
function LoRequestDraw({ appId, onSubmitted }) {
  const [st, setSt] = useState(null);
  const [lines, setLines] = useState([]);
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api.get(`/api/sitewire/files/${appId}/portal-draws`)
      .then((r) => { setSt((r && r.state) || null); setLines(Array.isArray(r && r.lines) ? r.lines : []); })
      .catch(() => { setSt(null); setLines([]); });
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (!st || !st.physical) return null;          // virtual files submit in the construction portal

  const cents = (v) => {
    const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  };
  const total = lines.reduce((s, l) => s + cents(amt[l.sitewire_job_item_id]), 0);
  // Mirrors the server's own refusal so the officer is told BEFORE they submit, not after.
  const over = lines.filter((l) => cents(amt[l.sitewire_job_item_id]) > Number(l.remaining_cents || 0));

  const submit = async () => {
    const entries = lines
      .map((l) => ({ sitewire_job_item_id: l.sitewire_job_item_id, requested_cents: cents(amt[l.sitewire_job_item_id]) }))
      .filter((e) => e.requested_cents > 0);
    if (!entries.length) { setMsg('Enter an amount on at least one line.'); return; }
    setBusy(true); setMsg('');
    try {
      await api.post(`/api/sitewire/files/${appId}/portal-draws`, { entries });
      setOpen(false); setAmt({}); setMsg('Draw request submitted — the draw coordinator takes it from here.');
      load(); if (onSubmitted) onSubmitted();
    } catch (e) {
      setMsg(e?.data?.error || e.message || 'Could not submit the request.');
    } finally { setBusy(false); }
  };

  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="dd-card-h">
        <div className="dd-card-t"><h3>Request a draw</h3></div>
        {st.open_portal_request && <span className="pill sw-pending">Request in flight</span>}
      </div>
      <div className="dd-sub" style={{ marginTop: -2, color: '#4B585C' }}>
        You can submit a draw request on the borrower’s behalf. The draw coordinator reviews it,
        orders the inspection and decides what is released — this only starts it.
      </div>
      {msg && <div className="small" style={{ marginTop: 8, fontWeight: 600, color: '#141B22' }}>{msg}</div>}

      {st.open_portal_request ? (
        <div className="muted small" style={{ marginTop: 8 }}>
          A draw request is already open on this file. The next one can be submitted once it is finished.
        </div>
      ) : st.parked ? (
        /* THE COMPOSER IS PARKED (owner-directed 2026-08-26, compliance): draw
           requests come in through Sitewire only — the note says why instead of
           a dead button (the parked.js house pattern). Requests in flight keep
           moving above. */
        <div className="dd-note warn" style={{ marginTop: 10 }}>
          {st.parked_reason || 'Draw requests are submitted through Sitewire for now — the composer here is parked (compliance).'}
        </div>
      ) : !open ? (
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-sm primary" disabled={!st.eligible} onClick={() => { setMsg(''); setOpen(true); }}>
            Request a draw
          </button>
          {!st.funded && <span className="small muted">Available once the loan is funded.</span>}
          {st.funded && !st.set_up && <span className="small muted">The draw setup (budget lines) hasn’t finished yet.</span>}
          {st.funded && st.set_up && st.open_sitewire_draw && <span className="small muted">A draw is already open in the construction system.</span>}
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div className="dd-tablecard" style={{ overflowX: 'auto', boxShadow: 'none' }}>
            <table className="dd-table" style={{ minWidth: 520 }}>
              <thead><tr><th>Budget line</th><th className="num">Still available</th><th className="num" style={{ width: 140 }}>Request ($)</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.sitewire_job_item_id}>
                    <td style={{ fontWeight: 600 }}>{l.name}</td>
                    <td className="num">{usd2(l.remaining_cents)}</td>
                    <td className="num">
                      <input className="input" style={{ width: 120 }} inputMode="decimal" placeholder="0.00"
                        value={amt[l.sitewire_job_item_id] ?? ''}
                        onChange={(e) => setAmt((s) => ({ ...s, [l.sitewire_job_item_id]: e.target.value }))} />
                    </td>
                  </tr>
                ))}
                {lines.length === 0 && <tr><td colSpan={3} className="muted small">No budget lines are set up yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <b style={{ color: '#141B22' }}>Total requested: {usd2(total)}</b>
            <button className="btn btn-sm primary" disabled={busy || total <= 0 || over.length > 0} onClick={submit}>
              {busy ? 'Submitting…' : 'Submit the request'}
            </button>
            <button className="btn btn-sm ghost" disabled={busy} onClick={() => { setOpen(false); setMsg(''); }}>Cancel</button>
          </div>
          {over.length > 0 && (
            <div className="small" style={{ marginTop: 6, color: '#B04A3F', fontWeight: 600 }}>
              {over.map((l) => l.name).join(', ')} {over.length === 1 ? 'is' : 'are'} over what is still available on
              {over.length === 1 ? ' that line' : ' those lines'}. Only the draw coordinator can request above a line’s
              remaining budget — lower the amount, or ask the desk to submit it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LoDrawView({ appId }) {
  const openReport = useReportOpener();   // opens the PDF in PILOT, with progress
  const [rollup, setRollup] = useState(null);
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api.get(`/api/sitewire/files/${appId}/rollup`)
      .then((r) => {
        setRollup(r && r.rollup ? r.rollup : null);
        setFindings(Array.isArray(r && r.findings) ? r.findings : []);
      })
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load the draws.'))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="dd-card">Loading draws…</div>;
  if (err) return <div className="dd-card" style={{ color: 'var(--danger)' }}>{err}</div>;

  const proj = rollup && rollup.project ? rollup.project : null;
  const hasProject = !!(proj && proj.budget > 0);
  if (!hasProject && findings.length === 0) {
    // The composer belongs HERE too, and this is the case it matters most in: a funded
    // file whose budget is set up but which has never drawn is exactly when somebody asks
    // for the FIRST draw. Returning only "no draws yet" would hide the button on the one
    // file that needs it. It self-hides when the file is not on physical inspections.
    return <>
      <div className="dd-card" style={{ textAlign: 'center', padding: '28px 20px' }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600, color: '#141B22' }}>No draws yet</div>
        <div className="dd-sub" style={{ marginTop: 4 }}>The draw dashboard appears here once this file's first draw is set up.</div>
      </div>
      <LoRequestDraw appId={appId} onSubmitted={load} />
    </>;
  }
  const pct = proj ? Math.max(0, Math.min(100, Number(proj.pct_complete) || 0)) : 0;
  const lineRows = (rollup && Array.isArray(rollup.lines) ? rollup.lines : []).filter((l) => l.kind === 'line');
  const draws = rollup && Array.isArray(rollup.draws) ? rollup.draws : [];
  const drawMoney = new Map(draws.map((d) => [String(d.sitewire_draw_id), d]));

  return (
    <div className="dd-wrap">
      {openReport.node}
      {/* VIEW-ONLY notice — the officer sees everything and runs nothing, except acting for the borrower. */}
      <div className="notice" role="note" style={{ background: 'var(--paper,#f6f3ec)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }}>
        <b style={{ color: '#141B22' }}>View-only draw access.</b>
        <span className="small" style={{ color: '#4B585C' }}> You can see every draw, the inspector’s results, notes, photos and the report PDFs. The actions here are the ones on the borrower’s behalf: submitting a draw request, and accepting or disputing an inspection result. The draw desk itself — approving, releasing and ordering — is run by the draw coordinator.</span>
      </div>

      <LoRequestDraw appId={appId} onSubmitted={load} />

      {hasProject && (
        <div className="dd-hero" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <div className="dd-hero-label">Construction budget</div>
            <div className="dd-hero-value">{usd(proj.budget)}</div>
            <div className="dd-hero-meter-top" style={{ marginTop: 16 }}>
              <span className="dd-hero-label">Released so far</span>
              <span className="dd-hero-pct">{pct}%</span>
            </div>
            <div className="dd-meter"><i style={{ width: pct + '%' }} /></div>
            <div className="dd-hero-legend">
              <div className="dd-leg"><span className="dd-leg-k"><span className="sw" style={{ background: 'var(--teal)' }} />Released so far</span><span className="dd-leg-v">{usd(proj.drawn)}</span></div>
              <div className="dd-leg"><span className="dd-leg-k"><span className="sw" style={{ background: 'var(--ink-3)' }} />Remaining</span><span className="dd-leg-v">{usd(proj.remaining)}</span></div>
            </div>
          </div>
        </div>
      )}

      {lineRows.length > 0 && (
        <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
          <table className="dd-table" style={{ minWidth: 460 }}>
            <thead><tr><th>Line item</th><th className="num">Budget</th><th className="num">Released</th><th className="num">Remaining</th></tr></thead>
            <tbody>
              {lineRows.map((l) => (
                <tr key={l.sow_line_key}>
                  <td style={{ fontWeight: 600 }}>{l.label}</td>
                  <td className="num">{usd(l.budgeted)}</td>
                  <td className="num">{usd(l.drawn)}</td>
                  <td className="num">{usd(l.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draws.length > 0 && (
        <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
          <table className="dd-table" style={{ minWidth: 560 }}>
            <thead><tr><th>Draw</th><th>Status</th><th className="num">Requested</th><th className="num">Approved</th><th className="num">Net release</th></tr></thead>
            <tbody>
              {draws.map((d) => {
                const s = DRAW_STATUS[d.status] || { label: d.status || 'In progress', cls: 'sw-insp' };
                return (
                  <tr key={d.sitewire_draw_id}>
                    <td style={{ fontWeight: 600 }}>#{d.number ?? '—'}</td>
                    <td><span className={'pill ' + (d.is_funded ? 'sw-approved' : s.cls)}>{s.label}</span></td>
                    <td className="num">{usd2(d.requested_cents)}</td>
                    <td className="num">{usd2(d.approved_cents)}</td>
                    <td className="num" style={{ fontWeight: 700 }}>{d.net_release_cents == null ? '—' : usd2(d.net_release_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Whole-project inspection report (PDF) — every draw in one branded document. */}
      {findings.length > 0 && (
        <div className="act-card">
          <div className="act-card-head">
            <div style={{ minWidth: 220, flex: 1 }}>
              <div className="act-card-title">Full inspection report</div>
              <div className="act-card-sub">Every draw, what was approved, the inspector’s notes and photos — one PDF.</div>
            </div>
            <button className="btn btn-sm ghost" disabled={openReport.busy}
              onClick={() => openReport.start({
                title: 'Whole-project inspection report',
                subtitle: 'Every draw, the schedule of values, inspector notes and photos.',
                status: () => api.sitewireProjectReportStatus(appId, 'staff'),
                fetch: (onP) => api.sitewireProjectReportBytes(appId, 'staff', onP),
              })}>Open PDF</button>
          </div>
        </div>
      )}

      {findings.map((f) => (
        <LoFindingCard key={f.id} appId={appId} finding={f} money={drawMoney.get(String(f.sitewire_draw_id)) || null} onChanged={load} />
      ))}
    </div>
  );
}

/* One inspection result — read-only line detail (requested / approved / inspector note / photos), the
   per-draw report PDF, and the two borrower-behalf actions. The officer confirms it is on the borrower's
   behalf with a required note; the server records it as staff-on-behalf. */
function LoFindingCard({ appId, finding, money, onChanged }) {
  const openReport = useReportOpener();   // opens the PDF in PILOT, with progress
  const [detail, setDetail] = useState(null);       // { finding, lines }
  const [mediaByReq, setMediaByReq] = useState(new Map());
  const [mode, setMode] = useState(null);           // null | 'accept' | 'dispute'
  const [note, setNote] = useState('');             // accept-on-behalf note
  const [disp, setDisp] = useState({});             // lineId -> { desired, note }
  const [dnote, setDnote] = useState('');           // dispute-on-behalf note
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const drawId = finding.sitewire_draw_id;
  // The rollup's summary finding carries no draw `number` or `released` flag — the per-draw money
  // object (from rollup.draws) does, so read them there.
  const drawNumber = money && money.number != null ? money.number : (finding.number ?? drawId);
  const released = !!(money && money.released);
  const badge = FINDING_BADGE[finding.status] || { label: finding.status, cls: 'sw-insp' };
  const canAct = finding.status === 'delivered';

  useEffect(() => {
    let live = true;
    api.get(`/api/sitewire/findings/${finding.id}`).then((d) => { if (live) setDetail(d); }).catch(() => {});
    api.get(`/api/sitewire/files/${appId}/draws/${drawId}/archived-media`).then((r) => {
      if (!live) return;
      const m = new Map();
      for (const row of (Array.isArray(r && r.media) ? r.media : [])) { const k = String(row.sitewire_request_id); if (!m.has(k)) m.set(k, []); m.get(k).push(row); }
      setMediaByReq(m);
    }).catch(() => {});
    return () => { live = false; };
  }, [appId, finding.id, drawId, finding.status]);

  const lines = detail && Array.isArray(detail.lines) ? detail.lines : [];

  async function accept() {
    if (note.trim().length < 8) { setErr('Add a short note confirming the borrower agreed (at least a few words).'); return; }
    setBusy(true); setErr('');
    try { await api.post(`/api/sitewire/files/${appId}/findings/${finding.id}/mark-accepted`, { note: note.trim() }); setMode(null); setNote(''); onChanged(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not accept.'); } finally { setBusy(false); }
  }
  async function submitDispute() {
    if (dnote.trim().length < 8) { setErr('Add a short note explaining the dispute on the borrower’s behalf.'); return; }
    const dl = Object.entries(disp).filter(([, v]) => v && (v.desired !== '' || v.note))
      .map(([line_id, v]) => ({ line_id: Number(line_id), desired_cents: moneyCents(v.desired), note: v.note || '' }));
    if (!dl.length) { setErr('Enter the amount or a reason on at least one line you’re disputing.'); return; }
    setBusy(true); setErr('');
    try { await api.post(`/api/sitewire/files/${appId}/findings/${finding.id}/dispute`, { note: dnote.trim(), lines: dl }); setMode(null); setDisp({}); setDnote(''); onChanged(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not submit the dispute.'); } finally { setBusy(false); }
  }

  return (
    <div className="dd-card">
      {openReport.node}
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16 }}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg></span>
          <h3>Draw #{drawNumber} — inspection results</h3>
        </div>
        <span className={'pill ' + badge.cls}>{badge.label}</span>
      </div>
      <div className="dd-sub" style={{ marginTop: -2, color: '#4B585C' }}>
        The inspector approved {usd2(finding.total_approved_cents)} of {usd2(finding.total_requested_cents)} requested.
        {finding.status === 'accepted' && !released && finding.wire_due_at ? ` Release expected by ${new Date(finding.wire_due_at).toLocaleDateString('en-US')}.` : ''}
        {released ? ' Funds released.' : ''}
        {money && money.net_release_cents != null ? ` Net release: ${usd2(money.net_release_cents)}.` : ''}
      </div>

      <div className="dd-tablecard" style={{ overflowX: 'auto', marginTop: 12, boxShadow: 'none' }}>
        <table className="dd-table" style={{ minWidth: 560 }}>
          <thead><tr><th>Item</th><th className="num">Requested</th><th className="num">Approved</th><th>Inspector note</th><th>Photos</th>{mode === 'dispute' && <th>On borrower’s behalf</th>}</tr></thead>
          <tbody>
            {lines.length === 0 && !detail && <tr><td colSpan={mode === 'dispute' ? 6 : 5} className="muted small">Loading line detail…</td></tr>}
            {lines.map((l) => (
              <tr key={l.id}>
                <td style={{ fontWeight: 600 }}>{l.name}</td>
                <td className="num">{usd2(l.requested_cents)}</td>
                <td className="num">{l.approved_cents == null
                  ? <span className="muted small">Not reviewed yet</span>
                  : <>{usd2(l.approved_cents)}{l.not_approved_cents > 0 ? <span className="muted small"> (−{usd2(l.not_approved_cents)})</span> : null}</>}</td>
                <td className="muted small">{l.inspector_comments || '—'}</td>
                <td><LineMedia appId={appId} drawId={drawId} line={l} byReq={mediaByReq} /></td>
                {mode === 'dispute' && (
                  <td>
                    <input className="input" style={{ width: 100 }} inputMode="decimal" placeholder="$ expected" value={(disp[l.id] || {}).desired ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), desired: e.target.value } }))} />
                    <input className="input" style={{ width: 160, marginTop: 4 }} placeholder="why (optional)" value={(disp[l.id] || {}).note ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), note: e.target.value } }))} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ACCEPT on the borrower's behalf — a required note recording the borrower agreed. */}
      {mode === 'accept' && (
        <div style={{ marginTop: 10 }}>
          <label className="small" style={{ fontWeight: 700, display: 'block', marginBottom: 4, color: '#141B22' }}>Confirm the borrower agreed</label>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
            placeholder="e.g. Spoke with the borrower by phone 8/12 — they accept the inspection results." style={{ width: '100%' }} />
        </div>
      )}
      {/* DISPUTE on the borrower's behalf — the amount/reason per line above, plus a required overall note. */}
      {mode === 'dispute' && (
        <div style={{ marginTop: 10 }}>
          <label className="small" style={{ fontWeight: 700, display: 'block', marginBottom: 4, color: '#141B22' }}>Dispute note (on the borrower’s behalf)</label>
          <textarea className="input" rows={2} value={dnote} onChange={(e) => setDnote(e.target.value)} maxLength={500}
            placeholder="e.g. Borrower disputes the roof line — work was completed, photos attached in Sitewire." style={{ width: '100%' }} />
        </div>
      )}

      {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 8, fontWeight: 600 }}>{err}</div>}

      <div className="act-bar">
        {canAct && mode === null && <button className="btn btn-sm primary" disabled={busy} onClick={() => { setErr(''); setMode('accept'); }}>Accept on borrower’s behalf</button>}
        {canAct && mode === null && <button className="btn btn-sm ghost" onClick={() => { setErr(''); setMode('dispute'); }}>Dispute on borrower’s behalf</button>}
        {mode === 'accept' && <button className="btn btn-sm primary" disabled={busy} onClick={accept}>{busy ? 'Saving…' : 'Confirm accept'}</button>}
        {mode === 'accept' && <button className="btn btn-sm ghost" disabled={busy} onClick={() => { setMode(null); setErr(''); }}>Cancel</button>}
        {mode === 'dispute' && <button className="btn btn-sm primary" disabled={busy} onClick={submitDispute}>{busy ? 'Saving…' : 'Submit dispute'}</button>}
        {mode === 'dispute' && <button className="btn btn-sm ghost" disabled={busy} onClick={() => { setMode(null); setErr(''); }}>Cancel</button>}
        {mode === null && (<>
          {canAct && <span className="act-sep" aria-hidden="true" />}
          <button className="btn btn-sm soft" disabled={openReport.busy}
            title="A PILOT-branded PDF for this draw — schedule of values, approved vs not-approved, inspector notes and photos."
            onClick={() => openReport.start({
              title: 'Draw inspection report',
              subtitle: 'Schedule of values, approved vs not approved, inspector notes and photos.',
              status: () => api.sitewireDrawReportStatus(appId, drawId, 'staff'),
              fetch: (onP) => api.sitewireDrawReportBytes(appId, drawId, 'staff', onP),
            })}>
            Open report (PDF)
          </button>
        </>)}
      </div>
    </div>
  );
}
