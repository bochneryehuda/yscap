import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { showMessage, askConfirm } from '../../lib/dialog.js';
import { arena, money } from '../../lib/arena.js';
import { ArenaAiIdeas } from './ArenaAiHelp.jsx';

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
  const [panel, setPanel] = useState('ready');
  const [catalog, setCatalog] = useState(null);
  const [sessions, setSessions] = useState([]);
  const session = board && board.session;

  const loadSessions = useCallback(async () => {
    try { setSessions((await arena.sessions()).sessions || []); } catch { /* the panel still opens */ }
  }, []);

  useEffect(() => {
    arena.catalog().then(setCatalog).catch(() => {});
    loadSessions();
  }, [loadSessions]);

  const panels = [
    ['ready', 'Ready to go'],
    ['spin', 'New spin'],
    ['challenges', 'The day\u2019s challenges'],
    ['sessions', 'Sessions'],
    ['queue', 'Waiting on you'],
    ['prizes', 'Prize list'],
    ['settings', 'Settings'],
  ];

  return (
    <div className="arena-control">
      <nav className="arena-subtabs">
        {panels.map(([k, l]) => (
          <button key={k} className={`arena-subtab${panel === k ? ' on' : ''}`} onClick={() => setPanel(k)}>{l}</button>
        ))}
      </nav>

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
          ? <NewSpin catalog={catalog} session={session} onChanged={onChanged} />
          : <p className="muted">Start a session first, over in Sessions.</p>
      )}
      {panel === 'sessions' && <Sessions sessions={sessions} onReload={() => { loadSessions(); onChanged(); }} />}
      {panel === 'queue' && (session ? <Queue board={board} onChanged={onChanged} /> : <p className="muted">No session running.</p>)}
      {panel === 'prizes' && <PrizeList />}
      {panel === 'settings' && <SettingsPanel />}
    </div>
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

  useEffect(() => { arena.templates().then((r) => setList(r.templates || [])).catch(() => {}); }, []);

  const load = async (key) => {
    setBusy(key); setDone(null);
    try {
      const r = await arena.loadTemplate(session.id, key, {
        day,
        // getTimezoneOffset is minutes BEHIND UTC, which is the sign the server
        // wants — so 10:30 here really is 10:30 there.
        offsetMinutes: new Date().getTimezoneOffset(),
      });
      setDone(r);
      await onChanged();
    } catch (e) {
      showMessage((e && e.message) || 'That could not be loaded.');
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
      <div className="arena-gamegrid">
        {list.map((t) => (
          <div key={t.key} className="arena-game" style={{ cursor: 'default' }}>
            <strong>{t.label}</strong>
            <span>{t.blurb}</span>
            <ul className="muted small" style={{ margin: '6px 0 0 16px' }}>
              {(t.howItReads || []).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
            <button className="btn small" style={{ marginTop: 8 }} disabled={!!busy} onClick={() => load(t.key)}>
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

  const load = useCallback(async () => {
    try {
      setBoard(await arena.challenges(session.id));
      if (!lib) setLib(await arena.challengeLibrary());
    } catch { /* the panel still opens */ }
  }, [session.id, lib]);
  useEffect(() => { load(); }, [load]);

  const change = async (id, body, label) => {
    setBusy(label || id);
    try { await arena.updateChallenge(id, body); await load(); if (onChanged) onChanged(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.'); }
    finally { setBusy(''); }
  };

  if (!board) return <p className="muted">Loading the day…</p>;
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
                    onClick={() => change(c.id, { state: 'closed' }, c.id)}>Close it</button>
                </span>
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
                onClick={() => change(c.id, { state: 'live' }, c.id)}>Start now</button>
              <button className="btn ghost small" disabled={!!busy}
                onClick={() => change(c.id, { state: 'skipped' }, c.id)}>Skip</button>
            </span>
          </li>
        ))}
        {!upcoming.length && <li className="muted">Nothing scheduled. Load the Mega Spin under “Ready to go”, or add one below.</li>}
      </ul>

      <AddChallenge session={session} lib={lib} onAdded={load} />
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
            {(lib ? lib.tiers : []).map((t) => (
              <option key={t.tier} value={t.tier}>{t.label} — {t.tickets} chances</option>
            ))}
          </select>
        </label>
        <label>How they prove it
          <select className="input" value={proof} onChange={(e) => setProof(e.target.value)}>
            {(lib ? lib.proofTypes : []).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label>Who can win it
          <select className="input" value={award} onChange={(e) => setAward(e.target.value)}>
            {(lib ? lib.awardModes : []).map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </label>
      </div>
      <label className="arena-fullfield">What people read on screen
        <textarea className="input" rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <button className="btn small" disabled={!title.trim() || !prompt.trim() || saving} onClick={async () => {
        setSaving(true);
        try {
          await arena.addChallenge(session.id, { title: title.trim(), prompt: prompt.trim(), tier, proofType: proof, awardMode: award, startNow: true });
          setTitle(''); setPrompt('');
          await onAdded();
        } catch (e) { showMessage((e && e.message) || 'That did not save.'); }
        finally { setSaving(false); }
      }}>Put it out now</button>
    </details>
  );
}

/* ------------------------------------------------------------ new spin */

function NewSpin({ catalog, session, onChanged }) {
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

  if (!catalog) return <p className="muted">Loading the games…</p>;
  const families = catalog.families || [];
  const games = (catalog.games || []).filter((g) => g.family === family);
  const usesQualifiers = game && game.wheels.some((w) => w.source === 'qualifiers' || w.source === 'qualifier_claimants');

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
      showMessage('Spin created. Open it when you are ready for people to check in.');
    } catch (e) {
      showMessage((e && e.message) || 'That spin could not be created.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="arena-card">
      <h3>Set up the next spin</h3>

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
            {game.wheels.map((w, i) => (
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
            {(game && game.wheels.some((w) => w.source === 'closed_files_window')) && (
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
          {(config.customList !== undefined || (game && game.wheels.some((w) => w.source === 'custom_list'))) && (
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

function Sessions({ sessions, onReload }) {
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [picking, setPicking] = useState(null);

  const create = async () => {
    if (!name.trim()) return;
    try { await arena.createSession({ name: name.trim(), subtitle: subtitle.trim() || null }); setName(''); setSubtitle(''); onReload(); }
    catch (e) { showMessage((e && e.message) || 'That did not work.'); }
  };

  return (
    <div className="arena-card">
      <h3>Sessions</h3>
      <p className="muted small">
        A session is a day, like Elementix Day. It holds as many spins as you like, and everything that
        happened in it stays on the board until you close it.
      </p>
      <div className="arena-form">
        <label>Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Elementix Day" /></label>
        <label>A line underneath<input className="input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Dial day" /></label>
      </div>
      <button className="btn small" disabled={!name.trim()} onClick={create}>Create it</button>

      <ul className="arena-sessionlist">
        {sessions.map((s) => (
          <li key={s.id}>
            <div>
              <strong>{s.name}</strong>
              <em className={`arena-status s-${s.state}`}>{s.state}</em>
              <span className="muted small">{s.spin_count} spins · {s.award_count} prizes given</span>
            </div>
            <div className="arena-decide">
              {s.state !== 'live' && (
                <button className="btn ghost small" onClick={async () => {
                  try { await arena.setSessionState(s.id, 'live'); onReload(); }
                  catch (e) { showMessage((e && e.message) || 'That did not work.'); }
                }}>Go live</button>
              )}
              {s.state === 'live' && (
                <button className="btn ghost small" onClick={async () => {
                  if (!await askConfirm(`Close "${s.name}"? The record stays; a new session starts fresh.`)) return;
                  try { await arena.setSessionState(s.id, 'closed'); onReload(); }
                  catch (e) { showMessage((e && e.message) || 'That did not work.'); }
                }}>Close it</button>
              )}
              <button className="btn ghost small" onClick={() => setPicking(picking === s.id ? null : s.id)}>Who is in it</button>
              <a className="btn ghost small" href={arena.awardsCsvUrl(s.id)}>Prizes given (CSV)</a>
            </div>
            {picking === s.id && <People sessionId={s.id} onSaved={onReload} />}
          </li>
        ))}
        {!sessions.length && <li className="muted">No sessions yet.</li>}
      </ul>
    </div>
  );
}

function People({ sessionId, onSaved }) {
  const [data, setData] = useState(null);
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    arena.people(sessionId).then((d) => {
      setData(d);
      setPicked(d.limitedToPicked ? d.pickedIds : d.everyone.map((p) => String(p.id)));
    }).catch(() => {});
  }, [sessionId]);
  if (!data) return <p className="muted small">Loading…</p>;
  const toggle = (id) => setPicked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <div className="arena-people">
      <p className="muted small">Tick who is playing. Tick everybody and it simply means the whole team.</p>
      <ul>
        {data.everyone.map((p) => (
          <li key={p.id}>
            <label>
              <input type="checkbox" checked={picked.includes(String(p.id))} onChange={() => toggle(String(p.id))} />
              <span>{p.full_name}</span>
              <em className="muted small">{p.role}</em>
            </label>
          </li>
        ))}
      </ul>
      <button className="btn small" onClick={async () => {
        try { await arena.updateSession(sessionId, { staffIds: picked }); onSaved(); showMessage('Saved.'); }
        catch (e) { showMessage((e && e.message) || 'That did not save.'); }
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
  const load = useCallback(() => { arena.prizes().then((r) => setList(r.prizes || [])).catch(() => {}); }, []);
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

      <ul className="arena-prizes">
        {list.map((p) => (
          <li key={p.id} className={p.is_active ? '' : 'out'}>
            <span>{p.label}{p.description ? <em className="muted small"> — {p.description}</em> : null}</span>
            <em>{p.value_cents ? money(p.value_cents) : 'no cash value'} · {p.kind}</em>
            <span className="arena-decide">
              <button className="btn ghost small" onClick={async () => {
                await arena.updatePrize(p.id, { isActive: !p.is_active }); load();
              }}>{p.is_active ? 'Hide' : 'Use again'}</button>
              <button className="btn ghost small" onClick={async () => {
                if (await askConfirm(`Delete "${p.label}" from the list?`)) { await arena.deletePrize(p.id); load(); }
              }}>Delete</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------- settings */

function SettingsPanel() {
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { arena.getSettings().then(setS).catch(() => {}); }, []);
  if (!s) return <p className="muted">Loading…</p>;
  const set = (k, v) => setS((c) => ({ ...c, settings: { ...c.settings, [k]: v } }));
  const save = async () => {
    setSaving(true);
    try { setS(await arena.saveSettings({ settings: s.settings })); showMessage('Saved.'); }
    catch (e) { showMessage((e && e.message) || 'That did not save.'); }
    finally { setSaving(false); }
  };
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
      </div>
      <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
      <p className="muted small">
        Turning the whole Arena on and off is on the Settings screen, not here — so it stays reachable
        even when the Arena is hidden from everybody.
      </p>
    </div>
  );
}
