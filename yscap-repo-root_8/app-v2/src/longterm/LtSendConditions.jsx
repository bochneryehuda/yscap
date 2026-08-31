import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';

/* SEND THE BORROWER THEIR OUTSTANDING CONDITIONS — the login-free link.
 *
 * The owner asked for this on 2026-08-28: *"another way for borrowers to manage
 * their conditions if they're not so technical. A more simple condition center
 * for them, with an email directly with links to upload and enter the
 * information over there … without him being able to set up an account or
 * portal."*
 *
 * EVERYTHING THIS CARD KNOWS COMES FROM THE SERVER. Who it can go to, what
 * would be sent, every link already out, and every reason it cannot be sent are
 * all read from `/outreach` — this file re-derives none of it. That is not
 * tidiness: the send RE-CHECKS every one of those reasons, so a screen that
 * made its own judgement would eventually disagree with the door and either
 * offer a button that refuses or hide one that would have worked.
 *
 * A REFUSAL IS SHOWN BEFORE THE BUTTON, NOT AFTER IT. A loan with no confirmed
 * borrower, an archived loan or a loan with nothing outstanding says so in the
 * server's own words, and the Send button is not offered at all — being told
 * why after pressing is how a person concludes the feature is broken.
 *
 * Colours are explicit darks. `--ink*` is a LIGHT paper colour in this palette
 * (the names are legacy and they lie), so a token there renders white on white.
 */

const DARK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const LINE = '#E4DFD3';

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

