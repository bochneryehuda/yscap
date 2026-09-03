import React, { useCallback, useEffect, useState } from 'react';
import { ltApi } from './api.js';
import { INK, MUTED, SLATE, GOLD, GOLD_TEXT, CAUTION, DANGER, eyebrow, sub, input, LINE, WASH } from './ppeStyles.js';

/**
 * INVESTORS THE SECOND SYSTEM DID NOT CARRY — the record behind the silence.
 *
 * ── THE OWNER'S DECISION, IN WRITING (2026-09-03) ──────────────────────────
 * *"final decision on this one is to leave it out silently and send the notification to the super
 * admin email"* — plus *"a manual review section recording the scenario, which investor LoanNEX
 * missed, and whether Lender Price had it, so the cause can be dug into."*
 *
 * ⛔ SILENTLY MEANS ON THE PRICING SCREEN, NOT HERE. The officer pricing a loan is told nothing —
 * the investor is simply absent — because once an investor is switched over, the other system's
 * copy of its pricing is second-hand and showing it would be quoting a sheet we have deliberately
 * stopped trusting for that investor. This section is where the people who can FIX it look.
 *
 * ⛔ AN UNREADABLE LOG SAYS SO. Rendering an empty list when the read failed would claim nothing
 * has ever gone wrong, which is the one thing this section may never say.
 */

const dateText = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
};

/** Whether the OTHER system had them, in words — the owner's own question. */
function otherNote(v) {
  if (v === true) return { text: 'The other system did have them', tone: CAUTION };
  if (v === false) return { text: 'Neither system had them', tone: MUTED };
  return { text: 'We could not tell', tone: MUTED };
}

/** The loan's shape, in one readable line. Only what the server recorded — never a person. */
function scenarioLine(sc) {
  const s = sc || {};
  const bits = [];
  if (s.purpose) bits.push(s.purpose);
  if (s.state) bits.push(s.county ? `${s.county}, ${s.state}` : s.state);
  if (s.zip) bits.push(s.zip);
  if (s.propertyType) bits.push(s.propertyType);
  if (s.loan) bits.push(`$${Math.round(s.loan).toLocaleString('en-US')} loan`);
  if (s.value) bits.push(`$${Math.round(s.value).toLocaleString('en-US')} value`);
  if (s.fico) bits.push(`${s.fico} FICO`);
  if (s.dscr) bits.push(`DSCR ${s.dscr}`);
  if (s.termYears) bits.push(`${s.termYears} years`);
  if (s.interestOnly === true) bits.push('interest only');
  if (s.prepayMonths) bits.push(`${s.prepayMonths}-month prepay`);
  return bits.length ? bits.join(' · ') : 'no scenario recorded';
}

