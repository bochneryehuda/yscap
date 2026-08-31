import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ltApi } from './api.js';
// ONE way to write a value down, shared with every other long-term screen. Writing
// a `money` or a `day` here would be a second copy, and the two drift: the file
// screen's `day` carries a calendar-day guard the pipeline's copy had lost, so a
// DATE column printed the day BEFORE in every US timezone until they were merged.
import { money, day } from './format.js';
import BorrowerLtConditions from './BorrowerLtConditions.jsx';

/**
 * THE CLIENT'S OWN LONG-TERM SIDE — and the switch back.
 *
 * Owner-directed: *"The borrower should also have, in their login, the option to
 * switch from long-term to short-term."*
 *
 * IT IS A SEPARATE PAGE, NOT A PANEL ON THE SHORT-TERM ONE, and that is the
 * separation charter deciding the shape rather than a preference. The authorization
 * ledger allows exactly two RTL files to reference long-term code — `App.jsx` to
 * MOUNT it and `StaffLayout.jsx` to render the staff switch — and says in as many
 * words that *"no RTL screen may import an LT component for its own use"*. So the
 * borrower's dashboard does not import this; the router mounts it at its own route,
 * the same way it mounts the six staff long-term screens. It also happens to match
 * the staff switch, which has always MOVED you between two sides rather than
 * folding one into the other.
 *
 * IT IS HONEST ABOUT ALL THREE EMPTY STATES, because they need three different
 * things from the reader and look identical if you conflate them:
 *   · the owner has not switched the borrower-facing side on,
 *   · they have no long-term loans,
 *   · nobody has confirmed which of their loans are theirs yet — which is the same
 *     screen as "none", deliberately: a client must never be told about our own
 *     internal mapping work.
 * A page that said "something went wrong" for any of these would send a client to
 * their loan officer for nothing.
 *
 * A CLIENT SEES ONLY WHAT A HUMAN CONFIRMED IS THEIRS. The list is keyed on the
 * borrower link an administrator confirmed; an unmatched loan belongs to nobody and
 * reaches nobody. An empty answer is the SAFE state, not a bug.
 *
 * THE STATUS IS THE SERVER'S WORDING, printed verbatim — already the wording
 * written for a client, already scrubbed of anything they may not see. Re-labelling
 * it here would be a second definition of one status, and the copy that drifts is
 * the one that leaks.
 *
 * Colours are explicit darks per the HARD RULE — every `--ink*` token in this
 * palette is a LIGHT paper colour and would render white-on-white.
 */

/** Ask the server what this client's long-term side holds. Never throws at a client. */
export function useLongTermSide() {
  const [state, setState] = useState({ ready: false, enabled: false, loans: [] });

  useEffect(() => {
    let alive = true;
    ltApi.myLoans()
      .then((d) => {
        if (!alive) return;
        setState({
          ready: true,
          enabled: !!(d && d.enabled),
          loans: (d && Array.isArray(d.loans)) ? d.loans : [],
        });
      })
      // A side build that is not live must never put an error in front of a client
      // checking their own loan. "Off" is the safe reading of a failure here.
      .catch(() => { if (alive) setState({ ready: true, enabled: false, loans: [] }); });
    return () => { alive = false; };
  }, []);

  return state;
}

/** The switch. `side` is which one you are ON; the other one navigates. */
export function BorrowerProductSwitch({ side = 'long' }) {
  const nav = useNavigate();

  const base = {
    border: 'none', background: 'transparent', cursor: 'pointer',
    padding: '6px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600,
    color: '#4B585C', lineHeight: 1.2, whiteSpace: 'nowrap',
  };
  const on = { ...base, background: '#FFFFFF', color: '#141B22', boxShadow: '0 1px 2px rgba(20,27,34,.14)' };

  return (
    <div role="group" aria-label="Which loans to show" style={{
      display: 'inline-flex', alignItems: 'center', gap: 2, padding: 3,
      background: '#EAE4D7', borderRadius: 999, border: '1px solid rgba(174,135,70,.35)',
    }}>
      <button type="button" style={side === 'long' ? base : on} aria-pressed={side !== 'long'}
        title="Your bridge, ground-up and fix &amp; flip loans"
        onClick={() => nav('/dashboard')}>Short-term</button>
      <button type="button" style={side === 'long' ? on : base} aria-pressed={side === 'long'}
        title="Your long-term loans"
        onClick={() => nav('/long-term')}>Long-term</button>
    </div>
  );
}

