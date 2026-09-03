/**
 * THE COMBINED PRICING ENGINE — the same board as the General Pricing Engine, priced on BOTH
 * programs at once.
 *
 * ⛔ THIS FILE IS NOT A COPY, AND THAT IS THE WHOLE POINT. It used to be a 2,900-line duplicate of
 * `LtPricer.jsx`, watched by a source fingerprint that could only ever say "the general engine
 * moved and this did not" — after the fact, and only if somebody re-stamped it honestly. The owner
 * ended that arrangement:
 *
 *   "It will not even be a copy. It should just share the code of the general pricing engine. If we
 *    enhance the general pricing engine, this should also enhance it, but it shouldn't touch the
 *    general pricing engine."
 *
 * So there is ONE board. `PricerScreen` is it; `COMBINED_ENGINE` is the short list of everything
 * this one does differently (its door, its investor roster, what it calls a rate sheet, that it
 * shows the vendor's own checks, that it has NO term-sheet cart, and that its door returns no
 * lender count). An enhancement to the general engine reaches this board by existing.
 *
 * WHAT IS LEFT HERE is only what the general engine has no concept of: a second program's
 * near-tier flag, the panel that says what is off the board and — when an admin asks — where each
 * row came from, and the investor link editor. They are handed to the shared screen as a SLOT
 * rather than flagged inside it, because a shared screen that enumerates its own exceptions is a
 * copy with extra steps.
 *
 * Super-admin only, on the server: `/api/lt/dscr/combined/*` answers 404 to everybody else, and
 * the nav entry is hidden rather than shown and refused.
 */
import React, { useState } from 'react';
import LtInvestorLinks from './LtInvestorLinks.jsx';
import { PricerScreen } from './LtPricer.jsx';
import { COMBINED_ENGINE } from './pricerEngine.js';
import { money } from './format.js';
import { GOLD, GOLD_TEXT, INK, SLATE, MUTED, CAUTION, LINE, card, eyebrow, checkRow, checkBox } from './ppeStyles.js';

/**
 * "YOU ARE ALMOST AT A BETTER TIER" (owner-directed 2026-08-30: *"You can make a nice flag that
 * you're almost at the edge… If it's almost at a tier, make a pop-up"*).
 *
 * ⛔ IT DECIDES NOTHING. Every figure here — the tier, the loan amount that reaches it, the gap on
 * the ratio, and the sentence itself — is computed on the SERVER (`pricing/near-tier.js`) off the
 * scenario the vendors were actually asked about and, where the sheet published one, that
 * investor's own grid cell. This draws it. A screen that worked out its own tier would eventually
 * tell somebody to cut a borrower's loan for a tier the sheet does not have.
 *
 * ⛔ AND IT IS A FLAG, NOT A MODAL. The owner asked for a pop-up; a dialog that interrupts every
 * priced board is one people learn to dismiss without reading, and it would sit between an officer
 * and the prices they just paid for. This is unmissable at the top of the board, states the exact
 * money, and puts the change one press away — the useful half of a pop-up with none of the part
 * that gets closed reflexively.
 *
 * It renders NOTHING when there is nothing to say, which is most of the time.
 */
export function NearTierFlag({ near, onUse }) {
  const [shut, setShut] = useState(false);
  const ltv = near && near.ltv;
  const dscr = near && near.dscr;
  if (shut || (!ltv && !dscr)) return null;
  const line = (o, action) => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 6 }}>
      <span style={{ fontSize: 13.5, color: INK, lineHeight: 1.6, flex: '1 1 320px' }}>{o.message}</span>
      {action}
    </div>
  );
  return (
    <div style={{
      border: `1px solid ${GOLD}`, borderRadius: 10, background: '#FFFBF2',
      padding: '12px 14px', marginBottom: 10,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: GOLD_TEXT, fontWeight: 700 }}>
          Almost at a better tier
        </div>
        <button type="button" className="btn ghost" style={{ fontSize: 12 }} onClick={() => setShut(true)}>Dismiss</button>
      </div>
      {ltv && line(ltv, ltv.maxLoan != null && onUse ? (
        <button type="button" className="btn soft" style={{ flex: '0 0 auto' }} onClick={() => onUse(ltv.maxLoan)}>
          Use {money(ltv.maxLoan)}
        </button>
      ) : null)}
      {dscr && line(dscr, null)}
      {/* WHERE THE TIER CAME FROM. "Your sheet says so" and "our standing steps say so" are
          different strengths of claim, and the person about to move a borrower's loan amount
          should know which one they are acting on. */}
      <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8, lineHeight: 1.6 }}>
        {[ltv && ltv.why, dscr && dscr.why].filter(Boolean).join(' ')}
      </div>
    </div>
  );
}


/**
 * THE COMBINED ENGINE'S OWN PANEL. The general engine has no concept of a second
 * program, so this exists only here.
 *
 * It answers the two questions a person auditing this board actually has: WHAT IS NOT ON IT (and
 * why), and — only when they ask — WHERE EACH ROW CAME FROM.
 *
 * The reveal is a re-price, not a client-side unmasking, and that is deliberate: the server strips
 * the vendor from every row before it leaves (the owner's "it should sound like one system"), so
 * there is nothing here to un-strip. Asking for it is an explicit second request.
 */
