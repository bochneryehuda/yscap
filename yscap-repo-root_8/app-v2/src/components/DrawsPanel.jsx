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
// Parse a money text field to integer cents, or NULL when it isn't a real number. Blank ("") or
// non-numeric ("abc", "$") → null, so a mis-click / empty box can never be coerced to a $0 money
// write (Number('') === 0 is the trap this closes). A real 0 must be typed as "0".
const centsOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (s === '' || !/[0-9]/.test(s)) return null;
  const n = Math.round(Number(s.replace(/[^0-9.]/g, '')) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const fmtDay = (v) => (v ? String(v).slice(0, 10) : '—');
const STATUS = {
  drafting: 'Drafting', pending_borrower: 'With borrower', inspecting: 'Inspecting',
  pending: 'Awaiting your approval', pending_capital_partner: 'With capital partner', approved: 'Approved',
};
const RISK = { high: { label: 'High risk', cls: 'sw-pending' }, medium: { label: 'Review', cls: 'sw-insp' }, low: { label: 'Minor', cls: 'sw-draft' }, clear: { label: 'Clear', cls: 'sw-approved' } };

// Friendly one-liner for a birth-phase setup problem stored on the file (link.raw.setup_status). Shown
// inline in this file's draw section — never as a global error row (go-forward only).
const SETUP_BLURB = {
  sitewire_no_sow: 'There’s no saved Scope of Work to turn into a Sitewire budget yet.',
  sitewire_no_budget: 'No frozen rehab budget is set on this file yet.',
  sitewire_missing_loan_number: 'This file has no loan number yet.',
  sitewire_budget_mismatch: 'The Scope of Work doesn’t add up to the frozen construction budget to the penny.',
  sitewire_capital_partner_unmatched: 'The file’s capital partner couldn’t be matched to a Sitewire partner.',
  sitewire_address_incomplete: 'The property address is missing part of the street / city / state / ZIP.',
  sitewire_property_rejected: 'Sitewire rejected the property (usually the address wouldn’t geocode).',
  sitewire_dupe_check_failed: 'PILOT couldn’t verify whether this loan is already in Sitewire.',
  sitewire_bind_missing_property: 'Sitewire didn’t return the ids PILOT needs to bind the property.',
  sitewire_units_note: 'A heads-up about the unit count — the push can still proceed.',
  sitewire_type_unmapped: 'A property/loan type couldn’t be mapped — optional; the push can still proceed.',
};
function setupBlurb(s) {
  if (!s) return '';
  if (SETUP_BLURB[s.class]) return SETUP_BLURB[s.class];
  const m = /^sitewire_[a-z0-9_]+:\s*(.+)$/is.exec(String(s.reason || ''));
  return (m ? m[1] : (s.reason || 'Setup needs a quick check.')).trim();
}

export default function DrawsPanel({ appId }) {
  const { can } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [quickStatuses, setQuickStatuses] = useState([]); // Sitewire pipeline status labels

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/api/sitewire/files/${appId}/rollup`)
      .then((d) => { setData(d); setErr(''); })
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load draws'))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get(`/api/sitewire/files/${appId}/quick-notify-statuses`).then((r) => setQuickStatuses((r && r.statuses) || [])).catch(() => setQuickStatuses([])); }, [appId]);

  const canManage = can('manage_draws');
  if (!canManage) return null;
  if (loading) return <div className="panel" style={{ marginTop: 12 }}>Loading draws…</div>;
  if (err) return <div className="panel" style={{ marginTop: 12, color: 'var(--bad,#b04a3f)' }}>{err}</div>;
  if (!data) return null;

  const { rollup, link, requests = [], ledger = [], findings = [], change_requests = [], retainage = null, waivers = [], lien_waivers_enabled = false,
    preexisting = false, setup_status = null, managed_since = null, go_live_date = null } = data;
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
  // Delivering findings needs Sitewire READS (it re-reads the draw), so it's gated by the MASTER
  // switch, not the write gate — it still works in the reads-on/writes-off state, but not when off.
  const readsOff = !!data.switches && !sw.enabled;
  const pct = Math.max(0, Math.min(100, Number(rollup.project && rollup.project.pct_complete) || 0));

  async function act(key, fn) {
    setBusy(key); setMsg('');
    try { const r = await fn(); setMsg(r && r.msg ? r.msg : 'Done.'); load(); }
    catch (e) { setMsg(e?.data?.error || e.message || 'That didn\'t work.'); }
    finally { setBusy(''); }
  }

  return (
    <div>
      {notLinked ? (
        <>
          {/* GO-FORWARD ONLY: a pre-existing Sitewire property (loan already there, not pushed by us) is
              NOT followed. Say so plainly and explain the only way to bring it under PILOT management. */}
          {preexisting && (
            <div className="panel" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)', borderLeft: '3px solid var(--bad,#b04a3f)' }}>
              <b>Already in Sitewire — PILOT is not managing this file’s draws.</b>
              <div className="muted small" style={{ marginTop: 3 }}>
                This loan is already on a property in Sitewire that PILOT did not create. PILOT only runs the draw
                process for properties it pushes itself, so it will not adopt or follow this one. To have PILOT
                manage the draws, <b>delete that property in Sitewire</b>, then start the draw process below to push a
                fresh copy. Otherwise leave it as-is and continue managing that property directly in Sitewire.
              </div>
            </div>
          )}
          {/* A non-collision setup problem from the last push attempt — shown ON THE FILE (never a global
              error row): the draw hasn't started because something needs fixing first (no Scope of Work,
              a budget that doesn't tie out, an unmatched partner, an incomplete address, …). */}
          {!preexisting && setup_status && (
            <div className="panel" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)', borderLeft: '3px solid var(--gold,#ae8746)' }}>
              <b>Draw setup hasn’t completed yet.</b>
              <div className="muted small" style={{ marginTop: 3 }}>{setupBlurb(setup_status)} Fix the cause, then start the draw process below.</div>
            </div>
          )}
          <StartDrawCard appId={appId} onStarted={load} />
        </>
      ) : (
        <>
          {msg && <div className="dd-card" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)' }}>{msg}</div>}

          {/* ---- header: status + released-vs-remaining meter + uniform KPI row (one cohesive card) ---- */}
          <div className="dd-card" style={{ marginTop: 12 }}>
            <div className="dd-card-h" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 6 }}>
              <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                <span className="dd-card-ic"><SdIcon name="rocket" /></span>
                <div>
                  <h3>Construction draws</h3>
                  <div className="dd-sub" style={{ marginTop: 1 }}>
                    Live in PILOT{managed_since ? ` since ${fmtDay(managed_since)}` : ''} — PILOT is the source of record: it follows the draw requests, delivers the inspection findings, and runs the approval + release pipeline.{go_live_date ? ` Go-live: ${fmtDay(go_live_date)}.` : ''}
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className={'dd-chip ' + (sw.enabled ? 'on' : 'off')}><span className="dot" />{sw.enabled ? 'Connected' : 'Sitewire off'}</span>
                {sw.enabled && <span className={'dd-chip ' + (sw.outbound ? 'on' : 'warn')}><span className="dot" />{sw.outbound ? 'Writing on' : 'Read-only'}</span>}
                {sw.dryrun && <span className="dd-chip warn"><span className="dot" />Dry-run</span>}
              </div>
            </div>

            {/* released-vs-remaining meter */}
            <div className="dd-hero-meter-top" style={{ marginTop: 10 }}>
              <span className="dd-hero-label">Released vs. remaining</span>
              <span className="dd-hero-pct">{pct}%</span>
            </div>
            <div className="dd-meter" style={{ height: 12 }} role="img" aria-label={`${pct}% of the construction budget released`}><i style={{ width: pct + '%' }} /></div>

            {/* uniform KPI row — fixed value size so every tile matches (no per-box scaling) */}
            <div style={{ marginTop: 16, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gridAutoRows: '1fr' }}>
              <KpiTile label="Construction budget" value={usd(rollup.project.budget)} />
              <KpiTile label="Drawn (released)" value={usd(rollup.project.drawn)} sub={`${pct}% complete`} tone="teal" />
              <KpiTile label="Remaining" value={usd(rollup.project.remaining)} tone="gold" />
              <KpiTile label="In the pipeline" value={usd(rollup.project.requested_open)} sub="requested, not yet released" />
            </div>
          </div>

          {/* ---- Sitewire borrower-invite status + resend ---- */}
          <BorrowerInviteStatus appId={appId} writesOff={writesOff} readsOff={readsOff} />

          {/* ---- Sitewire property documents (whatever's uploaded on Sitewire's side) ---- */}
          <SitewireDocuments appId={appId} readsOff={readsOff} />

          {/* ---- read-only notice when Sitewire writes are off (the default staged state) ---- */}
          {writesOff && (
            <div className="dd-card" style={{ marginTop: 12, borderLeft: '3px solid var(--gold,#ae8746)' }}>
              <b>Sitewire is turned off.</b>
              <div className="dd-sub" style={{ marginTop: 3 }}>
                Approving a draw syncs to Sitewire, so <b>Approve / Amend / Reopen</b>, setting approved amounts{readsOff ? ' and delivering findings' : ''} are paused until it's switched on{sw.enabled && !sw.outbound ? ' (reads are on; writing is still off)' : ''}. The money ledger, releases and records are kept in PILOT and still work.
              </div>
            </div>
          )}

          {/* ---- lifecycle: finish the draw process / mark paid off / re-open ---- */}
          <LifecycleControl appId={appId} link={link} writesOff={writesOff} onChanged={load} />

          {/* ---- the unified per-line / per-unit rollup ---- */}
          <div className="dd-card" style={{ marginTop: 12, padding: 0, overflow: 'hidden' }}>
            <div className="dd-card-h" style={{ padding: '16px 18px 0' }}><span className="dd-card-ic"><SdIcon name="list" /></span><h3>Scope of Work — budget vs. drawn</h3></div>
            <RollupTable rollup={rollup} />
          </div>

          {/* ---- draws ---- */}
          <div className="row between" style={{ marginTop: 22, marginBottom: 6, alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>Draws</h3>
            {draws.length > 0 && (
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm ghost" title="A PILOT-branded PDF of the whole construction project — schedule of values + every draw's inspection photos + notes."
                  onClick={() => { const w = window.open('', '_blank'); act('projreport', async () => { await api.sitewireProjectReport(appId, 'staff', w); return { msg: 'Opened the whole-project report in a new tab.' }; }); }}>
                  Whole-project report
                </button>
                <button className="btn btn-sm ghost" title="The same whole-project report, borrower-safe (no capital-partner name, no fee/net, no photo GPS). Generating it shares it with the borrower."
                  onClick={() => { if (!window.confirm('Share the borrower-safe whole-project report with the borrower? They’ll be able to see it in their portal.')) return; const w = window.open('', '_blank'); act('projreportb', async () => { await api.sitewireProjectReport(appId, 'borrower', w); return { msg: 'Shared the borrower-safe whole-project report with the borrower.' }; }); }}>
                  Borrower copy
                </button>
              </div>
            )}
          </div>
          {draws.length === 0 && <div className="muted">No draws yet on this file.</div>}
          {draws.map((d) => (
            <DrawCard key={d.sitewire_draw_id} appId={appId} draw={d} requests={reqsByDraw[d.sitewire_draw_id] || []}
              finding={findingByDraw[d.sitewire_draw_id]} busy={busy} act={act} reload={load} writesOff={writesOff} readsOff={readsOff} quickStatuses={quickStatuses} />
          ))}

          {/* ---- draw email / notification center (draw-related only) ---- */}
          <DrawMailCenter appId={appId} />

          {/* ---- money ledger ---- */}
          <LedgerPanel appId={appId} ledger={ledger} draws={draws} retainage={retainage} onSaved={load} act={act} busy={busy} />

          {/* ---- lien waivers — OFF by default; opt in per project ---- */}
          <LienWaivers appId={appId} enabled={lien_waivers_enabled} fileOverride={data.lien_waivers_file_override}
            canSetup={can('platform_setup')} waivers={waivers} draws={draws} onChanged={load} />

          {/* ---- Scope-of-Work reallocations ---- */}
          <ChangeRequests appId={appId} items={change_requests} busy={busy} act={act} />

          {/* ---- audit trail ---- */}
          <ActivityTrail appId={appId} />

          {/* ---- reset / re-push (testing): unlink + start the draw process over ---- */}
          <ResetDrawControl appId={appId} onChanged={load} />
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
/* Close a project out from the desk: "Finish the draw process" (construction done, no more draws) or
   "Mark paid off" (loan closed) — both deactivate the property in Sitewire so no further draws can be
   submitted; a finished/paid-off project can be re-opened. Confirmed before firing (it changes Sitewire). */
const LIFECYCLE_LABEL = { active: 'Active', finished: 'Draw process finished', paid_off: 'Paid off' };
function LifecycleControl({ appId, link, writesOff, onChanged }) {
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const state = (link && link.lifecycle_state) || 'active';
  const at = link && link.lifecycle_at;
  async function set(next, confirmText) {
    if (!window.confirm(confirmText)) return;
    setBusy(next); setMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/lifecycle`, { state: next });
      const swNote = r.sitewire === 'synced' ? ' Synced to Sitewire.' : r.sitewire === 'skipped' ? ' (Sitewire sync will apply once writing is turned on.)' : r.sitewire === 'dryrun' ? ' (dry-run — nothing sent to Sitewire.)' : '';
      setMsg((next === 'active' ? 'Project re-opened.' : next === 'paid_off' ? 'Marked paid off.' : 'Draw process finished.') + swNote);
      onChanged();
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); }
    finally { setBusy(''); }
  }
  const done = state !== 'active';
  return (
    <div className="panel" style={{ marginTop: 12, background: done ? 'var(--paper,#f6f3ec)' : 'transparent', borderLeft: done ? '3px solid var(--gold,#ae8746)' : undefined }}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div className="small">
          <b>Project status:</b> {LIFECYCLE_LABEL[state] || 'Active'}{done && at ? ` · ${fmtDay(at)}` : ''}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {state === 'active' ? (
            <>
              <button className="btn btn-sm ghost" disabled={busy === 'finished'} title="Construction is complete — no more draws expected. Deactivates the property in Sitewire."
                onClick={() => set('finished', 'Finish the draw process for this project? No further draws can be submitted (the property is deactivated in Sitewire). You can re-open it later.')}>Finish the draw process</button>
              <button className="btn btn-sm ghost" disabled={busy === 'paid_off'} title="The loan is paid off / closed. Deactivates the property in Sitewire."
                onClick={() => set('paid_off', 'Mark this loan as paid off? No further draws can be submitted (the property is deactivated in Sitewire). You can re-open it later.')}>Mark paid off</button>
            </>
          ) : (
            <button className="btn btn-sm ghost" disabled={busy === 'active'} title="Re-open this project — re-activates the property in Sitewire so draws can be submitted again."
              onClick={() => set('active', 'Re-open this project? It becomes active again and the property is re-activated in Sitewire.')}>Re-open project</button>
          )}
        </div>
      </div>
      {writesOff && state === 'active' && <div className="muted small" style={{ marginTop: 4 }}>Sitewire writing is off — closing a project is recorded in PILOT now and synced to Sitewire once writing is turned on.</div>}
      {msg && <div className="muted small" style={{ marginTop: 4 }}>{msg}</div>}
    </div>
  );
}

