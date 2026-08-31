import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ltApi } from './api.js';
import { stamp } from './format.js';
// The brand gold and its READABLE twin, from the one place they are defined.
// #AE8746 is 2.98:1 on this paper — under AA for body text (4.5:1) and under
// even the large-text bar (3:1) — so it is a rule, a dot, a border or a fill,
// never a word. GOLD_TEXT (#8A6A22, 4.55:1) still reads unmistakably as gold.
import { GOLD, GOLD_TEXT } from './ppeStyles.js';

/**
 * THE VERIFICATION OF RENT, on one loan.
 *
 * Owner-directed: *"prefill part one and part two … leave the landlord's sections
 * blank and required on DocuSign … be able to preview and edit the PDF before
 * sending … send by DocuSign, by email attachment, or both … and if it comes back
 * filled in by hand, void the envelope."*
 *
 * ── FIVE THINGS HERE ARE DELIBERATE ─────────────────────────────────────────
 *
 * 1. WHAT IS EDITED IS THE DATA; THE PDF IS THE PREVIEW OF IT. The frame re-renders
 *    from the server after every save, so "what you saw is what went out" is a
 *    property of the arrangement rather than a promise. There is no upload — a
 *    hand-edited PDF cannot be re-anchored, so its required questions would quietly
 *    stop being asked.
 *
 * 2. THE LANDLORD'S HALF IS SHOWN AND IS NOT EDITABLE HERE. It is on screen so a
 *    processor can see exactly what is being asked; answering it for the landlord is
 *    the one thing a verification of rent may never do, and the server refuses a
 *    landlord key at the door regardless.
 *
 * 3. EACH SEND METHOD CARRIES ITS OWN REASON IT CANNOT GO. The server answers with
 *    the blockers per method, so "DocuSign is not connected" greys DocuSign and
 *    leaves the email button alone — rather than one dead button and a paragraph.
 *
 * 4. RECORDING A MANUAL RETURN SAYS OUT LOUD THAT IT VOIDS WHAT IS OUT, before the
 *    click, and asks for the reason — that note is the only record afterwards of why
 *    a signature request in flight was stopped.
 *
 * 5. EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. `--ink*` is a LIGHT paper colour in
 *    this palette; the names are legacy and they lie.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GREEN = '#2F6B4F';
const AMBER = '#8A6A17';
const RED = '#8A2D2D';

const card = { background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 10, padding: 14, marginBottom: 12 };
const btn = {
  border: `1px solid ${LINE}`, background: '#FFFFFF', color: INK, borderRadius: 8,
  padding: '6px 12px', fontSize: 13, fontWeight: 550, cursor: 'pointer', minHeight: 32,
};
const btnPrimary = { ...btn, background: '#2F7F86', borderColor: '#2F7F86', color: '#FFFFFF' };
const input = {
  width: '100%', border: `1px solid ${LINE}`, borderRadius: 8, padding: '8px 10px',
  // 16px: iOS Safari zooms the whole page on focus of anything smaller, which on a
  // phone throws the form off screen.
  fontSize: 16, color: INK, background: '#FFFFFF', boxSizing: 'border-box',
};

const ENV_STATUS = {
  created: { label: 'Being prepared', colour: MUTED },
  sent: { label: 'Out for signature', colour: AMBER },
  delivered: { label: 'Opened by the landlord', colour: AMBER },
  completed: { label: 'Signed', colour: GREEN },
  declined: { label: 'Declined', colour: RED },
  voided: { label: 'Voided', colour: MUTED },
  failed: { label: 'Did not send', colour: RED },
};

const METHOD_LABEL = {
  docusign: 'Send on DocuSign',
  email: 'Send as an email attachment',
  both: 'Send both ways',
};

function Field({ field, value, onChange, readOnly, over }) {
  /* A BLOCK IS MULTI-LINE, AND THE FORM ITSELF SAYS WHICH ONES ARE.
     Owner-reported 2026-08-31: *"the way you display what we fill in, everything
     is on one line — it doesn't even have a space. After 'YS Capital Group' we
     have our address right away without a space."*

     ROOT CAUSE, and it was worse than a display problem: `type: 'multiline'`
     was declared on NO field, so every name-and-address block rendered in a
     one-line <input>. A browser strips the newlines out of one of those, so the
     block READ as one run — and the moment anybody touched the box it was SAVED
     that way, so the printed form went to the landlord mangled too.

     It is DERIVED from `lines`, which the field map already carries because it is
     the height of the real box on the owner's blank — so a block added later gets
     its proper editor without anybody remembering a second flag. */
  const rows = Math.max(1, Number(field.lines) || 1);
  const isLong = rows > 1 || field.type === 'multiline';
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: MUTED, marginBottom: 4 }}>
        {field.label}{field.optional ? ' (optional)' : ''}
      </span>
      {readOnly ? (
        <div style={{
          ...input, background: '#F8F7F4', color: MUTED, minHeight: 34,
          display: 'flex', alignItems: 'center', fontSize: 13,
        }}>
          The landlord answers this
        </div>
      ) : isLong ? (
        <>
          <textarea
            rows={rows}
            style={{ ...input, minHeight: 22 * rows, resize: 'vertical', lineHeight: 1.45, fontFamily: 'inherit' }}
            value={value || ''}
            onChange={(e) => onChange(field.key, e.target.value)}
          />
          {/* The box on the paper is this many lines, so a person typing a fifth
              one should know before the landlord gets a form missing it. */}
          <span style={{ display: 'block', fontSize: 11, color: over ? AMBER : MUTED, marginTop: 2 }}>
            {over
              ? `This is ${over.total} lines and the box on the form holds ${over.printed} — the last ${over.total - over.printed} will not print.`
              : `Up to ${rows} lines — one per line, as it should read on the form.`}
          </span>
        </>
      ) : (
        <input
          style={input}
          type={field.type === 'date' ? 'date' : 'text'}
          value={value || ''}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      )}
    </label>
  );
}

