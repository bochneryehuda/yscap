import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';

/**
 * ADD A LEAD FROM ELEMENTIX — type a name, pick the person, get them as a lead.
 *
 * The owner's third requirement, in their own words: "if another loan officer
 * clicked to get his contact information you should add them manually to your
 * profile if you want to keep them as a contact. So we put in their name, it
 * pulls up a few options of a few people available, you select which person,
 * that pulls in that person's entire contact information."
 *
 * ── THE ONE THING THIS SCREEN MUST GET RIGHT ────────────────────────────────
 * It has to be obvious, BEFORE the click, whether the click costs money. A
 * person somebody has already unlocked is FREE to add — that is the whole case
 * the owner described — and a person nobody has unlocked costs a credit. So the
 * free-status check runs on selection, the button says which one it is in plain
 * words, and only the paid one asks for a reason and a confirmation.
 *
 * Text colours are explicit dark hex: the `--ink*` tokens in this palette are
 * LIGHT, so `color: var(--ink)` renders white on white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E4DECF';

export default function ElementixFinder({ onAdded, onClose }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [hits, setHits] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState(null);
  const [status, setStatus] = useState(null);
  const [reason, setReason] = useState('');
  const [usage, setUsage] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => { api.elxUsage().then(setUsage).catch(() => {}); }, []);

  const search = async () => {
    setErr(''); setPicked(null); setStatus(null); setDone(null);
    if (q.trim().length < 3) { setErr('Type at least three letters of the name.'); return; }
    setBusy('search');
    try {
      const r = await api.elxSearch(q.trim(), state.trim().toUpperCase());
      setHits(r.results || []);
      setTruncated(!!r.truncated);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  /* Selecting somebody runs the FREE status check, so the button that follows
     can tell the truth about what it will cost. */
  const pick = async (h) => {
    setErr(''); setPicked(h); setStatus(null); setDone(null);
    setBusy('status');
    try { setStatus(await api.elxContact(h.personId)); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  /* THE SERVER DECIDES WHETHER THIS COSTS MONEY, not this screen. It asks our own
     store first (detail we hold is proof we already paid) and the vendor second,
     and it says plainly when it could not ask at all — which is neither "free"
     nor a reason to warn about a credit we may not spend. */
  const alreadyUnlocked = !!(status && status.free);
  const statusUnknown = !!(status && status.statusKnown === false);

  const add = async () => {
    if (!picked) return;
    setErr('');
    if (!alreadyUnlocked) {
      if (reason.trim().length < 4) { setErr('Say in a few words why you are looking this person up — it is kept with the credit that gets spent.'); return; }
      const yes = await askConfirm(
        statusUnknown
          ? `Look up ${picked.name || 'this person'}'s contact details? PILOT could not reach Elementix to check whether anybody here has already unlocked them, so this may spend one of the month's credits.`
          : `Look up ${picked.name || 'this person'}'s contact details? Nobody here has unlocked them yet, so this spends one of the month's credits.`,
        { confirmLabel: 'Look them up' });
      if (!yes) return;
    }
    setBusy('add');
    try {
      const body = { name: picked.name, state: picked.state, reason: reason.trim() || 'Added from Elementix' };
      const out = alreadyUnlocked
        ? await api.elxAddLead(picked.personId, body)
        : await api.elxSkipTrace(picked.personId, body);
      setDone(out);
      api.elxUsage().then(setUsage).catch(() => {});
      if (onAdded) onAdded(out);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  return (
    <div className="panel">
      <div className="panel-h" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3>Add a lead from Elementix</h3>
        <span style={{ flex: 1 }} />
        {usage && (
          <span style={{ color: MUTED, fontSize: 12.5 }}>
            {usage.ok ? `${usage.paidThisMonth} of ${usage.paidCap} lookups used this month` : ''}
          </span>
        )}
        {onClose && <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>}
      </div>
      <div className="panel-b">
        {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
        {done && (
          <div className="notice ok" style={{ marginBottom: 10 }}>
            {done.charged
              ? 'Looked them up and added them to your leads — one credit used.'
              : 'Added to your leads. Nobody was charged: this person had already been looked up.'}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <label className="lbl" style={{ color: MUTED }}>Their name</label>
            <input className="input" style={{ fontSize: 16 }} value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') search(); }} placeholder="e.g. Moty Brisk" />
          </div>
          <div style={{ flex: '0 0 110px' }}>
            <label className="lbl" style={{ color: MUTED }}>State</label>
            <input className="input" style={{ fontSize: 16 }} maxLength={2} value={state}
              onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="NJ" />
          </div>
          <button className="btn primary" disabled={busy === 'search'} onClick={search}>
            {busy === 'search' ? 'Searching…' : 'Search Elementix'}
          </button>
        </div>

        {hits && !hits.length && (
          <div style={{ color: MUTED, fontSize: 14, marginTop: 12 }}>Elementix has nobody by that name. Try a different spelling, or leave the state blank.</div>
        )}

        {hits && hits.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ color: MUTED, fontSize: 13, marginBottom: 6 }}>
              Pick the right person — Elementix keeps a separate record per state.
              {truncated ? ' Elementix sent back as many as it will in one go, so there may be more — add the state, or type more of the name.' : ''}
            </div>
            {hits.map((h) => {
              const on = picked && picked.personId === h.personId;
              return (
                <div key={h.personId} onClick={() => pick(h)} style={{
                  display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', cursor: 'pointer',
                  border: `1px solid ${on ? '#AE8746' : LINE}`, background: on ? '#FCF8F1' : '#FFFFFF',
                  borderRadius: 10, padding: '10px 12px', marginBottom: 8,
                }}>
                  <div style={{ flex: '1 1 200px' }}>
                    <div style={{ color: INK, fontWeight: 600 }}>{h.name || 'Unnamed'}</div>
                    <div style={{ color: MUTED, fontSize: 13 }}>
                      {h.state || 'state unknown'}
                      {h.hasContact ? ' · we already hold their details' : ''}
                      {h.leadCount ? ` · already a lead for ${h.leadCount} officer(s)` : ''}
                    </div>
                  </div>
                  {on && <span style={{ color: '#AE8746', fontWeight: 650, fontSize: 13 }}>Selected</span>}
                </div>
              );
            })}
          </div>
        )}

        {picked && (
          <div style={{ borderTop: `1px solid ${LINE}`, marginTop: 6, paddingTop: 12 }}>
            {busy === 'status' && <div style={{ color: MUTED, fontSize: 14 }}>Checking whether anyone has looked them up…</div>}
            {status && (
              <>
                <div style={{ color: INK, fontSize: 14, marginBottom: 8 }}>
                  {alreadyUnlocked
                    ? <>Somebody here has already looked <strong>{picked.name}</strong> up, so adding them to your leads is <strong>free</strong>.</>
                    : statusUnknown
                      ? <>PILOT could not reach Elementix to check whether anyone has looked <strong>{picked.name}</strong> up. Going ahead may use one of the month’s credits — or may cost nothing, if they turn out to be unlocked already.</>
                      : <>Nobody here has looked <strong>{picked.name}</strong> up yet, so this will use <strong>one of the month’s credits</strong>.</>}
                </div>
                {!alreadyUnlocked && (
                  <div style={{ marginBottom: 8 }}>
                    <label className="lbl" style={{ color: MUTED }}>Why are you looking them up?</label>
                    <input className="input" style={{ fontSize: 16 }} value={reason} onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Calling about a bridge loan on 41 Arlington Ave" />
                  </div>
                )}
                <button className="btn primary" disabled={busy === 'add'} onClick={add}>
                  {busy === 'add' ? 'Adding…' : alreadyUnlocked ? 'Add to my leads' : 'Look them up and add to my leads'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
