# Class Valuation callbacks — registration, verification and rotation

Class Valuation pushes order events (status changes, notes, attachments, payment,
appointments …) to a URL we register with them. This runbook is how that registration
is created, checked, and — because their API has no update operation — replaced.

The source of truth for their side is their "Webhook Self-Registration Guide"
(2026-09-03). The facts from it that shape everything below:

- One call registers all 15 event types: `POST /intg/callbacks/addAll`.
- `GET /intg/callbacks` returns the password **in plaintext** to any token holder in our
  organisation. The password must therefore be a high-entropy value used for nothing
  else, and no tool here ever prints it.
- There is **no update**. GET, POST and DELETE only. Rotating the password or moving the
  URL is delete-and-recreate.
- The URL is matched **exactly**. `…/callbacks` and `…/callbacks/` are two destinations
  and each would get a full set of registrations → duplicate deliveries on live orders.
- Registration takes effect **immediately** against live orders. The endpoint must be
  ready first: answer 200 within 30 seconds, validate the Basic-auth header on every
  request, and tolerate at-least-once delivery by deduplicating on
  `orderId + eventName + created`.

## What PILOT has

| Piece | Where |
|---|---|
| Public receiver | `POST https://yscapgroup.com/api/class/callbacks` (`src/routes/class-webhook.js`) — Basic auth, fails closed without credentials, answers 200 before it thinks, dedupes on their identity (`orderId + eventName + created`), falls back to bytes-per-day when the envelope lacks them. |
| Interpretation | `src/class/callbacks.js` — off the request path, retried, never loses a delivery. |
| Credentials | Render environment of the `yscap` service: `CLASS_CALLBACK_URL`, `CLASS_CALLBACK_USER`, `CLASS_CALLBACK_PASSWORD` (+ `CLASS_CALLBACK_PASSWORD_PREVIOUS` during a rotation). |
| Operator tool | `npm run class:callbacks -- <command>` (`scripts/class-callbacks.js`) — runs inside the deployed service so no secret passes through a terminal. |
| Record | `class_callback_registrations` (event, URL, Class's id, when) — never the password. |

The canonical URL is `https://yscapgroup.com/api/class/callbacks` — **no trailing slash**.

## Running the tool

The tool needs the service's own environment (the Class API credentials and the callback
password). Run it as a **Render one-off job** on the `yscap` web service, from the
project folder:

```
cd /opt/render/project/src/yscap-repo-root_8 && npm run class:callbacks -- <command>
```

Read the output in the job's log. Every line is prefixed `[class-callbacks]`; add
`--json` for one JSON object per line. Nothing it prints is secret: passwords and
usernames appear only as lengths and match/no-match booleans.

| Command | What it does | Exit 0 means |
|---|---|---|
| `list` | Shows the switches, the URL, the password's strength, every registration Class holds (masked), and what our database recorded. | ran |
| `verify` | Judges Class's list against our intent. | our URL has all 15 events, BasicAuth, our current username and password, and no trailing-slash twin |
| `register` | Preflight (switches on, https URL without trailing slash, a real password), then `addAll`, records the ids, then `verify`. Refuses when a twin or a stale credential is already registered (use `rotate`). | registration complete |
| `selftest` | Hits the public receiver from the outside with the real credentials: 401 without them, 401 with the wrong password, 200 with them inside 30 s, a retry collapses to one stored row, cleanup. | the receiver honours the contract |
| `delete <id>` | Deletes one registration by Class's id. | deleted |
| `rotate --confirm` | Deletes every registration for our URL (twins included) and registers again with the **current** `CLASS_CALLBACK_PASSWORD`. | registration complete |

All writes go through the same `CLASS_ENABLED` / `CLASS_OUTBOUND_ENABLED` / `CLASS_DRYRUN`
switches as every other write to Class. With `CLASS_DRYRUN=1` the tool prints what it
would send and sends nothing.

## First registration

1. Confirm the receiver: `selftest` → `SELFTEST_OK`.
2. `register` → `VERIFY … complete: true`.
3. Send the password to Class through a secure channel (they asked for it; never by email).
   The value is in the Render environment; do not paste it into chat.
4. Watch the first live order: `class_callback_events` gains rows and the order card on
   the file moves on its own.

## Rotating the password (delete-and-recreate)

Class's guide: "make sure your endpoint accepts both the old and new credentials during
the swap." PILOT does that through `CLASS_CALLBACK_PASSWORD_PREVIOUS`.

1. In Render, set `CLASS_CALLBACK_PASSWORD_PREVIOUS` to the **current** password and
   `CLASS_CALLBACK_PASSWORD` to the **new** one (a fresh 32-byte random value). Save;
   the service redeploys. From this moment the receiver accepts either password.
2. Run `rotate --confirm`. It deletes every registration for our URL and re-registers
   all 15 events with the new password. Deliveries Class sends in the seconds between the
   delete and the addAll are retried by them (at-least-once), and the receiver is
   answering throughout.
3. Run `verify` → `complete: true`. If `rotate` failed part-way (the delete went
   through but the addAll did not), run `register` again — it adds only what is missing.
4. Remove `CLASS_CALLBACK_PASSWORD_PREVIOUS` in Render. Save; redeploy. The old password
   is dead.
5. Send the new password to Class through the secure channel.

## Moving the URL

Same shape as a rotation: set the new `CLASS_CALLBACK_URL` (https, no trailing slash),
make sure the new address answers (`selftest`), then `rotate --confirm` — it deletes the
registrations under the old URL only if they are still listed under our current intent;
delete leftovers under the old URL with `delete <id>` from the `list` output.

## If something is wrong

- `VERIFY_FAIL … trailing-slash twin`: both forms are registered → duplicate deliveries.
  `rotate --confirm` removes both and re-registers the canonical one.
- `VERIFY_FAIL … password is not the current`: Class holds an older password. Either
  set `CLASS_CALLBACK_PASSWORD_PREVIOUS` to that older value and rotate (safe), or rotate
  straight away and accept a short window of 401s that Class retries.
- `REFUSED … CLASS_OUTBOUND_ENABLED`: writes to Class are switched off. Flip it on the
  API-Health page, or leave it off and run `list` / `verify` / `selftest`, which never write.
- `ADDALL … couldNotBeAdded` non-empty: a partial registration. Their reply names the
  events; run `verify`, then `register` again — addAll adds only what is missing.
- Deliveries arrive but nothing moves on the file: check `class_callback_events` for
  `process_error`; the drain retries with backoff and the poller settles anything left.

## What never changes

- The receiver never trusts the path; the body names the event.
- A 5xx from us asks them to retry; a 2xx tells them to stop. Anything we could not store
  is answered 5xx; anything we stored — including a marker for a body we cannot keep — is 200.
- The password is never written to a document, a commit, a PR, a log line or a chat.
