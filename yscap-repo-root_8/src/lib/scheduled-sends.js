'use strict';
/**
 * SCHEDULE AN ORDER EMAIL FOR LATER (owner-directed 2026-08-20).
 *
 * The owner: "For the order emails … title orders, insurance orders, or even
 * investor delivery, anything that you're sending out an email for, also closing
 * prep. If somebody wants to work in the middle of the night but he wants it to
 * go out in the morning, we need to add a scheduling option by the order … just
 * add an additional option with the small icon, like a time to schedule the email
 * instead of ordering it immediately."
 *
 * THE ONE DESIGN DECISION EVERYTHING ELSE FOLLOWS FROM: a scheduled send stores
 * the INTENT, never a rendered email, and at the due moment it RE-ENTERS THE
 * ORDINARY SEND ROUTE from the top.
 *
 * The tempting shape — build the email now, park the bytes, post them at 8am —
 * is wrong here in a way that costs real money. Six hours is long enough for the
 * file to be declined, the title company to be replaced, the property address to
 * be re-verified, the loan number to be filled in, the closing package to gain a
 * document, or the note buyer to change. Every one of those is a gate the send
 * path already enforces, and a frozen message is a message none of them ever saw
 * again. An order that goes to last night's vendor, or out of a file that was
 * withdrawn at 6am, is exactly the class of failure the Orders desk's blockers
 * exist to prevent.
 *
 * So `run()` does not re-implement a send. It calls the SAME express handler a
 * person clicking the button calls, through the SAME mounted router, with the
 * SAME body — so every blocker, every freeze, every exactly-once claim, every
 * audit row and every gate ADDED TO THAT PATH IN FUTURE applies to a scheduled
 * send for free, and no second copy of any of it exists to drift. That is why
 * this file has no email code in it at all.
 *
 * AND THE AUTHORITY IS RE-RESOLVED, NOT REMEMBERED. The route reads its own
 * `req.actor`, whose role and capability set `requireAuth` re-reads from the
 * database on EVERY request precisely because they change mid-session. A
 * scheduled send does the same: it rebuilds the actor from `staff_users` at the
 * due moment and refuses if that person is gone or deactivated. A send scheduled
 * by somebody who left the company before it fired must not go out in their name.
 */

const db = require('../db');

/* The business clock. Everything a person types or reads is New York time — the
   owner's "middle of the night" and "in the morning" are NY hours, and this is
   the timezone every scheduled thing in this codebase already runs on. */
const TZ = 'America/New_York';

/* How long after its time a send may still go out. A dispatcher that has been
   down (a deploy, a restart, an outage) comes back to a queue of overdue rows,
   and posting a 9am order at 4pm is worse than not posting it: the person who
   scheduled it has moved on, and an order they think went hours ago is a chase
   nobody is making. Past this, the row FAILS and says so. */
const STALE_AFTER_MIN = Number(process.env.SCHEDULED_SEND_STALE_MIN || 120);

/* A row is claimed before it runs, so a crash mid-send leaves it 'sending'
   rather than 'scheduled'. That is deliberate — an order email is not safe to
   retry blindly. This is how long before such a row is treated as abandoned and
   surfaced as failed (never silently re-run). */
const CLAIM_STUCK_MIN = Number(process.env.SCHEDULED_SEND_STUCK_MIN || 15);

/* The furthest ahead anything may be scheduled. A typo of the year is otherwise
   a send that sits in the queue for a decade. */
const MAX_AHEAD_DAYS = 60;

/* THE REGISTRY — the one place that says what may be scheduled and where each
   one re-enters. `router` names the mounted router the handler lives on and
   `path` is the URL a person clicking the button would post to; `{id}` and
   `{target}` are filled from the row. Adding a fifth schedulable email is one
   entry here plus its CHECK value in db/598 — never a new dispatcher branch. */
