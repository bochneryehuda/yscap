import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { showMessage, askConfirm, askPrompt } from '../lib/dialog.js';
import { useAuth } from '../lib/auth.jsx';
import { subscribeChat } from '../lib/chatEvents.js';
import { arena, money, countdown, serverNow, spinProgress, prefersReducedMotion } from '../lib/arena.js';
import ArenaWheel from '../components/ArenaWheel.jsx';
import ArenaChat from '../components/arena/ArenaChat.jsx';
import ArenaProof from '../components/arena/ArenaProof.jsx';
import ArenaControlRoom from '../components/arena/ArenaControlRoom.jsx';
import ArenaChallenges from '../components/arena/ArenaChallenges.jsx';
import ArenaAiHelp, { ArenaAiIdeas } from '../components/arena/ArenaAiHelp.jsx';
import ArenaTakeover from '../components/arena/ArenaTakeover.jsx';
import ArenaRoomBar from '../components/arena/ArenaRoomBar.jsx';
import ArenaRecap from '../components/arena/ArenaRecap.jsx';
import { arm as armSound } from '../lib/arenaSound.js';

/* THE ARENA — the screen everybody in the building has open during a session.
 *
 * ONE SCREEN, THREE JOBS, and they are deliberately not three screens: during a
 * live spin the room needs the wheel, the chat and their own "am I in?" state
 * in one glance, and a super admin needs to run the thing without leaving it.
 *   - THE STAGE: the wheel, the countdown, who is on it, and what just happened.
 *   - THE ROOM: chat beside the wheel, and what people want next time.
 *   - THE CONTROL ROOM: sessions, spins, approvals, prizes and the settings.
 *     Only a super admin sees this tab exists.
 *
 * EVERYTHING LIVE ARRIVES OVER THE EXISTING EVENT STREAM. Nothing here polls on
 * a timer except the one-second countdown clock, which is local arithmetic and
 * touches no network. When a frame arrives that changes the board, the board is
 * refetched once — a frame is a nudge, never the truth.
 *
 * IF THE STREAM IS DOWN the board still works; it just stops being live. The
 * refetch-on-frame design means there is no state that only exists in a frame,
 * so a missed frame costs a refresh, never a wrong screen.
 */

const STATE_LABEL = {
  draft: 'Not open yet', open: 'Open — check in now', locked: 'Closed, about to spin',
  spinning: 'Spinning', decided: 'Done', cancelled: 'Cancelled',
};

const fmtTime = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
};

