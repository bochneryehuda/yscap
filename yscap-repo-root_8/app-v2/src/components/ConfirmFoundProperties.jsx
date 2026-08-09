import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage } from '../lib/dialog.js';

/**
 * "We found these — which are yours?" (blueprint §9.4, phase 8)
 *
 * Our team searched the public records and staged what came back. This asks the
 * borrower, ONE PROPERTY AT A TIME, and records yes / no.
 *
 * ═══ THE THING THIS SCREEN IS OPTIMISED AGAINST IS A FALSE "YES" ═══════════
 * Not completion rate. A borrower's "yes" both puts a property on a permanent
 * record AND improves their own pricing, so acquiescence bias and an economic
 * incentive point the same way — which is a worse combination than either alone.
 * Every layout decision below resolves against "yes", and several of them cost
 * completion on purpose:
 *
 *   · "NOT MINE" IS FIRST. Krosnick & Alwin's primacy effect says the first
 *     option in a visual list is over-chosen, so the first option is the one
 *     whose error is cheap. Getting a "no" wrong costs a property that our team
 *     can still see and put back (the staff queue shows who declined it);
 *     getting a "yes" wrong puts someone else's house on this person's record
 *     and prices a loan on it. This REVERSES the sketch in §9.4, deliberately.
 *   · BOTH ANSWERS NAME THE PROPERTY. "Yes — 62 Highland St" rather than a bare
 *     "Yes", so the answer is item-specific and cannot be given on autopilot;
 *     an agree/disagree pair is what acquiescence research measures the bias on.
 *   · "I'M NOT SURE" IS A QUIET LINK, NEVER A THIRD BUTTON. A third equal button
 *     invites satisficing — the easy way out of a question they could answer.
 *     It is a real state, and it is NOT the same as skipping: not-sure says
 *     "I looked and I cannot tell", skip says "later".
 *   · NO CONFIDENCE SCORE, EVER. A percentage would be saying something about
 *     county coverage and would read as something about the borrower.
 *
 * ═══ HONEST PROGRESS ══════════════════════════════════════════════════════
 * "3 of 8", never "3" — the denominator raises completion, and it comes from the
 * SERVER so it survives closing the tab. No endowed-progress trick (no free
 * first step): the count is what it is.
 *
 * ═══ WHAT A BORROWER NEVER SEES ═══════════════════════════════════════════
 * The vendor payload, our internal notes, our matching reasoning, who decided,
 * and above all NO CONTACT DETAIL — we do not skip trace, and showing a phone
 * number would imply we had. The server's projection is the guarantee; this
 * component simply has nothing else to render.
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const GOLD = '#AE8746';
const TEAL = '#2F7F86';

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
/** Calendar-string only — `new Date('YYYY-MM-DD')` shifts a day in some zones,
 *  and a date that reads a day early on a borrower's screen looks like an
 *  error in OUR records. */
const monthYear = (d) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
};

/** The story of the property in one plain sentence, or null when the records
 *  said too little to tell one. Never invents a verb: a property with only a
 *  purchase is "bought", not "bought and still held", which we cannot know. */
function story(p) {
  const bought = monthYear(p.purchaseDate);
  const sold = monthYear(p.saleDate);
  const bp = money(p.purchasePrice);
  const sp = money(p.salePrice);
  const bits = [];
  if (bought) bits.push(`Bought ${bought}${bp ? ` for ${bp}` : ''}`);
  if (sold) bits.push(`sold ${sold}${sp ? ` for ${sp}` : ''}`);
  if (!bits.length) return null;
  return bits.join(' · ');
}