const KINDS = {
  title_order: {
    label: 'Title order',
    router: 'staff',
    path: (r) => `/applications/${r.application_id}/orders/title/place`,
    // What the desk calls the thing, for the queue screen and the failure notice.
    what: 'the title order',
  },
  insurance_order: {
    label: 'Insurance order',
    router: 'staff',
    path: (r) => `/applications/${r.application_id}/orders/insurance/place`,
    what: 'the insurance order',
  },
  closing_prep: {
    label: 'Closing prep request',
    router: 'staff',
    path: (r) => `/applications/${r.application_id}/closing-prep/place`,
    what: 'the closing-prep request to the attorney',
  },
  investor_delivery: {
    label: 'Investor delivery',
    router: 'sitewire',
    // The only kind with a target: WHICH draw is being delivered.
    path: (r) => `/files/${r.application_id}/draws/${r.target_key}/investor-delivery`,
    what: 'the draw delivery to the investor',
    requiresTarget: true,
  },
};

const isKind = (k) => Object.prototype.hasOwnProperty.call(KINDS, String(k || ''));

/* ── time ─────────────────────────────────────────────────────────────────── */

/** The offset New York is at on a given instant, as '-04:00' / '-05:00'. */
function nyOffset(at) {
  // Asking Intl for the short offset name is the only way to get this right
  // across the DST boundary without shipping a timezone table.
  const s = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' }).format(at);
  const m = /GMT([+-]\d{2}:\d{2})/.exec(s);
  return m ? m[1] : '-05:00';
}

/**
 * A wall-clock date + time the person typed, read as NEW YORK time.
 *
 * `new Date('2026-08-20T08:00')` is read in the SERVER's zone, and the server
 * runs in UTC — so a staffer asking for 8am would have been sent at 4am, before
 * anybody is awake, which is the precise failure this feature exists to avoid.
 * The offset is resolved AT THE TARGET INSTANT, not now, so a time picked in
 * November from a day in October lands on the hour that was asked for.
 */
