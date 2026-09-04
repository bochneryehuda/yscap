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
import React from 'react';
import LtInvestorLinks from './LtInvestorLinks.jsx';
import { PricerScreen } from './LtPricer.jsx';
import { COMBINED_ENGINE } from './pricerEngine.js';
import { GOLD, SLATE, card, eyebrow, checkRow, checkBox } from './ppeStyles.js';

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
 * THE COMBINED ENGINE'S OWN CARD — what this board IS, and the one control the general board has
 * no concept of.
 *
 * ⛔ WHAT USED TO BE HERE AND IS NOT ANY MORE: the accounting of who is not on the board, and the
 * unreadable-settings note. Both moved to the shared `BoardExplains` the moment the general route
 * started returning `hidden` and `settings` too (2026-09-03) — see that file's header. A panel
 * both boards have, drawn from a copy each, is two screens disagreeing about one short board.
 *
 * The reveal is a re-price, not a client-side unmasking, and that is deliberate: the server strips
 * the vendor from every row before it leaves (the owner's "it should sound like one system"), so
 * there is nothing here to un-strip. Asking for it is an explicit second request.
 */
export function CombinedPanel({ revealed, onReveal, busy }) {
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
        afterStrip: ({ busy, reveal, setReveal, reprice }) => (
          /* ⛔ WHAT IS LEFT IN THIS SLOT IS ONLY WHAT THE GENERAL BOARD HAS NO CONCEPT OF. The
             short-board notice, the near-tier flag and the accounting of who is not on the board
             all draw ABOVE this, from the shared screen, on BOTH engines — the ordering the owner
             asked for is unchanged and is now enforced in one place instead of two. */
          <CombinedPanel
            revealed={reveal} busy={busy}
            onReveal={(v) => { setReveal(v); reprice(null, { reveal: v }); }}
          />
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
