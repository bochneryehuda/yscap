import React, { useCallback, useEffect, useState } from 'react';
import { showMessage, askPrompt } from '../../lib/dialog.js';
import { subscribeChat } from '../../lib/chatEvents.js';
import { arena, money, countdown, serverNow } from '../../lib/arena.js';
import ArenaAiHelp from './ArenaAiHelp.jsx';

/* THE CHALLENGES — the things that land on everybody's screen through the day.
 *
 * IT SHOWS NOTHING WHEN NOTHING IS LIVE. That is the whole restraint of this
 * component: it mounts on every Arena screen and stays completely out of the
 * way until a challenge is actually open. A game that is always shouting is a
 * game people close.
 *
 * A NEW ONE ARRIVES AS A CARD, NOT A MODAL. A modal in the middle of a phone
 * call is exactly the interruption that makes people resent the whole thing —
 * and the people this is for are on the phone all afternoon. So it slides in at
 * the corner, sits there for its whole window, and waits. The countdown does
 * the persuading, not a box over the top of their work.
 *
 * WHAT SOMEBODY SEES WHEN THEY ARE TOO LATE is the owner's own sentence:
 * "somebody won this one already." Said plainly, with who took it, rather than
 * a greyed-out button that leaves them guessing.
 */
export default function ArenaChallenges({ sessionId, isSuper, onChanged }) {
  const [board, setBoard] = useState(null);
  const [openFor, setOpenFor] = useState(null);
  const [now, setNow] = useState(serverNow());
  const [minimised, setMinimised] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try { setBoard(await arena.challenges(sessionId)); }
    catch { /* the wheel matters more */ }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);
  // A NEW CHALLENGE TAKES THE WHOLE SCREEN, once, for a few seconds.
  // The owner asked for "a huge challenge to count down before it" — so the
  // arrival is loud: the room counts 3, 2, 1 together and the challenge lands.
  // Then it settles into the corner card and stays quiet for the rest of its
  // window. Loud once, quiet after: that is what keeps it exciting rather than
  // exhausting for people who are on the phone all afternoon.
  const [dropping, setDropping] = useState(null);
  const [count, setCount] = useState(0);
  // How long the room counts down is a SETTING (the owner asked for ten or
  // twenty seconds), read from the board rather than hard-coded. Zero means no
  // count-in at all -- the challenge simply appears.
  // THE GUARD LIVES ON THE CONDITION, NOT INSIDE Number() (owner-reported
  // 2026-08-19: pressing Go live crashed the whole Arena page, permanently).
  // Number(null) is 0 and 0 >= 0 is true, so the old test passed on the very
  // first render — before this component's own fetch had resolved — and the
  // consequent then read board.countdownSeconds off null and threw, which the
  // page ErrorBoundary turned into the full-screen "Something went wrong" on
  // every open of a live session. The board must be IN HAND before its value
  // is trusted.
  const countFrom = Math.max(0, Math.min(60,
    board && Number(board.countdownSeconds) >= 0 ? Number(board.countdownSeconds) : 10));
  useEffect(() => subscribeChat((event, data) => {
    if (event === 'arena:challenge-open' && data && data.id) {
      setDropping(data);
      setCount(countFrom);
    }
    if (event.startsWith('arena:challenge') || event === 'arena:tickets' || event === 'reconnect') load();
  }), [load]);

  // The count-in. Ticks 3 → 2 → 1 → gone, then the card takes over.
  useEffect(() => {
    if (!dropping) return undefined;
    // At zero the challenge itself is shown for a few seconds, then the whole
    // thing leaves by itself. Nobody has to dismiss it, and it never sits over
    // somebody's work.
    if (count <= 0) { const t = setTimeout(() => setDropping(null), 5000); return () => clearTimeout(t); }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [dropping, count]);

  if (!board) return null;
  const live = board.live || [];
  const me = board.me || {};

  const streak = me.streak || null;

  // Nothing live, and nothing earned yet — say nothing at all.
  if (!live.length && !me.tickets) return null;

  return (
    <>
      {dropping && <ChallengeDrop challenge={dropping} count={count} from={countFrom} />}
      <aside className={`arena-challenges${minimised ? ' min' : ''}`} aria-label="Challenges">
        <header className="arena-ch-head">
          <div>
            <strong>{live.length ? `${live.length} live now` : 'Nothing running'}</strong>
            {me.tickets > 0 && (
              <span className="arena-ch-tickets">
                {me.tickets} {me.tickets === 1 ? 'chance' : 'chances'}
                {me.left > 0 && <em> · {me.left} prize{me.left === 1 ? '' : 's'} to name</em>}
              </span>
            )}
          </div>
          <button className="arena-ch-min" onClick={() => setMinimised(!minimised)}
            aria-label={minimised ? 'Show the challenges' : 'Tuck the challenges away'}>
            {minimised ? '▲' : '▾'}
          </button>
        </header>

        {/* THE STREAK. Shown only when they are actually ON one — a counter
            reading "0 in a row" is a scoreboard for doing nothing, and the whole
            point of a streak is that it exists to be protected. The nudge is the
            server's own words, so the screen cannot invent a target. */}
        {streak && streak.run > 0 && (
          <div className={`arena-ch-streak${streak.nudge ? ' close' : ''}`}>
            <span className="arena-ch-flame" aria-hidden="true">▲</span>
            <strong>{streak.run} in a row</strong>
            {streak.nudge && <em>{streak.nudge}</em>}
            {streak.bonusTickets > 0 && (
              <span className="arena-ch-bonus">
                +{streak.bonusTickets} bonus {streak.bonusTickets === 1 ? 'chance' : 'chances'} so far
              </span>
            )}
          </div>
        )}

        {!minimised && (
          <>
            {live.map((c) => {
              const left = c.closesAt ? Date.parse(c.closesAt) - now : null;
              const done = c.mine;
              return (
                <article key={c.id} className={`arena-ch${c.goneMessage && !done ? ' gone' : ''}`}>
                  <div className="arena-ch-top">
                    <span className={`arena-ch-tier t${c.tier}`}>{c.tierLabel}</span>
                    <strong>{c.title}</strong>
                    {left != null && left > 0 && <time className={left < 120000 ? 'urgent' : ''}>{countdown(left)}</time>}
                  </div>
                  <p>{c.prompt}</p>
                  <div className="arena-ch-meta">
                    <span>{c.ticketsAwarded} {c.ticketsAwarded === 1 ? 'chance' : 'chances'}</span>
                    {c.prizeCapCents > 0 && <span>unlocks up to {money(c.prizeCapCents)}</span>}
                    {c.awardMode !== 'everyone' && (
                      <span>{c.slotsLeft === null ? '' : `${c.slotsLeft} of ${c.slots} left`}</span>
                    )}
                  </div>

                  {done && (
                    <p className={`arena-status s-${done.status}`}>
                      {done.status === 'pending' && 'Sent in — waiting on a super admin.'}
                      {done.status === 'approved' && `Approved. ${done.tickets_awarded} chance${done.tickets_awarded === 1 ? '' : 's'} added.`}
                      {done.status === 'rejected' && `Not this time.${done.decline_reason ? ` ${done.decline_reason}` : ''}`}
                    </p>
                  )}

                  {!done && c.goneMessage && <p className="arena-ch-gone">{c.goneMessage}</p>}

                  {!done && !c.goneMessage && (
                    <button className="btn small" onClick={() => setOpenFor(c)}>I did this</button>
                  )}

                  {isSuper && !!(c.entries || []).length && (
                    <details className="arena-ch-admin">
                      <summary>{c.entries.length} sent in</summary>
                      <ul>
                        {c.entries.map((e) => (
                          <li key={e.id}>
                            <strong>{e.full_name}</strong>
                            {e.note && <span className="muted small"> — {e.note}</span>}
                            {e.evidence_ref && <em className="muted small"> (with a picture)</em>}
                            {e.status === 'pending' ? (
                              <span className="arena-decide">
                                <button className="btn ghost small" onClick={async () => {
                                  try { await arena.decideFulfilment(e.id, 'approved'); await load(); if (onChanged) onChanged(); }
                                  catch (x) { showMessage((x && x.message) || 'That did not work.'); }
                                }}>Yes</button>
                                <button className="btn ghost small" onClick={async () => {
                                  const reason = await askPrompt('Why not? The reason is shown to them.', { title: 'Turn this one down' });
                                  if (reason === null) return;
                                  try { await arena.decideFulfilment(e.id, 'rejected', reason.trim() || undefined); await load(); }
                                  catch (x) { showMessage((x && x.message) || 'That did not work.', { tone: 'error' }); }
                                }}>No</button>
                              </span>
                            ) : <em className={`arena-status s-${e.status}`}> {e.status}</em>}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              );
            })}

            {!live.length && (
              <p className="muted small">
                Nothing running this minute.
                {board.nextAt ? ` The next one lands around ${new Date(board.nextAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.` : ''}
              </p>
            )}

            {me.tickets > 0 && (
              <p className="arena-ch-standing">
                {me.left > 0
                  ? `You can put ${me.left} more thing${me.left === 1 ? '' : 's'} on the prize wheel.`
                  : `${me.ticketsToNext} more chance${me.ticketsToNext === 1 ? '' : 's'} and you can name another prize.`}
              </p>
            )}

            {!!(board.top || []).length && (
              <ol className="arena-ch-top">
                {board.top.map((t) => (
                  <li key={t.id}><span>{t.full_name}</span><em>{t.tickets}</em></li>
                ))}
              </ol>
            )}
          </>
        )}
      </aside>

      {openFor && (
        <FulfilBox
          challenge={openFor}
          onClose={() => setOpenFor(null)}
          onDone={async () => { setOpenFor(null); await load(); if (onChanged) onChanged(); }}
        />
      )}
    </>
  );
}

/*
 * THE BIG MOMENT. A challenge landing takes the whole screen and counts itself
 * in, so the room looks up together.
 *
 * IT LEAVES BY ITSELF. Nobody has to dismiss it, and it never sits over
 * somebody's work — a few seconds and it is gone, with the challenge itself
 * waiting patiently in the corner card afterwards.
 *
 * `aria-live` means a screen reader announces it rather than only seeing a
 * number grow, and every animation on it is switched off for anybody who asked
 * their computer for less motion.
 */
function ChallengeDrop({ challenge, count, from }) {
  return (
    <div className="arena-drop" role="status" aria-live="assertive">
      <span className="arena-drop-eyebrow">New challenge</span>
      {count > 0
        ? (
          <>
            <div className="arena-drop-count" key={count}>{count}</div>
            {/* A bar that drains as the count runs down, so ten seconds has
                something to watch rather than a number changing once a second. */}
            <div className="arena-drop-bar">
              <i style={{ width: `${Math.max(0, Math.min(100, (count / Math.max(1, from)) * 100))}%`,
                transition: 'width 1s linear' }} />
            </div>
          </>
        )
        : (
          <>
            <h2 className="arena-drop-title">{challenge.title}</h2>
            <p className="arena-drop-prompt">{challenge.prompt}</p>
            <div className="arena-drop-meta">
              <span>{challenge.ticketsAwarded} {challenge.ticketsAwarded === 1 ? 'chance' : 'chances'}</span>
              {challenge.prizeCapCents > 0 && <span>up to {money(challenge.prizeCapCents)}</span>}
              <span>{challenge.awardMode === 'everyone' ? 'Everybody who does it' : challenge.slots === 1 ? 'First one only' : `First ${challenge.slots}`}</span>
            </div>
            <div className="arena-drop-bar"><i style={{ width: '100%' }} /></div>
            <p className="muted small">It is in the corner now — get to it when you are off the phone.</p>
          </>
        )}
    </div>
  );
}

/* "I did this" — the note, and the picture if one is asked for. */
function FulfilBox({ challenge, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [count, setCount] = useState('');
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const needsPhoto = challenge.proofType === 'upload';
  const needsCount = challenge.proofType === 'count';

  const send = async () => {
    if (!note.trim()) return;
    setSending(true);
    try {
      await arena.fulfil(challenge.id, {
        note: note.trim(),
        countValue: needsCount ? Number(count) || null : null,
        dataBase64: file ? file.data : undefined,
        filename: file ? file.name : undefined,
        contentType: file ? file.type : undefined,
      });
      await onDone();
    } catch (e) {
      // A 409 is not an error the person did anything wrong — somebody was
      // faster. Say so in those words.
      showMessage((e && e.message) || 'That did not go through.');
      setSending(false);
    }
  };

  return (
    <div className="arena-modal" role="dialog" aria-modal="true" aria-label={challenge.title}>
      <div className="arena-modal-box">
        <header className="arena-modal-head">
          <h3>{challenge.title}</h3>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </header>
        <p>{challenge.prompt}</p>
        {challenge.detail && <p className="muted small">{challenge.detail}</p>}
        <p className="muted small">{challenge.proofNote}</p>

        <label className="arena-fullfield">What did you do?
          <textarea
            className="input" rows={3} value={note} maxLength={2000}
            placeholder="What it was — the client, the file, what happened — so we can check it."
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {/* The little helper. Optional everywhere, and it never replaces what
            they typed without them saying so. */}
        <ArenaAiHelp text={note} purpose="claim" onAccept={setNote} />

        {needsCount && (
          <label className="arena-fullfield">How many?
            <input className="input" type="number" min="0" value={count} onChange={(e) => setCount(e.target.value)} />
          </label>
        )}

        {needsPhoto && (
          <label className="arena-fullfield">A screenshot or photo
            <input
              className="input" type="file" accept="image/*"
              onChange={(e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) { setFile(null); return; }
                if (f.size > 12 * 1024 * 1024) { showMessage('That picture is too big — keep it under 12MB.'); return; }
                const r = new FileReader();
                r.onload = () => setFile({ name: f.name, type: f.type, data: String(r.result).split(',')[1] });
                r.readAsDataURL(f);
              }}
            />
            {file && <span className="muted small">{file.name} ready</span>}
          </label>
        )}

        <button
          className="btn" disabled={!note.trim() || sending || (needsPhoto && !file)}
          onClick={send}
        >{sending ? 'Sending…' : 'Send it in'}</button>
        {needsPhoto && !file && <p className="muted small">This one needs a picture.</p>}
      </div>
    </div>
  );
}