function parseNyLocal(dayText, timeText) {
  const day = String(dayText || '').trim();
  const time = String(timeText || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  // Two passes: guess with the offset in force at the naive instant, then
  // re-resolve at the answer. That settles both DST directions.
  const naive = new Date(`${day}T${time}:00Z`);
  if (isNaN(naive.getTime())) return null;
  let at = new Date(`${day}T${time}:00${nyOffset(naive)}`);
  if (isNaN(at.getTime())) return null;
  at = new Date(`${day}T${time}:00${nyOffset(at)}`);
  return isNaN(at.getTime()) ? null : at;
}

/** How a scheduled time is shown back to a person — always in NY, always named. */
function describeWhen(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (isNaN(d.getTime())) return '';
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(d)} ET`;
}

/* ── what a person may ask for ────────────────────────────────────────────── */

/**
 * Judge a requested time. Refusals are PLAIN and say the limit, because the
 * person reading them is the one who can fix it.
 * @returns {null | {error, code}}
 */
function whenProblem(at, now = new Date()) {
  if (!(at instanceof Date) || isNaN(at.getTime())) {
    return { code: 'bad_time', error: 'Pick a date and a time.' };
  }
  // A minute of slack: a person picking "in a minute" and the round trip taking
  // a few seconds should not be told their time is in the past.
  if (at.getTime() < now.getTime() - 60 * 1000) {
    return { code: 'past', error: 'That time has already passed — pick a time in the future.' };
  }
  if (at.getTime() > now.getTime() + MAX_AHEAD_DAYS * 24 * 3600 * 1000) {
    return { code: 'too_far', error: `Pick a time within the next ${MAX_AHEAD_DAYS} days.` };
  }
  return null;
}

/* ── the queue ────────────────────────────────────────────────────────────── */

/**
 * Put a send in the queue, replacing whatever was pending for the same thing.
 *
 * REPLACE, NOT STACK. Changing your mind about the time must not leave the first
 * one armed — two scheduled sends of one order means the vendor gets it twice,
 * and the exactly-once claim on the order cannot help because they fire hours
 * apart. The partial unique index makes stacking impossible; this does the
 * replacement deliberately so the person sees one row, not a refusal.
 */
async function schedule({ appId, kind, targetKey = '', at, payload = {}, actorId }, dbc = db) {
  if (!isKind(kind)) return { ok: false, httpStatus: 400, code: 'unknown_kind', error: 'That is not something that can be scheduled.' };
  const meta = KINDS[kind];
  const target = String(targetKey || '');
  if (meta.requiresTarget && !target) {
    return { ok: false, httpStatus: 400, code: 'no_target', error: 'Which draw is this for?' };
  }
  const bad = whenProblem(at);
  if (bad) return { ok: false, httpStatus: 400, ...bad };

  // `getClient` is this repo's own accessor (it tracks the checkout so a leak is
  // visible); a bare pool.connect() would not be tracked.
  const client = await dbc.getClient();
  try {
    await client.query('BEGIN');
    // Supersede the pending one FIRST, in the same transaction, so the unique
    // index can never refuse the insert and a crash between the two can never
    // leave the file with nothing scheduled when the person was told otherwise.
    await client.query(
      `UPDATE scheduled_sends
          SET status='cancelled', cancelled_at=now(), cancelled_by=$4, updated_at=now(),
              last_error='Replaced by a later scheduling of the same send.', last_error_code='replaced'
        WHERE application_id=$1 AND kind=$2 AND target_key=$3 AND status IN ('scheduled','sending')`,
      [appId, kind, target, actorId || null]);
    const row = (await client.query(
      `INSERT INTO scheduled_sends (application_id, kind, target_key, send_at, payload, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       RETURNING id, application_id, kind, target_key, send_at, status, created_by, created_at`,
      [appId, kind, target, at.toISOString(), JSON.stringify(payload || {}), actorId || null])).rows[0];
    await client.query('COMMIT');
    return { ok: true, row: shape(row) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, httpStatus: 500, code: 'schedule_failed', error: 'Could not schedule that.' };
  } finally { client.release(); }
}

/** Take one back out of the queue. Only a pending one can be cancelled. */
async function cancel({ id, appId, actorId }, dbc = db) {
  // ONLY a send that is still WAITING. A row in 'sending' is mid-flight: the email
  // may already be with the vendor, so cancelling it would set the row to
  // 'cancelled' while the send finishes and settles it 'sent' a second later —
  // and, far worse, would tell somebody it was stopped when it was not. The
  // honest answer names what is happening and where to look.
  const r = await dbc.query(
    `UPDATE scheduled_sends
        SET status='cancelled', cancelled_at=now(), cancelled_by=$3, updated_at=now(),
            last_error=NULL, last_error_code=NULL
      WHERE id=$1 AND application_id=$2 AND status='scheduled'
      RETURNING id`, [id, appId, actorId || null]);
  if (r.rows[0]) return { ok: true };
  const cur = (await dbc.query(`SELECT status FROM scheduled_sends WHERE id=$1 AND application_id=$2`, [id, appId])).rows[0];
  if (cur && cur.status === 'sending') {
    return { ok: false, httpStatus: 409, code: 'in_flight',
      error: 'This is going out right now, so it is too late to stop it. Check the Email Center to see whether it reached the vendor.' };
  }
  return { ok: false, httpStatus: 409, code: 'not_pending',
    error: 'That send is no longer waiting — it has already gone out, failed, or been cancelled.' };
}

function shape(r) {
  if (!r) return null;
  const meta = KINDS[r.kind] || {};
  return {
    id: r.id,
    kind: r.kind,
    label: meta.label || r.kind,
    what: meta.what || r.kind,
    targetKey: r.target_key || null,
    sendAt: r.send_at instanceof Date ? r.send_at.toISOString() : r.send_at,
    sendAtText: describeWhen(r.send_at),
    status: r.status,
    attempts: r.attempts || 0,
    sentAt: r.sent_at ? (r.sent_at instanceof Date ? r.sent_at.toISOString() : r.sent_at) : null,
    lastError: r.last_error || null,
    lastErrorCode: r.last_error_code || null,
    createdBy: r.created_by || null,
    createdByName: r.created_by_name || null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

/** What is queued (and what recently happened) on one file. */
async function listForApp(appId, dbc = db) {
  const rows = (await dbc.query(
    `SELECT s.*, su.full_name AS created_by_name
       FROM scheduled_sends s
       LEFT JOIN staff_users su ON su.id = s.created_by
      WHERE s.application_id=$1
        AND (s.status IN ('scheduled','sending') OR s.updated_at > now() - interval '7 days')
      ORDER BY (s.status IN ('scheduled','sending')) DESC, s.send_at ASC
      LIMIT 100`, [appId])).rows;
  return rows.map(shape);
}

/* ── the dispatcher ───────────────────────────────────────────────────────── */

/* The routers are required LAZILY, inside the call. They require half this
   library back (and the whole express app), so requiring them at module load
   makes this file unloadable from a pure test and risks a cycle. */
function routerFor(name) {
  return name === 'sitewire' ? require('../routes/sitewire') : require('../routes/staff');
}

/**
 * Mint the credential the scheduled send will act with — and let the ORDINARY
 * auth path be the gate.
 *
 * The first cut of this handed the route a hand-built `req.actor`, skipping
 * `requireAuth` entirely. That was wrong twice over: the staff router mounts
 * `requireAuth` itself, so the send never reached the handler at all — and more
 * importantly, a hand-built actor is a SECOND definition of "is this person
 * still allowed in", and the one that drifts is the one that leaks. `requireAuth`
 * checks four things a scheduled send genuinely must respect, and they are
 * exactly the ones that change between 2am and 8am: the account is still active,
 * its `token_version` has not moved (a password change or a sign-out-everywhere
 * revokes it), the session was not revoked, and the role/capability set is
 * re-read from the database rather than remembered.
 *
 * So this reads the CURRENT token_version and mints a token that lives for a
 * minute — long enough for one send, useless if it leaks — and the route
 * authenticates it the ordinary way. The pre-checks here are for a clear
 * message, not for the gate.
 *
 * @returns {null | {token, actorId}}
 */
async function credentialFor(staffId, dbc = db) {
  if (!staffId) return null;
  const r = (await dbc.query(
    `SELECT id, role, token_version, is_active, is_external FROM staff_users WHERE id=$1`, [staffId])).rows[0];
  if (!r || r.is_active === false) return null;
  // An external staff row is a TPO broker, who has no business on an internal
  // router — the same exclusion every internal roster query applies.
  if (r.is_external === true) return null;
  const C = require('./crypto');
  return {
    actorId: r.id,
    token: C.signJwt({ sub: r.id, kind: 'staff', role: r.role, tv: r.token_version || 0 }, 60),
  };
}

/**
 * Run one row's send by re-entering its real route.
 *
 * The response shim records instead of writing to a socket. It answers every
 * method an express handler might reach for so a handler that sets a header or
 * ends the response cannot throw here — a send must never fail because the thing
 * calling it was not a real HTTP request.
 */
function callRoute(router, method, url, { token, body }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const res = {
      statusCode: 200, body: null, headersSent: false,
      status(c) { this.statusCode = c; return this; },
      set() { return this; }, setHeader() { return this; }, header() { return this; },
      type() { return this; }, vary() { return this; }, append() { return this; },
      cookie() { return this; }, clearCookie() { return this; },
      locals: {},
      json(b) { this.body = b; this.headersSent = true; done({ status: this.statusCode, body: b }); return this; },
      send(b) { this.body = b; this.headersSent = true; done({ status: this.statusCode, body: b }); return this; },
      end() { this.headersSent = true; done({ status: this.statusCode, body: this.body }); return this; },
      sendStatus(c) { this.statusCode = c; return this.end(); },
    };
    const req = {
      method, url, originalUrl: url, path: url.split('?')[0],
      baseUrl: '', params: {}, query: {}, body: body || {},
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      // `requireAuth` reads the credential through `req.get`, so this has to
      // behave like express's — case-insensitive, and answering the header it
      // was actually given.
      get(name) { return this.headers[String(name || '').toLowerCase()]; },
      header(name) { return this.get(name); },
      ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' },
      // Marks this as PILOT running somebody's scheduled send rather than a live
      // click, for anything downstream that wants to know (audit detail, tests).
      scheduledSend: true,
    };
    try {
      router(req, res, (err) => {
        // Falling out of the router means no route matched, or a handler called
        // next(err). Either way nothing was sent.
        // NO ROUTE MATCHED is a different fact from "the file was not found",
        // and it must not be able to masquerade as one: a typo in the registry's
        // path would otherwise present as an ordinary missing file, on every row,
        // for ever. `no_route` is asserted against in the test.
        done({ status: err ? 500 : 404,
          body: err ? { error: err.message || 'server error' }
            : { error: 'PILOT could not find the send route for this — tell an administrator.', code: 'no_route' } });
      });
    } catch (e) {
      done({ status: 500, body: { error: (e && e.message) || 'server error' } });
    }
  });
}

/** Is this failure worth trying again, or is it the answer? */
function isTransient(status) {
  // 5xx is "something on our side broke" — a database blip, a mail provider
  // wobble. 4xx is a DECISION (the file is closed, the contact is missing, it is
  // already ordered) and re-running it changes nothing but the log.
  return Number(status) >= 500;
}

const MAX_ATTEMPTS = 3;

/* How long a row released for a retry waits before it may be claimed again —
   one dispatcher tick. */
const RETRY_AFTER_SEC = Number(process.env.SCHEDULED_SEND_RETRY_SEC || 60);

/**
 * Claim and run the oldest due send. Returns null when there is nothing to do.
 *
 * CLAIM-THEN-ACT with `FOR UPDATE SKIP LOCKED`, so two web instances never run
 * one row twice — an order email is the last thing that should be sent twice.
 */
async function runOne(dbc = db, opts = {}) {
  const claimed = (await dbc.query(
    `UPDATE scheduled_sends s
        SET status='sending', attempts=attempts+1, claimed_at=now(), updated_at=now()
      WHERE s.id = (
        SELECT id FROM scheduled_sends
         WHERE status='scheduled' AND send_at <= now()
           -- A ROW PUT BACK FOR A RETRY WAITS A TICK. Without this the retry is
           -- eligible the instant it is released, so the dispatchDue loop
           -- re-claims it and burns every attempt inside ONE minute — which is
           -- not a retry, it is the same failure three times in a row against a
           -- provider that has had no time to recover. Measured: a title order
           -- attempted three times in one tick. claimed_at is only ever set by
           -- this claim, so it doubles as the backoff clock.
           AND (claimed_at IS NULL OR claimed_at < now() - ($1 || ' seconds')::interval)
         ORDER BY send_at ASC
         LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [String(opts.retryAfterSec == null ? RETRY_AFTER_SEC : opts.retryAfterSec)])).rows[0];
  if (!claimed) return null;

  const settle = async (patch) => {
    await dbc.query(
      `UPDATE scheduled_sends
          SET status=$2, last_error=$3, last_error_code=$4,
              sent_at = CASE WHEN $2='sent' THEN now() ELSE sent_at END, updated_at=now()
        WHERE id=$1`,
      [claimed.id, patch.status, patch.error || null, patch.code || null]).catch(() => {});
    return { id: claimed.id, kind: claimed.kind, ...patch };
  };

  // TOO LATE TO BE USEFUL. Better to tell somebody than to post a 9am order at
  // 4pm as though nothing happened.
  const lateMs = Date.now() - new Date(claimed.send_at).getTime();
  if (lateMs > STALE_AFTER_MIN * 60 * 1000) {
    const out = await settle({ status: 'failed', code: 'stale',
      error: `This was due ${describeWhen(claimed.send_at)} and PILOT only reached it ${Math.round(lateMs / 60000)} minutes later, so it was NOT sent. Send it now if it is still wanted.` });
    await notifyOwner(claimed, out, dbc);
    return out;
  }

  const meta = KINDS[claimed.kind];
  if (!meta) {
    return settle({ status: 'failed', code: 'unknown_kind', error: 'PILOT no longer knows how to send that.' });
  }

  const cred = await credentialFor(claimed.created_by, dbc);
  if (!cred) {
    const out = await settle({ status: 'failed', code: 'no_actor',
      error: 'The person who scheduled this no longer has access, so it was NOT sent.' });
    await notifyOwner(claimed, out, dbc);
    return out;
  }

  const router = (opts.routerFor || routerFor)(meta.router);
  const r = await callRoute(router, 'POST', meta.path(claimed), {
    token: cred.token, body: (claimed.payload && typeof claimed.payload === 'object') ? claimed.payload : {},
  });

  // A refused SESSION is not a refused ORDER. `requireAuth` answers 401 when the
  // account was turned off, its token_version moved, or the session was revoked
  // between the scheduling and now — none of which a retry can mend, and all of
  // which the person must hear about in those words rather than as "the send
  // answered 401".
  if (r.status === 401 || r.status === 403) {
    const out = await settle({ status: 'failed', code: 'no_longer_permitted',
      error: 'The person who scheduled this no longer has access to this file, so it was NOT sent.' });
    await notifyOwner(claimed, out, dbc);
    return out;
  }

  if (r.status >= 200 && r.status < 300) {
    return settle({ status: 'sent', code: null, error: null });
  }
  const msg = (r.body && (r.body.error || r.body.message)) || `The send answered ${r.status}.`;
  const code = (r.body && r.body.code) || `http_${r.status}`;
  if (isTransient(r.status) && (claimed.attempts || 1) < MAX_ATTEMPTS) {
    // Put it back for the next tick. `send_at` is left alone so it stays overdue
    // and keeps its place at the front of the queue — and so the staleness rule
    // above still measures against the time the person actually asked for.
    await dbc.query(
      `UPDATE scheduled_sends SET status='scheduled', last_error=$2, last_error_code=$3, updated_at=now()
        WHERE id=$1`, [claimed.id, msg, code]).catch(() => {});
    return { id: claimed.id, kind: claimed.kind, status: 'retry', code, error: msg };
  }
  const out = await settle({ status: 'failed', code, error: msg });
  await notifyOwner(claimed, out, dbc);
  return out;
}

