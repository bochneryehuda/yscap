import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ltApi } from './api.js';

/**
 * A CONTACT CONDITION IS A FORM WIRED TO THE FILE'S CONTACTS — not a drop zone.
 *
 * Owner-reported 2026-08-31: *"The file contacts condition has an upload slot.
 * This is not the intent. The intent is that it should follow the same type of
 * idea that we have on the file contacts on the short term … the required file
 * contact comes up as conditions with a form type of idea which is directly
 * linked to the file contacts so automatically when you fill the form it
 * automatically fills the file contact for that type … when you start typing
 * it's automatically linked to the vendors that we have in the system."*
 *
 * And the consequence of not having it, in the owner's own words: *"I know all
 * the orders are automatically a problem because the FileContacts is one dummy,
 * and the orders are not linked to the correct FileContacts, so you can't even
 * send it out."* That is literally true — `orders/data.blockers` refuses to send
 * when the loan carries no vendor of the order's kind, and until now there was
 * no screen that could put one there.
 *
 * ── WHAT IS DELIBERATE ──────────────────────────────────────────────────────
 *
 * 1. IT WRITES THE LOAN'S REAL CONTACT ROW (`lt_loan_vendors` -> the shared
 *    `service_contacts` directory), through the same doors the orders desk
 *    reads. Nothing is stored on the condition, so filling this form is what
 *    makes the matching order sendable — which is the whole point.
 *
 * 2. TYPING SEARCHES THE SHARED DIRECTORY. One company is one card across both
 *    products; a name typed twice is the same record, not two.
 *
 * 3. A CONTACT THAT DOES NOT BELONG TO THIS FILE IS GREYED WITH ITS REASON,
 *    never hidden — the server decides (`applies`), and `applies === null`
 *    ("we could not tell") is drawn differently from a confident "no".
 *
 * 4. FLOOD IS ONE CLICK FROM HAZARD — *"with one click of a button you can click
 *    hey this context is the same as the flood of the regular hazard
 *    insurance."* It LINKS THE SAME DIRECTORY CARD to the flood role rather than
 *    copying its details, so correcting the agent once corrects both.
 *
 * 5. EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. `--ink*` is a LIGHT paper colour
 *    in this palette — the names are legacy and they lie.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GOLD = '#AE8746';
const GREEN = '#2F6B4F';
const RED = '#8A2D2D';

/** Which contact a "same as" shortcut copies FROM, by the role it fills. */
const SAME_AS = Object.freeze({
  flood_insurance: { from: 'hazard_insurance', label: 'Same as the hazard insurance agent' },
});

const emailsOf = (v) => (Array.isArray(v && v.emails) ? v.emails : []).filter(Boolean);
const phonesOf = (v) => (Array.isArray(v && v.phones) ? v.phones : []).filter(Boolean);

