import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { GOLD_TEXT } from './ppeStyles.js';

/**
 * THE THREE CONDITIONS THAT ARE A CHOICE, NOT AN UPLOAD.
 *
 * The owner, correcting the shipped list: *"This is not only a form. It's either
 * a form or a mortgage statement upload … or you can just select a certain one
 * that is primary. It's one out of three."* And on the subject property's
 * mortgage: *"you can just select that it's FCI, whatever, and then you don't
 * need anything, not an attachment and not a form."*
 *
 * ── THE WAYS ARE THE SERVER'S, NOT THIS FILE'S ──────────────────────────────
 *
 * Every way, every field and every rule about which fields are asked comes down
 * from `/workspace`, which reads `answers.js` — the SAME module the sign-off gate
 * reads. This screen draws what it is handed and decides nothing, so a way added
 * on the server appears here with no second list to keep in step, and a form this
 * screen accepts is always one the gate will honour.
 *
 * WHICH IS ALSO WHY THE REFUSAL IS THE SERVER'S. This component does not
 * pre-validate: it posts, and shows what comes back. A screen that guessed the
 * rule would eventually guess differently from the gate, and the person would be
 * told their answer was fine by one and refused by the other.
 *
 * ── DARK TEXT ON WHITE, ALWAYS ──────────────────────────────────────────────
 *
 * Explicit hexes, never an `--ink*` token — those are LIGHT paper colours in this
 * palette and render white-on-white. The brand gold carries no words: #AE8746 is
 * 2.98:1 here, so eyebrows use GOLD_TEXT (4.55:1).
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GREEN = '#2F6B4F';
const RED = '#8A2D2D';

const eyebrow = {
  fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
  color: GOLD_TEXT, fontWeight: 700, marginBottom: 6,
};
const input = {
  width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 14,
  color: INK, background: '#FFFFFF', border: `1px solid ${LINE}`, borderRadius: 6,
};
const btn = (on) => ({
  font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  padding: '6px 10px', borderRadius: 6,
  border: `1px solid ${on ? GOLD_TEXT : LINE}`,
  background: on ? '#FDF8EC' : '#FFFFFF',
  color: INK,
});

/**
 * THE VESTING COMPANY — WHAT THE BORROWER ALREADY HOLDS, AND HOW TO ADD TO IT.
 *
 * ── THIS SCREEN USED TO PROMISE SOMETHING THE CODE DID NOT DO ───────────────
 *
 * It told people, on every file whose company was not on the profile: *"What is
 * uploaded here will be saved to it, and verified once — so the next loan for
 * the same company starts already done."* Nothing did that. The read side was
 * shared and correct and there was no write side at all, so a document collected
 * here stayed on this loan's condition and the next loan asked for it again.
 *
 * The sentence is true now, and it is true because of WHERE the upload goes, not
 * because anything copies it afterwards: each row below files straight onto that
 * slot on the COMPANY, through the shared upload door. One document, on the
 * profile, which is the thing `entity-prefill.js` reads on the next loan.
 *
 * ── SAVING THE COMPANY IS A BUTTON, NEVER AUTOMATIC ─────────────────────────
 *
 * Putting a company on a person's permanent record is a decision, so somebody
 * makes it. It is also what the slots hang off, which is why nothing can be
 * uploaded until it has been done — said plainly rather than by a disabled
 * control with no explanation.
 *
 * EVERY REFUSAL IS THE SERVER'S OWN WORDS, like the rest of this file.
 */
