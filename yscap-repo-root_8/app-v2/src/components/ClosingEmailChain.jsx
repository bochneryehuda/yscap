import React, { useState } from 'react';
import EmailCenter from './EmailCenter.jsx';
import DocPreview from './DocPreview.jsx';
import { api, saveBlob } from '../lib/api.js';

/* ════════════════════════════════════════════════════════════════════════════
   THE CLOSING EMAIL CHAIN — the file's own closing address + the whole attorney
   conversation. Extracted from ClosingPrepCard so it can live in BOTH places the
   team looks for it: the Orders desk (where the closing-prep request is SENT) and
   the Closing section (where the closer expects to OPEN the conversation). One
   definition, so the two can never drift.

   Text colours are explicit dark hex on purpose — the legacy `--ink*` tokens are
   LIGHT in this palette and would render invisible on the white card.
   ════════════════════════════════════════════════════════════════════════════ */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = 'var(--gold,#AE8746)';
// `.notice` carries ONLY padding/radius/font-size — border/background live on its
// variants — so a gold callout needs these explicitly.
const CALLOUT = { border: `1px solid ${GOLD}`, background: 'var(--paper,#F6F3EC)' };

const EVENT_LABEL = {
  order: 'Closing prep requested', followup: 'Follow-up',
  executed_term_sheet: 'Executed term sheet sent', closing_date: 'New closing date sent',
  clear_to_close: 'Clear to close sent', manual: 'Message',
};

const KB = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

/* The unique closing address, front and centre — it is the whole feature.
   `emptyHint` is what shows when the file has no chain yet (closing prep not sent);
   each host provides its own, because "send it below" (Orders) and "send it from
   the Orders section" (Closing) are different instructions. */
