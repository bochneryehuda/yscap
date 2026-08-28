# Rotating a compromised credential

**Why this file exists.** CLAUDE.md's standing rule: *a credential pasted into a chat or a
transcript is considered COMPROMISED and must be ROTATED before use.* That rule was invoked, and
the rotation itself turned out to need a runbook — because on this system several credentials are
mirrored into MORE THAN ONE environment variable, and updating only the obvious one leaves a
stale override that silently keeps the old value.

**This file contains no secret values and never will** — only variable names and the order to do
things in. Values live in the Render dashboard and nowhere else.

---

## The rule that makes the order matter

Every rotation is the same two moves in the same order:

1. **Make the new value** at the vendor (Encompass, Render, ClickUp…).
2. **Put it in Render**, in EVERY variable that carries it, THEN restart.
3. **Only then** revoke the old value at the vendor.

Doing 3 before 2 takes the integration down between the two steps. Doing 2 without checking
"every variable that carries it" is the trap this file exists for.

---

## The trap: one credential, two variables

Long-Term and the retail product each have their own Encompass client, and Long-Term's
credentials **fall back** to the shared ones (`src/longterm/config.js`):

```
LT_ENCOMPASS_CLIENT_ID      || ENCOMPASS_CLIENT_ID
LT_ENCOMPASS_CLIENT_SECRET  || ENCOMPASS_CLIENT_SECRET
LT_ENCOMPASS_INSTANCE_ID    || ENCOMPASS_INSTANCE_ID
LT_ENCOMPASS_USERNAME       || ENCOMPASS_USERNAME
LT_ENCOMPASS_PASSWORD       || ENCOMPASS_PASSWORD
LT_ENCOMPASS_API_BASE       || ENCOMPASS_API_BASE
```

(The last one is not a secret — it is which Encompass to talk to — but it falls back the same way
and an override set to a sandbox would stick just as silently, so it is listed with the rest.)

A fallback is only a fallback while the `LT_` variable is UNSET. If one was ever set — even to the
same value — it now holds the OLD password, and rotating `ENCOMPASS_PASSWORD` alone breaks
Long-Term while leaving retail working, which reads like a Long-Term bug and is not one.

The flood client has a third set (`ENCOMPASS_FLOOD_CLIENT_ID` / `_SECRET` / `_INSTANCE_ID` /
`_USERNAME` / `_PASSWORD`). Its fallback is written a layer lower — `src/config.js` leaves each one
`null` and `src/encompass/flood-order.js` falls back per field to the retail value — but the effect,
and the trap, are identical.

**So: before rotating an Encompass credential, list which of the three sets are actually SET in
Render.** Update every one that is. Leave the unset ones unset — that is what makes them follow.

---

## The credentials that were exposed, and how each is replaced

### 1. The Render API key

Render dashboard → Account Settings → API Keys → create a new key, then delete the old one.

Nothing in `src/` reads a `RENDER_API_KEY`, so the running application does not need restarting and
no Render variable has to change. It IS used by hand: the database restore procedure in
`docs/DATABASE-BACKUP-AND-RESTORE.md` passes it to `curl` as a shell variable. Update it wherever
YOU keep it — a shell profile, a CI secret, a note — and remember that a key you can no longer find
is a key you cannot revoke, which is the argument for deleting the old one at Render rather than
just making a new one.

### 2. The five Encompass values

`ENCOMPASS_CLIENT_ID`, `ENCOMPASS_CLIENT_SECRET`, `ENCOMPASS_INSTANCE_ID`, `ENCOMPASS_USERNAME`,
`ENCOMPASS_PASSWORD`.

- **Instance id** is not a secret and does not change — it identifies the tenant.
- **Client id / client secret** belong to the API application in ICE's developer portal. Roll the
  secret there; the id usually stays.
- **Username / password** are the API user's own Encompass login. Change the password in
  Encompass admin.

**While you are in there, check the API user's persona is READ-ONLY.** That is the credential half
of the read-only rule (`docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md`) — the code half is enforced on
every build, but a read-only persona means Encompass itself would refuse a write even if the code
gate were ever wrong.

**A safe way to do this with no window of breakage:** `ENCOMPASS_ENABLED=0` switches the whole
connection off in one place, for both products, without deleting or rewriting anything
(`docs/ENCOMPASS-MASTER-SWITCH.md`). Switch off, rotate at both ends, switch back on. Every screen
that explains a stopped connection will say it was switched off deliberately rather than showing
an error.

### 3. The two webhook secrets

- **The old drivekosher rule's secret.** It is not read by this application at all. Change it in
  the Encompass rule and at whatever receives it.
- **`LT_ENCOMPASS_WEBHOOK_SECRET`** — the one PILOT checks on `POST /api/lt/encompass-hook`. Set
  the new value in Render FIRST, restart, then change the header value in the Encompass rule.
  Between those two moments the rule's pings are answered `403` and dropped, which is harmless:
  the sync's own rota still reads every loan on its own schedule, so the only cost is that
  updates are on the timer instead of instant until the rule catches up.

The endpoint **fails closed**: with the variable unset it answers `503` and accepts nothing, so
there is no window in which an un-rotated or missing secret lets anything through.
`docs/longterm/ENCOMPASS-WEBHOOK-SETUP.md` has the full setup, including how to tell a wrong
secret (`403`) from an unset one (`503`).

---

## Checking it worked

- **Encompass:** the internal API-Health screen pings the connection and reports the reason when
  it cannot. A rotated-and-mismatched password shows there as an auth failure, not as missing
  data on a loan screen.
- **The webhook:** the `curl` in `docs/longterm/ENCOMPASS-WEBHOOK-SETUP.md` step 5. `403` means
  the secret does not match; `503` means it is not set at all.
- **Long-Term specifically:** if retail works and Long-Term does not, re-read the trap above —
  that is the signature of an `LT_`-prefixed override still holding the old value.

---

## What must never happen during a rotation

Nothing in this repository may ever hold a secret VALUE — not a tracked file, not a doc, not a
commit message, not a PR body, not a code comment. `.env` is git-ignored and stays that way. If a
rotated value needs to reach somebody, it goes through the Render dashboard, not through the
codebase.
