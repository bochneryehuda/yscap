/**
 * WHAT THE SERVER SAYS ABOUT THIS BOARD — the three panels that explain an answer, drawn by the
 * ONE shared pricing screen so BOTH engines say the same things in the same words.
 *
 * ⛔ WHY THESE LIVE HERE RATHER THAN IN A SLOT. `LtPricer.jsx`'s own rule is that `slots` are for
 * "the panels only ONE board has", and until 2026-09-03 these were exactly that: the general
 * board's route computed `hidden` / `completeness` / `settings` / `nearTier` inside `applyRouting`
 * and threw every one of them away, so only the combined board had anything to draw. Now that the
 * general route returns them too, a slot would be the SECOND copy of one arrangement — and the
 * copy that drifts is the one an officer reads while auditing a short board.
 *
 * ⛔ NOT ONE OF THEM DECIDES ANYTHING. The fact AND the sentence come from the server every time
 * (`pricing/investor-routing.applyRouting` → `hidden`/`completeness`/`settings`,
 * `pricing/near-tier.js` → `nearTier`). A screen that composed this wording would one day word it
 * differently from the server's own idea of the same fact, and a screen that worked out its own
 * tier would eventually tell somebody to cut a borrower's loan for a tier the sheet does not have.
 *
 * ⛔ AND NOT ONE OF THEM NAMES A VENDOR. "One of the two rate sheets did not answer" is the whole
 * of what an officer needs in order to know that prices are MISSING rather than unavailable;
 * WHICH one is provenance, and provenance is what the combined engine's reveal is for. That is
 * what lets these be said on a one-system board at all — and it is why the general engine, which
 * has no reveal, can mount every one of them unchanged.
 *
 * Each renders NOTHING when there is nothing to say, which is most of the time.
 */
import React, { useState } from 'react';
import { money } from './format.js';
import { GOLD, GOLD_TEXT, INK, SLATE, MUTED, CAUTION, LINE, eyebrow } from './ppeStyles.js';

/**
 * "THIS BOARD IS SHORTER THAN IT SHOULD BE" (audit F2).
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

/**
 * "YOU ARE ALMOST AT A BETTER TIER" (owner-directed 2026-08-30: *"You can make a nice flag that
 * you're almost at the edge… If it's almost at a tier, make a pop-up"*).
 *
 * ⛔ IT IS A FLAG, NOT A MODAL. The owner asked for a pop-up; a dialog that interrupts every priced
 * board is one people learn to dismiss without reading, and it would sit between an officer and the
 * prices they just paid for. This is unmissable at the top of the board, states the exact money,
 * and puts the change one press away — the useful half of a pop-up with none of the part that gets
 * closed reflexively.
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
 * NOTHING IS SILENTLY DROPPED — the accounting of every investor the router took OFF this board,
 * each with the reason it gave (switched off in settings / the sheet did not answer / the sheet
 * had no quote), and a note when a setting could not be read at all.
 *
 * ⛔ THIS IS THE OTHER HALF OF THE SHORT-BOARD WARNING ABOVE IT. A board showing six investors
 * where the sheets priced nine must always be able to account for the other three, and an officer
 * reading that board needs both halves in front of them before they read it.
 *
 * ⛔ IT PRINTS OUR OWN NAME FOR AN INVESTOR, never the vendor's spelling — `whiteLabel` first, and
 * the raw name only where nobody has white-labelled it yet. The investor name never reaches a
 * client from any surface, and this one is staff-only besides.
 */
export function NotOnThisBoard({ hidden, settings }) {
  const rows = Array.isArray(hidden) ? hidden : [];
  const problems = (settings && Array.isArray(settings.problems)) ? settings.problems : [];
  if (rows.length === 0 && problems.length === 0) return null;
  return (
    <div style={{
      border: `1px solid ${LINE}`, borderRadius: 10, background: '#FFFFFF',
      padding: '12px 14px', marginBottom: 10,
    }}>
      {rows.length > 0 && (
        <>
          <div style={{ ...eyebrow, marginBottom: 6 }}>Not on this board ({rows.length})</div>
          {rows.map((h, i) => (
            <div key={`${h.key || i}`} style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginBottom: 4 }}>
              <strong style={{ color: SLATE }}>{h.whiteLabel || h.investor || h.key}</strong> — {h.reason}
            </div>
          ))}
        </>
      )}
      {problems.length > 0 && (
        <div style={{ marginTop: rows.length > 0 ? 10 : 0, fontSize: 12, color: CAUTION, lineHeight: 1.6 }}>
          {problems.length} investor setting{problems.length === 1 ? '' : 's'} could not be
          read and {problems.length === 1 ? 'was' : 'were'} ignored — open the settings screen to fix
          {problems.length === 1 ? ' it' : ' them'}.
        </div>
      )}
    </div>
  );
}

/**
 * THE THREE, IN THE ONE ORDER THAT SURVIVES SOMEBODY READING ONLY THE FIRST.
 *
 * 1 "some of your prices are missing" — it outranks everything else here, because a person who
 *   reads a short board without knowing it is short may act on it.
 * 2 the offer to CHANGE THE SEARCH — beside the search, not under the answer it would replace.
 * 3 the accounting of what is not on the board — the other half of (1).
 *
 * `onUseLoan` is optional: without it the tier flag still states the money and simply offers no
 * button, which is what it already does for a DSCR tier (there is no loan amount that reaches one).
 */
export default function BoardExplains({ res, onUseLoan }) {
  const r = res || {};
  return (
    <>
      <ShortBoardNotice completeness={r.completeness} />
      <NearTierFlag near={r.nearTier} onUse={onUseLoan} />
      <NotOnThisBoard hidden={r.hidden} settings={r.settings} />
    </>
  );
}
