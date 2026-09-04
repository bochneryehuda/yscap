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
 * OUR OWN RULES — what the Pricing Rule Center refused, blocked and adjusted.
 *
 * Owner-directed 2026-09-04: *"even if the engine is giving it to you it should be our own
 * ineligible … come up an ineligible section and it should say the ineligible reason is our own
 * overlay"*, and *"anytime we select that to come up ineligible the message should give why it's
 * ineligible."*
 *
 * ⛔ ITS OWN SECTION, BESIDE "Not on this board" AND NEVER INSIDE IT. That panel answers why a
 * RATE SHEET has no row here — switched off, the sheet did not answer, the sheet had no quote.
 * This answers why WE do not, which is a different question with a different remedy: one is a
 * settings screen or a vendor, the other is a rule somebody in this company wrote down. Folding
 * them together would tell an officer LoanNEX did not carry an investor we refused ourselves.
 *
 * ⛔ IT NAMES THE RULE AND PRINTS ITS REASON VERBATIM. The reason is what the person who wrote the
 * rule typed, and it is the whole point of the action — a refusal with no reason is a dead end for
 * whoever has to explain it to a borrower.
 *
 * ⛔ IT NEVER NAMES A VENDOR OR AN INVESTOR'S REAL NAME. The server sends the client-safe name; a
 * row nobody has white-labelled yet simply says the program.
 *
 * Renders nothing when the centre is empty, which is every board until somebody writes a rule.
 */
export function OurOwnRules({ houseRules }) {
  const h = houseRules || {};
  const refused = Array.isArray(h.ineligible) ? h.ineligible : [];
  const blocked = Array.isArray(h.blocked) ? h.blocked : [];
  /* WHICH RULES MOVED A PRICE, ASKED OF THE FACTS RATHER THAN OF THE SENTENCE.
     This tested `did` for the word "point", so a rule that refuses a loan AND
     holds back margin — legal, since only two STOPS are forbidden — was listed
     as having priced a row it had just taken off the board. A stopping rule is
     never an adjustment, however its summary happens to read. */
  const adjusted = Array.isArray(h.applied) ? h.applied.filter((a) => a && a.points && !a.stops) : [];
  const problems = Array.isArray(h.problems) ? h.problems : [];
  if (!refused.length && !blocked.length && !adjusted.length && !problems.length && !h.problem) return null;

  const line = (name, program, rule, reason, key) => (
    <div key={key} style={{ fontSize: 12, color: MUTED, lineHeight: 1.6, marginBottom: 4 }}>
      <strong style={{ color: SLATE }}>{name || program || 'A quote'}</strong>
      {program && name ? ` · ${program}` : ''} — {reason || 'no reason was written on the rule'}
      <span style={{ color: GOLD_TEXT }}>{rule ? ` (our rule: ${rule})` : ''}</span>
    </div>
  );

  return (
    <div style={{
      border: `1px solid ${GOLD}55`, borderRadius: 10, background: '#FFFDF8',
      padding: '12px 14px', marginBottom: 10,
    }}>
      <div style={{ ...eyebrow, color: GOLD_TEXT, marginBottom: 6 }}>Ineligible under our own rules</div>

      {blocked.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: SLATE, fontWeight: 700, marginBottom: 4 }}>
            {blocked.length} investor{blocked.length === 1 ? '' : 's'} we do not place on this loan
          </div>
          {blocked.map((b, i) => line(b.name, b.program, b.rule, b.reason, `b${i}`))}
        </>
      )}

      {refused.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: SLATE, fontWeight: 700, margin: `${blocked.length ? 10 : 0}px 0 4px` }}>
            {refused.length} quote{refused.length === 1 ? '' : 's'} we refuse, whatever the rate sheet says
          </div>
          {refused.map((r, i) => line(r.name, r.program, r.rule, r.reason, `r${i}`))}
        </>
      )}

      {adjusted.length > 0 && (
        <div style={{ marginTop: (blocked.length || refused.length) ? 10 : 0, fontSize: 12, color: SLATE, lineHeight: 1.6 }}>
          <strong>Priced with our own adjustment:</strong>{' '}
          {adjusted.map((a) => `${a.name} (${a.did})`).join('; ')}
        </div>
      )}

      {/* A RULE THAT COULD NOT BE READ IS NEVER SILENT — it fired on nothing, and
          the person who wrote it is the only one who can fix it. */}
      {problems.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: CAUTION, lineHeight: 1.6 }}>
          {problems.map((p, i) => (
            <div key={`p${i}`}>{p.name ? `“${p.name}”` : 'One rule'} — {p.problem}</div>
          ))}
        </div>
      )}
      {h.problem && (
        <div style={{ marginTop: 10, fontSize: 12, color: CAUTION, lineHeight: 1.6 }}>
          The rule centre could not be read, so this board carries none of our own rules.
        </div>
      )}
    </div>
  );
}

/**
 * THE FOUR, IN THE ONE ORDER THAT SURVIVES SOMEBODY READING ONLY THE FIRST.
 *
 * 1 "some of your prices are missing" — it outranks everything else here, because a person who
 *   reads a short board without knowing it is short may act on it.
 * 2 the offer to CHANGE THE SEARCH — beside the search, not under the answer it would replace.
 * 3 what OUR OWN rules refused — a decision somebody here made, and can explain.
 * 4 the accounting of what the rate sheets do not have — the other half of (1).
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
      {/* OUR OWN RULES BEFORE THE RATE SHEETS' — a quote WE refused is a decision
          somebody here made and can explain, and it outranks "the sheet had no
          quote", which is somebody else's. */}
      <OurOwnRules houseRules={r.houseRules} />
      <NotOnThisBoard hidden={r.hidden} settings={r.settings} />
    </>
  );
}
