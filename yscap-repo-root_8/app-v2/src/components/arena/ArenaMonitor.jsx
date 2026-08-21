import React, { useCallback, useEffect, useState } from 'react';
import { subscribeChat } from '../../lib/chatEvents.js';
import { arena, money, countdown, serverNow } from '../../lib/arena.js';

/* THE LIVE MONITOR — the screen the person running the day watches.
 *
 * The owner: "to be set up with good notifications on the winner live screen to
 * monitor how it's being filled out, how the spins run, and who wins."
 *
 * THE BOARD IS FOR PLAYING; THIS IS FOR RUNNING. A player needs the wheel, the
 * chat and their own state. The person running the day needs one number — is
 * anything waiting on me — and then everything else at a glance: who has
 * clocked in, how far each spin has got, and who has won what.
 *
 * THE ONE NUMBER IS AT THE TOP, and it is loud when it is not zero. Everything
 * else on this screen is information; that number is the only thing that ever
 * needs somebody to act, so it earns the biggest type on the page.
 *
 * IT IS THE ONE PLACE A FULL RANKING IS SHOWN. The players' own board
 * deliberately shows the top few and your own standing, never "you are 14th of
 * 16" — the research on sales leaderboards is consistent that publishing the
 * bottom makes the people on it stop trying. But the person running the day
 * genuinely needs to see everybody, including who has not got going yet, so
 * they can nudge them. Different audience, different rule, said out loud.
 *
 * LIVE OFF THE SAME STREAM as everything else, with a slow poll behind it as a
 * safety net — this screen is likely to sit open on a second monitor all day,
 * and a missed frame must not leave it quietly stale.
 */
export default function ArenaMonitor({ sessionId }) {
  const [m, setM] = useState(null);
  const [now, setNow] = useState(serverNow());
  const [err, setErr] = useState('');
  const [whoOpen, setWhoOpen] = useState(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try { setM(await arena.monitor(sessionId)); setErr(''); }
    catch (e) { setErr((e && e.message) || 'The monitor could not be loaded.'); }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);
  // Live, plus a slow poll underneath it. Thirty seconds is cheap and means a
  // screen left open all day can never drift far from the truth.
  useEffect(() => subscribeChat((event) => {
    if (event.startsWith('arena:') || event === 'reconnect') load();
  }), [load]);
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <p className="arena-bad">{err}</p>;
  if (!m) return <p className="muted">Opening the monitor…</p>;

  const p = m.pending || {};
  const live = (m.spins || []).filter((s) => ['open', 'locked', 'spinning'].includes(s.state));
  const done = (m.spins || []).filter((s) => s.state === 'decided');

  return (
    <div className="arena-monitor">
      <div className={`arena-mon-hero${m.waitingOnYou ? ' hot' : ''}`}>
        <strong>{m.waitingOnYou}</strong>
        <span>{m.waitingOnYou === 0 ? 'Nothing waiting on you' : m.waitingOnYou === 1 ? 'thing waiting on you' : 'things waiting on you'}</span>
        {m.waitingOnYou > 0 && (
          <em>
            {[
              p.checkins ? `${p.checkins} check-in${p.checkins === 1 ? '' : 's'}` : '',
              p.entries ? `${p.entries} prize${p.entries === 1 ? '' : 's'}` : '',
              p.claims ? `${p.claims} claim${p.claims === 1 ? '' : 's'}` : '',
              p.fulfilments ? `${p.fulfilments} challenge${p.fulfilments === 1 ? '' : 's'}` : '',
            ].filter(Boolean).join(' · ')}
          </em>
        )}
      </div>

      <div className="arena-mon-grid">
        <Stat label="Spins run" value={done.length} of={(m.spins || []).length} />
        <Stat label="Prizes given" value={(m.awards || []).length} />
        <Stat label="Challenges live" value={(m.challenges || {}).live || 0} of={((m.challenges || {}).live || 0) + ((m.challenges || {}).scheduled || 0)} />
        <Stat label="Messages" value={m.chatMessages || 0} />
      </div>

      <section className="arena-card">
        <h3>How each spin is running</h3>
        {!(m.spins || []).length && <p className="muted">No spins yet.</p>}
        <ul className="arena-mon-spins">
          {(m.spins || []).map((s) => {
            const left = s.entryDeadlineAt ? Date.parse(s.entryDeadlineAt) - now : null;
            return (
              <li key={s.id} className={`s-${s.state}`}>
                <span className="arena-seq">#{s.seq}</span>
                <strong>{s.title}</strong>
                <span className={`arena-pill s-${s.state}`}>{s.state}</span>
                <span className="arena-mon-nums">
                  <em>{s.checkins} in</em>
                  {s.checkinsPending > 0 && <em className="hot">{s.checkinsPending} to approve</em>}
                  <em>{s.entries} prize{s.entries === 1 ? '' : 's'}</em>
                  {s.entriesPending > 0 && <em className="hot">{s.entriesPending} to approve</em>}
                  <em>{s.wheelsDone}/{s.wheelsTotal} wheels</em>
                  {!!(s.checkinPeople && s.checkinPeople.length) && (
                    <button type="button" className="btn ghost small"
                      onClick={() => setWhoOpen(whoOpen === s.id ? null : s.id)}>
                      {whoOpen === s.id ? 'Hide the list' : 'Who is in'}
                    </button>
                  )}
                </span>
                {s.state === 'open' && left != null && (
                  <span className={`arena-mon-clock${left < 5 * 60000 ? ' hot' : ''}`}>
                    {left > 0 ? `${countdown(left)} left` : 'closing'}
                  </span>
                )}
                {s.state === 'draft' && s.launchAt && (
                  <span className="arena-mon-clock">
                    opens {new Date(s.launchAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                )}
                {s.outcomeNote && <span className="muted small arena-mon-note">{s.outcomeNote}</span>}
                {whoOpen === s.id && (
                  <ul className="arena-mon-who">
                    {(s.checkinPeople || []).map((cp, i) => (
                      <li key={i}>
                        <span>{cp.name}</span>
                        <em className={`muted small${cp.status === 'pending' ? ' hot' : ''}`}>
                          {cp.status === 'approved' ? 'in the spin' : cp.status === 'pending' ? 'waiting on approval' : cp.status}
                        </em>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="arena-mon-two">
        <section className="arena-card">
          <h3>Who has won what</h3>
          {!(m.awards || []).length && <p className="muted">Nothing yet.</p>}
          <ul className="arena-mon-awards">
            {(m.awards || []).map((a) => (
              <li key={a.id}>
                <strong>{a.full_name}</strong>
                <span>{a.prize_label}</span>
                {a.value_cents > 0 && <em>{money(a.value_cents)}</em>}
                <time>{new Date(a.awarded_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</time>
              </li>
            ))}
          </ul>
        </section>

        <section className="arena-card">
          <h3>Everybody&rsquo;s chances</h3>
          <p className="muted small">
            The full list, because you are the one running the day. The team&rsquo;s own screen
            never shows anybody their position in it.
          </p>
          <ul className="arena-mon-standings">
            {(m.standings || []).map((s) => (
              <li key={s.id} className={s.tickets === 0 ? 'zero' : ''}>
                <span>{s.full_name}</span>
                <em>{s.tickets}</em>
              </li>
            ))}
            {!(m.standings || []).length && <li className="muted">Nobody yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, of }) {
  return (
    <div className="arena-mon-stat">
      <strong>{value}{of !== undefined && of !== value ? <em> / {of}</em> : null}</strong>
      <span>{label}</span>
    </div>
  );
}
