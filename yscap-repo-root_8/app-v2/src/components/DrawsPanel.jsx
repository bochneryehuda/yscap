import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import EmailCenter from './EmailCenter.jsx';
import FileSections, { Section } from './FileSections.jsx';

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
const fmtDay = (v) => {   // MM/DD/YYYY (industry standard), shift-free for date-only values
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
};
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

  const { rollup, link, requests = [], ledger = [], findings = [], change_requests = [], retainage = null, oop = null, waivers = [], lien_waivers_enabled = false,
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

  // The left section rail for the (linked) draw desk — grouped like the loan file.
  const drawSections = [
    { id: 'dsec-overview', label: 'Overview', group: 'Draw' },
    { id: 'dsec-draws', label: 'Draws', group: 'Draw', badge: draws.length || '' },
    { id: 'dsec-sow', label: 'Scope of Work', group: 'Draw' },
    { id: 'dsec-ledger', label: 'Money ledger', group: 'Money' },
    { id: 'dsec-waivers', label: 'Retainage & waivers', group: 'Money' },
    { id: 'dsec-request', label: 'Draw request & wire', group: 'Communication' },
    { id: 'dsec-emails', label: 'Emails & activity', group: 'Communication' },
    { id: 'dsec-docs', label: 'Documents & borrower', group: 'Communication' },
    { id: 'dsec-changes', label: 'Change requests', group: 'Manage' },
    { id: 'dsec-controls', label: 'Sitewire controls', group: 'Manage' },
    { id: 'dsec-lifecycle', label: 'Project status', group: 'Manage' },
  ];

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
          <TrustpointPanel appId={appId} />
          <PortalDrawsCard appId={appId} />
          {/* Send the DocuSign Draw Request & Wire Instructions form right from the start-draw screen. */}
          <DrawRequestCard appId={appId} />
          {/* The draw email center is visible on the construction-draw screen even BEFORE the file is
              pushed to Sitewire — the draw-request form + any early draw messages already show here. */}
          <DrawEmailCenter appId={appId} />
        </>
      ) : (
        <>
          {msg && <div className="dd-card" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)' }}>{msg}</div>}
          <TrustpointPanel appId={appId} />
          <PortalDrawsCard appId={appId} />

          {/* Redesigned draw desk: a sticky left section rail (like the loan file) + collapsible sections,
              so the whole draw process is scannable without endless scrolling. Each section opens on demand;
              a rail click jumps to it and expands it. */}
          <FileSections sections={drawSections}>
            {/* OVERVIEW — always open: status chips + released-vs-remaining meter + KPI row. */}
            <Section id="dsec-overview" title="Overview" collapsible={false}>
              <div className="dd-card">
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
                <div className="dd-hero-meter-top" style={{ marginTop: 10 }}>
                  <span className="dd-hero-label">Released vs. remaining</span>
                  <span className="dd-hero-pct">{pct}%</span>
                </div>
                <div className="dd-meter" style={{ height: 12 }} role="img" aria-label={`${pct}% of the construction budget released`}><i style={{ width: pct + '%' }} /></div>
                <div style={{ marginTop: 16, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gridAutoRows: '1fr' }}>
                  {/* "Remaining" used to be budget − RELEASED, so a draw the inspector had fully
                      approved left the entire budget showing as still available. It now counts a
                      not-yet-final draw as spent — the owner's rule: treat it as approved, and if it
                      is amended or declined it all goes back to available. */}
                  <KpiTile label="Construction budget" value={usd(rollup.project.budget)} />
                  <KpiTile label="Released" value={usd(rollup.project.drawn)} sub={`${pct}% released`} tone="teal" />
                  <KpiTile label="Approved, not yet released" value={usd(Math.max(0, (rollup.project.committed ?? rollup.project.drawn) - rollup.project.drawn))} sub="counts against the budget" />
                  <KpiTile label="Still available" value={usd(rollup.project.available ?? rollup.project.remaining)} tone="gold" />
                </div>
              </div>
              {writesOff && (
                <div className="dd-card" style={{ marginTop: 12, borderLeft: '3px solid var(--gold,#ae8746)' }}>
                  <b>Sitewire is turned off.</b>
                  <div className="dd-sub" style={{ marginTop: 3 }}>
                    Approving a draw syncs to Sitewire, so <b>Approve / Amend / Reopen</b>, setting approved amounts{readsOff ? ' and delivering findings' : ''} are paused until it's switched on{sw.enabled && !sw.outbound ? ' (reads are on; writing is still off)' : ''}. The money ledger, releases and records are kept in PILOT and still work.
                  </div>
                </div>
              )}
            </Section>

            {/* DRAWS — the main content, open by default. */}
            <Section id="dsec-draws" title="Draws" defaultOpen badge={draws.length || null}
              action={draws.length > 0 ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm ghost" title="A PILOT-branded PDF of the whole construction project — schedule of values + every draw's inspection photos + notes."
                    onClick={() => { const w = window.open('', '_blank'); act('projreport', async () => { await api.sitewireProjectReport(appId, 'staff', w); return { msg: 'Opened the whole-project report in a new tab.' }; }); }}>
                    Whole-project report
                  </button>
                  <button className="btn btn-sm ghost" title="The same whole-project report, borrower-safe: no capital-partner name and no photo locations. It DOES show the draw processing fee that comes out of their money — never our fee income across the project. Generating it shares it with the borrower."
                    onClick={() => { if (!window.confirm('Share the borrower-safe whole-project report with the borrower? They’ll be able to see it in their portal.')) return; const w = window.open('', '_blank'); act('projreportb', async () => { await api.sitewireProjectReport(appId, 'borrower', w); return { msg: 'Shared the borrower-safe whole-project report with the borrower.' }; }); }}>
                    Borrower copy
                  </button>
                </div>
              ) : null}>
              {draws.length === 0 && <div className="muted">No draws yet on this file.</div>}
              {draws.map((d) => (
                <DrawCard key={d.sitewire_draw_id} appId={appId} draw={d} requests={reqsByDraw[d.sitewire_draw_id] || []}
                  finding={findingByDraw[d.sitewire_draw_id]} busy={busy} act={act} reload={load} writesOff={writesOff} readsOff={readsOff} quickStatuses={quickStatuses} />
              ))}
            </Section>

            {/* SCOPE OF WORK — budget vs. drawn rollup + (super-admin) line wording/description editor. */}
            <Section id="dsec-sow" title="Scope of Work — budget vs. drawn" defaultOpen={false}>
              <div className="dd-card" style={{ padding: 0, overflow: 'hidden' }}><RollupTable rollup={rollup} /></div>
              <SowLineEditor appId={appId} />
            </Section>

            {/* MONEY — the ledger + retainage/waivers. */}
            <Section id="dsec-ledger" title="Money ledger" defaultOpen={false}>
              <LedgerPanel appId={appId} ledger={ledger} draws={draws} retainage={retainage} oop={oop} fees={rollup.fees || null} onSaved={load} act={act} busy={busy} />
            </Section>
            <Section id="dsec-waivers" title="Retainage & lien waivers" defaultOpen={false}>
              <LienWaivers appId={appId} enabled={lien_waivers_enabled} fileOverride={data.lien_waivers_file_override}
                canSetup={can('platform_setup')} waivers={waivers} draws={draws} onChanged={load} />
            </Section>

            {/* COMMUNICATION — draw request/wire, the unified email + activity, docs + borrower invite. */}
            <Section id="dsec-request" title="Draw request & wire instructions" defaultOpen={false}>
              <DrawRequestCard appId={appId} />
            </Section>
            <Section id="dsec-emails" title="Emails & activity" defaultOpen={false}>
              <DrawEmailCenter appId={appId} />
            </Section>
            <Section id="dsec-docs" title="Documents & borrower invite" defaultOpen={false}>
              <BorrowerInviteStatus appId={appId} writesOff={writesOff} readsOff={readsOff} />
              <SitewireDocumentPush appId={appId} writesOff={writesOff} />
              <SitewireDocuments appId={appId} readsOff={readsOff} />
            </Section>

            {/* MANAGE — reallocations, project status + controls. */}
            <Section id="dsec-changes" title="Scope-of-Work change requests" defaultOpen={false}>
              <ChangeRequests appId={appId} items={change_requests} busy={busy} act={act} />
            </Section>
            <Section id="dsec-controls" title="Sitewire property controls" defaultOpen={false}>
              <SitewirePropertyControls appId={appId} onChanged={load} />
            </Section>
            <Section id="dsec-lifecycle" title="Project status & controls" defaultOpen={false}>
              <LifecycleControl appId={appId} link={link} writesOff={writesOff} onChanged={load} />
              <ActivityTrail appId={appId} />
              <ResetDrawControl appId={appId} onChanged={load} />
            </Section>
          </FileSections>
        </>
      )}
    </div>
  );
}

/* Draw Request & Wire Instructions — sent to the borrower through the existing DocuSign
   integration (owner-directed 2026-07-20). MOST of the form auto-fills from the file; the
   borrower fills the WIRE INSTRUCTIONS in fillable boxes and signs. On completion the signed
   PDF files back to the "Signed draw request form" draw condition AND the typed wire details
   are captured here (masked account number). If the wire account name is a NEW entity (not the
   borrower and not the subject LLC), a FATAL operating-agreement condition is opened. */
