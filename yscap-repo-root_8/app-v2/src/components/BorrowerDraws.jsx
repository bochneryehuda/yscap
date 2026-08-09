import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { moneyCents } from '../lib/money.js';

/* Borrower draw view. You submit draws and upload photos in Sitewire; here you see the
   live picture of your construction budget vs. what's been released, and you review each
   inspection result — accepting it (which starts our release clock) or disputing a line
   with your own note and the amount you believe is right. No capital-partner names appear. */

const usd = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US');
const usd2 = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Read chosen files into the upload contract {filename, contentType, dataBase64} + keep a local
// `preview` data-URL so the borrower sees a thumbnail immediately (no server round-trip).
function filesToBase64(fileList) {
  return Promise.all(Array.from(fileList || []).slice(0, 8).map((f) => new Promise((res) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); res({ filename: f.name, contentType: f.type || 'image/jpeg', dataBase64: s.split(',')[1] || '', preview: s }); };
    r.onerror = () => res(null);
    r.readAsDataURL(f);
  })));
}
// Borrower-friendly draw status (no capital-partner detail).
const DRAW_STATUS = {
  drafting: { label: 'Being prepared', cls: 'sw-draft' }, pending_borrower: { label: 'Waiting on you', cls: 'sw-pending' },
  inspecting: { label: 'Inspection under way', cls: 'sw-insp' }, pending: { label: 'Under review', cls: 'sw-insp' },
  pending_capital_partner: { label: 'Final review', cls: 'sw-insp' }, approved: { label: 'Approved & released', cls: 'sw-approved' },
};

/* WHAT HAPPENS NEXT, AND WHEN — the one line a borrower actually wants (owner-directed
   2026-08-09). It shows the SOONEST thing still ahead, and nothing at all when there is nothing to
   promise: a date with no start to count from would be a guess, and a guess in front of somebody
   waiting on their money is worse than saying nothing. The booked inspection visit leads when
   there is one — it has been mirrored for months and simply never shown to the person standing at
   the property. */