export default function StaffArena() {
  const { role } = useAuth();
  const [params, setParams] = useSearchParams();
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState(params.get('tab') || 'stage');
  const [tv, setTv] = useState(params.get('tv') === '1');
  const [now, setNow] = useState(serverNow());
  const [celebrating, setCelebrating] = useState(null);
  const [proofFor, setProofFor] = useState(null);
  const [busy, setBusy] = useState('');
  // What the stream has told us about the wheel that is turning RIGHT NOW.
  // Kept beside the board rather than inside it, because a free spin has no
  // duration and no landing angle until somebody presses the button — the board
  // simply does not know yet, and only the stream does.
  const [liveSpin, setLiveSpin] = useState(null);
  const [me, setMe] = useState(null);
  // The whole-screen moment when a SPIN is settled — the person AND the prize.
  // Separate from `celebrating`, which is one WHEEL landing: a spin with two
  // wheels lands twice and is decided once, and only the decision is the news.
  const [takeover, setTakeover] = useState(null);
  const seenDecided = useRef(new Set());
  // A named Arena HOST runs the room like a super admin (settings.hosts) —
  // the server says so on the board; the role check covers the empty screen
  // before any board has loaded.
  const isSuper = role === 'super_admin' || !!(board && board.isSuperAdmin);
  const sessionParam = params.get('session') || '';
  const reload = useRef(null);
  // Read inside the stream subscription, which is set up once and must not be
  // torn down and rebuilt every time `me` resolves — a resubscribe drops frames.
  const meRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const b = await arena.board(sessionParam);
      setBoard(b);
      setErr('');
    } catch (e) {
      setErr(e && e.message ? e.message : 'The Arena could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [sessionParam]);

  // ONE REFRESH A SECOND, NOT ONE PER FRAME.
  //
  // Every arena event asks the open screens to refresh, and the board is nine
  // queries. That is nothing when one thing happens — and it is the busiest
  // minute of the day that breaks it: at half past ten forty people check in
  // inside two minutes, each check-in is a frame to every open screen, and an
  // immediate refetch on each one turns one person's click into forty board
  // loads. Forty by forty is sixteen hundred loads, on the same instance that
  // is serving the loan portal.
  //
  // So refreshes are COALESCED: at most one a second per screen, and always a
  // TRAILING one, because the frame most worth reacting to is usually the last
  // in a burst and a leading-edge-only throttle is exactly the one that drops
  // it. The wheel itself never waits on this — spinning, stopping and the
  // landing all come straight off the stream and paint immediately.
  const reloadTimer = useRef(null);
  const reloadAt = useRef(0);
  const askReload = useCallback(() => {
    const GAP = 1000;
    if (reloadTimer.current) return;                       // one is already queued
    const since = Date.now() - reloadAt.current;
    if (since >= GAP) { reloadAt.current = Date.now(); load(); return; }
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      reloadAt.current = Date.now();
      load();
    }, GAP - since);
  }, [load]);
  reload.current = askReload;

  useEffect(() => () => { if (reloadTimer.current) clearTimeout(reloadTimer.current); }, []);

  useEffect(() => { load(); }, [load]);

  // Open the audio path on this person's first click anywhere, so the first
  // landing they are actually present for can be heard. Costs nothing and is
  // silent for anybody who has switched the sound off.
  useEffect(() => { armSound(); }, []);

  // The countdown clock. Local arithmetic on the server-corrected time — no
  // request, so a one-second tick costs nothing.
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, []);

  // The live stream. A frame is a nudge to refetch, except the two that carry
  // something the board cannot re-derive: the reveal (for the celebration) and
  // the switch being turned off underneath everybody.
  useEffect(() => subscribeChat((event, data) => {
    if (!event.startsWith('arena:') && event !== 'reconnect') return;
    if (event === 'arena:switch' && data && data.enabled === false) {
      // The owner turned it off. Everyone's window clears, right now.
      setBoard(null);
      setErr('The Arena has been switched off.');
      return;
    }
    if (event === 'arena:revealed' && data) {
      setCelebrating({ label: data.winnerLabel, seq: data.seq, at: Date.now() });
      setTimeout(() => setCelebrating((c) => (c && c.at && Date.now() - c.at >= 5500 ? null : c)), 6000);
    }
    if (event === 'arena:chat' || event === 'arena:chat-react') return;   // ArenaChat owns those
    if (event === 'arena:spinning' && data) {
      setLiveSpin({
        drawId: data.drawId, seq: data.seq, spinId: data.spinId,
        startedAt: data.startedAt, durationMs: data.durationMs,
        targetRotationDeg: data.targetRotationDeg,
        free: !!data.free, degPerSecond: data.degPerSecond || 900,
        stopHolderStaffId: data.stopHolderStaffId || null,
        stopTruth: data.stopTruth || null,
        coastFrom: null, coastMs: 1600,
      });
      return;
    }
    if (event === 'arena:stopping' && data) {
      // The button went. Everybody's wheel now knows where it is coming to rest.
      setLiveSpin((c) => (c && c.drawId === data.drawId
        ? { ...c, coastFrom: data.stoppedAt, targetRotationDeg: data.targetRotationDeg, coastMs: data.coastMs || 1600 }
        : c));
      return;
    }
    if (event === 'arena:revealed' && data) setLiveSpin(null);
    if (event === 'arena:decided' && data && data.spinId) {
      // ONCE PER SPIN. A reconnect replays frames, and a second takeover for a
      // result the room already cheered reads as a bug rather than a moment.
      const key = String(data.spinId);
      if (!seenDecided.current.has(key)) {
        seenDecided.current.add(key);
        setTakeover({
          key,
          spinId: data.spinId,
          spinSeq: data.seq || null,
          winnerName: data.winnerName,
          prizeLabel: data.prizeLabel,
          valueCents: data.valueCents,
          joke: !!data.joke,
          jokeDetail: data.jokeDetail || null,
          mine: !!(data.winnerStaffId && meRef.current && String(data.winnerStaffId) === String(meRef.current)),
        });
      }
    }
    if (reload.current) reload.current();
  }), []);

  // Who am I? Needed to know whether a stop button is mine. Read once.
  useEffect(() => {
    let alive = true;
    import('../lib/api.js').then(({ api }) => api.get('/auth/me'))
      .then((r) => { if (alive) { setMe(r && r.id ? String(r.id) : null); meRef.current = r && r.id ? String(r.id) : null; } })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const session = board && board.session;
  const spins = (board && board.spins) || [];
  const current = spins.find((s) => ['open', 'locked', 'spinning'].includes(s.state)) || spins[0] || null;
  const history = spins.filter((s) => s.state === 'decided');

  const setTabParam = (t) => {
    setTab(t);
    const p = new URLSearchParams(params);
    p.set('tab', t);
    setParams(p, { replace: true });
  };

  const act = async (label, fn) => {
    setBusy(label);
    try { await fn(); await load(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.'); }
    finally { setBusy(''); }
  };

  if (loading) return <div className="wrap"><p className="muted">Opening the Arena…</p></div>;

  if (err && !board) {
    return (
      <div className="wrap">
        <h1>The Arena</h1>
        <p className="muted">{err}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="wrap arena">
        <h1>The Arena</h1>
        <p className="muted">
          There is no session running right now.
          {isSuper ? ' Open the control room to start one.' : ' A super admin starts one when it is time to play.'}
        </p>
        {isSuper && (
          <div style={{ marginTop: 18 }}>
            <ArenaControlRoom board={null} onChanged={load} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`wrap arena${tv ? ' arena-tv' : ''}`}>
      <header className="arena-head">
        <div>
          <div className="arena-live">
            <span className="arena-dot" aria-hidden="true" />
            {session.state === 'live' ? 'Live now' : STATE_LABEL[session.state] || session.state}
          </div>
          <h1 className="arena-title">{session.name}</h1>
          {session.subtitle && <p className="arena-sub">{session.subtitle}</p>}
          {isSuper && !tv && tab !== 'control' && (
            <p style={{ margin: '6px 0 0' }}>
              <button className="btn small" onClick={() => setTabParam('control')}>Open the control room</button>
            </p>
          )}
          {session.paused_at && (
            <p className="arena-sub" style={{ color: '#8A6215', fontWeight: 700 }}>
              Paused — back in a moment. Check-in reopens when it resumes.
            </p>
          )}
        </div>
        <div className="arena-head-actions">
          <button className="btn ghost small" onClick={() => setTv(!tv)}>
            {tv ? 'Leave big-screen mode' : 'Big screen'}
          </button>
        </div>
      </header>

      {!tv && (
        <nav className="arena-tabs" role="tablist">
          {[['stage', 'The stage'], ['history', `Every spin (${history.length})`], ['room', 'The room'], ['me', 'Your day']]
            .concat(isSuper ? [['control', 'Control room']] : [])
            .map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                className={`arena-tab${tab === k ? ' on' : ''}`}
                onClick={() => setTabParam(k)}
              >{label}</button>
            ))}
        </nav>
      )}

      {celebrating && <Celebration label={celebrating.label} />}
      <ArenaTakeover result={takeover} onClose={() => setTakeover(null)} />

      {(tab === 'stage' || tv) && (
        <Stage
          board={board} spin={current} now={now} isSuper={isSuper} busy={busy}
          onAct={act} onProof={setProofFor} tv={tv} onReload={load}
          liveSpin={liveSpin} me={me}
        />
      )}

      {tab === 'history' && !tv && (
        <History spins={history} onProof={setProofFor} />
      )}

      {tab === 'room' && !tv && (
        <div className="arena-room">
          <ArenaChat sessionId={session.id} spinId={current && current.id} isSuper={isSuper} />
          <Suggestions sessionId={session.id} isSuper={isSuper} />
        </div>
      )}

      {tab === 'me' && !tv && (
        <ArenaRecap sessionId={session.id} />
      )}

      {tab === 'control' && isSuper && !tv && (
        <ArenaControlRoom board={board} onChanged={load} />
      )}

      {/* The challenges that land on everybody's screen through the day. It
          mounts itself and shows nothing at all when none are running. */}
      <ArenaChallenges sessionId={session.id} isSuper={isSuper} onChanged={load} />

      {proofFor && <ArenaProof drawId={proofFor} onClose={() => setProofFor(null)} />}
    </div>
  );
}

/* --------------------------------------------------------------- the stage */

function Stage({ board, spin, now, isSuper, busy, onAct, onProof, tv, onReload, liveSpin, me }) {
  const settings = (board && board.settings) || {};
  if (!spin) {
    return <p className="muted">No spins yet in this session.{isSuper ? ' Set one up in the control room.' : ''}</p>;
  }
  const draws = spin.draws || [];
  // The wheel on screen is the one turning, or the last one that landed, or the
  // next one waiting. In that order, because that is the order the room cares.
  const active = draws.find((d) => d.state === 'spinning')
    || [...draws].reverse().find((d) => d.state === 'revealed')
    || draws.find((d) => d.roster) || draws[0] || null;

  // Array.isArray, not truthiness — arena_draws.roster is jsonb, and a non-array
  // value there would make .reduce throw past the || [] guard.
  const roster = Array.isArray(active && active.roster) ? active.roster : [];
  const total = roster.reduce((a, c) => a + (Number(c.weight) || 0), 0);
  const angles = total > 0
    ? roster.map((c) => (360 * (Number(c.weight) || 0)) / total)
    : roster.map(() => 360 / Math.max(1, roster.length));

  const deadline = spin.entry_deadline_at ? Date.parse(spin.entry_deadline_at) : null;
  const left = deadline ? deadline - now : null;
  const open = spin.state === 'open';
  // A free spin's truth lives in the stream, not the board — the board has no
  // duration and no landing angle for it until the button has been pressed.
  const onAir = liveSpin && active && String(liveSpin.drawId) === String(active.id) ? liveSpin : null;
  const spinning = onAir
    ? true
    : (active && active.state === 'spinning' && spinProgress(active.spin_started_at, active.duration_ms) < 1);
  const myButton = onAir && onAir.free && me && String(onAir.stopHolderStaffId) === String(me) && !onAir.coastFrom;

  return (
    <div className={`arena-stage${tv ? ' tv' : ''}`}>
      <section className="arena-wheelcol">
        {/* Who is actually with us. Above the wheel because it is the first
            thing a person looks for when they open the Arena mid-morning. */}
        <ArenaRoomBar sessionId={board && board.session && board.session.id} />
        <div className="arena-spinhead">
          <span className="arena-seq">Spin {spin.seq}</span>
          <h2>{spin.title}</h2>
          {spin.subtitle && <p className="arena-sub">{spin.subtitle}</p>}
          <span className={`arena-pill s-${spin.state}`}>{STATE_LABEL[spin.state] || spin.state}</span>
        </div>

        {open && deadline && (
          <div className={`arena-countdown${left != null && left < 5 * 60000 ? ' urgent' : ''}`}>
            {left > 0
              ? <><strong>{countdown(left)}</strong> left to get in</>
              : <>Check-in has closed</>}
            <span className="arena-deadline-at">closes {fmtTime(spin.entry_deadline_at)}</span>
          </div>
        )}

        {active && (
          <>
            <p className="arena-wheeltitle">{active.title}</p>
            <ArenaWheel
              candidates={roster}
              angles={angles}
              startedAt={onAir ? onAir.startedAt : (spinning ? active.spin_started_at : null)}
              durationMs={onAir ? onAir.durationMs : active.duration_ms}
              targetRotationDeg={onAir ? (onAir.targetRotationDeg || 0) : (active.target_rotation_deg || 0)}
              winnerIndex={active.winner_index}
              hideLabels={!!(spin.config && spin.config.hideLabels)}
              size={tv ? 520 : 360}
              onLanded={onReload}
              free={!!(onAir && onAir.free)}
              degPerSecond={onAir ? onAir.degPerSecond : 900}
              coastFrom={onAir ? onAir.coastFrom : null}
              coastMs={onAir ? onAir.coastMs : 1600}
            />
            {onAir && onAir.free && (
              <StopButton onAir={onAir} mine={!!myButton} me={me} />
            )}
            {active.state === 'revealed' && (
              <div className="arena-result">
                <span className="arena-result-k">{active.title}</span>
                <strong className="arena-result-v">{active.winner_label}</strong>
                {settings.showFairnessProof !== false && (
                  <button className="btn ghost small" onClick={() => onProof(active.id)}>Check this draw</button>
                )}
              </div>
            )}
            {!roster.length && (
              <p className="muted">Nobody is on this wheel yet. It cannot be spun until somebody is.</p>
            )}
          </>
        )}

        {isSuper && !tv && <AdminSpinBar spin={spin} draws={draws} busy={busy} onAct={onAct} />}
      </section>

      <aside className="arena-side">
        <MyPart spin={spin} board={board} onAct={onAct} busy={busy} now={now} />
        <WhoIsOn spin={spin} roster={roster} total={total} settings={settings} isSuper={isSuper} onAct={onAct} />
        {!!(spin.qualifiers || []).length && (
          <Qualifiers spin={spin} isSuper={isSuper} onAct={onAct} />
        )}
        <Prizes spin={spin} isSuper={isSuper} onAct={onAct} />
        {!tv && <ArenaChat sessionId={board.session.id} spinId={spin.id} isSuper={isSuper} compact />}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------- the stop button */

/*
 * THE BUTTON. It really does stop the wheel.
 *
 * Only the person holding it sees a button; everybody else sees whose it is, so
 * the room knows who to look at. Pressing it tells the server, and the SERVER
 * works out where the wheel landed from the moment the press arrived — which is
 * why the button does not need to know anything about the result, and why a
 * slow laptop cannot change it.
 *
 * The wording under it is deliberately exact. It really does decide where the
 * wheel stops; it is also going far too fast to aim. Saying both is the only
 * honest version, and it is more fun than either half on its own.
 */
function StopButton({ onAir, mine, me }) {
  const [pressed, setPressed] = useState(false);
  if (onAir.coastFrom) return <p className="arena-stopnote">Stopping…</p>;
  if (!mine) {
    return (
      <p className="arena-stopnote">
        {onAir.stopHolderStaffId
          ? 'Somebody in the room has the stop button. It keeps turning until they press it.'
          : 'This one stops on its own.'}
      </p>
    );
  }
  return (
    <div className="arena-stopbox">
      <button
        className="arena-stopbtn"
        disabled={pressed}
        onClick={async () => {
          setPressed(true);
          try { await arena.pressStop(onAir.drawId); }
          catch (e) { setPressed(false); showMessage((e && e.message) || 'That did not go through — try again.'); }
        }}
      >{pressed ? 'Stopping…' : 'STOP'}</button>
      <p className="arena-stoptruth">{onAir.stopTruth}</p>
    </div>
  );
}

/* ------------------------------------------------------------- my own part */

function MyPart({ spin, board, onAct, busy, now }) {
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState('personal');
  const settings = board.settings || {};
  const mine = spin.myCheckin;
  const myEntries = spin.myEntries || [];
  const config = spin.config || {};
  const canEnter = config.entriesAllowed !== false && spin.state === 'open'
    && mine && mine.status !== 'rejected';
  const cap = kind === 'business'
    ? (config.businessCapCents ?? settings.businessCapCents ?? 100000)
    : (config.personalCapCents ?? settings.personalCapCents ?? 50000);

  return (
    <div className="arena-card arena-me">
      <h3>You</h3>
      {/* A session limited to a picked list refuses everyone else at check-in
          — so they are TOLD that instead of being handed a button that 400s. */}
      {!mine && spin.state === 'open' && board && board.iAmIn === false && (
        <p className="muted">This session is limited to a picked list, and you are not on it — ask a super admin if that is wrong.</p>
      )}
      {!mine && spin.state === 'open' && !(board && board.iAmIn === false) && (
        <>
          <p className="muted">You are not in this spin yet.</p>
          {/* The wording they agree to is SHOWN and their agreement RECORDED —
              the attestation was configured on the spin and stored with the
              check-in, so what they attested to is on the record (it was
              defined and never shown anywhere until the 2026-08-19 audit). */}
          <button
            className="btn"
            disabled={busy === 'checkin'}
            onClick={async () => {
              const wording = spin.config && typeof spin.config.attestation === 'string'
                ? spin.config.attestation.trim() : '';
              if (wording) {
                const sure = await askConfirm(wording, { title: 'Before you check in', confirmLabel: 'That is me — check me in' });
                if (!sure) return;
                onAct('checkin', () => arena.checkIn(spin.id, undefined, true));
                return;
              }
              onAct('checkin', () => arena.checkIn(spin.id));
            }}
          >{busy === 'checkin' ? 'Checking in…' : 'Check in — I am here'}</button>
        </>
      )}
      {!mine && spin.state !== 'open' && <p className="muted">Check-in is not open.</p>}
      {mine && (
        <p className={`arena-status s-${mine.status}`}>
          {mine.status === 'approved' && 'You are in. Good luck.'}
          {mine.status === 'pending' && 'You checked in — waiting for a super admin to wave you through.'}
          {mine.status === 'rejected' && `Your check-in was declined.${mine.decline_reason ? ` ${mine.decline_reason}` : ''}`}
        </p>
      )}

      {canEnter && (
        <div className="arena-entryform">
          <h4>What would you like to win?</h4>
          <p className="muted small">
            Anything personal up to {money(config.personalCapCents ?? settings.personalCapCents ?? 50000)},
            anything for your business up to {money(config.businessCapCents ?? settings.businessCapCents ?? 100000)}.
            A super admin says yes or no to each one.
          </p>
          <div className="arena-kindpick">
            {[['personal', 'Personal'], ['business', 'For the business']].map(([k, l]) => (
              <button key={k} className={`arena-chip${kind === k ? ' on' : ''}`} onClick={() => setKind(k)}>{l}</button>
            ))}
          </div>
          <input
            className="input" placeholder="What is it?" value={label} maxLength={140}
            onChange={(e) => setLabel(e.target.value)}
          />
          {/* The helper. Optional — the two boxes work perfectly without it. */}
          <ArenaAiHelp text={label} purpose="entry" onAccept={setLabel} compact />
          <ArenaAiIdeas
            kind={kind} capUsd={Math.round(cap / 100)}
            hint={kind === 'business' ? 'Something that would help you write more loans' : 'Something you would actually like'}
            onPick={(i) => {
              setLabel(i.label || '');
              if (i.valueUsd != null) setValue(String(i.valueUsd));
            }}
          />
          <input
            className="input" placeholder={`Roughly what it is worth (up to ${money(cap)})`} value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            className="btn" disabled={!label.trim() || busy === 'enter'}
            onClick={() => onAct('enter', async () => {
              await arena.enter(spin.id, { kind, label: label.trim(), value: value || '0' });
              setLabel(''); setValue('');
            })}
          >{busy === 'enter' ? 'Sending…' : 'Put it forward'}</button>
        </div>
      )}

      {!!myEntries.length && (
        <ul className="arena-mylist">
          {myEntries.map((e) => (
            <li key={e.id}>
              <span>{e.label} <em>{money(e.value_cents)}</em></span>
              <span className={`arena-status s-${e.status}`}>
                {e.status === 'approved' ? 'Accepted' : e.status === 'pending' ? 'Waiting' : 'Declined'}
              </span>
              {e.status === 'pending' && (
                <button className="btn ghost small" onClick={() => onAct('withdraw', () => arena.withdrawEntry(e.id))}>
                  Take it back
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- who is on it */

function WhoIsOn({ spin, roster, total, settings, isSuper, onAct }) {
  const checkins = spin.checkins || [];
  const pending = checkins.filter((c) => c.status === 'pending');
  return (
    <div className="arena-card">
      <h3>Who is on the wheel</h3>
      {roster.length
        ? (
          <>
            <p className="muted small">
              {roster.length} on the wheel, frozen before it turns.
              {settings.showOddsToEveryone !== false && total > 0 && ' Everyone can see the odds.'}
            </p>
            <ul className="arena-roster">
              {roster.map((c, i) => (
                <li key={`${c.key}-${i}`} className={c.weight === 0 ? 'out' : ''}>
                  <span>{c.label}</span>
                  {settings.showOddsToEveryone !== false && total > 0 && (
                    <em>{c.weight === 0 ? 'already won' : `${((c.weight / total) * 100).toFixed(1)}%`}</em>
                  )}
                </li>
              ))}
            </ul>
          </>
        )
        : (
          <>
            <p className="muted small">The wheel is set once check-in closes. Checked in so far:</p>
            <ul className="arena-roster">
              {checkins.map((c) => (
                <li key={c.id}>
                  <span>{c.full_name}</span>
                  <em className={`arena-status s-${c.status}`}>{c.status === 'approved' ? 'in' : c.status}</em>
                  {/* Take somebody off THIS spin — the server side existed since
                      phase 2 with no button anywhere (2026-08-19 audit). Only
                      before the wheel is set; it adds them to the excluded
                      list, and the same endpoint can put them back. */}
                  {isSuper && c.status === 'approved' && !['spinning', 'decided'].includes(spin.state) && (
                    <button className="btn ghost small" onClick={async () => {
                      if (!await askConfirm(`Take ${c.full_name} off this spin? They stay checked in — they just will not be on this wheel.`, { confirmLabel: 'Take them off' })) return;
                      onAct('roster', async () => {
                        const cur = await arena.spinRoster(spin.id);
                        const off = new Set((cur.excluded || []).map(String));
                        off.add(String(c.staff_id));
                        await arena.setSpinRoster(spin.id, [...off]);
                      });
                    }}>Take off this wheel</button>
                  )}
                  {isSuper && c.status === 'pending' && (
                    <span className="arena-decide">
                      <button className="btn ghost small" onClick={() => onAct('cin', () => arena.decideCheckin(c.id, 'approved'))}>Let in</button>
                      <button className="btn ghost small" onClick={async () => {
                        const reason = await askPrompt('Why not? The reason is shown to them.', { title: 'Turn this check-in down' });
                        if (reason === null) return;
                        onAct('cin', () => arena.decideCheckin(c.id, 'rejected', reason.trim() || undefined));
                      }}>No</button>
                    </span>
                  )}
                </li>
              ))}
              {!checkins.length && <li className="muted">Nobody yet.</li>}
            </ul>
            {isSuper && !!pending.length && (
              <button className="btn small" onClick={() => onAct('cin', async () => {
                // One failure must not silently strand the rest — approve what
                // can be approved and say exactly who could not be.
                const failed = [];
                for (const c of pending) {
                  try { await arena.decideCheckin(c.id, 'approved'); }
                  catch (e) { failed.push(`${c.full_name || 'somebody'}: ${(e && e.message) || 'failed'}`); }
                }
                if (failed.length) throw new Error(`${failed.length} could not be let in — ${failed.join('; ')}`);
              })}>Let all {pending.length} in</button>
            )}
          </>
        )}
    </div>
  );
}

/* ------------------------------------------------------------- qualifiers */

function Qualifiers({ spin, isSuper, onAct }) {
  const [openFor, setOpenFor] = useState(null);
  const [evidence, setEvidence] = useState('');
  return (
    <div className="arena-card">
      <h3>What could win</h3>
      <p className="muted small">
        Say which one you did and how we can see it. A super admin approves before your name goes on the wheel.
      </p>
      <ul className="arena-quals">
        {(spin.qualifiers || []).map((q) => (
          <li key={q.id}>
            <div className="arena-qual-head">
              <strong>{q.label}</strong>
              <em>{(q.claims || []).filter((c) => c.status === 'approved').length} in</em>
            </div>
            {q.description && <p className="muted small">{q.description}</p>}
            {spin.state === 'open' && (
              openFor === q.id
                ? (
                  <div className="arena-claimform">
                    <textarea
                      className="input" rows={2} value={evidence}
                      placeholder={q.evidence_hint || 'What did you do, and how can we see it?'}
                      onChange={(e) => setEvidence(e.target.value)}
                    />
                    <button
                      className="btn small" disabled={!evidence.trim()}
                      onClick={() => onAct('claim', async () => {
                        await arena.claim(q.id, { evidence: evidence.trim() });
                        setEvidence(''); setOpenFor(null);
                      })}
                    >Send it in</button>
                    <button className="btn ghost small" onClick={() => setOpenFor(null)}>Cancel</button>
                  </div>
                )
                : <button className="btn ghost small" onClick={() => { setOpenFor(q.id); setEvidence(''); }}>I did this one</button>
            )}
            {isSuper && !!(q.claims || []).length && (
              <ul className="arena-claims">
                {q.claims.map((c) => (
                  <li key={c.id}>
                    <span><strong>{c.full_name}</strong> — {c.evidence}</span>
                    {c.status === 'pending'
                      ? (
                        <span className="arena-decide">
                          <button className="btn ghost small" onClick={() => onAct('claim', () => arena.decideClaim(c.id, 'approved'))}>Yes</button>
                          <button className="btn ghost small" onClick={() => onAct('claim', () => arena.decideClaim(c.id, 'rejected'))}>No</button>
                        </span>
                      )
                      : <em className={`arena-status s-${c.status}`}>{c.status}</em>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ prizes */

function Prizes({ spin, isSuper, onAct }) {
  const entries = spin.entries || [];
  if (!entries.length) return null;
  const approved = entries.filter((e) => e.status === 'approved');
  const pending = entries.filter((e) => e.status === 'pending');
  return (
    <div className="arena-card">
      <h3>On the table</h3>
      {approved.length
        ? (
          <ul className="arena-prizes">
            {approved.map((e) => (
              <li key={e.id}>
                <span>{e.label}</span>
                <em>{money(e.value_cents)}{e.kind === 'business' ? ' · business' : ''}</em>
              </li>
            ))}
          </ul>
        )
        : <p className="muted small">Nothing accepted yet.</p>}
      {isSuper && !!pending.length && (
        <>
          <h4>Waiting on you ({pending.length})</h4>
          <ul className="arena-prizes">
            {pending.map((e) => (
              <li key={e.id}>
                <span>{e.label} <em className="muted">— {e.asked_by}</em></span>
                <em>{money(e.value_cents)}{e.kind === 'business' ? ' · business' : ''}</em>
                <span className="arena-decide">
                  <button className="btn ghost small" onClick={() => onAct('ent', () => arena.decideEntry(e.id, 'approved'))}>Accept</button>
                  <button className="btn ghost small" onClick={async () => {
                    const reason = await askPrompt('Why not? The reason is shown to them.', { title: 'Decline this prize idea' });
                    if (reason === null) return;
                    onAct('ent', () => arena.decideEntry(e.id, 'rejected', reason.trim() || undefined));
                  }}>Decline</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------- the admin's bar */

function AdminSpinBar({ spin, draws, busy, onAct }) {
  const [seed, setSeed] = useState('');
  const next = draws.find((d) => d.state !== 'revealed');
  return (
    <div className="arena-adminbar">
      {spin.state === 'draft' && (
        <button className="btn" disabled={!!busy} onClick={() => onAct('open', () => arena.openSpin(spin.id))}>
          Open it for check-in
        </button>
      )}
      {spin.state === 'open' && (
        <button className="btn" disabled={!!busy} onClick={() => onAct('lock', () => arena.lockSpin(spin.id))}>
          Close check-in and set the wheel
        </button>
      )}
      {['locked', 'spinning'].includes(spin.state) && next && (
        <>
          <input
            className="input arena-seedbox" value={seed} placeholder="A number from the room (optional)"
            onChange={(e) => setSeed(e.target.value)}
          />
          <button
            className="btn" disabled={!!busy}
            onClick={() => onAct('spin', async () => {
              await arena.turnWheel(spin.id, next.seq, seed.trim() || undefined);
              setSeed('');
            })}
          >{busy === 'spin' ? 'Spinning…' : `Spin ${next.title}`}</button>
        </>
      )}
      {spin.state !== 'decided' && spin.state !== 'cancelled' && (
        <button
          className="btn ghost" disabled={!!busy}
          onClick={async () => {
            if (await askConfirm('Cancel this spin? The record of it stays.')) {
              onAct('cancel', () => arena.cancelSpin(spin.id, 'Cancelled by the host'));
            }
          }}
        >Cancel this spin</button>
      )}
      <p className="muted small arena-adminnote">
        The wheel is worked out on the server before it turns, from a number locked in when the spin was
        created. You watch the same wheel as everybody else.
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- history */

function History({ spins, onProof }) {
  if (!spins.length) return <p className="muted">Nothing has been decided yet.</p>;
  return (
    <div className="arena-history">
      {spins.map((s) => (
        <article key={s.id} className="arena-card">
          <header className="arena-hist-head">
            <span className="arena-seq">Spin {s.seq}</span>
            <h3>{s.title}</h3>
            <time>{fmtTime(s.decided_at)}</time>
          </header>
          <ol className="arena-hist-draws">
            {(s.draws || []).map((d) => (
              <li key={d.id}>
                <span className="arena-hist-k">{d.title}</span>
                <strong>{d.winner_label || '—'}</strong>
                <span className="muted small">out of {(d.roster || []).length}</span>
                <button className="btn ghost small" onClick={() => onProof(d.id)}>Check it</button>
              </li>
            ))}
          </ol>
          {s.outcome_note && <p className="muted small">{s.outcome_note}</p>}
        </article>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- suggestions */

function Suggestions({ sessionId, isSuper }) {
  const [list, setList] = useState([]);
  const [body, setBody] = useState('');
  const load = useCallback(async () => {
    try { setList((await arena.suggestions(sessionId)).suggestions || []); } catch { /* the board still works */ }
  }, [sessionId]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="arena-card">
      <h3>What should we play next?</h3>
      <div className="arena-suggestform">
        <input
          className="input" value={body} maxLength={500} placeholder="An idea for the next spin…"
          onChange={(e) => setBody(e.target.value)}
        />
        <button
          className="btn small" disabled={!body.trim()}
          onClick={async () => {
            try { await arena.suggest(sessionId, body.trim()); setBody(''); await load(); }
            catch (e) { showMessage((e && e.message) || 'That did not send.'); }
          }}
        >Add it</button>
      </div>
      <ul className="arena-suggestions">
        {list.map((s) => (
          <li key={s.id}>
            <button
              className={`arena-vote${s.voted ? ' on' : ''}`}
              onClick={async () => {
                try { await arena.voteSuggestion(s.id, !s.voted); await load(); }
                catch (err) { showMessage((err && err.message) || 'The vote did not go through.', { tone: 'error' }); }
              }}
              aria-label={s.voted ? 'Take my vote back' : 'I like this one'}
            >▲ {s.votes}</button>
            <span>{s.body}</span>
            <em className="muted small">{s.full_name}</em>
            {isSuper && (
              <select
                className="input small" value={s.status}
                onChange={async (e) => {
                  try { await arena.setSuggestionStatus(s.id, e.target.value); await load(); }
                  catch (err) { showMessage((err && err.message) || 'That did not save.', { tone: 'error' }); }
                }}
              >
                {['new', 'planned', 'used', 'declined'].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            )}
          </li>
        ))}
        {!list.length && <li className="muted">No ideas yet. Add the first one.</li>}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- the noise */

function Celebration({ label }) {
  // Confetti drawn as plain elements — no library, no dependency, and it turns
  // itself off for anybody who asked their computer for less movement.
  const reduce = prefersReducedMotion();
  const bits = useMemo(
    () => (reduce ? [] : Array.from({ length: 60 }, (_, i) => ({
      i,
      left: (i * 37) % 100,
      delay: (i % 12) * 0.09,
      hue: (i * 47) % 360,
    }))),
    [reduce],
  );
  return (
    <div className="arena-celebrate" role="status" aria-live="polite">
      <div className="arena-celebrate-text">{label}</div>
      {bits.map((b) => (
        <span
          key={b.i}
          className="arena-confetti"
          style={{ left: `${b.left}%`, animationDelay: `${b.delay}s`, background: `hsl(${b.hue} 80% 60%)` }}
        />
      ))}
    </div>
  );
}
