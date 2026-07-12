# Section 1 — The Front Door: Accounts & Access

_Part of the [Portal Look-Back Audit](./00-MASTER-PLAN.md). We only write up
problems here — no code is being changed._

---

## What this section is about

This is the **front door** of the portal — everything about *getting in* and
*who you are once you're in*:

- Borrowers creating an account, logging in, and resetting a password.
- Staff (loan officers, processors, underwriters, admins) logging in.
- The "second code" (MFA) step.
- Staff invites.
- The **permission system** — who is allowed to see which loan file, and who is
  allowed to do what.
- The invisible "login pass" your browser carries around after you sign in (the
  thing that keeps you logged in). We call it a **login pass** below; developers
  call it a token.

**What we wanted to accomplish here (from all our past chats):** two clean,
separate worlds. Borrowers only ever see **their own** file, in a
**borrower-safe** version. Staff see the inside, but only the files they're
allowed to. A fired employee is cut off instantly. Our internal numbers (margin,
capital-partner names) never cross over to the customer.

**The good news:** the core "walls" are genuinely well built (see
[What's already solid](#whats-already-solid-dont-re-worry-about-these) at the
bottom). The problems below are real, but they're mostly *gaps around the
edges*, not the walls falling down.

---

## The scoreboard for this section

| 🔴 Critical | 🟠 High | 🟡 Medium | ⚪ Low | Total |
|:-:|:-:|:-:|:-:|:-:|
| 1 | 4 | 6 | 5 | **16** |

The four that matter most for **"what's leaking to the borrower"** and
**"what could a borrower or a lower-level employee do that they shouldn't"** are
**S1-03, S1-04, S1-01, and S1-05**. Start there.

---

## The findings

Each one is written the same simple way:
**🐞 The Bug** → **🔎 Troubleshooting** (what's really going on) →
**🔧 The Fix** (a plain instruction, not code).

---

### 🔴 S1-04 — A borrower can rewrite the price of their own loan using a password that's printed inside the code
**Severity: 🔴 Critical** · Where: `src/config.js:135`, `src/routes/borrower.js:355-368, 412-428`

**🐞 The Bug.** There's a secret "admin unlock" password that lets whoever knows
it change the *staff-only* pricing on a loan — our profit margin, the points, and
the fees. That password is written directly into our code as `Yscg@12345`. If we
haven't overridden it on the live server, then **every borrower effectively has
that password**, and a borrower could lower the margin and fees on their **own**
loan and lock those cheaper terms in as the official ones.

**🔎 Troubleshooting.** When a borrower asks the system for a price, the code
normally only lets them touch a few safe settings. But there's a special path: if
the request carries an `adminKey` that matches the server's key, the system also
accepts staff-grade changes — markup %, origination points, lender/credit/
appraisal/title fees. The server's key comes from a setting called
`ADMIN_PRICING_KEY`, and **if that setting is empty, the code falls back to the
word `Yscg@12345`, which is sitting right there in the repository.** Worse, the
"register" step — the one that makes the terms *official* — only throws away
fake experience numbers; it keeps the margin and fee changes. So a borrower who
sends that key could register a loan at a margin we never agreed to.

**🔧 The Fix.**
1. Delete the built-in `Yscg@12345` fallback so the feature simply **turns off**
   unless we set a real, private key on the server.
2. Set a fresh `ADMIN_PRICING_KEY` on the live server and confirm it's set.
3. Better still: **never accept margin/fee changes from a borrower's session at
   all** — those belong only to staff screens. A borrower should never be able to
   send that unlock key in the first place.

---

### 🟠 S1-03 — A borrower's own file screen shows them our internal profit margin (and can show a co-borrower the other person's private info)
**Severity: 🟠 High** · Where: `src/routes/borrower.js:272-315`, `src/lib/redact.js`

**🐞 The Bug.** When a borrower opens their loan file, the system sends their
browser a bundle of data. Two things that should be hidden are riding along in
that bundle: (1) our **internal pricing** — the margin/markup and fee build-up we
make on their loan — and (2) the **raw application blob**, which still holds
things like date of birth, home address, phone, and FICO.

**🔎 Troubleshooting.** This screen is built by grabbing *everything* about the
file and then deleting a hand-written list of "secret" fields before sending it.
That delete-list is the weak spot. It **doesn't include** the registered pricing
quote (`registered_quote`), so the internal margin inside it goes out. It also
**doesn't include** the raw application (`raw_intake`); the only cleanup on that
blob removes the Social Security number, so the rest of the personal info stays.
We know these are supposed to be hidden because the *sibling* pricing screen
(`/pricing`) deliberately strips the exact same margin field — this screen just
forgot to. And on a **joint loan**, "the borrower" viewing the file could be the
co-borrower, so the primary borrower's raw personal info can land in the
co-borrower's hands.

**🔧 The Fix.** Flip the rule from a "hide-list" to a **"show-list."** Instead of
sending everything and trying to remember what to remove, decide the exact short
list of fields the borrower screen actually needs, and send only those. As an
immediate patch, add the registered pricing quote and the raw application to the
hide-list, and run the same margin-strip the pricing screen already uses.

---

### 🟠 S1-01 — A fired staff member can keep watching live chat after being shut off
**Severity: 🟠 High** · Where: `src/routes/events.js:18-25`, `src/routes/admin.js` (deactivate)

**🐞 The Bug.** When we "deactivate" an employee, the normal parts of the portal
correctly slam the door on them. But the **live-updates channel** — the thing
that makes chat messages pop in instantly — has its own, weaker door check. A
just-fired loan officer can keep a live connection open and **keep receiving new
chat messages** (both borrower messages and internal team chatter) on their old
files.

**🔎 Troubleshooting.** Signing in gives the browser a login pass. The regular
portal, on every request, re-checks "is this staff account still active?" and
blocks them the moment they're deactivated. The live-updates channel skips that
"still active?" check — it only checks that the pass hasn't been version-bumped.
And here's the catch: **deactivating someone does not bump that version.** So
their old pass stays valid on the live channel until it naturally expires (up to
7 days) or someone also resets their password. They can't pull up documents (that
part is still guarded), but new chat messages keep streaming to them.

**🔧 The Fix.** Two belts, either one closes it, ideally both:
1. Make the live-updates channel run the same **"is this staff still active?"**
   check the rest of the portal already runs.
2. When we deactivate a staffer, **bump their pass version** so *every* channel —
   including the live one — cuts off in the same instant.

---

### 🟠 S1-02 — Staff logins have no lockout, so their passwords can be guessed over and over
**Severity: 🟠 High** · Where: `src/auth/index.js:368-382`, `db/schema.sql` (staff table)

**🐞 The Bug.** If a borrower types a wrong password 6 times, we lock their
account for 15 minutes. **Staff accounts have no such lock at all.** The very
accounts that can see every borrower's file and every Social Security number are
the ones with the *weakest* protection against password guessing.

**🔎 Troubleshooting.** The borrower login counts wrong tries and locks the
account. The staff login doesn't — the staff table doesn't even have a place to
record a failed attempt. The only thing slowing an attacker down is a shared
speed-bump of 30 tries per minute from one internet address. An attacker who
spreads guesses across many addresses (cheap to rent) never trips any per-account
lock and can grind away at a staff password indefinitely.

**🔧 The Fix.** Give staff logins the same "too many wrong tries → lock for a
while" rule borrowers already have — and consider making it stricter for staff
(fewer tries, plus an alert to an admin), since these accounts are the crown
jewels. Record the attempts in the database so the lock survives a restart.

---

### 🟠 S1-05 — Whoever can "manage the team" can quietly promote themselves to full power and take over another admin's account
**Severity: 🟠 High** · Where: `src/routes/admin.js:164-214`, `src/lib/permissions.js:94-99`

**🐞 The Bug.** The "Manage the team" permission is meant for everyday chores —
add a staffer, set their role. But in practice it hands over the **entire
platform**. Someone with it can edit **their own** account and switch on every
powerful permission (see all files, delete files, platform setup, manage the
team). They can also **reset another admin's password** and then log in as that
person.

**🔎 Troubleshooting.** The screen that edits a staff member has one guard: you
can't touch a *super-admin*, and you can't hand out the super-admin role.
Everything else is open. There's **no "you can't edit yourself" rule**, and the
permission-setting accepts **all** permissions with no limit — so a team manager
can tick every box on their own account. And the "set this person's password"
button works on any non-super account, including a regular admin, so one admin
can seize another admin's login (and then anything they do looks like it was that
other person). This only bites when "manage team" is handed to someone who isn't
already fully trusted, or between two regular admins — but it's a real
separation-of-duty hole.