function EntityBlock({ ws, loanId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const profile = ws.profile || null;

  const save = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      await ltApi.vestingEntityToProfile(loanId);
      if (onChanged) await onChanged();
    } catch (e) {
      setErr((e && (e.error || e.message)) || 'That could not be saved.');
    } finally { setBusy(false); }
  }, [loanId, onChanged]);

  const upload = useCallback(async (slotItemId, file) => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      // The RAW File — the streamed door takes the bytes as they arrive, so an
      // operating agreement past the JSON ceiling still lands.
      await ltApi.vestingEntityDocUpload(loanId, slotItemId, { file, filename: file.name });
      if (onChanged) await onChanged();
    } catch (e) {
      setErr((e && (e.error || e.message)) || 'That document could not be filed.');
    } finally { setBusy(false); }
  }, [loanId, onChanged]);

  return (
    <div>
      <div style={eyebrow}>On the borrower’s profile</div>

      {/* AN UNREADABLE PROFILE IS NOT "NOTHING ON FILE". Saying the second when
          the first is true would ask a borrower for documents they already sent. */}
      {profile && profile.unreadable && (
        <p style={{ margin: 0, fontSize: 13, color: RED, lineHeight: 1.55 }}>{profile.why}</p>
      )}

      {profile && !profile.unreadable && !profile.found && (
        <div>
          <p style={{ margin: 0, fontSize: 13, color: MUTED, lineHeight: 1.55 }}>
            {ws.entityName
              ? `${ws.entityName} is not on this borrower’s profile yet. Save it there and its documents live on the profile — so the next loan for the same company starts already done.`
              : 'This loan has no vesting company recorded yet. It comes from Encompass once somebody enters it.'}
          </p>
          {ws.entityName && (
            <button
              type="button" disabled={busy}
              style={{ ...btn(true), marginTop: 10, opacity: busy ? 0.5 : 1 }}
              onClick={save}>
              {busy ? 'Saving…' : 'Save this company to the borrower’s profile'}
            </button>
          )}
        </div>
      )}

      {profile && profile.found && (
        <div>
          <p style={{ margin: 0, fontSize: 13, color: INK, lineHeight: 1.55 }}>
            <strong>{ws.entityName}</strong> is already on this borrower’s profile
            {profile.verified ? ' and verified.' : ', not yet verified.'}
          </p>
          <ul style={{ margin: '8px 0 0', padding: 0, listStyle: 'none', fontSize: 13 }}>
            {profile.slots.map((sl) => (
              <li key={sl.key} style={{
                marginTop: 6, display: 'flex', flexWrap: 'wrap',
                alignItems: 'center', gap: 8,
              }}>
                <span style={{ color: sl.filled ? GREEN : MUTED }}>
                  {sl.label} — {sl.filled ? 'already on file' : 'not on file'}
                  {sl.note ? ` (${sl.note})` : ''}
                </span>
                {/* A SLOT WITH NO ITEM ID CANNOT BE UPLOADED INTO, and that is
                    an honest state rather than a broken control: the company is
                    on the profile but its slots have not been built yet. */}
                {!sl.filled && sl.itemId && (
                  <label style={{ ...btn(false), display: 'inline-block', opacity: busy ? 0.5 : 1 }}>
                    {busy ? 'Working…' : 'Upload'}
                    <input
                      type="file" disabled={busy}
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files && e.target.files[0];
                        e.target.value = '';
                        upload(sl.itemId, f);
                      }} />
                  </label>
                )}
              </li>
            ))}
          </ul>
          {ws.note && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{ws.note}</p>
          )}
        </div>
      )}

      {err && <p style={{ margin: '8px 0 0', fontSize: 13, color: RED, lineHeight: 1.55 }}>{err}</p>}
    </div>
  );
}

/** One field, drawn from the server's own description of it. */
function Field({ field, value, onChange }) {
  const id = `f-${field.key}`;
  return (
    <label htmlFor={id} style={{ display: 'block', marginTop: 8 }}>
      <span style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 3 }}>{field.label}</span>
      {field.type === 'choice' ? (
        <select id={id} style={input} value={value || ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(field.options || []).map((o) => (
            <option key={o} value={o}>{o === 'second_home' ? 'Second home' : 'Investment'}</option>
          ))}
        </select>
      ) : (
        <input
          id={id} style={input} value={value == null ? '' : value}
          inputMode={field.type === 'money' ? 'decimal' : undefined}
          placeholder={field.type === 'money' ? '0.00' : ''}
          onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

/** The ways, as buttons, with the chosen one's fields underneath. */
function Ways({ ways, chosen, values, onChoose, onValue }) {
  const way = ways.find((w) => w.key === chosen) || null;
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {ways.map((w) => (
          <button key={w.key} type="button" style={btn(w.key === chosen)} onClick={() => onChoose(w.key)}>
            {w.label}
          </button>
        ))}
      </div>
      {/* A way that explains itself says so where it is chosen, not in a footnote. */}
      {way && way.why && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{way.why}</p>
      )}
      {way && (way.fields || []).map((f) => (
        <Field key={f.key} field={f} value={(values || {})[f.key]} onChange={(v) => onValue(f.key, v)} />
      ))}
      {way && way.needsDocument && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
          Upload it against this condition — this counts once the document has been accepted.
        </p>
      )}
    </div>
  );
}