export default function LtVor({ loanId }) {
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState({});
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [returnNote, setReturnNote] = useState('');
  const urlRef = useRef(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.vor(loanId)
      .then((s) => { setState(s); setDraft(s.data || {}); })
      .catch((e) => setErr(e.message || 'The form could not be read.'));
  }, [loanId]);

  useEffect(() => { load(); }, [load]);

  /* A blob URL is a copy of the document held in the tab. Revoking the OLD one on
     every refresh, and the last one on unmount, is what stops a processor who
     previews ten times from carrying ten copies of the form around. */
  const refreshPreview = useCallback(async () => {
    try {
      const url = await ltApi.vorPreviewUrl(loanId);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setPreviewUrl(url);
    } catch (e) {
      setErr(e.message || 'The form could not be drawn.');
    }
  }, [loanId]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  useEffect(() => { if (showPreview) refreshPreview(); }, [showPreview, refreshPreview]);

  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const run = async (fn, words) => {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await fn();
      setOk(words);
      setConfirming(null);
      load();
      if (showPreview) refreshPreview();
      return r;
    } catch (e) {
      setErr(e.message || 'That did not work.');
      return null;
    } finally { setBusy(false); }
  };

  const ourFields = useMemo(
    () => (state ? state.fields.filter((f) => f.who === 'us') : []), [state]);
  const llFields = useMemo(
    () => (state ? state.fields.filter((f) => f.who === 'landlord') : []), [state]);

  if (err && !state) return <div style={{ ...card, color: RED }}>{err}</div>;
  if (!state) return <div style={{ ...card, color: MUTED }}>Reading the form…</div>;

  const dirty = ourFields.some((f) => (draft[f.key] || '') !== (state.data[f.key] || ''));
  const live = (state.envelopes || []).filter((e) => ['created', 'sent', 'delivered'].includes(e.status));

  return (
    <div>
      <div style={{ ...card }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>Verification of rent</div>
        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
          Filled in from the file. Check it, then send it — the landlord answers Part III.
        </div>

        {state.borrowerRents === false ? (
          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#FDF8EC', color: AMBER, fontSize: 13 }}>
            This file says the borrower OWNS where they live, so a rent verification may not be needed here.
            It is left available rather than hidden — the file can be wrong.
          </div>
        ) : null}

        {(state.unreadable || []).length ? (
          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#FDF1F1', color: RED, fontSize: 13 }}>
            Part of this file could not be read just now ({state.unreadable.join(', ')}), so the form may be
            short a detail. Try again in a moment before sending.
          </div>
        ) : null}

        {err ? <div style={{ marginTop: 10, color: RED, fontSize: 13 }}>{err}</div> : null}
        {ok ? <div style={{ marginTop: 10, color: GREEN, fontSize: 13 }}>{ok}</div> : null}
      </div>

      {/* ── our half ─────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: GOLD_TEXT, letterSpacing: 0.4, marginBottom: 8 }}>
          WHAT WE FILL IN
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))', gap: '0 16px' }}>
          {ourFields.map((f) => (
            <Field key={f.key} field={f} value={draft[f.key]} onChange={set}
              over={(state.overflow || []).find((o) => o.key === f.key) || null} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
          <button
            type="button"
            style={dirty ? btnPrimary : { ...btn, opacity: 0.6 }}
            disabled={busy || !dirty}
            onClick={() => run(() => ltApi.vorSave(loanId, draft), 'Saved.')}
          >
            Save
          </button>
          <button type="button" style={btn} disabled={busy} onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? 'Hide the form' : 'Preview the form'}
          </button>
          <button type="button" style={btn} disabled={busy} onClick={() => ltApi.vorDownload(loanId).catch((e) => setErr(e.message))}>
            Download a copy
          </button>
          {state.missing.length ? (
            <span style={{ fontSize: 12, color: AMBER }}>
              {state.missing.length} of our own answers {state.missing.length === 1 ? 'is' : 'are'} still blank.
            </span>
          ) : null}
        </div>

        {/* ── CONFIRM IT ───────────────────────────────────────────────────
            The owner's gate: *"the verification of rent form fill-out … needs to
            be confirmed before you can order the VOR."* It sits with the form
            rather than with the send, because it is a statement about the FORM —
            and it is offered only once our own answers are all in, so nobody is
            asked to agree to blanks. Every colour is an explicit dark: an
            `--ink*` token is a LIGHT paper colour here and renders white on
            white. */}
        <div style={{
          marginTop: 12, padding: '10px 12px', borderRadius: 8,
          border: `1px solid ${state.confirmedAt ? '#2F7F86' : GOLD}`,
          background: state.confirmedAt ? '#F1F7F7' : '#FBF7EF',
          display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
        }}>
          <div style={{ flex: '1 1 260px', minWidth: 0, fontSize: 13, color: INK }}>
            {state.confirmedAt ? (
              <>This form is <strong>confirmed</strong> and can go out. Changing anything above asks for a fresh confirmation.</>
            ) : (
              <>Read the form through and confirm it. <strong>Nothing goes to the landlord until you do</strong> — the order and the form both wait on it.</>
            )}
          </div>
          {state.confirmedAt ? null : (
            <button
              type="button"
              style={state.missing.length ? { ...btn, opacity: 0.6 } : btnPrimary}
              disabled={busy || state.missing.length > 0}
              title={state.missing.length ? 'Fill our own answers in first.' : undefined}
              onClick={() => run(() => ltApi.vorConfirm(loanId), 'Confirmed.')}
            >
              Confirm this form
            </button>
          )}
        </div>

        {showPreview ? (
          previewUrl ? (
            <iframe
              title="Verification of rent"
              src={previewUrl}
              style={{ width: '100%', height: 620, marginTop: 12, border: `1px solid ${LINE}`, borderRadius: 8, background: '#FFFFFF' }}
            />
          ) : (
            <div style={{ marginTop: 12, color: MUTED, fontSize: 13 }}>Drawing the form…</div>
          )
        ) : null}
      </div>

      {/* ── the landlord's half, shown and not editable ───────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: GOLD_TEXT, letterSpacing: 0.4, marginBottom: 4 }}>
          WHAT THE LANDLORD IS ASKED
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          Every one of these is required on DocuSign — they cannot finish while one is empty.
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: INK, fontSize: 13, lineHeight: 1.7 }}>
          {llFields.map((f) => (
            <li key={f.key}>{f.label}{f.optional ? ' (optional)' : ''}</li>
          ))}
        </ul>
      </div>

      {/* ── sending ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: GOLD_TEXT, letterSpacing: 0.4, marginBottom: 8 }}>SEND IT</div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          {state.landlord && state.landlord.email
            ? <>To {state.landlord.name || 'the landlord'} at {state.landlord.email}.</>
            : 'There is no landlord email on this file yet.'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(state.methods || []).map((m) => {
            const blocked = m.blockers.length > 0;
            const reason = blocked ? (state.blockerText[m.blockers[0]] || 'This cannot be sent yet.') : null;
            return (
              <div key={m.method} style={{ minWidth: 180 }}>
                <button
                  type="button"
                  style={blocked ? { ...btn, opacity: 0.6 } : btnPrimary}
                  disabled={busy}
                  aria-disabled={blocked ? 'true' : 'false'}
                  onClick={() => (blocked ? setErr(reason) : setConfirming(m.method))}
                >
                  {METHOD_LABEL[m.method]}
                </button>
                {reason ? <div style={{ fontSize: 11, color: AMBER, marginTop: 4, maxWidth: 220 }}>{reason}</div> : null}
              </div>
            );
          })}
        </div>

        {confirming && confirming !== 'return' ? (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#FDF8EC', border: `1px solid ${GOLD}` }}>
            <div style={{ fontSize: 13, color: INK }}>
              {METHOD_LABEL[confirming]} to {state.landlord && state.landlord.email}? This goes to somebody outside the company.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button" style={btnPrimary} disabled={busy}
                onClick={() => run(() => ltApi.vorSend(loanId, { method: confirming }), 'Sent.')}
              >
                Yes, send it
              </button>
              <button type="button" style={btn} disabled={busy} onClick={() => setConfirming(null)}>Not yet</button>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── what is out, and what came back ───────────────────────────────── */}
      {(state.envelopes || []).length ? (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, color: GOLD_TEXT, letterSpacing: 0.4, marginBottom: 8 }}>ON DOCUSIGN</div>
          {state.envelopes.map((e) => {
            const s = ENV_STATUS[e.status] || { label: e.status, colour: MUTED };
            return (
              <div key={e.id} style={{ borderTop: `1px solid ${LINE}`, paddingTop: 8, marginTop: 8, fontSize: 13, color: INK }}>
                <span style={{ color: s.colour, fontWeight: 600 }}>{s.label}</span>
                {' · '}{e.recipient_email || 'no address recorded'}
                {e.sent_at ? <> · sent {stamp(e.sent_at)}</> : null}
                {e.completed_at ? <> · signed {stamp(e.completed_at)}</> : null}
                {e.void_reason ? <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>{e.void_reason}</div> : null}
                {e.last_error ? <div style={{ color: RED, fontSize: 12, marginTop: 2 }}>{e.last_error}</div> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {(state.returns || []).length ? (
        <div style={card}>
          <div style={{ fontSize: 13, fontWeight: 700, color: GOLD_TEXT, letterSpacing: 0.4, marginBottom: 8 }}>WHAT CAME BACK</div>
          {state.returns.map((r) => (
            <div key={r.id} style={{ borderTop: `1px solid ${LINE}`, paddingTop: 8, marginTop: 8, fontSize: 13, color: INK }}>
              <span style={{ fontWeight: 600 }}>
                {r.source === 'docusign' ? 'Signed on DocuSign' : 'Came back another way'}
              </span>
              {' · '}{stamp(r.created_at)}
              {r.note ? <div style={{ color: MUTED, fontSize: 12, marginTop: 2 }}>{r.note}</div> : null}
              {r.answers && Object.keys(r.answers).length ? (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: MUTED, fontSize: 12 }}>
                  {llFields.filter((f) => r.answers[f.key]).map((f) => (
                    <li key={f.key}>{f.label}: <span style={{ color: INK }}>{r.answers[f.key]}</span></li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* ── a form that came back another way ─────────────────────────────── */}
      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: GOLD_TEXT, letterSpacing: 0.4, marginBottom: 4 }}>
          IT CAME BACK ANOTHER WAY
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          {live.length
            ? `Recording this VOIDS the ${live.length === 1 ? 'form' : `${live.length} forms`} still out on DocuSign, so there is never a second, half-signed copy in flight.`
            : 'Nothing is out on DocuSign, so this only records what arrived.'}
        </div>
        <input
          style={input}
          placeholder="How did it come back? (emailed by the landlord, handed over at closing…)"
          value={returnNote}
          onChange={(e) => setReturnNote(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {confirming === 'return' ? (
            <>
              <button
                type="button" style={btnPrimary} disabled={busy}
                onClick={() => run(
                  () => ltApi.vorManualReturn(loanId, { note: returnNote }),
                  live.length ? 'Recorded, and the form out on DocuSign was voided.' : 'Recorded.',
                ).then((r) => { if (r) setReturnNote(''); })}
              >
                {live.length ? 'Yes — record it and void what is out' : 'Yes, record it'}
              </button>
              <button type="button" style={btn} disabled={busy} onClick={() => setConfirming(null)}>Not yet</button>
            </>
          ) : (
            <button
              type="button"
              style={returnNote.trim().length >= 4 ? btn : { ...btn, opacity: 0.6 }}
              disabled={busy}
              onClick={() => (returnNote.trim().length >= 4
                ? setConfirming('return')
                : setErr('Say in a few words how the form came back — it is the only record afterwards.'))}
            >
              Record a completed form
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