// A SHORT verdict for the chip (a pill can't wrap, so it must fit a phone) — the full explanation
// for a new entity lives in the operating-agreement block right below the card.
const WIRE_KIND = {
  borrower_personal: { label: 'Borrower’s account', tone: 'on' },
  subject_llc: { label: 'Subject LLC account', tone: 'on' },
  // A known entity of the borrower (on their profile / library) — not the file's linked
  // subject LLC, but not an unknown third party either, so no operating agreement is needed.
  known_entity: { label: 'Borrower’s entity', tone: 'on' },
  new_entity: { label: 'New entity', tone: 'off' },
  unknown: { label: 'Not provided', tone: 'warn' },
};
function DrawRequestCard({ appId }) {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [recipient, setRecipient] = useState('borrower'); // who signs the wire form: borrower | co_borrower
  const reload = useCallback(() => {
    api.get(`/api/sitewire/files/${appId}/draw-request`)
      .then((r) => setD(r)).catch(() => setD(null)).finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { reload(); }, [reload]);
  if (loading || !d) return null;
  const opts = d.recipient_options || {};
  const coBorrower = opts.coBorrower && opts.coBorrower.email ? opts.coBorrower : null;

  const env = d.envelope, wire = d.wire, oa = d.operating_agreement, prereqs = d.prereqs || {};
  const terminal = env && env.terminal;
  const missing = [];
  if (!prereqs.funded) missing.push('the loan to be funded');
  if (!prereqs.loan_number) missing.push('a loan number');
  if (!prereqs.address) missing.push('a property address');

  async function send(reissue) {
    setBusy(true); setMsg('');
    try {
      const who = coBorrower && recipient === 'co_borrower' ? 'co_borrower' : 'borrower';
      const r = await api.post(`/api/sitewire/files/${appId}/draw-request/send`, { ...(reissue ? { reissue: true } : {}), recipient: who });
      const toName = who === 'co_borrower' ? (coBorrower.name || 'the co-borrower') : 'the borrower';
      setMsg(r && r.ok ? `Sent to ${toName} for signature. Their wire details will appear here once they sign.` : (r && r.note) || 'The draw request is queued to send.');
      reload();
    } catch (e) { setMsg((e && e.data && e.data.error) || e.message || 'Could not send the draw request.'); }
    finally { setBusy(false); }
  }
  async function openSigned(id) {
    try { const { blob } = await api.staffDownloadDoc(id); const url = URL.createObjectURL(blob); window.open(url, '_blank'); }
    catch (_) { setMsg('Could not open the signed form.'); }
  }

  const envLabel = env ? ({
    sent: 'Sent — awaiting the borrower', delivered: 'Opened by the borrower',
    completed: 'Signed', declined: 'Declined by the borrower', voided: 'Voided',
  }[String(env.status)] || env.status) : null;

  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="mail" /></span>
          <div>
            <h3>Draw request &amp; wire instructions</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>Send the borrower a pre-filled form via DocuSign — they enter their bank wire instructions and sign. Their wire details are saved here automatically.</div>
          </div>
        </div>
        {env && <span className={'dd-chip ' + (env.status === 'completed' ? 'on' : env.status === 'declined' || env.status === 'voided' ? 'off' : 'warn')}><span className="dot" />{envLabel}</span>}
      </div>

      {!d.docusign_enabled && (
        <div className="dd-sub" style={{ marginTop: 8, color: 'var(--gold,#ae8746)' }}>DocuSign sending is turned off. Turn on <code>DOCUSIGN_SEND_ENABLED</code> to send this form.</div>
      )}
      {d.docusign_enabled && d.docusign_test_mode && (
        <div className="dd-sub" style={{ marginTop: 8 }}>DocuSign is in <b>test mode</b> — only allow-listed test emails receive the form.</div>
      )}
      {missing.length > 0 && <div className="dd-sub" style={{ marginTop: 8 }}>This file still needs {missing.join(', ')} before the draw request can go out.</div>}

      {msg && <div className="dd-sub" style={{ marginTop: 8 }}>{msg}</div>}

      {/* recipient progress */}
      {env && d.recipients && d.recipients.length > 0 && (
        <div className="dd-sub" style={{ marginTop: 8 }}>
          {d.recipients.map((r, i) => (
            <div key={i}>{r.name}: {r.signed_at ? `signed ${fmtDay(r.signed_at)}` : r.viewed_at ? 'opened, not yet signed' : 'sent, not yet opened'}</div>
          ))}
        </div>
      )}

      {/* WIRE INSTRUCTIONS — redesigned (owner-directed 2026-08-05). The account name (where the
          money goes) leads, with its verdict chip; the bank details sit in a clean grid below. */}
      {wire && (
        <div className="act-card" style={{ marginTop: 12 }}>
          <div className="act-card-head">
            <div style={{ minWidth: 200, flex: 1 }}>
              <div className="act-card-title">Where this draw’s money goes</div>
              <div className="act-card-sub">The borrower’s wire instructions, captured from the signed form.</div>
            </div>
            <span className={'dd-chip ' + (WIRE_KIND[wire.name_kind] || WIRE_KIND.unknown).tone}>
              <span className="dot" />{(WIRE_KIND[wire.name_kind] || WIRE_KIND.unknown).label}
            </span>
          </div>

          <div style={{ marginTop: 12 }}>
            <div className="act-label" style={{ display: 'block' }}>Account name</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>{wire.account_name || '—'}</div>
          </div>

          <div style={{ marginTop: 12, display: 'grid', gap: '11px 18px', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <WireField k="Bank" v={wire.bank_name} />
            <WireField k="Account number" v={wire.account_number_masked} mono />
            <WireField k="Routing / ABA" v={wire.routing_number} mono />
            <WireField k="Bank address" v={wire.bank_address} />
            <WireField k="Account holder address" v={wire.account_address} />
          </div>

          {wire.captured_at && <div className="act-card-sub" style={{ marginTop: 12 }}>Captured {fmtDay(wire.captured_at)} from the signed form.</div>}
        </div>
      )}

      {/* Operating agreement — the new-entity slot + its progress (Task 5) */}
      {oa && (
        <div className="act-card" style={{ marginTop: 10, borderLeft: '3px solid ' + (oa.satisfied ? 'var(--success,#2E7A5E)' : 'var(--danger,#A32A2A)') }}>
          <div className="act-card-title">
            {oa.satisfied ? 'Operating agreement — collected' : 'Operating agreement required before releasing this wire'}
          </div>
          <div className="act-card-sub" style={{ marginTop: 3 }}>
            {oa.satisfied
              ? 'The wire entity’s operating agreement has been collected, and the entity is saved to the borrower’s profile for the future.'
              : 'The wire account name is a company that isn’t the borrower or the subject LLC. Collect that entity’s operating agreement — and confirm its authority to receive funds — before any wire is released.'}
          </div>
          {!oa.satisfied && (
            <div className="act-card-sub" style={{ marginTop: 6 }}>
              {oa.doc_accepted > 0
                ? <span style={{ color: 'var(--success,#2E7A5E)' }}>An operating agreement has been accepted — sign off the condition to clear it. It has been saved to the entity on the borrower’s profile.</span>
                : oa.doc_total > 0
                  ? <span style={{ color: 'var(--warning,#B07A1E)' }}>An operating agreement is on the condition, waiting to be reviewed.</span>
                  : <span style={{ color: 'var(--muted)' }}>No operating agreement on file yet — upload it on the condition, or it is pulled automatically if the borrower already has this entity on their profile.</span>}
            </div>
          )}
        </div>
      )}

      {/* signed PDF */}
      {d.signed_document && (
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-sm ghost" onClick={() => openSigned(d.signed_document.id)}>View the signed form (PDF)</button>
        </div>
      )}

      {/* recipient chooser — only when there's a co-borrower to choose (owner-directed 2026-07-21) */}
      {coBorrower && (!env || terminal) && (
        <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="dd-sub">Send the form to:</span>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className={'btn btn-sm ' + (recipient === 'borrower' ? '' : 'ghost')} onClick={() => setRecipient('borrower')}>
              {(opts.borrower && opts.borrower.name) || 'Borrower'}
            </button>
            <button className={'btn btn-sm ' + (recipient === 'co_borrower' ? '' : 'ghost')} onClick={() => setRecipient('co_borrower')}>
              {coBorrower.name || 'Co-borrower'} <span className="dd-sub">(co-borrower)</span>
            </button>
          </div>
        </div>
      )}

      {/* the action button */}
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {(!env || terminal) && (
          <button className="btn" disabled={busy || !d.can_send} onClick={() => send(terminal)}
            title={!d.docusign_enabled ? 'DocuSign sending is turned off' : missing.length ? 'Complete the file first' : ''}>
            {busy ? 'Sending…' : terminal ? 'Re-send draw request form' : 'Send draw request form (DocuSign)'}
          </button>
        )}
        {env && !terminal && <span className="dd-sub">The form is out for signature. You can re-send once it’s completed, declined, or voided.</span>}
      </div>
    </div>
  );
}
// One wire detail — a small uppercase label above the value, so long values (addresses) read
// cleanly and the grid never has to right-align a wrapping string.
function WireField({ k, v, mono }) {
  return (
    <div>
      <div className="act-label" style={{ display: 'block' }}>{k}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: v ? 'var(--text)' : 'var(--muted)', marginTop: 2,
        fontVariantNumeric: mono ? 'tabular-nums' : undefined, wordBreak: 'break-word' }}>{v || '—'}</div>
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

/* One control row (label + live status line + action button) on the Sitewire controls card. */
function ControlRow({ title, status, statusTone, sub, btnLabel, busy, disabled, onClick }) {
  return (
    <div className="row between" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--hairline,#e7e0d4)' }}>
      <div style={{ minWidth: 200, flex: '1 1 260px' }}>
        <div><b>{title}</b>{status ? <> — <span style={{ color: statusTone || 'var(--text)' }}>{status}</span></> : null}</div>
        {sub && <div className="dd-sub" style={{ marginTop: 1 }}>{sub}</div>}
      </div>
      {btnLabel && (
        <button className="btn btn-sm ghost" style={{ flex: '0 0 auto' }} disabled={disabled} onClick={onClick}>
          {busy ? 'Saving…' : btnLabel}
        </button>
      )}
    </div>
  );
}

/* Sitewire PROPERTY CONTROLS from the PILOT desk (owner-directed 2026-07-21 — "ALL features that we have in
   Sitewire… control the entire process from our system"). Reads the LIVE Sitewire property and offers ALL FOUR
   controls, each a real guarded write that reads back what it wrote (never a fake button). Field names use the
   OFFICIAL Sitewire API v2 spec (never guessed): property.inactive, property.require_sitewire_inspector
   (Sitewire GC↔in-house review), property.inspection_method, property.processing_fee_cents, and
   budget.draw_eligible (Block Draws — lives on the budget, not the property). Mirrors Sitewire's screen: when
   the property is INACTIVE the other controls collapse (only Reactivate shows), exactly as Sitewire does. */
const INSP_LABEL = { mobile: 'Virtual (Sitewire mobile app)', traditional: 'On-site (in person)' };
function SitewirePropertyControls({ appId, onChanged }) {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [feeEdit, setFeeEdit] = useState(false);
  const [feeInput, setFeeInput] = useState('');
  const loadIt = useCallback(() => {
    setLoading(true);
    api.get(`/api/sitewire/files/${appId}/sitewire-property`)
      .then(setD).catch(() => setD(null)).finally(() => setLoading(false));
  }, [appId]);
  useEffect(() => { loadIt(); }, [loadIt]);

  async function apply(changes, key, done) {
    setBusy(key); setMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/property-settings`, changes);
      const note = r.sitewire === 'synced' ? ' Saved in Sitewire.' : r.sitewire === 'dryrun' ? ' (dry-run — nothing sent to Sitewire.)' : ' Sent to Sitewire (confirming…).';
      setMsg((done || 'Updated.') + note);
      loadIt(); if (onChanged) onChanged();
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); }
    finally { setBusy(''); }
  }
  const confirmApply = (question, changes, key, done) => { if (!window.confirm(question)) return; apply(changes, key, done); };

  if (loading) return <div className="dd-card" style={{ marginTop: 12 }}>Loading Sitewire settings…</div>;
  if (!d) return null;
  const sw = d.switches || {};
  const off = !(sw.enabled && sw.outbound); // Sitewire writing off → disable the buttons

  // Not a PILOT-managed property, or the connection is off — say so plainly, don't show dead buttons.
  if (!d.available) {
    if (d.reason === 'not_managed') return null; // the Start-draw / preexisting cards already explain this
    return (
      <div className="dd-card" style={{ marginTop: 12 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="settings" /></span>
          <div>
            <b>Sitewire property controls</b>
            <div className="dd-sub" style={{ marginTop: 1 }}>
              {d.reason === 'off' ? 'The Sitewire connection is turned off, so its live settings can’t be shown right now.' : 'Couldn’t read the property from Sitewire right now — try again shortly.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const prop = d.property || {};
  const active = prop.inactive !== true;                 // property.inactive boolean → active = not inactive
  // Draws-allowed lives on the BUDGET (budget.draw_eligible); default allowed. Sitewire-vs-in-house review is
  // property.require_sitewire_inspector (default false = in-house). Both are read straight off the live property.
  const drawsAllowed = !(prop.budget && prop.budget.draw_eligible === false);
  const sitewireReview = prop.require_sitewire_inspector === true;
  const insp = d.inspection || {};
  const method = insp.method || prop.inspection_method || 'mobile';
  const canSwitch = insp.can_switch !== false;
  const otherMethod = method === 'mobile' ? 'traditional' : 'mobile';
  const feeCents = insp.fee_cents != null ? Number(insp.fee_cents) : null;
  function saveFee() {
    const dollars = Number(feeInput);
    if (!Number.isFinite(dollars) || dollars < 0 || dollars > 100000) { setMsg('Enter a fee between $0 and $100,000.'); return; }
    setFeeEdit(false);
    apply({ fee_cents: Math.round(dollars * 100) }, 'fee', 'Draw fee updated.');
  }

  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
        <span className="dd-card-ic"><SdIcon name="settings" /></span>
        <div>
          <b>Sitewire property controls</b>
          <div className="dd-sub" style={{ marginTop: 1 }}>Change these here instead of logging into Sitewire — each one is sent straight to Sitewire and read back to confirm it took.</div>
        </div>
      </div>

      {/* VISIBILITY — Active ↔ Inactive (Sitewire "Mark Inactive" / "Reactivate") */}
      <ControlRow
        title={active ? 'Active' : 'Inactive'}
        status={active ? 'Visible everywhere, appears in search results' : 'Hidden from web and mobile apps, blocks draws'}
        statusTone={active ? 'var(--success,#3f7a4a)' : 'var(--text-muted)'}
        btnLabel={active ? 'Mark Inactive' : 'Reactivate'}
        busy={busy === 'inactive'} disabled={off || busy === 'inactive'}
        onClick={() => confirmApply(
          active ? 'Mark this property INACTIVE in Sitewire? It’s hidden and no new draws can be submitted.' : 'Reactivate this property in Sitewire so it’s visible and can accept draws again?',
          { inactive: active }, 'inactive', active ? 'Marked property inactive.' : 'Property reactivated.')}
      />

      {/* When INACTIVE the rest collapses — mirroring Sitewire's own screen (nothing else to control). */}
      {!active ? (
        <div className="dd-sub" style={{ marginTop: 8 }}>The other controls appear once the property is active again.</div>
      ) : (
        <>
          {/* DRAWS — Allowed ↔ Blocked (budget.draw_eligible) */}
          <ControlRow
            title={drawsAllowed ? 'Draws Allowed' : 'Draws Blocked'}
            status={drawsAllowed ? 'Borrower can submit draws' : 'Borrower cannot submit draws'}
            statusTone={drawsAllowed ? 'var(--success,#3f7a4a)' : 'var(--gold,#ae8746)'}
            btnLabel={drawsAllowed ? 'Block Draws' : 'Allow Draws'}
            busy={busy === 'draws'} disabled={off || busy === 'draws'}
            onClick={() => confirmApply(
              drawsAllowed ? 'Block draws on this property? The borrower won’t be able to submit any new draws.' : 'Allow draws on this property again?',
              { draw_eligible: !drawsAllowed }, 'draws', drawsAllowed ? 'Blocked draws.' : 'Draws allowed.')}
          />

          {/* INSPECTION — Virtual/mobile ↔ On-site/traditional */}
          <ControlRow
            title={method === 'mobile' ? 'Virtual Inspection' : 'Onsite Inspection'}
            status={method === 'mobile' ? 'Capture using the Sitewire mobile app' : 'Use preferred field inspector'}
            sub={canSwitch ? null : 'The capital partner sets this — it can’t be switched for this file.'}
            btnLabel={canSwitch ? (method === 'mobile' ? 'Change to Onsite' : 'Change to Virtual') : null}
            busy={busy === 'method'} disabled={off || busy === 'method'}
            onClick={() => confirmApply(`Change the inspection type to ${INSP_LABEL[otherMethod]}?`, { inspection_method: otherMethod }, 'method', `Switched to ${INSP_LABEL[otherMethod]}.`)}
          />

          {/* DRAW FEE — change the processing fee after the property is pushed; syncs to Sitewire. */}
          <div className="row between" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--hairline,#e7e0d4)' }}>
            <div style={{ minWidth: 200, flex: '1 1 260px' }}>
              <div><b>Draw processing fee</b>{feeCents != null ? <> — <span>{usd(feeCents)}</span></> : null}</div>
              <div className="dd-sub" style={{ marginTop: 1 }}>{insp.fee_overridden ? 'Custom fee set for this file.' : 'Standard fee for this partner/method.'} Charged per draw — a change is sent straight to Sitewire.</div>
            </div>
            {!feeEdit ? (
              <button className="btn btn-sm ghost" style={{ flex: '0 0 auto' }} disabled={off || busy === 'fee'}
                onClick={() => { setFeeInput(feeCents != null ? String(Math.round(feeCents) / 100) : ''); setFeeEdit(true); setMsg(''); }}>
                {busy === 'fee' ? 'Saving…' : 'Change fee'}
              </button>
            ) : (
              <div className="row" style={{ gap: 6, flex: '0 0 auto', alignItems: 'center' }}>
                <span className="dd-sub">$</span>
                <input type="number" min="0" max="100000" step="1" value={feeInput} onChange={(e) => setFeeInput(e.target.value)}
                  style={{ width: 100, padding: '4px 6px', fontSize: 14 }} aria-label="New draw fee (dollars)" />
                <button className="btn btn-sm" disabled={off || busy === 'fee'} onClick={saveFee}>Save</button>
                <button className="btn btn-sm ghost" onClick={() => setFeeEdit(false)}>Cancel</button>
              </div>
            )}
          </div>

          {/* REVIEW — Sitewire GC review ↔ In-house review (property.require_sitewire_inspector) */}
          <ControlRow
            title={sitewireReview ? 'Sitewire Review' : 'In-house Review'}
            status={sitewireReview ? 'A Sitewire GC partner will review each virtual inspection' : 'No review by Sitewire GC partner'}
            btnLabel={sitewireReview ? 'Change to In-house' : 'Change to Sitewire'}
            busy={busy === 'review'} disabled={off || busy === 'review'}
            onClick={() => confirmApply(
              sitewireReview ? 'Switch to IN-HOUSE review? A Sitewire GC partner will no longer review each inspection.' : 'Switch back to SITEWIRE review? A Sitewire GC partner will review each inspection.',
              { require_sitewire_inspector: !sitewireReview }, 'review', sitewireReview ? 'Switched to in-house review.' : 'Switched to Sitewire review.')}
          />
        </>
      )}

      {off && <div className="muted small" style={{ marginTop: 6 }}>Sitewire writing is currently off, so these buttons are disabled until it’s turned on.</div>}
      {msg && <div className="dd-sub" style={{ marginTop: 6 }}>{msg}</div>}

      {/* The full live property, straight from Sitewire — every current setting, for reference. */}
      <details style={{ marginTop: 8 }} open={showRaw} onToggle={(e) => setShowRaw(e.target.open)}>
        <summary className="small" style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>Advanced — all live Sitewire settings for this property</summary>
        <pre style={{ marginTop: 6, maxHeight: 320, overflow: 'auto', background: 'var(--paper,#f6f3ec)', padding: 10, borderRadius: 6, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {JSON.stringify(prop, null, 2)}
        </pre>
      </details>
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
  const [editing, setEditing] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const loadStatus = useCallback(() => { api.get(`/api/sitewire/files/${appId}/borrower-status`).then(setSt).catch(() => setSt(null)); }, [appId]);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  if (!st) return null;
  const info = (st.available && INVITE[st.status]) || null;
  const accepted = st.status === 'assigned';
  const invited = st.invite_email || st.borrower_email || '';
  const isOverride = !!st.override_email && st.override_email !== st.borrower_email;
  async function resend() {
    setBusy(true); setMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/resend-invite`, {});
      setMsg(r.sitewire === 'dryrun' ? 'Dry-run — the invite wasn’t actually sent.' : `Invite sent to ${r.email}.`);
      setTimeout(loadStatus, 800);
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); }
    finally { setBusy(false); }
  }
  async function saveEmail() {
    const email = String(emailInput || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('Please enter a valid email address.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await api.setDrawInviteEmail(appId, email);
      setMsg(r.sitewire === 'synced' ? `Invitation now goes to ${r.email} — a fresh invite was sent.`
        : r.sitewire === 'not_pushed' ? `Saved. The invitation will go to ${r.email} when the draw starts.`
        : r.sitewire === 'dryrun' ? 'Dry-run — nothing was actually sent.'
        : `Saved ${r.email}.`);
      setEditing(false);
      setTimeout(loadStatus, 800);
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); }
    finally { setBusy(false); }
  }
  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="row between" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center', minWidth: 0 }}>
          <span className="dd-card-ic"><SdIcon name="mail" /></span>
          <div style={{ minWidth: 0 }}>
            <b>Borrower invite in Sitewire</b>
            {st.managed
              ? (info
                ? <div className="dd-sub" style={{ marginTop: 1, color: info.tone }}>{info.label}{st.contact_email ? ` · ${st.contact_email}` : ''}</div>
                : <div className="dd-sub" style={{ marginTop: 1 }}>{readsOff ? 'Turn Sitewire on to see the borrower’s invite status.' : 'Status unavailable right now.'}</div>)
              : <div className="dd-sub" style={{ marginTop: 1 }}>The invitation goes out when the draw process starts.</div>}
            {!editing && invited && (
              <div className="dd-sub" style={{ marginTop: 3 }}>
                Invitation email: <b>{invited}</b>{isOverride ? ' (instead of the borrower — e.g. their GC/partner)' : ''}
              </div>
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 8, flex: '0 0 auto', flexWrap: 'wrap' }}>
          {!accepted && !editing && (
            <button className="btn btn-sm ghost" disabled={busy}
              title="Send the Sitewire invite to a different email (e.g. the borrower’s contractor or partner)"
              onClick={() => { setEmailInput(invited); setEditing(true); setMsg(''); }}>Change email</button>
          )}
          {st.managed && !accepted && !readsOff && !editing && (
            <button className="btn btn-sm ghost" disabled={busy || writesOff}
              title={writesOff ? 'Sitewire writing is off' : 'Re-send the Sitewire borrower invite'} onClick={resend}>
              {busy ? 'Sending…' : (st.status === 'invited' ? 'Resend invite' : 'Send invite')}
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div style={{ marginTop: 10 }}>
          {/* Quick-pick the borrower or co-borrower (fills the email) — or type any address (e.g. a GC/partner). */}
          {st.recipients && (st.recipients.borrower || st.recipients.coBorrower) && (
            <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="dd-sub">Invite:</span>
              {st.recipients.borrower && st.recipients.borrower.email && (
                <button className="btn btn-sm ghost" disabled={busy} onClick={() => setEmailInput(st.recipients.borrower.email)}>
                  {st.recipients.borrower.name || 'Borrower'}
                </button>
              )}
              {st.recipients.coBorrower && st.recipients.coBorrower.email && (
                <button className="btn btn-sm ghost" disabled={busy} onClick={() => setEmailInput(st.recipients.coBorrower.email)}>
                  {st.recipients.coBorrower.name || 'Co-borrower'} <span className="dd-sub">(co-borrower)</span>
                </button>
              )}
            </div>
          )}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} placeholder="name@email.com"
              style={{ flex: '1 1 220px', minWidth: 0, fontSize: 16, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 8 }} />
            <button className="btn btn-sm" disabled={busy} onClick={saveEmail}>{busy ? 'Saving…' : 'Save & send invite'}</button>
            <button className="btn btn-sm ghost" disabled={busy} onClick={() => { setEditing(false); setMsg(''); }}>Cancel</button>
          </div>
        </div>
      )}
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

