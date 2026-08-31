import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import LtLayout from './LtLayout.jsx';
import { ltApi } from './api.js';
import {
  money, money2, noteRate, price, points, plain, stamp, day, pct, ratio, yesNo,
} from './format.js';

/**
 * PULL UP A TERM SHEET BY ITS ID.
 *
 * Owner-reported 2026-08-31: *"there is no place where loan officers can go in
 * and see the data when they put in the ID … see exactly what the input was and
 * what exactly they priced in the real program and the real investors behind
 * everything."*
 *
 * ⛔ THE BACK END WAS ALREADY THERE AND NOBODY COULD REACH IT. `GET
 * /api/lt/dscr/term-sheet/:code` has replayed a stored sheet since the day it
 * shipped; there was no screen, so the answer existed and no one could ask the
 * question. A back end is not a feature.
 *
 * ⛔ IT REPLAYS, IT NEVER RE-PRICES. Everything on this page is the document as
 * it was ISSUED — the whole point of a term sheet ID is that an officer on the
 * telephone sees what the borrower was actually sent, not what today's rate
 * sheet would say. The route that re-prices is a different door and is not
 * wired here.
 *
 * ⛔ TWO HALVES, AND THE SECOND ONE MAY NEVER REACH A CLIENT. "What the officer
 * typed" comes off each option's own scenario, which the document has always
 * carried. "Who is really behind it" comes from `internal` (db/651), a
 * staff-side record that is deliberately NOT part of the snapshot: the snapshot
 * is what the PDF is drawn from and what a client may hold, and an investor's
 * name never goes on one (CLAUDE.md rule 10). This screen is inside
 * `StaffPrivate` and its door is staff-gated, which is the only place those
 * names are allowed to appear.
 *
 * Every colour is an explicit dark or the brand gold: in this palette every
 * `--ink*` token is a LIGHT paper colour, so one used as a text colour renders
 * white on white.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
/* THE BRAND GOLD IS A BORDER AND A RULE, NEVER A WORD. Measured on white it is
   about 3.4:1 — under AA for body text — which is why every long-term screen is
   swept for it (`test-lt-status-reviews-pure.js`). `ACCENT` is the darker gold
   that carries the words the gold border frames. */
const GOLD = '#AE8746';
const ACCENT = '#8A6A22';
const TEAL = '#256168';
const RED = '#8A2D2D';
const LINE = 'rgba(20,27,34,.10)';

/** How the three documents are named, matching the server's own wording. */
const KIND_WORDS = {
  term_sheet: 'Term sheet',
  comparison: 'Comparison sheet',
  scenario_comparison: 'Scenario comparison',
};

/* ⛔ EVERY FIGURE IS WRITTEN THE WAY EVERY OTHER LONG-TERM SCREEN WRITES IT.
   `money`, `pct`, `ratio`, `noteRate`, `price` and `points` come from
   `format.js`, which exists because the pipeline and the file screen had already
   drifted on one of them. A replay screen is the last place to invent a second
   convention: an officer comparing this page to the pricer must see the same
   number written the same way, or the difference reads as a real one. */

const MODE_WORDS = { borrowerPaid: 'Borrower-paid', lenderPaid: 'Lender-paid' };