/* Reset / re-push (owner-directed testing control): unlink the property and start the draw process over.
   Sitewire has no delete, so the backend deactivates the property there and clears our mirror; the money
   ledger is kept. Strong confirm — it's destructive to the draw tracking. Lives in a red "danger" card. */
function ResetDrawControl({ appId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function reset() {
    if (!window.confirm('Reset this file’s draw setup and start over?\n\nThis deactivates the property in Sitewire (Sitewire has no delete — the old copy stays in their list, just inactive) and unlinks it here, clearing the mirrored draws, findings and photos so you can push a fresh copy. Your money ledger — releases, retainage and waivers — is kept.')) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/reset-draw`, {});
      const sw = !r.was_managed ? '' : r.sitewire === 'synced' ? ' The old property was deactivated in Sitewire.'
        : r.sitewire === 'failed' ? ' (Couldn’t deactivate it in Sitewire — deactivate or delete it there if you need to.)'
        : r.sitewire === 'dryrun' ? ' (Dry-run — nothing was sent to Sitewire.)'
        : ' (Sitewire writing is off — deactivate it there if you need to.)';
      setMsg('Draw setup reset — start the draw process again above.' + sw);
      onChanged();
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="dd-card" style={{ marginTop: 18, borderLeft: '3px solid var(--bad,#b04a3f)' }}>
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 220, flex: '1 1 320px' }}>
          <b>Reset draw setup</b>
          <div className="dd-sub" style={{ marginTop: 2 }}>Unlink this property and start the push over. Deactivates it in Sitewire, clears the mirrored draws/findings/photos, and brings back the “Start the draw process” options with all the push settings. Your money ledger is kept.</div>
        </div>
        <button className="btn btn-sm" style={{ background: 'var(--bad,#b04a3f)', color: '#fff', flex: '0 0 auto' }} disabled={busy} onClick={reset}>{busy ? 'Resetting…' : 'Reset & re-push'}</button>
      </div>
      {msg && <div className="dd-sub" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

/* Shows Sitewire's borrower-invite state (unassigned → invited → accepted) and a resend button. Sitewire
   owns the invite email itself; we surface the status it exposes and can re-trigger the invite. Staff-only. */
const INVITE = {
  assigned: { label: 'Borrower accepted the Sitewire invite', cls: 'sw-approved', tone: 'var(--good,#3f7a4a)' },
  invited: { label: 'Sitewire invite sent — waiting on the borrower', cls: 'sw-pending', tone: 'var(--gold,#ae8746)' },
  unassigned: { label: 'Borrower not yet invited in Sitewire', cls: 'sw-draft', tone: 'var(--text-muted)' },
};
function BorrowerInviteStatus({ appId, writesOff, readsOff }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const loadStatus = useCallback(() => { api.get(`/api/sitewire/files/${appId}/borrower-status`).then(setSt).catch(() => setSt(null)); }, [appId]);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  if (!st || !st.managed) return null;
  const info = (st.available && INVITE[st.status]) || null;
  async function resend() {
    setBusy(true); setMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/resend-invite`, {});
      setMsg(r.sitewire === 'dryrun' ? 'Dry-run — the invite wasn’t actually sent.' : `Invite sent to ${r.email}.`);
      setTimeout(loadStatus, 800);
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); }
    finally { setBusy(false); }
  }
  const accepted = st.status === 'assigned';
  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center', minWidth: 0 }}>
          <span className="dd-card-ic"><SdIcon name="mail" /></span>
          <div>
            <b>Borrower in Sitewire</b>
            {info
              ? <div className="dd-sub" style={{ marginTop: 1, color: info.tone }}>{info.label}{st.contact_email ? ` · ${st.contact_email}` : ''}</div>
              : <div className="dd-sub" style={{ marginTop: 1 }}>{readsOff ? 'Turn Sitewire on to see the borrower’s invite status.' : 'Status unavailable right now.'}</div>}
          </div>
        </div>
        {!accepted && !readsOff && (
          <button className="btn btn-sm ghost" style={{ flex: '0 0 auto' }} disabled={busy || writesOff}
            title={writesOff ? 'Sitewire writing is off' : 'Re-send the Sitewire borrower invite'} onClick={resend}>
            {busy ? 'Sending…' : (st.status === 'invited' ? 'Resend invite' : 'Send invite')}
          </button>
        )}
      </div>
      {msg && <div className="dd-sub" style={{ marginTop: 6 }}>{msg}</div>}
    </div>
  );
}