function ContactRow({ loanId, type, vendors, onChanged, busy, setBusy }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ companyName: '', contactName: '', email: '', phone: '' });
  const [err, setErr] = useState(null);

  const on = vendors.find((v) => v.kind === type.key) || null;
  const greyed = type.applies === false;
  const unknown = type.applies === null;
  const sameAs = SAME_AS[type.key];
  const source = sameAs ? vendors.find((v) => v.kind === sameAs.from) : null;

  /* THE TYPE-AHEAD. Two characters is the server's own floor; asking below it
     would return the whole directory and read as a broken search. */
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setHits(null); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      ltApi.orderVendorSearch(loanId, type.key, term)
        .then((r) => { if (alive) setHits(r.results || []); })
        .catch(() => { if (alive) setHits([]); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q, loanId, type.key]);

  const run = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); setQ(''); setHits(null); setAdding(false); await onChanged(); }
    catch (e) { setErr((e && e.message) || 'That did not save.'); }
    finally { setBusy(false); }
  };

  const link = (contactId) => run(() =>
    ltApi.orderVendorLink(loanId, { kind: type.key, serviceContactId: contactId }));

  const create = () => {
    const d = draft;
    if (!d.companyName.trim() && !d.contactName.trim() && !d.email.trim() && !d.phone.trim()) {
      setErr('Enter at least one detail — a company, a name, an email or a phone number.');
      return;
    }
    run(() => ltApi.orderVendorCreate(loanId, { kind: type.key, ...d }));
  };

  return (
    <div style={{ padding: '10px 0', borderTop: `1px solid ${LINE}`, opacity: greyed ? 0.62 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK }}>{type.label}</div>
        {type.required && !greyed
          ? <span style={{ fontSize: 11, color: GOLD, fontWeight: 700 }}>REQUIRED</span> : null}
        {on ? <span style={{ fontSize: 11, color: GREEN, fontWeight: 700 }}>ON THE FILE</span> : null}
        {greyed ? <span style={{ fontSize: 12, color: MUTED }}>{type.whyNot || 'Not for this file.'}</span> : null}
        {unknown ? <span style={{ fontSize: 12, color: MUTED }}>{type.whyNot}</span> : null}
      </div>

      {on ? (
        <div style={{ marginTop: 4, fontSize: 13, color: INK, lineHeight: 1.5 }}>
          {on.missing ? (
            <span style={{ color: RED }}>
              This company is no longer in the directory. Pick another, or add it again.
            </span>
          ) : (
            <>
              <div>{on.companyName || on.contactName || '(no name)'}</div>
              <div style={{ color: MUTED, fontSize: 12.5 }}>
                {[on.contactName && on.companyName ? on.contactName : null,
                  emailsOf(on)[0], phonesOf(on)[0]].filter(Boolean).join(' · ') || 'No email or phone yet'}
              </div>
            </>
          )}
          <button type="button" className="btn ghost small" disabled={busy}
            style={{ marginTop: 6 }}
            onClick={() => run(() => ltApi.orderVendorUnlink(loanId, on.id))}>
            Take off the file
          </button>
        </div>
      ) : greyed ? null : (
        <div style={{ marginTop: 6 }}>
          {sameAs && source && !source.missing ? (
            <button type="button" className="btn soft small" disabled={busy}
              style={{ marginBottom: 6 }}
              onClick={() => link(source.serviceContactId)}>
              {sameAs.label}
            </button>
          ) : null}

          <input className="input" value={q} disabled={busy}
            placeholder="Start typing a company or a name…"
            onChange={(e) => setQ(e.target.value)}
            style={{ width: '100%', maxWidth: 420 }} />

          {hits && hits.length ? (
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0,
              border: `1px solid ${LINE}`, borderRadius: 8, maxWidth: 420, overflow: 'hidden' }}>
              {hits.map((h) => (
                <li key={h.id} style={{ borderTop: `1px solid ${LINE}` }}>
                  <button type="button" disabled={busy}
                    onClick={() => link(h.id)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
                      background: 'none', border: 0, cursor: 'pointer', fontSize: 13, color: INK }}>
                    <strong>{h.companyName || h.contactName || '(no name)'}</strong>
                    <span style={{ color: MUTED }}>
                      {[h.contactName && h.companyName ? h.contactName : null,
                        (h.emails || [])[0]].filter(Boolean).map((x) => ` · ${x}`).join('')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {hits && !hits.length ? (
            <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>
              Nobody by that name in the directory yet.
            </div>
          ) : null}

          {adding ? (
            <div style={{ marginTop: 8, maxWidth: 420, display: 'grid', gap: 6 }}>
              {[['companyName', 'Company'], ['contactName', 'Person'], ['email', 'Email'], ['phone', 'Phone']]
                .map(([k, label]) => (
                  <input key={k} className="input" placeholder={label} value={draft[k]} disabled={busy}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn primary small" disabled={busy} onClick={create}>
                  Add and put on the file
                </button>
                <button type="button" className="btn ghost small" disabled={busy}
                  onClick={() => { setAdding(false); setErr(null); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn ghost small" disabled={busy}
              style={{ marginTop: 6 }} onClick={() => setAdding(true)}>
              Not in the directory — add them
            </button>
          )}
        </div>
      )}

      {err ? <div style={{ marginTop: 6, fontSize: 12.5, color: RED }}>{err}</div> : null}
    </div>
  );
}

export default function LtConditionContacts({ loanId, condition, onChanged }) {
  const types = useMemo(
    () => (Array.isArray(condition && condition.contactTypes) ? condition.contactTypes : []),
    [condition]);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!types.length) return;
    setErr(null);
    try { setData(await ltApi.orderVendors(loanId)); }
    catch (e) { setErr((e && e.message) || 'Could not read this loan’s contacts just now.'); }
  }, [loanId, types.length]);
  useEffect(() => { load(); }, [load]);

  // Self-hiding on every condition that asks for no contacts.
  if (!types.length) return null;

  if (err) {
    return (
      <div style={{ marginTop: 12, fontSize: 13, color: RED }}>
        {err}{' '}
        <button type="button" className="btn ghost small" onClick={load} style={{ marginLeft: 6 }}>Try again</button>
      </div>
    );
  }
  if (!data) return <div style={{ marginTop: 12, fontSize: 13, color: MUTED }}>Reading the contacts…</div>;

  const vendors = data.vendors || [];
  const missingRequired = types.filter((t) => t.applies !== false && t.required
    && !vendors.some((v) => v.kind === t.key));

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
        color: MUTED, fontWeight: 700 }}>Who is on this file</div>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
        These are the loan’s own contacts — the same records the orders are sent to, and the same
        company directory the short-term side uses.
      </p>

      {types.map((t) => (
        <ContactRow key={t.key} loanId={loanId} type={t} vendors={vendors}
          onChanged={async () => { await load(); if (onChanged) await onChanged(); }}
          busy={busy} setBusy={setBusy} />
      ))}

      {missingRequired.length ? (
        <p style={{ margin: '10px 0 0', fontSize: 12.5, color: GOLD, lineHeight: 1.5 }}>
          Still needed before the matching order can go out:{' '}
          {missingRequired.map((t) => t.label).join(', ')}.
        </p>
      ) : null}
    </div>
  );
}