function NextUp({ d }) {
  if (!d) return <span className="dd-sub">—</span>;
  const fmt = (iso) => { try { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (_) { return iso; } };
  if (d.visit_scheduled_at) {
    const day = String(new Date(d.visit_scheduled_at).toISOString()).slice(0, 10);
    return <span>Inspection visit <b>{fmt(day)}</b></span>;
  }
  for (const [label, v] of [['Inspection', d.inspection], ['Decision', d.decision], ['Funds', d.release]]) {
    if (v && v.date && !v.actual) {
      return <span>{label} <b>{fmt(v.date)}</b>{v.late ? <span className="dd-sub"> (running late — we’re on it)</span> : ''}</span>;
    }
  }
  return <span className="dd-sub">—</span>;
}

export default function BorrowerDraws({ appId }) {
  const [rollup, setRollup] = useState(null);
  const [findings, setFindings] = useState([]);
  const [eligibility, setEligibility] = useState(null);
  const [loading, setLoading] = useState(true);
  const [has, setHas] = useState(true);
  // WHAT HAPPENS NEXT, AND WHEN (owner-directed 2026-08-09) — keyed by draw. Only the three dates
  // and the booked visit; never the internal checklist, which names our own work.
  const [dates, setDates] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get(`/api/borrower/draws/${appId}/rollup`).catch(() => null),
      api.get(`/api/borrower/draws/${appId}/findings`).catch(() => ({ findings: [] })),
      api.get(`/api/borrower/draws/${appId}/eligibility`).catch(() => null),
    ]).then(([r, f, e]) => {
      setRollup(r && r.rollup ? r.rollup : null);
      setDates((r && r.dates) || {});
      setFindings((f && f.findings) || []);
      setEligibility(e || null);
      setHas(!!(r && r.rollup && r.rollup.project && r.rollup.project.budget > 0));
    }).finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="dd-card">Loading your draws…</div>;
  if (!has && findings.length === 0) return <div className="dd-card" style={{ textAlign: 'center', padding: '28px 20px' }}><div style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 600 }}>No draws yet</div><div className="dd-sub" style={{ marginTop: 4 }}>Your draw dashboard will appear here once your first draw is set up.</div></div>;

  const proj = rollup && rollup.project ? rollup.project : null;
  const pct = proj ? Math.max(0, Math.min(100, Number(proj.pct_complete) || 0)) : 0;
  // The per-draw money, keyed by draw, so a result card can show what actually reaches the
  // borrower. Read from the rollup — the SAME source their downloadable report is built from.
  const drawMoney = new Map(((rollup && rollup.draws) || []).map((d) => [String(d.sitewire_draw_id), d]));

  return (
    <div className="dd-wrap">
      {proj && proj.budget > 0 && (
        <div className="dd-hero" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <div className="dd-hero-label">Your construction budget</div>
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

      {rollup && rollup.lines && rollup.lines.filter((l) => l.kind === 'line').length > 0 && (
        <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
          <table className="dd-table" style={{ minWidth: 460 }}>
            <thead><tr><th>Line item</th><th className="num">Budget</th><th className="num">Released</th><th className="num">Remaining</th></tr></thead>
            <tbody>
              {rollup.lines.filter((l) => l.kind === 'line').map((l) => (
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

      {rollup && Array.isArray(rollup.draws) && rollup.draws.length > 0 && (
        <div className="dd-tablecard" style={{ overflowX: 'auto' }}>
          <table className="dd-table" style={{ minWidth: 520 }}>
            {/* WHAT YOU RECEIVE (owner-directed 2026-08-03) — the approved figure is what the
                inspector signed off; this is the money that actually reaches the borrower, after
                the draw fee. It comes straight off the rollup, the same source their PDF report is
                built from, so the two can never quote different numbers. */}
            <thead><tr><th>Draw</th><th>Status</th><th>What’s next</th><th className="num">Requested</th><th className="num">Approved</th><th className="num">You receive</th></tr></thead>
            <tbody>
              {rollup.draws.map((d) => {
                const s = DRAW_STATUS[d.status] || { label: d.status, cls: 'sw-insp' };
                return (
                  <tr key={d.sitewire_draw_id}>
                    <td style={{ fontWeight: 600 }}>#{d.number ?? '—'}</td>
                    <td><span className={'pill ' + (d.is_funded ? 'sw-approved' : s.cls)}>{s.label}</span></td>
                    <td><NextUp d={dates[d.sitewire_draw_id]} /></td>
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

      {/* Documents turn up after a request is in — an invoice arrives, the contractor sends a
          photo — so attaching is not only possible at the moment of submitting. */}
      {rollup && Array.isArray(rollup.draws) && rollup.draws.length > 0 && (
        <AttachToDraw appId={appId} draws={rollup.draws} onChanged={load} />
      )}

      {/* whole-project inspection report (PDF) — all draws in one branded, borrower-safe document */}
      {findings.length > 0 && <ProjectReportButton appId={appId} />}

      {/* Eligibility preview + the in-PILOT composer (physical files) or the Sitewire hand-off */}
      {eligibility && <EligibilityCard e={eligibility} appId={appId} onChanged={load} />}

      {findings.map((f) => (
        <FindingCard key={f.id} finding={f} appId={appId} onChanged={load}
          money={drawMoney.get(String(f.sitewire_draw_id)) || null} />
      ))}
    </div>
  );
}

/* ADD A DOCUMENT TO A DRAW ALREADY IN FLIGHT (owner-directed 2026-08-09). The composer takes files
   WITH a request; this covers the invoice that arrives two days later. Same upload contract, same
   server door, and the same rule at the other end: a borrower's upload is NOT born accepted, so
   nothing they add here travels to an investor until somebody reviews it. */
function AttachToDraw({ appId, draws, onChanged }) {
  const [drawId, setDrawId] = useState(String(draws[0] && draws[0].sitewire_draw_id) || '');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState('');

  async function send() {
    if (busy || !files.length || !drawId) return;
    setBusy(true); setErr(''); setDone('');
    try {
      const r = await api.post(`/api/borrower/draws/${appId}/attachments`, {
        sitewire_draw_id: drawId,
        files: files.map(({ filename, contentType, dataBase64 }) => ({ filename, contentType, dataBase64 })),
      });
      const skipped = Array.isArray(r && r.skipped) ? r.skipped : [];
      // Never claim more than actually landed, and always name what did not.
      setDone(`Added ${r.added ? r.added.length : 0} document${(r.added && r.added.length) === 1 ? '' : 's'} to your draw.`
        + (skipped.length ? ` ${skipped.length} could not be added — ${skipped.map((s) => `${s.what}: ${s.reason}`).join('; ')}.` : ''));
      setFiles([]);
      onChanged && onChanged();
    } catch (e) { setErr(e?.data?.error || e.message || 'That didn’t work — please try again.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="small" style={{ fontWeight: 700 }}>Add a document to a draw</div>
      <div className="small" style={{ color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
        An invoice, a receipt or a progress photo for a draw you’ve already requested. Your team sees it on that draw.
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
        <select className="input" value={drawId} disabled={busy} onChange={(e) => setDrawId(e.target.value)} style={{ maxWidth: 180 }}>
          {draws.map((d) => (
            <option key={d.sitewire_draw_id} value={String(d.sitewire_draw_id)}>Draw {d.number ?? '—'}</option>
          ))}
        </select>
        <input type="file" multiple accept="image/*,application/pdf" disabled={busy}
          onChange={async (e) => { setFiles((await filesToBase64(e.target.files)).filter(Boolean)); e.target.value = ''; }} />
        <button className="btn btn-sm primary" disabled={busy || !files.length} onClick={send}>
          {busy ? 'Adding…' : `Add ${files.length || ''} document${files.length === 1 ? '' : 's'}`.trim()}
        </button>
      </div>
      {files.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {files.map((f, i) => (
            <span key={i} className="pill sw-draft" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 220 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</span>
              <button type="button" className="btn link" style={{ padding: 0, minHeight: 0, fontSize: 13 }} disabled={busy}
                aria-label={`Remove ${f.filename}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {err && <div className="small" style={{ marginTop: 6, color: 'var(--danger, #b3261e)' }}>{err}</div>}
      {done && <div className="small" style={{ marginTop: 6, color: 'var(--text-muted)' }}>{done}</div>}
    </div>
  );
}

// A short, shift-free date ("Aug 1") for a draw step — parses a date-only value in local time so it
// never slips a day, and shows nothing for a step that hasn't happened yet.
const fmtStepDay = (v) => {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/* The borrower's draw lifecycle at a glance — plain-language steps from inspection to money in hand,
   each carrying the date it was reached (owner-directed: a timestamp on every step). Driven only by
   borrower-safe finding state (status + timestamps + a released flag), no capital-partner detail. */
function DrawStepper({ finding, releasedAt }) {
  const st = finding.status;
  const disputed = st === 'disputed';
  const accepted = st === 'accepted' || st === 'resolved';
  const released = !!finding.released;
  const steps = [
    { key: 'inspected', label: 'Inspected', done: true, at: null },
    { key: 'results', label: 'Results ready', done: true, at: finding.delivered_at },
    { key: 'review', label: disputed ? 'Under review' : 'You accept', done: accepted, active: st === 'delivered', warn: disputed, at: disputed ? finding.disputed_at : (finding.accepted_at || finding.resolved_at) },
    { key: 'released', label: 'Funds released', done: released, active: accepted && !released, at: released ? releasedAt : null },
  ];
  return (
    <div className="row" style={{ gap: 0, alignItems: 'flex-start', margin: '4px 0 14px', flexWrap: 'nowrap', overflowX: 'auto' }}>
      {steps.map((s, i) => {
        const color = s.warn ? 'var(--warning, #b8860b)' : s.done ? 'var(--teal)' : s.active ? 'var(--gold, #ae8746)' : 'var(--ink-3, #c9cdd0)';
        const day = s.done ? fmtStepDay(s.at) : '';
        return (
          <React.Fragment key={s.key}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 66, flex: '0 0 auto' }}>
              <span style={{ width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', background: (s.done || s.active || s.warn) ? color : 'transparent', border: `2px solid ${color}`, color: (s.done || s.active || s.warn) ? '#fff' : color, fontSize: 12, fontWeight: 800 }}>
                {s.done ? '✓' : (s.warn ? '!' : i + 1)}
              </span>
              <span className="small" style={{ marginTop: 5, textAlign: 'center', color: (s.done || s.active || s.warn) ? 'var(--text)' : 'var(--text-muted)', fontWeight: (s.active || s.warn) ? 700 : 500, lineHeight: 1.15 }}>{s.label}</span>
              {day && <span style={{ marginTop: 2, fontSize: 11, textAlign: 'center', color: 'var(--text-muted)', lineHeight: 1.1 }}>{day}</span>}
            </div>
            {i < steps.length - 1 && <span style={{ flex: '1 1 18px', minWidth: 18, height: 2, background: steps[i + 1].done || steps[i].done ? 'var(--teal)' : 'var(--line)', marginTop: 10 }} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* "Can I request another draw?" — an honest, guided preview: how much budget is left, whether anything is
   holding a new draw, and the steps to submit one in Sitewire (where borrowers submit + photograph draws).
   On a physical-inspection file the borrower can ALSO compose the draw line-by-line right here (e.composer). */
function EligibilityCard({ e, appId, onChanged }) {
  const eligible = !!e.eligible;
  const url = e.sitewire_portal_url || 'https://app.sitewire.co';
  const composer = e.composer || null;
  const openReq = composer && composer.open_request;
  const OPEN_REQ_LABEL = {
    submitted: 'Received — being set up for inspection',
    entered: 'In review with the inspection team',
    approved: 'Approved — your release is being processed',
  };
  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic" style={{ background: eligible ? 'var(--teal-soft, #e6f0f0)' : 'var(--warning-soft)', color: eligible ? 'var(--teal)' : 'var(--warning, #b8860b)' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16 }}>{eligible ? <path d="M20 6L9 17l-5-5" /> : <><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>}</svg>
          </span>
          <div>
            <h3>Request another draw</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>{usd(e.remaining_cents)} of your budget is still available to draw.</div>
          </div>
        </div>
      </div>

      {/* One bullet style, two tones (owner-directed 2026-08-03) — these were two copies of the
          same hand-drawn dot built from inline styles. */}
      {e.blocking && e.blocking.length > 0 && (
        <div className="dd-notes">
          {e.blocking.map((b, i) => <div key={i} className="dd-note warn">{b}</div>)}
        </div>
      )}
      {e.next_steps && e.next_steps.length > 0 && (
        <div className="dd-notes">
          {e.next_steps.map((s, i) => <div key={i} className="dd-note next">{s}</div>)}
        </div>
      )}

      {/* an in-flight portal request: plain status, no second submission */}
      {openReq && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="pill sw-insp">Draw request in progress</span>
            <span className="small" style={{ fontWeight: 600 }}>{usd(openReq.total_requested_cents)}</span>
            <span className="small muted">{OPEN_REQ_LABEL[openReq.status] || 'In progress'}</span>
          </div>
        </div>
      )}

      {/* physical-inspection files: compose the draw right here, line by line */}
      {eligible && composer && composer.can_compose && !openReq && (
        <BorrowerComposer appId={appId} composer={composer} onChanged={onChanged} sitewireUrl={url} />
      )}

      {/* everyone else (and as the photo-friendly alternative): submit in Sitewire */}
      {eligible && !(composer && composer.can_compose && !openReq) && !openReq && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>How to submit your next draw</div>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <li>Open Sitewire (below) — that’s where you submit draws and upload progress photos.</li>
            <li>Choose the line items you’ve completed and enter the amount for each.</li>
            <li>Add clear photos of the finished work — they speed up your inspection.</li>
            <li>Submit. An inspection is scheduled, and your results appear right here for you to accept.</li>
          </ol>
          <a className="btn btn-sm primary" href={url} target="_blank" rel="noreferrer" style={{ marginTop: 12, display: 'inline-block' }}>Open Sitewire to submit a draw ↗</a>
        </div>
      )}
    </div>
  );
}

/* The in-PILOT line-item draw composer (physical-inspection files). Pick the lines you've
   finished, enter an amount for each (up to what's remaining), and submit — your team takes
   it from there and the site inspection is arranged. Server-validated; borrower-safe. */
function BorrowerComposer({ appId, composer, onChanged, sitewireUrl }) {
  const [open, setOpen] = useState(false);
  const [amounts, setAmounts] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Invoices, receipts and progress photos sent WITH the request (owner-directed 2026-08-09) — the
  // borrower could previously only attach evidence when DISPUTING a result, which is the one moment
  // it is already too late to help.
  const [files, setFiles] = useState([]);
  const [note2, setNote2] = useState('');   // what did not attach, in their words
  const lines = Array.isArray(composer.lines) ? composer.lines : [];
  const cents = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
  const totalCents = lines.reduce((s, l) => s + cents(amounts[l.sitewire_job_item_id]), 0);
  const overLine = lines.find((l) => cents(amounts[l.sitewire_job_item_id]) > Number(l.remaining_cents || 0));
  async function submit() {
    if (busy) return;
    setBusy(true); setErr(''); setNote2('');
    try {
      const entries = lines
        .map((l) => ({ sitewire_job_item_id: l.sitewire_job_item_id, requested_cents: cents(amounts[l.sitewire_job_item_id]) }))
        .filter((x) => x.requested_cents > 0);
      const body = { entries };
      if (note.trim()) body.note = note.trim();
      // The local `preview` data-URL is for the thumbnail only and never goes to the server — the
      // upload contract is {filename, contentType, dataBase64}.
      if (files.length) body.attachments = files.map(({ filename, contentType, dataBase64 }) => ({ filename, contentType, dataBase64 }));
      const r = await api.post(`/api/borrower/draws/${appId}/request`, body);
      // The request is created BEFORE the files are stored, so a file that would not store never
      // fails the draw — but it must never fail SILENTLY either. Say which one, and why.
      const skipped = Array.isArray(r && r.attachments_skipped) ? r.attachments_skipped : [];
      if (skipped.length) {
        setNote2(`Your draw request was submitted. ${skipped.length} file${skipped.length === 1 ? '' : 's'} could not be attached — ${skipped.map((s) => `${s.what}: ${s.reason}`).join('; ')}. You can add ${skipped.length === 1 ? 'it' : 'them'} again below.`);
      } else {
        setOpen(false); setAmounts({}); setNote(''); setFiles([]);
      }
      onChanged && onChanged();
    } catch (e2) { setErr(e2?.data?.error || e2.message || 'That didn’t work — please try again.'); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
      <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>Request your next draw here</div>
      <div className="small" style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Enter an amount for each line of work you’ve completed. Your team reviews it, a site inspection is
        arranged, and you can track every step on this page.
      </div>
      {!open && (
        <button className="btn btn-sm primary" style={{ marginTop: 10 }} onClick={() => { setErr(''); setOpen(true); }}>
          Start a draw request
        </button>
      )}
      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Line of work</th><th className="num">Available</th><th className="num" style={{ width: 130 }}>Request ($)</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.sitewire_job_item_id}>
                    <td>{l.name}</td>
                    <td className="num muted">{usd2(l.remaining_cents)}</td>
                    <td className="num">
                      <input type="number" min="0" step="0.01" inputMode="decimal" value={amounts[l.sitewire_job_item_id] ?? ''}
                        onChange={(ev) => setAmounts((a) => ({ ...a, [l.sitewire_job_item_id]: ev.target.value }))}
                        style={{ width: 110, textAlign: 'right' }} placeholder="0.00" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <textarea className="small" rows={2} value={note} onChange={(ev) => setNote(ev.target.value)}
            placeholder="Anything your team should know about this draw (optional)" style={{ width: '100%', marginTop: 8 }} maxLength={500} />

          {/* INVOICES, RECEIPTS AND PHOTOS, WITH THE REQUEST. Optional — a draw is never held up
              for want of one — but sending the proof now is what stops the back-and-forth later. */}
          <div style={{ marginTop: 10 }}>
            <label className="small" style={{ fontWeight: 700, display: 'block', marginBottom: 4 }}>
              Add invoices, receipts or photos (optional)
            </label>
            <div className="small" style={{ color: 'var(--text-muted)', marginBottom: 6 }}>
              Anything that shows the work is done. Your team sees these with your request.
            </div>
            <input type="file" multiple accept="image/*,application/pdf" disabled={busy}
              onChange={async (ev) => {
                const picked = (await filesToBase64(ev.target.files)).filter(Boolean);
                // Replacing rather than appending keeps what is on screen equal to what will be
                // sent — the picker always reports the whole current selection.
                setFiles(picked);
                ev.target.value = '';
              }} />
            {files.length > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {files.map((f, i) => (
                  <span key={i} className="pill sw-draft" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 220 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</span>
                    <button type="button" className="btn link" style={{ padding: 0, minHeight: 0, fontSize: 13 }} disabled={busy}
                      aria-label={`Remove ${f.filename}`}
                      onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>×</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="act-bar" style={{ alignItems: 'center' }}>
            <span className="small" style={{ fontWeight: 700 }}>Total: {usd2(totalCents)}</span>
            {overLine && <span className="small" style={{ color: 'var(--warning, #b8860b)' }}>“{overLine.name}” only has {usd2(overLine.remaining_cents)} left.</span>}
            <span style={{ flex: 1 }} />
            <button className="btn btn-sm ghost" disabled={busy} onClick={() => { setOpen(false); setErr(''); }}>Cancel</button>
            <button className="btn btn-sm primary" disabled={busy || totalCents <= 0 || !!overLine} onClick={submit}>
              {busy ? 'Submitting…' : 'Submit draw request'}
            </button>
          </div>
          {err && <div className="small" style={{ marginTop: 6, color: 'var(--danger, #b3261e)' }}>{err}</div>}
          {/* The request went through and a file did not — not an error, but never silent. */}
          {note2 && <div className="small" style={{ marginTop: 6, color: 'var(--warning, #b8860b)' }}>{note2}</div>}
        </div>
      )}
      <div className="small muted" style={{ marginTop: 10 }}>
        Prefer the construction portal (with progress photos)? <a href={sitewireUrl} target="_blank" rel="noreferrer">Submit there instead ↗</a>
      </div>
    </div>
  );
}

/* Per-line inspection photos/videos. Prefers PILOT's DURABLE copies (finding.lines[].photos —
   token-scoped URLs that never expire), and only falls back to Sitewire's raw (expiring) src when a
   line hasn't been archived yet. Videos render as a small play chip. */
function MediaStrip({ line }) {
  const durable = Array.isArray(line.photos) ? line.photos : [];
  const raw = Array.isArray(line.media) ? line.media : [];
  const items = durable.length
    ? durable.slice(0, 6)
    : raw.filter((m) => m && (m.type === 'image' || m.type === 'video')).slice(0, 6).map((m) => ({ url: m.thumbnail || m.src, full: m.src, kind: m.type }));
  if (!items.length) return <span className="muted small">{(Number(line.photo_count) || 0) + (Number(line.video_count) || 0) || '—'}</span>;
  return (
    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
      {items.map((m, i) => (
        m.kind === 'video'
          ? <a key={i} href={m.url || m.full} target="_blank" rel="noreferrer" title="Play video" style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, color: 'var(--teal)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 7px' }}>▶</a>
          : <a key={i} href={m.full || m.url} target="_blank" rel="noreferrer"><img src={m.url} alt="" loading="lazy" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, verticalAlign: 'middle', border: '1px solid var(--line)' }} /></a>
      ))}
    </div>
  );
}

/* One button that opens the whole-project inspection report (every draw in one branded PDF).
   Uses the shared `.act-card` (owner-directed 2026-08-03) — a section that OWNS its action, with
   the title and the one-line explanation on the left and the button on the right. The hand-rolled
   flex row it replaced had no `flex:1` on the text block, so the button broke onto its own line at
   ordinary widths and ended up floating under the sentence. */
function ProjectReportButton({ appId }) {
  const [err, setErr] = useState('');
  return (
    <div className="act-card">
      <div className="act-card-head">
        <div style={{ minWidth: 220, flex: 1 }}>
          <div className="act-card-title">Full inspection report</div>
          <div className="act-card-sub">Every draw, what was approved, the inspector’s notes and photos — one PDF.</div>
          {err && <div className="act-card-sub" style={{ color: 'var(--danger)', fontWeight: 600 }}>{err}</div>}
        </div>
        <button className="btn btn-sm ghost" onClick={() => { setErr(''); const w = window.open('', '_blank'); api.borrowerDrawReport(appId, null, w).catch((e) => setErr(e?.data?.error || e.message || 'Could not open your report — please try again.')); }}>
          Download PDF
        </button>
      </div>
    </div>
  );
}

function FindingCard({ finding, appId, onChanged, money }) {
  const [mode, setMode] = useState(null); // null | 'dispute'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [disp, setDisp] = useState({}); // lineId -> {desired, note}
  const badge = { delivered: { label: 'Please review', cls: 'sw-pending' }, accepted: { label: 'Accepted', cls: 'sw-approved' }, disputed: { label: 'Disputed — we\'re reviewing', cls: 'sw-insp' }, resolved: { label: 'Resolved', cls: 'sw-approved' } }[finding.status] || { label: finding.status, cls: 'sw-insp' };

  async function accept() {
    setBusy(true); setErr('');
    try { await api.post(`/api/borrower/findings/${finding.id}/accept`, {}); onChanged(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not accept.'); } finally { setBusy(false); }
  }
  async function submitDispute() {
    const lines = Object.entries(disp).filter(([, v]) => v && (v.desired !== '' || v.note || (v.media && v.media.length)))
      .map(([line_id, v]) => ({ line_id, desired_cents: moneyCents(v.desired), note: v.note || '', media: (v.media || []).map((m) => ({ filename: m.filename, contentType: m.contentType, dataBase64: m.dataBase64 })) }));
    if (!lines.length) { setErr('Add a note, amount, or a photo to at least one line you\'re disputing.'); return; }
    setBusy(true); setErr('');
    try { await api.post(`/api/borrower/findings/${finding.id}/dispute`, { lines }); setMode(null); onChanged(); }
    catch (e) { setErr(e?.data?.error || e.message || 'Could not submit.'); } finally { setBusy(false); }
  }

  const canAct = finding.status === 'delivered';
  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 16, height: 16 }}><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" /></svg></span>
          <h3>Draw inspection results</h3>
        </div>
        <span className={'pill ' + badge.cls}>{badge.label}</span>
      </div>
      <div className="dd-sub" style={{ marginTop: -2 }}>
        The inspector approved {usd2(finding.total_approved_cents)} of {usd2(finding.total_requested_cents)} requested.
        {finding.status === 'accepted' && !finding.released && finding.wire_due_at ? ` Your release is expected by ${new Date(finding.wire_due_at).toLocaleDateString('en-US')}.` : ''}
        {finding.released ? ' Your funds have been released.' : ''}
      </div>

      {/* THE NUMBER THEY ACTUALLY CARE ABOUT (owner-directed 2026-08-03). The card used to state
          only what the inspector approved, so the borrower had to open the PDF to learn that
          $24,701 — not $25,000 — was landing in their account. The figure and the sentence both
          come from the server (the rollup + approval.netExplanation's borrower wording), so this
          screen, their report and the email can never phrase the same deduction differently. */}
      {money && money.net_release_cents != null && (
        <div className="dd-payout">
          <div>
            <div className="dd-payout-k">{money.released ? 'Released to you' : 'You receive'}</div>
            <div className="dd-payout-v">{usd2(money.net_release_cents)}</div>
          </div>
          {money.net_explanation && <div className="dd-payout-why">{money.net_explanation}</div>}
        </div>
      )}

      {/* Visual step tracker — inspection → results → your acceptance → funds released */}
      <DrawStepper finding={finding} releasedAt={money && money.release_date} />

      <div className="dd-tablecard" style={{ overflowX: 'auto', marginTop: 12, boxShadow: 'none' }}>
        <table className="dd-table" style={{ minWidth: 520 }}>
          <thead><tr><th>Item</th><th className="num">Requested</th><th className="num">Approved</th><th>Inspector note</th><th>Photos</th>{mode === 'dispute' && <th>Your ask</th>}</tr></thead>
          <tbody>
            {(finding.lines || []).map((l) => (
              <tr key={l.id}>
                <td style={{ fontWeight: 600 }}>{l.name}</td>
                <td className="num">{usd2(l.requested_cents)}</td>
                <td className="num">{usd2(l.approved_cents)}{l.not_approved_cents > 0 ? <span className="muted small"> (−{usd2(l.not_approved_cents)})</span> : null}</td>
                <td className="muted small">{l.inspector_comments || '—'}</td>
                <td><MediaStrip line={l} /></td>
                {mode === 'dispute' && (
                  <td>
                    <input className="input" style={{ width: 100 }} inputMode="decimal" placeholder="$ you expect" value={(disp[l.id] || {}).desired ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), desired: e.target.value } }))} />
                    <input className="input" style={{ width: 160, marginTop: 4 }} placeholder="why (optional)" value={(disp[l.id] || {}).note ?? ''}
                      onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), note: e.target.value } }))} />
                    <div className="row" style={{ gap: 6, marginTop: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                      <label className="btn btn-xs ghost" style={{ cursor: 'pointer', margin: 0 }}>
                        📎 Add photos
                        <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                          onChange={async (e) => { const arr = (await filesToBase64(e.target.files)).filter(Boolean); e.target.value = ''; setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), media: [...(((s[l.id] || {}).media) || []), ...arr].slice(0, 8) } })); }} />
                      </label>
                      {((disp[l.id] || {}).media || []).length > 0 && (
                        <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                          {((disp[l.id] || {}).media || []).map((m, i) => (
                            <span key={i} style={{ position: 'relative', display: 'inline-block' }}>
                              <img src={m.preview} alt="" style={{ width: 30, height: 30, objectFit: 'cover', borderRadius: 5, border: '1px solid var(--line)', verticalAlign: 'middle' }} />
                              <button type="button" title="Remove" onClick={() => setDisp((s) => ({ ...s, [l.id]: { ...(s[l.id] || {}), media: ((s[l.id] || {}).media || []).filter((_, j) => j !== i) } }))}
                                style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: 999, border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 11, lineHeight: '16px', cursor: 'pointer', padding: 0 }}>×</button>
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {err && <div className="small" style={{ color: 'var(--danger)', marginTop: 8, fontWeight: 600 }}>{err}</div>}
      {/* DECISIONS FIRST, THEN THE DOCUMENT (owner-directed 2026-08-03). Accepting the results
          releases money and disputing opens a review — "Download report" merely opens a PDF, and
          all three used to sit shoulder to shoulder in one row of identical buttons. The download
          is now a quiet `soft` action behind a hairline, so the two real choices stand alone. */}
      <div className="act-bar">
        {canAct && mode !== 'dispute' && <button className="btn btn-sm primary" disabled={busy} onClick={accept}>Accept results</button>}
        {canAct && mode !== 'dispute' && <button className="btn btn-sm ghost" onClick={() => setMode('dispute')}>Dispute an item</button>}
        {mode === 'dispute' && <button className="btn btn-sm primary" disabled={busy} onClick={submitDispute}>Submit dispute</button>}
        {mode === 'dispute' && <button className="btn btn-sm ghost" onClick={() => { setMode(null); setErr(''); }}>Cancel</button>}
        {/* the borrower's OWN branded inspection report (PDF) — always available once findings exist */}
        {mode !== 'dispute' && (<>
          {canAct && <span className="act-sep" aria-hidden="true" />}
          <button className="btn btn-sm soft" disabled={busy}
            title="A PILOT-branded PDF of your draw inspection — the schedule of values, what was approved, the inspector’s notes and photos."
            onClick={() => { setErr(''); const w = window.open('', '_blank'); api.borrowerDrawReport(appId, finding.sitewire_draw_id, w).catch((e) => setErr(e?.data?.error || e.message || 'Could not open your report — please try again.')); }}>
            Download report (PDF)
          </button>
        </>)}
      </div>
    </div>
  );
}