/**
 * The switch as the BORROWER'S HOME SCREEN mounts it (owner-directed 2026-08-17:
 * "put the switch on the borrower's home screen"; recorded in
 * docs/LONG-TERM-AUTHORIZED-COPIES.md as the third — and narrowest — RTL file
 * allowed to reference long-term code).
 *
 * IT DECIDES FOR ITSELF, AND THAT IS THE WHOLE POINT OF ITS EXISTING. The
 * dashboard could have called `useLongTermSide()` and written the test itself,
 * and then the rule "when does a client have a long-term side?" would live in
 * an RTL screen — a second definition, in the product that may not hold one.
 * So the RTL screen imports ONE component and renders it; everything below is
 * on this side of the wall and can change without touching RTL at all.
 *
 * IT RENDERS NOTHING unless the client genuinely has somewhere to go: the side
 * must be switched ON and they must have at least one CONFIRMED long-term loan
 * (`lt_loans.borrower_id`, which only a human's confirmation ever writes). A
 * switch offered to a borrower with no long-term loans is a door onto an empty
 * room, and on the home screen — the one page every client sees — that reads as
 * a fault in their file rather than as a product they are not on.
 *
 * It FAILS QUIET, deliberately: `useLongTermSide` answers "off" on any error, so
 * an unreachable long-term side leaves the borrower's own home screen exactly as
 * it was rather than putting our plumbing in front of a client.
 */
export function BorrowerLongTermSwitch() {
  const { ready, enabled, loans } = useLongTermSide();
  if (!ready || !enabled || !loans.length) return null;
  return <BorrowerProductSwitch side="short" />;
}

/** The list itself. */
export function BorrowerLongTermLoans({ loans, onOpen }) {
  const list = Array.isArray(loans) ? loans : [];
  return (
    <div id="loans">
      <div className="grid cols-2">
        {list.map((l) => (
          <div className="panel" key={l.id} style={{ marginBottom: 0 }}>
            <div style={{ fontWeight: 700, color: '#141B22' }}>{l.file}</div>
            {l.programName && (
              <div style={{ color: '#4B585C', fontSize: 13, marginTop: 2 }}>{l.programName}</div>
            )}
            <div style={{
              display: 'inline-block', marginTop: 10, padding: '3px 10px', borderRadius: 999,
              background: '#F4F1EA', border: '1px solid rgba(174,135,70,.28)',
              color: '#141B22', fontSize: 13, fontWeight: 600,
            }}>
              {/* Nothing invented: with no wording written for a client the server
                  sends none, and this says something neutral rather than guessing. */}
              {l.status || 'In progress'}
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
              <div>
                <div style={{ color: '#4B585C' }}>Loan amount</div>
                <div style={{ color: '#141B22', fontWeight: 600 }}>{money(l.loanAmount)}</div>
              </div>
              <div>
                <div style={{ color: '#4B585C' }}>Term</div>
                <div style={{ color: '#141B22', fontWeight: 600 }}>
                  {l.termMonths == null ? '—' : `${l.termMonths} months`}
                </div>
              </div>
            </div>
            {l.updatedAt && (
              <div style={{ color: '#4B585C', fontSize: 12, marginTop: 10 }}>
                Updated {day(l.updatedAt)}
              </div>
            )}
            {/* THE WAY IN. Until this button existed the card was the whole
                screen: a borrower could read a loan amount and had no way to
                learn what we were waiting on, or to send it. Rendered only when
                a handler is passed, so this component stays usable anywhere. */}
            {onOpen && (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn" onClick={() => onOpen(l.id)}>
                  What we still need
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The whole page, which is what the router mounts. */
export default function BorrowerLongTermScreen() {
  const { ready, enabled, loans } = useLongTermSide();
  const [openLoan, setOpenLoan] = useState(null);

  /* ONE LOAN AT A TIME. The conditions screen replaces the list rather than
     opening beside it: on a phone a list of loans above a list of conditions is
     two things to scroll past before reaching the button that matters. */
  if (openLoan) {
    return <BorrowerLtConditions loanId={openLoan} onClose={() => setOpenLoan(null)} />;
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1>Your long-term loans</h1>
          <p className="muted small">Where each one is up to.</p>
        </div>
        <div className="spacer" />
        <BorrowerProductSwitch side="long" />
      </div>

      {!ready && <div className="panel muted">Loading…</div>}

      {ready && !enabled && (
        <div className="panel">
          <h3 style={{ marginTop: 0, color: '#141B22' }}>Not available yet</h3>
          <p style={{ color: '#4B585C', margin: 0, lineHeight: 1.55 }}>
            The long-term side of your login is not switched on yet. Your loans are on
            the short-term side — use the switch above.
          </p>
        </div>
      )}

      {ready && enabled && !loans.length && (
        <div className="panel">
          <h3 style={{ marginTop: 0, color: '#141B22' }}>No long-term loans yet</h3>
          <p style={{ color: '#4B585C', margin: 0, lineHeight: 1.55 }}>
            When you have a long-term loan with us it will appear here. Your other
            files are on the short-term side — use the switch above.
          </p>
        </div>
      )}

      {ready && enabled && loans.length > 0 && (
        <BorrowerLongTermLoans loans={loans} onOpen={setOpenLoan} />
      )}
    </>
  );
}
