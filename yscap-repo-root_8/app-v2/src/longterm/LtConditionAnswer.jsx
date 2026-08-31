import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { GOLD_TEXT } from './ppeStyles.js';
import AddressField from './AddressField.jsx';
import LtEntity from './LtEntity.jsx';

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

/* THE OLD READ-ONLY ENTITY BLOCK IS GONE (2026-08-31), not left beside its
   replacement. It listed the three slots and put an Upload button next to each —
   no details form, no entity type, no ownership, no titles, no layered
   entities, no verification — and leaving it here would be a SECOND answer to
   "what is the entity section" on the same screen. The real one is
   `LtEntity.jsx`, which mounts the shared `components/LlcManager.jsx`. */

/**
 * THE APPRAISAL CARD — held on the borrower's PROFILE, both directions.
 *
 * The owner's directive, item 7: the card is *"BIDIRECTIONAL with the shared
 * profile"*. So this says what is already on file before asking for anything,
 * and a card entered here is kept on the person rather than on this loan — which
 * is what makes the condition's own promise ("a card given on one loan is
 * already here on the next") true.
 *
 * THE NUMBER IS NEVER SHOWN AND NEVER COMES BACK. The server returns brand, last
 * four and expiry only; nothing on this path decrypts a card number, so there is
 * nothing here that could render one. The input is `inputMode="numeric"` and
 * `autoComplete="cc-number"` so a phone offers the right keyboard and a password
 * manager the right field — but it is never re-populated from the server.
 *
 * AN EXPIRED CARD IS ITS OWN STATE, not an absent one: those need different
 * sentences, because one asks for a card and the other says the one on file has
 * run out.
 */
