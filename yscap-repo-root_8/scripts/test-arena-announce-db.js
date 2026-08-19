/**
 * TELLING PEOPLE WHAT HAPPENED — proven against a real Postgres.
 *
 * WHY THIS SUITE EXISTS. The first build of the Arena broadcast every result
 * over the live stream and stopped there. That is fine for the people watching
 * the wheel and completely silent for the person who won while they were on a
 * call — which is exactly the thing the owner asked for by name. This suite
 * exists so that can never quietly regress.
 *
 * What it proves:
 *   - a decided spin produces a notification ADDRESSED TO THE WINNER, and a
 *     different one for everybody else;
 *   - it sends ONCE, even when settle is replayed — because a repeated
 *     announcement to the whole company is the failure people remember;
 *   - closing a session sends one round-up listing what was won;
 *   - a landing challenge reaches the bell but is NEVER emailed;
 *   - turning results off in settings really stops them;
 *   - every Arena notification type is in the Notification Center catalog, so a
 *     person can switch any of them off, and none of them is forced.
 *
 * PROVEN TO FAIL, each mutation applied alone with a clean run either side:
 *   - drop the claim from announce.spinDecided -> RED at "replaying the settle
 *     sends nothing more";
 *   - send the winner the same message as everybody else -> RED at "the winner
 *     is told personally";
 *   - mark an arena catalog entry forced:true -> RED at "no Arena notification
 *     is forced";
 *   - take `arena_challenge` out of notify.js's STAFF_INAPP_TYPES
 *       -> RED at "a challenge never becomes an email".
 *
 * NOTE ON THE MAILER. The bundled "none" provider answers {ok:false}, so EVERY
 * notification's stored email_status is 'skipped' on a machine with no mail
 * configured — asserting on that column would have been decoration. The provider
 * is stubbed and the assertions are made on what it was actually handed.
 *
 * Self-skips without DATABASE_URL. Cleans up after itself.
 */
const R = require('path').resolve(__dirname, '..');