export default function LtConditionAnswer({ loanId, conditionId, onSaved }) {
  const [ws, setWs] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ way: null, values: {}, lines: {}, mortgages: [] });

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await ltApi.conditionWorkspace(loanId, conditionId);
      const w = r && r.workspace;
      setWs(w || null);
      if (w && w.shape === 'choice') {
        setDraft((d) => ({ ...d, way: (w.answer && w.answer.way) || null, values: (w.answer && w.answer.values) || {} }));
      }
      if (w && w.shape === 'per_line') {
        setDraft((d) => ({
          ...d,
          lines: (w.answer && w.answer.lines) || {},
          mortgages: (w.answer && w.answer.mortgages) || [],
        }));
      }
    } catch (e) {
      // An unreadable workspace SAYS SO. Rendering nothing would read as a
      // condition with no way to answer it, which is the opposite of the truth.
      setErr('PILOT could not open this condition just now.');
    }
  }, [loanId, conditionId]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (answer) => {
    setBusy(true); setErr(null); setNote(null);
    try {
      await ltApi.conditionAnswer(loanId, conditionId, answer);
      setNote('Saved.');
      await load();
      if (onSaved) onSaved();
    } catch (e) {
      // THE SERVER'S OWN WORDS. This screen never invents a refusal, so what a
      // person reads here is exactly what the sign-off gate will say.
      setErr((e && (e.error || e.message)) || 'That could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [loanId, conditionId, load, onSaved]);

  if (!ws && !err) return null;
  if (err && !ws) return <p style={{ margin: '10px 0 0', fontSize: 13, color: RED }}>{err}</p>;

  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
      {/* ── The vesting entity: what the borrower already holds ─────────────── */}
      {ws.shape === 'entity' && (
        <EntityBlock ws={ws} loanId={loanId} onChanged={load} />
      )}

      {/* ── One choice ─────────────────────────────────────────────────────── */}
      {ws.shape === 'choice' && (
        <div>
          <div style={eyebrow}>How you want to answer this</div>
          <Ways
            ways={ws.ways} chosen={draft.way} values={draft.values}
            onChoose={(k) => setDraft((d) => ({ ...d, way: k }))}
            onValue={(k, v) => setDraft((d) => ({ ...d, values: { ...d.values, [k]: v } }))} />
          <button
            type="button" disabled={busy || !draft.way}
            style={{ ...btn(true), marginTop: 10, opacity: busy || !draft.way ? 0.5 : 1 }}
            onClick={() => save({ way: draft.way, values: draft.values })}>
            {busy ? 'Saving…' : 'Save this answer'}
          </button>
        </div>
      )}

      {/* ── One line at a time ─────────────────────────────────────────────── */}
      {ws.shape === 'per_line' && (
        <div>
          <div style={eyebrow}>Every mortgage on the credit report</div>
          {ws.unreadable && (
            <p style={{ margin: '0 0 8px', fontSize: 13, color: RED, lineHeight: 1.55 }}>{ws.why}</p>
          )}
          {!ws.unreadable && ws.lines.length === 0 && (
            <p style={{ margin: 0, fontSize: 13, color: MUTED, lineHeight: 1.55 }}>
              No liabilities have come across from the credit report yet.
            </p>
          )}
          {ws.lines.map((l) => {
            const marked = draft.mortgages.some((m) => String(m.key || m) === l.key);
            const entry = draft.lines[l.key] || {};
            return (
              <div key={l.key} style={{ borderTop: `1px solid ${LINE}`, paddingTop: 10, marginTop: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: INK }}>{l.label}</div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                  {l.type || 'Type not stated'}
                  {l.balance != null && ` · balance ${l.balance.toLocaleString()}`}
                  {l.payment != null && ` · ${l.payment.toLocaleString()}/mo`}
                  {/* PILOT PROPOSES, A PERSON DECIDES — and "PILOT is not sure"
                      is shown as itself rather than folded into a quiet no. */}
                  {l.proposedMortgage === true && ' · PILOT reads this as a mortgage'}
                  {l.proposedMortgage === false && ' · PILOT does not read this as a mortgage'}
                  {l.proposedMortgage === null && ' · PILOT cannot tell — please look'}
                </div>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, fontSize: 13, color: INK }}>
                  <input
                    type="checkbox" checked={marked}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      mortgages: e.target.checked
                        ? [...d.mortgages.filter((m) => String(m.key || m) !== l.key), { key: l.key, label: l.label }]
                        : d.mortgages.filter((m) => String(m.key || m) !== l.key),
                    }))} />
                  This is a mortgage
                </label>
                {marked && (
                  <div style={{ marginTop: 8 }}>
                    <Ways
                      ways={ws.ways} chosen={entry.way} values={entry.values}
                      onChoose={(k) => setDraft((d) => ({
                        ...d, lines: { ...d.lines, [l.key]: { ...(d.lines[l.key] || {}), way: k } },
                      }))}
                      onValue={(k, v) => setDraft((d) => ({
                        ...d,
                        lines: {
                          ...d.lines,
                          [l.key]: {
                            ...(d.lines[l.key] || {}),
                            values: { ...((d.lines[l.key] || {}).values || {}), [k]: v },
                          },
                        },
                      }))} />
                    {l.document && (
                      <p style={{ margin: '6px 0 0', fontSize: 12, color: GREEN }}>
                        {l.document.filename} is on this line and accepted.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {ws.lines.length > 0 && (
            <button
              type="button" disabled={busy}
              style={{ ...btn(true), marginTop: 12, opacity: busy ? 0.5 : 1 }}
              onClick={() => save({ mortgages: draft.mortgages, lines: draft.lines })}>
              {busy ? 'Saving…' : 'Save these answers'}
            </button>
          )}
        </div>
      )}

      {err && <p style={{ margin: '8px 0 0', fontSize: 13, color: RED, lineHeight: 1.55 }}>{err}</p>}
      {note && <p style={{ margin: '8px 0 0', fontSize: 13, color: GREEN }}>{note}</p>}
    </div>
  );
}