**🔧 The Fix.**
1. Block anyone from changing **their own** role or permissions.
2. Require a **super-admin** to grant the heavy permissions (platform setup,
   delete files, see all files, manage team).
3. Make "reset another admin's password" a **super-admin-only** action, and write
   it to the audit log.

---

### 🟡 S1-06 — Outsiders can figure out which emails are real staff accounts by timing the login
**Severity: 🟡 Medium** (High if combined with S1-02) · Where: `src/auth/index.js:375`

**🐞 The Bug.** The staff login answers *faster* for an email that doesn't exist
than for one that does. That tiny speed difference quietly tells an outsider
which emails are real staff logins.

**🔎 Troubleshooting.** For a real account, the system does the slow work of
checking the password (a few tenths of a second). For an email it doesn't
recognize, it bails out instantly. Measuring that gap reveals real staff emails.
The borrower login already defends against this by doing the same slow work even
for unknown emails — the staff login skips that trick.

**🔧 The Fix.** Make the staff login do the same "waste the same amount of time"
step for unknown or inactive accounts that the borrower login already does, so a
real and a fake email come back in the same amount of time.

---

### 🟡 S1-07 — Registration reveals whether an email is already one of our customers
**Severity: 🟡 Medium** · Where: `src/auth/index.js:147-189`

