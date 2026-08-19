import React, { useCallback, useEffect, useRef, useState } from 'react';
import { money, prefersReducedMotion } from '../../lib/arena.js';
import { playLanding, soundOn, setSoundOn, arm } from '../../lib/arenaSound.js';

/* THE LANDING TAKEOVER — the moment the whole room looks up.
 *
 * The owner: "sound and a full-screen takeover on every screen when a spin
 * lands, not just a card."
 *
 * WHY A TAKEOVER RATHER THAN A BANNER. Everybody in the building is doing
 * something else — on a call, in a file, three tabs deep. A card in the corner
 * of one screen is a thing you notice afterwards; the point of a live game is
 * that thirty people find out at the same second. So it is the whole screen,
 * for a few seconds, and then it gets out of the way by itself.
 *
 * ── THE FOUR RULES IT OBEYS ────────────────────────────────────────────────
 * 1. IT ALWAYS LETS GO. It clears itself after a few seconds, Escape closes it,
 *    and so does clicking anywhere on it. Nothing in a loan business may ever
 *    be covered by a game with no way out — somebody is always mid-sentence
 *    with a borrower when a wheel lands.
 * 2. LESS MOTION IS HONOURED. `prefers-reduced-motion` turns off the confetti
 *    and every animation; the card still appears, because the INFORMATION is
 *    the point and only the movement was ever optional.
 * 3. THE SOUND IS ONE CLICK AWAY FROM OFF, from inside the takeover itself —
 *    which is exactly where a person is when they discover they want it off.
 * 4. IT NEVER SHOWS THE SAME RESULT TWICE. A reconnect replays frames, and a
 *    second takeover for a spin the room already cheered reads as a bug.
 */
export default function ArenaTakeover({ result, onClose, holdMs = 9000 }) {
  const [muted, setMuted] = useState(() => !soundOn());
  const reduce = prefersReducedMotion();
  const timer = useRef(null);

  // Open the audio path on the first gesture anywhere. Harmless to repeat.
  useEffect(() => { arm(); }, []);

  const close = useCallback(() => { if (onClose) onClose(); }, [onClose]);

  useEffect(() => {
    if (!result) return undefined;
    playLanding();
    clearTimeout(timer.current);
    timer.current = setTimeout(close, Math.max(2000, Number(holdMs) || 9000));
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer.current); window.removeEventListener('keydown', onKey); };
    // `result.key` changes per landing, which is what re-runs the chime.
  }, [result && result.key, close, holdMs]);   // eslint-disable-line react-hooks/exhaustive-deps

  if (!result) return null;
  const worth = money(result.valueCents);
  const bits = reduce ? [] : Array.from({ length: 90 }, (_, i) => ({
    i, left: (i * 29) % 100, delay: (i % 15) * 0.07, hue: (i * 53) % 360,
    size: 6 + (i % 4) * 3,
  }));

  return (
    <div
      className={`arena-takeover${reduce ? ' calm' : ''}`}
      role="alertdialog"
      aria-live="assertive"
      aria-label={`${result.winnerName || 'Nobody'} won ${result.prizeLabel || ''}`}
      onClick={close}
    >
      {bits.map((b) => (
        <span
          key={b.i}
          className="arena-tk-bit"
          style={{
            left: `${b.left}%`, animationDelay: `${b.delay}s`,
            background: `hsl(${b.hue} 82% 58%)`, width: b.size, height: b.size * 1.6,
          }}
        />
      ))}
      <div className={`arena-tk-card${result.joke ? ' joke' : ''}`} onClick={(e) => e.stopPropagation()}>
        <span className="arena-tk-eyebrow">
          {result.spinSeq ? `Spin ${result.spinSeq}` : 'The wheel has landed'}
        </span>
        <strong className="arena-tk-name">{result.winnerName || 'Nobody'}</strong>
        {result.prizeLabel && <span className="arena-tk-prize">{result.prizeLabel}</span>}
        {/* A BOOBY PRIZE GETS ITS PUNCHLINE AND NEVER A PRICE. `worth` is
            already blank on one (its value is zero by construction), but the
            follow-through line is the whole joke and has to be on the screen the
            room is looking at — the message that lands in an inbox afterwards is
            not where a gag works. */}
        {result.joke && result.jokeDetail && (
          <span className="arena-tk-joke">{result.jokeDetail}</span>
        )}
        {!result.joke && worth && <span className="arena-tk-worth">{worth}</span>}
        {result.mine && (
          <span className="arena-tk-mine">{result.joke ? 'That is you. Sorry.' : 'That is you.'}</span>
        )}
        <div className="arena-tk-actions">
          <button type="button" className="btn primary" onClick={close}>Back to it</button>
          <button
            type="button"
            className="btn soft"
            onClick={() => setMuted(!setSoundOn(muted))}
            aria-pressed={muted}
          >
            {muted ? 'Sound off' : 'Sound on'}
          </button>
        </div>
        <span className="arena-tk-hint">This clears itself. Escape closes it now.</span>
      </div>
    </div>
  );
}