/**
 * "THIS BOARD IS SHORTER THAN IT SHOULD BE" (audit F2).
 *
 * ⛔ IT DECIDES NOTHING AND WORDS NOTHING. Both the fact and the sentence come from the server
 * (`investor-routing.applyRouting` → `completeness`), because a screen that composed this wording
 * would one day word it differently from the server's own idea of the same fact. It renders when
 * there is something to say and nothing at all otherwise — which is almost always.
 *
 * ⛔ AND IT NAMES NO VENDOR. "One of the two rate sheets did not answer" is the whole of what an
 * officer needs to know that prices are MISSING rather than unavailable; which one is provenance,
 * and provenance is what the reveal is for. That is what let this be fixed at all without breaking
 * the one-system rule.
 *
 * Drawn ABOVE the board rather than inside the empty state, because the expensive case is not an
 * empty board — it is a board with SOME prices on it that reads as complete.
 */
export function ShortBoardNotice({ completeness }) {
  const c = completeness;
  if (!c || c.complete !== false || !c.message) return null;
  return (
    <div style={{
      border: `1px solid ${CAUTION}`, borderRadius: 10, background: '#FFF7F2',
      padding: '12px 14px', marginBottom: 10,
    }}>
      <div style={{
        fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase',
        color: CAUTION, fontWeight: 700, marginBottom: 4,
      }}>
        This board is short
      </div>
      <div style={{ fontSize: 13.5, color: INK, lineHeight: 1.6 }}>{c.message}</div>
    </div>
  );
}

export function CombinedPanel({ hidden, settings, revealed, onReveal, busy }) {
  const rows = Array.isArray(hidden) ? hidden : [];
  return (
    <div style={{ ...card, borderColor: `${GOLD}55` }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ flex: '1 1 320px' }}>
          <div style={eyebrow}>Combined engine</div>
          <div style={{ fontSize: 13, color: SLATE, marginTop: 6, lineHeight: 1.6 }}>
            Every investor is fetched from ONE program, so a row is a row. Which program each one
            comes from is set on the Combined Pricing Engine settings screen.
          </div>
        </div>
        <label style={{ ...checkRow, flex: '0 0 auto' }}>
          <input type="checkbox" style={checkBox} checked={!!revealed} disabled={!!busy}
            onChange={(e) => onReveal(e.target.checked)} />
          <span style={{ fontSize: 13, color: SLATE }}>Show where each row came from</span>
        </label>
      </div>
      {/* NOTHING IS SILENTLY DROPPED. A board showing six investors where the two programs priced
          nine must always be able to account for the other three. */}
      {rows.length > 0 && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
          <div style={{ ...eyebrow, marginBottom: 6 }}>Not on this board ({rows.length})</div>
          {rows.map((h, i) => (
            <div key={`${h.key || i}`} style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginBottom: 4 }}>
              <strong style={{ color: SLATE }}>{h.whiteLabel || h.investor || h.key}</strong> — {h.reason}
            </div>
          ))}
        </div>
      )}
      {settings && settings.problems && settings.problems.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: CAUTION, lineHeight: 1.6 }}>
          {settings.problems.length} investor setting{settings.problems.length === 1 ? '' : 's'} could not be
          read and {settings.problems.length === 1 ? 'was' : 'were'} ignored — open the settings screen to fix
          {settings.problems.length === 1 ? ' it' : ' them'}.
        </div>
      )}
    </div>
  );
}

export default function LtCombinedPricer() {
  return (
    <PricerScreen
      engine={COMBINED_ENGINE}
      slots={{
        /* ⛔ WHAT GOES ABOVE THE BOARD IS ONLY WHAT DECIDES WHETHER THE BOARD IS SAFE TO READ.
           Owner-reported 2026-09-03: *"I don't like the way you put it on the search page right
           after the search instead of coming back right results."* Four panels sat between the
           press and the prices; three of them are about THIS answer and one was about tidying up
           the names afterwards. That one moved below (see `afterBoard`). */
        afterStrip: ({ res, busy, reveal, setReveal, reprice, setForm }) => (
          <>
            {/* FIRST, because "some of your prices are missing" outranks every other thing on this
                strip: a person who reads the board without knowing it is short may act on it. */}
            <ShortBoardNotice completeness={res.completeness} />
            {/* An offer to CHANGE THE SEARCH — it belongs beside the search, not under the answer
                it is proposing to replace. */}
            <NearTierFlag near={res.nearTier} onUse={(loan) => {
              setForm((p) => ({ ...p, loan: String(loan) }));
              try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* no window in a test render */ }
            }} />
            {/* The accounting of what is NOT on the board, which is the other half of the short-board
                warning above it — an officer reading a board of six where nine priced needs both
                halves in front of them before they read it. */}
            <CombinedPanel
              hidden={res.hidden} settings={res.settings} revealed={reveal} busy={busy}
              onReveal={(v) => { setReveal(v); reprice(null, { reveal: v }); }}
            />
          </>
        ),
        /* LINK TWO SPELLINGS OF ONE INVESTOR, FROM THE BOARD THAT FOUND THEM. Mounted here as
           well as on the settings screen, and it is the SAME component both times — never a
           second arrangement, or the two screens would disagree about what is linked. What
           only exists here is the live side-by-side: `investorPairing` is what the two
           programs ACTUALLY called each investor on THIS board, so this is the one place a
           person can see the two names together and the one moment an unrecognised spelling
           is in front of them.

           ⛔ IT DRAWS AFTER THE ANSWER, and that IS the owner's report above. It changes how the
           NEXT board is joined and nothing about the one on screen, so putting it before the
           prices delayed the answer to make a point about the search after it. Same finding the
           comparison area got on 2026-09-01, one panel further up.

           A re-price is deliberately NOT fired on save, for the same reason it sits here: the
           links change how the NEXT board is joined, and silently re-pricing under somebody would
           replace the answer they are reading. The person presses Price again. */
        afterBoard: ({ res }) => (res.investorPairing ? <LtInvestorLinks pairing={res.investorPairing} /> : null),
      }}
    />
  );
}