function CheckRow({ ok, label }) {
  return (
    <div className="row" style={{ gap: 9, alignItems: 'center', padding: '4px 0' }}>
      <span style={{ display: 'inline-grid', placeItems: 'center', width: 18, height: 18, borderRadius: 999, flex: '0 0 auto', fontSize: 11, fontWeight: 800, background: ok ? 'var(--success-soft)' : 'var(--ink-3)', color: ok ? 'var(--success)' : 'var(--text-soft)' }}>{ok ? '✓' : '·'}</span>
      <span className={ok ? '' : 'muted'} style={{ fontSize: 14 }}>{label}</span>
    </div>
  );
}

function StartDrawCard({ appId, onStarted }) {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState('');
  const [feeInput, setFeeInput] = useState('');
  const [feeEdited, setFeeEdited] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/api/sitewire/files/${appId}/draw-setup`)
      .then((d) => {
        setS(d); setErr(''); setMethod('');
        const insp = d.inspection || {};
        // seed the fee box from the effective fee (includes any stored override); an existing override
        // counts as "edited" so switching method won't silently reset the coordinator's amount.
        setFeeInput(insp.fee_cents != null ? String(Math.round(Number(insp.fee_cents) / 100)) : '');
        setFeeEdited(!!insp.fee_overridden);
      })
      .catch((e) => setErr(e?.data?.error || e.message || 'Could not load draw setup'))
      .finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="dd-card" style={{ marginTop: 12 }}>Loading draw setup…</div>;
  if (err) return <div className="dd-card" style={{ marginTop: 12, color: 'var(--danger)' }}>{err}</div>;
  if (!s) return null;

  // Handled externally: this capital partner runs its own draw process — PILOT never pushes to
  // Sitewire, so there's nothing for the coordinator to start here.
  if (s.handled_externally) {
    return (
      <div className="dd-card" style={{ marginTop: 12 }}>
        <div className="dd-card-h"><span className="dd-card-ic"><SdIcon name="ext" /></span><h3>Draws are handled externally</h3></div>
        <div className="dd-sub" style={{ marginTop: 2 }}>
          {(s.capital_partner && s.capital_partner.name) ? `${s.capital_partner.name} runs` : 'This capital partner runs'} its own draw process in its own system, so PILOT does not send this file to Sitewire. Nothing to start here.
        </div>
      </div>
    );
  }

  const insp = s.inspection || {};
  const cp = s.capital_partner || {};
  const p = s.prereqs || {};
  const u = s.units || null;
  // the method actually in effect (the coordinator's live switch, else the resolved default)
  const effMethod = method || insp.method;
  const effKind = effMethod === 'traditional' ? 'physical' : 'virtual';
  // the rule's default fee for a given method (physical falls back to virtual, then the resolved fee)
  function defaultFeeForMethod(m) {
    const kind = m === 'traditional' ? 'physical' : 'virtual';
    const c = kind === 'physical' ? (insp.fee_physical_cents != null ? insp.fee_physical_cents : insp.fee_virtual_cents) : insp.fee_virtual_cents;
    return c != null ? c : (insp.rule_fee_cents != null ? insp.rule_fee_cents : insp.fee_cents);
  }
  function pickMethod(m) {
    setMethod(m);
    // if the coordinator hasn't customized the fee, follow the new method's default
    if (!feeEdited) { const d = defaultFeeForMethod(m); setFeeInput(d != null ? String(Math.round(Number(d) / 100)) : ''); }
  }
  // A BLANK fee box means "use the rule default" — never $0. Only a typed number is sent as an
  // override; blank leaves the stored fee untouched (so clearing the box can't silently push a $0 fee).
  const feeBlank = String(feeInput).trim() === '';
  const feeCents = centsOrNull(feeInput); // null = blank OR non-numeric garbage (never coerced to 0)
  const feeValid = feeBlank || (feeCents != null && feeCents <= 10000000);
  const isCustomFee = !feeBlank && feeCents != null && feeCents !== Number(defaultFeeForMethod(effMethod));
  const alreadyStarted = !!s.started_at; // coordinator pressed Start earlier; awaiting the switch/push

  async function start() {
    setBusy(true); setMsg('');
    try {
      const body = {};
      if (method && method !== insp.method) body.inspection_method = method;
      if (!feeBlank && feeValid) body.fee_cents = feeCents; // a typed fee only; blank = leave the fee as-is (backend clears the override when it equals the rule fee)
      const r = await api.post(`/api/sitewire/files/${appId}/start-draw`, body);
      // The push can succeed OR safely PARK (a review was opened) OR be skipped — never report a blanket
      // "everything was sent" when it actually parked (e.g. clicking Start on a pre-existing-Sitewire file
      // without deleting it first re-parks the collision). Surface the real outcome.
      const res = r && r.result;
      // Go-forward: a not-yet-pushed file records its status ON THE FILE (the banner right below), never a
      // global review row — so point the coordinator there, never to the Sync review screen.
      const PARKED = {
        dupe_property: 'Not pushed — this loan is already on a property in Sitewire that PILOT didn’t create. Delete it in Sitewire and try again, or keep managing that property directly in Sitewire. (See the note below.)',
        dupe_check_failed: 'Not pushed — PILOT couldn’t verify whether this loan is already in Sitewire. See the note on this file’s draw section below.',
        budget_mismatch: 'Not pushed — the Scope of Work doesn’t add up to the frozen construction budget to the penny. See the note below.',
        capital_partner: 'Not pushed — the file’s capital partner couldn’t be matched to Sitewire. See the note below.',
        address: 'Not pushed — the property address is incomplete. See the note below.',
        no_sow: 'Not pushed — there’s no saved Scope of Work to turn into a budget yet.',
        no_budget: 'Not pushed — no frozen rehab budget is set on this file yet.',
        missing_loan_number: 'Not pushed — this file has no loan number yet.',
      };
      let m;
      if (r && r.note) m = r.note;                                            // Sitewire off / queued (transient)
      else if (res && res.parked) m = PARKED[res.parked] || 'Couldn’t finish — the reason is shown on this file’s draw section below.';
      else if (res && res.skipped) m = `Not pushed — ${res.skipped}.`;
      else if (res && res.dryrun) m = 'Validated in dry-run mode — nothing was sent (Sitewire dry-run is on).';
      else m = 'Draw process started — everything was sent to Sitewire.';
      setMsg(m);
      load();
      if (onStarted) setTimeout(onStarted, 400);
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn\'t work.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="rocket" /></span>
          <div>
            <h3>Start the draw process</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>Sends the property, construction budget, Scope of Work and fees to Sitewire, then reads them back to confirm. Do this once, after funding.</div>
          </div>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {!s.switches?.enabled && <span className="dd-chip warn"><span className="dot" />Sitewire off — will queue</span>}
          {s.switches?.enabled && s.switches?.dryrun && <span className="dd-chip warn"><span className="dot" />Dry-run</span>}
          {s.switches?.enabled && !s.switches?.dryrun && !s.switches?.outbound && <span className="dd-chip warn"><span className="dot" />Read-only</span>}
        </div>
      </div>

      {alreadyStarted && (
        <div className="small" style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--success-soft)', color: 'var(--success)', fontWeight: 600 }}>
          ✓ Draw setup was started on {fmtDay(s.started_at)}{insp.chosen_override ? ` (${insp.chosen_override === 'traditional' ? 'on-site' : 'virtual'} inspection)` : ''}.
          {s.switches?.enabled ? ' You can re-send it below if needed.' : ' It will push to Sitewire automatically the moment Sitewire is turned on — nothing more to do.'}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 14, marginTop: 14 }}>
        <div style={{ background: 'var(--ink-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 16px' }}>
          <div className="dd-field-l" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6, fontSize: 11 }}>Before we can start</div>
          <CheckRow ok={p.funded} label="Loan is funded" />
          <CheckRow ok={p.loan_number} label="YS loan number set" />
          <CheckRow ok={p.capital_partner} label={cp.name ? `Capital partner: ${cp.name}` : 'Capital partner matched'} />
          <CheckRow ok={p.budget} label="Construction budget frozen" />
          <CheckRow ok={p.scope_of_work} label="Scope of Work saved" />
          <CheckRow ok={p.address} label="Property address complete" />
          {u && (
            <div className="small" style={{ marginTop: 8, color: 'var(--text-muted)' }}>
              Units in Sitewire: <b style={{ color: 'var(--text)' }}>{u.physical}</b>
              {u.disagree && <span> — the file lists {u.file}, the Scope of Work is built for {u.sow}; PILOT pushes the physical building count ({u.physical}). Units with no work carry no budget lines — fix the file’s unit count if {u.physical} is wrong.</span>}
            </div>
          )}
          {!p.capital_partner && cp.ambiguous && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>The capital-partner name matches more than one — fix the lender label on the file.</div>}
          {!p.capital_partner && cp.candidate_name && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>Closest match is “{cp.candidate_name}”, but it isn't exact — link it in Draw settings before we can push.</div>}
        </div>
        <div style={{ background: 'var(--ink-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 16px' }}>
          <div className="dd-field-l" style={{ textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, fontSize: 11 }}>Inspection &amp; fee</div>
          {insp.can_switch ? (
            <label className="small" style={{ display: 'block', marginBottom: 10 }}>Inspection method
              <select className="input" value={effMethod} onChange={(e) => pickMethod(e.target.value)}>
                <option value="mobile">Virtual (mobile){insp.default_method === 'mobile' ? ' — default' : ''}</option>
                <option value="traditional">On-site (traditional){insp.default_method === 'traditional' ? ' — default' : ''}</option>
              </select>
            </label>
          ) : (
            <div style={{ marginBottom: 10 }}>{effMethod === 'traditional' ? 'On-site (traditional)' : 'Virtual (mobile)'}<span className="muted small"> — {insp.allow_virtual === false || insp.allow_physical === false ? 'set by the program, can’t switch' : 'the only method allowed'}</span></div>
          )}
          <label className="small" style={{ display: 'block' }}>Draw fee ({effKind})
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="muted" style={{ fontWeight: 600 }}>$</span>
              <input className="input" style={{ maxWidth: 120 }} value={feeInput} onChange={(e) => { setFeeInput(e.target.value); setFeeEdited(true); }} />
              <span className="muted small">per draw</span>
            </div>
          </label>
          {!feeValid && <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>Enter a fee between $0 and $100,000.</div>}
          {feeValid && isCustomFee && <div className="small" style={{ color: 'var(--warning)', marginTop: 4 }}>Custom fee for this file (rule default is {usd(defaultFeeForMethod(effMethod))}).</div>}
          <div className="muted small" style={{ marginTop: 10 }}>
            {s.requires?.sitewire_inspector ? 'A Sitewire inspector must sign off each draw.' : 'No Sitewire inspector required.'}<br />
            {s.requires?.capital_partner_approval ? 'Approved draws route to the capital partner.' : 'No capital-partner approval step.'}
          </div>
        </div>
      </div>

      {s.open_reviews > 0 && (
        <div className="small" style={{ marginTop: 12, color: 'var(--danger)', fontWeight: 600 }}>
          {s.open_reviews} item{s.open_reviews === 1 ? '' : 's'} on this file need review before it will go through cleanly. <a href="#/internal/sync-reviews">Open the review list</a>.
        </div>
      )}

      <div className="row" style={{ gap: 10, marginTop: 16, alignItems: 'center' }}>
        {/* When started while Sitewire is off, there's nothing more to press — the worker pushes on switch-on. */}
        {!(alreadyStarted && !s.switches?.enabled) && (
          <button className="btn primary" disabled={busy || !s.can_start || !feeValid} onClick={start}>
            {busy ? 'Starting…' : alreadyStarted ? 'Re-send to Sitewire' : s.switches?.enabled ? 'Start the draw process' : 'Start (queue for Sitewire)'}
          </button>
        )}
        {!s.can_start && <span className="muted small">Finish the checklist above first.</span>}
        {msg && <span className="small" style={{ color: 'var(--success)', fontWeight: 600 }}>{msg}</span>}
      </div>
    </div>
  );
}

/* Tiny inline icon set for the start-draw card. */
function SdIcon({ name }) {
  const p = {
    rocket: <><path d="M12 3c3 1 5 4 5 8l-2 5H9l-2-5c0-4 2-7 5-8z" /><circle cx="12" cy="9" r="1.6" /><path d="M9 16l-2 3M15 16l2 3" /></>,
    ext: <><path d="M14 4h6v6" /><path d="M20 4l-8 8" /><path d="M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4" /></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
    reply: <><path d="M9 17l-5-5 5-5" /><path d="M4 12h11a5 5 0 015 5v1" /></>,
    folder: <><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></>,
  }[name] || null;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>;
}

/* A draw-desk KPI tile on the shared dd-kpi surface, with a FIXED value size so every tile in the row
   matches exactly (the old stat-tile scaled each number to its own box width, which read as "different-size
   boxes"). tone tints the value; sub is an optional caption. */
function KpiTile({ label, value, sub, tone }) {
  const color = tone === 'teal' ? 'var(--teal-br)' : tone === 'gold' ? 'var(--gold,#ae8746)' : 'var(--text)';
  return (
    <div className="dd-kpi">
      <div className="dd-kpi-label">{label}</div>
      <div className="dd-kpi-value" style={{ fontSize: 21, color }}>{value}</div>
      {sub && <div className="dd-kpi-sub">{sub}</div>}
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
    <div style={{ marginTop: 12, overflowX: 'auto' }}>
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

/* The Sitewire property's own documents — a live read of whatever's been uploaded on Sitewire's side, so the
   coordinator sees everything Sitewire holds without leaving PILOT. Links open Sitewire's copy (may expire). */
function SitewireDocuments({ appId, readsOff }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.get(`/api/sitewire/files/${appId}/sitewire-documents`).then(setD).catch(() => setD(null)); }, [appId]);
  if (!d || !d.managed) return null;
  const docs = d.documents || [];
  if (!docs.length && (readsOff || !d.available)) return null; // nothing to show + can't read → hide
  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="folder" /></span>
          <div><h3>Documents in Sitewire</h3><div className="dd-sub" style={{ marginTop: 1 }}>Files uploaded on Sitewire’s side for this property.</div></div>
        </div>
        <span className="dd-sub">{docs.length}</span>
      </div>
      {docs.length === 0
        ? <div className="dd-sub" style={{ marginTop: 6 }}>No documents on the Sitewire property yet.</div>
        : <div style={{ marginTop: 6 }}>{docs.map((doc, i) => (
            <div key={i} className="row" style={{ gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <span className="dd-card-ic" style={{ width: 24, height: 24, background: 'var(--primary-soft)' }}><SdIcon name="folder" /></span>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}><b style={{ fontSize: 13 }}>{doc.name}</b>{doc.kind ? <span className="dd-sub"> · {doc.kind}</span> : null}</span>
              {doc.url ? <a className="btn btn-sm ghost" href={doc.url} target="_blank" rel="noreferrer" style={{ flex: '0 0 auto' }}>Open ↗</a> : <span className="dd-sub">no link</span>}
            </div>
          ))}</div>}
    </div>
  );
}

function DrawCard({ appId, draw, requests, finding, busy, act, reload, writesOff, readsOff, quickStatuses }) {
  const offTip = writesOff ? 'Sitewire is turned off — available once it\'s switched on' : undefined;
  const readTip = readsOff ? 'Sitewire is turned off — available once it\'s switched on' : undefined;
  const isOpen = draw.status !== 'approved';
  const flags = Array.isArray(draw.risk_flags) ? draw.risk_flags : [];
  const risk = RISK[draw.risk_level] || null;
  const [edits, setEdits] = useState({}); // reqId -> approved dollars string
  const [showPhotos, setShowPhotos] = useState(false);

  async function setApproved(r) {
    // reject a blank / non-numeric box — never let a mis-clicked empty Save push $0 approved to
    // Sitewire (that would destroy the lender-approved amount for the line). A real 0 must be typed.
    const cents = centsOrNull(edits[r.sitewire_request_id]);
    if (cents == null) return;
    await act('appr:' + r.sitewire_request_id, async () => {
      await api.post(`/api/sitewire/requests/${r.sitewire_request_id}/approve`, { approved_cents: cents });
      // clear the input on success so it doesn't keep showing a stale typed value
      setEdits((s) => { const n = { ...s }; delete n[r.sitewire_request_id]; return n; });
      return { msg: 'Approved amount saved.' };
    });
  }
  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div className="row between" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <b>Draw #{draw.number ?? '—'}</b>
          <span className="pill sw-insp">{STATUS[draw.status] || 'In progress'}</span>
          {risk && flags.length > 0 && <span className={'pill ' + risk.cls}>{risk.label} · {flags.length}</span>}
        </div>
        <div className="muted small">Requested {usd2(draw.requested_cents)} · Approved {usd2(draw.approved_cents)} · Net {usd2(draw.net_release_cents)}</div>
      </div>

      {/* Sitewire pipeline status — the same status control Sitewire's own desk has, per draw */}
      {Array.isArray(quickStatuses) && quickStatuses.length > 0 && (
        <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span className="muted small">Pipeline status</span>
          <select className="input" style={{ maxWidth: 260 }} value={draw.quick_notify_status_id ?? ''} disabled={writesOff || busy === 'qn' + draw.sitewire_draw_id}
            title={writesOff ? 'Sitewire writing is off' : 'Set this draw’s Sitewire pipeline status'}
            onChange={(e) => { const v = e.target.value; act('qn' + draw.sitewire_draw_id, async () => { await api.post(`/api/sitewire/files/${appId}/draws/${draw.sitewire_draw_id}/quick-notify`, { status_id: v === '' ? null : v }); return { msg: 'Pipeline status updated in Sitewire.' }; }); }}>
            {/* "— not set —" is a placeholder only: a status can be MOVED between statuses but not cleared
                back to none (the Sitewire write-guard refuses a clearing value), so it's not selectable. */}
            <option value="" disabled>— not set —</option>
            {quickStatuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      )}

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
        <button className="btn btn-sm ghost" title={readTip} disabled={readsOff || busy === 'deliver' + draw.sitewire_draw_id}
          onClick={() => act('deliver' + draw.sitewire_draw_id, async () => { const r = await api.post(`/api/sitewire/files/${appId}/findings/${draw.sitewire_draw_id}/deliver`, {}); const ready = Array.isArray(r.reports_ready) && r.reports_ready.length; return { msg: `Findings delivered to the borrower (${r.lines} items).${ready ? ' Photos archived + PILOT reports ready.' : (r.reports_pending ? ' Archiving photos + preparing reports…' : '')}` }; })}>
          {finding ? 'Re-send findings' : 'Deliver findings to borrower'}
        </button>
        <button className={'btn btn-sm ' + (showPhotos ? 'primary' : 'ghost')} onClick={() => setShowPhotos((s) => !s)}>
          {showPhotos ? 'Hide inspection photos' : 'Inspection photos'}
        </button>
        <button className="btn btn-sm ghost" onClick={() => api.sitewireExportPacket(appId, draw.sitewire_draw_id).catch(() => {})}>Draw packet</button>
        <button className="btn btn-sm ghost" title="A PILOT-branded PDF for this draw — schedule of values, approved vs not-approved, inspector notes and the inspection photos." disabled={busy === 'rep' + draw.sitewire_draw_id}
          onClick={() => { const w = window.open('', '_blank'); act('rep' + draw.sitewire_draw_id, async () => { await api.sitewireDrawReport(appId, draw.sitewire_draw_id, 'staff', w); return { msg: 'Opened the PILOT report in a new tab.' }; }); }}>PILOT report (PDF)</button>
        <button className="btn btn-sm ghost" title="The same report, borrower-safe (no capital-partner name, no fee/net, no photo GPS). Generating it shares it with the borrower." disabled={busy === 'repb' + draw.sitewire_draw_id}
          onClick={() => { if (!window.confirm('Share the borrower-safe report for this draw with the borrower? They’ll be able to see it in their portal.')) return; const w = window.open('', '_blank'); act('repb' + draw.sitewire_draw_id, async () => { await api.sitewireDrawReport(appId, draw.sitewire_draw_id, 'borrower', w); return { msg: 'Shared the borrower-safe report with the borrower (opened in a new tab).' }; }); }}>Borrower copy</button>
        {draw.pdf_src && <a className="btn btn-sm ghost" href={draw.pdf_src} target="_blank" rel="noreferrer">Sitewire PDF</a>}
      </div>

      {showPhotos && <InspectionGallery appId={appId} draw={draw} finding={finding} readsOff={readsOff} />}
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

/* Staff inspection review: the inspector's photos/videos + notes + approved/not-approved per line.
   Loads the LIVE findings from Sitewire (works before delivery, so staff can review before approving);
   falls back to the persisted findings (with media) if reads are off and findings were already delivered.
   This is the gap the standalone Draw-Management phase closes — staff could previously see only a count. */
function InspectionGallery({ appId, draw, finding, readsOff }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [archivedCount, setArchivedCount] = useState(null); // durable copies already in PILOT storage
  const [archiving, setArchiving] = useState(false);
  const [archiveMsg, setArchiveMsg] = useState('');
  const loadArchived = useCallback(() => {
    api.get(`/api/sitewire/files/${appId}/draws/${draw.sitewire_draw_id}/archived-media`)
      .then((r) => setArchivedCount(r.count || 0)).catch(() => {});
  }, [appId, draw.sitewire_draw_id]);
  useEffect(() => { loadArchived(); }, [loadArchived]);
  async function archive() {
    setArchiving(true); setArchiveMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/draws/${draw.sitewire_draw_id}/archive-media`, {});
      let m;
      if (r.archived) m = `Saved ${r.archived} file${r.archived === 1 ? '' : 's'} to PILOT — durable now and can be included in the report.${r.failed ? ` (${r.failed} couldn’t be downloaded.)` : ''}`;
      else if (r.failed) m = `Couldn’t download ${r.failed} file${r.failed === 1 ? '' : 's'} — the inspector’s links may have expired. Re-sync the draw, then try again.`;
      else if (r.skipped) m = 'Already saved to PILOT — nothing new to archive.';
      else m = 'Nothing to archive yet — deliver findings first, then archive.';
      setArchiveMsg(m);
      loadArchived();
    } catch (e) { setArchiveMsg(e?.data?.error || 'Could not archive — please try again.'); }
    finally { setArchiving(false); }
  }
  useEffect(() => {
    let live = true;
    setLoading(true); setErr('');
    const persisted = () => (finding
      ? api.get(`/api/sitewire/findings/${finding.id}`).then((d) => ({ lines: d.lines || [] }))
      : Promise.reject(new Error(readsOff
        ? 'Turn on Sitewire to load inspection photos (or deliver findings first).'
        : 'No inspection photos available for this draw yet.')));
    const p = readsOff
      ? persisted()
      : api.get(`/api/sitewire/files/${appId}/findings/${draw.sitewire_draw_id}`).catch(() => persisted());
    p.then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e?.data?.error || e.message || 'Could not load inspection photos'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [appId, draw.sitewire_draw_id, finding && finding.id, readsOff]);

  const lines = (data && data.lines) || [];
  const totalPhotos = lines.reduce((n, l) => n + (Array.isArray(l.media) ? l.media.filter((m) => m.type !== 'video').length : 0), 0);
  return (
    <div className="panel" style={{ marginTop: 8, background: 'var(--paper,#f6f3ec)' }}>
      <div className="row between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 }}>
        <div className="small"><b>Inspection review</b>{!loading && lines.length ? ` · ${totalPhotos} photo${totalPhotos === 1 ? '' : 's'} across ${lines.length} line${lines.length === 1 ? '' : 's'}` : ''}
          {archivedCount ? <span className="muted" style={{ marginLeft: 8, color: 'var(--good,#3f7a4a)' }}>✓ {archivedCount} saved to PILOT</span> : null}</div>
        <button className="btn btn-sm ghost" disabled={archiving} title="Download the inspector’s photos/videos into PILOT’s own storage so they never expire (and so they can go into the branded report)."
          onClick={archive}>{archiving ? 'Saving…' : 'Archive photos to PILOT'}</button>
      </div>
      {archiveMsg && <div className="muted small" style={{ marginBottom: 6 }}>{archiveMsg}</div>}
      {loading && <div className="muted small">Loading inspection photos…</div>}
      {err && !loading && <div className="muted small" style={{ color: 'var(--bad,#b04a3f)' }}>{err}</div>}
      {!loading && !err && lines.length === 0 && <div className="muted small">No inspection photos on this draw yet.</div>}
      {!loading && !err && lines.map((l, i) => {
        const media = Array.isArray(l.media) ? l.media : [];
        // Only show approved/not-approved once the DRAW is actually approved (decided). Before that every
        // line is under review — an undecided line must NOT read as a red "Not approved" rejection.
        const decided = draw.status === 'approved';
        const notAppr = l.not_approved_cents != null ? l.not_approved_cents : Math.max(0, (l.requested_cents || 0) - (l.approved_cents || 0));
        return (
          <div key={l.id || l.request_id || i} style={{ borderTop: '1px dashed var(--line,#e6e0d4)', paddingTop: 8, marginTop: 8 }}>
            <div className="row between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <div className="small"><b>{l.name || `Line ${l.job_item_id || l.sitewire_job_item_id || ''}`}</b></div>
              <div className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                Requested {usd2(l.requested_cents)}{decided
                  ? <> · Approved {usd2(l.approved_cents)}{notAppr > 0 ? <span style={{ color: 'var(--bad,#b04a3f)' }}> · Not approved {usd2(notAppr)}</span> : null}</>
                  : <> · {l.approved_cents ? `Approved ${usd2(l.approved_cents)}` : 'Awaiting your decision'}</>}
              </div>
            </div>
            {l.inspector_comments && <div className="small" style={{ marginTop: 3, fontStyle: 'italic' }}>Inspector: “{l.inspector_comments}”</div>}
            {media.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 6 }}>
                {media.map((m, j) => (
                  <a key={j} href={m.src} target="_blank" rel="noreferrer" title={[m.type === 'video' ? 'Video' : 'Photo', m.note || '', m.captured_at ? new Date(m.captured_at).toLocaleString('en-US') : '', (m.lat && m.lng) ? `${m.lat}, ${m.lng}` : ''].filter(Boolean).join(' · ')}
                    style={{ display: 'block', position: 'relative', aspectRatio: '4 / 3', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line,#e6e0d4)', background: '#000' }}>
                    {m.type === 'video'
                      ? <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12 }}>▶ Video</div>
                      : <img src={m.thumbnail || m.src} alt={l.name || 'inspection'} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  </a>
                ))}
              </div>
            ) : <div className="muted small" style={{ marginTop: 4 }}>No photos on this line.</div>}
          </div>
        );
      })}
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
  // Retainage is an OPT-IN feature (turned on per project in Draw settings); most projects don't hold
  // any. Show the retainage column/summary/preview ONLY when this project actually uses it — otherwise
  // it stays out of the ledger entirely.
  const showRetainage = !!(retainage && (pct > 0 || retainage.held_cents > 0 || retainage.holding_cents > 0));
  const approvedC = centsOrNull(f.approved); // null when the Approved box is blank/garbage
  const feeC = centsOrNull(f.fee) || 0;       // a $0 fee is legitimate
  const retC = Math.round((approvedC || 0) * pct / 100);
  const net = (approvedC || 0) - feeC - retC;
  async function save() {
    // A release must name its draw (audit F-2) — so the ledger, retainage pool and overdue monitor all bind
    // the release to exactly one draw. The server enforces this too; guarding here gives a clean message.
    if (!f.sitewire_draw_id) { setErr('Pick which draw this release is for.'); return; }
    if (approvedC == null || approvedC <= 0) { setErr('Enter the approved amount.'); return; }
    setBusy(true); setErr('');
    try {
      await api.post('/api/sitewire/disbursements', {
        application_id: appId, sitewire_draw_id: f.sitewire_draw_id,
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
      {showRetainage && (
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
            <thead><tr><th>Draw</th><th style={{ textAlign: 'right' }}>Approved</th><th style={{ textAlign: 'right' }}>Fee</th>{showRetainage && <th style={{ textAlign: 'right' }}>Retainage</th>}<th style={{ textAlign: 'right' }}>Net release</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>
              {ledger.map((d) => (
                <tr key={d.id}>
                  <td>{d.kind === 'retainage_release' ? 'Retainage' : (d.sitewire_draw_id ? 'Draw #' + (numByDraw[String(d.sitewire_draw_id)] ?? d.sitewire_draw_id) : '—')}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.approved_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.fee_cents)}</td>
                  {showRetainage && <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{usd2(d.retainage_held_cents)}</td>}
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
        <label className="small">Draw <span style={{ color: 'var(--bad,#b04a3f)' }}>*</span>
          <select className="input" value={f.sitewire_draw_id} onChange={(e) => setF({ ...f, sitewire_draw_id: e.target.value })}>
            <option value="">Select a draw…</option>
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
        <button className="btn btn-sm primary" disabled={busy || !f.sitewire_draw_id || approvedC == null || approvedC <= 0 || net < 0} onClick={save}>Record release</button>
      </div>
      {err && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 6 }}>{err}</div>}
    </div>
  );
}

function LienWaivers({ appId, enabled, fileOverride, canSetup, waivers, draws, onChanged }) {
  // Lien waivers are an OPT-IN feature most projects don't use — they're turned on per project from
  // the admin Draw settings, not here. So the desk shows this section ONLY when the project already
  // has them enabled (or waivers exist); otherwise it stays completely hidden (out of the workflow).
  if (!enabled && waivers.length === 0) return null;
  return (
    <div>
      {fileOverride === true && canSetup && (
        <div className="muted small" style={{ marginTop: 14, marginBottom: -6 }}>
          Lien waivers are on for this project — manage this in <a href="#/internal/draw-rules">Draw settings</a>.
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
  // friendly draw number (same mapping the ledger uses) so this table reads "Draw #1", not "#8001"
  const numByDraw = {};
  for (const d of (draws || [])) if (d.number != null) numByDraw[String(d.sitewire_draw_id)] = d.number;
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
                    <td>{w.sitewire_draw_id ? 'Draw #' + (numByDraw[String(w.sitewire_draw_id)] ?? w.sitewire_draw_id) : '—'}</td>
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

/* The draw coordinator's per-file email section — a professional, email-style list of every DRAW-related
   notification PILOT sent about this file (to the borrower or the team), each openable to see exactly who it
   went to, when, its delivery status and full content, plus the borrower's email replies. Scoped to draw items
   only. (Sitewire's own borrower emails aren't exposed by their API, so this is PILOT's own outbound + inbound
   trail.) */
const MAIL_KIND = {
  draw: { label: 'Draw released', tone: 'var(--good,#3f7a4a)' },
  draw_findings: { label: 'Inspection result', tone: 'var(--teal,#2f7f86)' },
  draw_accepted: { label: 'Borrower accepted', tone: 'var(--good,#3f7a4a)' },
  draw_disputed: { label: 'Borrower disputed', tone: 'var(--bad,#b04a3f)' },
  draw_dispute_resolved: { label: 'Dispute resolved', tone: 'var(--good,#3f7a4a)' },
  sow_change_request: { label: 'Budget change', tone: 'var(--gold,#ae8746)' },
  sow_reallocation: { label: 'Budget change', tone: 'var(--gold,#ae8746)' },
};
const EMAIL_STATE = { sent: { label: 'Emailed', cls: 'sw-approved' }, skipped: { label: 'In-app only', cls: 'sw-draft' }, error: { label: 'Email failed', cls: 'sw-pending' }, pending: { label: 'Sending…', cls: 'sw-draft' } };
function DrawMailCenter({ appId }) {
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [full, setFull] = useState({}); // notificationId -> { loading?, email?, error? }
  const [fullscreen, setFullscreen] = useState(false);
  const load = useCallback(() => api.get(`/api/sitewire/files/${appId}/notifications`).then(setData).catch(() => setData({ sent: [], replies: [] })), [appId]);
  useEffect(() => { load(); }, [load]);
  const openMessage = useCallback((m) => {
    const id = m.id;
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (m.has_full_email && !full[id]) {
      setFull((s) => ({ ...s, [id]: { loading: true } }));
      api.get(`/api/sitewire/files/${appId}/messages/${id}`)
        .then((email) => setFull((s) => ({ ...s, [id]: { email } })))
        .catch(() => setFull((s) => ({ ...s, [id]: { error: true } })));
    }
  }, [appId, openId, full]);
  if (!data) return <div className="dd-card" style={{ marginTop: 18 }}>Loading draw messages…</div>;
  const sent = data.sent || [];
  const replies = data.replies || [];
  const when = (v) => (v ? new Date(v).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  // The message list + replies + composer — rendered both inline and (bigger) in the full-screen inbox.
  const inbox = (frameH) => (
    <>
      {sent.length === 0 && replies.length === 0 && <div className="dd-sub" style={{ marginTop: 8 }}>No draw messages have gone out on this file yet — send the first one below.</div>}
      <div style={{ marginTop: 6 }}>
        {sent.map((m) => {
          const k = MAIL_KIND[m.type] || { label: m.type, tone: 'var(--text-muted)' };
          const es = EMAIL_STATE[m.email_status] || EMAIL_STATE.pending;
          const isOpen = openId === m.id;
          const toWhom = m.recipient_kind === 'borrower' ? `Borrower${m.recipient_name ? ` · ${m.recipient_name}` : ''}` : `Team${m.recipient_name ? ` · ${m.recipient_name}` : ''}`;
          const fe = full[m.id];
          return (
            <div key={m.id} style={{ borderTop: '1px solid var(--line)' }}>
              <button onClick={() => openMessage(m)} className="row" style={{ width: '100%', textAlign: 'left', gap: 10, alignItems: 'center', padding: '10px 2px', background: isOpen ? 'var(--paper,#f6f3ec)' : 'none', border: 'none', cursor: 'pointer' }}>
                <span style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: 999, background: k.tone }} />
                <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <span className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 13 }}>{m.title}</b>
                    <span className="dd-sub" style={{ color: k.tone }}>{k.label}</span>
                    {m.attachment_count > 0 && <span className="dd-sub" title="has attachments">📎 {m.attachment_count}</span>}
                  </span>
                  <span className="dd-sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>To: {toWhom}{m.recipient_count > 1 ? ` +${m.recipient_count - 1}` : ''}{m.recipient_email ? ` · ${m.recipient_email}` : ''}</span>
                </span>
                <span className="dd-sub" style={{ flex: '0 0 auto', textAlign: 'right' }}>
                  <span className={'pill ' + es.cls} style={{ marginRight: 6 }}>{es.label}</span>
                  {when(m.created_at)}
                </span>
              </button>
              {isOpen && (
                <div style={{ padding: '0 2px 14px 18px' }}>
                  {m.has_full_email && fe && fe.loading && <div className="dd-sub">Opening the full email…</div>}
                  {m.has_full_email && fe && fe.email && (
                    <>
                      <div style={{ background: 'var(--paper,#f6f3ec)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', marginBottom: 8, fontSize: 12.5 }}>
                        <div><b>Subject:</b> {fe.email.subject || m.title}</div>
                        <div><b>To:</b> {(fe.email.to || []).join(', ') || '—'}</div>
                        {fe.email.from && <div><b>From:</b> {fe.email.from}</div>}
                        {fe.email.reply_to && <div><b>Reply-to:</b> {fe.email.reply_to}</div>}
                        <div><b>Sent:</b> {when(fe.email.created_at)} · {fe.email.status === 'sent' ? 'delivered by email' : fe.email.status === 'skipped' ? 'in-app only (not emailed)' : fe.email.status === 'error' ? 'email failed' : fe.email.status}</div>
                        {Array.isArray(fe.email.attachments) && fe.email.attachments.length > 0 && (
                          <div style={{ marginTop: 6 }}><b>Attachments:</b>{' '}
                            {fe.email.attachments.map((a) => (
                              <span key={a.index} className="row" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginRight: 8 }}>
                                {a.downloadable
                                  ? <button className="btn btn-sm ghost" onClick={() => api.sitewireMessageAttachment(appId, m.id, a.index).catch(() => {})}>📎 {a.filename}</button>
                                  : <span className="dd-sub">📎 {a.filename}</span>}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      {fe.email.html
                        ? <iframe title="email" sandbox="" srcDoc={fe.email.html} style={{ width: '100%', height: frameH, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
                        : <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>{fe.email.text || m.body}</div>}
                    </>
                  )}
                  {m.has_full_email && fe && fe.error && <div className="dd-sub" style={{ color: 'var(--bad,#b04a3f)' }}>Could not open the full email.</div>}
                  {!m.has_full_email && (
                    <>
                      <div className="dd-sub" style={{ marginBottom: 6 }}>
                        Sent {when(m.emailed_at || m.created_at)} · {m.email_status === 'sent' ? 'delivered by email' : m.email_status === 'skipped' ? 'shown in the portal only' : m.email_status === 'error' ? 'email failed to send' : 'sending'}{m.read_at ? ' · read' : ''} · (full design not captured for older messages)
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, background: 'var(--paper,#f6f3ec)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px' }}>{m.body || '(no message body)'}</div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {replies.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <div className="dd-field-l" style={{ textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 11, marginBottom: 8 }}>Replies received from the borrower</div>
          {replies.map((r) => (
            <div key={r.id} className="row" style={{ gap: 10, alignItems: 'baseline', padding: '6px 0' }}>
              <span className="dd-card-ic" style={{ width: 24, height: 24, background: 'var(--primary-soft)' }}><SdIcon name="reply" /></span>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <b style={{ fontSize: 13 }}>{r.subject || '(no subject)'}</b>
                <span className="dd-sub" style={{ display: 'block' }}>From: {r.from_email}{r.forwarded_count ? ` · forwarded to ${r.forwarded_count}` : ''}</span>
              </span>
              <span className="dd-sub" style={{ flex: '0 0 auto' }}>{when(r.created_at)}</span>
            </div>
          ))}
        </div>
      )}

      {/* reply / compose — a direct message to the borrower, sent + captured here */}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
        <ReplyComposer appId={appId} onSent={load} />
      </div>
    </>
  );

  const header = (inFull) => (
    <div className="dd-card-h" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center' }}>
        <span className="dd-card-ic"><SdIcon name="mail" /></span>
        <div>
          <h3>Draw messages</h3>
          {!inFull && <div className="dd-sub" style={{ marginTop: 1 }}>Everything on this file’s draw — the draw start, results, releases, messages you send, and the borrower’s replies. Open any to see the whole email; reply right from here.</div>}
        </div>
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="dd-sub">{sent.length} sent{replies.length ? ` · ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` : ''}</span>
        {inFull
          ? <button className="btn btn-sm ghost" onClick={() => setFullscreen(false)}>✕ Close</button>
          : <button className="btn btn-sm ghost" onClick={() => setFullscreen(true)} title="Open the full-screen inbox">⛶ Full screen</button>}
      </div>
    </div>
  );

  return (
    <>
      <div className="dd-card" style={{ marginTop: 18 }}>
        {header(false)}
        {inbox(420)}
      </div>
      {fullscreen && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(20,27,34,.5)', zIndex: 1000, display: 'flex', padding: '2.5vh 2.5vw' }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 1040, margin: '0 auto', display: 'flex', flexDirection: 'column', maxHeight: '95vh', overflow: 'hidden', boxShadow: '0 20px 60px rgba(20,27,34,.3)' }}>
            <div style={{ padding: '4px 18px', borderBottom: '1px solid var(--line)', flex: '0 0 auto' }}>{header(true)}</div>
            <div style={{ overflowY: 'auto', padding: '8px 18px 20px' }}>{inbox(620)}</div>
          </div>
        </div>
      )}
    </>
  );
}

/* Compose + send a direct message to the borrower from the draw box — it emails the borrower (borrower-safe),
   logs + captures the email so it appears in the thread, and the borrower's reply comes back into "Replies". */
function ReplyComposer({ appId, onSent }) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function send() {
    if (!body.trim()) { setMsg('Type a message first.'); return; }
    setBusy(true); setMsg('');
    try {
      await api.post(`/api/sitewire/files/${appId}/messages/reply`, { body: body.trim(), subject: subject.trim() || undefined });
      setBody(''); setSubject(''); setOpen(false);
      if (onSent) onSent();
    } catch (e) { setMsg(e?.data?.error || e.message || 'Could not send your message.'); }
    finally { setBusy(false); }
  }
  if (!open) return <button className="btn btn-sm primary" onClick={() => setOpen(true)}>✉️ Message the borrower</button>;
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, background: '#fff' }}>
      <div className="dd-field-l" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>New message to the borrower</div>
      <input className="input" style={{ width: '100%', marginBottom: 6 }} placeholder="Subject (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea className="input" style={{ width: '100%', resize: 'vertical', minHeight: 90 }} rows={4} placeholder="Write a message about the draw…" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send to borrower'}</button>
        <button className="btn btn-sm ghost" onClick={() => { setOpen(false); setMsg(''); }}>Cancel</button>
        {msg && <span className="dd-sub" style={{ color: 'var(--bad,#b04a3f)' }}>{msg}</span>}
      </div>
      <div className="dd-sub" style={{ marginTop: 6 }}>Emails the borrower and appears in this thread. Their reply comes back to your team inbox and shows under “Replies received”. (No capital-partner names ever reach the borrower.)</div>
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
              <span className="muted small" style={{ minWidth: 130, fontVariantNumeric: 'tabular-nums' }}>{a.date_only ? fmtDay(a.at) : new Date(a.at).toLocaleString('en-US')}</span>
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
