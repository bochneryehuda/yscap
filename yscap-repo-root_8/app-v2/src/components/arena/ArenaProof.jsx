import React, { useEffect, useState } from 'react';
import { arena } from '../../lib/arena.js';

/* "CHECK THIS DRAW" — the panel that answers "was that rigged?".
 *
 * IT DOES NOT DO THE MATHS. It asks the server to re-run the draw from its own
 * recorded numbers and shows the answer. That is deliberate: a second
 * implementation in the browser is how two answers start disagreeing, and the
 * one people would believe is the one on their own screen. What is shown here
 * is the EVIDENCE — the fingerprint published before the draw, the secret
 * revealed after it, the frozen list, and the three checks — laid out so
 * somebody who wants to can redo it by hand with any SHA-256 tool.
 *
 * THE THREE CHECKS, in the order they have to hold:
 *   1. the revealed secret really is the one whose fingerprint was published
 *      BEFORE anybody entered — so nobody picked a number to suit the answer;
 *   2. the list on the wheel is byte for byte the list frozen before it turned
 *      — so nobody was added, removed or given extra slices afterwards;
 *   3. redoing the sum lands on the same winner.
 * If any one fails, the panel says which, in words, and does not soften it.
 */
export default function ArenaProof({ drawId, onClose }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    arena.verify(drawId)
      .then((x) => { if (alive) setR(x); })
      .catch((e) => { if (alive) setErr((e && e.message) || 'The check could not run.'); });
    return () => { alive = false; };
  }, [drawId]);

  return (
    <div className="arena-modal" role="dialog" aria-modal="true" aria-label="Check this draw">
      <div className="arena-modal-box">
        <header className="arena-modal-head">
          <h3>Was this draw straight?</h3>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </header>

        {err && <p className="arena-bad">{err}</p>}
        {!r && !err && <p className="muted">Working it out again…</p>}

        {r && (
          <>
            <p className={r.ok ? 'arena-good' : 'arena-bad'}>
              {r.ok
                ? 'Yes. Every check passed — this draw is exactly what the numbers say it should be.'
                : `No. ${r.reason || 'Something does not add up.'}`}
            </p>

            <ul className="arena-checks">
              <Check on={r.commitmentOk} label="The secret number matches the fingerprint published before the draw"
                note="The fingerprint went up before anybody entered, so nobody could pick a number to suit the answer." />
              <Check on={r.rosterOk} label="The list on the wheel is the list that was frozen"
                note="Nobody was added, removed or given extra slices after the list was locked." />
              <Check on={r.winnerOk} label="Doing the sum again gives the same winner"
                note="Anyone can redo it from the numbers below and land on the same name." />
            </ul>

            <dl className="arena-proof">
              <dt>What was drawn</dt><dd>{r.title} — {r.candidateCount} on the wheel</dd>
              <dt>Winner</dt><dd>{r.winnerLabel || '—'}</dd>
              <dt>Fingerprint published beforehand</dt><dd className="mono">{r.commitHash || '—'}</dd>
              <dt>Secret revealed afterwards</dt>
              <dd className="mono">{r.serverSeed || 'not revealed yet'}</dd>
              <dt>Fingerprint of the frozen list</dt><dd className="mono">{r.rosterHash || '—'}</dd>
              {/* A held draw was decided by a PRESS, not a pre-drawn number —
                  so its evidence is the press, the speed and the coast, and the
                  auto-draw's "number from the room"/"turn" rows would print "—"
                  under instructions for the wrong maths (found by the
                  2026-08-19 audit; the rematch is exactly a held draw). */}
              {r.mode === 'held' ? (
                <>
                  <dt>How it stopped</dt><dd>Somebody pressed the button</dd>
                  <dt>The press, after the wheel started</dt>
                  <dd className="mono">{Number.isFinite(Number(r.elapsedMs)) ? `${(Number(r.elapsedMs) / 1000).toFixed(3)} seconds` : '—'}</dd>
                  <dt>Wheel speed</dt><dd className="mono">{r.degPerSecond}° per second</dd>
                  <dt>Coast after the press</dt><dd className="mono">{r.spinDownDeg}°</dd>
                </>
              ) : (
                <>
                  <dt>The number from the room</dt><dd className="mono">{r.clientSeed || '—'}</dd>
                  <dt>Turn</dt><dd className="mono">{r.nonce}</dd>
                </>
              )}
            </dl>

            {r.mode === 'held' ? (
              <p className="muted small">
                To redo it yourself: the SHA-256 of the revealed secret has to equal the fingerprint published
                beforehand — that secret set where the wheel STARTED, before anyone could know it. Then turn the
                wheel forward by (speed × seconds until the press) plus the coast, and read off which slice the
                pointer is in. It lands on the same name every time. Where it stopped really was decided by when
                the button was pressed; the sealed secret is what stops anybody lining the wheel up in advance.
              </p>
            ) : (
              <p className="muted small">
                To redo it yourself: the SHA-256 of the revealed secret has to equal the fingerprint published
                beforehand. Then take HMAC-SHA256 of “{'{the number from the room}'}:{'{turn}'}” keyed with that
                secret, read it as a number, and count along the wheel by slice size. It lands on the same name
                every time. This is the same commit-and-reveal method regulated prize draws use.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Check({ on, label, note }) {
  return (
    <li className={on ? 'ok' : 'no'}>
      <span aria-hidden="true">{on ? '✓' : '✕'}</span>
      <div>
        <strong>{label}</strong>
        <p className="muted small">{note}</p>
      </div>
    </li>
  );
}
