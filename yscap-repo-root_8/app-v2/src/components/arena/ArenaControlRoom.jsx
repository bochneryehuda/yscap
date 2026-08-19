import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showMessage, askConfirm } from '../../lib/dialog.js';
import { arena, money } from '../../lib/arena.js';
import { ArenaAiIdeas } from './ArenaAiHelp.jsx';
import ArenaMonitor from './ArenaMonitor.jsx';

/* THE CONTROL ROOM — everything a super admin runs the day from.
 *
 * FIVE PANELS, and the order is the order of the day: the session, then the
 * spins, then the people waiting on a decision, then the prize list, then the
 * settings. Nobody should have to leave the board to run it.
 *
 * THE NEW-SPIN BUILDER IS THE POINT. Every game in the catalog arrives with its
 * questions already answered — the wheels it uses, whether people check in,
 * whether they can name a prize, how the odds work, how long it turns. That is
 * what "pre-filled, not custom-coded" means: the admin changes what they want
 * and presses go, and nothing about the game they picked is hidden in code.
 *
 * IT SHOWS WHAT IT CANNOT DO. A game that needs a call log carries the note
 * saying PILOT has no call log and that it runs on people claiming what they
 * did. Discovering that at 11:30 on the day would be the expensive way to learn
 * it.
 */
export default function ArenaControlRoom({ board, onChanged }) {
  // The monitor first: during a live session it is the screen you actually
  // want open, and it is the only one that tells you whether anything needs you.
  const [panel, setPanel] = useState('monitor');
  const [catalog, setCatalog] = useState(null);
  const [catalogErr, setCatalogErr] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionsErr, setSessionsErr] = useState('');
  const session = board && board.session;

  const loadSessions = useCallback(async () => {
    setSessionsErr('');
    try { setSessions((await arena.sessions()).sessions || []); }
    catch (e) { setSessionsErr((e && e.message) || 'The sessions could not be loaded.'); }
  }, []);

  const loadCatalog = useCallback(() => {
    setCatalogErr('');
    arena.catalog().then(setCatalog)
      .catch((e) => setCatalogErr((e && e.message) || 'The games could not be loaded.'));
  }, []);

  useEffect(() => {
    loadCatalog();
    loadSessions();
  }, [loadCatalog, loadSessions]);

  const panels = [
    ['monitor', 'Live monitor'],
    ['quick', 'Quick spin'],
    ['ready', 'Ready to go'],
    ['spin', 'New spin'],
    ['rematch', 'Rematch'],
    ['challenges', 'The day\u2019s challenges'],
    ['sessions', 'Sessions'],
    ['queue', 'Waiting on you'],
    ['prizes', 'Prize list'],
    ['mail', 'Messages sent'],
    ['settings', 'Settings'],
  ];

  return (
    <div className="arena-control">
      <nav className="arena-subtabs">
        {panels.map(([k, l]) => (
          <button key={k} className={`arena-subtab${panel === k ? ' on' : ''}`} onClick={() => setPanel(k)}>{l}</button>
        ))}
      </nav>

      {panel === 'monitor' && (
        session
          ? <ArenaMonitor sessionId={session.id} />
          : <p className="muted">Nothing running. Start a session under Sessions.</p>
      )}
      {panel === 'ready' && (
        session
          ? <ReadyMade session={session} onChanged={onChanged} />
          : <p className="muted">Start a session first, over in Sessions.</p>
      )}
      {panel === 'challenges' && (
        session
          ? <ChallengeDay session={session} onChanged={onChanged} />
          : <p className="muted">Start a session first.</p>
      )}
      {panel === 'spin' && (
        session
          ? <NewSpin catalog={catalog} catalogErr={catalogErr} onRetryCatalog={loadCatalog} session={session} onChanged={onChanged} />
          : <p className="muted">Start a session first, over in Sessions.</p>
      )}
      {panel === 'rematch' && (
        session
          ? <Rematch session={session} onChanged={onChanged} />
          : <p className="muted">Start a session first.</p>
      )}
      {panel === 'sessions' && (
        <Sessions
          sessions={sessions}
          loadErr={sessionsErr}
          onRetry={loadSessions}
          onReload={() => { loadSessions(); onChanged(); }}
        />
      )}
      {panel === 'quick' && (
        session
          ? <QuickSpin session={session} onChanged={onChanged} />
          : <p className="muted">Start a session first, over in Sessions.</p>
      )}
      {panel === 'queue' && (session ? <Queue board={board} onChanged={onChanged} /> : <p className="muted">No session running.</p>)}
      {panel === 'prizes' && <PrizeList />}
      {panel === 'mail' && <ArenaOutbox />}
      {panel === 'settings' && <SettingsPanel />}
    </div>
  );
}

/* ------------------------------------------------------------- the rematch */

/*
 * THE LAST TWO, HEAD TO HEAD.
 *
 * The owner: "a rematch spin — the last two standing, head to head, one wheel."
 * This is the half-past-five moment, so the whole panel is built for speed:
 * PILOT proposes the pair and says how it worked it out, and the button both
 * creates the duel AND opens it, because a duel that needs a second click is a
 * duel the room has already stopped watching.
 *
 * THE SUGGESTION IS NEVER BINDING. Both names are ordinary pickers pre-filled
 * with the proposal — the person running the day always knows better than the
 * computer who the room wants to see, and the reason is printed so nobody has
 * to argue about where the pair came from.
 *
 * THE CHALLENGER HOLDS THE STOP BUTTON, and it says so before anyone commits.
 * Handing it to whoever is ahead would make the last spin of the day look like
 * the house pressing its own button.
 */