function CardBlock({ ws, loanId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ number: '', cvc: '', exp: '', zip: '' });
  const card = ws.card || { available: false };

  const save = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      // `exp` goes as typed ("MM/YY"); the SERVER splits it through the shared
      // module's own parser, so this screen never decides what an expiry looks
      // like.
      await ltApi.appraisalCardSave(loanId, f);
      setF({ number: '', cvc: '', exp: '', zip: '' });
      setOpen(false);
      if (onChanged) await onChanged();
    } catch (e) {
      setErr((e && (e.error || e.message)) || 'That card could not be saved.');
    } finally { setBusy(false); }
  }, [loanId, f, onChanged]);

  const set = (k) => (e) => setF((d) => ({ ...d, [k]: e.target.value }));

  return (
    <div>
      <div style={eyebrow}>On the borrower’s profile</div>

      {ws.unreadable && (
        <p style={{ margin: 0, fontSize: 13, color: RED, lineHeight: 1.55 }}>{ws.why}</p>
      )}

      {!ws.unreadable && card.available && (
        <p style={{ margin: 0, fontSize: 13, color: card.expired ? RED : INK, lineHeight: 1.55 }}>
          {card.expired
            ? `The ${card.brand || 'card'} ending ${card.last4} on this borrower’s profile expired (${card.exp}). A new one is needed.`
            : `A ${card.brand || 'card'} ending ${card.last4} is already on this borrower’s profile${card.exp ? `, good to ${card.exp}` : ''}.`}
        </p>
      )}
      {!ws.unreadable && !card.available && (
        <p style={{ margin: 0, fontSize: 13, color: MUTED, lineHeight: 1.55 }}>
          No card on this borrower’s profile yet. One entered here is kept on the profile, so the
          next loan for the same borrower already has it.
        </p>
      )}

      {!open && (
        <button type="button" style={{ ...btn(!card.available), marginTop: 10 }}
          onClick={() => setOpen(true)}>
          {card.available ? 'Replace the card on file' : 'Add a card'}
        </button>
      )}

      {open && (
        <div style={{ marginTop: 10 }}>
          <label htmlFor="lt-cc-num" style={{ display: 'block', fontSize: 12, color: MUTED }}>Card number</label>
          <input id="lt-cc-num" style={input} value={f.number} onChange={set('number')}
            inputMode="numeric" autoComplete="cc-number" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <div style={{ flex: '1 1 7rem' }}>
              <label htmlFor="lt-cc-exp" style={{ display: 'block', fontSize: 12, color: MUTED }}>Expiry (MM/YY)</label>
              <input id="lt-cc-exp" style={input} value={f.exp} onChange={set('exp')}
                inputMode="numeric" autoComplete="cc-exp" placeholder="04/29" />
            </div>
            <div style={{ flex: '1 1 5rem' }}>
              <label htmlFor="lt-cc-cvc" style={{ display: 'block', fontSize: 12, color: MUTED }}>Security code</label>
              <input id="lt-cc-cvc" style={input} value={f.cvc} onChange={set('cvc')}
                inputMode="numeric" autoComplete="cc-csc" />
            </div>
            <div style={{ flex: '1 1 6rem' }}>
              <label htmlFor="lt-cc-zip" style={{ display: 'block', fontSize: 12, color: MUTED }}>Billing ZIP</label>
              <input id="lt-cc-zip" style={input} value={f.zip} onChange={set('zip')}
                inputMode="numeric" autoComplete="postal-code" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" disabled={busy} style={{ ...btn(true), opacity: busy ? 0.5 : 1 }}
              onClick={save}>{busy ? 'Saving…' : 'Save to the profile'}</button>
            <button type="button" disabled={busy} style={btn(false)}
              onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {err && <p style={{ margin: '8px 0 0', fontSize: 13, color: RED, lineHeight: 1.55 }}>{err}</p>}
    </div>
  );
}

/**
 * THE GOVERNMENT PHOTO ID — read only, and that is deliberate rather than
 * unfinished. An ID already on the borrower's profile answers this condition,
 * which is exactly what its own hint promises. Making an upload HERE become the
 * profile's ID is an open question with the owner: on the short-term side that
 * act also reopens every government-ID condition across the borrower's files,
 * and Long-Term writing those would be one product reaching into the other's
 * workflow. `src/longterm/conditions-center/profile-links.js` records why.
 * Uploading against this condition works as it does for any other document.
 */
function PhotoIdBlock({ ws }) {
  const id = ws.photoId || { available: false };
  return (
    <div>
      <div style={eyebrow}>On the borrower’s profile</div>
      {ws.unreadable && (
        <p style={{ margin: 0, fontSize: 13, color: RED, lineHeight: 1.55 }}>{ws.why}</p>
      )}
      {!ws.unreadable && (
        <p style={{ margin: 0, fontSize: 13, color: id.available ? GREEN : MUTED, lineHeight: 1.55 }}>
          {id.available
            ? `A photo ID is already on this borrower’s profile${id.filename ? ` (${id.filename})` : ''} — it was given on an earlier loan and does not need sending again.`
            : 'No photo ID on this borrower’s profile yet.'}
        </p>
      )}
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
      ) : field.type === 'address' ? (
        /* THE LOOK-UP THE OWNER ASKED FOR, IN THE PLACE THEY ASKED FOR IT.
           The sharing directive's item 8 is "the address lookup (the existing
           autocomplete) INSIDE LT conditions", and the box was built and then
           wired only to the term sheet — so the one condition that asks for an
           address, "say which property this mortgage is secured by" on the
           REO/mortgages list, has been a bare text box since it shipped. The
           server has said `type: 'address'` about that field all along
           (`src/lib/conditions/answers.js`); this renderer simply had no branch
           for it and fell through to a plain input, silently, which is why
           nothing ever errored.
           `AddressField` emits a one-line string exactly like the plain input
           it replaces, so nothing downstream changes — the answer is stored,
           validated and read the same way. It degrades to an ordinary text box
           on any provider failure, so a rural parcel or a bad minute at the
           vendor can never stop somebody answering the condition. */
        <AddressField
          id={id}
          style={input}
          value={value == null ? '' : value}
          onChange={onChange}
          ariaLabel={field.label} />
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
      const r = await ltApi.conditionAnswer(loanId, conditionId, answer);
      /* TWO CONDITIONS, ONE CLICK — so the second one is REPORTED. Marking a
         mortgage as the one on the subject property fills in the statement
         condition, and a person who is not told that has no reason to look at
         it. A reason it could NOT be filled in matters just as much: silence
         would read as "done". */
      const sub = (r && r.subjectMortgage) || {};
      const extra = sub.note || sub.why || null;
      setNote(extra ? `Saved. ${extra}` : 'Saved.');
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
      {/* ── THE ENTITY SECTION — the short-term one, on this file ────────────
          Owner-directed 2026-08-31: *"The exact entity section, same exact form
          information to type in an entity section. The exact verification
          workflow … The exact document slots and bi-directional … Don't
          reinvent."* `LtEntity` is the adapter and the verify control; the
          section itself is `components/LlcManager.jsx`, the same component the
          short-term file screen renders. What used to be here was a read-only
          list of the three slots with an Upload button beside each — true, and a
          long way short of an entity section. */}
      {ws.shape === 'entity' && (
        <LtEntity
          loanId={loanId}
          entityName={ws.entityName}
          profile={ws.profile}
          note={ws.note}
          onChanged={load} />
      )}

      {/* THE CARD AND THE ID LIVE ON THE PERSON, so both say what the borrower
          already has before asking for anything. */}
      {ws.shape === 'card' && (
        <CardBlock ws={ws} loanId={loanId} onChanged={load} />
      )}
      {ws.shape === 'photo_id' && (
        <PhotoIdBlock ws={ws} />
      )}

      {/* ── One choice ─────────────────────────────────────────────────────── */}
      {ws.shape === 'choice' && (
        <div>
          <div style={eyebrow}>How you want to answer this</div>
          {/* THE MARK. When these figures came off the credit report rather than
              from the person reading them, the screen says so — including that a
              credit report carries only the last four digits of an account, so
              nobody keys four digits into Encompass as a loan number. */}
          {ws.sourceNote && (
            <p style={{
              margin: '0 0 10px', padding: '8px 10px', borderRadius: 8,
              background: '#FFF7E6', border: '1px solid #E4C77A',
              fontSize: 12.5, color: '#3A4550', lineHeight: 1.55,
            }}>
              {ws.sourceNote}
            </p>
          )}
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
