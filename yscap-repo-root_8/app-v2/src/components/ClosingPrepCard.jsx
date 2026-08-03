import React, { useCallback, useEffect, useState } from 'react';
import { api, saveBlob } from '../lib/api.js';
import { ChainAddress, ChainDocuments, ChainHistory } from './ClosingEmailChain.jsx';
import DocPreview from './DocPreview.jsx';

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
function DocumentPreview({ documents, isAssignment, onPreview, onDownload }) {
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
  // An assignment set is only "missing" on a deal that IS an assignment.
  const missing = (documents.missing || []).filter((m) => !(m.key === 'assignment' && !isAssignment));
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

      {missing.length > 0 && (
        <div className="notice" style={{ marginTop: 8, ...CALLOUT }}>
          <b style={{ color: INK }}>Not on the file yet:</b>{' '}
          <span style={{ color: MUTED }}>{missing.map((m) => m.label).join(' · ')}</span>
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

  const place = async (force) => {
    setBusy('place'); setMsg(null);
    try {
      const r = await api.staffPlaceClosingPrep(appId, {
        force: !!force,
        extraEmails: extra.split(/[,;\s]+/).filter(Boolean),
        note,
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
      if (e && e.status === 409) setMsg({ tone: 'warn', text: 'Closing prep was already requested for this file. Use Follow-up, or force a re-send below.', canForce: true });
      else setMsg({ tone: 'err', text: (e && e.message) || 'Could not send the closing-prep request.' });
    } finally { setBusy(''); }
  };

  const followup = async () => {
    setBusy('follow'); setMsg(null);
    try {
      const r = await api.staffClosingPrepFollowup(appId, {
        message: followMsg,
        extraEmails: extra.split(/[,;\s]+/).filter(Boolean),
      });
      setMsg({ tone: 'ok', text: `Follow-up sent on the closing chain to ${(r.sent_to || []).join(', ')}.` });
      setFollowMsg(''); setFollowOpen(false); reload();
    } catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not send the follow-up.' }); }
    finally { setBusy(''); }
  };

  const cancel = async (reopen) => {
    if (!reopen && !window.confirm('Cancel the closing-prep request? Nobody is emailed, and anything the attorney already sent stays on the file.')) return;
    setBusy('cancel'); setMsg(null);
    try { await api.staffCancelClosingPrep(appId, reopen); reload(); }
    catch (e) { setMsg({ tone: 'err', text: (e && e.message) || 'Could not update.' }); }
    finally { setBusy(''); }
  };

  if (err) return <div className="notice err">{err}</div>;
  if (!data) return <p className="muted small">Loading closing prep…</p>;

  const order = data.order || {};
  const blockers = order.blockers || [];
  const placed = order.status !== 'not_ordered' && order.status !== 'cancelled';
  // A CANCELLED order still leaves its 'order' message on the chain (cancelling
  // deliberately keeps everything the attorney already sent). So plain "send" would
  // lose to that message's claim and answer 409 "use Follow-up, or force a re-send"
  // — while Follow up is hidden in exactly this state. Sending from here IS a
  // re-send, so it goes down the re-send path and says so.
  const orderOnChain = ((data.chain && data.chain.messages) || [])
    .some((m) => m.event_kind === 'order' && (m.status === 'sent' || m.status === 'carried'));
  const isAssignment = !!(data.file || {}).isAssignment;
  const ready = blockers.length === 0;

  return (
    <div className="panel" style={{ marginTop: 0 }}>
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
        onPreview={setPreviewDoc} onDownload={download} />

      <Recipients recipients={data.recipients || { to: [], cc: [] }} team={data.team || {}}
        contacts={data.contacts || { title: [], other: [] }}
        extra={extra} setExtra={setExtra} disabled={!!busy} />

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

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {!placed && (
          <button className="btn primary small" disabled={!!busy || !ready} onClick={() => place(orderOnChain)}
            title={ready
              ? (orderOnChain ? 'Send the closing-prep request again, with the documents as they stand now'
                : 'Send the closing-prep request to the attorney')
              : 'Finish the steps listed above first'}>
            {busy === 'place' ? 'Sending…' : (orderOnChain ? 'Send closing prep request again' : 'Send closing prep request')}
          </button>
        )}
        {placed && (
          <>
            <button className="btn primary small" disabled={!!busy} onClick={() => setFollowOpen((o) => !o)}>Follow up</button>
            <button className="btn ghost small" disabled={!!busy || !ready} onClick={() => place(true)}
              title={ready ? 'Send the whole request again, with the documents as they stand now' : 'Finish the steps listed above first'}>
              {busy === 'place' ? 'Sending…' : 'Re-send request'}
            </button>
            <button className="btn ghost small" disabled={!!busy} style={{ color: 'var(--danger)' }} onClick={() => cancel(false)}>
              Cancel request
            </button>
          </>
        )}
        {order.status === 'cancelled' && (
          <button className="btn ghost small" disabled={!!busy} onClick={() => cancel(true)}>Reopen</button>
        )}
      </div>

      {followOpen && (
        <div className="panel" style={{ background: 'var(--surface-soft, #f4f1ea)', marginTop: 10 }}>
          <label className="muted small" style={{ color: MUTED }}>Follow-up message (optional — a default is sent if blank)</label>
          <textarea className="input" rows={3} value={followMsg} onChange={(e) => setFollowMsg(e.target.value)}
            placeholder="Following up on the closing prep…" />
          <div className="small" style={{ color: MUTED, marginTop: 4 }}>
            This goes out on the same email chain, to everyone already on it.
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary small" disabled={busy === 'follow'} onClick={followup}>
              {busy === 'follow' ? 'Sending…' : 'Send follow-up'}
            </button>
            <button className="btn ghost small" onClick={() => { setFollowOpen(false); setFollowMsg(''); }}>Cancel</button>
          </div>
        </div>
      )}

      {msg && (
        <div className={`notice ${msg.tone === 'ok' ? 'ok' : msg.tone === 'warn' ? '' : 'err'}`} style={{ marginTop: 10 }} role="status">
          {msg.text}
          {msg.canForce && <> <button className="btn link small" onClick={() => place(true)}>Force re-send</button></>}
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