/**
 * Tell the person who scheduled it that it did not go.
 *
 * A scheduled send that fails silently is worse than no scheduling at all: the
 * person believes the vendor has the order and nobody is chasing. Best-effort —
 * it may never turn a recorded failure into a thrown one.
 */
async function notifyOwner(row, out, dbc = db) {
  try {
    if (!row.created_by) return;
    const meta = KINDS[row.kind] || {};
    await require('./notify').notifyStaff(row.created_by, {
      type: 'sync_review',
      title: `Scheduled send did NOT go out — ${meta.label || row.kind}`,
      body: `You scheduled ${meta.what || 'a send'} for ${describeWhen(row.send_at)}. It did not go out: ${out.error}`,
      applicationId: row.application_id,
      link: `/internal/app/${row.application_id}`,
    }, dbc);
  } catch (_) { /* the row already records it */ }
}

/** Surface a row abandoned mid-send by a crash. Never re-runs it. */
async function reapStuck(dbc = db) {
  const rows = (await dbc.query(
    `UPDATE scheduled_sends
        SET status='failed', last_error_code='interrupted',
            last_error='PILOT restarted while this was being sent. It may or may not have gone out — check the Email Center before sending it again.',
            updated_at=now()
      WHERE status='sending' AND claimed_at < now() - ($1 || ' minutes')::interval
      RETURNING id, kind, application_id, created_by, send_at`, [String(CLAIM_STUCK_MIN)])).rows;
  for (const r of rows) await notifyOwner(r, { error: 'PILOT restarted while it was being sent — check the Email Center before sending it again.' }, dbc);
  return rows.length;
}

