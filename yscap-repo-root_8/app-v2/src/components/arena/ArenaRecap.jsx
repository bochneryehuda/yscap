import React, { useCallback, useEffect, useState } from 'react';
import { arena } from '../../lib/arena.js';

/* THE RECAP CARD — one person's day, in a shape worth screenshotting.
 *
 * The owner: "an end-of-day recap card each person can screenshot: what they
 * did, what they won, where they finished."
 *
 * ── IT IS PRIVATE, AND THAT IS WHAT MAKES THE POSITION ALLOWABLE ───────────
 * Everywhere else the Arena refuses to show anybody the bottom of a
 * leaderboard, because publishing it is what makes the people on it stop
 * trying. This card tells a person their own position anyway: it is theirs
 * alone (the server answers with the id on the token, never the one in the
 * URL), it is at the END of the day, and a card that quietly skipped the number
 * for exactly the people who came last would be doing so transparently. What is
 * still never done is showing anybody ELSE's position to them.
 *
 * ── IT LEADS WITH WHAT THEY DID ────────────────────────────────────────────
 * The headline is an action, never a rank — the part they control. The position
 * is one line near the bottom, the same size as everything else.
 *
 * The card is plain elements on a plain background on purpose: a phone
 * screenshot of it has to be readable in a group chat.
 */
export default function ArenaRecap({ sessionId, staffId = null, compact = false }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!sessionId) return;
    try { setR(await arena.recap(sessionId, staffId)); setErr(''); }
    catch (e) { setErr((e && e.message) || 'Your day could not be loaded.'); }
  }, [sessionId, staffId]);
  useEffect(() => { load(); }, [load]);

  if (err) return <p className="arena-bad">{err}</p>;
  if (!r) return <p className="muted">Adding it up…</p>;

  return (
    <div className={`arena-recap${compact ? ' compact' : ''}`}>
      <div className="arena-recap-top">
        <span className="arena-recap-eyebrow">{(r.session && r.session.name) || 'Elementix Day'}</span>
        <strong className="arena-recap-head">{r.headline}</strong>
        {r.person && <span className="arena-recap-who">{r.person.name}</span>}
      </div>

      {!!(r.prizes || []).length && (
        <ul className="arena-recap-prizes">
          {r.prizes.map((p, i) => (
            <li key={i}>
              <strong>{p.label}</strong>
              {p.value && <em>{p.value}</em>}
              {p.spinSeq ? <span className="muted small">Spin {p.spinSeq}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <dl className="arena-recap-lines">
        {(r.lines || []).map((l, i) => (
          <div key={i}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>

      {!(r.lines || []).length && (
        <p className="muted">
          Nothing to add up yet — check in, or take on a challenge, and this fills itself in.
        </p>
      )}
    </div>
  );
}
