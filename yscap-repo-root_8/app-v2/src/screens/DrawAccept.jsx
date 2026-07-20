import React, { useEffect, useState } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* Public accept / push-back landing page reached from the findings delivery email. The
   reply_token in the URL is the capability — no login needed to ACCEPT your own release or to
   PUSH BACK on a line (amount + reason). Photo evidence on a dispute is added from the portal
   (an unauthenticated file upload is an abuse surface). Everything here is borrower-safe: the
   server scrubs capital-partner names, strips photo GPS, and never exposes lender fees. */

const usd2 = (c) => '$' + (Number(c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (c) => '$' + Math.round(Number(c || 0) / 100).toLocaleString('en-US');

function Mark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 18 }}>
      <span aria-hidden="true" style={{ display: 'inline-flex', width: 26, height: 26, borderRadius: 7, background: 'var(--gold, #AE8746)', alignItems: 'center', justifyContent: 'center' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}><path d="M5 12l5 5L20 5" /></svg>
      </span>
      <span style={{ fontFamily: 'var(--serif)', fontWeight: 700, fontSize: 18, letterSpacing: '.5px', color: 'var(--text)' }}>PILOT</span>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>by YS Capital</span>
    </div>
  );
}

export default function DrawAccept() {
  const { token } = useParams();
  const loc = useLocation();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);           // accept result
  const [disputed, setDisputed] = useState(null);   // dispute result
  const [mode, setMode] = useState('review');        // review | dispute
  const [disp, setDisp] = useState({});              // { lineId: { desired, note } }

  useEffect(() => {
    api.get(`/api/public/draw-findings/${token}`)
      .then((d) => {
        setData(d);
        const wantDispute = new URLSearchParams(loc.search || '').get('tab') === 'dispute';
        if (wantDispute && d && d.finding && d.finding.status === 'delivered') setMode('dispute');
      })
      .catch((e) => setErr(e?.data?.error || 'This link is no longer valid.'))
      .finally(() => setLoading(false));
  }, [token, loc.search]);

  const f = data && data.finding;
  const lines = (data && Array.isArray(data.lines)) ? data.lines : [];
  const pct = f && Number(f.total_requested_cents) > 0
    ? Math.round((Number(f.total_approved_cents) / Number(f.total_requested_cents)) * 100) : 0;
  const hours = (data && Number(data.wire_turnaround_hours)) || 48;
  const wireText = hours % 24 === 0 ? `${hours / 24} business day${hours / 24 === 1 ? '' : 's'}` : `${hours} hours`;

  async function accept() {
    setBusy(true); setErr('');
    try { const r = await api.post(`/api/public/draw-findings/${token}/accept`, {}); setDone(r); }
    catch (e) { setErr(e?.data?.error || 'Could not accept — please sign in to the portal and try there.'); }
    finally { setBusy(false); }
  }

  async function submitDispute() {
    const payload = Object.entries(disp)
      .filter(([, v]) => (v.desired !== '' && v.desired != null) || (v.note && v.note.trim()))
      .map(([lineId, v]) => ({ line_id: Number(lineId), desired_cents: v.desired === '' || v.desired == null ? null : Math.round(Number(v.desired) * 100), note: v.note || null }));
    if (!payload.length) { setErr('Add the amount you expected — or a note — on at least one line.'); return; }
    setBusy(true); setErr('');
    try { const r = await api.post(`/api/public/draw-findings/${token}/dispute`, { lines: payload }); setDisputed(r); }
    catch (e) { setErr(e?.data?.error || 'Could not send — please sign in to the portal and try there.'); }
    finally { setBusy(false); }
  }

  const reportHref = `/api/public/draw-findings/${token}/report`;

  return (
    <div className="wrap" style={{ maxWidth: 680, margin: '40px auto', padding: '0 16px' }}>
      <div className="dd-card" style={{ padding: '24px 26px' }}>
        <Mark />
        <h3 style={{ fontSize: 22, fontFamily: 'var(--serif)', fontWeight: 700, margin: '0 0 2px' }}>Your draw inspection results</h3>
        <div className="dd-sub">Review each line, then accept to release your draw — or push back on anything you disagree with.</div>

        {loading && <div className="dd-sub" style={{ marginTop: 16 }}>Loading…</div>}
        {err && !done && !disputed && <div style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 12 }}>{err}</div>}

        {/* SUCCESS — accepted */}
        {done && (
          <div style={{ marginTop: 16 }}>
            <div style={{ padding: '18px 20px', borderRadius: 12, background: 'var(--success-soft)', color: 'var(--success)' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 700 }}>Accepted — thank you.</div>
              <div style={{ marginTop: 4, fontWeight: 500 }}>Your release is on the way{done.wire_due_at ? `, expected by ${new Date(done.wire_due_at).toLocaleDateString('en-US')}` : ''}.</div>
            </div>
            <a className="btn ghost" href={reportHref} target="_blank" rel="noopener noreferrer" style={{ marginTop: 14 }}>Download your report (PDF)</a>
          </div>
        )}

        {/* SUCCESS — dispute sent */}
        {disputed && (
          <div style={{ marginTop: 16 }}>
            <div style={{ padding: '18px 20px', borderRadius: 12, background: 'var(--gold-soft, #F3ECDD)', color: 'var(--text)' }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 700 }}>Got it — we’re reviewing.</div>
              <div style={{ marginTop: 4, fontWeight: 500 }}>Your draw coordinator will review the {disputed.disputed_lines} item{disputed.disputed_lines === 1 ? '' : 's'} you flagged and follow up. You can add photos or receipts anytime by signing in to your portal.</div>
            </div>
            <Link className="btn ghost" to="/login" style={{ marginTop: 14 }}>Sign in to add photos</Link>
          </div>
        )}

        {/* already handled state */}
        {data && !done && !disputed && f.status !== 'delivered' && (
          <div style={{ marginTop: 16, padding: '14px 16px', borderRadius: 10, background: 'var(--ink-2)', border: '1px solid var(--line)', fontWeight: 600, color: 'var(--text)' }}>
            {f.status === 'accepted' && '✓ You’ve already accepted these results — your release is on the way.'}
            {f.status === 'disputed' && 'You’ve pushed back on these results — your coordinator is reviewing them.'}
            {f.status === 'resolved' && 'These results have been reviewed and resolved.'}
            <div style={{ marginTop: 10 }}><a className="btn ghost" href={reportHref} target="_blank" rel="noopener noreferrer">Download your report (PDF)</a></div>
          </div>
        )}

        {/* MAIN — delivered, awaiting the borrower */}
        {data && !done && !disputed && f.status === 'delivered' && (
          <>
            {/* headline number */}
            <div style={{ marginTop: 16, padding: '16px 18px', borderRadius: 12, background: 'var(--ink-2)', border: '1px solid var(--line)' }}>
              <div className="dd-hero-label">Approved for release</div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 32, fontWeight: 700, color: 'var(--text)', lineHeight: 1, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{usd2(f.total_approved_cents)}</div>
              <div className="dd-sub" style={{ marginTop: 4 }}>of {usd2(f.total_requested_cents)} requested{pct ? ` · ${pct}%` : ''}</div>
            </div>

            {/* mode toggle */}
            <div className="row" style={{ gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
              <button className={'btn ' + (mode === 'review' ? 'primary' : 'ghost')} onClick={() => { setMode('review'); setErr(''); }}>Review &amp; accept</button>
              <button className={'btn ' + (mode === 'dispute' ? 'primary' : 'ghost')} onClick={() => { setMode('dispute'); setErr(''); }}>Push back on a line</button>
              <a className="btn ghost" href={reportHref} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto' }}>Report (PDF)</a>
            </div>

            {/* per-line detail */}
            <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
              {lines.map((l) => {
                const notAppr = Number(l.not_approved_cents) > 0;
                const d = disp[l.id] || {};
                return (
                  <div key={l.id} style={{ border: '1px solid var(--line)', borderRadius: 12, padding: '13px 15px', background: 'var(--ink-1, #fff)' }}>
                    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{l.name || 'Line item'}</div>
                      <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: notAppr ? 'var(--text)' : 'var(--success)' }}>{usd0(l.approved_cents)}<span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> / {usd0(l.requested_cents)}</span></div>
                    </div>
                    {notAppr && <div className="small" style={{ color: 'var(--danger)', marginTop: 3 }}>{usd0(l.not_approved_cents)} not approved</div>}
                    {l.inspector_comments && <div className="small" style={{ color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>“{l.inspector_comments}”</div>}

                    {/* photo / video strip (durable, token-scoped) */}
                    {Array.isArray(l.media) && l.media.length > 0 && (
                      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {l.media.slice(0, 8).map((m) => (
                          m.kind === 'video'
                            ? <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--teal, #2F7F86)', border: '1px solid var(--line)', borderRadius: 8, padding: '6px 10px' }}>▶ Video</a>
                            : <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer"><img src={m.url} alt="" loading="lazy" style={{ width: 62, height: 62, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)', display: 'block' }} /></a>
                        ))}
                        {(Number(l.photo_count) + Number(l.video_count)) > l.media.length && <span className="small" style={{ color: 'var(--text-muted)', alignSelf: 'center' }}>+{(Number(l.photo_count) + Number(l.video_count)) - l.media.length} more</span>}
                      </div>
                    )}

                    {/* dispute inputs */}
                    {mode === 'dispute' && (
                      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 130px' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Amount you expected</span>
                          <input type="number" inputMode="decimal" min="0" step="1" placeholder="$" value={d.desired ?? ''} onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...s[l.id], desired: e.target.value } }))} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 16 }} />
                        </label>
                        <label className="small" style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '3 1 200px' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Why (optional)</span>
                          <input type="text" placeholder="e.g. this work is complete — see photos" value={d.note ?? ''} onChange={(e) => setDisp((s) => ({ ...s, [l.id]: { ...s[l.id], note: e.target.value } }))} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', fontSize: 16 }} />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* actions */}
            {mode === 'review' ? (
              <>
                <div className="row" style={{ gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
                  <button className="btn primary" disabled={busy} onClick={accept}>{busy ? 'Accepting…' : 'Accept these results'}</button>
                  <button className="btn ghost" disabled={busy} onClick={() => setMode('dispute')}>Push back on a line</button>
                </div>
                <div className="dd-sub" style={{ marginTop: 10 }}>Accepting releases your draw — your funds are typically wired within {wireText}.</div>
              </>
            ) : (
              <>
                <div className="row" style={{ gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
                  <button className="btn primary" disabled={busy} onClick={submitDispute}>{busy ? 'Sending…' : 'Send my push-back'}</button>
                  <button className="btn ghost" disabled={busy} onClick={() => { setMode('review'); setErr(''); }}>Cancel</button>
                </div>
                <div className="dd-sub" style={{ marginTop: 10 }}>Tell us the amount you expected and why on any line. Want to attach photos or receipts? <Link to="/login">Sign in to your portal</Link> to add them.</div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