function Rematch({ session, onChanged }) {
  const [people, setPeople] = useState([]);
  const [suggestion, setSuggestion] = useState(null);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [holder, setHolder] = useState('');
  const [prize, setPrize] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [err, setErr] = useState('');
  const [sugErr, setSugErr] = useState('');
  const [tryCount, setTryCount] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr('');
    setSugErr('');
    arena.people(session.id)
      .then((r) => { if (alive) setPeople(r.people || []); })
      .catch((e) => { if (alive) setErr((e && e.message) || 'The team list could not be loaded.'); });
    arena.rematchSuggestion(session.id)
      .then((r) => {
        if (!alive) return;
        setSuggestion(r);
        // The suggestion orders the leader first, so the SECOND name is the
        // challenger and holds the button by default.
        if (r && r.pair && r.pair.length === 2) {
          setA(String(r.pair[0].id));
          setB(String(r.pair[1].id));
          setHolder(String(r.pair[1].id));
        }
      })
      .catch((e) => { if (alive) setSugErr((e && e.message) || 'The suggested pair could not be loaded.'); });
    return () => { alive = false; };
  }, [session.id, tryCount]);

  const nameOf = (id) => (people.find((p) => String(p.id) === String(id)) || {}).full_name || '';
  const bad = !a || !b || String(a) === String(b);

  const go = async () => {
    if (bad) return;
    if (!await askConfirm(
      `Put ${nameOf(a)} and ${nameOf(b)} head to head now? Everybody's screen will show it, and `
      + `${nameOf(holder || b)} gets the stop button.`)) return;
    setBusy(true);
    try {
      const r = await arena.rematch(session.id, {
        staffIds: [a, b], stopHolderStaffId: holder || b, prizeLabel: prize.trim() || null,
      });
      setMade(r);
      onChanged();
    } catch (e) {
      showMessage((e && e.message) || 'That rematch could not be set up.');
    } finally { setBusy(false); }
  };

  return (
    <section className="arena-card">
      <h3>Rematch</h3>
      <p className="muted small">
        Two names, one wheel, one stop button. It opens the moment you press the button,
        so everybody sees it at once.
      </p>

      {((err && !people.length) || (sugErr && !suggestion)) && (
        <p className="arena-bad small">
          {(err && !people.length) ? err : sugErr}{' '}
          <button className="btn ghost small" onClick={() => setTryCount((n) => n + 1)}>Try again</button>
        </p>
      )}

      {suggestion && (
        <p className={`arena-rm-why${suggestion.pair && suggestion.pair.length === 2 ? ' good' : ''}`}>
          {suggestion.pair && suggestion.pair.length === 2
            ? <>Suggested: <strong>{suggestion.pair[0].name}</strong> v <strong>{suggestion.pair[1].name}</strong> — {suggestion.why}</>
            : suggestion.why}
        </p>
      )}

      <div className="arena-rm-grid">
        <label>
          <span>First up</span>
          <select value={a} onChange={(e) => setA(e.target.value)}>
            <option value="">Pick somebody</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
        <span className="arena-rm-v" aria-hidden="true">v</span>
        <label>
          <span>Against</span>
          <select value={b} onChange={(e) => { setB(e.target.value); if (!holder) setHolder(e.target.value); }}>
            <option value="">Pick somebody</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </label>
      </div>

      <label className="arena-rm-full">
        <span>What they are playing for (optional)</span>
        <input className="input" value={prize} onChange={(e) => setPrize(e.target.value)}
          placeholder="Lunch on the company" maxLength={120} />
      </label>

      <label className="arena-rm-full">
        <span>Who holds the stop button</span>
        <select value={holder} onChange={(e) => setHolder(e.target.value)}>
          {[a, b].filter(Boolean).map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
        </select>
        <em className="muted small">
          Give it to the challenger. It really does stop the wheel, and where it lands is down to
          when they press — nobody can aim it.
        </em>
      </label>

      {a && b && String(a) === String(b) && (
        <p className="arena-bad">Two different people, or it is not much of a duel.</p>
      )}

      <button className="btn primary" disabled={bad || busy} onClick={go}>
        {busy ? 'Setting it up…' : 'Put them head to head'}
      </button>

      {made && (
        <>
          <p className="arena-good">
            {(made.pair || []).map((p) => p.name).join(' v ')} are on the wheel. {made.stopHolderName} has the stop button.
          </p>
          {/* A wheel that could not be frozen is a FAILURE, not a footnote on
              the success line — it means the duel is not actually ready. */}
          {made.freezeError && (
            <p className="arena-bad">The wheel could not be frozen: {made.freezeError} Fix that before you spin.</p>
          )}
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------- ready to go */

/*
 * THE TWO PLANS THE OWNER DESCRIBED, one click each.
 *
 * The date and the room's clock offset are read from THIS browser and sent up,
 * because "10:30" means half past ten where the people are, and the server is
 * in whatever region it happens to be in.
 */
function ReadyMade({ session, onChanged }) {
  const [list, setList] = useState([]);
  const [day, setDay] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState(null);

  const [err, setErr] = useState('');

  const loadTemplates = useCallback(() => {
    setErr('');
    arena.templates().then((r) => setList(r.templates || []))
      .catch((e) => setErr((e && e.message) || 'The plans could not be loaded.'));
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const load = async (key, label) => {
    const sure = await askConfirm(
      `Load "${label}" into this session for ${day}? It arrives as a draft, and loading the Mega Spin `
      + 'replaces any challenge plan already scheduled for the day.', { confirmLabel: 'Load it' });
    if (!sure) return;
    setBusy(key); setDone(null);
    try {
      const r = await arena.loadTemplate(session.id, key, {
        day,
        // THE SIGN MATTERS AND IT IS NEGATIVE. getTimezoneOffset() is minutes
        // BEHIND UTC (+240 in New York); the server's `at()` wants minutes
        // AHEAD of UTC (-240 there). Passing it un-negated shifted every time
        // by TWICE the offset — the 10:30 Early Bird would have auto-launched
        // at 2:30 in the morning. Same expression as DaySetup, on purpose.
        offsetMinutes: -new Date().getTimezoneOffset(),
      });
      if (r && r.revived) {
        showMessage(r.message || 'That plan had been called off — it is back now as a draft.', { title: 'Brought back', tone: 'info' });
      } else if (r && r.alreadyThere) {
        showMessage(r.message || 'That plan is already in this session.', { title: 'Already there', tone: 'info' });
      }
      setDone(r);
      await onChanged();
    } catch (e) {
      showMessage((e && e.message) || 'That could not be loaded.', { tone: 'error' });
    } finally { setBusy(''); }
  };

  return (
    <div className="arena-card">
      <h3>Ready to go</h3>
      <p className="muted small">
        Both of these arrive completely filled in — times, wording, wheels and all. Load one, look it over,
        change anything you like, then open it. Nothing goes out until you say so.
      </p>
      <label className="arena-fullfield" style={{ maxWidth: 220 }}>Which day
        <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      </label>
      {err && !list.length && (
        <p className="arena-bad small">{err} <button className="btn ghost small" onClick={loadTemplates}>Try again</button></p>
      )}
      <div className="arena-gamegrid">
        {list.map((t) => (
          <div key={t.key} className="arena-game" style={{ cursor: 'default' }}>
            <strong>{t.label}</strong>
            <span>{t.blurb}</span>
            <ul className="muted small" style={{ margin: '6px 0 0 16px' }}>
              {(t.howItReads || []).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
            <button className="btn small" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => load(t.key, t.label)}>
              {busy === t.key ? 'Loading…' : 'Load it'}
            </button>
          </div>
        ))}
      </div>
      {done && (
        <div className="arena-gamedetail">
          <p><strong>Loaded.</strong> It is sitting as a draft — open it when you are ready.</p>
          {done.challengesPlanned > 0 && (
            <p>{done.challengesPlanned} challenges are scheduled across the day. You can see and change every one of them under “The day’s challenges”.</p>
          )}
          <p className="muted small"><strong>Email subject:</strong> {done.emailSubject}</p>
          <p className="muted small">{done.announcement}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ the day's plan */

/*
 * EVERY CHALLENGE THAT IS COMING, and the ability to change any of it.
 *
 * The owner: "I should be able to see the entire time which challenge is going
 * to populate the next time, and I can change the setting, and I can choose any
 * other challenge that you have for the schedule and skip that one that is
 * going to populate. I can enter new ones to populate."
 */
function ChallengeDay({ session, onChanged }) {
  const [board, setBoard] = useState(null);
  const [lib, setLib] = useState(null);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null);

  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      setBoard(await arena.challenges(session.id));
      if (!lib) setLib(await arena.challengeLibrary());
    } catch (e) { setErr((e && e.message) || 'The day could not be loaded.'); }
  }, [session.id, lib]);
  useEffect(() => { load(); }, [load]);

  const change = async (id, body, label) => {
    setBusy(label || id);
    try { await arena.updateChallenge(id, body); await load(); if (onChanged) onChanged(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.'); }
    finally { setBusy(''); }
  };

  if (!board) {
    return err
      ? <p className="arena-bad small">{err} <button className="btn ghost small" onClick={load}>Try again</button></p>
      : <p className="muted">Loading the day…</p>;
  }
  const upcoming = board.upcoming || [];
  const live = board.live || [];

  return (
    <div className="arena-card">
      <h3>The day’s challenges</h3>
      <p className="muted small">
        These land on everybody’s screen through the afternoon — never on the dot, and never more than two at
        once. Change any of them, skip one, or start one right now.
      </p>

      {!!live.length && (
        <>
          <h4>Live now</h4>
          <ul className="arena-queue">
            {live.map((c) => (
              <li key={c.id}>
                <span className={`arena-ch-tier t${c.tier}`}>{c.tierLabel}</span>
                <span><strong>{c.title}</strong> — {c.prompt}</span>
                <span className="arena-decide">
                  <button className="btn ghost small" disabled={!!busy}
                    onClick={() => setEditing(editing === c.id ? null : c.id)}>Edit</button>
                  <button className="btn ghost small" disabled={!!busy}
                    onClick={() => change(c.id, { state: 'closed' }, c.id)}>Close it</button>
                </span>
                {editing === c.id && (
                  <ChallengeEdit challenge={c} live onSaved={() => { setEditing(null); load(); }} />
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Coming up ({upcoming.length})</h4>
      <ul className="arena-queue">
        {upcoming.map((c) => (
          <li key={c.id}>
            <time className="muted small">
              {c.opensAt ? new Date(c.opensAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'}
            </time>
            <span className={`arena-ch-tier t${c.tier}`}>{c.tierLabel}</span>
            <span><strong>{c.title}</strong> — {c.prompt}</span>
            <em className="muted small">{c.ticketsAwarded} chances · {c.awardMode === 'everyone' ? 'anybody' : `first ${c.slots}`}</em>
            <span className="arena-decide">
              <button className="btn ghost small" disabled={!!busy}
                onClick={() => setEditing(editing === c.id ? null : c.id)}>Edit</button>
              <button className="btn ghost small" disabled={!!busy}
                onClick={async () => {
                  // A live challenge takes over every screen in the building.
                  if (!await askConfirm(`Start "${c.title}" right now? It pops up on everyone's screen the moment you do.`, { confirmLabel: 'Start it now' })) return;
                  change(c.id, { state: 'live' }, c.id);
                }}>Start now</button>
              <button className="btn ghost small" disabled={!!busy}
                onClick={() => change(c.id, { state: 'skipped' }, c.id)}>Skip</button>
            </span>
            {editing === c.id && (
              <ChallengeEdit challenge={c} onSaved={() => { setEditing(null); load(); }} />
            )}
          </li>
        ))}
        {!upcoming.length && <li className="muted">Nothing scheduled. Load the Mega Spin under “Ready to go”, or add one below.</li>}
      </ul>

      <AddChallenge session={session} lib={lib} onAdded={load} />
      <HandOutChances session={session} />
    </div>
  );
}

/** Give somebody extra chances by hand — or take them back — always with a
 *  reason, because the reason shows up on their own list. The server route
 *  existed from day one; this is its screen (owner: "all the admin settings
 *  that you left"). */
function HandOutChances({ session }) {
  const [everyone, setEveryone] = useState(null);
  const [who, setWho] = useState('');
  const [count, setCount] = useState(1);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    arena.roster().then((d) => setEveryone(d.everyone || [])).catch(() => setEveryone([]));
  }, []);
  const give = async () => {
    setBusy(true); setNote('');
    try {
      const r = await arena.giveTickets(session.id, { staffId: who, count: Math.trunc(Number(count)), reason: reason.trim() });
      const name = (everyone || []).find((p) => String(p.id) === who);
      const total = r && r.standing && Number.isFinite(Number(r.standing.tickets)) ? ` They now have ${r.standing.tickets}.` : '';
      setNote(`Done — ${name ? name.full_name : 'they'} ${Number(count) > 0 ? `got ${count}` : `lost ${Math.abs(count)}`} chance${Math.abs(count) === 1 ? '' : 's'}.${total}`);
      setReason('');
    } catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <div className="arena-daysetup" style={{ marginTop: 14 }}>
      <h4>Hand out chances by hand</h4>
      <p className="muted small">
        Extra chances go onto the person's wheel odds for the ticket spins. A negative number takes
        chances back. The reason shows on their own list, so write it as you would say it to them.
      </p>
      <div className="arena-form">
        <label>Who
          <select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Pick a person…</option>
            {(everyone || []).map((p) => <option key={p.id} value={String(p.id)}>{p.full_name}</option>)}
          </select>
        </label>
        <label>How many (negative takes back)
          <input className="input" type="number" min="-20" max="20" value={count} onChange={(e) => setCount(e.target.value)} />
        </label>
        <label>Why
          <input className="input" value={reason} placeholder="Closed the Rodriguez file" onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      <button className="btn small" disabled={busy || !who || !reason.trim() || !Math.trunc(Number(count))} onClick={give}>
        {busy ? 'Working…' : 'Give them'}
      </button>
      {note && <p className="arena-good small">{note}</p>}
    </div>
  );
}

/** Edit a challenge's wording — name, one-line description, and the longer
 *  instructions — LIVE ones included (owner, 2026-08-19: "even after it's
 *  live, I should be able to edit the name … description and instructions").
 *  A live edit lands on everyone's screen the moment it saves. */
function ChallengeEdit({ challenge, live, onSaved }) {
  const [title, setTitle] = useState(challenge.title || '');
  const [prompt, setPrompt] = useState(challenge.prompt || '');
  const [detail, setDetail] = useState(challenge.detail || '');
  const [awardMode, setAwardMode] = useState(challenge.awardMode || 'everyone');
  const [slots, setSlots] = useState(challenge.slots || 1);
  const [tickets, setTickets] = useState(challenge.ticketsAwarded == null ? 1 : challenge.ticketsAwarded);
  const [closes, setCloses] = useState(toLocalInput(challenge.closesAt));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (live && !await askConfirm('This challenge is live — the new wording and rules land on everyone\u2019s screen the moment you save. Save it?', { confirmLabel: 'Save it' })) return;
    setSaving(true);
    try {
      await arena.updateChallenge(challenge.id, {
        title: title.trim() || null,
        prompt: prompt.trim() || null,
        detail: detail.trim() || null,
        awardMode,
        slots: awardMode === 'everyone' ? null : (awardMode === 'first' ? 1 : Math.max(1, Math.floor(Number(slots) || 1))),
        ticketsAwarded: Math.max(0, Math.floor(Number(tickets) || 0)),
        closesAt: closes ? fromLocalInput(closes) : null,
      });
      showMessage('The challenge is updated.', { title: 'Saved', tone: 'info' });
      onSaved();
    } catch (e) { showMessage((e && e.message) || 'That did not save.', { tone: 'error' }); }
    finally { setSaving(false); }
  };
  return (
    <div className="arena-form" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
      <label>Name<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>One line — what to do
        <input className="input" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label style={{ gridColumn: '1 / -1' }}>Instructions (the longer wording under it)
        <textarea className="input" rows={3} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </label>
      <label>Who can win it
        <select className="input" value={awardMode} onChange={(e) => setAwardMode(e.target.value)}>
          <option value="everyone">Anybody who does it</option>
          <option value="first">Only the FIRST one — it closes itself when claimed</option>
          <option value="first_n">The first few — it closes itself when they are gone</option>
        </select>
      </label>
      {awardMode === 'first_n' && (
        <label>How many places
          <input className="input" type="number" min="1" max="20" value={slots} onChange={(e) => setSlots(e.target.value)} />
        </label>
      )}
      <label>Chances it pays
        <input className="input" type="number" min="0" max="10" value={tickets} onChange={(e) => setTickets(e.target.value)} />
      </label>
      <label>Closes on its own at
        <input className="input" type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} />
      </label>
      <button className="btn small" disabled={saving || !title.trim() || !prompt.trim()} onClick={save}>
        {saving ? 'Saving…' : 'Save the challenge'}
      </button>
    </div>
  );
}

function AddChallenge({ session, lib, onAdded }) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState(2);
  const [proof, setProof] = useState('text');
  const [award, setAward] = useState('everyone');
  const [saving, setSaving] = useState(false);

  return (
    <details className="arena-advanced">
      <summary>Add one of your own</summary>
      <ArenaAiIdeas
        what="challenges"
        hint="What sort of challenge? e.g. something about referral partners"
        onPick={(i) => {
          setTitle(i.title || '');
          setPrompt(i.prompt || '');
          if (i.tier) setTier(Number(i.tier));
          if (i.proofType) setProof(i.proofType);
          if (i.awardMode) setAward(i.awardMode);
        }}
      />
      <div className="arena-form">
        <label>What to call it<input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>How hard
          <select className="input" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
            {((lib && lib.tiers) || []).map((t) => (
              <option key={t.tier} value={t.tier}>{t.label} — {t.tickets} chances</option>
            ))}
          </select>
        </label>
        <label>How they prove it
          <select className="input" value={proof} onChange={(e) => setProof(e.target.value)}>
            {((lib && lib.proofTypes) || []).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label>Who can win it
          <select className="input" value={award} onChange={(e) => setAward(e.target.value)}>
            {((lib && lib.awardModes) || []).map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </label>
      </div>
      <label className="arena-fullfield">What people read on screen
        <textarea className="input" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <button className="btn small" disabled={!title.trim() || !prompt.trim() || saving} onClick={async () => {
        // Same warning as Start now: this takes over every screen right away.
        if (!await askConfirm(`Put "${title.trim()}" out right now? It pops up on everyone's screen the moment you do.`, { confirmLabel: 'Put it out' })) return;
        setSaving(true);
        try {
          // A hand-added challenge gets a CLOSING TIME (20 minutes), or the
          // sweep can never close it and it sits live on every screen until
          // somebody remembers (found by the 2026-08-19 audit — the sweep only
          // closes rows whose closes_at is set).
          await arena.addChallenge(session.id, {
            title: title.trim(), prompt: prompt.trim(), tier, proofType: proof, awardMode: award,
            startNow: true, closesInMinutes: 20,
          });
          setTitle(''); setPrompt('');
          await onAdded();
        } catch (e) { showMessage((e && e.message) || 'That did not save.', { tone: 'error' }); }
        finally { setSaving(false); }
      }}>Put it out now</button>
    </details>
  );
}

/* ------------------------------------------------------------ new spin */

function NewSpin({ catalog, catalogErr, onRetryCatalog, session, onChanged }) {
  const [kind, setKind] = useState('elementix_double');
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [config, setConfig] = useState(null);
  const [quals, setQuals] = useState('');
  const [saving, setSaving] = useState(false);
  const [family, setFamily] = useState('signature');

  const game = useMemo(
    () => (catalog ? (catalog.games || []).find((g) => g.key === kind) : null),
    [catalog, kind],
  );

  // Whenever the game changes, the form resets to THAT game's pre-filled
  // answers. Carrying the previous game's settings over would be a quiet way to
  // run a spin nobody actually configured.
  useEffect(() => {
    if (game) { setConfig({ ...game.defaults }); setTitle((t) => t || game.label); }
  }, [game]);

  // The helper's draft. Applied AFTER the reset above (its own effect, keyed on
  // the draft), so switching the game to the suggested one cannot wipe what
  // the draft filled in. Everything lands in the ordinary boxes for a human to
  // read and change — the helper never creates anything by itself.
  const [aiText, setAiText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');
  const [aiDraft, setAiDraft] = useState(null);
  useEffect(() => {
    if (!aiDraft) return;
    if (aiDraft.title) setTitle(aiDraft.title);
    if (aiDraft.subtitle) setSubtitle(aiDraft.subtitle);
    if (Array.isArray(aiDraft.qualifiers) && aiDraft.qualifiers.length) setQuals(aiDraft.qualifiers.join('\n'));
    setConfig((c) => {
      const next = { ...(c || {}) };
      if (Number.isFinite(Number(aiDraft.personalCapUsd)) && aiDraft.personalCapUsd != null) next.personalCapCents = Math.round(Number(aiDraft.personalCapUsd) * 100);
      if (Number.isFinite(Number(aiDraft.businessCapUsd)) && aiDraft.businessCapUsd != null) next.businessCapCents = Math.round(Number(aiDraft.businessCapUsd) * 100);
      return next;
    });
  }, [aiDraft]);
  const draftIt = async () => {
    setAiBusy(true); setAiNote('');
    try {
      const r = await arena.aiSpin(aiText.trim());
      if (!r || !r.ok) { setAiNote((r && r.reason) || 'The helper is not switched on.'); return; }
      const d = r.draft || {};
      if (d.suggestedGameKey) {
        const g = (catalog.games || []).find((x) => x.key === d.suggestedGameKey);
        if (g) { setFamily(g.family); setKind(g.key); }
      }
      setAiDraft(d);
      setAiNote(d.notes ? `Drafted. Worth checking: ${d.notes}` : 'Drafted — read it over, change anything, then create it.');
    } catch (e) { setAiNote((e && e.message) || 'That did not work.'); }
    finally { setAiBusy(false); }
  };

  if (!catalog) {
    return catalogErr
      ? <p className="arena-bad small">{catalogErr} <button className="btn ghost small" onClick={onRetryCatalog}>Try again</button></p>
      : <p className="muted">Loading the games…</p>;
  }
  const families = catalog.families || [];
  const games = (catalog.games || []).filter((g) => g.family === family);
  const aiBox = (
    <div className="arena-daysetup">
      <h4>Describe it, and the helper drafts the form</h4>
      <div className="arena-form">
        <label style={{ gridColumn: '1 / -1' }}>What do you want this spin to be?
          <input className="input" value={aiText} placeholder="A spin between everyone who booked a call today, winner picks lunch"
            onChange={(e) => setAiText(e.target.value)} />
        </label>
      </div>
      <button className="btn ghost small" disabled={aiBusy || aiText.trim().length < 8} onClick={draftIt}>
        {aiBusy ? 'Drafting…' : 'Draft it for me'}
      </button>
      {aiNote && <p className="muted small">{aiNote}</p>}
    </div>
  );
  const usesQualifiers = game && (game.wheels || []).some((w) => w.source === 'qualifiers' || w.source === 'qualifier_claimants');

  const set = (k, v) => setConfig((c) => ({ ...c, [k]: v }));

  const create = async () => {
    setSaving(true);
    try {
      await arena.createSpin(session.id, {
        title: title.trim() || (game && game.label) || 'Spin',
        subtitle: subtitle.trim() || null,
        kind,
        config,
        entryDeadlineAt: deadline ? new Date(deadline).toISOString() : null,
        qualifiers: usesQualifiers
          ? quals.split('\n').map((s) => s.trim()).filter(Boolean).map((label) => ({ label }))
          : undefined,
      });
      setTitle(''); setSubtitle(''); setQuals('');
      await onChanged();
      showMessage('Spin created. Open it when you are ready for people to check in.', { title: 'Created', tone: 'info' });
    } catch (e) {
      showMessage((e && e.message) || 'That spin could not be created.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="arena-card">
      <h3>Set up the next spin</h3>

      {aiBox}

      <div className="arena-famrow">
        {families.map((f) => (
          <button key={f.key} className={`arena-chip${family === f.key ? ' on' : ''}`} onClick={() => setFamily(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      <p className="muted small">{(families.find((f) => f.key === family) || {}).blurb}</p>

      <div className="arena-gamegrid">
        {games.map((g) => (
          <button key={g.key} className={`arena-game${kind === g.key ? ' on' : ''}`} onClick={() => setKind(g.key)}>
            <strong>{g.label}</strong>
            <span>{g.blurb}</span>
          </button>
        ))}
      </div>

      {game && (
        <div className="arena-gamedetail">
          <p>{game.howItWorks}</p>
          {game.dataNote && <p className="arena-datanote">{game.dataNote}</p>}
          <p className="muted small">Where this came from: {game.origin}</p>
          <ol className="arena-wheels">
            {(game.wheels || []).map((w, i) => (
              <li key={i}><strong>Wheel {i + 1}: {w.title}</strong> <em className="muted">{w.sourceLabel}</em></li>
            ))}
          </ol>
        </div>
      )}

      <div className="arena-form">
        <label>What to call it
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>A line underneath (optional)
          <input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
        </label>
        <label>Check-in closes at
          <input className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
      </div>

      {usesQualifiers && (
        <label className="arena-fullfield">What could win — one per line
          <textarea
            className="input" rows={4} value={quals}
            placeholder={'A call over ten minutes\nA tough rejection you stayed on\nClosed a deal today'}
            onChange={(e) => setQuals(e.target.value)}
          />
        </label>
      )}

      {config && (
        <details className="arena-advanced">
          <summary>The settings for this spin ({Object.keys(config).length})</summary>
          <div className="arena-form">
            <Toggle label="People must check in" v={config.checkinRequired} on={(v) => set('checkinRequired', v)} />
            <Toggle label="Wave check-ins through automatically" v={config.autoApproveCheckins} on={(v) => set('autoApproveCheckins', v)} />
            <Toggle label="People can say what they want to win" v={config.entriesAllowed} on={(v) => set('entriesAllowed', v)} />
            <Toggle label="Accept those automatically" v={config.autoApproveEntries} on={(v) => set('autoApproveEntries', v)} />
            <label>How the odds work
              <select className="input" value={config.weightMode} onChange={(e) => set('weightMode', e.target.value)}>
                {(arenaWeightModes()).map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </label>
            <label>Somebody who already won today
              <select className="input" value={config.removeWinner} onChange={(e) => set('removeWinner', e.target.value)}>
                <option value="keep">stays on with the same chance</option>
                <option value="zero">stays visible but cannot win again</option>
                <option value="remove">comes off the wheel</option>
              </select>
            </label>
            <label>How long the wheel turns (seconds)
              <input
                className="input" type="number" min="2" max="60"
                value={Math.round((config.durationMs || 7000) / 1000)}
                onChange={(e) => set('durationMs', Math.round(Number(e.target.value) * 1000))}
              />
            </label>
            <label>How many full turns
              <input
                className="input" type="number" min="1" max="30" value={config.fullTurns || 6}
                onChange={(e) => set('fullTurns', Number(e.target.value))}
              />
            </label>
            <label>Most on one wheel
              <input
                className="input" type="number" min="2" max="500" value={config.maxCandidates || 60}
                onChange={(e) => set('maxCandidates', Number(e.target.value))}
              />
            </label>
            {(game && (game.wheels || []).some((w) => w.source === 'closed_files_window')) && (
              <label>How many days back
                <input
                  className="input" type="number" min="1" max="365" value={config.windowDays || 7}
                  onChange={(e) => set('windowDays', Number(e.target.value))}
                />
              </label>
            )}
            <label>Personal prize cap
              <input
                className="input" type="number" min="0"
                value={Math.round((config.personalCapCents ?? 50000) / 100)}
                onChange={(e) => set('personalCapCents', Math.round(Number(e.target.value) * 100))}
              />
            </label>
            <label>Business prize cap
              <input
                className="input" type="number" min="0"
                value={Math.round((config.businessCapCents ?? 100000) / 100)}
                onChange={(e) => set('businessCapCents', Math.round(Number(e.target.value) * 100))}
              />
            </label>
          </div>
          {(config.customList !== undefined || (game && (game.wheels || []).some((w) => w.source === 'custom_list'))) && (
            <label className="arena-fullfield">What goes on the wheel — one per line
              <textarea
                className="input" rows={5} value={config.customList || ''}
                onChange={(e) => set('customList', e.target.value)}
              />
            </label>
          )}
        </details>
      )}

      <button className="btn" disabled={saving} onClick={create}>
        {saving ? 'Creating…' : 'Create this spin'}
      </button>
    </div>
  );
}

/* The weight modes, kept next to their one use. The server sends the real list
   on /catalog; this is the fallback so the form still renders if that call is
   slow, and the values match the server's exactly. */
const arenaWeightModes = () => ([
  { key: 'equal', label: 'Everyone equal (recommended)' },
  { key: 'tickets', label: 'Tickets earned — more tickets, better odds' },
  { key: 'entry', label: 'As recorded on each row' },
]);

function Toggle({ label, v, on }) {
  return (
    <label className="arena-toggle">
      <input type="checkbox" checked={!!v} onChange={(e) => on(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/* ------------------------------------------------------------- sessions */

/* Which colleagues belong to which quick-pick group. Client-side on purpose:
   the roles arrive with the roster, and a chip is only a fast way of ticking
   boxes the admin can still change one by one. */
const ROSTER_GROUPS = [
  { key: 'sales', label: 'Sales team', roles: ['loan_officer', 'account_executive'] },
  { key: 'back', label: 'Back office', roles: ['processor', 'underwriter', 'closer', 'draw_coordinator', 'loan_coordinator', 'account_manager'] },
  { key: 'admins', label: 'Admins', roles: ['admin', 'super_admin'] },
];

/* Plain words on the list, never a database key like "loan_officer". */
const ROLE_LABEL = {
  loan_officer: 'loan officer', account_executive: 'account executive',
  processor: 'processor', underwriter: 'underwriter', closer: 'closer',
  draw_coordinator: 'draw coordinator', loan_coordinator: 'loan coordinator',
  account_manager: 'account manager', admin: 'admin', super_admin: 'super admin',
};

/** The reusable tick-who-plays list: group chips on top, people underneath.
 *  A GROUP CHIP REPLACES THE SELECTION — press "Sales team" and exactly the
 *  sales people are ticked, nothing to un-tick (the owner's rule, 2026-08-19).
 *  Then add or take off individuals one by one, or find them with the search
 *  box. The chip that matches what is currently picked lights up. */
function RosterPicker({ everyone, picked, onChange }) {
  const [q, setQ] = useState('');
  const all = everyone.map((p) => String(p.id));
  const isAll = picked.length === all.length;
  const pickedSet = new Set(picked);
  const groupIds = (roles) => everyone.filter((p) => roles.includes(p.role)).map((p) => String(p.id));
  const sameSet = (ids) => ids.length === picked.length && ids.every((id) => pickedSet.has(id));
  const setGroup = (roles) => onChange(groupIds(roles));
  const toggle = (id) => onChange(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? everyone.filter((p) => `${p.full_name} ${ROLE_LABEL[p.role] || p.role}`.toLowerCase().includes(needle))
    : everyone;
  const activeGroup = !isAll && ROSTER_GROUPS.find((g) => sameSet(groupIds(g.roles)));
  return (
    <div className="arena-people">
      <div className="arena-group-chips">
        <button type="button" className={`btn ghost small${isAll ? ' on' : ''}`} onClick={() => onChange(all)}>Everyone</button>
        {ROSTER_GROUPS.map((g) => (
          <button
            key={g.key} type="button"
            className={`btn ghost small${!isAll && sameSet(groupIds(g.roles)) ? ' on' : ''}`}
            onClick={() => setGroup(g.roles)}
          >{g.label}</button>
        ))}
        <button type="button" className="btn ghost small" onClick={() => onChange([])}>Clear</button>
      </div>
      <p className="muted small">
        {isAll
          ? 'Everyone is in — the whole team, including anyone who joins later.'
          : activeGroup
            ? `${activeGroup.label} only — ${picked.length} people. Tick anyone below to add them, or un-tick to take them off.`
            : `${picked.length} of ${everyone.length} picked. Only these people can play.`}
      </p>
      <input
        className="input" placeholder="Find a person…" value={q}
        onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }}
      />
      <ul>
        {shown.map((p) => (
          <li key={p.id}>
            <label>
              <input type="checkbox" checked={pickedSet.has(String(p.id))} onChange={() => toggle(String(p.id))} />
              <span>{p.full_name}</span>
              <em className="muted small">{ROLE_LABEL[p.role] || p.role}</em>
            </label>
          </li>
        ))}
        {!shown.length && <li className="muted small">Nobody matches "{q}".</li>}
      </ul>
    </div>
  );
}

/* ------------------------------------------------ the day's plan, per spin */

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
};
const fromLocalInput = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : '—');

/** One pre-filled spin on the plan: what it is, when it opens and closes,
 *  boxes to CHANGE those times, and a button to open it right now. */
function PlanRow({ spin, sessionLive, onChanged }) {
  const [launch, setLaunch] = useState(toLocalInput(spin.launch_at));
  const [deadline, setDeadline] = useState(toLocalInput(spin.entry_deadline_at));
  const [title, setTitle] = useState(spin.title || '');
  const [sub, setSub] = useState(spin.subtitle || '');
  const [busy, setBusy] = useState(false);
  const done = ['decided', 'cancelled'].includes(spin.state);
  const running = spin.state === 'spinning';
  const wheels = Array.isArray(spin.config && spin.config.wheels) ? spin.config.wheels.length : 1;
  const saveTimes = async () => {
    setBusy(true);
    try {
      await arena.updateSpin(spin.id, {
        title: title.trim() || null,
        subtitle: sub.trim() || null,
        launchAt: launch ? fromLocalInput(launch) : null,
        entryDeadlineAt: deadline ? fromLocalInput(deadline) : null,
      });
      showMessage('Saved — the stage shows the new wording.', { title: 'Saved', tone: 'info' });
      onChanged();
    } catch (e) { showMessage((e && e.message) || 'That did not save.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  const openNow = async () => {
    const warn = sessionLive
      ? `Open "${spin.title}" for check-in right now? The team is told the moment it opens.`
      : `Open "${spin.title}" right now? NOTE: its session is not live yet, so the team cannot see the board `
        + 'until you press "Start it (go live)" on the session.';
    if (!await askConfirm(warn, { confirmLabel: 'Open it now' })) return;
    setBusy(true);
    try { await arena.openSpin(spin.id); onChanged(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!await askConfirm(`Call off "${spin.title}"? It stays on the record as cancelled.`, { confirmLabel: 'Call it off' })) return;
    setBusy(true);
    try { await arena.cancelSpin(spin.id, 'Called off from the plan'); onChanged(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <li className="arena-planrow">
      <div>
        <strong>{spin.title}</strong>
        <em className={`arena-status s-${spin.state}`}>{spin.state}</em>
        <span className="muted small">
          {wheels} wheel{wheels === 1 ? '' : 's'}
          {spin.launch_at ? ` · opens itself ${fmtWhen(spin.launch_at)}` : ''}
          {spin.entry_deadline_at ? ` · check-in closes ${fmtWhen(spin.entry_deadline_at)}` : ''}
        </span>
      </div>
      {spin.state === 'cancelled' && (
        <div className="arena-decide" style={{ marginTop: 6 }}>
          <button className="btn small" disabled={busy} onClick={async () => {
            if (!await askConfirm(`Bring "${spin.title}" back? It returns as a draft with its times kept — open it (or let it open itself) when ready.`, { confirmLabel: 'Bring it back' })) return;
            setBusy(true);
            try { await arena.reviveSpin(spin.id); onChanged(); }
            catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
            finally { setBusy(false); }
          }}>Bring it back</button>
        </div>
      )}
      {!done && !running && (
        <div className="arena-form arena-plantimes">
          <label>What it is called
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>A line underneath
            <input className="input" value={sub} onChange={(e) => setSub(e.target.value)} />
          </label>
          <label>Opens itself at
            <input className="input" type="datetime-local" value={launch} onChange={(e) => setLaunch(e.target.value)} />
          </label>
          <label>Check-in closes at
            <input className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <div className="arena-decide">
            <button className="btn ghost small" disabled={busy} onClick={saveTimes}>Save the wording and times</button>
            {spin.state === 'draft' && <button className="btn small" disabled={busy} onClick={openNow}>Open it now</button>}
            <button className="btn ghost small" disabled={busy} onClick={cancel}>Call it off</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** The whole plan for one session — every pre-filled spin, before anything is
 *  live. The owner asked for exactly this on the live day: "a list of all the
 *  pre-filled templates … edit it and change the time, go live right away." */
function SessionPlan({ session, onChanged }) {
  const [spins, setSpins] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    setErr('');
    arena.board(session.id)
      .then((b) => setSpins(b.spins || []))
      .catch((e) => setErr((e && e.message) || 'The plan could not be loaded.'));
  }, [session.id]);
  useEffect(load, [load]);
  const reload = () => { load(); onChanged(); };
  if (err) return <p className="arena-bad small">{err} <button className="btn ghost small" onClick={load}>Try again</button></p>;
  if (!spins) return <p className="muted small">Loading the plan…</p>;
  if (!spins.length) return <p className="muted small">Nothing planned in this session yet — use "Set up the whole day" above, or add a spin under New spin.</p>;
  return (
    <ul className="arena-plan">
      {[...spins].sort((a, b) => (a.seq || 0) - (b.seq || 0)).map((sp) => (
        <PlanRow key={sp.id} spin={sp} sessionLive={session.state === 'live'} onChanged={reload} />
      ))}
    </ul>
  );
}

/* "Everyone ticked" is sent as an EMPTY list on purpose: the server stores no
   member rows then, which genuinely means "the whole team" — somebody hired
   next week is in automatically. Sending the full list instead would PIN
   today's names, and the new hire would be refused at check-in (the exact trap
   the 2026-08-19 audit found). */
const staffIdsToSend = (picked, everyone) =>
  (picked.length === everyone.length ? [] : picked);

/** ONE press builds the whole day, ready to Start. */
function DaySetup({ onReload }) {
  const [day, setDay] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await arena.setupDay({ day, offsetMinutes: -new Date().getTimezoneOffset() });
      setResult(r);
      onReload();
    } catch (e) { showMessage((e && e.message) || 'The day could not be set up.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <div className="arena-daysetup">
      <h4>Set up Elementix Day in one press</h4>
      <p className="muted small">
        Builds the whole day as a draft — the Early Bird (clock in by 11:38, then the four wheels)
        and the all-day Mega Spin (challenges from 12:30 until six) — with every setting pre-filled.
        Nothing goes out to the team until you press <strong>Start the day</strong> on it below.
      </p>
      <div className="arena-form">
        <label>Which day
          <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
      </div>
      <button className="btn small" disabled={busy || !day} onClick={run}>
        {busy ? 'Setting it up…' : 'Set up the whole day'}
      </button>
      {result && <p className="arena-good small">{result.summary}</p>}
    </div>
  );
}

/** THE MANUAL ONE (owner-directed 2026-08-19, twice: "I can just type in
 *  stuff that should be on the wheel and click the spin button", then "either
 *  offices or the things … automatically import which offices we want and
 *  type which things we want"). Three shapes, none of which follows the
 *  standard session machinery — no check-in, no entries, no approvals:
 *  THINGS (one typed list), PEOPLE (tick exactly who — the winner is a REAL
 *  person: they are told, and the win lands on the day's record and the
 *  payroll CSV), or BOTH (wheel one the people, wheel two the prizes — the
 *  person who wins gets what wheel two lands on). */
function QuickSpin({ session, onChanged }) {
  const [mode, setMode] = useState('people_prizes');
  const [title, setTitle] = useState('Quick spin');
  const [things, setThings] = useState('');
  const [busy, setBusy] = useState(false);
  const [everyone, setEveryone] = useState(null);
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    arena.roster()
      .then((d) => { setEveryone(d.everyone || []); })
      .catch(() => setEveryone([]));
  }, []);
  const lines = things.split('\n').map((x) => x.trim()).filter(Boolean);
  const needsPeople = mode !== 'things';
  const needsThings = mode !== 'people';
  const ready = (!needsPeople || picked.length >= (mode === 'people' ? 2 : 1))
    && (!needsThings || lines.length >= (mode === 'things' ? 2 : 1));
  const go = async () => {
    setBusy(true);
    try {
      const kind = mode === 'things' ? 'quick_wheel' : mode === 'people' ? 'quick_pick' : 'quick_double';
      const config = { durationMs: 5000 };
      if (needsPeople) config.pickedStaffIds = picked;
      if (mode === 'things') config.customList = things;
      if (mode === 'people_prizes') config.customList2 = things;
      const made = await arena.createSpin(session.id, { title: title.trim() || 'Quick spin', kind, config });
      const spinId = made && made.spin && made.spin.id;
      if (spinId) await arena.openSpin(spinId);
      onChanged();
      showMessage('It is on the stage — press "Spin the wheel" there when everybody is watching.', { title: 'Ready', tone: 'info' });
    } catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
    finally { setBusy(false); }
  };
  return (
    <div className="arena-card">
      <h3>Quick spin — no settings, just spin</h3>
      <p className="muted small">
        A one-off wheel, outside the day's plan. Nothing to configure and nobody has to check in —
        it lands on the stage the moment you press the button, and everybody watches it turn.
      </p>
      <div className="arena-group-chips">
        {[['people_prizes', 'People + prizes (two wheels)'], ['people', 'Just people'], ['things', 'Just a typed list']].map(([k, l]) => (
          <button key={k} type="button" className={`btn ghost small${mode === k ? ' on' : ''}`} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>
      <div className="arena-form">
        <label>What this spin is called
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      {needsPeople && (
        <>
          <p className="muted small" style={{ margin: '10px 0 4px' }}>
            <strong>Who is on the wheel</strong> — tick a group, then add or take off anyone.
            The winner is told and the win lands on the day's record.
          </p>
          {!everyone && <p className="muted small">Loading the team…</p>}
          {everyone && <RosterPicker everyone={everyone} picked={picked} onChange={setPicked} />}
        </>
      )}
      {needsThings && (
        <label className="arena-fullfield">
          {mode === 'people_prizes' ? 'What they can win — one per line' : 'On the wheel — one per line'}
          <textarea
            className="input" rows={6} value={things}
            placeholder={mode === 'people_prizes' ? 'Lunch on us\nLeave early Friday\n$50 gift card' : 'Moshe\nRivky\nYanky'}
            onChange={(e) => setThings(e.target.value)}
          />
        </label>
      )}
      <p className="muted small">
        {needsPeople ? `${picked.length} ${picked.length === 1 ? 'person' : 'people'} on the wheel` : ''}
        {needsPeople && needsThings ? ' · ' : ''}
        {needsThings ? `${lines.length} ${mode === 'people_prizes' ? 'prize' : 'slice'}${lines.length === 1 ? '' : 's'} typed` : ''}
      </p>
      <button className="btn" disabled={busy || !ready} onClick={go}>
        {busy ? 'Putting it up…' : 'Put it on the stage'}
      </button>
    </div>
  );
}

/** THE OUTBOX — every arena message that went out, who got it, who has seen
 *  it. Grouped like an email account: one line per blast, expandable to the
 *  recipient list (owner-directed 2026-08-19). */
function ArenaOutbox() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [openKey, setOpenKey] = useState(null);
  const load = useCallback(() => {
    setErr('');
    arena.outbox().then(setData).catch((e) => setErr((e && e.message) || 'The outbox could not be loaded.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <p className="arena-bad small">{err} <button className="btn ghost small" onClick={load}>Try again</button></p>;
  if (!data) return <p className="muted">Loading…</p>;
  const blasts = data.blasts || [];
  return (
    <div className="arena-card">
      <h3>Messages sent</h3>
      <p className="muted small">
        Every Arena message PILOT has sent — spin openings, deadline alarms, results, challenge alerts —
        newest first. Open one to see exactly who it went to and who has seen it.
        <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={load}>Refresh</button>
      </p>
      <ul className="arena-outbox">
        {blasts.map((b) => {
          const seen = b.recipients.filter((r) => r.readAt).length;
          return (
            <li key={b.key}>
              <button type="button" className="arena-outbox-row" onClick={() => setOpenKey(openKey === b.key ? null : b.key)}>
                <strong>{b.title}</strong>
                <span className="muted small">{b.body}</span>
                <em className="muted small">
                  {new Date(b.sentAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  {' · '}{b.recipients.length} {b.recipients.length === 1 ? 'person' : 'people'} · {seen} seen it
                </em>
              </button>
              {openKey === b.key && (
                <ul className="arena-outbox-who">
                  {b.recipients.map((r, i) => (
                    <li key={i}>
                      <span>{r.name}</span>
                      <em className={`muted small${r.readAt ? '' : ' arena-unseen'}`}>
                        {r.readAt ? `seen ${new Date(r.readAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'not seen yet'}
                      </em>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {!blasts.length && <li className="muted">Nothing sent yet. Messages appear here the moment the Arena sends them.</li>}
      </ul>
    </div>
  );
}

/** Rename the session or change the line under its name — the "settings of
 *  the session" the owner asked for (2026-08-19). */
function SessionSettings({ session, onSaved }) {
  const [name, setName] = useState(session.name || '');
  const [subtitle, setSubtitle] = useState(session.subtitle || '');
  const [notes, setNotes] = useState((session.settings && session.settings.boardNotes) || '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="arena-form" style={{ marginTop: 8 }}>
      <label>Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>A line underneath<input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} /></label>
      <label style={{ gridColumn: '1 / -1' }}>A message on the stage — instructions, encouragement, anything
        <textarea className="input" rows={4} value={notes} maxLength={4000}
          placeholder={'Welcome to Elementix Day!\nClock in by 11:38 to be on the wheel. Every dial counts.'}
          onChange={(e) => setNotes(e.target.value)} />
      </label>
      <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
        The message shows on everybody's stage the moment you save — and clears if you empty it.
      </p>
      <button className="btn small" disabled={busy || !name.trim()} onClick={async () => {
        setBusy(true);
        try {
          await arena.updateSession(session.id, { name: name.trim(), subtitle: subtitle.trim() || null, boardNotes: notes });
          showMessage('The session is updated — the stage shows it now.', { title: 'Saved', tone: 'info' });
          onSaved();
        } catch (e) { showMessage((e && e.message) || 'That did not save.', { tone: 'error' }); }
        finally { setBusy(false); }
      }}>Save</button>
    </div>
  );
}

function Sessions({ sessions, loadErr, onRetry, onReload }) {
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [picking, setPicking] = useState(null);
  const [planning, setPlanning] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [everyone, setEveryone] = useState(null);
  const [rosterErr, setRosterErr] = useState('');
  const [picked, setPicked] = useState([]);

  useEffect(() => {
    arena.roster()
      .then((d) => { setEveryone(d.everyone || []); setPicked((d.everyone || []).map((p) => String(p.id))); })
      .catch((e) => setRosterErr((e && e.message) || 'The team list could not be loaded.'));
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await arena.createSession({
        name: name.trim(), subtitle: subtitle.trim() || null,
        staffIds: everyone ? staffIdsToSend(picked, everyone) : [],
      });
      setName(''); setSubtitle('');
      onReload();
      showMessage('The session is created as a draft. Press "Start it (go live)" when you are ready.', { title: 'Created', tone: 'info' });
    } catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
  };

  const goLive = async (sess) => {
    const sure = await askConfirm(
      `Start "${sess.name}" now? The moment it goes live, the whole team is told the day has begun `
      + '— that message cannot be unsent.', { confirmLabel: 'Start it' });
    if (!sure) return;
    try { await arena.setSessionState(sess.id, 'live'); onReload(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
  };

  return (
    <div className="arena-card">
      <h3>Sessions</h3>
      <p className="muted small">
        A session is a day, like Elementix Day. It holds as many spins as you like, and everything that
        happened in it stays on the board until you close it.
      </p>

      <DaySetup onReload={onReload} />

      <details className="arena-createown">
        <summary>Or build a session of your own</summary>
        <div className="arena-form">
          <label>Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Elementix Day" /></label>
          <label>A line underneath<input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Dial day" /></label>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}><strong>Who is playing</strong> — pick before you create it:</p>
        {rosterErr && <p className="arena-bad small">{rosterErr} <button className="btn ghost small" onClick={() => { setRosterErr(''); arena.roster().then((d) => { setEveryone(d.everyone || []); setPicked((d.everyone || []).map((p) => String(p.id))); }).catch((e) => setRosterErr((e && e.message) || 'Still not loading.')); }}>Try again</button></p>}
        {!everyone && !rosterErr && <p className="muted small">Loading the team…</p>}
        {everyone && <RosterPicker everyone={everyone} picked={picked} onChange={setPicked} />}
        <button className="btn small" disabled={!name.trim()} onClick={create}>Create it</button>
      </details>

      <ul className="arena-sessionlist">
        {sessions.map((s) => (
          <li key={s.id}>
            <div>
              <strong>{s.name}</strong>
              <em className={`arena-status s-${s.paused_at ? 'paused' : s.state}`}>{s.paused_at ? 'paused' : s.state}</em>
              <span className="muted small">{s.spin_count} spins · {s.award_count} prizes given</span>
            </div>
            {s.paused_at && (
              <p className="muted small">
                Paused — nothing launches itself, no alarms go out and check-in is shut until you resume it.
              </p>
            )}
            <div className="arena-decide">
              {s.state !== 'live' && s.state !== 'closed' && (
                <button className="btn small" onClick={() => goLive(s)}>Start it (go live)</button>
              )}
              {s.state === 'live' && !s.paused_at && (
                <button className="btn ghost small" onClick={async () => {
                  if (!await askConfirm(`Pause "${s.name}"? Everything freezes — nothing opens or closes itself, and check-in is shut — until you resume it. Nobody is emailed.`, { confirmLabel: 'Pause it' })) return;
                  try { await arena.setSessionState(s.id, 'paused'); onReload(); }
                  catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
                }}>Pause it</button>
              )}
              {s.state === 'live' && s.paused_at && (
                <button className="btn small" onClick={async () => {
                  try { await arena.setSessionState(s.id, 'live'); onReload(); }
                  catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
                }}>Resume it</button>
              )}
              {s.state === 'live' && (
                <button className="btn ghost small" onClick={async () => {
                  if (!await askConfirm(`Close "${s.name}"? The record stays; a new session starts fresh.`)) return;
                  try { await arena.setSessionState(s.id, 'closed'); onReload(); }
                  catch (e) { showMessage((e && e.message) || 'That did not work.', { tone: 'error' }); }
                }}>Close it</button>
              )}
              <button
                className="btn ghost small"
                onClick={() => setPlanning(planning === s.id ? null : s.id)}
              >{planning === s.id ? 'Hide the plan' : `Today's plan (${s.spin_count})`}</button>
              <button className="btn ghost small" onClick={() => setPicking(picking === s.id ? null : s.id)}>Who is in it</button>
              <button className="btn ghost small" onClick={() => setRenaming(renaming === s.id ? null : s.id)}>Session settings</button>
              {/* Fetched with the login, never a bare link — a plain href cannot
                  carry the token and landed the admin on a raw JSON error page. */}
              <button className="btn ghost small" onClick={async () => {
                try { await arena.downloadAwardsCsv(s.id); }
                catch (e) { showMessage((e && e.message) || 'The prize list could not be downloaded.', { tone: 'error' }); }
              }}>Download the prize list (for payroll)</button>
            </div>
            {planning === s.id && <SessionPlan session={s} onChanged={onReload} />}
            {renaming === s.id && <SessionSettings session={s} onSaved={() => { setRenaming(null); onReload(); }} />}
            {picking === s.id && <People sessionId={s.id} onSaved={onReload} />}
          </li>
        ))}
        {!sessions.length && (loadErr
          ? (
            <li>
              <p className="arena-bad small">{loadErr} <button className="btn ghost small" onClick={onRetry}>Try again</button></p>
            </li>
          )
          : <li className="muted">No sessions yet — set the day up above, or build your own.</li>)}
      </ul>
    </div>
  );
}

function People({ sessionId, onSaved }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState([]);
  const load = () => {
    setErr('');
    arena.people(sessionId).then((d) => {
      setData(d);
      setPicked(d.limitedToPicked ? d.pickedIds : d.everyone.map((p) => String(p.id)));
    }).catch((e) => setErr((e && e.message) || 'The list could not be loaded.'));
  };
  useEffect(load, [sessionId]);
  if (err) return <p className="arena-bad small">{err} <button className="btn ghost small" onClick={load}>Try again</button></p>;
  if (!data) return <p className="muted small">Loading…</p>;
  return (
    <div>
      <RosterPicker everyone={data.everyone || []} picked={picked} onChange={setPicked} />
      <button className="btn small" onClick={async () => {
        try {
          // Everyone ticked is sent as an EMPTY list — see staffIdsToSend.
          await arena.updateSession(sessionId, { staffIds: staffIdsToSend(picked, data.everyone || []) });
          onSaved();
          showMessage('The list is saved.', { title: 'Saved', tone: 'info' });
        }
        catch (e) { showMessage((e && e.message) || 'That did not save.', { tone: 'error' }); }
      }}>Save who is in</button>
    </div>
  );
}

/* --------------------------------------------------------------- queue */

function Queue({ board, onChanged }) {
  const spins = board.spins || [];
  const rows = [];
  for (const s of spins) {
    for (const c of (s.checkins || [])) if (c.status === 'pending') rows.push({ kind: 'checkin', s, row: c });
    for (const e of (s.entries || [])) if (e.status === 'pending') rows.push({ kind: 'entry', s, row: e });
    for (const q of (s.qualifiers || [])) for (const c of (q.claims || [])) if (c.status === 'pending') rows.push({ kind: 'claim', s, q, row: c });
  }
  const decide = async (fn) => {
    try { await fn(); await onChanged(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.'); }
  };
  return (
    <div className="arena-card">
      <h3>Waiting on you ({rows.length})</h3>
      {!rows.length && <p className="muted">Nothing to decide right now.</p>}
      <ul className="arena-queue">
        {rows.map(({ kind, s, q, row }) => (
          <li key={`${kind}-${row.id}`}>
            <span className="arena-seq">Spin {s.seq}</span>
            {kind === 'checkin' && <span><strong>{row.full_name}</strong> wants in</span>}
            {kind === 'entry' && (
              <span><strong>{row.asked_by}</strong> asked for “{row.label}” — {money(row.value_cents)}
                {row.kind === 'business' ? ' (business)' : ''}</span>
            )}
            {kind === 'claim' && <span><strong>{row.full_name}</strong> claims “{q.label}”: {row.evidence}</span>}
            <span className="arena-decide">
              <button className="btn ghost small" onClick={() => decide(() => (
                kind === 'checkin' ? arena.decideCheckin(row.id, 'approved')
                  : kind === 'entry' ? arena.decideEntry(row.id, 'approved')
                    : arena.decideClaim(row.id, 'approved')))}>Yes</button>
              <button className="btn ghost small" onClick={() => decide(() => (
                kind === 'checkin' ? arena.decideCheckin(row.id, 'rejected')
                  : kind === 'entry' ? arena.decideEntry(row.id, 'rejected')
                    : arena.decideClaim(row.id, 'rejected')))}>No</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- prizes */

function PrizeList() {
  const [list, setList] = useState([]);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState('perk');
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    setErr('');
    arena.prizes().then((r) => setList(r.prizes || []))
      .catch((e) => setErr((e && e.message) || 'The prize list could not be loaded.'));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="arena-card">
      <h3>The standing prize list</h3>
      <p className="muted small">
        These are just a starting point — change any of them, delete the ones you do not want, add your own.
        A spin can use this list instead of asking people to type something.
      </p>
      <div className="arena-form">
        <label>What it is<input className="input" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <label>Worth<input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" /></label>
        <label>Kind
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="perk">A perk (costs nothing)</option>
            <option value="personal">Personal</option>
            <option value="business">For their business</option>
          </select>
        </label>
      </div>
      <button className="btn small" disabled={!label.trim()} onClick={async () => {
        try { await arena.addPrize({ label: label.trim(), value: value || '0', kind }); setLabel(''); setValue(''); load(); }
        catch (e) { showMessage((e && e.message) || 'That did not save.'); }
      }}>Add it</button>

      {err && !list.length && (
        <p className="arena-bad small">{err} <button className="btn ghost small" onClick={load}>Try again</button></p>
      )}

      <ul className="arena-prizes">
        {list.map((p) => (
          <li key={p.id} className={p.is_active ? '' : 'out'}>
            <span>{p.label}{p.description ? <em className="muted small"> — {p.description}</em> : null}</span>
            <em>{p.value_cents ? money(p.value_cents) : 'no cash value'} · {p.kind}</em>
            <span className="arena-decide">
              <button className="btn ghost small" onClick={async () => {
                try { await arena.updatePrize(p.id, { isActive: !p.is_active }); load(); }
                catch (e) { showMessage((e && e.message) || 'That did not save.', { tone: 'error' }); }
              }}>{p.is_active ? 'Hide' : 'Use again'}</button>
              <button className="btn ghost small" onClick={async () => {
                if (!await askConfirm(`Delete "${p.label}" from the list?`)) return;
                try { await arena.deletePrize(p.id); load(); }
                catch (e) { showMessage((e && e.message) || 'That did not delete.', { tone: 'error' }); }
              }}>Delete</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------- settings */

/** Who runs the Arena beside the super admins — tick a person and they get
 *  the whole control room (owner-directed 2026-08-19: "give Ezra the same
 *  access as the super admin when it comes to this"). Arena only — no other
 *  super-admin power anywhere else in PILOT. */
function HostsPicker({ hosts, onChange }) {
  const [everyone, setEveryone] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    arena.roster().then((d) => setEveryone(d.everyone || [])).catch(() => setEveryone([]));
  }, []);
  const ids = (hosts || []).map(String);
  const toggle = (id) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const needle = q.trim().toLowerCase();
  const shown = (everyone || []).filter((p) => !needle || `${p.full_name}`.toLowerCase().includes(needle));
  return (
    <div className="arena-daysetup" style={{ marginTop: 12 }}>
      <h4>Who runs the Arena</h4>
      <p className="muted small">
        Super admins always can. Tick anyone else who should have the WHOLE control room — start and
        pause sessions, spin the wheels, decide challenges, hand out chances. This is the Arena only;
        it gives no other admin power anywhere else. Save the settings below for it to take effect.
      </p>
      <input className="input" placeholder="Find a person…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
      <ul className="arena-people-flat">
        {shown.map((p) => (
          <li key={p.id}>
            <label>
              <input type="checkbox" checked={ids.includes(String(p.id))} onChange={() => toggle(String(p.id))} />
              <span>{p.full_name}</span>
              <em className="muted small">{ROLE_LABEL[p.role] || p.role}</em>
            </label>
          </li>
        ))}
        {!everyone && <li className="muted small">Loading the team…</li>}
      </ul>
      {!!ids.length && <p className="muted small">{ids.length} host{ids.length === 1 ? '' : 's'} beside the super admins.</p>}
    </div>
  );
}

function SettingsPanel() {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => {
    setErr('');
    arena.getSettings().then(setS)
      .catch((e) => setErr((e && e.message) || 'The settings could not be loaded.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!s) {
    return err
      ? <p className="arena-bad small">{err} <button className="btn ghost small" onClick={load}>Try again</button></p>
      : <p className="muted">Loading…</p>;
  }
  const set = (k, v) => setS((c) => ({ ...c, settings: { ...c.settings, [k]: v } }));
  const save = async () => {
    setSaving(true);
    try { setS(await arena.saveSettings({ settings: s.settings })); showMessage('The settings are saved.', { title: 'Saved', tone: 'info' }); }
    catch (e) { showMessage((e && e.message) || 'That did not save.'); }
    finally { setSaving(false); }
  };
  // A degraded read can answer without `settings`; the inputs below read
  // straight off it, so refuse to render them rather than crash the panel.
  if (!s.settings) {
    return <p className="arena-bad small">The settings could not be read just now. <button className="btn ghost small" onClick={load}>Try again</button></p>;
  }
  return (
    <div className="arena-card">
      <h3>How the Arena behaves</h3>
      {!s.readable && (
        <p className="arena-bad">
          The settings could not be read just now, so what you see below is the safe default rather than
          what is actually saved. Reload before changing anything.
        </p>
      )}
      <div className="arena-form">
        <label>Personal prize cap
          <input className="input" type="number" min="0" value={Math.round(s.settings.personalCapCents / 100)}
            onChange={(e) => set('personalCapCents', Math.round(Number(e.target.value) * 100))} />
        </label>
        <label>Business prize cap
          <input className="input" type="number" min="0" value={Math.round(s.settings.businessCapCents / 100)}
            onChange={(e) => set('businessCapCents', Math.round(Number(e.target.value) * 100))} />
        </label>
        <label>How many things one person can put forward
          <input className="input" type="number" min="1" max="10" value={s.settings.entriesPerPerson}
            onChange={(e) => set('entriesPerPerson', Number(e.target.value))} />
        </label>
        <label>Warn people this many minutes before a cutoff
          <input
            className="input" value={(s.settings.reminderOffsetsMinutes || []).join(', ')}
            onChange={(e) => set('reminderOffsetsMinutes',
              e.target.value.split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => x > 0))}
          />
        </label>
        <label>Slow mode — seconds between messages
          <input className="input" type="number" min="0" max="60" value={s.settings.chatSlowModeSeconds}
            onChange={(e) => set('chatSlowModeSeconds', Number(e.target.value))} />
        </label>
        <label>Count-in before a challenge appears (seconds)
          <input className="input" type="number" min="0" max="120" value={s.settings.challengeCountdownSeconds}
            onChange={(e) => set('challengeCountdownSeconds', Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label>How long a wheel spins (seconds)
          <input className="input" type="number" min="3" max="20" value={Math.round((s.settings.defaultDurationMs || 7000) / 1000)}
            onChange={(e) => set('defaultDurationMs', Math.min(20, Math.max(3, Number(e.target.value) || 7)) * 1000)} />
        </label>
        <label>Full turns before it lands
          <input className="input" type="number" min="2" max="12" value={s.settings.defaultFullTurns}
            onChange={(e) => set('defaultFullTurns', Math.min(12, Math.max(2, Number(e.target.value) || 6)))} />
        </label>
        <label>Joke slices — % of a prize wheel (blank = automatic pacing)
          <input className="input" type="number" min="0" max="45" placeholder="automatic"
            value={s.settings.jokeShare == null ? '' : Math.round(Number(s.settings.jokeShare) * 100)}
            onChange={(e) => set('jokeShare', e.target.value === '' ? null : Math.min(45, Math.max(0, Number(e.target.value) || 0)) / 100)} />
        </label>
        <label>What the board is called
          <input className="input" value={s.settings.boardName || ''} placeholder="The Arena"
            onChange={(e) => set('boardName', e.target.value)} />
        </label>
      </div>
      <div className="arena-togglegrid">
        <Toggle label="Email people before a cutoff" v={s.settings.emailReminders} on={(v) => set('emailReminders', v)} />
        <Toggle label="Email people what happened" v={s.settings.emailResults} on={(v) => set('emailResults', v)} />
        <Toggle label="Chat is on" v={s.settings.chatEnabled} on={(v) => set('chatEnabled', v)} />
        <Toggle label="People can suggest the next spin" v={s.settings.suggestionsEnabled} on={(v) => set('suggestionsEnabled', v)} />
        <Toggle label="Show everybody the odds" v={s.settings.showOddsToEveryone} on={(v) => set('showOddsToEveryone', v)} />
        <Toggle label="Let anybody check a draw afterwards" v={s.settings.showFairnessProof} on={(v) => set('showFairnessProof', v)} />
        <Toggle label="Sound" v={s.settings.soundEnabled} on={(v) => set('soundEnabled', v)} />
        <Toggle label="Confetti" v={s.settings.confettiEnabled} on={(v) => set('confettiEnabled', v)} />
        <Toggle label="A person's entries need approval first" v={s.settings.requireEntryApproval} on={(v) => set('requireEntryApproval', v)} />
        <Toggle label="Bell alert when a challenge lands" v={s.settings.challengeAlerts} on={(v) => set('challengeAlerts', v)} />
        <Toggle label="Joke slices on the prize wheel (Elementix calls)" v={s.settings.jokePrizes} on={(v) => set('jokePrizes', v)} />
        <Toggle label="Big-screen (TV) mode available" v={s.settings.tvModeEnabled} on={(v) => set('tvModeEnabled', v)} />
      </div>
      {s.canEditHosts !== false && <HostsPicker hosts={s.settings.hosts || []} onChange={(ids) => set('hosts', ids)} />}
      <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
      <p className="muted small">
        Turning the whole Arena on and off is on the Settings screen, not here — so it stays reachable
        even when the Arena is hidden from everybody.
      </p>
    </div>
  );
}