// ---- TrustPoint mirror panel (physical-draw workflow phases 2-3; STAFF-ONLY surface) ----
// Renders only when the file is linked to a TrustPoint project. Read-mostly: shows the
// mirrored draws + inspection orders; the one action surface is the coordinator's
// Portal draw requests (phase 4): the staff line-item composer + desk for physical-inspection
// files. A request born here (or on the borrower's draws screen) is hand-run through the
// administered/inspection process by the draw coordinator; once fully approved it closes out
// into Sitewire as a HISTORICAL draw so the per-line ledger and rollups stay whole.
function PortalDrawsCard({ appId }) {
  const [data, setData] = useState(null);
  const [openForm, setOpenForm] = useState(false);
  const [amounts, setAmounts] = useState({});
  const [note, setNote] = useState('');
  const [allowOver, setAllowOver] = useState(false);
  const [allowParallel, setAllowParallel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [apprFor, setApprFor] = useState(null);       // portal request id whose decision form is open
  const [apprAmounts, setApprAmounts] = useState({});
  const usd = (c) => c == null ? '—' : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const cents = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
  const load = useCallback(() => {
    api.get(`/api/sitewire/files/${appId}/portal-draws`).then(setData).catch(() => setData(null));
  }, [appId]);
  useEffect(() => { load(); }, [load]);
  if (!data || !data.state || !data.state.physical) return null;
  const st = data.state;
  const lines = data.lines || [];
  const history = data.history || [];
  const orders = data.trinity_orders || [];
  const total = lines.reduce((s, l) => s + cents(amounts[l.sitewire_job_item_id]), 0);
  const PR_STATUS = {
    submitted: { label: 'Submitted', cls: 'sw-pending' }, entered: { label: st.platform === 'trustpoint' ? 'Entered in TrustPoint' : 'In review', cls: 'sw-insp' },
    approved: { label: 'Approved', cls: 'sw-approved' }, closed_out: { label: 'Closed out to Sitewire', cls: 'sw-approved' }, cancelled: { label: 'Cancelled', cls: 'sw-draft' },
  };
  const ORDER_NEXT = { requested: { action: 'ordered', label: 'Mark ordered from Trinity' }, ordered: { action: 'report_received', label: 'Report received' } };
  async function act(fn) {
    setBusy(true); setMsg('');
    try { await fn(); load(); }
    catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); }
    finally { setBusy(false); }
  }
  function submitCreate() {
    return act(async () => {
      const entries = lines
        .map((l) => ({ sitewire_job_item_id: l.sitewire_job_item_id, requested_cents: cents(amounts[l.sitewire_job_item_id]) }))
        .filter((x) => x.requested_cents > 0);
      await api.post(`/api/sitewire/files/${appId}/portal-draws`, {
        entries, note: note.trim() || undefined, allow_over: allowOver || undefined, allow_parallel: allowParallel || undefined,
      });
      setOpenForm(false); setAmounts({}); setNote(''); setAllowOver(false); setAllowParallel(false);
      setMsg('Draw request submitted — the coordinator has it.');
    });
  }
  function openDecision(pr) {
    const init = {};
    for (const l of (Array.isArray(pr.lines) ? pr.lines : [])) init[l.sitewire_job_item_id] = (Number(l.requested_cents) / 100).toFixed(2);
    setApprAmounts(init); setApprFor(pr.id); setMsg('');
  }
  function submitDecision(pr) {
    return act(async () => {
      const entries = (Array.isArray(pr.lines) ? pr.lines : [])
        .map((l) => ({ sitewire_job_item_id: l.sitewire_job_item_id, approved_cents: cents(apprAmounts[l.sitewire_job_item_id]) }));
      const r = await api.post(`/api/sitewire/files/${appId}/portal-draws/${pr.id}/approve-trinity`, { entries });
      setApprFor(null);
      setMsg(r.closeout && r.closeout.ok ? 'Decision recorded — and the draw was closed out into Sitewire.'
        : `Decision recorded.${r.closeout && r.closeout.skipped ? ` Sitewire close-out is waiting (${String(r.closeout.skipped).replace(/_/g, ' ')}).` : ''}`);
    });
  }
  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="file" /></span>
          <div>
            <h3>Portal draw requests</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>
              {st.platform === 'trustpoint'
                ? 'Physical-inspection file — a request composed here is hand-entered into TrustPoint by the coordinator; once fully approved it lands in Sitewire as a historical draw.'
                : 'Physical-inspection file — a request composed here has its inspection ordered from Trinity; record the decision when the report is back.'}
            </div>
          </div>
        </div>
        {st.open_portal_request && <span className="dd-chip warn"><span className="dot" />Request in flight</span>}
      </div>
      {msg && <div className="small" style={{ marginTop: 8, fontWeight: 600 }}>{msg}</div>}

      {/* the composer */}
      {!st.open_portal_request && (
        !openForm ? (
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-sm primary" disabled={busy || !st.set_up || !st.funded} onClick={() => { setMsg(''); setOpenForm(true); }}>Compose a draw request</button>
            {!st.funded && <span className="small muted">Available once the loan is funded.</span>}
            {st.funded && !st.set_up && <span className="small muted">The draw setup (budget lines) hasn’t finished yet.</span>}
            {st.open_sitewire_draw && <span className="small muted">Heads up: draw #{st.open_sitewire_draw.number ?? '—'} is already open in Sitewire.</span>}
          </div>
        ) : (
          <div style={{ marginTop: 10 }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="tbl">
                <thead><tr><th>Budget line</th><th className="num">Remaining</th><th className="num" style={{ width: 130 }}>Request ($)</th></tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.sitewire_job_item_id}>
                      <td>{l.name}</td>
                      <td className="num muted">{usd(l.remaining_cents)}</td>
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
            <input className="small" value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500}
              placeholder="Note for the coordinator (optional)" style={{ width: '100%', marginTop: 8 }} />
            <label className="small row" style={{ gap: 6, marginTop: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={allowOver} onChange={(ev) => setAllowOver(ev.target.checked)} />
              Allow amounts above a line’s remaining (deliberate override)
            </label>
            {st.open_sitewire_draw && (
              <label className="small row" style={{ gap: 6, marginTop: 4, alignItems: 'center' }}>
                <input type="checkbox" checked={allowParallel} onChange={(ev) => setAllowParallel(ev.target.checked)} />
                Proceed even though a Sitewire draw is already open on this file
              </label>
            )}
            <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <span className="small" style={{ fontWeight: 700 }}>Total: {usd(total)}</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-sm ghost" disabled={busy} onClick={() => setOpenForm(false)}>Cancel</button>
              <button className="btn btn-sm primary" disabled={busy || total <= 0} onClick={submitCreate}>{busy ? 'Submitting…' : 'Submit request'}</button>
            </div>
          </div>
        )
      )}

      {/* history + desk actions */}
      {history.length > 0 && history.map((pr) => {
        const s = PR_STATUS[pr.status] || { label: pr.status, cls: 'sw-insp' };
        const order = orders.find((o) => Number(o.portal_draw_request_id) === Number(pr.id));
        const next = order && !['cancelled', 'closed_out'].includes(pr.status) ? ORDER_NEXT[order.status] : null;
        return (
          <div key={pr.id} style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10 }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <b>Request #{pr.id}</b>
              <span className={'pill ' + s.cls}>{s.label}</span>
              <span className="small muted">
                {pr.source === 'staff' ? 'By staff' : 'By the borrower'} · {usd(pr.total_requested_cents)}
                {pr.approved_cents != null ? ` · Approved ${usd(pr.approved_cents)}` : ''}
                {pr.platform === 'trinity' && order ? ` · Inspection: ${String(order.status).replace(/_/g, ' ')}` : ''}
              </span>
            </div>
            {Array.isArray(pr.lines) && pr.lines.length > 0 && (
              <div className="small muted" style={{ marginTop: 4 }}>
                {pr.lines.slice(0, 6).map((l) => `${l.name}: ${usd(l.requested_cents)}`).join(' · ')}{pr.lines.length > 6 ? ' · …' : ''}
              </div>
            )}
            {pr.cancelled_reason && <div className="small muted" style={{ marginTop: 4 }}>Cancelled: {pr.cancelled_reason}</div>}
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {['submitted', 'entered'].includes(pr.status) && pr.platform === 'trinity' && apprFor !== pr.id && (
                <button className="btn btn-sm ghost" disabled={busy} onClick={() => openDecision(pr)}>Record the decision</button>
              )}
              {next && (
                <button className="btn btn-sm ghost" disabled={busy}
                  onClick={() => act(() => api.post(`/api/sitewire/files/${appId}/trinity-orders/${order.id}/advance`, { action: next.action }))}>{next.label}</button>
              )}
              {pr.status === 'approved' && !pr.sitewire_draw_id && (
                <button className="btn btn-sm ghost" disabled={busy}
                  onClick={() => act(async () => {
                    const r = await api.post(`/api/sitewire/files/${appId}/portal-draws/${pr.id}/close-out`, {});
                    setMsg(r.ok ? 'Closed out into Sitewire.' : `Not closed out — ${String(r.skipped || r.parked || 'see the review list').replace(/_/g, ' ')}.`);
                  })}>Close out into Sitewire</button>
              )}
              {['submitted', 'entered', 'approved'].includes(pr.status) && (
                <button className="btn btn-sm ghost" disabled={busy}
                  onClick={() => { const reason = window.prompt('Cancel this draw request? Add a short reason (the borrower sees it if they submitted it):'); if (reason !== null) act(() => api.post(`/api/sitewire/files/${appId}/portal-draws/${pr.id}/cancel`, { reason })); }}>Cancel request</button>
              )}
            </div>
            {apprFor === pr.id && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--line)' }}>
                <div className="small" style={{ fontWeight: 700, marginBottom: 6 }}>Approved amount per line (from the inspection report)</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="tbl">
                    <thead><tr><th>Line</th><th className="num">Requested</th><th className="num" style={{ width: 130 }}>Approved ($)</th></tr></thead>
                    <tbody>
                      {(Array.isArray(pr.lines) ? pr.lines : []).map((l) => (
                        <tr key={l.sitewire_job_item_id}>
                          <td>{l.name}</td>
                          <td className="num muted">{usd(l.requested_cents)}</td>
                          <td className="num">
                            <input type="number" min="0" step="0.01" inputMode="decimal" value={apprAmounts[l.sitewire_job_item_id] ?? ''}
                              onChange={(ev) => setApprAmounts((a) => ({ ...a, [l.sitewire_job_item_id]: ev.target.value }))}
                              style={{ width: 110, textAlign: 'right' }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <button className="btn btn-sm ghost" disabled={busy} onClick={() => setApprFor(null)}>Cancel</button>
                  <button className="btn btn-sm primary" disabled={busy} onClick={() => submitDecision(pr)}>{busy ? 'Saving…' : 'Approve these amounts'}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// per-line entry (transcribed from TrustPoint's console) + the push-to-Sitewire button.
function TrustpointPanel({ appId }) {
  const [ov, setOv] = useState(null);
  const [openLines, setOpenLines] = useState(null);   // tp_draw_id whose entry form is open
  const [lineData, setLineData] = useState(null);
  const [amounts, setAmounts] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const usd = (c) => c == null ? '—' : '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const load = useCallback(() => {
    api.get(`/api/trustpoint/files/${appId}/overview`).then(setOv).catch(() => setOv(null));
  }, [appId]);
  useEffect(() => { load(); }, [load]);
  if (!ov || !ov.linked) return null;
  async function openEntry(d) {
    setMsg(''); setOpenLines(d.tp_draw_id); setLineData(null);
    try {
      const r = await api.get(`/api/trustpoint/files/${appId}/draws/${d.tp_draw_id}/lines`);
      setLineData(r);
      const init = {};
      for (const l of (r.lines || [])) init[l.sitewire_job_item_id] = (Number(l.approved_cents) / 100).toFixed(2);
      setAmounts(init);
    } catch (e) { setMsg(e?.data?.error || e.message); }
  }
  async function saveEntry(d) {
    setBusy(true); setMsg('');
    try {
      const entries = Object.entries(amounts)
        .filter(([, v]) => String(v).trim() !== '')
        .map(([jid, v]) => ({ sitewire_job_item_id: Number(jid), approved_cents: Math.round(Number(v) * 100) }));
      const r = await api.post(`/api/trustpoint/files/${appId}/draws/${d.tp_draw_id}/lines`, { entries });
      setMsg(r.writeback && r.writeback.ok ? 'Saved — and the approval was pushed into Sitewire.' :
        r.writeback && r.writeback.skipped ? `Saved. Sitewire push is waiting (${r.writeback.skipped.replace(/_/g, ' ')}).` : 'Saved.');
      setOpenLines(null); load();
    } catch (e) { setMsg(e?.data?.error || e.message || "That didn't work."); }
    finally { setBusy(false); }
  }
  async function pushNow(d) {
    setBusy(true); setMsg('');
    try {
      const r = await api.post(`/api/trustpoint/files/${appId}/draws/${d.tp_draw_id}/push-sitewire`, {});
      setMsg(r.ok
        ? (r.pushed && r.pushed.dryrun ? 'Checked in dry-run — nothing was sent yet.' : 'Approval pushed into Sitewire.')
        : `Not pushed — ${String(r.skipped || r.parked || 'see the draw desk').replace(/_/g, ' ')}.`);
      load();
    } catch (e) { setMsg(e?.data?.error || e.message); }
    finally { setBusy(false); }
  }
  // NOTE: there is deliberately NO status-label map here. Every label/tone/meaning comes from
  // `status_info` / `headline`, resolved on the SERVER by src/lib/draw-status.js — a second copy
  // in the client is exactly how the two drift and a status TrustPoint adds tomorrow renders as
  // a raw database value in one place and a friendly label in the other.
  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="ext" /></span>
          <div>
            <h3>Administered draws (TrustPoint)</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>Mirrored from the note buyer's draw administrator. Approvals happen there; PILOT records them and pushes the numbers back into Sitewire.</div>
          </div>
        </div>
        <span className="dd-chip warn"><span className="dot" />TrustPoint</span>
      </div>
      {msg && <div className="small" style={{ marginTop: 8, fontWeight: 600 }}>{msg}</div>}
      {/* WHAT IS HAPPENING RIGHT NOW, in one sentence — the server picks it (a problem at the
          inspector beats progress, progress beats a settled draw status). */}
      {ov.headline ? (
        <div style={{
          marginTop: 10, padding: '10px 12px', borderRadius: 8, background: '#FFFFFF',
          border: `1px solid ${(SO_TONE[ov.headline.tone] || SO_TONE.neutral).bd}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#4B585C' }}>Right now</span>
            <StatusChip info={ov.headline} />
            <span style={{ fontSize: 11.5, color: '#4B585C' }}>
              {ov.headline.from === 'inspection' ? 'from the inspection' : 'from the draw'}
            </span>
          </div>
          {ov.headline.meaning ? (
            <div style={{ marginTop: 4, fontSize: 12, color: '#4B585C' }}>{ov.headline.meaning}</div>
          ) : null}
        </div>
      ) : null}
      {(ov.draws || []).length === 0 && <div className="muted small" style={{ marginTop: 10 }}>No draws mirrored yet.</div>}
      {(ov.draws || []).map((d) => (
        <div key={d.tp_draw_id} style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10 }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <b>Draw #{d.number == null ? '—' : d.number}</b>
            <StatusChip info={d.status_info} />
            <span className="small muted">Requested {usd(d.requested_cents)} · Approved {usd(d.approved_cents)}{d.to_disburse_cents != null ? ` · Net ${usd(d.to_disburse_cents)}` : ''}</span>
            {(d.disbursed_at || Number(d.disbursed_cents) > 0) && (
              <span className="small" style={{ color: 'var(--success)' }}>✓ Released{Number(d.disbursed_cents) > 0 ? ` ${usd(d.disbursed_cents)}` : ''}</span>
            )}
            {d.writeback_at ? <span className="small" style={{ color: 'var(--success)' }}>✓ In Sitewire</span>
              : d.writeback_note ? <span className="small muted">{d.writeback_note}</span> : null}
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {(d.status === 'APPROVED' || d.status === 'COMPLETED') && !d.writeback_at && (
              <>
                <button className="btn btn-sm ghost" disabled={busy} onClick={() => openEntry(d)}>Enter line-by-line amounts</button>
                <button className="btn btn-sm ghost" disabled={busy} onClick={() => pushNow(d)}>Push approval to Sitewire</button>
              </>
            )}
            <button className="btn btn-sm ghost" disabled={busy} onClick={() => { const w = window.open('', '_blank'); api.trustpointDrawReport(appId, d.tp_draw_id, 'staff', w).catch((e) => setMsg(e?.data?.error || e.message)); }}>Report (PDF)</button>
          </div>
          <DrawMessages messages={d.messages} />
          {openLines === d.tp_draw_id && lineData && (
            <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--ink-2)', borderRadius: 8 }}>
              <div className="small" style={{ fontWeight: 600 }}>Copy the approved amount per line from TrustPoint (must add up to {usd(lineData.draw.approved_cents)} exactly):</div>
              {(lineData.budget_lines || []).map((b) => (
                <label key={b.sitewire_job_item_id} className="row small" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>{b.name}</span>
                  <span className="muted">$</span>
                  <input className="input" style={{ width: 110 }} inputMode="decimal" value={amounts[b.sitewire_job_item_id] || ''}
                    onChange={(e) => setAmounts({ ...amounts, [b.sitewire_job_item_id]: e.target.value })} placeholder="0" />
                </label>
              ))}
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <button className="btn btn-sm primary" disabled={busy} onClick={() => saveEntry(d)}>{busy ? 'Saving…' : 'Save amounts'}</button>
                <button className="btn btn-sm ghost" disabled={busy} onClick={() => setOpenLines(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {(ov.service_orders || []).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="dd-field-l" style={{ textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 11 }}>Inspections &amp; services</div>
          {(ov.service_orders || []).slice(0, 8).map((so) => (
            <InspectionRow key={so.tp_service_order_id} so={so} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ONE inspection, told properly (owner-directed 2026-07-27 — the old row printed a lower-cased
 * database value: "inspection · ready_for_review · scheduled 2026-07-24").
 *
 * Everything here comes from `so.status_info`, resolved on the SERVER by src/lib/draw-status.js, so
 * the wording lives in one place and a status TrustPoint adds tomorrow still renders. Text colours
 * are explicit darks — never a `--ink*` token, which is a LIGHT paper colour in this palette and
 * renders white-on-white (the standing hard rule).
 */
const SO_TONE = {
  neutral:  { fg: '#4B585C', bg: '#F1EFE9', bd: '#E4E0D6' },
  gold:     { fg: '#7A5E2E', bg: '#F8F1E1', bd: '#E8D9B5' },
  teal:     { fg: '#245F66', bg: '#E7F1F2', bd: '#C7DFE1' },
  positive: { fg: '#1E6B50', bg: '#E6F3ED', bd: '#C3E2D5' },
  bad:      { fg: '#8E3A31', bg: '#FBEBE9', bd: '#F0CFCA' },
};

/** ONE status pill, from the server-resolved `{label, tone}` shape. The only place a tone
 *  becomes a colour, so the draw chip, the headline and the inspection row can never disagree. */
function StatusChip({ info }) {
  const i = info || {};
  const t = SO_TONE[i.tone] || SO_TONE.neutral;
  return (
    <span
      title={i.meaning || undefined}
      style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '.02em', padding: '2px 8px', borderRadius: 999,
        color: t.fg, background: t.bg, border: `1px solid ${t.bd}`,
      }}
    >{i.label || '—'}</span>
  );
}

/**
 * THE CONVERSATION ON ONE DRAW (owner-directed 2026-07-27: "we should also be able to see the
 * real messages in our system related to each and every draw — all the messages going back and
 * forth"). Read-only on purpose: a reply belongs in TrustPoint, where the administrator will
 * actually see it, and a one-way mirror can never put words in our coordinator's mouth.
 *
 * There is NO byline, and that is the truth rather than an omission — TrustPoint's comment
 * response publishes the message, when it was written, and nothing that names a person.
 */
function DrawMessages({ messages }) {
  const list = Array.isArray(messages) ? messages : [];
  const [open, setOpen] = React.useState(false);
  if (!list.length) return null;
  const total = list.reduce((n, m) => n + 1 + (m.replies ? m.replies.length : 0), 0);
  // A bare new Date(x).toISOString() THROWS RangeError on an unparseable value, and a throw
  // during render takes the whole file screen down through the ErrorBoundary. Never render an
  // external timestamp without this guard.
  const day = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  const line = (m, depth) => (
    <div key={m.tp_comment_id} style={{ marginTop: 8, marginLeft: depth * 16 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11.5, color: '#4B585C' }}>{day(m.commented_at) || 'date not given'}</span>
        {m.author ? <span style={{ fontSize: 11.5, fontWeight: 600, color: '#141B22' }}>{m.author}</span> : null}
        {m.is_pinned ? <span style={{ fontSize: 11, color: '#7A5E2E' }}>pinned</span> : null}
      </div>
      <div style={{ fontSize: 12.5, color: '#141B22', whiteSpace: 'pre-wrap', marginTop: 2 }}>{m.body}</div>
      {(m.replies || []).map((r) => line(r, depth + 1))}
    </div>
  );
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #E4E0D6', paddingTop: 8 }}>
      <button
        className="btn btn-sm ghost"
        onClick={() => setOpen(!open)}
        style={{ padding: '2px 8px', fontSize: 12 }}
      >{open ? 'Hide' : 'Show'} messages ({total})</button>
      {open ? (
        <div style={{ marginTop: 4 }}>
          {list.map((m) => line(m, 0))}
          <div style={{ marginTop: 10, fontSize: 11, color: '#4B585C' }}>
            Copied from the draw administrator. To reply, write back on their system — messages
            typed here would not reach them.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function InspectionRow({ so }) {
  const i = so.status_info || {};
  const t = SO_TONE[i.tone] || SO_TONE.neutral;
  const steps = Number(i.steps) || 0;
  const step = i.step == null ? null : Number(i.step);
  const facts = [
    i.number ? ['Order #', i.number] : null,
    i.orderedOn ? ['Ordered', i.orderedOn] : null,
    i.scheduledOn ? ['Visit booked', i.scheduledOn] : null,
    i.completedOn ? ['Completed', i.completedOn] : null,
    i.cancelledOn ? ['Cancelled', i.cancelledOn] : null,
    i.progressPct != null ? ['Progress found', `${i.progressPct}%`] : null,
  ].filter(Boolean);

  return (
    <div style={{ marginTop: 8, padding: '10px 12px', border: `1px solid ${t.bd}`, borderRadius: 8, background: '#FFFFFF' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#141B22', textTransform: 'capitalize' }}>{i.kind || 'service'}</span>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '.02em', padding: '2px 8px', borderRadius: 999,
          color: t.fg, background: t.bg, border: `1px solid ${t.bd}`,
        }}>{i.label || '—'}</span>
      </div>
      {i.meaning ? (
        <div style={{ marginTop: 4, fontSize: 12, color: '#4B585C' }}>{i.meaning}</div>
      ) : null}
      {/* where it sits on the track from ordered to done — cancelled/failed sit OFF the track */}
      {step != null && steps > 0 ? (
        <div style={{ display: 'flex', gap: 3, marginTop: 8 }} aria-hidden="true">
          {Array.from({ length: steps }).map((_, n) => (
            <span key={n} style={{
              height: 3, flex: 1, borderRadius: 2,
              background: n <= step ? t.fg : '#E4E0D6',
            }} />
          ))}
        </div>
      ) : null}
      {facts.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', marginTop: 8 }}>
          {facts.map(([k, v]) => (
            <span key={k} style={{ fontSize: 11.5, color: '#4B585C' }}>
              {k} <strong style={{ color: '#141B22', fontWeight: 600 }}>{v}</strong>
            </span>
          ))}
        </div>
      ) : null}
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
  const oop = s.out_of_pocket || null; // out-of-pocket-first floor (0 = no OOP-rehab exception)
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
          {s.draw_platform === 'trustpoint' && <span className="dd-chip warn"><span className="dot" />Administered on TrustPoint</span>}
          {!s.switches?.enabled && <span className="dd-chip warn"><span className="dot" />Sitewire off — will queue</span>}
          {s.switches?.enabled && s.switches?.dryrun && <span className="dd-chip warn"><span className="dot" />Dry-run</span>}
          {s.switches?.enabled && !s.switches?.dryrun && !s.switches?.outbound && <span className="dd-chip warn"><span className="dot" />Read-only</span>}
        </div>
      </div>

      {s.draw_platform === 'trustpoint' && (
        <div className="small" style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--gold-soft)', fontWeight: 600 }}>
          This file's draws are administered on TrustPoint (physical inspection). Set it up in Sitewire as usual — the borrower submits there — and every submitted draw opens a coordinator task to enter it into TrustPoint. Approvals happen in TrustPoint and are mirrored back.
        </div>
      )}

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
          {oop && oop.floor_cents > 0 && (
            <div className="small" style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'var(--gold-soft)', color: 'var(--text)', fontWeight: 600 }}>
              Out-of-pocket rehab: <b>{usd(oop.floor_cents)}</b>. The borrower pays the first {usd(oop.floor_cents)} of rehab themselves — PILOT won’t reimburse a draw until that much has been done out of pocket. The full {oop.full_rehab_cents != null ? usd(oop.full_rehab_cents) : 'construction'} budget still goes to Sitewire; only {oop.financed_rehab_cents != null ? usd(oop.financed_rehab_cents) : 'the financed portion'} is reimbursed.
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
    upload: <><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 20h16" /></>,
    file: <><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></>,
    dollar: <><path d="M12 2v20" /><path d="M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.5 9.2 9.5 12 10s5 1.6 5 3.5-2.2 3-5 3-5-1.1-5-3" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" /></>,
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

/* Super-admin Scope-of-Work line editor (owner-directed 2026-07-21). Only a super-admin sees it, and only
   after clicking "Unlock editing" (frozen by default). Per line: change the WORDING + add a DESCRIPTION for
   the investor — updates the real Scope of Work + its Excel, and the new wording syncs to Sitewire (a line
   already drawn against keeps its Sitewire name). The description stays in our SOW + Excel (Sitewire's line
   description is read-only for us). Renders nothing for non-super-admins or a file with no Scope of Work. */
function SowLineEditor({ appId }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(null);
  const [label, setLabel] = useState('');
  const [desc, setDesc] = useState('');
  const load = useCallback(() => { api.get(`/api/sitewire/files/${appId}/sow-lines`).then(setData).catch(() => setData(null)); }, [appId]);
  useEffect(() => { load(); }, [load]);
  if (!data || !data.available || !data.is_super_admin) return null;

  async function setUnlock(unlocked) {
    setBusy('lock'); setMsg('');
    try { await api.post(`/api/sitewire/files/${appId}/sow-edit-lock`, { unlocked }); setEditing(null); load(); }
    catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); } finally { setBusy(''); }
  }
  function startEdit(l) { setEditing(l.sow_line_key); setLabel(l.name || ''); setDesc(l.desc || ''); setMsg(''); }
  async function save() {
    setBusy('save'); setMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/sow-line-edit`, { sow_line_key: editing, label, desc });
      const parts = [];
      if (r.sitewire === 'pushed' || r.sitewire === 'synced') parts.push('wording');
      if (r.desc_sitewire === 'pushed' || r.desc_sitewire === 'synced' || r.desc_sitewire === 'unverified') parts.push('description');
      const sw = parts.length ? ` ${parts.join(' + ')} sent to Sitewire.`
        : (r.sitewire === 'parked' || r.desc_sitewire === 'parked') ? ' (A Sitewire sync review was opened so nothing is lost.)'
        : (r.sitewire === 'writes_off' || r.desc_sitewire === 'writes_off') ? ' (Sitewire writing is off — it will sync when it’s on.)'
        : '';
      setMsg('Saved to the Scope of Work + Excel.' + sw);
      setEditing(null); load();
    } catch (e) { setMsg(e?.data?.error || e.message || 'That didn’t work.'); } finally { setBusy(''); }
  }
  const inputStyle = { width: '100%', padding: '5px 7px', fontSize: 14, boxSizing: 'border-box' };

  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="row between" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200, flex: '1 1 260px' }}>
          <b>Edit line wording &amp; descriptions</b>
          <div className="dd-sub" style={{ marginTop: 1 }}>Super-admin only. Changes update the Scope of Work + its Excel; new wording also syncs to Sitewire.</div>
        </div>
        <button className="btn btn-sm ghost" style={{ flex: '0 0 auto' }} disabled={busy === 'lock'}
          onClick={() => setUnlock(!data.unlocked)}>{busy === 'lock' ? '…' : (data.unlocked ? 'Lock editing' : 'Unlock editing')}</button>
      </div>

      {!data.unlocked ? (
        <div className="dd-sub" style={{ marginTop: 8 }}>Editing is frozen. Click <b>Unlock editing</b> to change a line’s wording or add a description.</div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {data.lines.map((l) => (
            <div key={l.sow_line_key} style={{ borderTop: '1px solid var(--hairline,#e7e0d4)', padding: '8px 0' }}>
              {editing === l.sow_line_key ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Line wording" maxLength={200} style={inputStyle} aria-label="Line wording" />
                  <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description for the investor (optional)" maxLength={2000} rows={2} style={inputStyle} aria-label="Line description" />
                  <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn btn-sm" disabled={busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
                    <button className="btn btn-sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                    {l.drawn_locked && <span className="dd-sub" style={{ color: 'var(--gold,#ae8746)' }}>Sitewire keeps this line’s name (already drawn) — the wording still updates our Scope of Work + Excel.</span>}
                  </div>
                </div>
              ) : (
                <div className="row between" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                    <div><b>{l.name}</b> <span className="dd-sub">· {l.amount}</span>{l.drawn_locked && <span className="dd-sub" style={{ color: 'var(--gold,#ae8746)' }}> · Sitewire name locked</span>}</div>
                    {l.desc && <div className="dd-sub" style={{ marginTop: 1 }}>{l.desc}</div>}
                  </div>
                  <button className="btn btn-xs ghost" style={{ flex: '0 0 auto' }} onClick={() => startEdit(l)}>Edit</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {msg && <div className="dd-sub" style={{ marginTop: 6 }}>{msg}</div>}
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

// Push OUR 3 property documents (appraisal PDF + Scope of Work Excel + Scope of Work PDF) INTO the Sitewire
// property's Documents tab — the website workaround (Sitewire has no upload API). Runs automatically on every
// property push; this panel is the manual "Send" + "Re-send" for the desk, and shows what's confirmed present.
function SitewireDocumentPush({ appId, writesOff }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  const reload = () => api.get(`/api/sitewire/files/${appId}/documents-push`).then(setD).catch(() => setD(null));
  useEffect(() => { reload(); }, [appId]);
  if (!d || !d.managed) return null;
  const slots = d.slots || [];
  const anyAvailable = slots.some((s) => s.available);
  const anyPushed = slots.some((s) => s.pushed);

  async function push(opts) {
    setBusy(opts.which || (opts.force ? 'resend' : 'send')); setMsg(null);
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/documents-push`, opts);
      setMsg({ t: r && r.dryrun ? 'Prepared (test mode — nothing sent).' : 'Sent the documents to Sitewire.' });
    } catch (e) { setMsg({ err: true, t: (e && e.message) || 'Couldn’t send the documents right now.' }); }
    finally { setBusy(null); await reload(); }
  }
  const stateLabel = (s) => s.verified ? 'Confirmed in Sitewire' : s.pushed ? 'Sent' : s.available ? 'Ready to send' : 'Not available yet';
  const stateCls = (s) => s.verified ? 'sw-ok' : s.pushed ? 'sw-insp' : s.available ? '' : 'sw-warn';

  return (
    <div className="dd-card" style={{ marginTop: 12 }}>
      <div className="dd-card-h" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="upload" /></span>
          <div><h3>Send our documents to Sitewire</h3><div className="dd-sub" style={{ marginTop: 1 }}>Appraisal PDF, Scope of Work (Excel), Scope of Work (PDF) — placed in Sitewire’s Documents tab automatically. No need to log into Sitewire.</div></div>
        </div>
      </div>
      {!d.enabled && <div className="dd-sub" style={{ marginTop: 8, color: 'var(--warn, #9a6b00)' }}>Sending documents to Sitewire isn’t switched on yet. It turns on once the Sitewire website login is set up.</div>}
      {d.enabled && !d.web_configured && <div className="dd-sub" style={{ marginTop: 8, color: 'var(--warn, #9a6b00)' }}>The Sitewire website login isn’t set up yet, so documents can’t be sent. Add it in the app settings.</div>}
      <div style={{ marginTop: 6 }}>
        {slots.map((s) => (
          <div key={s.which} className="row" style={{ gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--line)' }}>
            <span className="dd-card-ic" style={{ width: 24, height: 24, background: 'var(--primary-soft)' }}><SdIcon name="file" /></span>
            <span style={{ flex: '1 1 auto', minWidth: 0 }}>
              <b style={{ fontSize: 13 }}>{s.label}</b>
              {s.missing && <span className="dd-sub"> · not on this file yet</span>}
              {s.last_error && !s.pushed && <span className="dd-sub" style={{ color: 'var(--danger,#b00)' }}> · last try failed</span>}
            </span>
            <span className={'pill ' + stateCls(s)} style={{ flex: '0 0 auto' }}>{stateLabel(s)}</span>
            {s.pushed && !writesOff && <button className="btn btn-sm ghost" disabled={busy === s.which} onClick={() => push({ which: s.which, force: true })} style={{ flex: '0 0 auto' }}>{busy === s.which ? '…' : 'Re-send'}</button>}
          </div>
        ))}
      </div>
      {msg && <div className="dd-sub" style={{ marginTop: 8, color: msg.err ? 'var(--danger,#b00)' : 'var(--ok,#137333)' }}>{msg.t}</div>}
      <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-sm" disabled={writesOff || !d.enabled || !d.web_configured || !anyAvailable || busy === 'send'}
          title={writesOff ? 'Sitewire writing is off' : undefined}
          onClick={() => push({})}>{busy === 'send' ? 'Sending…' : 'Send documents to Sitewire'}</button>
        {anyPushed && <button className="btn btn-sm ghost" disabled={writesOff || !d.enabled || !d.web_configured || busy === 'resend'}
          onClick={() => push({ force: true })}>{busy === 'resend' ? 'Re-sending…' : 'Re-send all'}</button>}
      </div>
    </div>
  );
}

/* The draw transitions PILOT can drive in Sitewire, by whether the draw is still open.
   `amend` and `reopen` are the post-decision actions — an approved draw is exactly when they are
   needed — and both require a written reason, which is journaled on the file. */
const DRAW_ACTIONS = (isOpen) => (isOpen ? [
  { key: 'approve', label: 'Final approve', done: 'Draw finally approved.', needsNote: false,
    hint: 'Records OUR final approval in Sitewire — the last step before the money is released.' },
  { key: 'amend', label: 'Amend', needsNote: true, done: 'Draw amended — the borrower can revise it.',
    prompt: 'Why are you amending this draw? (at least a few words — it goes on the audit trail)',
    hint: 'Send the draw back for changes to the amounts or the work claimed.' },
  { key: 'reopen', label: 'Reopen', needsNote: true, done: 'Draw reopened.',
    prompt: 'Why are you reopening this draw? (at least a few words — it goes on the audit trail)',
    hint: 'Put the draw back into the inspection stage.' },
] : [
  { key: 'amend', label: 'Amend this draw', needsNote: true, done: 'Draw amended — it is back open for changes.',
    prompt: 'Why are you amending this approved draw? (at least a few words — it goes on the audit trail)',
    hint: 'The draw is already finally approved. Amending reopens it for changes, and the money goes back to available until it is approved again.' },
  { key: 'reopen', label: 'Reopen', needsNote: true, done: 'Draw reopened.',
    prompt: 'Why are you reopening this approved draw? (at least a few words — it goes on the audit trail)',
    hint: 'Put an approved draw back into the inspection stage.' },
]);

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
          <span className="pill sw-insp">{draw.approval_label || STATUS[draw.status] || 'In progress'}</span>
          {risk && flags.length > 0 && <span className={'pill ' + risk.cls}>{risk.label} · {flags.length}</span>}
        </div>
        {/* "Approved" here is the INSPECTOR's approval until we press Final approve — Sitewire's own
            total_approved_cents stays 0 for that whole stretch, which is what printed $0 across the
            desk and the reports on a fully-inspected draw (owner-reported 2026-08-03). */}
        <div className="muted small">
          Requested {usd2(draw.requested_cents)} · {draw.final_approved_cents > 0 ? 'Final approved' : 'Inspector approved'} {usd2(draw.approved_cents)}
          {draw.fee_cents > 0 ? <> · Less fee {usd2(draw.fee_cents)}{draw.fee_projected ? '*' : ''}</> : null}
          {' '}· Net {usd2(draw.net_release_cents)}
        </div>
      </div>

      {draw.net_explanation && (
        <div className="dd-sub" style={{ marginTop: 4 }}>
          {draw.net_explanation}
          {draw.final_approved_cents > 0 ? '' : ' This is what the inspector approved — it still needs the borrower’s acceptance, the capital partner’s review and our final approval.'}
        </div>
      )}

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
            <thead><tr><th>Line</th><th style={{ textAlign: 'right' }}>Requested</th>
              <th style={{ textAlign: 'right' }} title="What the inspector approved on this line. It becomes the final approved amount when we press Final approve.">{isOpen ? 'Approved by inspector' : 'Approved'}</th>
              <th title="Inspection photos and videos on file for this line — counted from the inspector's findings and the copies archived in PILOT, not just from the live Sitewire feed.">Photos</th>{isOpen && <th>Set approved</th>}</tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.sitewire_request_id}>
                  {/* Owner-directed 2026-07-22: a media item (Photo/Video Required — Sitewire's
                      inspection gate) is NOT a money line. Show the requirement label instead of
                      dashes for amounts, and REPLACE the "Set approved $ Save" input with a
                      "Photo/video only" note so a coordinator can't accidentally record money
                      against a $0 gate row. is_media_item comes from the crosswalk via the
                      /files/:id/rollup request query (LEFT JOIN sitewire_job_item_links). */}
                  <td>{r.job_item_name || `Line ${r.sitewire_job_item_id}`}{r.is_media_item ? <span className="muted small" style={{ marginLeft: 6 }}>· photo/video required</span> : null}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} className={r.is_media_item ? 'muted' : undefined}>{r.is_media_item ? '—' : usd2(r.requested_cents)}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} className={r.is_media_item ? 'muted' : undefined}>{r.is_media_item ? '—' : (r.approved_cents == null ? '—' : usd2(r.approved_cents))}</td>
                  <td className="muted small">{r.inspection_count || 0}</td>
                  {isOpen && (
                    <td>
                      {r.is_media_item ? (
                        <span className="muted small">Photo/video only — no dollars to enter</span>
                      ) : (
                        <div className="row" style={{ gap: 6 }}>
                          <input className="input" style={{ width: 100 }} placeholder="$" disabled={writesOff} value={edits[r.sitewire_request_id] ?? ''} onChange={(e) => setEdits((s) => ({ ...s, [r.sitewire_request_id]: e.target.value }))} />
                          <button className="btn btn-sm ghost" title={offTip} disabled={writesOff || busy === 'appr:' + r.sitewire_request_id} onClick={() => setApproved(r)}>Save</button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ACTIONS GROUPED BY WHAT THEY DO (owner-directed 2026-08-03: "everything is a little
          messed up … the button is not a nice place"). This had grown to nine buttons in one
          wrapping row, all the same weight — so Approve, which moves real money, read exactly as
          loudly as Draw packet, which downloads a spreadsheet. Two clusters now: the DECISIONS on
          this draw, then the DOCUMENTS it produces (quiet `soft` buttons), with a hairline
          between them. Same actions, same handlers — only the grouping and the weight changed. */}
      <div className="act-bar">
        {/* AMEND AND REOPEN MUST SURVIVE THE FINAL APPROVAL (owner-reported 2026-08-03: "we're
            missing the amend button, which is available in Sitewire after the final approval").
            These two actions only make sense on a draw somebody already decided — that is what
            "amend" means — yet the whole row was hidden the moment the draw reached `approved`, so
            the one state they exist for was the one state they could not be reached in. The backend
            route has always accepted them (client.DRAW_TRANSITIONS). Both also REQUIRE a note of at
            least 8 characters (audit B-10) which the old button never asked for, so every click
            answered 400 — the button was broken on open draws too. */}
        {DRAW_ACTIONS(isOpen).map((a) => (
          <button key={a.key} className={'btn btn-sm ' + (a.key === 'approve' ? 'primary' : 'ghost')}
            title={offTip || a.hint} disabled={writesOff || busy === a.key + draw.sitewire_draw_id}
            onClick={() => {
              let note = null;
              if (a.needsNote) {
                note = window.prompt(a.prompt, '');
                if (note == null) return;                       // cancelled
                if (String(note).trim().length < 8) { window.alert('Please write at least a few words explaining why — this goes on the file\u2019s audit trail.'); return; }
              }
              act(a.key + draw.sitewire_draw_id, async () => {
                await api.post(`/api/sitewire/draws/${draw.sitewire_draw_id}/${a.key}`, note ? { note: String(note).trim() } : {});
                return { msg: a.done };
              });
            }}>
            {a.label}
          </button>
        ))}
        <button className="btn btn-sm ghost" title={readTip} disabled={readsOff || busy === 'deliver' + draw.sitewire_draw_id}
          onClick={() => act('deliver' + draw.sitewire_draw_id, async () => { const r = await api.post(`/api/sitewire/files/${appId}/findings/${draw.sitewire_draw_id}/deliver`, {}); const ready = Array.isArray(r.reports_ready) && r.reports_ready.length; return { msg: `Findings delivered to the borrower (${r.lines} items).${ready ? ' Photos archived + PILOT reports ready.' : (r.reports_pending ? ' Archiving photos + preparing reports…' : '')}` }; })}>
          {finding ? 'Re-send findings' : 'Deliver findings to borrower'}
        </button>

        <span className="act-sep" aria-hidden="true" />

        <span className="act-group">
          <span className="act-label">Documents</span>
          <button className={'btn btn-sm ' + (showPhotos ? 'primary' : 'soft')} onClick={() => setShowPhotos((s) => !s)}>
            {showPhotos ? 'Hide photos' : 'Photos'}
          </button>
          <button className="btn btn-sm soft" onClick={() => api.sitewireExportPacket(appId, draw.sitewire_draw_id).catch(() => {})}>Packet (Excel)</button>
          <button className="btn btn-sm soft" title="A PILOT-branded PDF for this draw — schedule of values, approved vs not-approved, inspector notes and the inspection photos." disabled={busy === 'rep' + draw.sitewire_draw_id}
            onClick={() => { const w = window.open('', '_blank'); act('rep' + draw.sitewire_draw_id, async () => { await api.sitewireDrawReport(appId, draw.sitewire_draw_id, 'staff', w); return { msg: 'Opened the PILOT report in a new tab.' }; }); }}>Our report</button>
          <button className="btn btn-sm soft" title="The same report, borrower-safe: no capital-partner name and no photo locations. It DOES show the draw processing fee that comes out of their money — never our fee income across the project. Generating it shares it with the borrower." disabled={busy === 'repb' + draw.sitewire_draw_id}
            onClick={() => { if (!window.confirm('Share the borrower-safe report for this draw with the borrower? They’ll be able to see it in their portal, including the draw processing fee deducted from their release.')) return; const w = window.open('', '_blank'); act('repb' + draw.sitewire_draw_id, async () => { await api.sitewireDrawReport(appId, draw.sitewire_draw_id, 'borrower', w); return { msg: 'Shared the borrower-safe report with the borrower (opened in a new tab).' }; }); }}>Borrower copy</button>
          {draw.pdf_src && <a className="btn btn-sm soft" href={draw.pdf_src} target="_blank" rel="noreferrer">Inspector PDF</a>}
        </span>
      </div>

      {showPhotos && <InspectionGallery appId={appId} draw={draw} finding={finding} readsOff={readsOff} />}
      {finding && <FindingStatus appId={appId} finding={finding} reload={reload} />}
      {finding && <InvestorDeliveryCard appId={appId} drawId={draw.sitewire_draw_id} reload={reload} />}
    </div>
  );
}

/* INVESTOR DELIVERY (owner-directed 2026-08-03) — once the borrower agrees, the draw goes to the
   note buyer who actually funds it. Everything shown here is computed by the server
   (src/sitewire/investor-delivery*.js): the money, who receives it, and what is blocking the send.
   The screen never re-derives a figure — it prints what the report and the packet were built from. */
function InvestorDeliveryCard({ appId, drawId, reload }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');   // optional note for a MANUAL delivery
  const load = useCallback(() => {
    api.get(`/api/sitewire/files/${appId}/draws/${drawId}/investor-delivery`).then(setP).catch(() => {});
  }, [appId, drawId]);
  useEffect(() => { if (open) load(); }, [open, load]);

  async function setMode(mode, scope) {
    setBusy(true); setErr(''); setMsg('');
    try {
      await api.post(`/api/sitewire/files/${appId}/draws/${drawId}/funding-mode`, { mode, scope });
      load();
    } catch (e) { setErr(e?.data?.error || 'Could not save that choice.'); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!p) return;
    const manual = p.funding_mode === 'manual';
    let ok;
    if (manual) {
      ok = window.confirm(`Record that this draw was delivered to ${p.note_buyer} outside PILOT?\n\nPILOT sends no email — this only records the delivery so the reminders stop.`);
    } else {
      const who = p.to.join(', ');
      const modeLine = p.funding_mode === 'reimbursement'
        ? `They will be asked to REIMBURSE us ${usd2(p.money.investor_total_cents)}.`
        : `They will be asked to release ${usd2(p.money.to_borrower_cents)} to the borrower and ${usd2(p.money.to_us_cents)} to us.`;
      ok = window.confirm(`Deliver this draw to ${p.note_buyer}?\n\nTo: ${who}\n\n${modeLine}\n\nThe draw coordinator, the loan officer and draws@yscapgroup.com are copied. The borrower is never included.`);
    }
    if (!ok) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.post(`/api/sitewire/files/${appId}/draws/${drawId}/investor-delivery`, {
        confirm_note_buyer: p.note_buyer, mode: p.funding_mode, note: manual ? note : undefined,
      });
      if (r.manual) {
        setMsg(`Recorded as delivered to ${p.note_buyer} manually — the "deliver to the investor" reminders will stop.`);
      } else {
        const missing = (r.skipped || []).length;
        setMsg(`Delivered to ${p.note_buyer} (${r.to.length} contact${r.to.length === 1 ? '' : 's'}) with ${r.attachments.length} attachment${r.attachments.length === 1 ? '' : 's'}.${missing ? ` ${missing} item(s) could not be attached — see below.` : ''}`);
      }
      setNote('');
      load(); reload();
    } catch (e) { setErr(e?.data?.error || 'Could not deliver this draw to the investor.'); }
    finally { setBusy(false); }
  }

  // A section that OWNS its action (owner-directed 2026-08-03: "the button is not a nice place").
  // Collapsed, it is a titled row that says what it does with the action on the right — never a
  // bare button floating under the card attached to nothing.
  if (!open) {
    return (
      <div className="act-card">
        <div className="act-card-head">
          <div style={{ minWidth: 220, flex: 1 }}>
            <div className="act-card-title">Investor delivery</div>
            <div className="act-card-sub">Send this draw to the investor who funds it, with the reports, the packet and the signed wire instructions.</div>
          </div>
          <button className="btn btn-sm ghost" onClick={() => setOpen(true)}>Open</button>
        </div>
      </div>
    );
  }
  return (
    <div className="act-card is-open">
      <div className="act-card-head">
        <div style={{ minWidth: 220, flex: 1 }}>
          <div className="act-card-title">Investor delivery</div>
          {p && <div className="act-card-sub">Goes to <b style={{ color: 'var(--text)' }}>{p.note_buyer || 'the note buyer'}</b> with the inspector’s report, our report, the draw packet and the borrower’s signed wire instructions.</div>}
        </div>
        <button className="btn btn-sm soft" onClick={() => setOpen(false)}>Close</button>
      </div>

      {!p ? <div className="act-card-sub" style={{ marginTop: 10 }}>Loading…</div> : (
        <>
          {/* the money, exactly as the report and the packet state it */}
          <dl className="act-figs">
            <dt>Approved on inspection</dt><dd>{usd2(p.money.approved_cents)}</dd>
            <dt>To the borrower</dt><dd>{usd2(p.money.to_borrower_cents)}</dd>
            {p.money.to_us_cents > 0 && (<>
              <dt>Our draw fee</dt><dd>{usd2(p.money.to_us_cents)}</dd>
            </>)}
            <div className="rule" />
            <dt className="tot">Investor funds</dt><dd className="tot">{usd2(p.money.investor_total_cents)}</dd>
          </dl>

          {/* how it is funded — one segmented control, not two look-alike buttons */}
          <div style={{ marginTop: 14 }}>
            <div className="act-label" style={{ display: 'block', marginBottom: 5 }}>How this draw is funded</div>
            <div className="seg" role="group" aria-label="How this draw is funded">
              {(p.modes || []).map((m) => (
                <button key={m.mode} type="button" className={p.funding_mode === m.mode ? 'on' : ''}
                  disabled={busy} title={m.help} aria-pressed={p.funding_mode === m.mode}
                  onClick={() => setMode(m.mode, 'draw')}>{m.label}</button>
              ))}
            </div>
            <div className="act-card-sub" style={{ marginTop: 6 }}>
              {(p.modes || []).find((m) => m.mode === p.funding_mode)?.help}
              {p.funding_mode_source === 'default' ? ' This is the standard arrangement.' : p.funding_mode_source === 'file' ? ' Set as this file’s default.' : ' Set for this draw.'}
              {' '}
              <button className="btn link" style={{ padding: 0, minHeight: 0, fontSize: 13 }} disabled={busy}
                onClick={() => setMode(p.funding_mode, 'file')}>Use for every draw on this file</button>
            </div>
          </div>

          {/* who it goes to — or, for a manual delivery, a note field (PILOT sends no email) */}
          {p.funding_mode === 'manual' ? (
            <div style={{ marginTop: 14 }}>
              <div className="act-label" style={{ display: 'block', marginBottom: 5 }}>Manual delivery</div>
              <div className="act-card-sub" style={{ marginTop: 0, marginBottom: 6 }}>
                PILOT sends no email in this mode — you deliver this draw to the investor yourself and record it here so the reminders stop.
              </div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} disabled={busy}
                placeholder="How it was delivered (optional) — e.g. sent through the investor's portal, or by phone" maxLength={2000} rows={2}
                aria-label="Manual delivery note"
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--hairline,#E4E0D6)', fontSize: 14, color: '#141B22' }} />
            </div>
          ) : (
            <div style={{ marginTop: 14 }}>
              <div className="act-label" style={{ display: 'block', marginBottom: 5 }}>Recipients</div>
              <div className="act-card-sub" style={{ marginTop: 0 }}>
                <b style={{ color: 'var(--text)' }}>To</b> {p.to.length ? p.to.join(', ') : <span style={{ color: 'var(--danger,#B4453C)' }}>no investor contacts saved</span>}<br />
                <b style={{ color: 'var(--text)' }}>Copied</b> {p.cc.join(', ') || '—'}<br />
                The borrower is never included.
              </div>
            </div>
          )}

          {/* the signed wire form's review state — the investor wires the borrower off it, so it
              must be reviewed and accepted first (a MANUAL delivery is handled outside PILOT). */}
          {p.funding_mode !== 'manual' && p.wire_form && (
            <div className="act-card-sub" style={{ marginTop: 12 }}>
              <b style={{ color: 'var(--text)' }}>Signed wire form</b>{' '}
              {p.wire_form.accepted
                ? <span style={{ color: 'var(--good,#2F7F53)' }}>accepted ✓</span>
                : !p.wire_form.present
                  ? <span style={{ color: 'var(--danger,#B4453C)' }}>not signed yet</span>
                  : p.wire_form.rejectedOnly
                    ? <span style={{ color: 'var(--danger,#B4453C)' }}>rejected — needs to be re-signed</span>
                    : <span style={{ color: 'var(--warn,#AE8746)' }}>waiting to be accepted</span>}
            </div>
          )}

          {p.blockers.length > 0 && (
            <ul className="act-card-sub" style={{ marginTop: 12, color: 'var(--danger,#B4453C)', paddingLeft: 18 }}>
              {p.blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}

          <div className="row" style={{ gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-sm primary" disabled={busy || !p.can_send} onClick={send}
              title={p.can_send ? (p.funding_mode === 'manual' ? 'Record this draw as delivered manually' : `Deliver this draw to ${p.note_buyer}`) : 'Clear the items above first'}>
              {busy ? (p.funding_mode === 'manual' ? 'Recording…' : 'Sending…')
                : p.funding_mode === 'manual' ? 'Record manual delivery' : `Deliver to ${p.note_buyer || 'the investor'}`}
            </button>
            {p.history.length > 0 && (
              <span className="act-card-sub" style={{ marginTop: 0 }}>
                Last sent {new Date(p.history[0].sent_at).toLocaleString('en-US')}{p.history[0].status === 'error' ? ' (failed)' : ''} · {p.history.length} on record
              </span>
            )}
          </div>
          {msg ? <div className="act-card-sub" style={{ color: 'var(--primary,#2F7F86)' }}>{msg}</div> : null}
          {err ? <div className="act-card-sub" style={{ color: 'var(--danger,#B4453C)' }}>{err}</div> : null}
        </>
      )}
    </div>
  );
}

/* An <img> for an authenticated endpoint — an <img src> can't send the Bearer token, so we fetch
   the bytes as a blob and hand the tag an object URL. Used for borrower dispute-evidence photos. */
function AuthImg({ path, alt, style, onOpen }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let alive = true, url = null;
    api.authedBlob(path).then((b) => { if (!alive) { return; } url = URL.createObjectURL(b); setSrc(url); }).catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  if (!src) return <span style={{ display: 'inline-block', width: 40, height: 40, borderRadius: 6, background: 'var(--ink-2,#eee)', border: '1px solid var(--line)', ...style }} />;
  return <img src={src} alt={alt || ''} onClick={onOpen} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)', cursor: onOpen ? 'pointer' : 'default', ...style }} />;
}

function FindingStatus({ appId, finding, reload }) {
  const [detail, setDetail] = useState(null);
  const [amt, setAmt] = useState({}); // per-line typed approved dollars (override); defaults to the borrower's ask
  const badge = { delivered: 'Awaiting the borrower', accepted: 'Accepted', disputed: 'Disputed — needs review', resolved: 'Resolved' }[finding.status] || finding.status;
  useEffect(() => { if (finding.status === 'disputed') api.get(`/api/sitewire/findings/${finding.id}`).then(setDetail).catch(() => {}); }, [finding.id, finding.status]);
  async function decide(lineId, decision, dollars) {
    const body = { decision };
    // On approve, send the exact figure staff typed (a negotiated amount) — it overrides in Sitewire.
    if (decision === 'approved' && dollars != null && dollars !== '' && Number.isFinite(Number(dollars))) body.approved_cents = Math.round(Number(dollars) * 100);
    try { await api.post(`/api/sitewire/findings/${finding.id}/lines/${lineId}/decide`, body); const d = await api.get(`/api/sitewire/findings/${finding.id}`); setDetail(d); reload(); } catch (e) { /* surfaced by parent on reload */ }
  }
  // THE BORROWER MAY AGREE OUTSIDE THE PORTAL (owner-directed 2026-08-03): "we should also be able
  // to click that the borrower agreed with the finding in case the borrower gives us his
  // authorization verbally or he writes an email and he's not doing it in the portal." It runs the
  // SAME transition their own Accept button does — the note records how the approval arrived.
  const [recording, setRecording] = useState(false);
  const [recErr, setRecErr] = useState('');
  async function recordAgreement() {
    const note = window.prompt('How did the borrower approve this draw?\n\nFor example: "approved by phone with Yehuda 8/3" or "emailed approval, forwarded to the file". This goes on the file’s audit trail.', '');
    if (note == null) return;
    if (String(note).trim().length < 8) { window.alert('Please write a few words about how the approval arrived — it goes on the file’s audit trail.'); return; }
    setRecording(true); setRecErr('');
    try {
      await api.post(`/api/sitewire/files/${appId}/findings/${finding.id}/mark-accepted`, { note: String(note).trim() });
      reload();
    } catch (e) { setRecErr(e?.data?.error || 'Could not record the borrower’s approval — please try again.'); }
    finally { setRecording(false); }
  }

  return (
    <div style={{ marginTop: 8, borderTop: '1px dashed var(--line,#e6e0d4)', paddingTop: 8 }}>
      <div className="small"><b>Inspection findings:</b> {badge}{finding.wire_due_at && finding.status === 'accepted' ? ` · release due ${new Date(finding.wire_due_at).toLocaleString('en-US')}` : ''}
        {finding.accepted_via === 'staff' ? <span className="muted"> · recorded by the team</span> : null}</div>
      {finding.status === 'delivered' && (
        <div className="act-card" style={{ marginTop: 8 }}>
          <div className="act-card-head">
            <div style={{ minWidth: 220, flex: 1 }}>
              <div className="act-card-title">Waiting on the borrower</div>
              <div className="act-card-sub">If they approved by phone or email instead of in their portal, record it here.</div>
            </div>
            <button className="btn btn-sm ghost" disabled={recording} onClick={recordAgreement}>
              {recording ? 'Recording…' : 'Borrower agreed'}
            </button>
          </div>
        </div>
      )}
      {recErr ? <div className="small" style={{ color: '#B4453C', marginTop: 4 }}>{recErr}</div> : null}
      {detail && detail.lines && detail.lines.filter((l) => l.dispute_status === 'open').map((l) => {
        const defDollars = l.dispute_desired_cents != null ? String(Math.round(Number(l.dispute_desired_cents)) / 100) : '';
        const val = amt[l.id] != null ? amt[l.id] : defDollars;
        return (
        <div key={l.id} style={{ marginTop: 8, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8 }}>
          <div className="row between" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div className="small">{l.name}: borrower wants {l.dispute_desired_cents == null ? '(review)' : usd2(l.dispute_desired_cents)}{l.requested_cents != null ? ` · requested ${usd2(l.requested_cents)}` : ''}{l.dispute_note ? ` — "${l.dispute_note}"` : ''}</div>
            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="small muted">Approve $</span>
              <input type="number" min="0" step="1" value={val} onChange={(e) => setAmt((m) => ({ ...m, [l.id]: e.target.value }))}
                style={{ width: 90, padding: '3px 6px', fontSize: 14 }} aria-label="Approved amount (dollars)"
                title="The amount to approve — overrides in Sitewire. Can't exceed the requested amount." />
              <button className="btn btn-sm primary" onClick={() => decide(l.id, 'approved', val)}>Approve</button>
              <button className="btn btn-sm ghost" onClick={() => decide(l.id, 'rejected')}>Reject</button>
            </div>
          </div>
          {/* borrower's photo/receipt evidence (durable, GPS-stripped), fetched with auth */}
          {Array.isArray(l.dispute_evidence) && l.dispute_evidence.length > 0 && (
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="small muted">Evidence:</span>
              {l.dispute_evidence.map((ev) => (
                ev.kind === 'image'
                  ? <AuthImg key={ev.idx} path={`/api/sitewire/findings/lines/${l.id}/dispute-media/${ev.idx}`} alt={ev.filename} onOpen={() => { const w = window.open('', '_blank'); api.sitewireOpenDisputeMedia(l.id, ev.idx, w).catch(() => {}); }} />
                  : <button key={ev.idx} className="btn btn-xs ghost" onClick={() => { const w = window.open('', '_blank'); api.sitewireOpenDisputeMedia(l.id, ev.idx, w).catch(() => {}); }}>{ev.filename}</button>
              ))}
            </div>
          )}
        </div>
        );
      })}
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
  const [archivedMedia, setArchivedMedia] = useState([]);   // the durable rows (id, kind, request id)
  const [archiving, setArchiving] = useState(false);
  const [archiveMsg, setArchiveMsg] = useState('');
  const loadArchived = useCallback(() => {
    api.get(`/api/sitewire/files/${appId}/draws/${draw.sitewire_draw_id}/archived-media`)
      .then((r) => { setArchivedCount(r.count || 0); setArchivedMedia(Array.isArray(r.media) ? r.media : []); }).catch(() => {});
  }, [appId, draw.sitewire_draw_id]);
  // durable copies grouped by the Sitewire request (draw line) they belong to.
  const durableByReq = new Map();
  for (const m of archivedMedia) { const k = String(m.sitewire_request_id); if (!durableByReq.has(k)) durableByReq.set(k, []); durableByReq.get(k).push(m); }
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
            {(() => {
              // Prefer PILOT's DURABLE copies (they never expire) keyed by the draw line's request id;
              // fall back to Sitewire's live (expiring) media only when this line hasn't been archived yet.
              const reqId = l.request_id != null ? l.request_id : l.sitewire_request_id;
              const durable = durableByReq.get(String(reqId)) || [];
              if (durable.length > 0) {
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 6 }}>
                    {durable.map((m) => {
                      const path = `/api/sitewire/files/${appId}/draws/${draw.sitewire_draw_id}/media/${m.id}`;
                      return m.kind === 'video'
                        ? <button key={m.id} onClick={() => { const w = window.open('', '_blank'); api.authedBlob(path).then((b) => { const u = URL.createObjectURL(b); if (w) w.location.href = u; }).catch(() => {}); }} title="Video (saved to PILOT)" style={{ aspectRatio: '4 / 3', borderRadius: 6, border: '1px solid var(--line,#e6e0d4)', background: '#000', color: '#fff', fontSize: 12, cursor: 'pointer' }}>▶ Video</button>
                        : <AuthImg key={m.id} path={path} alt={l.name || 'inspection'} style={{ width: '100%', height: 'auto', aspectRatio: '4 / 3', borderRadius: 6, border: '1px solid var(--line,#e6e0d4)' }} onOpen={() => { const w = window.open('', '_blank'); api.authedBlob(path).then((b) => { const u = URL.createObjectURL(b); if (w) w.location.href = u; }).catch(() => {}); }} />;
                    })}
                  </div>
                );
              }
              return media.length > 0 ? (
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
              ) : <div className="muted small" style={{ marginTop: 4 }}>No photos on this line.</div>;
            })()}
          </div>
        );
      })}
    </div>
  );
}

function LedgerPanel({ appId, ledger, draws, retainage, oop = null, fees = null, onSaved, act, busy: parentBusy }) {
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
  // Out-of-pocket-first (owner-directed 2026-07-31): the borrower funds the first `floorC` of rehab, so a
  // draw is reimbursed only for the part that clears the running approved total past the floor. This
  // mirrors the server's computeRelease so the net preview matches what will actually be recorded. 0 (no
  // OOP-rehab exception) → reimbursable === approved and the preview is unchanged.
  const floorC = oop && Number(oop.floor_cents) > 0 ? Number(oop.floor_cents) : 0;
  const priorApprovedC = ledger.reduce((s, d) => s + (d.kind === 'draw' ? (Number(d.approved_cents) || 0) : 0), 0);
  const approvedC = centsOrNull(f.approved); // null when the Approved box is blank/garbage
  const feeC = centsOrNull(f.fee) || 0;       // a $0 fee is legitimate
  const reimbursableC = floorC > 0
    ? Math.max(0, (priorApprovedC + (approvedC || 0)) - floorC) - Math.max(0, priorApprovedC - floorC)
    : (approvedC || 0);
  const oopHeldC = (approvedC || 0) - reimbursableC; // the part of this draw that stays out of pocket
  const retC = Math.round(reimbursableC * pct / 100);
  const net = reimbursableC - feeC - retC;
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
  // Summary tiles across the top — released / our fees / net wired / (retainage held).
  const sum = (k, only) => ledger.reduce((s, d) => s + ((!only || d.funded_status === only) ? (Number(d[k]) || 0) : 0), 0);
  const totApproved = sum('approved_cents');
  const totFee = sum('fee_cents');
  const totNet = sum('net_release_cents', 'released');
  const LEDGER_STATUS = { released: { label: 'Released', cls: 'sw-approved' }, held: { label: 'Held', cls: 'sw-pending' }, pending: { label: 'Pending', cls: 'sw-draft' } };
  return (
    <div className="dd-card">
      <div className="dd-card-h" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <span className="dd-card-ic"><SdIcon name="dollar" /></span>
          <div>
            <h3>Money ledger</h3>
            <div className="dd-sub" style={{ marginTop: 1 }}>Our fee comes off the approved amount{pct > 0 ? `, ${pct}% is held as retainage,` : ''} and the borrower nets the rest.</div>
          </div>
        </div>
        <button className="btn btn-sm ghost" onClick={() => api.sitewireExportGl(appId).catch(() => {})}>GL export</button>
      </div>

      {/* summary tiles */}
      <div style={{ marginTop: 12, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gridAutoRows: '1fr' }}>
        <KpiTile label="Approved to date" value={usd(totApproved)} />
        {/* OUR fee income on this project, kept separate from the borrower's money (owner-directed
            2026-08-03). `charged` is what recorded releases actually took; `projected` is the file's
            standard fee on draws that have not been released yet. */}
        <KpiTile label="Our fees" value={usd(totFee)} tone="gold"
          sub={fees && Number(fees.projected_cents) > 0
            ? `+ ${usd(fees.projected_cents)} expected on draws not yet released`
            : (fees && fees.per_draw_cents != null ? `${usd(fees.per_draw_cents)} per draw` : undefined)} />
        <KpiTile label="Net wired to borrower" value={usd(totNet)} tone="teal" sub="released" />
        {showRetainage && <KpiTile label="Retainage held" value={usd(retainage.holding_cents)} sub={retainage.released_cents > 0 ? `released ${usd2(retainage.released_cents)}` : 'held back'} />}
        {floorC > 0 && <KpiTile label="Out-of-pocket rehab" value={usd(floorC)} tone="gold" sub={oop && oop.remaining_cents > 0 ? `${usd2(oop.remaining_cents)} left before draws reimburse` : 'met — draws now reimburse'} />}
      </div>

      {showRetainage && retainage.holding_cents > 0 && (
        <div className="row" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn btn-sm ghost" disabled={parentBusy === 'retrel'}
            onClick={() => act('retrel', async () => { const r = await api.post(`/api/sitewire/files/${appId}/retainage-release`, {}); return { msg: `Retainage released: ${usd2(r.released_cents)}.` }; })}>Release retainage ({usd2(retainage.holding_cents)})</button>
        </div>
      )}

      {ledger.length > 0 && (
        <div className="dd-tablecard" style={{ overflowX: 'auto', marginTop: 12 }}>
          <table className="dd-table" style={{ minWidth: 640 }}>
            <thead><tr><th>Draw</th><th className="num">Approved</th><th className="num">Fee</th>{showRetainage && <th className="num">Retainage</th>}<th className="num">Net release</th><th>Date</th><th>Status</th></tr></thead>
            <tbody>
              {ledger.map((d) => {
                const st = LEDGER_STATUS[d.funded_status] || { label: d.funded_status, cls: 'sw-draft' };
                return (
                  <tr key={d.id}>
                    <td style={{ fontWeight: 600 }}>{d.kind === 'retainage_release' ? 'Retainage' : (d.sitewire_draw_id ? 'Draw #' + (numByDraw[String(d.sitewire_draw_id)] ?? d.sitewire_draw_id) : '—')}</td>
                    <td className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>{usd2(d.approved_cents)}</td>
                    <td className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>{usd2(d.fee_cents)}</td>
                    {showRetainage && <td className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>{usd2(d.retainage_held_cents)}</td>}
                    <td className="num" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: 'var(--teal-br)' }}>{usd2(d.net_release_cents)}</td>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDay(d.release_date)}</td>
                    <td><span className={'pill ' + st.cls}>{st.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* record a release — a clean inline form with a prominent net preview */}
      <div className="dd-card" style={{ marginTop: 12, background: 'var(--paper,#f6f3ec)' }}>
        <div className="dd-field-l" style={{ fontWeight: 700, marginBottom: 8 }}>Record a release</div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
        </div>
        {floorC > 0 && oopHeldC > 0 && (
          <div className="small" style={{ color: 'var(--warning)', marginTop: 8 }}>
            {usd2(oopHeldC)} of this draw is within the borrower’s out-of-pocket rehab ({usd2(floorC)}) and won’t be reimbursed — only {usd2(reimbursableC)} is reimbursable.
          </div>
        )}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 10 }}>
          <div className="small">{floorC > 0 ? <>Reimbursable: <b>{usd2(reimbursableC)}</b> · </> : null}{pct > 0 ? <>Retainage held: <b>{usd2(retC)}</b> · </> : null}Borrower nets: <b style={{ fontSize: 16, color: 'var(--teal-br)' }}>{usd2(net)}</b></div>
          <button className="btn btn-sm primary" disabled={busy || !f.sitewire_draw_id || approvedC == null || approvedC <= 0 || net < 0} onClick={save}>Record release</button>
        </div>
        {err && <div className="small" style={{ color: 'var(--bad,#b04a3f)', marginTop: 6 }}>{err}</div>}
      </div>
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

/* The draw email center — the SAME rich, Gmail-style Email Center used on the regular file screen,
   scoped to this file's draw conversations (draw + Scope-of-Work alerts and their reply threads):
   search, threads, avatars, read/unread, star, per-recipient delivery + open tracking, the full
   designed email in a reader, a full-screen window, and reply/compose. Every draw alert PILOT sends
   to anyone on the file (borrower, coordinator, team) shows here; the borrower's replies come back in.
   (Sitewire's own borrower/inspector emails aren't exposed by their API — this is PILOT's own trail.) */
function DrawEmailCenter({ appId }) {
  return (
    <div className="dd-card" style={{ marginTop: 18 }}>
      <div className="dd-card-h" style={{ marginBottom: 4 }}>
        <span className="dd-card-ic"><SdIcon name="mail" /></span>
        <div>
          <h3>Draw emails</h3>
          <div className="dd-sub" style={{ marginTop: 1 }}>Every draw alert on this file — the draw start, inspection results, releases, budget changes and messages you send — plus the borrower's replies. Open any to read the full email; search, star and reply right here.</div>
        </div>
      </div>
      <EmailCenter mode="file" appId={appId} scope="draw" />
    </div>
  );
}

function ActivityTrail({ appId }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  useEffect(() => { if (open && rows === null) api.get(`/api/sitewire/files/${appId}/activity`).then((d) => setRows(d.activity || [])).catch(() => setRows([])); }, [open, rows, appId]);
  const KIND = { write: 'PILOT → Sitewire', inbound: 'Sitewire → PILOT', draw: 'Draw', money: 'Release', findings: 'Findings', reallocation: 'Budget' };
  const KIND_CLS = { write: 'sw-insp', inbound: 'sw-approved', money: 'sw-approved', findings: 'sw-pending' };
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
              <span className={'pill ' + (KIND_CLS[a.kind] || 'sw-draft')} style={{ flex: 'none' }}>{KIND[a.kind] || a.kind}</span>
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