export function ChainAddress({ chain, emptyHint }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // No chain at all = closing prep has not been sent yet. The address is minted on
  // the first send, so say that rather than implying something is misconfigured.
  if (!chain) {
    return emptyHint || (
      <div className="small" style={{ color: MUTED, marginTop: 10 }}>
        When you send this, the file gets its own closing email address. The attorney is asked to keep
        it on the chain they start, and everything on that chain then lands here by itself.
      </div>
    );
  }
  const address = chain.address;
  if (!address) {
    return (
      <div className="notice" style={{ marginTop: 10, ...CALLOUT }}>
        <b style={{ color: INK }}>No inbound email domain is set up yet.</b>
        <div className="small" style={{ color: MUTED, marginTop: 3 }}>
          The request still sends, but there is no unique closing address to put on it — so the
          attorney's own email chain will not come back into this file. Ask an admin to set the
          inbound email domain.
        </div>
      </div>
    );
  }
  const copy = async () => {
    // writeText returns a promise, so a blocked clipboard (denied permission, or any
    // non-secure context) rejects AFTER a plain try block has already said "Copied".
    // On the one address the whole feature depends on, a false success is the worst
    // possible answer — so the tick only appears once the copy really happened.
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true); setTimeout(() => setCopied(false), 1800);
    } catch (_) { setCopyFailed(true); setTimeout(() => setCopyFailed(false), 4000); }
  };
  return (
    <div className="panel" style={{ marginTop: 10, background: 'var(--paper,#f6f3ec)', borderColor: GOLD }}>
      <div style={{ fontWeight: 600, color: INK }}>This closing's own email address</div>
      <div className="small" style={{ color: MUTED, margin: '3px 0 8px' }}>
        The attorney is asked, in the email, to keep this address on the closing chain they start.
        Every message and every document on that chain then lands on this file automatically —
        nobody has to forward anything.
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <code style={{ background: '#fff', border: '1px solid var(--line,#D9D4C8)', borderRadius: 8, padding: '6px 10px', color: INK, fontSize: 13, wordBreak: 'break-all' }}>
          {address}
        </code>
        <button className="btn ghost small" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      {copyFailed && (
        <div className="small" style={{ color: 'var(--danger,#8C2F2F)', marginTop: 4 }}>
          Your browser blocked the copy — select the address above and copy it by hand.
        </div>
      )}
      {chain && (
        <div className="small" style={{ color: MUTED, marginTop: 8 }}>
          {chain.outboundCount || 0} sent · {chain.inboundCount || 0} received · {chain.docsCount || 0} document{(chain.docsCount || 0) === 1 ? '' : 's'} saved
          {chain.lastActivityAt ? ` · last activity ${when(chain.lastActivityAt)}` : ''}
        </div>
      )}
      {/* SPOOFED SENDER WARNING — deliberately here, in the always-visible part of
          the card, NOT inside the collapsed chain history. This address is handed to
          title, the settlement agent, the realtor and counsel, so it travels; anything
          arriving on it is filed automatically. The one moment this warning is worth
          anything is BEFORE somebody opens the attachment and acts on it. */}
      {chain && Array.isArray(chain.unauthenticated) && chain.unauthenticated.length > 0 && (
        <div className="notice" style={{ marginTop: 8, background: '#FBF3F3', border: '1px solid #8C2F2F', borderRadius: 8, padding: '8px 10px' }}>
          <div style={{ fontWeight: 700, color: '#8C2F2F' }}>
            Check who really sent {chain.unauthenticated.length === 1 ? 'this message' : 'these messages'}
          </div>
          <div className="small" style={{ color: INK, margin: '3px 0 5px' }}>
            {chain.unauthenticated.length === 1 ? 'A message' : `${chain.unauthenticated.length} messages`} on this
            chain did not pass the sending domain's own checks, so the "from" name may not be who it says.
            This happens innocently when mail is forwarded — but confirm by phone, on a number you already
            have, before acting on anything {chain.unauthenticated.length === 1 ? 'it' : 'they'} asked for,
            especially wiring instructions.
          </div>
          {chain.unauthenticated.map((m, i) => (
            <div key={i} className="small" style={{ color: MUTED }}>
              {m.from_email || 'unknown sender'} · {when(m.occurred_at)}{m.subject ? ` · "${m.subject}"` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* THE CLOSING EMAIL CHAIN'S OWN DOCUMENT BOX (owner-directed 2026-08-03: "all of
   the documents from both of the closing email chains … go in the special box for
   the closing email chain documents", each with a preview button).
   BOTH chains land here and that is not a coincidence: the closing-prep request we
   send to the lender's closing attorney carries this file's `closing+<token>@`
   address as its Reply-To, and the attorney is asked in the body to keep that same
   address on the new chain they start with title and the settlement agent. So a
   reply to OUR email and a message on THEIR chain both carry the one address, and
   both are filed here as the file's closing correspondence.
   It is deliberately OUT of the collapsed history: these are the documents the
   closing runs on, and having to open a chain log to discover they exist is how
   they get missed. */
export function ChainDocuments({ chain, onDownload }) {
  const [previewDoc, setPreviewDoc] = useState(null);
  const [dlBusy, setDlBusy] = useState('');
  if (!chain) return null;
  const docs = chain.documents || [];

  const download = async (d) => {
    if (onDownload) return onDownload(d);
    setDlBusy(d.id);
    try { const { blob, filename } = await api.staffDownloadDoc(d.id); saveBlob(blob, filename || d.filename); }
    catch (_) { /* ignore */ }
    finally { setDlBusy(''); }
  };

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, color: INK }}>Closing email chain documents ({docs.length})</div>
      </div>
      <div className="small" style={{ color: MUTED, margin: '3px 0 6px' }}>
        Everything that arrived on this closing's email chain — the attorney's replies to our request and
        the chain they opened with title and the settlement agent. Its own package on the file, separate
        from the final executed closing package; nothing here clears a condition on its own.
      </div>
      {docs.length === 0 ? (
        <div className="small" style={{ color: MUTED }}>
          Nothing yet. Anything emailed to this closing's address lands here by itself.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {docs.map((d) => (
            <div key={d.id} className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="small" style={{ flex: 1, minWidth: 160, color: INK }}>{d.filename}</span>
              <span className="small" style={{ color: MUTED }}>{KB(d.size_bytes)} · {new Date(d.created_at).toLocaleDateString()}</span>
              <button className="btn ghost small" onClick={() => setPreviewDoc(d)} title="Open it here without downloading">Preview</button>
              <button className="btn ghost small" disabled={dlBusy === d.id} onClick={() => download(d)}>
                {dlBusy === d.id ? '…' : 'Download'}
              </button>
            </div>
          ))}
        </div>
      )}
      {previewDoc && (
        <DocPreview
          title="Closing correspondence"
          filename={previewDoc.filename}
          contentType={previewDoc.content_type}
          load={() => api.staffDownloadDoc(previewDoc.id)}
          onDownload={() => download(previewDoc)}
          onClose={() => setPreviewDoc(null)} />
      )}
    </div>
  );
}

/* Everything the system has put on the chain, and everything that came back. The
   DOCUMENTS moved out to <ChainDocuments> above — they are the thing people come
   here for, so they no longer sit behind this toggle. */
export function ChainHistory({ appId, chain }) {
  const [open, setOpen] = useState(false);
  if (!chain) return null;
  const msgs = chain.messages || [];
  return (
    <div style={{ marginTop: 12 }}>
      <button className="btn ghost small" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Open'} the closing email chain
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {msgs.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="small" style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>What we sent on this chain</div>
              {msgs.map((m, i) => (
                <div key={i} className="small" style={{ color: MUTED }}>
                  {EVENT_LABEL[m.event_kind] || m.event_kind} · {when(m.sent_at)}
                  {/* 'carried' is not a send — the closing-prep request already told
                      them this, so it is recorded to stop a duplicate going out
                      later. Saying "sent" here would be untrue. */}
                  {m.status === 'carried' ? ' · included in the request above'
                    : m.status === 'error' ? ' · did not send — will be retried'
                      : m.status !== 'sent' ? ` · ${m.status}` : ''}
                  {Array.isArray(m.attachments) && m.attachments.length ? ` · ${m.attachments.length} attachment${m.attachments.length === 1 ? '' : 's'}` : ''}
                </div>
              ))}
            </div>
          )}
          <div className="small" style={{ color: MUTED, marginBottom: 6 }}>
            Everything on this chain, both directions — a reply typed here goes to the attorney and
            everyone else already on it.
          </div>
          <EmailCenter mode="file" appId={appId} scope="closing" />
        </div>
      )}
    </div>
  );
}