function Row({ label, value, strong = false }) {
  return (
    <div style={{
      display: 'flex', gap: 12, justifyContent: 'space-between',
      padding: '5px 0', borderBottom: `1px solid ${LINE}`, fontSize: 13,
    }}>
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ color: INK, fontWeight: strong ? 700 : 550, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function Card({ title, note, children, tone = 'plain' }) {
  const border = tone === 'internal' ? `1px solid ${GOLD}` : '1px solid rgba(20,27,34,.12)';
  return (
    <section className="lt-card" style={{ color: INK, border, marginBottom: 12 }}>
      <h3 style={{
        margin: '0 0 2px', fontSize: 11, letterSpacing: '.12em',
        textTransform: 'uppercase', color: tone === 'internal' ? ACCENT : MUTED, fontWeight: 700,
      }}>{title}</h3>
      {note && <p style={{ margin: '0 0 8px', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{note}</p>}
      {children}
    </section>
  );
}

/**
 * WHAT THE OFFICER TYPED — the search, exactly as it ran.
 *
 * Every figure here is off the option's own stored scenario. Nothing is derived
 * on this screen: a blank means the officer left it blank, and printing a
 * computed stand-in would make the record say something the officer did not.
 */
function ScenarioBlock({ s }) {
  const sc = s || {};
  return (
    <div>
      <Row label="Purpose" value={plain(sc.purpose)} />
      <Row label="Property type" value={plain(sc.propertyType)} />
      <Row label="Units" value={plain(sc.units)} />
      <Row label="Property value" value={money(sc.propertyValue)} />
      <Row label="Loan amount" value={money(sc.loanAmount)} strong />
      <Row label="Loan to value" value={pct(sc.ltv)} />
      <Row label="Term" value={sc.termYears == null ? '—' : `${sc.termYears} years`} />
      <Row label="Interest only" value={yesNo(sc.interestOnly)} />
      <Row label="Escrows waived" value={yesNo(sc.escrowWaive)} />
      <Row label="DSCR searched at" value={ratio(sc.dscr)} />
      <Row label="FICO" value={plain(sc.fico)} />
      <Row label="Prepay" value={sc.prepayMonths == null ? '—' : `${sc.prepayMonths} months${sc.prepayStructure ? ` · ${sc.prepayStructure}` : ''}`} />
      <Row label="Where" value={[sc.city, sc.county, sc.state, sc.zip].filter(Boolean).join(', ') || '—'} />
      {/* The qualifying figures the officer typed into the DSCR calculator. They
          are what the ratio was worked out from, so a replay without them cannot
          answer "why did it price at that band". */}
      <Row label="Monthly rent" value={money2(sc.rentMonthly)} />
      <Row label="Monthly taxes" value={money2(sc.taxMonthly)} />
      <Row label="Monthly insurance" value={money2(sc.insuranceMonthly)} />
      <Row label="Monthly HOA" value={money2(sc.hoaMonthly)} />
    </div>
  );
}

/** WHAT THE BORROWER WAS SHOWN — the client-facing half of one option. */
function OfferBlock({ m }) {
  const ch = m.charges || {};
  const cl = m.closing || {};
  return (
    <div>
      <Row label="Program (as the borrower reads it)" value={plain(m.consumerLabel)} strong />
      <Row label="Product" value={plain(m.product)} />
      <Row label="Note rate" value={noteRate(m.ratePct)} strong />
      <Row label="Monthly P&I" value={money2(m.monthlyPI)} />
      <Row label="Compensation" value={MODE_WORDS[m.mode] || plain(m.mode)} />
      <Row label="Lender fees waived" value={yesNo(m.waiveLenderFees)} />
      <Row label="Price shown" value={price(ch.displayPrice)} />
      <Row label="Origination" value={money2(cl.originationDollars)} />
      <Row label="Lender fees" value={money2(cl.lenderFeesDollars)} />
      <Row label="Buydown" value={money2(cl.buydownDollars)} />
      <Row label="Cash to close" value={money2(cl.cashToCloseDollars)} strong />
      <Row label="Prepay" value={plain(m.prepayLabel)} />
      <Row label="Priced at" value={stamp(m.pricedAt)} />
      {m.programNamedBy === 'manual' && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: ACCENT, fontWeight: 600, lineHeight: 1.5 }}>
          The officer named this program by hand — it had no white-label name on the rate sheet.
        </p>
      )}
    </div>
  );
}

/**
 * WHO IS REALLY BEHIND IT — staff only.
 *
 * ⛔ A BLANK HERE IS NOT A FAULT AND IT IS NOT "UNKNOWN". A sheet issued before
 * db/651 was built from a board that never sent the investor identity to the
 * server, so there is nothing to recover — and the server hands us the sentence
 * that says so, rather than this screen inventing wording that could drift.
 */
function InternalBlock({ rec, notRecorded }) {
  const empty = !rec || Object.keys(rec).length === 0;
  if (empty) {
    return <p style={{ margin: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.55 }}>{notRecorded}</p>;
  }
  return (
    <div>
      <Row label="Investor" value={plain(rec.investor)} strong />
      <Row label="Lender" value={plain(rec.lender)} />
      <Row label="Their program name" value={plain(rec.program)} strong />
      <Row label="Their product" value={plain(rec.product)} />
      <Row label="Rate sheet" value={plain(rec.rateSheet)} />
      <Row label="Raw price (before our comp)" value={price(rec.rawPrice)} />
      <Row label="Points on the board" value={points(rec.adjustedPoints)} />
    </div>
  );
}

export default function LtSheetLookup() {
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState(params.get('code') || '');
  const [sheet, setSheet] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState(null);

  /* THE OFFICER'S OWN RECENT SHEETS, so the screen is useful before anybody has
     typed anything. It is a LIST, never the documents — pulling one up is a
     deliberate act, because the code is what a person quotes down a telephone. */
  useEffect(() => {
    let alive = true;
    ltApi.termSheetList()
      .then((r) => { if (alive) setMine(Array.isArray(r && r.sheets) ? r.sheets : []); })
      .catch(() => { if (alive) setMine([]); });
    return () => { alive = false; };
  }, []);

  const look = useCallback((raw) => {
    const c = String(raw || '').trim();
    if (!c) { setErr('Type a term sheet ID.'); return; }
    setBusy(true); setErr(null); setSheet(null);
    /* THE TYPED FORM IS FORGIVING AND THE SERVER OWNS THE RULE. `code.js`
       already folds the letters people confuse, strips the TS- prefix and
       ignores spacing — so a second, browser-side normaliser would be a copy
       that drifts, and the one that drifts is the one that fails to find a real
       sheet. Whatever was typed goes up as it was typed. */
    ltApi.termSheetGet(c)
      .then((r) => {
        setSheet(r);
        setParams(r && r.code ? { code: r.code } : {}, { replace: true });
      })
      .catch((e) => setErr((e && e.message) || 'Could not find that term sheet.'))
      .finally(() => setBusy(false));
  }, [setParams]);

  // A code in the address bar opens straight onto the sheet, so a link to one
  // works — which is what makes this shareable in a message to a colleague.
  useEffect(() => {
    const c = params.get('code');
    if (c) look(c);
    // Deliberately once, on mount: re-running on every `params` change would
    // re-fetch the sheet the successful lookup just wrote into the address bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const snap = sheet && sheet.snapshot ? sheet.snapshot : null;
  const members = snap && Array.isArray(snap.members) ? snap.members : [];
  const internal = sheet && Array.isArray(sheet.internal) ? sheet.internal : [];
  const kindWord = snap ? (KIND_WORDS[snap.docKind] || KIND_WORDS.term_sheet) : '';

  return (
    <LtLayout title="Look up a term sheet">
      <div className="lt-card" style={{ color: INK, marginBottom: 14 }}>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: MUTED, lineHeight: 1.55 }}>
          Type the ID off the document — <strong style={{ color: INK }}>TS-4KH92B</strong>, however it was
          written down. This shows the sheet exactly as it was issued: every figure the officer
          typed, what the borrower was shown, and — staff only — which investor was really behind
          each price. Nothing here re-prices anything.
        </p>
        <form
          onSubmit={(e) => { e.preventDefault(); look(typed); }}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
        >
          <input
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="TS-4KH92B"
            aria-label="Term sheet ID"
            style={{
              flex: '1 1 220px', minWidth: 0, fontSize: 16, letterSpacing: '.08em',
              textTransform: 'uppercase', fontWeight: 700, color: INK,
            }}
          />
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Looking…' : 'Pull it up'}
          </button>
        </form>
        {err && (
          <p style={{ margin: '10px 0 0', color: RED, fontSize: 13, fontWeight: 650 }}>{err}</p>
        )}
      </div>

      {sheet && snap && (
        <>
          {/* ⛔ SAID, NEVER SWALLOWED. A stored document whose bytes no longer
              hash to what we recorded is NOT the document we sent, and the
              screen leads with that rather than presenting it as authoritative. */}
          {sheet.integrity && sheet.integrity.ok === false && (
            <div className="lt-card" style={{
              color: RED, border: `1px solid ${RED}`, marginBottom: 12, fontWeight: 650, fontSize: 13,
            }}>
              This stored sheet no longer matches the fingerprint PILOT recorded when it was issued
              ({plain(sheet.integrity.reason)}). It is shown so you can see it, but do not treat it
              as the document that went out.
            </div>
          )}

          <div className="lt-card" style={{ color: INK, marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <h2 style={{ margin: 0, fontSize: 22, letterSpacing: '.06em', color: INK }}>{sheet.code}</h2>
              <span style={{
                fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase',
                color: ACCENT, fontWeight: 700,
              }}>{kindWord}</span>
              {sheet.expired && (
                <span style={{ fontSize: 12, color: RED, fontWeight: 700 }}>Expired</span>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <Row label="Prepared for" value={plain((snap.prepared || {}).borrowerName)} />
              <Row label="Vesting entity" value={plain((snap.prepared || {}).entityName)} />
              <Row label="Property" value={plain((snap.prepared || {}).propertyAddress)} />
              <Row label="Officer" value={plain((snap.prepared || {}).officerName)} />
              <Row label="Issued" value={stamp(sheet.issued && sheet.issued.at)} />
              <Row label="Priced" value={stamp(sheet.issued && sheet.issued.pricedAt)} />
              <Row label="Expires" value={stamp(sheet.issued && sheet.issued.expiresAt)} />
              <Row label="Options on it" value={String(members.length)} />
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn ghost"
                onClick={() => ltApi.termSheetPdf(sheet.code).catch((e) => setErr((e && e.message) || 'Could not draw that PDF.'))}
              >
                Download the {kindWord.toLowerCase()} (PDF)
              </button>
            </div>
          </div>

          {sheet.internalError && (
            <div className="lt-card" style={{ color: RED, marginBottom: 12, fontSize: 13, fontWeight: 650 }}>
              {sheet.internalError} The document below is still exactly as it was issued.
            </div>
          )}

          {members.map((m, i) => (
            <div key={`${m.consumerLabel || 'option'}:${i}`} style={{ marginBottom: 18 }}>
              <h2 style={{ margin: '0 0 8px', fontSize: 16, color: INK }}>
                {members.length > 1 ? `Option ${i + 1} — ` : ''}{plain(m.consumerLabel)}
                <span style={{ color: MUTED, fontWeight: 500 }}> · {noteRate(m.ratePct)}</span>
              </h2>
              <div style={{
                display: 'grid', gap: 12,
                gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
              }}>
                <Card title="What was searched" note="Every figure the officer typed, as the search ran.">
                  <ScenarioBlock s={m.scenario} />
                </Card>
                <Card title="What the borrower was shown">
                  <OfferBlock m={m} />
                </Card>
                <Card
                  title="Who is behind it — staff only"
                  tone="internal"
                  note="Never on the document, never sent to a borrower or a broker."
                >
                  <InternalBlock
                    rec={(internal[i] || {}).internal}
                    notRecorded={sheet.internalNotRecorded}
                  />
                </Card>
              </div>
            </div>
          ))}
        </>
      )}

      {!sheet && (
        <div className="lt-card" style={{ color: INK }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 16 }}>Your recent sheets</h2>
          {mine === null && <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>Loading…</p>}
          {mine !== null && mine.length === 0 && (
            <p style={{ margin: 0, color: MUTED, fontSize: 13, lineHeight: 1.55 }}>
              You have not issued one yet. Anyone&rsquo;s ID works here — the point of the code is
              that a colleague can read it to you over the telephone.
            </p>
          )}
          {mine !== null && mine.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                <thead>
                  <tr>
                    {['ID', 'What it is', 'Borrower', 'Program', 'Issued'].map((h) => (
                      <th key={h} style={{
                        textAlign: 'left', padding: '8px 10px', fontSize: 10, fontWeight: 700,
                        letterSpacing: '.12em', textTransform: 'uppercase', color: MUTED,
                        borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mine.map((r) => (
                    <tr key={r.id}>
                      <td style={cell}>
                        <button
                          type="button"
                          onClick={() => { setTyped(r.code); look(r.code); }}
                          style={{
                            background: 'none', border: 0, padding: 0, cursor: 'pointer',
                            color: TEAL, fontWeight: 700, textDecoration: 'underline', fontSize: 13,
                          }}
                        >{r.code}</button>
                      </td>
                      <td style={{ ...cell, color: MUTED }}>
                        {KIND_WORDS[r.doc_kind] || (r.kind === 'comparison' ? 'Comparison sheet' : 'Term sheet')}
                        {r.option_count > 1 ? ` · ${r.option_count} options` : ''}
                      </td>
                      <td style={cell}>{plain(r.borrower_name)}</td>
                      <td style={{ ...cell, color: MUTED }}>{plain(r.first_program)}</td>
                      <td style={{ ...cell, color: MUTED, whiteSpace: 'nowrap' }}>{day(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </LtLayout>
  );
}

const cell = {
  padding: '8px 10px', fontSize: 13, color: INK,
  borderBottom: `1px solid ${LINE}`, verticalAlign: 'top',
};
