import React, { useCallback, useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { ChainAddress, ChainDocuments, ChainHistory } from './ClosingEmailChain.jsx';
import DocPreview from './DocPreview.jsx';
import EmailPreview from './EmailPreview.jsx';
import { ScheduleButton, ScheduledSends, useScheduledSends } from './ScheduleSend.jsx';
import ClosingHandlingControl from './ClosingHandlingControl.jsx';

/* ════════════════════════════════════════════════════════════════════════════
   ATTORNEY CLOSING PREP — the third order on the Orders desk.

   Sends the closing attorney "File ready for closing prep": the deal in words,
   the term sheet, the contract and assignments, the entity documents, the
   insurance binder + invoice and the borrower's ID as real attachments, and the
   title company's details IN THE BODY (never a Cc — the attorney opens their own
   chain with title).

   The card's job beyond the button is to remove every surprise BEFORE the send:
   exactly which documents will attach, which of the owner's named sets are still
   empty, anything that will not fit the email, who is on the To and the Cc, and
   the unique closing address the attorney is asked to keep on their chain.

   Text colours are explicit dark hex on purpose — the legacy `--ink*` tokens are
   LIGHT in this palette and would render invisible on the white card.
   ════════════════════════════════════════════════════════════════════════════ */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = 'var(--gold,#AE8746)';
// `.notice` in styles.css carries ONLY padding/radius/font-size — border and
// background live on its `.err`/`.ok`/`.info`/`.warn` variants. Setting borderColor
// on a bare `.notice` therefore drew nothing at all, so every gold callout on this
// card rendered as unboxed body text. These are the surface a callout needs.
const CALLOUT = { border: `1px solid ${GOLD}`, background: 'var(--paper,#F6F3EC)' };

/* PLACED — the closing-prep order exists and has not been stood down. ONE
   definition, because it is needed in TWO places that sit on opposite sides of
   this card's loading gate: the scheduling door near the top of the component,
   and the render body below the `if (!data) return` early exit.

   It is a module-level function rather than a `const` inside the component for a
   reason that cost a production outage: the scheduling door used to read the
   `placed` binding declared ~90 lines FURTHER DOWN the same function scope. A
   `const` is hoisted but uninitialised until its declaration runs, so reading it
   above that line is a ReferenceError ("Cannot access 'placed' before
   initialization") thrown on EVERY render of this card — and this card is
   rendered by the Orders desk on every file, so every file's order section died
   in the ErrorBoundary. Declaring it up here, on a status string that is
   available before the gate, makes the ordering un-gettable-wrong. */
const isPlacedStatus = (status) => status !== 'not_ordered' && status !== 'cancelled';

/** Who is ACTUALLY copied, counted rather than assumed — the old wording asserted a
    loan officer even on an unassigned file and read "The loan officer are copied." */
function copiedLine(team = {}) {
  const who = [];
  if (team.officer) who.push('the loan officer');
  if (team.processor) who.push('the processor');
  if (team.closer) who.push('our closer');
  if (!who.length) return 'Nobody from the team is copied — this file has no loan officer, processor or closer assigned.';
  const list = who.length === 1 ? who[0] : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
  const verb = who.length === 1 ? 'is' : 'are';
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${verb} copied.`;
}
const TEAL = 'var(--teal,#2F7F86)';

const STATUS_LABEL = {
  not_ordered: 'Not requested', ordered: 'Requested', documents_in: 'Documents in',
  completed: 'Completed', cancelled: 'Cancelled',
};
/* Every blocker code this card can NAME. The server's `closing-prep.blockers()` is
   the authority on which codes can arrive, and scripts/test-order-blocker-labels-pure.js
   fails the build the moment that list gains a code with no wording here — because a
   blocker the card cannot name used to render as an EMPTY "To send this, first:" box
   over a disabled Send button: a dead end with no words (the 'usps' code shipped
   exactly that way). Codes outside this list still render, through the fallback line. */
const KNOWN_BLOCKERS = ['loan_number', 'not_registered', 'term_sheet', 'attorney', 'documents_unavailable', 'usps'];
const STATUS_TONE = {
  not_ordered: { borderColor: GOLD, color: GOLD },
  ordered: { borderColor: TEAL, color: TEAL },
  documents_in: { borderColor: TEAL, color: TEAL },
  completed: { borderColor: 'var(--ok)', color: 'var(--ok)' },
  cancelled: { opacity: 0.6 },
};
const KB = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

/* Exactly what will be attached, grouped, with everything empty called out — and,
   owner-directed 2026-08-03, each document openable right here: "in the closing
   prep email we should also see all the documents over there in the closing prep
   order and we should also have the preview button". Checking that the term sheet
   and the binder about to go to the attorney are the right files is the point of
   showing the list at all. */
function DocumentPreview({ documents, isAssignment, vestsIndividually, isRefinance, onPreview, onDownload }) {
  const [open, setOpen] = useState(false);
  const groups = documents.groups || [];
  const total = groups.reduce((n, g) => n + g.docs.length, 0);
  // A package bigger than one email is SPLIT across the closing chain, not trimmed.
  // So the question the card answers is "how many emails?", not "what gets left off?".
  // Only the documents in `willSkip` are genuinely not going.
  const skipBytes = (documents.willSkip || []).reduce((n, d) => n + (Number(d.size_bytes) || 0), 0);
  const sendBytes = Math.max(0, (documents.totalBytes || 0) - skipBytes);
  const budget = Number(documents.budgetBytes) || 0;
  const partsNeeded = budget > 0 ? Math.max(1, Math.ceil(sendBytes / budget)) : 1;
  // A tab still running yesterday's bundle has no `maxParts`; treat that as "no cap
  // to warn about" rather than warning on every multi-part package.
  const partCap = Number(documents.maxParts) || 0;
  const overParts = partCap > 0 && partsNeeded > partCap;
  // The server already drops the groups this deal does not need (assignment on a
  // straight purchase, purchase contract on a refinance, entity documents on an
  // individual). This mirror-filter is belt-and-suspenders so a stale bundle can
  // never show a document as outstanding that the deal does not require.
  const missing = (documents.missing || []).filter((m) => {
    if (m.key === 'assignment' && !isAssignment) return false;
    if (m.key === 'contract' && isRefinance) return false;
    if (m.key === 'llc' && vestsIndividually) return false;
    return true;
  });
  const ins = documents.insurance || {};
  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, color: INK }}>
          {total} document{total === 1 ? '' : 's'} will be attached
        </div>
        <span className="muted small" style={{ color: MUTED }}>{KB(documents.totalBytes)}</span>
        <button className="btn link small" style={{ padding: 0 }} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide the list' : 'Show the list'}
        </button>
      </div>

      {partsNeeded > 1 && (
        <div className="small" style={{ color: MUTED, marginTop: 3 }}>
          That is more than one email can carry, so it goes out as{' '}
          <b style={{ color: INK }}>{partsNeeded} emails</b> on the same closing chain — the attorney gets
          everything, in order, in one conversation.
        </div>
      )}

      {documents.termSheetExecuted
        ? <div className="small" style={{ color: MUTED, marginTop: 3 }}>
            The term sheet on this file is the <b style={{ color: INK }}>fully executed</b> one — that is what will be sent.
          </div>
        : <div className="small" style={{ color: MUTED, marginTop: 3 }}>
            The <b style={{ color: INK }}>initial</b> term sheet will be sent, clearly marked as not final until all
            parties sign. When it is executed, the signed copy goes out on this same email chain automatically.
          </div>}

      {open && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {groups.map((g) => (
            <div key={g.key} style={{ borderTop: '1px solid var(--line,#D9D4C8)', paddingTop: 6 }}>
              <div className="small" style={{ fontWeight: 700, color: INK }}>{g.label}</div>
              {g.docs.length === 0
                ? <div className="small" style={{ color: MUTED }}>Nothing on file</div>
                : g.docs.map((d) => (
                    <div key={d.id} className="row small" style={{ color: MUTED, gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '1px 0' }}>
                      <span style={{ flex: 1, minWidth: 160 }}>
                        {d.filename} · {KB(d.size_bytes)}
                        {d.slot_label ? ` · ${d.slot_label}` : ''}
                        {d.review_status && d.review_status !== 'accepted' ? ` · ${d.review_status}` : ''}
                      </span>
                      {onPreview && <button className="btn ghost small" onClick={() => onPreview(d)} title="Open it here without downloading">Preview</button>}
                      {onDownload && <button className="btn ghost small" onClick={() => onDownload(d)}>Download</button>}
                    </div>
                  ))}
            </div>
          ))}
        </div>
      )}

      {/* Insurance is the one set with two named halves the attorney will look for. */}
      {(documents.counts || {}).insurance > 0 && (!ins.binder || !ins.invoice) && (
        <div className="small" style={{ color: MUTED, marginTop: 6 }}>
          Insurance: {ins.binder ? 'binder ✓' : 'no binder labelled'} · {ins.invoice ? 'invoice ✓' : 'no invoice labelled'}
          {ins.unclassified ? ` · ${ins.unclassified} document${ins.unclassified === 1 ? '' : 's'} came back from the agent but nobody has labelled ${ins.unclassified === 1 ? 'it' : 'them'} yet` : ''}
          . They will still be attached.
        </div>
      )}

      {/* WAITING TO BE ACCEPTED — held back, not missing (owner-directed
          2026-08-03). These documents ARE on the file; nobody has accepted them,
          so they are not attached. Shown before "not on the file yet" and worded
          differently on purpose: sending somebody to chase a borrower for a
          document that is sitting in the building is the exact confusion the
          old "Nothing on file" line created. */}
      {(documents.awaiting || []).length > 0 && (
        <div className="notice" style={{ marginTop: 8, ...CALLOUT }}>
          <b style={{ color: INK }}>Waiting to be accepted — not attached:</b>
          <ul style={{ margin: '3px 0 0 18px', padding: 0, color: MUTED }}>
            {(documents.awaiting || []).map((d) => (
              <li key={d.id} className="small">{d.filename}{d.groupLabel ? ` — ${d.groupLabel}` : ''}</li>
            ))}
          </ul>
          <div className="small" style={{ color: MUTED, marginTop: 3 }}>
            These are on the file already. Only documents somebody has accepted go to the attorney —
            accept them on their condition and they will be included.
          </div>
        </div>
      )}

      {vestsIndividually && (
        <div className="small" style={{ color: MUTED, marginTop: 6 }}>
          This file closes in the borrower&rsquo;s <b style={{ color: INK }}>personal name</b> — no entity
          documents are required, and the attorney email says so.
        </div>
      )}

      {missing.length > 0 && (
        <div className="notice" style={{ marginTop: 8, ...CALLOUT }}>
          <b style={{ color: INK }}>Not on the file yet:</b>{' '}
          <span style={{ color: MUTED }}>
            {missing.map((m) => `${m.label}${m.awaitingCount ? ` (${m.awaitingCount} waiting to be accepted)` : ''}`).join(' · ')}
          </span>
          <div className="small" style={{ color: MUTED, marginTop: 3 }}>
            The email says these are coming. You can send now and they follow later, or add them first.
          </div>
        </div>
      )}

      {(documents.willSkip || []).length > 0 && (
        <div className="notice" style={{ marginTop: 8, ...CALLOUT }}>
          <b style={{ color: INK }}>These cannot be attached:</b>
          <ul style={{ margin: '3px 0 0 18px', padding: 0, color: MUTED }}>
            {(documents.willSkip || []).map((d, i) => (
              <li key={i} className="small">
                {d.filename} — {d.reason === 'too large to email'
                  ? `bigger than one whole email on its own (${KB(documents.budgetBytes)} is the most one can carry)`
                  : 'we have no stored copy of it'}
              </li>
            ))}
          </ul>
          <div className="small" style={{ color: MUTED, marginTop: 3 }}>
            Everything else still goes, across as many emails as it takes. The email names these so the
            attorney knows to ask — send them a smaller copy, or split the file, if you need them there now.
          </div>
        </div>
      )}

      {overParts && (
        <div className="notice err" style={{ marginTop: 8 }}>
          <b>These documents need more than the {partCap} emails we will send.</b>
          <div className="small" style={{ marginTop: 3 }}>
            The last ones will be left off — the email names every one it could not attach, and after
            sending you will see exactly which. Send anyway, or trim the biggest files first.
          </div>
        </div>
      )}
    </div>
  );
}

/* Who gets it — and the box for looping in more people. */
function Recipients({ recipients, team, contacts, extra, setExtra, disabled }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <button className="btn link small" style={{ padding: 0 }} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} who gets this email
      </button>
      {open && (
        <div className="small" style={{ marginTop: 5, color: MUTED }}>
          <div><b style={{ color: INK }}>To:</b> {recipients.to.join(', ') || '— nobody yet'}</div>
          <div><b style={{ color: INK }}>Cc:</b> {recipients.cc.join(', ') || '—'} <span>(visible to everyone)</span></div>
          <div style={{ marginTop: 4 }}>{copiedLine(team)}</div>
          {team.closerAmbiguous && (
            <div style={{ color: 'var(--danger)', marginTop: 3 }}>
              No closer is assigned to this file and there is more than one closer on the team — assign
              one on the file so they are copied.
            </div>
          )}
          {(contacts.title.length > 0 || contacts.other.length > 0) && (
            <div style={{ marginTop: 6 }}>
              <b style={{ color: INK }}>In the body, not copied:</b>{' '}
              {[...contacts.title, ...contacts.other].map((c) => c.label).join(' · ')}
              <div>The attorney opens their own chain with title — so their details are given, not Cc'd.</div>
            </div>
          )}
          <div style={{ marginTop: 6 }}>The insurance contact is never included.</div>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <label className="muted small" style={{ color: MUTED }}>Loop in more email addresses (optional, comma separated)</label>
        <input className="input" value={extra} disabled={disabled}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="someone@example.com, someone.else@example.com" />
      </div>
    </div>
  );
}

/* `onChanged` lets the card tell whoever hosts it that the closing order moved —
   the Orders panel refreshes the sibling title/insurance cards and the section
   badges off it. Without it the three order sections each held their own copy of
   the file and only the one you touched was ever right. */
export default function ClosingPrepCard({ appId, onChanged = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [extra, setExtra] = useState('');
  const [note, setNote] = useState('');
  const [showDeal, setShowDeal] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [followMsg, setFollowMsg] = useState('');
  const [previewDoc, setPreviewDoc] = useState(null);

  const load = useCallback(() => {
    setErr('');
    api.staffClosingPrep(appId)
      .then((d) => { setData(d); setExtra(((d.recipients || {}).extraEmails || []).join(', ')); })
      .catch((e) => setErr((e && e.message) || 'Could not load closing prep.'));
  }, [appId]);
  useEffect(() => { load(); }, [load]);
  /* Reload THIS card and tell the host the order moved, so the sibling order
     sections and the section badges stop showing a file that has moved on.
     Deliberately not folded into `load` itself: that also runs on mount, and
     announcing a change nobody made would cost a round trip on every render. */
  const reload = useCallback(() => { load(); if (onChanged) onChanged(); }, [load, onChanged]);

  const download = async (d) => {
    try { const { blob, filename } = await api.staffDownloadDoc(d.id); saveBlob(blob, filename || d.filename); }
    catch (_) { /* ignore */ }
  };

  /* SEND IT LATER. The intent is queued; `gatherPackage` runs at the due moment,
     so outside counsel receives the closing package as it stands when the email
     actually goes — not as it stood at 2am.

     Keyed on the order's STATUS STRING, read straight off the payload this
     component already holds. Two things follow from that, and both are the point:
     the hook sits ABOVE the `if (!data) return` gate below (a hook may never move
     under an early return — that is the "rendered more hooks than during the
     previous render" crash), and it depends on nothing declared further down. It
     also reloads the queue when the order moves BETWEEN two placed statuses,
     which a boolean could not see. Same idiom as OrdersPanel's own cards. */
  const orderStatus = ((data && data.order) || {}).status;
  const sched = useScheduledSends(appId, [orderStatus]);
  const scheduleIt = async ({ day, time, override }) => {
    const r = await api.staffScheduleClosingPrep(appId, {
      day, time, force: isPlacedStatus(orderStatus),
      extraEmails: extra.split(/[,;\s]+/).filter(Boolean),
      note,
      // A subject/body edited in the preview rides the stored intent, so the
      // dispatcher's re-post lands it through the place route's own override door.
      ...(override ? { override } : {}),
    });
    await sched.reload();
    setMsg({ tone: (r.warnings && r.warnings.length) ? 'warn' : 'ok',
      text: (r.warnings && r.warnings.length)
        ? `Scheduled for ${r.scheduled.sendAtText}. It will NOT go out unless you also: ${r.warnings.join(' ')}`
        : `Closing-prep request scheduled for ${r.scheduled.sendAtText}.` });
    onChanged && onChanged();
  };

  /* THE EDITABLE PREVIEW (owner-directed 2026-08-26): Send / Re-send / Follow-up first
     open the send's OWN built email — subject + body, fully editable — and the send
     carries only what was changed. The preview runs the same pure builders the place
     route runs (buildClosingPrepEmail / buildFollowupEmail), so it can never show a
     different email than the one that goes out. */
  const [preview, setPreview] = useState(null);   // {mode, force, subject, text, to, cc}
  const openSendPreview = async (mode, force) => {
    setBusy('preview'); setMsg(null);
    try {
      const q = mode === 'followup' ? { followup: '1', ...(followMsg.trim() ? { note: followMsg.trim() } : {}) } : (note.trim() ? { note: note.trim() } : null);
      const pv = await api.staffClosingPrepEmailPreview(appId, q);
      setPreview({ mode, force: !!force, subject: pv.subject || '', text: pv.text || '', to: pv.to || [], cc: pv.cc || [] });
    } catch (e) {
      setMsg({ tone: 'err', text: (e && e.message) || 'Could not build the email preview.' });
    } finally { setBusy(''); }
  };
  const place = async (force, override) => {
    setBusy('place'); setMsg(null);
    try {
      const r = await api.staffPlaceClosingPrep(appId, {
        force: !!force,
        extraEmails: extra.split(/[,;\s]+/).filter(Boolean),
        note,
        ...(override ? { override } : {}),
      });
      const skipped = r.skipped || [];
      const failed = r.partsFailed || [];
      const parts = Number(r.parts) || 1;
      setMsg({
        tone: (skipped.length || failed.length) ? 'warn' : 'ok',
        text: `Sent to ${(r.sent_to || []).join(', ')}${r.cc && r.cc.length ? ` (cc ${r.cc.length})` : ''} with ${(r.attached || []).length} document${(r.attached || []).length === 1 ? '' : 's'} attached`
          + (parts > 1 ? `, across ${parts} emails on the closing chain.` : '.')
          + (skipped.length ? ` ${skipped.length} could not be attached — the email names them: ${skipped.map((s) => `${s.filename} (${s.reason})`).join('; ')}.` : '')
          // Part 1 has already gone out naming every document, so a part that did not
          // follow must be said out loud — otherwise the attorney is short files the
          // email promised and nobody here knows.
          + (failed.length ? ` ${failed.length} of the follow-on emails did not send — these documents did NOT reach the attorney: ${failed.map((f) => f.files.join(', ')).join('; ')}. Re-send to try again.` : ''),
      });
      setNote('');
      reload();
    } catch (e) {
      // The server's own wording wins — see the note on the same branch in
      // OrdersPanel: a hard-coded string here tells somebody who just pressed
      // "force a re-send" to force a re-send.
      if (e && e.status === 409) setMsg({ tone: 'warn', text: (e && e.message) || 'Closing prep was already requested for this file. Use Follow-up, or force a re-send below.', canForce: !(e.data && e.data.code === 'too_soon') });
      else setMsg({ tone: 'err', text: (e && e.message) || 'Could not send the closing-prep request.' });
    } finally { setBusy(''); }
  };

  const followup = async (override) => {
    setBusy('follow'); setMsg(null);
    try {
      const r = await api.staffClosingPrepFollowup(appId, {
        message: followMsg,
        extraEmails: extra.split(/[,;\s]+/).filter(Boolean),
        ...(override ? { override } : {}),
      });
      setMsg({ tone: 'ok', text: `Follow-up sent on the closing chain to ${(r.sent_to || []).join(', ')}.` });
      setFollowMsg(''); setFollowOpen(false); reload();
    } catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not send the follow-up.' }); }
    finally { setBusy(''); }
  };

  /* CANCEL NOW EMAILS OUTSIDE COUNSEL (owner-directed 2026-08-07). The old confirm said "Nobody is
     emailed", which was true then and is exactly the behaviour the owner asked to change: an
     attorney holding our package and a term sheet has to be told to stand down, not just quietly
     dropped off the updates.

     A REASON BOX, not a confirm dialog. The reason goes INTO the email counsel receives ("this is
     a brokered file, it is closing with RCN"), which is the single most useful line on it — and a
     browser confirm cannot collect one. `reopen` keeps its one-click path: putting an order back
     on the desk emails nobody and needs no explanation. */
  const cancel = async (reopen) => {
    setBusy('cancel'); setMsg(null);
    try {
      const r = await api.staffCancelClosingPrep(appId, reopen, reopen ? null : cancelReason);
      setCancelOpen(false); setCancelReason('');
      // Say which of the two things happened. "Cancelled" and "cancelled AND counsel was told"
      // are different states, and assuming the second when only the first is true is how an
      // attorney ends up drafting a file nobody is working.
      if (!reopen) {
        setMsg(r && r.notified
          ? { tone: 'ok', text: 'Cancelled — the attorney has been told to disregard this file, and no further updates will go out to them.' }
          : { tone: 'warn', text: 'Cancelled and all further updates are stopped — but we could not send the cancellation email. Contact the attorney directly.' });
      }
      reload();
    } catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not update.' }); }
    finally { setBusy(''); }
  };

  if (err) return <div className="notice err">{err}</div>;
  if (!data) return <p className="muted small">Loading closing prep…</p>;

  const order = data.order || {};
  const blockers = order.blockers || [];
  const placed = isPlacedStatus(order.status);
  // A CANCELLED order still leaves its 'order' message on the chain (cancelling
  // deliberately keeps everything the attorney already sent). So plain "send" would
  // lose to that message's claim and answer 409 "use Follow-up, or force a re-send"
  // — while Follow up is hidden in exactly this state. Sending from here IS a
  // re-send, so it goes down the re-send path and says so.
  const orderOnChain = ((data.chain && data.chain.messages) || [])
    .some((m) => m.event_kind === 'order' && (m.status === 'sent' || m.status === 'carried'));
  const file = data.file || {};
  const isAssignment = !!file.isAssignment;
  const vestsIndividually = !!file.vestsIndividually;
  const isRefinance = !!file.isRefinance;
  const ready = blockers.length === 0;

  return (
    <div className="panel" style={{ marginTop: 0 }}>
      {/* WHO HANDLES THIS CLOSING (owner-directed 2026-08-28): the three-way
          per-file switch, shown before anything can be sent — with the full
          reason whenever it turns this card off. The routes enforce the same
          rule server-side. */}
      <ClosingHandlingControl appId={appId} onChanged={reload} />
      <div className="row" style={{ alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h3 style={{ margin: 0, color: INK }}>Attorney closing prep</h3>
        <span className="pill" style={STATUS_TONE[order.status] || {}}>{STATUS_LABEL[order.status] || order.status}</span>
        {order.followupCount > 0 && <span className="muted small" style={{ color: MUTED }}>· {order.followupCount} follow-up{order.followupCount === 1 ? '' : 's'}</span>}
      </div>
      <div className="small" style={{ color: MUTED, marginBottom: 6 }}>
        Sends the closing attorney "File ready for closing prep" — the deal, the term sheet, the
        contract and assignments, the entity documents, the insurance binder and invoice and the
        borrower's ID — and opens this closing's own email chain.
      </div>

      {order.orderedAt && (
        <div className="small" style={{ color: MUTED, marginBottom: 6 }}>
          Requested {when(order.orderedAt)}{order.lastFollowupAt ? ` · last follow-up ${when(order.lastFollowupAt)}` : ''}
        </div>
      )}

      {/* The deal, exactly as the attorney will see it. */}
      <div>
        <button className="btn link small" style={{ padding: 0 }} onClick={() => setShowDeal((s) => !s)}>
          {showDeal ? 'Hide' : 'Show'} the deal details that go in the email
        </button>
        {showDeal && (
          <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
            {(data.deal || []).map((r, i) => (
              <div key={i} className="small">
                <span style={{ color: MUTED }}>{r.label}: </span>
                <span style={{ color: INK, fontWeight: 600 }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <DocumentPreview documents={data.documents || {}} isAssignment={isAssignment}
        vestsIndividually={vestsIndividually} isRefinance={isRefinance}
        onPreview={setPreviewDoc} onDownload={download} />

      <Recipients recipients={data.recipients || { to: [], cc: [] }} team={data.team || {}}
        contacts={data.contacts || { title: [], other: [] }}
        extra={extra} setExtra={setExtra} disabled={!!busy} />

      {/* WHO SIGNS, AND AS WHAT — a nudge, not a blocker (owner-directed
          2026-08-09: "when the closer gets the closing desk, if it's not filled
          yet they should tell her that she needs to fill it"). A title prints
          under the signature line on every recorded instrument and the document
          engine merges it verbatim, so a blank one is real missing work. It is
          deliberately NOT in `blockers`: refusing the whole closing-prep order
          over something the closer can fix in ten seconds, while they are looking
          right at it, would be worse than saying so plainly here. */}
      {(file.ownersMissingTitles || []).length > 0 && (
        <div className="notice" style={{ marginTop: 10, ...CALLOUT }} role="status">
          <div style={{ fontWeight: 600, marginBottom: 4, color: INK }}>
            {file.ownersMissingTitles.length === 1
              ? 'One owner of the vesting entity has no title yet'
              : `${file.ownersMissingTitles.length} owners of the vesting entity have no title yet`}
          </div>
          <div className="small" style={{ color: MUTED }}>
            {file.ownersMissingTitles.join(', ')} — a title (Managing Member, President…) prints under each
            signature on the recorded documents, so the closing package cannot be drafted without one. Set it
            on the vesting entity in the Borrower section of this file.
          </div>
        </div>
      )}
      {/* WHICH KIND OF PARTNERSHIP OR TRUST. "General partnership" and "limited
          partnership" are different legal entities with different liability, and
          that word is printed onto the recorded instrument — so it is worth
          settling before the documents are drafted. Same posture as the rest:
          the desk is told, the order is not blocked. */}
      {!!file.entitySubtypeNeeded && (
        <div className="notice" style={{ marginTop: 10, ...CALLOUT }} role="status">
          <div style={{ fontWeight: 600, marginBottom: 4, color: INK }}>
            What kind of {String(file.entityKind || 'entity').toLowerCase()} is {file.entityName}?
          </div>
          <div className="small" style={{ color: MUTED }}>
            A general partnership and a limited partnership are different legal entities, and a revocable trust
            has no EIN of its own — so this decides both what the documents call it and what we can ask the
            borrower for. Set it on the vesting entity in the Borrower section.
          </div>
        </div>
      )}
      {/* NOBODY HAS SAID WHAT KIND OF COMPANY THIS IS. Everything treats it as an
          LLC in the meantime, which it usually is — but the loan documents describe
          an LLC's members and operating agreement where a corporation has
          shareholders and bylaws, so the closing desk is the last cheap moment to
          settle it. Also a nudge, for the same reason. */}
      {!!file.entityName && !file.entityTypeConfirmed && (
        <div className="notice" style={{ marginTop: 10, ...CALLOUT }} role="status">
          <div style={{ fontWeight: 600, marginBottom: 4, color: INK }}>Confirm what {file.entityName} is</div>
          <div className="small" style={{ color: MUTED }}>
            Nobody has said whether it is an LLC, a corporation, a partnership or a trust, so the documents will
            describe it as an LLC. Set the entity type on the vesting entity in the Borrower section if that is wrong.
          </div>
        </div>
      )}

      {/* What still has to happen first — each with the action, never a silently
          greyed-out button (a loan officer reads a disabled button as "not allowed"). */}
      {!ready && (
        <div className="notice" style={{ marginTop: 10, ...CALLOUT }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: INK }}>
            {placed ? 'Before you can send this again:' : 'To send this, first:'}
          </div>
          <ul style={{ margin: '0 0 2px 18px', padding: 0, color: MUTED }}>
            {blockers.includes('loan_number') && <li>Add the file's loan number — the box at the top of this section.</li>}
            {blockers.includes('not_registered') && <li>Register the product in Products &amp; Pricing. The attorney needs a term sheet to draft from.</li>}
            {blockers.includes('term_sheet') && <li>Generate the term sheet, so there is one to attach.</li>}
            {/* NOT "add an attorney contact to the file" — that contact is the
                BORROWER'S own lawyer, who is deliberately never a recipient here
                (they are handed over in the body instead). Adding one changes
                nothing, so the old wording sent people to do something that could
                not work. Same words the server answers with. */}
            {blockers.includes('attorney') && <li>Ask an admin to set up the closing attorney's group inbox — there is nowhere to send this yet. Adding an attorney contact to the file will not help: that contact is the borrower's own lawyer and is never copied on this email.</li>}
            {blockers.includes('documents_unavailable') && <li>We could not read this file's documents just now. Try again in a moment.</li>}
            {/* THE USPS ADDRESS GATE — the same rule the title and insurance orders
                have: nothing carrying the property address goes to an outside party
                until the USPS-verified address is imported. Same words the server
                answers with. */}
            {blockers.includes('usps') && <li>Import the USPS-verified property address — open <b style={{ color: INK }}>USPS Address Verification</b> on this file's conditions list, verify the subject address, and click "Import verified address". The attorney drafts the closing documents off this address, so it goes out USPS-verified or not at all. If USPS cannot confirm the address, a super admin can accept it there as an exception.</li>}
            {/* A blocker this screen has no wording for still SHOWS — an empty
                "To send this, first:" box over a disabled button is a dead end. */}
            {blockers.filter((b) => !KNOWN_BLOCKERS.includes(b)).map((b) => (
              <li key={b}>Something on the server is holding this order (its code is "{b}") and this screen does not know how to explain it yet. Refresh the page — if this line is still here, the portal needs an update.</li>
            ))}
          </ul>
        </div>
      )}

      {!placed && ready && (
        <div style={{ marginTop: 10 }}>
          <label className="muted small" style={{ color: MUTED }}>Anything to add at the top of the email (optional)</label>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. the seller's attorney is copied on the contract — please loop them in." />
        </div>
      )}

      <ScheduledSends rows={sched.rows} onCancel={sched.cancel} kinds={['closing_prep']} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {!placed && (
          <button className="btn primary small" disabled={!!busy || !ready} onClick={() => openSendPreview('place', orderOnChain)}
            title={ready
              ? (orderOnChain ? 'Send the closing-prep request again, with the documents as they stand now'
                : 'Send the closing-prep request to the attorney')
              : 'Finish the steps listed above first'}>
            {busy === 'place' ? 'Sending…' : (orderOnChain ? 'Send closing prep request again' : 'Send closing prep request')}
          </button>
        )}
        {!placed && (
          <ScheduleButton onSchedule={scheduleIt} busy={!!busy} what="the closing-prep request" />
        )}
        {placed && (
          <>
            <button className="btn primary small" disabled={!!busy} onClick={() => setFollowOpen((o) => !o)}>Follow up</button>
            <button className="btn ghost small" disabled={!!busy || !ready} onClick={() => openSendPreview('place', true)}
              title={ready ? 'Send the whole request again, with the documents as they stand now' : 'Finish the steps listed above first'}>
              {busy === 'place' ? 'Sending…' : 'Re-send request'}
            </button>
            <ScheduleButton onSchedule={scheduleIt} busy={!!busy} what="the closing-prep request" />
            {/* NOT on a FINISHED request. Cancelling is an explicit stand-down
                that shuts the follow-up and reply doors on the closing chain, so
                on a request that already finished it can only cost the team the
                ability to write to counsel about a deal that is done. Reopen is
                the action there. */}
            {order.status !== 'completed' && (
              <button className="btn ghost small" disabled={!!busy} style={{ color: 'var(--danger)' }}
                onClick={() => { setCancelOpen((o) => !o); setFollowOpen(false); }}
                title="Tell the attorney to disregard this file and stop every further update to them">
                Cancel closing prep
              </button>
            )}
          </>
        )}
        {/* Both ways this order ends. It reaches 'completed' on its own once the
            deal is over (closing-prep.retireClosedOrdersOnce), so offering Reopen
            only for 'cancelled' left a closed file that came back to life with no
            way back onto the desk. */}
        {(order.status === 'cancelled' || order.status === 'completed') && (
          <button className="btn ghost small" disabled={!!busy} onClick={() => cancel(true)}
            title="Put this request back on the Orders desk without re-sending it">
            Reopen
          </button>
        )}
      </div>

      {preview && (
        <EmailPreview
          title={preview.mode === 'followup' ? 'Follow-up on the closing prep' : 'Closing-prep request email'}
          subject={preview.subject} text={preview.text} to={preview.to} cc={preview.cc}
          subjectLocked={preview.mode === 'followup' || preview.force}
          lockNote="This goes out on the file's closing email chain, so its subject is kept."
          busy={busy === 'place' || busy === 'follow'}
          sendLabel={preview.mode === 'followup' ? 'Send follow-up' : (preview.force ? 'Re-send request' : 'Send request')}
          warning="The document package is attached at send time — the attachment list in the sent copy names exactly what rode along."
          onClose={() => setPreview(null)}
          onSend={async (override) => {
            if (preview.mode === 'followup') await followup(override); else await place(preview.force, override);
            setPreview(null);
          }}
          /* Scheduling from INSIDE the preview keeps the edit — the outside ScheduleButton
             has no edit to carry. A follow-up cannot be scheduled (no such kind). */
          scheduleWhat="the closing-prep request"
          onSchedule={preview.mode === 'followup' ? null : async (override, { day, time }) => {
            await scheduleIt({ day, time, override });
            setPreview(null);
          }} />
      )}

      {followOpen && (
        <div className="panel" style={{ background: 'var(--surface-soft, #f4f1ea)', marginTop: 10 }}>
          <label className="muted small" style={{ color: MUTED }}>Follow-up message (optional — a default is sent if blank)</label>
          <textarea className="input" rows={3} value={followMsg} onChange={(e) => setFollowMsg(e.target.value)}
            placeholder="Following up on the closing prep…" />
          <div className="small" style={{ color: MUTED, marginTop: 4 }}>
            This goes out on the same email chain, to everyone already on it.
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary small" disabled={busy === 'follow'} onClick={() => openSendPreview('followup')}>
              {busy === 'follow' ? 'Sending…' : 'Preview & send follow-up'}
            </button>
            <button className="btn ghost small" onClick={() => { setFollowOpen(false); setFollowMsg(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {cancelOpen && (
        <div className="panel" style={{ background: 'var(--surface-soft, #f4f1ea)', marginTop: 10, borderLeft: '3px solid var(--danger, #B24A2B)' }}>
          <div style={{ fontWeight: 700, color: INK }}>Cancel closing prep</div>
          <div className="small" style={{ color: MUTED, marginTop: 4 }}>
            The attorney is emailed on this same chain and told to disregard the file and stop work.
            After this, nothing further goes out to them — no executed term sheet, no closing-date
            change, no clear-to-close. Everything they already sent stays on the file, and you can
            reopen the request later if the deal comes back.
          </div>
          <label className="muted small" style={{ color: MUTED, display: 'block', marginTop: 8 }}>
            Why (optional — this goes in the email they receive)
          </label>
          <textarea className="input" rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}
            placeholder="e.g. This is a brokered file — it is closing with RCN." />
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary small" disabled={busy === 'cancel'}
              style={{ background: 'var(--danger, #B24A2B)', borderColor: 'var(--danger, #B24A2B)' }}
              onClick={() => cancel(false)}>
              {busy === 'cancel' ? 'Cancelling…' : 'Cancel and tell the attorney'}
            </button>
            <button className="btn ghost small" disabled={busy === 'cancel'}
              onClick={() => { setCancelOpen(false); setCancelReason(''); }}>Keep it open</button>
          </div>
        </div>
      )}

      {msg && (
        <div className={`notice ${msg.tone === 'ok' ? 'ok' : msg.tone === 'warn' ? '' : 'err'}`} style={{ marginTop: 10 }} role="status">
          {msg.text}
          {msg.canForce && <> <button className="btn link small" onClick={() => openSendPreview('place', true)}>Force re-send</button></>}
        </div>
      )}

      {/* What the system will send on this chain by itself — stated up front, so the
          team knows the attorney gets these without anyone remembering to. */}
      <div className="small" style={{ color: MUTED, marginTop: 12, borderTop: '1px solid var(--line,#D9D4C8)', paddingTop: 8 }}>
        <b style={{ color: INK }}>Sent on this chain automatically:</b> the executed term sheet the moment
        all parties sign · every new expected closing date · clear to close.
      </div>

      <ChainAddress chain={data.chain} />
      <ChainDocuments chain={data.chain} onDownload={download} />
      <ChainHistory appId={appId} chain={data.chain} />
      {previewDoc && (
        <DocPreview
          title={previewDoc.slot_label || 'Closing prep document'}
          filename={previewDoc.filename}
          load={() => api.staffDownloadDoc(previewDoc.id)}
          onDownload={() => download(previewDoc)}
          onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}