/** One tick: everything that is due, up to a sane cap. */
async function dispatchDue(dbc = db, opts = {}) {
  const out = [];
  await reapStuck(dbc).catch(() => {});
  const CAP = 20;
  let drained = false;
  for (let i = 0; i < CAP; i++) {
    const r = await runOne(dbc, opts);
    if (!r) { drained = true; break; }
    out.push(r);
  }
  // NEVER A SILENT CAP. Anything left waits for the next tick a minute away, which
  // is not a loss — but a queue that keeps hitting this is worth seeing.
  if (!drained) console.warn(`[scheduled-sends] ${CAP} sent this tick; more are due and will go on the next one`);
  return out;
}

let timer = null;
/** Started from server.js, exactly like the reminder dispatcher. */
function start() {
  if (timer) return;
  if (process.env.SCHEDULED_SENDS_DISABLED === '1') {
    console.log('[scheduled-sends] disabled by SCHEDULED_SENDS_DISABLED=1');
    return;
  }
  timer = setInterval(() => {
    dispatchDue().catch((e) => console.error('[scheduled-sends] dispatch:', e && e.message));
  }, 60 * 1000);
  timer.unref();
  console.log('[scheduled-sends] dispatcher started (checks every minute)');
}

module.exports = {
  KINDS, isKind, TZ, MAX_AHEAD_DAYS, STALE_AFTER_MIN, MAX_ATTEMPTS, RETRY_AFTER_SEC,
  parseNyLocal, describeWhen, whenProblem, nyOffset,
  schedule, cancel, listForApp, shape,
  runOne, dispatchDue, reapStuck, credentialFor, callRoute, isTransient,
  start,
};