**🐞 The Bug.** The account-creation step gives three visibly different answers
depending on the email: "you already have an account," "we already have a record
for you," or "welcome, new account." An outsider can type in emails and read
those answers to learn who is already a YS Capital customer.

**🔎 Troubleshooting.** Our forgot-password and verify screens are careful — they
always give the same neutral answer no matter what. Registration is not: it
returns three different results. That's enough for someone to build a list of
"these people are already customers," which is both a privacy leak and a ready-
made target list for scam emails.

**🔧 The Fix.** Make registration give **one neutral answer** for any email that
already exists ("check your email to continue"), and send the right follow-up
email quietly in the background — instead of announcing the account's status on
the screen.

---

### 🟡 S1-08 — You can create an account on someone else's email and get let in before proving it's yours
**Severity: 🟡 Medium** · Where: `src/auth/index.js:141-189`

**🐞 The Bug.** When someone registers a brand-new email, the system logs them in
**right away** — they never have to click a link in that inbox to prove it's
theirs. Email confirmation exists, but nothing actually requires it.

**🔎 Troubleshooting.** Because there's no "prove you own this mailbox" gate, a
bad actor could pre-register an account on a real prospect's email (before that
prospect is in our system). Later, if a loan officer opens a file for that same
email, the file — and the borrower's private info — attaches to the **attacker's**
pre-made account. (The reverse order is already blocked: if we *already* have the
person, registration refuses to bind a password and sends an invite instead. It's
only the "attacker got there first" order that's open.)

**🔧 The Fix.** Require the email to be **confirmed** (click the link / enter the
code) before a self-made borrower account gets a real session — or at least
before a staff-created file can be attached to a self-made login. That way,
having the mailbox is always proven before any access is granted.

---

### 🟡 S1-09 — The second-code (MFA) and email-confirm steps have no "too many wrong tries" limit
**Severity: 🟡 Medium** · Where: `src/auth/index.js:222-262, 383-390`

**🐞 The Bug.** The 6-digit second-step codes (both the login MFA code and the
email-confirmation code) can be guessed as many times as you like — nothing locks
after repeated wrong tries except the shared per-minute internet speed-bump.

**🔎 Troubleshooting.** The MFA screen checks the code but never counts wrong
answers. The rotating authenticator code is hard to guess in the moment, so
that's lower risk — but the **email-confirmation** code is a fixed 6 digits that
stays valid for a whole day, which is much more guessable if someone can try in
bulk. There's no per-account lock and no alert to the owner after a burst of wrong
codes.

**🔧 The Fix.** Add a "too many wrong codes → lock and stop accepting this
attempt" rule to both the MFA step and the email-code step, the same way the
password login locks after too many misses.

---

### 🟡 S1-10 — Any staffer on a file can reveal the full credit-card number and security code
**Severity: 🟡 Medium** · Where: `src/routes/staff.js:1539-1556`

**🐞 The Bug.** The screen that shows the saved appraisal payment card reveals the
**full card number, the CVC, expiration, and ZIP.** It's correctly limited to
staff on that file and it's logged — but there's **no extra permission check**, so
a loan officer who never places the order can pull up the full card, not just the
back-office person who actually needs it.

**🔎 Troubleshooting.** The reveal is scoped to the file and written to the audit
trail (good), but it decrypts and returns the card without asking "is this person
allowed to see raw card numbers?" That's more people than necessary touching full
cardholder data, which is a card-industry (PCI) concern.

**🔧 The Fix.** Put full-card reveal behind its **own permission** (something like
"place appraisal orders") so only that role can see the full number and code.
Keep the audit-log entry.

---

### 🟡 S1-11 — The login pass is stored where any page script could read it, and there's no content lockdown
**Severity: 🟡 Medium** · Where: `app/src/lib/api.js:12-16`, `src/lib/security.js:8-13`

**🐞 The Bug.** After sign-in, the browser keeps the login pass in a spot
(`localStorage`) that **any** JavaScript running on our site can read. We also
don't ship a "content lockdown" rule (a CSP) that would limit what scripts are
allowed to run. So one bad script sneaking onto any page of our domain could
steal the pass and quietly become that user.

**🔎 Troubleshooting.** The pass sits in browser storage that scripts can read,
and because the pass auto-renews every time it's used, a stolen one keeps
refreshing itself and stays alive. For a **staff** pass that's silent, lasting
access to every borrower's private info. The content-lockdown rule was left off
on purpose (it would break some inline scripts on the older marketing pages), but
that leaves the portal exposed.

**🔧 The Fix.** Turn on a content-lockdown rule (CSP) scoped just to the portal
(so it doesn't disturb the frozen marketing site), and move toward storing the
pass in a **cookie that page scripts can't read**. At minimum, prioritize the
lockdown rule for the portal.

---

### ⚪ S1-12 — The live-updates channel puts the login pass in the web address, where it can leak into logs
**Severity: ⚪ Low** · Where: `src/routes/events.js:1-19`

**🐞 The Bug.** The live-updates channel can't send the pass the normal (hidden)
way, so it puts the pass right in the web address (`?token=...`). Web addresses
routinely get written into server logs, proxy logs, and browser history — so the
pass can end up sitting in those places.

**🔎 Troubleshooting.** This is a known trade-off (that channel technically can't
attach a hidden header), but the real, long-lived pass in the URL is more exposure
than we need. A short, single-purpose "ticket" would be safer than the full pass.

**🔧 The Fix.** Instead of the real pass, hand the live channel a **short-lived,
one-job ticket** that only works for opening that stream, so the real pass never
lands in a log.

---

### ⚪ S1-13 — Sessions never truly expire; they just keep renewing
**Severity: ⚪ Low** · Where: `src/auth/index.js:87-96`

**🐞 The Bug.** As long as someone keeps using the portal, their session keeps
renewing itself forever. There's no hard "you must sign in again after X days no
matter what."

**🔎 Troubleshooting.** Each active use hands back a fresh 7-day pass, so an
in-use session never hits a fixed end date — it's an idle timeout only. A quietly
stolen staff pass could be kept alive indefinitely, and there's no way to see or
kill a single leaked session (only "log out everywhere").

**🔧 The Fix.** Add a hard maximum session age that forces a real re-login after a
set number of days regardless of activity, and consider a per-device session list
that users or admins can revoke one at a time.

---

### ⚪ S1-14 — A couple of smaller "does this email exist" leaks
**Severity: ⚪ Low** · Where: `src/auth/index.js:207-208, 265-306`

**🐞 The Bug.** Two smaller versions of the S1-07 leak: the login shows a distinct
"account locked" message only for real accounts, and the forgot-password / resend
steps do a little extra work (and take a little longer) only when the email
exists.

**🔎 Troubleshooting.** Both let a patient outsider tell a registered email from
an unregistered one — the locked message directly, and the timing difference more
subtly.

**🔧 The Fix.** Give the same neutral response for locked accounts, and do the
forgot/resend work in the background after answering, so the timing doesn't give
away whether the email is real.

---

### ⚪ S1-15 — A refreshed staff pass can carry an out-of-date role, and the "dev" signing secret is a public word
**Severity: ⚪ Low** (config check) · Where: `src/auth/index.js:93`, `src/config.js:34-50`

**🐞 The Bug.** Two small cleanups. (1) When a staff pass auto-renews, it's
stamped with the role from the *old* pass, not freshly read from the database.
(2) Outside the live server, the secret used to sign passes is the public word
`dev-only-change-me` — anyone who knows it could forge any pass, including a
super-admin.

**🔎 Troubleshooting.** (1) isn't dangerous today — every request re-reads the
real role from the database, so permissions always use the current role; the
stamped pass is just cosmetically stale. (2) The live server is set up correctly
(it generates a real secret), **but any staging or test server that isn't marked
as "production" would be fully forgeable.** Our health page reports a
`jwtStable` flag that confirms this.

**🔧 The Fix.** Stamp the renewed pass with the role read fresh from the database.
And confirm **every** deployed server (including staging/test) is marked as
production so it uses a real, private signing secret — treat a `jwtStable: false`
on the health page as an emergency.

---

### ⚪ S1-16 — Admin screens are protected one-by-one instead of by a single "staff only" wall
**Severity: ⚪ Low (future-proofing)** · Where: `src/routes/admin.js:18-20`

**🐞 The Bug.** The admin area checks permissions on each specific path rather than
putting one blanket "you must be staff" wall at the entrance. Every admin screen
today is covered — but if someone adds a **new** admin screen and forgets the
pattern, that new screen could be reachable by a plain borrower.

**🔎 Troubleshooting.** The admin area only requires "logged in" at the door;
borrowers are logged in too, just not staff. The real protection is bolted onto
each known path. It works now, but it's a trap waiting for the next new route.

**🔧 The Fix.** Add one blanket **"must be staff"** wall at the entrance to the
whole admin area, on top of the per-screen permission checks, so no admin screen
can ever be reached by a borrower — even a brand-new one.

---

## What's already solid (don't re-worry about these)

The agents specifically checked these and found them **correctly protected** —
worth knowing so we don't waste time re-auditing them later:

- **Borrowers can only ever see their own files.** Every borrower screen filters
  by "the person who's logged in." We could not find a single way for one
  borrower to open another borrower's file, documents, LLCs, track record, or
  messages by guessing a number in the web address.
- **Staff file-scoping holds everywhere, not just on the main screen.** A loan
  officer who isn't allowed to "see all files" is blocked from the file's
  documents, conditions, chat, and PII reveals too — not just the front page.
- **A loan officer on one file can't reach another file of the same borrower's**
  documents. Access is tied to the specific file, not the whole person.
- **Social-Security-number reveals are both permission-gated and logged.**
- **A borrower can never reach staff screens.** The staff and admin areas reject a
  borrower's pass outright.
- **You can't fake your way past the login/MFA design.** The half-finished
  "pending MFA" pass can't be used as a real login pass, and the pass can't be
  forged by swapping its signature method — the classic tricks are all closed.
- **The "log everyone out" switch works instantly** (on the normal channels), and
  a password reset kills all old sessions.
- **Passwords are stored the strong, modern way** (scrypt with a random salt),
  and login comparisons are done in constant time.
- **Reset / verify / invite links are strong, single-use, time-limited, and
  stored only as scrambled hashes** — the raw link only ever lives in the email.
- **A borrower can't register or invite themselves as staff**, and a non-super
  admin can't seize a super-admin account.
- **Internal staff chat notes never reach borrowers**, and the system blocks a
  borrower from typing a Social Security or card number into chat.
- **Downloaded files are forced to download** (not opened in the browser) except
  for a safe short list, which blocks a whole class of "malicious file" attacks.

---

## Suggested order to fix (when we get to building)

1. **S1-04** — kill the hardcoded pricing key (borrower can rewrite their loan).
2. **S1-03** — stop the internal-margin / personal-info leak on the borrower's
   file screen.
3. **S1-01** — cut off fired staff from the live chat channel.
4. **S1-02** — add lockout to staff logins.
5. **S1-05** — fix "manage team" self-promotion and peer-admin takeover.
6. Then the Mediums (S1-06 → S1-11), then the Lows.

---

_Next section: **Section 2 — The Borrower's File (what the borrower sees).**_
_We'll go deeper on exactly which pieces of data reach the borrower's screen,
their emails, and their PDFs — the capital-partner-name rule especially._