export default function ConfirmFoundProperties({ onChanged }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lastAnswer, setLastAnswer] = useState(null);   // for Undo
  const [notSure, setNotSure] = useState({});           // id -> true, client-side
  const [skipped, setSkipped] = useState({});           // id -> true, client-side
  const [kind, setKind] = useState({});                 // id -> deal type they picked
  const [kindOverride, setKindOverride] = useState({}); // id -> they rejected our reading

  /* The deal type that will actually be sent. Their pick wins over ours, and
     rejecting our reading clears it so they must choose — never silently
     falling back to a label they just told us was wrong. */
  const effectiveKind = (p) => kind[p.id] || (kindOverride[p.id] ? null : p.dealType) || null;
  const headingRef = useRef(null);

  const load = useCallback(async () => {
    try { setState(await api.trackRecordCandidates()); }
    catch { setState({ ok: false, properties: [], total: 0, answered: 0 }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!state || state.nothingToConfirm || !state.properties || !state.properties.length) return null;

  const open = state.properties.filter((p) => !p.answered && !skipped[p.id] && !notSure[p.id]);
  const current = open[0] || null;
  const answered = state.answered || 0;

  /* Focus moves to the HEADING, never onto a button — landing focus on an
     action is how a screen reader user answers a question they have not been
     read yet, and how a fast keyboard user double-fires the previous answer. */
  async function answer(p, value) {
    if (busy) return;
    setBusy(true);
    try {
      await api.answerTrackRecordCandidate(p.id, {
        answer: value,
        // Only meaningful on a yes; the server refuses an import with no deal type.
        dealType: value === 'mine' ? effectiveKind(p) : undefined,
      });
      setLastAnswer({ id: p.id, address: p.address, value });
      await load();
      if (onChanged) onChanged();
      setTimeout(() => { try { headingRef.current && headingRef.current.focus(); } catch { /* gone */ } }, 0);
    } catch (e) {
      await showMessage((e && e.message) || 'That did not save. Please try again.', { title: 'Not saved' });
    } finally { setBusy(false); }
  }

  async function undo() {
    if (busy || !lastAnswer) return;
    setBusy(true);
    try {
      const out = await api.undoTrackRecordCandidate(lastAnswer.id);
      setLastAnswer(null);
      await load();
      if (onChanged) onChanged();
      /* A line our team has already worked is KEPT — saying so is the honest
         thing, because "undone" would be a lie the borrower could not check. */
      if (out && out.lineKept) {
        await showMessage(
          'We have taken your answer back. Our team had already started working on that property, so it stays on your record — they will sort it out with you.',
          { title: 'Answer taken back' });
      }
    } catch (e) {
      await showMessage((e && e.message) || 'That did not work. Please try again.', { title: 'Not changed' });
    } finally { setBusy(false); }
  }

  const done = !current;
  const pct = state.total ? Math.round((answered / state.total) * 100) : 0;

  return (
    <section className="card" style={{ borderTop: `3px solid ${GOLD}` }}>
      <h3 tabIndex={-1} ref={headingRef} style={{ margin: '0 0 4px', color: INK, outline: 'none' }}>
        {done ? 'Thank you — that is all of them' : 'We found these properties. Which are yours?'}
      </h3>
      <p style={{ margin: '0 0 14px', color: MUTED, fontSize: 15, lineHeight: 1.5 }}>
        {done
          ? 'Our team will check the ones you said are yours and add them to your track record.'
          : 'These came from public county records, so some may belong to somebody with a similar name or company. Only say yes to the ones you really owned.'}
      </p>

      {/* Progress. "3 of 8", never "3" — and the denominator is the server's. */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: MUTED, marginBottom: 5 }}>
          <span>{answered} of {state.total} answered</span>
          {state.remaining > 0 ? <span>{state.remaining} to go</span> : null}
        </div>
        <div style={{ height: 6, borderRadius: 3, background: '#EAE4D7', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: TEAL, transition: 'width .2s' }} />
        </div>
      </div>

      {/* UNDO SITS ABOVE THE CARD IN DOM ORDER so a screen reader meets it
          before the next question — an undo announced after the following
          question has already been read is not an undo anyone can find. */}
      {lastAnswer ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '9px 12px', marginBottom: 14, borderRadius: 8,
          background: '#F4F1EA', border: '1px solid #EAE4D7', fontSize: 14, color: INK,
        }}>
          <span>
            You said <strong>{lastAnswer.value === 'mine' ? 'yes' : 'not mine'}</strong> to {lastAnswer.address}.
          </span>
          <button type="button" className="btn ghost" onClick={undo} disabled={busy} style={{ marginLeft: 'auto' }}>
            Undo that
          </button>
        </div>
      ) : null}

      {current ? (
        <div style={{
          border: '1px solid #EAE4D7', borderRadius: 12, padding: 16, background: '#fff',
        }}>
          <div style={{ fontSize: 19, fontWeight: 650, color: INK, lineHeight: 1.35 }}>
            {current.address}
          </div>
          {story(current) ? (
            <div style={{ marginTop: 6, color: MUTED, fontSize: 15 }}>{story(current)}</div>
          ) : (
            <div style={{ marginTop: 6, color: MUTED, fontSize: 15 }}>
              The records did not say when it was bought or sold.
            </div>
          )}
          {current.entityName ? (
            <div style={{ marginTop: 6, color: MUTED, fontSize: 15 }}>
              Under the name <strong style={{ color: INK }}>{current.entityName}</strong>
            </div>
          ) : null}
          {current.alreadyOnRecord ? (
            <div style={{ marginTop: 10, fontSize: 14, color: INK, background: '#F4F1EA', padding: '7px 10px', borderRadius: 7 }}>
              This one already looks like a property on your track record. Saying yes just confirms it — nothing you typed will change.
            </div>
          ) : null}

          {/* THE DEAL TYPE IS STATED, NOT ASKED, when the records answer it.
              Asking a borrower to classify their own deal invites them to pick
              the label that prices best; the two deeds already said it. When the
              records do NOT say, the question appears instead — a line with no
              deal type counts toward NOTHING and is filed under holds, so this
              can never be left blank. */}
          {current.dealTypeDerived && !kindOverride[current.id] ? (
            <div style={{ marginTop: 12, fontSize: 14, color: MUTED }}>
              We&rsquo;ll record this as a <strong style={{ color: INK }}>flip</strong> — bought and then sold.{' '}
              <button
                type="button" disabled={busy}
                onClick={() => setKindOverride((s) => ({ ...s, [current.id]: true }))}
                style={{ background: 'none', border: 0, padding: 0, color: TEAL, fontSize: 14, cursor: 'pointer' }}
              >
                That&rsquo;s not right
              </button>
            </div>
          ) : null}
          {(!current.dealType || kindOverride[current.id]) ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 14, color: INK, marginBottom: 7 }}>What did you do with this one?</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[['flip', 'Fixed it up and sold it'],
                  ['hold', 'Kept it and rented it out'],
                  ['ground-up', 'Built it from the ground up']].map(([v, label]) => (
                    <button
                      key={v} type="button" disabled={busy}
                      onClick={() => setKind((s) => ({ ...s, [current.id]: v }))}
                      className={kind[current.id] === v ? 'btn primary' : 'btn ghost'}
                      style={{ minHeight: 44, fontSize: 15, color: kind[current.id] === v ? undefined : INK }}
                    >{label}</button>
                  ))}
              </div>
            </div>
          ) : null}

          {/* "NOT MINE" FIRST. The first option is over-chosen, so it is the one
              whose error is cheap and reversible. Both name the property, so
              neither can be given on autopilot. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            <button
              type="button" className="btn ghost" disabled={busy}
              onClick={() => answer(current, 'not_mine')}
              style={{ minHeight: 48, fontSize: 16, justifyContent: 'flex-start', textAlign: 'left', color: INK }}
            >
              Not mine — I never owned {current.address}
            </button>
            <button
              type="button" className="btn primary" disabled={busy || !effectiveKind(current)}
              onClick={() => answer(current, 'mine')}
              style={{ minHeight: 48, fontSize: 16, justifyContent: 'flex-start', textAlign: 'left' }}
            >
              Yes, I owned {current.address}
            </button>
            {!effectiveKind(current) ? (
              <div style={{ fontSize: 13, color: MUTED }}>
                Pick what you did with it above, then say yes — otherwise it would not count toward your experience.
              </div>
            ) : null}
          </div>

          {/* Two DIFFERENT states, deliberately not merged: "I looked and I
              cannot tell" is a question for our team; "later" is not. Both are
              quiet links, never buttons competing with the real answer. */}
          <div style={{ display: 'flex', gap: 18, marginTop: 14, flexWrap: 'wrap' }}>
            <button
              type="button" className="linklike" disabled={busy}
              onClick={() => setNotSure((s) => ({ ...s, [current.id]: true }))}
              style={{ background: 'none', border: 0, padding: 0, color: TEAL, fontSize: 14, cursor: 'pointer' }}
            >
              I&rsquo;m not sure
            </button>
            <button
              type="button" className="linklike" disabled={busy}
              onClick={() => setSkipped((s) => ({ ...s, [current.id]: true }))}
              style={{ background: 'none', border: 0, padding: 0, color: MUTED, fontSize: 14, cursor: 'pointer' }}
            >
              Skip for now
            </button>
          </div>
        </div>
      ) : null}

      {Object.keys(notSure).length ? (
        <p style={{ marginTop: 14, marginBottom: 0, color: MUTED, fontSize: 14 }}>
          {/* HONEST WORDING — "not sure" is not sent anywhere (audit 2026-08-09
              #12: the server has no such state, and the old copy promised "our
              team will look into it" about a note that died on reload). Say
              what is true: the question simply stays open. */}
          You marked {Object.keys(notSure).length}{' '}
          {Object.keys(notSure).length === 1 ? 'property' : 'properties'} as not sure — no problem.
          {Object.keys(notSure).length === 1 ? ' It' : ' They'} will still be here to answer
          whenever you are ready, and your loan team can help you work
          {Object.keys(notSure).length === 1 ? ' it' : ' them'} out.
        </p>
      ) : null}
      {Object.keys(skipped).length && done ? (
        <p style={{ marginTop: 10, marginBottom: 0, color: MUTED, fontSize: 14 }}>
          You skipped {Object.keys(skipped).length}. They will still be here next time.
        </p>
      ) : null}
    </section>
  );
}