// CAPTURE WHAT THE MAIL PROVIDER IS ACTUALLY HANDED. The bundled "none" provider
// answers {ok:false}, so every notification's stored email_status is 'skipped'
// whether or not an email was attempted — asserting on that column would prove
// nothing about the rule. The stub is the only way to tell "we never tried" from
// "there is no mailer on this machine".
const noopMailer = require(R + '/src/lib/email/noop');
const sends = [];
noopMailer.sendMail = async (m) => { sends.push(m); return { ok: true, id: `stub-${sends.length}` }; };
const sentTo = (addr) => sends.filter((m) => [].concat(m.to || []).includes(addr));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP Arena announce DB (no DATABASE_URL)'); process.exit(0); }
  const db = require(R + '/src/db');
  const settings = require(R + '/src/lib/arena/settings');
  const announce = require(R + '/src/lib/arena/announce');
  const catalog = require(R + '/src/lib/notification-catalog');
  const notify = require(R + '/src/lib/notify');

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const made = [];
  let sessionId = null;
  let switchWas = null;

  const notesFor = async (ids, type) => (await db.query(
    `SELECT staff_id, title, body, type FROM notifications
      WHERE staff_id = ANY($1::uuid[]) AND type = $2`, [ids, type])).rows;

  try {
    switchWas = (await db.query(`SELECT enabled, settings FROM arena_settings WHERE id = true`)).rows[0];

    // ---- A. THE CATALOG ----------------------------------------------------
    const arenaEntries = catalog.CATALOG.filter((c) => c.category === 'arena');
    ok(arenaEntries.length >= 6, `the Arena's notifications are in the Notification Center (${arenaEntries.length})`);
    ok(catalog.CATEGORIES.some((c) => c.id === 'arena'), 'and they have their own section in it');
    ok(!arenaEntries.some((c) => c.forced),
      'no Arena notification is forced — a game must never be something you cannot turn off');
    for (const key of ['arena_you_won', 'arena_result', 'arena_session_wrap', 'arena_challenge', 'arena_deadline', 'arena_spin_open']) {
      ok(arenaEntries.some((c) => c.key === key), `"${key}" is in the catalog, so it can be switched off`);
    }
    for (const c of arenaEntries) {
      ok(!!c.description && c.description.length > 20, `${c.key} explains itself to whoever is deciding`);
    }

    // ---- B. SETUP ----------------------------------------------------------
    await db.query(`UPDATE arena_settings SET enabled = true WHERE id = true`);
    settings.invalidate();

    const mk = async (name, role) => {
      const r = await db.query(
        `INSERT INTO staff_users (email, full_name, role, is_active, token_version)
         VALUES ($1,$2,$3,true,0) RETURNING id`, [`ann-${name}-${sfx}@t.local`, name, role]);
      made.push(r.rows[0].id);
      return r.rows[0].id;
    };
    const boss = await mk('Boss', 'super_admin');
    const winner = await mk('Winona', 'loan_officer');
    const other1 = await mk('Otto', 'loan_officer');
    const other2 = await mk('Olive', 'loan_officer');
    const everyone = [boss, winner, other1, other2];

    const ses = await db.query(
      `INSERT INTO arena_sessions (name, state) VALUES ($1,'live') RETURNING *`, [`Ann ${sfx}`]);
    sessionId = ses.rows[0].id;
    for (const id of everyone) {
      await db.query(`INSERT INTO arena_session_members (session_id, staff_id) VALUES ($1,$2)`, [sessionId, id]);
    }
    const spin = (await db.query(
      `INSERT INTO arena_spins (session_id, seq, title, state) VALUES ($1,1,'The big one','decided') RETURNING *`,
      [sessionId])).rows[0];

    // ---- C. THE RESULT -----------------------------------------------------
    const out = { staffId: winner, personLabel: 'Winona', prizeLabel: 'A new laptop', prizeValue: 95000, reason: 'Who wins: Winona' };
    const first = await announce.spinDecided(spin, out);
    ok(first.sent >= 4, `the result reached everybody (${first.sent} messages)`);

    const won = await notesFor([winner], 'arena_you_won');
    eq(won.length, 1, 'the winner is told personally, in their own message');
    // Read through a blank rather than indexing: when the personal message is the
    // thing that broke, an index into an empty list THROWS and the suite reports a
    // crash instead of naming which rule failed.
    const w0 = won[0] || { title: '', body: '' };
    ok(/You won/.test(w0.title), 'and the message is addressed to them');
    ok(/laptop/.test(w0.title), 'naming what they won');
    ok(/\$950/.test(w0.body), 'and what it is worth');

    const told = await notesFor([other1, other2, boss], 'arena_result');
    eq(told.length, 3, 'everybody else is told the result');
    ok(/Winona won/.test((told[0] || {}).title || ''), 'naming the winner and the prize');
    eq((await notesFor([winner], 'arena_result')).length, 0,
      'and the winner does NOT also get the round-up — they already got their own');

    // The thing that matters most.
    const again = await announce.spinDecided(spin, out);
    eq(again.sent, 0, 'replaying the settle sends nothing more');
    eq(again.skipped, 'already announced', 'and says plainly why');
    eq((await notesFor(everyone, 'arena_you_won')).length + (await notesFor(everyone, 'arena_result')).length, 4,
      'so the company is never told the same result twice');

    // ---- D. THE WRAP-UP ----------------------------------------------------
    await db.query(
      `INSERT INTO arena_awards (session_id, spin_id, staff_id, prize_label, value_cents, reason)
       VALUES ($1,$2,$3,'A new laptop',95000,'Who wins: Winona')`, [sessionId, spin.id, winner]);
    const wrap = await announce.sessionClosed(ses.rows[0]);
    ok(wrap.sent >= 4, `closing the day sends one round-up to everybody (${wrap.sent})`);
    const wraps = await notesFor(everyone, 'arena_session_wrap');
    eq(wraps.length, 4, 'including the winner this time — it is the whole day, not their prize');
    ok(/Winona won A new laptop/.test((wraps[0] || {}).body || ''), 'and it lists what was actually won');
    eq((await announce.sessionClosed(ses.rows[0])).sent, 0, 'and it too only ever goes once');

    // ---- E. THE CHALLENGE --------------------------------------------------
    const ch = (await db.query(
      `INSERT INTO arena_challenges (session_id, title, prompt, tickets_awarded, state)
       VALUES ($1,'Show a long call','Upload a call log over 8 minutes.',3,'live') RETURNING *`,
      [sessionId])).rows[0];
    // One person has already done it — they must not be told about it.
    await db.query(
      `INSERT INTO arena_challenge_entries (challenge_id, staff_id, note) VALUES ($1,$2,'done')`, [ch.id, other1]);
    const chOut = await announce.challengeLanded(ch);
    eq(chOut.sent, 3, 'a landing challenge reaches everybody who has not already done it');
    const chNotes = await notesFor(everyone, 'arena_challenge');
    eq(chNotes.length, 3, 'and only them');
    eq(chNotes.filter((n) => String(n.staff_id) === String(other1)).length, 0,
      'the person who already sent it in is not pestered about it');
    ok(/3 chances/.test((chNotes[0] || {}).body || ''), 'and the message says what it is worth');

    // THE VOLUME RULE, MEASURED AT THE WIRE. About twenty of these land in an
    // afternoon, so they must never become email — and the proof is that the mail
    // provider was never handed one, not that a status column looks quiet.
    await notify.drainEmails();
    ok(!sends.some((m) => /New challenge/.test(m.subject || '')),
      'a challenge never becomes an email — twenty a day would turn the game into a mail filter');
    // The control that gives the line above its meaning: a RESULT does reach the
    // provider, so the assertion above is measuring the rule and not a dead mailer.
    ok(sentTo(`ann-Winona-${sfx}@t.local`).some((m) => /You won/.test(m.subject || '')),
      'while winning DOES reach them by email — that one is worth the interruption');

    // ---- F. THE OFF SWITCHES -----------------------------------------------
    await settings.save({ settings: { emailResults: false } }, boss);
    const spin2 = (await db.query(
      `INSERT INTO arena_spins (session_id, seq, title, state) VALUES ($1,2,'Second','decided') RETURNING *`,
      [sessionId])).rows[0];
    const off = await announce.spinDecided(spin2, { ...out, prizeLabel: 'Nothing at all' });
    eq(off.sent, 0, 'turning results off in settings really stops them');
    ok(/switched off/.test(off.skipped || ''), 'and it says that is why, rather than failing silently');

    await settings.save({ settings: { emailResults: true, challengeAlerts: false } }, boss);
    const ch2 = (await db.query(
      `INSERT INTO arena_challenges (session_id, title, prompt, state)
       VALUES ($1,'Another','Do a thing.','live') RETURNING *`, [sessionId])).rows[0];
    eq((await announce.challengeLanded(ch2)).sent, 0, 'and challenge alerts have their own off switch');
  } catch (e) {
    fail++;
    console.log('  FAIL: threw -', e && e.stack ? e.stack : e);
  } finally {
    try {
      if (sessionId) await db.query(`DELETE FROM arena_sessions WHERE id = $1`, [sessionId]);
      if (made.length) {
        await db.query(`DELETE FROM notifications WHERE staff_id = ANY($1::uuid[])`, [made]);
        await db.query(`DELETE FROM audit_log WHERE actor_id = ANY($1::uuid[])`, [made]);
        await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [made]);
      }
      if (switchWas) {
        await db.query(`UPDATE arena_settings SET enabled = $1, settings = $2::jsonb WHERE id = true`,
          [switchWas.enabled, JSON.stringify(switchWas.settings || {})]);
      }
      require(R + '/src/lib/arena/settings').invalidate();
    } catch (e) { console.log('  (cleanup warning:', e.message, ')'); }
  }

  console.log(`arena announce (db): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