export default function LtSendConditions({ loanId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [openPanel, setOpenPanel] = useState(false);
  const [chosen, setChosen] = useState(() => new Set());
  const [extra, setExtra] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);   // { tone, text }

  const load = useCallback(() => {
    setErr(null);
    ltApi.conditionsOutreach(loanId)
      .then((d) => {
        setData(d);
        // Pre-tick the borrower — the one recipient there is by default.
        setChosen(new Set((d && d.recipients ? d.recipients : []).map((r) => r.email)));
      })
      .catch((e) => setErr(e.message || 'Could not read who this can go to.'));
  }, [loanId]);
  useEffect(load, [load]);

  if (err) {
    return (
      <div style={card}>
        <b style={{ color: DARK }}>Send the borrower their list</b>
        <p style={{ color: MUTED, margin: '6px 0 0' }}>{err}</p>
      </div>
    );
  }
  if (!data) return null;

  const blockers = data.blockers || [];
  const items = data.items || [];
  const recipients = data.recipients || [];
  const prior = data.prior || [];
  const canSend = blockers.length === 0 && items.length > 0;

  const toggle = (email) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(email)) next.delete(email); else next.add(email);
    return next;
  });

  const send = async () => {
    const emails = Array.from(chosen);
    const typed = String(extra || '').trim().toLowerCase();
    if (typed) emails.push(typed);
    if (!emails.length) { setSaid({ tone: 'err', text: 'Pick at least one person to send it to.' }); return; }
    setBusy(true); setSaid(null);
    try {
      const r = await ltApi.conditionsOutreachSend(loanId, emails, note);
      const failed = (r && r.failed) || [];
      setSaid({
        tone: failed.length ? 'err' : 'ok',
        text: failed.length
          ? `Sent to ${(r.sent || []).length}. Could not send to ${failed.map((f) => f.email).join(', ')} — ${failed[0].reason}`
          : `Sent to ${(r.sent || []).join(', ')} — ${r.items} item${r.items === 1 ? '' : 's'}.`,
      });
      setExtra(''); setNote(''); load();
    } catch (e) {
      setSaid({ tone: 'err', text: e.message || 'That could not be sent.' });
    } finally { setBusy(false); }
  };

  const revoke = async (linkId) => {
    setBusy(true); setSaid(null);
    try {
      await ltApi.conditionsOutreachRevoke(loanId, linkId);
      setSaid({ tone: 'ok', text: 'That link is dead — it will not open for anybody now.' });
      load();
    } catch (e) {
      setSaid({ tone: 'err', text: e.message || 'That link could not be revoked.' });
    } finally { setBusy(false); }
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <b style={{ color: DARK, fontSize: 15 }}>Send the borrower their list</b>
        <span style={{ color: MUTED, fontSize: 13, flex: 1 }}>
          An email with every outstanding item and its own upload button. No account, no password.
        </span>
        {canSend && (
          <button type="button" onClick={() => setOpenPanel((v) => !v)} style={btn(false)}>
            {openPanel ? 'Close' : 'Send…'}
          </button>
        )}
      </div>

      {/* WHY IT CANNOT BE SENT, before the button rather than after it. */}
      {blockers.length > 0 && (
        <ul style={{ color: '#8a6d3b', margin: '8px 0 0', paddingLeft: 18, fontSize: 14 }}>
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      {blockers.length === 0 && items.length === 0 && (
        <p style={{ color: MUTED, margin: '8px 0 0', fontSize: 14 }}>
          Nothing is outstanding for the borrower on this loan, so there is nothing to send.
        </p>
      )}
      {data.itemsReadable === false && data.itemsReason && (
        <p style={{ color: '#b3261e', margin: '8px 0 0', fontSize: 14 }}>{data.itemsReason}</p>
      )}

      {said && (
        <div role="status" style={{
          margin: '10px 0 0', padding: '8px 10px', borderRadius: 8, fontSize: 14, color: DARK,
          border: `1px solid ${said.tone === 'err' ? '#b3261e' : GOLD}`,
          background: said.tone === 'err' ? '#fdf3f2' : '#fbf7ee',
        }}>{said.text}</div>
      )}

      {openPanel && canSend && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
          <div style={{ color: MUTED, fontSize: 13, marginBottom: 6 }}>
            {items.length} item{items.length === 1 ? '' : 's'} will be listed. Each person gets their own link,
            good for {data.linkDays} days, and it can be revoked at any time.
          </div>
          {recipients.map((r) => (
            <label key={r.email} style={{ display: 'flex', gap: 8, alignItems: 'center', color: DARK, fontSize: 14, marginTop: 4 }}>
              <input type="checkbox" checked={chosen.has(r.email)} onChange={() => toggle(r.email)} />
              <span>{r.name} — {r.email}</span>
              {r.source === 'encompass' && (
                <span style={{ color: MUTED, fontSize: 12 }}>(from Encompass — not on their profile yet)</span>
              )}
            </label>
          ))}
          <input value={extra} onChange={(e) => setExtra(e.target.value)} className="input"
            placeholder="Another address (optional) — opens the borrower's own view"
            style={{ marginTop: 8, width: '100%', maxWidth: 420, padding: '9px 11px', borderRadius: 8, border: `1px solid ${LINE}`, color: DARK, fontSize: 15 }} />
          <textarea value={note} onChange={(e) => setNote(e.target.value)} className="input" rows={2}
            placeholder="A line to open the email with (optional)"
            style={{ marginTop: 8, width: '100%', padding: '9px 11px', borderRadius: 8, border: `1px solid ${LINE}`, color: DARK, fontSize: 15 }} />
          <button type="button" onClick={send} disabled={busy} style={{ ...btn(true), marginTop: 10 }}>
            {busy ? 'Sending…' : 'Send it'}
          </button>
        </div>
      )}

      {prior.length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
          <div style={{ color: MUTED, fontSize: 13, marginBottom: 4 }}>Links already sent</div>
          {prior.map((l) => {
            const dead = !!l.revoked_at || (l.expires_at && new Date(l.expires_at) < new Date());
            return (
              <div key={l.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', color: DARK, fontSize: 13, marginTop: 3 }}>
                <span>{l.sent_to_email}</span>
                <span style={{ color: MUTED }}>sent {when(l.created_at)}</span>
                <span style={{ color: MUTED }}>
                  {l.revoked_at ? 'revoked'
                    : dead ? 'expired'
                      : l.last_used_at ? `opened ${l.use_count}×` : 'not opened yet'}
                </span>
                {!dead && (
                  <button type="button" onClick={() => revoke(l.id)} disabled={busy} style={btn(false, true)}>Revoke</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const card = {
  border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff',
  padding: '12px 14px', marginBottom: 12,
};

function btn(primary, small) {
  return {
    padding: small ? '4px 10px' : '8px 14px',
    borderRadius: 8, cursor: 'pointer', fontWeight: 600,
    fontSize: small ? 13 : 14,
    border: `1px solid ${primary ? DARK : LINE}`,
    background: primary ? DARK : '#fff',
    color: primary ? '#fff' : DARK,
  };
}