export default function LtSourceMisses() {
  const [data, setData] = useState(null);
  const [gone, setGone] = useState(false);
  const [err, setErr] = useState(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [note, setNote] = useState({});
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setErr(null);
    ltApi.sourceMisses(openOnly)
      .then((r) => {
        setData(r);
        // The read can succeed as a request and FAIL as a read — the server says which,
        // and "we could not read the log" must never render as "nothing has gone wrong".
        if (r && r.ok && r.problem) setErr(`The review log could not be read: ${r.problem}`);
      })
      .catch((e) => {
        if (e && (e.status === 404 || (e.data && e.data.error === 'not_found'))) { setGone(true); return; }
        setErr((e && e.message) || 'The review log could not be read.');
      });
  }, [openOnly]);
  useEffect(load, [load]);

  async function mark(row, reviewed) {
    if (busy) return;
    setBusy(row.id);
    try {
      await ltApi.sourceReviewMiss(row.id, { reviewed, note: note[row.id] || '' });
      setNote((s) => ({ ...s, [row.id]: '' }));
      load();
    } catch (e) {
      setErr((e && e.message) || 'That could not be saved.');
    } finally { setBusy(null); }
  }

  if (gone) return null;

  const rows = (data && data.rows) || [];
  const openCount = (data && data.openCount) || 0;

  return (
    <div>
      <div style={eyebrow}>Investors the second system did not carry</div>
      <p style={{ ...sub, marginBottom: 10, lineHeight: 1.7 }}>
        When a system answers a search and does not carry an investor it is supposed to price, that
        investor is left off the board with <strong style={{ color: INK }}>nothing said on the
        pricing screen</strong> — the other system&#8217;s copy of its pricing is second-hand once
        the investor has been switched over. The super admin is emailed, and every search that hit
        it is recorded here.
        <br />
        One line per investor per day, with a count, so a bad afternoon reads as one line.
      </p>

      {err && <div style={{ fontSize: 13, color: DANGER, marginBottom: 10 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ fontSize: 13, color: SLATE, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          Only the ones nobody has looked at
        </label>
        <span style={{ fontSize: 12, color: openCount ? GOLD_TEXT : MUTED }}>
          {openCount} waiting to be looked at
        </span>
        <button type="button" onClick={load} style={{
          marginLeft: 'auto', appearance: 'none', border: `1px solid ${LINE}`, background: '#fff',
          color: INK, borderRadius: 9, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}>Refresh</button>
      </div>

      {data && rows.length === 0 && (
        <div style={{ fontSize: 13, color: MUTED, padding: '10px 0' }}>
          {openOnly
            ? 'Nothing is waiting. Un-tick the box above to see everything that has been looked at.'
            : 'Nothing has been recorded — no search has had an investor go missing.'}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((r) => {
          const other = otherNote(r.other_source_had);
          const settled = !!r.reviewed_at;
          return (
            <div key={r.id} style={{
              border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 12px',
              background: settled ? '#FBFAF8' : '#fff',
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>
                  {r.investor_label || r.investor_key}
                </div>
                <div style={{ fontSize: 12, color: MUTED }}>
                  {r.source === 'loannex' ? 'LoanNEX' : r.source} did not carry them
                </div>
                <div style={{
                  fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 8px',
                  background: WASH, color: SLATE, whiteSpace: 'nowrap',
                }}>{r.hits} search{r.hits === 1 ? '' : 'es'}</div>
                <div style={{ fontSize: 12, color: other.tone, marginLeft: 'auto' }}>{other.text}</div>
              </div>
              <div style={{ fontSize: 12, color: SLATE, marginTop: 4, overflowWrap: 'anywhere' }}>
                {scenarioLine(r.scenario)}
              </div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 3 }}>
                First seen {dateText(r.first_seen_at)} · last {dateText(r.last_seen_at)}
                {r.alerted_at ? ' · the super admin was told' : ' · nobody has been emailed about this one'}
              </div>
              {settled ? (
                <div style={{ fontSize: 12, color: GOLD_TEXT, marginTop: 6 }}>
                  Looked at {dateText(r.reviewed_at)}{r.review_note ? ` — ${r.review_note}` : ''}
                  {' '}
                  <button type="button" disabled={busy === r.id} onClick={() => mark(r, false)} style={{
                    appearance: 'none', border: 0, background: 'transparent', color: GOLD_TEXT,
                    fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0,
                  }}>put it back</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                  <input
                    style={{ ...input, fontSize: 14, padding: '7px 9px', flex: '1 1 220px', width: 'auto' }}
                    placeholder="What did you find? (optional)"
                    value={note[r.id] || ''}
                    onChange={(e) => setNote((s) => ({ ...s, [r.id]: e.target.value }))}
                  />
                  <button type="button" disabled={busy === r.id} onClick={() => mark(r, true)} style={{
                    appearance: 'none', border: 0, borderRadius: 9, padding: '8px 14px',
                    fontSize: 13, fontWeight: 700, minHeight: 38, cursor: 'pointer',
                    background: GOLD, color: '#fff',
                  }}>{busy === r.id ? 'Saving…' : 'Mark looked at'}</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
