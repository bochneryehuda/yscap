import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { goToSection } from './FileSections.jsx';
import {
  PHASE, PURPOSE, ROLE, TERMINAL, timeAgo, absTime, recipientSteps, recipientState,
  agingHours, agingLevel, agingLabel,
} from '../lib/esign.js';

/* Per-file DocuSign section on the internal file screen (owner-directed: "a full
 * DocuSign section... before send show what's outstanding, then live tracking —
 * timestamps, viewed/signed, who we're waiting on, plus resend"). This is the
 * per-file twin of the cross-file cockpit (/internal/esign): the readiness gate
 * + the two Send buttons + every envelope's live per-signer timeline + the
 * management actions (resend / void / re-issue / admin counter-sign / download).
 *
 * Everything is gated server-side (DOCUSIGN_SEND_ENABLED); a disabled send comes
 * back as a clear 409 we surface rather than pretending it sent. */

const PACKAGES = [
  { purpose: 'term_sheet_package', label: 'Term-sheet package', hint: 'Term sheet + application + business-purpose disclosure. Borrower (+ co-borrower) sign, then you counter-sign last.' },
  { purpose: 'heter_iska', label: 'Heter Iska', hint: 'Standalone. Borrower/guarantor sign only — no counter-signature. Never in the TPR export or SharePoint.' },
];

function Recipient({ r }) {
  const steps = recipientSteps(r);
  const state = recipientState(r);
  const declined = state === 'bad';
  const signed = state === 'done';
  return (
    <div className={`esr esr-${state}`}>
      <div className="esr-head">
        <span className="esr-order" aria-hidden="true">{r.routingOrder}</span>
        <span className="esr-who">
          <strong>{r.name || '(no name)'}</strong>
          <span className="muted small">{ROLE[r.role] || r.role}{r.isCountersigner ? ' · signs last' : ''}</span>
        </span>
        <span className="spacer" />
        <span className={`pill ${declined ? 'declined' : signed ? 'ok' : 'muted'}`}>
          {declined ? 'Declined' : signed ? 'Signed' : (r.deliveredAt ? 'Viewing' : 'Waiting')}
        </span>
      </div>
      <div className="esr-mail muted small">{r.email}</div>
      <ol className="esr-steps">
        {steps.map((s) => (
          <li key={s.key} className={`${s.done ? 'on' : ''} ${s.bad ? 'bad' : ''}`}>
            <span className="esr-step-label">{s.label}</span>
            {s.at ? <span className="esr-step-time" title={absTime(s.at)}>{timeAgo(s.at)}</span> : <span className="esr-step-time muted">—</span>}
          </li>
        ))}
      </ol>
      {declined && r.declineReason ? <div className="notice err" style={{ margin: '8px 0 0' }}>Reason: {r.declineReason}</div> : null}
    </div>
  );
}

export default function EsignFileSection({ appId, role, onChanged }) {
  const { actor } = useAuth();
  const isAdmin = role === 'admin' || role === 'super_admin';
  const [data, setData] = useState(null);   // { gate, packages, envelopes, loanNumber }
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');      // action key currently running
  const [lnInput, setLnInput] = useState('');   // inline YS loan-number backfill
  const [openEnvs, setOpenEnvs] = useState({});  // per-envelope expand override (id -> bool)
  const [excOpen, setExcOpen] = useState(false);   // send-before-CTC request form open
  const [excReason, setExcReason] = useState('');  // selected reason code
  const [excNote, setExcNote] = useState('');
  const [encOvrOpen, setEncOvrOpen] = useState(false);  // Encompass-mismatch override form open
  const [encOvrNote, setEncOvrNote] = useState('');     // the admin's recorded reason
  const seq = useRef(0);

  const load = useCallback(async (quiet) => {
    const mine = ++seq.current;
    if (!quiet) setErr('');
    try {
      const r = await api.get(`/api/staff/applications/${appId}/esign`);
      if (mine === seq.current) setData(r);
    } catch (e) { if (mine === seq.current && !quiet) setErr(e.message || 'Could not load e-signatures'); }
  }, [appId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) load(true); }, 20000);
    return () => clearInterval(t);
  }, [load]);

  const msgT = useRef(null);
  // `after` runs only on SUCCESS, after the local esign refetch — used by actions
  // that also change data OUTSIDE this section (clearing a package reopens the
  // file's conditions), so the parent can refetch its conditions panel and it
  // doesn't sit showing a just-reopened condition as still "signed off".
  async function act(key, fn, okMsg, after) {
    setBusy(key); setErr(''); setMsg('');
    if (msgT.current) { clearTimeout(msgT.current); msgT.current = null; }
    try {
      await fn(); if (okMsg) { setMsg(okMsg); msgT.current = setTimeout(() => setMsg(''), 6000); }   // auto-dismiss so a stale "Sent" banner never sits above a failed card
      await load(true);
      if (after) { try { await after(); } catch (_) { /* the parent refresh is best-effort */ } }
    } catch (e) { setErr(e.message || 'Action failed'); }
    finally { setBusy(''); }
  }
  useEffect(() => () => { if (msgT.current) clearTimeout(msgT.current); }, []);

  // A plain send (reissue=false) never re-sends a terminal package — the server
  // returns terminal:true so we steer to the per-envelope Re-issue button. reissue=true
  // (the card's Retry/Re-issue) mints a deliberate fresh envelope.
  // `encOverride` (a non-empty reason) rides along ONLY when an admin is deliberately
  // overriding the Encompass match gate — the server REQUIRES the reason, audits it,
  // and records it in the exception register. Never sent otherwise.
  const send = (purpose, reissue, encOverride) => act(`send:${purpose}`, async () => {
    const body = { purpose, reissue: !!reissue };
    const ovr = String(encOverride || '').trim();
    if (ovr) body.encompassOverrideReason = ovr;
    let r;
    try {
      r = await api.post(`/api/staff/applications/${appId}/esign/send`, body);
    } catch (e) {
      // The Encompass match gate refused. The server's own message says "as an
      // admin you can override — provide a reason", so OPEN the reason box right
      // here instead of leaving that advice with nothing to click. (The panel
      // normally offers it up front from the gate read; this covers a panel whose
      // 20s refresh hasn't caught up with a mismatch that just appeared.)
      if (e && e.data && e.data.code === 'encompass_override_reason_required') setEncOvrOpen(true);
      throw e;
    }
    if (r && (r.dead || r.terminal || r.ok === false)) throw new Error(r.error || 'The document could not be sent — check the file and try again.');
    setEncOvrOpen(false); setEncOvrNote('');
  }, 'Sent for signature.');
  // Inline YS loan-number backfill — a term-sheet package can't send without a loan
  // number (it prints on the disclosure). Validate the "YSCAP" prefix on the client
  // for instant feedback; the server enforces prefix + uniqueness for real.
  const lnValid = /^\s*yscap.+/i.test(lnInput);
  const saveLoanNumber = () => act('loannum', async () => {
    const r = await api.post(`/api/staff/applications/${appId}/loan-number`, { loanNumber: lnInput });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Could not save the loan number.');
    setLnInput('');
  }, 'Loan number saved.');
  const resend = (rowId) => act(`resend:${rowId}`, () => api.post(`/api/staff/esign/${rowId}/resend`), 'Reminder resent.');
  const voidEnv = (rowId) => {
    const reason = window.prompt('Void this envelope — reason (required):');
    if (!reason || !reason.trim()) return;
    return act(`void:${rowId}`, () => api.post(`/api/staff/esign/${rowId}/void`, { reason }), 'Envelope voided.');
  };
  // Clear a package: void it (if still out for signature) OR clear a completed
  // one, remove its signed document from the file, and reopen its conditions so a
  // fresh package can be sent. Warns first — this cannot be undone.
  const clearPkg = (e) => {
    const label = PURPOSE[e.purpose] || e.purpose;
    const ok = window.confirm(
      `Clear the ${label} package?\n\n`
      + `This permanently clears and DELETES this package from the file:\n`
      + `  • the signed document is removed (from its condition and from Documents)\n`
      + `  • the package’s conditions reopen\n`
      + `  • the structure unfreezes and you can send a fresh package with updated details\n\n`
      + `This CANNOT be undone. Continue?`);
    if (!ok) return;
    // Pass onChanged as the success callback so the parent refetches its
    // conditions panel — clearing reopened this package's condition(s).
    return act(`clear:${e.id}`, () => api.post(`/api/staff/esign/${e.id}/clear`, {}), `${label} package cleared — send a fresh one when you’re ready.`, onChanged);
  };
  const countersign = (rowId) => act(`cs:${rowId}`, async () => {
    const { url } = await api.post(`/api/staff/esign/${rowId}/countersign-view`);
    // Navigate in the SAME tab — window.open() after an await is outside the user
    // gesture and gets popup-blocked (Safari especially). DocuSign bounces staff
    // back to the file when done.
    if (!url) throw new Error('Could not open the signing view — please try again.');
    window.location.assign(url);
  });
  const download = (doc) => act(`dl:${doc.documentId}`, async () => {
    const { blob, filename } = await api.staffDownloadDoc(doc.documentId);
    saveBlob(blob, filename || doc.filename);
  });
  // Request a super-admin exception to send the term-sheet package now. May be
  // requested whenever the package can't send (owner-directed 2026-07-24) — the
  // reviewing super-admin sees the full done/outstanding picture and picks
  // exactly which requirements to waive; everything not waived still applies.
  const requestException = () => act('exc:req', async () => {
    const r = await api.requestEsignBeforeCtc(appId, { reasonCode: excReason, reasonNote: excNote });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Could not send the request.');
    setExcOpen(false); setExcNote('');
  }, 'Exception requested — a super-admin will review it.', onChanged);
  const withdrawException = (eid) => act('exc:wd', async () => {
    const r = await api.withdrawException(appId, eid);
    if (!r || !r.ok) throw new Error((r && r.error) || 'Could not withdraw the request.');
  }, 'Exception request withdrawn.', onChanged);

  if (data == null) return <p className="muted small">Loading…</p>;
  // Defaults keep the component safe against an older server payload that lacks the
  // exception fields (sendAllowed falls back to ready; waived flags to false).
  const gate = data.gate || { ready: false, outstanding: [] };
  const sendAllowed = gate.sendAllowed !== undefined ? gate.sendAllowed : gate.ready;
  const outstanding = gate.outstanding || [];               // every blocker, with tier + waived flags
  const waivedOutstanding = gate.waivedOutstanding || outstanding.filter((o) => o.waived);
  const exc = gate.exception || null;                       // latest esign_before_ctc exception (any status)
  const excApproved = !!(exc && exc.status === 'approved');
  const excRequested = !!(exc && exc.status === 'requested');
  // Request-anytime (owner-directed 2026-07-24): whenever the package can't send
  // and no request is pending — the floor being unmet no longer blocks ASKING.
  const canRequestException = gate.canRequestException !== undefined
    ? gate.canRequestException
    : (!gate.ready && !sendAllowed && !excRequested);
  const reasonOpts = data.exceptionReasonCodes || {};
  const envelopes = data.envelopes || [];
  const hasLoanNumber = !!(data.loanNumber && String(data.loanNumber).trim());

  // The SECOND gate on a term-sheet send (owner-reported 2026-07-27). The gate
  // above covers the appraisal / P&P / closing-date prerequisites ONLY; the
  // Encompass match gate blocks the term-sheet package independently, at the
  // send route. So a file with every condition signed off is `gate.ready` here
  // and STILL refused — which used to render as "All prerequisites met" with the
  // escape hatch gone (it lived inside the not-ready branch), and then a send
  // error nobody could act on. Both blockers now show, and each one keeps its
  // OWN way out on screen: a super-admin exception for the prerequisites, the
  // admin override for the Encompass mismatch.
  // Defaults keep this safe against an older server payload with no `encompass`.
  const enc = data.encompass || { block: false, openBlocking: 0, openBlockingKeys: [] };
  // Encompass gates the TERM-SHEET package only (owner-directed 2026-07-26) — the
  // Heter Iska carries no Encompass-sourced numbers and is never held by it.
  const encBlocks = !!enc.block;
  const encFieldCount = enc.openBlocking || (enc.openBlockingKeys || []).length;
  // A THIRD reason the term-sheet package can't send (owner-directed
  // 2026-08-02): the Term Sheet on the file PRINTS "INITIAL TERM SHEET — NOT
  // FINAL". The wording is drawn into the PDF when it is generated, so the send
  // refuses to mail it — and, like the Encompass gate, it has to show HERE or
  // the officer meets the refusal only after pressing Send. Same shape, same
  // rule: the blocker and its one-step way out appear together. Defaults keep
  // this safe against an older server payload with no `termSheet`.
  const tsDoc = data.termSheet || { onFile: false, final: false, block: false };
  const tsStampBlocks = !!tsDoc.block;
  const termSheetStarted = envelopes.some((e) => e.purpose === 'term_sheet_package');
  // Everything that must be true before the override button can actually send.
  const encOvrSendable = sendAllowed && hasLoanNumber && !termSheetStarted;

  // Retry / Re-issue from an envelope card. The override box in the readiness
  // panel drives the FIRST send only, so a term-sheet package that failed or was
  // voided needs its own way past the Encompass check — asked for right here,
  // the same way Void asks for its reason.
  const reissueSend = (e) => {
    // A re-issue mails the term sheet stored on the file right now, so it meets
    // the same "the sheet that goes out is the final one" rule as a first send —
    // and there is no override for it, because the fix is one re-registration.
    if (tsStampBlocks && e.purpose === 'term_sheet_package') {
      setErr('The term sheet on this file still prints “INITIAL TERM SHEET — NOT FINAL”. Re-register the product in Products & Pricing — that regenerates it as the final version — then re-issue.');
      return;
    }
    if (encBlocks && e.purpose === 'term_sheet_package') {
      if (!isAdmin) {
        setErr('Encompass doesn’t match this file yet — fix the fields in the Encompass sync section, or ask an admin to make an exception for this send.');
        return;
      }
      const reason = window.prompt(
        'Encompass still doesn’t match this file.\n\n'
        + 'Send this package anyway? Say why — it is recorded on the file and in the exception register:');
      if (!reason || !reason.trim()) return;
      return send(e.purpose, true, reason);
    }
    return send(e.purpose, true);
  };

  // Group the envelopes so a succeeded/active package isn't buried under a pile of
  // failed attempts (owner-directed 2026-07-20). Per package: the ones worth seeing now
  // — completed or still in flight — stay expanded; older failed/voided/declined attempts
  // collapse into a "past attempts" section you can open. If a package has ONLY failed
  // attempts, its newest one stays visible so you can retry it.
  const isFailedEnv = (e) => ['error', 'declined', 'voided'].includes(e.phase) || !!e.deadLetteredAt;
  const shownEnv = [], pastEnv = [];
  {
    const byPurpose = {};
    for (const e of envelopes) (byPurpose[e.purpose] = byPurpose[e.purpose] || []).push(e);   // server orders newest-first
    for (const group of Object.values(byPurpose)) {
      const good = group.filter((e) => !isFailedEnv(e));
      if (good.length) { shownEnv.push(...good); pastEnv.push(...group.filter(isFailedEnv)); }
      else { shownEnv.push(group[0]); pastEnv.push(...group.slice(1)); }
    }
    const byNewest = (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    shownEnv.sort(byNewest); pastEnv.sort(byNewest);
  }

  const renderEnvelope = (e) => {
    const ph = PHASE[e.phase] || { label: e.phase, cls: 'muted', dot: '#4B585C' };
    const h = agingHours(e);
    const lvl = agingLevel(h);
    const terminal = TERMINAL.includes(e.phase);   // shared vocabulary (esign.js) — no drift
    // A package can be CLEARED while it is LIVE — out for signature (awaiting_borrower/
    // awaiting_countersign) OR already fully signed (completed). Void alone can't undo a
    // completed one; Clear can (it clears our side, reopens the conditions, unfreezes the file).
    const clearable = !!e.envelopeId && ['awaiting_borrower', 'awaiting_countersign', 'completed'].includes(e.phase);
    const recips = (e.recipients || []).slice().sort((a, b) => Number(a.routingOrder) - Number(b.routingOrder) || String(a.role).localeCompare(String(b.role)));
    // Each envelope collapses to a one-line summary (owner-directed: "the
    // e-signature of each and every package is very big — that should all be
    // able to be collapsed into small things"). Default collapsed; the summary
    // row still shows the status + who we're waiting on. An envelope that needs
    // ACTION right now — the admin's counter-signature, or a failed/declined/
    // voided attempt whose Retry/Re-issue button lives in the body — starts
    // expanded so nothing actionable is hidden behind a click.
    const autoOpen = e.phase === 'awaiting_countersign' || e.phase === 'error'
      || e.phase === 'declined' || e.phase === 'voided' || !!e.deadLetteredAt;
    const open = openEnvs[e.id] != null ? openEnvs[e.id] : autoOpen;
    const toggle = () => setOpenEnvs((m) => ({ ...m, [e.id]: !(m[e.id] != null ? m[e.id] : autoOpen) }));
    return (
      <div className="panel esign-card" key={e.id} style={{ marginBottom: 12 }}>
        <div className="row esign-card-head" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer' }}
          onClick={toggle} role="button" tabIndex={0}
          onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } }}
          aria-expanded={open}>
          <span className={`sec-chevron${open ? ' open' : ''}`} aria-hidden="true">▶</span>
          <span className="pill muted">{PURPOSE[e.purpose] || e.purpose}</span>
          <span className={`pill ${ph.cls}`}><span className="esign-dot" style={{ background: ph.dot }} aria-hidden="true" />{ph.label}</span>
          {e.waitingOn && lvl ? (
            <span className={`pill esign-aging ${lvl}`} title={`No progress for ${agingLabel(h)}`}>⏱ {agingLabel(h)}</span>
          ) : null}
          {!open && e.waitingOn ? <span className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {e.phase === 'awaiting_countersign' ? 'ready for your counter-signature' : `waiting on ${e.waitingOn.name}`}</span> : null}
          <div className="spacer" />
          {e.envelopeId ? <span className="muted small esign-env" title="DocuSign envelope ID">{e.envelopeId}</span> : null}
          <span className="muted small" style={{ flex: 'none' }}>{open ? 'Hide' : 'Show'}</span>
        </div>

        {!open ? null : <>
        {e.waitingOn ? (
          <div className={`esign-waiting ${e.phase === 'awaiting_countersign' ? 'is-admin' : ''}`}>
            {e.phase === 'awaiting_countersign'
              ? <>Ready for your counter-signature — <strong>{e.waitingOn.name}</strong></>
              : <>Waiting on <strong>{e.waitingOn.name}</strong> ({ROLE[e.waitingOn.role] || e.waitingOn.role})</>}
          </div>
        ) : null}
        {(e.phase === 'error' || e.deadLetteredAt) && e.lastError ? <div className="notice err" style={{ margin: '10px 0 0' }}><strong>Send failed.</strong> {e.lastError}</div> : null}
        {e.phase === 'voided' && e.voidReason ? <div className="notice info" style={{ margin: '10px 0 0' }}>Voided: {e.voidReason}</div> : null}

        <div className="esign-recips">
          {recips.map((r) => <Recipient key={r.id || `${r.role}-${r.routingOrder}`} r={r} />)}
        </div>

        {/* Legally-binding summary once the package is fully signed */}
        {e.phase === 'completed' ? (
          <div className="notice ok" style={{ margin: '10px 0 0' }}>
            <strong>Legally binding.</strong> All parties signed{e.completedAt ? ` — completed ${timeAgo(e.completedAt)}` : ''}.
            {' '}The DocuSign <strong>Certificate of Completion</strong> — the legal record of who signed, when, and from where (signer identities, timestamps, IP addresses) — {e.certificate ? 'is available to download below.' : 'is being retrieved and will appear here shortly.'}
          </div>
        ) : null}

        {/* Actions */}
        <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {e.phase === 'awaiting_countersign' && isAdmin && (
            <button className="btn primary btn-sm" disabled={busy === `cs:${e.id}`} onClick={() => countersign(e.id)}>
              {busy === `cs:${e.id}` ? '…' : 'Counter-sign now'}
            </button>
          )}
          {!terminal && e.envelopeId && (
            <>
              <button className="btn ghost btn-sm" disabled={busy === `resend:${e.id}`} onClick={() => resend(e.id)}>{busy === `resend:${e.id}` ? '…' : 'Resend reminder'}</button>
              <button className="btn ghost btn-sm" disabled={busy === `void:${e.id}`} onClick={() => voidEnv(e.id)}>Void</button>
            </>
          )}
          {(e.phase === 'declined' || e.phase === 'voided' || e.phase === 'error') && sendAllowed && (
            <button className="btn primary btn-sm"
              disabled={busy === `send:${e.purpose}` || (e.purpose === 'term_sheet_package' && !hasLoanNumber)}
              title={e.purpose === 'term_sheet_package' && !hasLoanNumber ? 'Enter the YS loan number above first'
                : (tsStampBlocks && e.purpose === 'term_sheet_package')
                  ? 'The term sheet on file still prints “NOT FINAL” — re-register the product to regenerate it as the final one'
                : (encBlocks && e.purpose === 'term_sheet_package')
                  ? (isAdmin ? 'Encompass doesn’t match yet — you’ll be asked for a reason to send anyway'
                    : 'Encompass doesn’t match yet — fix the fields, or ask an admin to make an exception for this send')
                  : 'Send a fresh envelope for this package'}
              onClick={() => reissueSend(e)}>{busy === `send:${e.purpose}` ? '…' : (e.phase === 'error' ? 'Retry send' : 'Re-issue')}</button>
          )}
          {clearable && (
            <button className="btn ghost btn-sm" style={{ color: 'var(--bad, #b04a3f)', borderColor: 'var(--bad, #b04a3f)' }}
              disabled={busy === `clear:${e.id}`}
              title="Clear this package — removes the signed document and reopens its conditions so you can send a fresh one. This cannot be undone."
              onClick={() => clearPkg(e)}>{busy === `clear:${e.id}` ? '…' : 'Clear & delete package'}</button>
          )}
          {(e.documents || []).map((d) => (
            <button key={d.documentId} className="btn ghost btn-sm" disabled={busy === `dl:${d.documentId}`} onClick={() => download(d)}
              title={`Download ${d.filename}`}>{busy === `dl:${d.documentId}` ? '…' : `↓ ${(d.docKind || '').replace(/_signed$/, '').replace(/_/g, ' ')}`}</button>
          ))}
          {e.certificate ? (
            <button className="btn ghost btn-sm" disabled={busy === `dl:${e.certificate.documentId}`} onClick={() => download(e.certificate)}
              title="DocuSign Certificate of Completion — the legal audit trail (signers, timestamps, IP addresses)">{busy === `dl:${e.certificate.documentId}` ? '…' : '↓ certificate'}</button>
          ) : null}
        </div>
        </>}
      </div>
    );
  };

  return (
    <div className="esign-file">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
      {msg && <div className="notice ok" style={{ marginBottom: 10 }}>{msg}</div>}

      {/* Readiness gate + Send buttons */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h4 style={{ margin: 0 }}>Ready to send?</h4>
          <div className="spacer" />
          {/* Never say "All prerequisites met" while the Encompass check is still
              holding the term-sheet package — that headline is what sent people
              to a Send button that could only fail. */}
          <span className={`pill ${encBlocks || tsStampBlocks ? 'warn' : gate.ready ? 'ok' : sendAllowed ? 'warn' : 'muted'}`}>
            {encBlocks ? 'Encompass doesn’t match yet'
              : tsStampBlocks ? 'Term sheet isn’t the final one yet'
              : gate.ready ? 'All prerequisites met'
              : sendAllowed ? 'Cleared by exception' : 'Not yet'}
          </span>
        </div>
        {gate.ready ? (
          <ul className="esign-gate">
            <li className="ok"><span className="esign-gate-ic">✓</span> Appraisal back · reviewed · product re-priced after the appraisal.</li>
          </ul>
        ) : (
          <>
            {/* Every outstanding requirement in ONE list. A blocker a super-admin
                waived shows as ✓ "waived"; everything else still blocks. Items that
                make the signed term sheet itself correct carry a tag. */}
            {outstanding.length > 0 && (
              <ul className="esign-gate">
                {outstanding.map((o) => (
                  <li key={o.code} className={o.waived ? 'ok' : 'bad'}>
                    <span className="esign-gate-ic">{o.waived ? '✓' : '✗'}</span> <strong>{o.label}</strong>
                    {' '}— <span className="muted small">{o.waived ? 'waived by an approved super-admin exception' : o.reason}</span>
                    {!o.waived && o.tier === 'floor' ? (
                      <span className="ts-badge warn" style={{ marginLeft: 6 }} title="This requirement makes the signed term sheet itself correct.">term-sheet correctness</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {/* The super-admin exception path (owner-directed 2026-07-24): can be
                REQUESTED whenever the package can't send — the reviewer sees the
                full done/outstanding picture and picks exactly what to waive. */}
            {excApproved && sendAllowed ? (
              <div className="notice ok" style={{ margin: '2px 0 10px' }}>
                <strong>Approved to send by super-admin exception.</strong>
                {' '}{waivedOutstanding.length
                  ? <>Waived: {waivedOutstanding.map((o) => o.label).join('; ')}.</>
                  : 'Every requirement is otherwise met.'}
                {exc.decision_note ? ` — ${exc.decision_note}` : ''}
              </div>
            ) : excApproved && !sendAllowed ? (
              <div className="notice err" style={{ margin: '2px 0 10px' }}>
                <strong>The approved exception no longer covers everything.</strong> The picture changed since the
                approval — the item(s) marked ✗ above still block the send. Complete them, or request a fresh
                exception below.
              </div>
            ) : excRequested ? (
              <div className="notice info" style={{ margin: '2px 0 10px' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="ts-badge warn">Exception requested — awaiting super-admin review</span>
                  {/* Only the requester (or an admin) may withdraw — matches the server rule. */}
                  {(isAdmin || (actor && exc.requested_by === actor.id))
                    ? <button className="btn ghost btn-sm" disabled={busy === 'exc:wd'} onClick={() => withdrawException(exc.id)}>Withdraw request</button>
                    : <span className="muted small">Only the requester or an admin can withdraw it.</span>}
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  The super-admin sees everything that’s done and still outstanding, and chooses exactly which
                  requirements to waive — anything not waived still applies.
                </div>
              </div>
            ) : null}
            {canRequestException ? (
              <div style={{ margin: '2px 0 10px' }}>
                {exc && exc.status === 'denied' && (
                  <div className="muted small" style={{ marginBottom: 6 }}>A previous exception request was denied{exc.decision_note ? ` — ${exc.decision_note}` : ''}.</div>
                )}
                {!excOpen ? (
                  <button className="btn ghost btn-sm" onClick={() => { setExcOpen(true); setErr(''); }}>
                    Request a super-admin exception to send now
                  </button>
                ) : (
                  <div style={{ padding: 10, background: 'rgba(174,135,70,0.08)', border: '1px solid #AE8746', borderRadius: 8 }}>
                    <div className="muted small" style={{ marginBottom: 6 }}>
                      Ask a super-admin to approve sending the term-sheet package now. They’ll see the full picture —
                      what’s already done and what’s still outstanding — and tick exactly which requirements to waive
                      (for example: “this sign-off is waived, but you still must re-register the product”). Anything
                      they don’t waive still applies before the package can go out. Use this too when a system flag is
                      blocking the send in error.
                    </div>
                    <label className="muted small">Reason</label>
                    <select className="input" value={excReason} onChange={(e) => setExcReason(e.target.value)} style={{ width: '100%', marginBottom: 6 }}>
                      <option value="">Select a reason…</option>
                      {Object.entries(reasonOpts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                    <textarea className="input" rows={2} style={{ width: '100%' }}
                      placeholder="Explain why this needs to go out now…"
                      value={excNote} onChange={(e) => setExcNote(e.target.value)} />
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <button className="btn primary btn-sm" disabled={busy === 'exc:req' || !excNote.trim()} onClick={requestException}>
                        {busy === 'exc:req' ? 'Sending…' : 'Send request'}
                      </button>
                      <button className="btn ghost btn-sm" onClick={() => { setExcOpen(false); setExcNote(''); }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}

        {/* THE ENCOMPASS MATCH BLOCKER — deliberately OUTSIDE the gate.ready
            branch above (owner-reported 2026-07-27). It is a separate gate on the
            term-sheet package, so it must show whether or not the prerequisites
            are met, and it carries its OWN way out: an admin overrides it for
            this one send with a recorded reason (exactly what the send route's
            own refusal message offers), and everyone else gets the real fix —
            make the two systems agree — one click away. */}
        {encBlocks && (
          <div className="notice err" style={{ margin: '2px 0 10px' }}>
            <div>
              <strong>Encompass and this file don’t agree yet.</strong>{' '}
              {encFieldCount ? <>{encFieldCount} field{encFieldCount === 1 ? '' : 's'} {encFieldCount === 1 ? 'doesn’t' : 'don’t'} match. </> : null}
              The term-sheet package can’t go out for signature until they match — or until an admin
              lets this one send through anyway. <span className="muted small">(The Heter Iska is not affected.)</span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn ghost btn-sm" onClick={() => goToSection('sec-encompass')}>
                See what doesn’t match
              </button>
              {isAdmin && !encOvrOpen ? (
                <button className="btn ghost btn-sm" onClick={() => { setEncOvrOpen(true); setErr(''); }}>
                  Send anyway — make an exception for this send
                </button>
              ) : null}
            </div>
            {!isAdmin ? (
              <div className="muted small" style={{ marginTop: 6 }}>
                Fix the fields so both systems agree — or ask an admin to make an exception for this send.
              </div>
            ) : null}
            {isAdmin && encOvrOpen ? (
              <div style={{ marginTop: 8, padding: 10, background: 'rgba(174,135,70,0.08)', border: '1px solid #AE8746', borderRadius: 8 }}>
                <div className="muted small" style={{ marginBottom: 6 }}>
                  You’re letting this ONE send go out while Encompass still disagrees. Say why — it’s
                  recorded on the file and in the exception register. It changes nothing in Encompass and
                  doesn’t apply to any future send.
                </div>
                <textarea className="input" rows={2} style={{ width: '100%' }}
                  placeholder="Why is it OK to send while these fields don’t match?"
                  value={encOvrNote} onChange={(e) => setEncOvrNote(e.target.value)} />
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <button className="btn primary btn-sm"
                    disabled={busy === 'send:term_sheet_package' || !encOvrNote.trim() || !encOvrSendable}
                    onClick={() => send('term_sheet_package', false, encOvrNote)}>
                    {busy === 'send:term_sheet_package' ? 'Sending…' : 'Send the term-sheet package anyway'}
                  </button>
                  <button className="btn ghost btn-sm" onClick={() => { setEncOvrOpen(false); setEncOvrNote(''); }}>Cancel</button>
                </div>
                {/* The override only clears the ENCOMPASS check — every other
                    reason the package can't send still applies, so say which one. */}
                {!encOvrSendable ? (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {termSheetStarted ? 'This package is already started — manage it on its envelope below (Resend / Void / Re-issue).'
                      : !hasLoanNumber ? 'Enter the YS loan number above first.'
                      : 'The send requirements above still have to be met (or waived by a super-admin exception) — this override only clears the Encompass check.'}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
        {/* THE TERM SHEET THAT GOES OUT IS THE FINAL ONE (owner-directed
            2026-08-02): "the term sheet that goes out through DocuSign should
            not say NOT FINAL — it goes to everybody after you finished all the
            required steps." The INITIAL/FINAL wording is printed into the PDF
            when it is generated, so a sheet made before the file was ready
            still says it isn't final and the send refuses it. Shown OUTSIDE the
            gate.ready branch for the same reason the Encompass blocker is: it
            holds a file whose prerequisites are all met, and it carries its own
            one-step fix — re-register, which regenerates and re-attaches the
            sheet stamped FINAL. */}
        {tsStampBlocks && (
          <div className="notice err" style={{ margin: '2px 0 10px' }}>
            <div>
              <strong>The term sheet on this file is still the initial one.</strong>{' '}
              It prints “INITIAL TERM SHEET — NOT FINAL”, so it can’t go out for signature — the sheet everyone
              signs has to be the final one. Re-register the product in Products &amp; Pricing: that regenerates
              the term sheet and attaches it as the final version, and nothing else about the deal changes.
              {' '}<span className="muted small">(The Heter Iska is not affected.)</span>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn ghost btn-sm" onClick={() => goToSection('sec-pricing')}>
                Open Products &amp; Pricing
              </button>
            </div>
          </div>
        )}
        {/* Inline loan-number backfill — the term-sheet package prints the loan number
            on the disclosure, so a file without one can't send. Enter it right here. */}
        {!hasLoanNumber && (
          <div className="notice info" style={{ margin: '2px 0 10px' }}>
            <div><strong>This file has no YS loan number yet.</strong> A loan number is required to send the term-sheet package — enter it here to send right away.</div>
            <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input className="input" style={{ maxWidth: 240 }} placeholder="YSCAP…" value={lnInput}
                onChange={(e) => setLnInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter' && lnValid && busy !== 'loannum') saveLoanNumber(); }} />
              <button className="btn primary btn-sm" disabled={!lnValid || busy === 'loannum'} onClick={saveLoanNumber}>
                {busy === 'loannum' ? 'Saving…' : 'Save loan number'}
              </button>
              {lnInput && !lnValid ? <span className="muted small">Must start with “YSCAP”.</span> : null}
            </div>
          </div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {PACKAGES.map((p) => {
            // The term-sheet package additionally needs a loan number; Heter Iska does not.
            const needsLoan = p.purpose === 'term_sheet_package' && !hasLoanNumber;
            // Once a package has ANY envelope on the file, the top Send is retired for it —
            // otherwise clicking it again just piled up duplicate envelopes ("send send
            // send"). Manage that package from its envelope card below (Resend / Void /
            // Re-issue). The first send is the only one that starts here.
            const already = envelopes.some((e) => e.purpose === p.purpose);
            // The Encompass match gate holds the TERM-SHEET package only. This
            // button used to stay enabled through it and could only ever fail —
            // the way out (override / fix the fields) lives in the blocker box
            // above, so point there instead of firing a doomed send.
            const encHeld = encBlocks && p.purpose === 'term_sheet_package';
            // Same treatment as the Encompass hold: the term sheet on file
            // printing "NOT FINAL" holds the TERM-SHEET package only, and the
            // send can only ever fail while it does — so point at the fix above
            // instead of firing a doomed send.
            const tsHeld = tsStampBlocks && p.purpose === 'term_sheet_package';
            const blocked = !sendAllowed || needsLoan || already || encHeld || tsHeld;
            const title = already ? 'This package is already started — manage it on its envelope below (Resend / Void / Re-issue)'
              : needsLoan ? 'Enter the YS loan number above first'
              : tsHeld ? 'The term sheet on file still prints “NOT FINAL” — re-register the product to regenerate it as the final one'
              : encHeld ? (isAdmin
                ? 'Encompass doesn’t match yet — use “Send anyway — make an exception for this send” above'
                : 'Encompass doesn’t match yet — fix the fields, or ask an admin to make an exception for this send')
              : (sendAllowed ? (gate.ready ? p.hint : `${p.hint} (approved by super-admin exception)`) : 'Complete the outstanding requirements above first — or request a super-admin exception to send now');
            return (
              <button key={p.purpose} className="btn primary btn-sm" disabled={blocked || busy === `send:${p.purpose}`}
                title={title} onClick={() => send(p.purpose)}>
                {busy === `send:${p.purpose}` ? 'Sending…' : already ? `${p.label} — see below` : `Send ${p.label}`}
              </button>
            );
          })}
        </div>
        <p className="muted small" style={{ margin: '8px 0 0' }}>
          Each signer is emailed a secure link to review and sign — you can watch every step below.
        </p>
      </div>

      {/* Envelopes sent for this file — every package sent, with its live status,
          signers, signed PDFs and the completion certificate, right here on the file. */}
      <div className="row" style={{ alignItems: 'baseline', margin: '4px 0 8px' }}>
        <h4 style={{ margin: 0 }}>Envelopes sent for this file</h4>
        <div className="spacer" />
        {envelopes.length ? <span className="muted small">{envelopes.length} {envelopes.length === 1 ? 'envelope' : 'envelopes'}</span> : null}
      </div>
      {envelopes.length === 0 ? (
        <p className="muted small">No packages sent yet. Once you send one above, it appears here with its live status, signers, signed PDFs and certificate.</p>
      ) : (
        <>
          {shownEnv.map(renderEnvelope)}
          {pastEnv.length > 0 && (
            <details className="esign-past-attempts" style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', padding: '10px 12px', borderRadius: 8, background: 'var(--ink-2, #f4f2ec)', border: '1px solid var(--line, #e4e0d6)', color: 'var(--text-muted, #4B585C)', fontSize: 13, fontWeight: 600, listStyle: 'none' }}>
                ▸ {pastEnv.length} earlier {pastEnv.length === 1 ? 'attempt' : 'attempts'} that didn’t go through (failed / voided / declined) — click to show
              </summary>
              <div style={{ marginTop: 10 }}>{pastEnv.map(renderEnvelope)}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
