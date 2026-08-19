# Loan Officer Settings — the full audit and the catalog of what we can build (RTL)

**Owner request (2026-08-19):** *"We want to give more control to the loan officers in their settings so they can
do stuff and customize the system according to them. Make a full audit of the system and compare it to industry
standards… Give me a list of all the settings that you think you can give the loan officer… Don't build anything.
Just take a few hours, give me a whole list of ideas, and then we're going to start building it."*

**Product:** RTL only. Nothing in this document touches the Long-Term side, and none of it proposes crossing the
two products. Research only — no code was changed for this document.

This document has five parts:

1. **What loan officers can already control today** — the honest audit. More exists than "notifications and CC
   the borrower": the notification system is already deep, and personal dashboards exist. But those are the
   only deep areas.
2. **How a setting becomes real in PILOT** — the plumbing we already have, so every idea below names the exact
   way it would work.
3. **How the industry does it** — what Encompass, Floify, Blend, the mortgage CRMs, and best-in-class general
   software give each individual user, and where PILOT stands against that.
4. **THE CATALOG** — every setting we can offer, numbered (S1, S2, …) so you can say "build S12 and S31".
   Each one says what it does in plain words, what happens today, how it would work, and how big a job it is.
5. **What must NEVER become a personal setting** (the guardrails), and **the order I would build in**.

---

## Part 1 — What a loan officer can already control today (the audit)

### 1a. Notifications — already built, and deeper than most commercial systems

The Notification Center (`/internal/notifications`, `StaffNotificationCenter.jsx`) has five tabs, and behind
them TWO independent control systems, both live today:

**What my borrowers receive** (the outbound gate — `src/lib/lo-notification-gate.js`;
tables `lo_notification_prefs` / `lo_notification_rules` / `lo_notification_file_overrides` /
`lo_notification_drafts`, db/226–228):

- A catalog of 94 notification types in 14 categories. Per type: send automatically / hold as a **draft** for
  my review / off entirely — with bulk "everything automatic / everything manual / everything off" buttons.
- Per FILE override (on the file screen, assigned officer only): pin one type — or the whole file — to a mode,
  with one-click presets: *Follow my defaults / VIP (everything automatic) / Quiet (park as drafts) / Silence*.
- A Gmail-style **Drafts queue**: preview the exact email, edit subject/body, send / schedule / snooze /
  discard, one by one or in bulk — with an auto-send safety net (default 48h) so a held message is never lost.
- **Learning mode**: a new officer can turn on 72 hours of "everything drafts" and watch what would go out.
- **Rules**: quiet hours, work days, timezone, compose default (send now vs save to drafts), an undo-send
  window (0–60 seconds).
- A **Compose** action (write an ad-hoc notification through the same machinery) and an **Analytics** tab
  (30 days of sent/opened/discarded, per type).
- Hard floor: security / account / DocuSign notifications — and the approval/exception traffic (escalations,
  exception requests and decisions) — are FORCED: no setting can turn them off.

**What I myself receive** (the self gate — `src/lib/lo-self-gate.js`; tables `lo_self_notification_prefs` /
`lo_self_delivery_rules` / `lo_muted_files` / `lo_starred_files` / `lo_batched_emails`, db/368–369):

- Per type: both / email / in-app only / off, and instant / hourly / daily / weekly.
- Master modes: instant / batched (bundle every 15–240 min) / digest-only / no-email (in-app only).
- Vacation dates (hold my email until I'm back — or drop it), weekend hold, quiet hours, work days, timezone.
- Mute a file (silence one deal, optionally until a date), star a file (it breaks through every filter).
- A volume cap (at most N emails an hour) and presence-awareness (actively working in PILOT → skip the email).

**Verdict:** this area is genuinely ahead of the industry standard — most commercial LOS/POS products offer a
flat on/off list per event. The gap is everywhere else.

### 1b. Business settings — the "My settings" screen (exactly two settings)

`lo_settings` (db/391) is the per-officer settings bag the owner directed on 2026-07-31 — *"the loan officers
should have their settings section where they can set different settings … different per loan officer how he
wants to run his business."* It holds exactly TWO keys today (`src/lib/lo-settings.js`):

- **CC my borrowers on title order emails by default** (off by default; flippable on any single order).
- **CC my borrowers on insurance order emails by default** (same).

The screen (`StaffSettings.jsx`, `/internal/settings`) renders whatever keys the server declares, so every new
on/off setting appears there automatically with no screen work. This bag is the designated home for most of the
Phase-1 catalog below — the dashboards module even names it "this repo's pattern for user-authored config."

### 1c. Personal surfaces that already exist (scattered, worth knowing)

- **Personal dashboards** (db/422): every staffer can build their own dashboard of cards, share it with a
  person / a role / everyone, and a company dashboard offers "Make it mine" (a personal fork) instead of
  letting one person's edit change everyone's view. Real per-user customization — but there's no "make this
  my home screen" setting.
- **Custom chat status**: an officer can set an emoji + "In a closing until 4pm" status with an expiry
  (`staff_users.status_emoji/status_text/status_expires_at`).
- **Per-conversation chat mute** (`conversation_members.muted_until`).
- **Sticky view choices — but only per browser**: the file screen remembers conditions filter (mine/all),
  audience, collapsed groups, communications tab, and rooms-vs-classic view in `localStorage`
  (`pilot.filter.*`), and the Email Center keeps read/star state the same way. Switch computers or clear the
  browser and it's gone — none of it follows the officer.
- **Personal work queues** exist as scopes (`?mine=1` pipeline, My Tasks screen) — derived from assignments,
  not configurable.

### 1d. Identity & branding — half exists, nothing is self-service

- Every officer has a personal **marketing link** (`?lo=<code>`, code = the email's left half): the whole
  marketing site brands to them (contact bar on every page), the loan application locks to them, and leads
  posted with their code route to them (leads without a code round-robin).
- Borrower emails already carry a **"Your loan officer"** block (name · title · NMLS · phone · email).
- But: there is **no officer photo anywhere** (avatars are initials), no bio, no personal landing page, no
  email signature block, no scheduling link. An officer **cannot edit their own profile** — title, phone,
  cell, NMLS, even the custom fields the roster serves are admin-only on the Team screen. And the marketing
  site's officer roster is a **hard-coded list inside `brand.js`** (16 officers) that has to be kept in sync
  with the real staff table by hand — a settings project should make that live.

### 1e. Everything else is company-wide or fixed

A non-exhaustive list of one-size-fits-all behaviors today (each is a candidate in the catalog):

- Whether the officer is BCC'd on their borrowers' emails: one global company switch (`CC_LO_ON_BORROWER`
  env var), not per officer.
- Reminder cadences: stale-file nudge (10 days), draw-findings borrower nudge (every 4 hours), the weekly
  borrower "what's still needed" digest, the daily officer pipeline snapshot and weekly book snapshot —
  all global; the two officer digests have **no per-officer schedule or opt-out** (the "digest hour" setting
  in the Notification Center governs batched emails, not these).
- DocuSign reminder schedule: hardcoded (first reminder after 2 days, then every 3 days, expire at 30).
- Timezone/quiet-hours/work-days exist **twice**, set separately on the two notification tabs — no single
  "my working hours" the whole system reads.
- Pipeline default view, file-screen layout, landing page after login: same for everyone.
- Email wording: one shared catalog; no personal templates, snippets, or signature.
- Vendors: title/insurance contacts are typed per file; no officer "favorites" that pre-fill.
- Delegation: `visible_officer_ids` (standing access to a colleague's whole book) exists but only an admin
  can set it; there is no self-service vacation coverage — the vacation setting only holds the officer's own
  email. (Per-FILE assistants are different: anyone on a file can already add one — what's missing is the
  durable, automatic layer.)
- Term Sheet Studio: nothing remembers an officer's habits (program, term, reserve style) between files.

---

## Part 2 — How a setting becomes real in PILOT (so every idea below is buildable)

We already have all four mechanisms a settings system needs. Every catalog entry names which one it rides.

1. **The settings bag** (`lo_settings` + `src/lib/lo-settings.js`): one row per officer, a validated
   whitelist — an unknown key is refused, never stored. Adding a setting = one entry in `SETTINGS_KEYS`
   (+ its default) and the "My settings" screen shows it automatically. Every change is audited
   (`lo_settings_updated`). Consumers read it at the exact chokepoint the behavior already flows through
   (the way `orders.js` reads `ccBorrowerOnTitleOrder` today). **Rule: a new setting's default always equals
   today's behavior — adding a setting changes nothing until an officer opts in.**
   *Today the screen renders on/off switches; a small one-time upgrade adds choice-lists, numbers, and short
   text so richer settings render automatically too.*
2. **The notification tables** (Part 1a): anything about who-gets-told-what-when extends the existing gates —
   never a second mechanism.
3. **The staff profile** (`staff_users` + `GET /api/roster`): identity/branding fields live here so every
   surface that already shows the officer (borrower emails, the branding bar, the loan application dropdown,
   term sheets) picks them up from one place. The roster endpoint already serves the loan application live;
   the branding bar still reads its hard-coded list — one fix and every profile field becomes site-wide.
4. **Per-file override on top of per-officer default**: the established pattern (order CC works this way —
   officer default, flippable on the single order; notifications work this way — per-file override table).
   Every behavioral setting below follows it.

Where something genuinely new is needed (personal templates, saved views that follow you, web push), the
catalog entry says so and sizes it honestly.

---

## Part 3 — How the industry does it, and where PILOT stands

We surveyed the per-officer settings of the major origination platforms (Encompass, Floify, Blend,
SimpleNexus/nCino, Maxwell, BeSmartee, Arive, LendingPad, Calyx, Big POS), the pricing engines (Optimal Blue,
LoanPASS, Lender Price, Polly), the mortgage CRMs (Total Expert, Surefire, Jungo, Shape, Whiteboard, Aidium,
Usherpa, BNTouch), the private-lending platforms closest to our business (LendingWise, Mortgage Automator,
Liquid Logics, Bryt, The Mortgage Office, Lodasoft, Fund Control, Sitewire), and the general software everyone
measures against (Gmail/Outlook, Slack, Salesforce, HubSpot, Linear). Sources are listed at the end of this
document. Three headline findings:

**1. On notifications, PILOT is already ahead of everything we surveyed.** The best the industry shows is
Floify's activity digest with time-of-day, Blend's per-loan-team muting, and Arive's company-AND-user-level
toggles. Nobody surveyed has PILOT's draft-and-review queue, learning mode, presence-awareness, per-file VIP/
quiet/silence presets, or an undo window. Nothing to copy here — only the two officer digests to finish wiring
(S27/S28).

**2. There is a standard "officer package" everywhere else that PILOT simply doesn't have.** Across
essentially every platform: the officer owns a profile (photo, NMLS, licenses, custom title, short bio), gets
a personal landing page / apply link, personal email templates with merge fields, saved pipeline views with a
personal default, and follow-up cadences they tune (Arive lets an officer set borrower reminder timing 1–15
days, globally and per file). The compliance-safe pattern is universal and worth copying exactly: **the
company owns the template, the officer owns identity slots inside it** (signature, photo, booking link,
personal paragraph) — officers personalize identity, never regulated copy.

**3. Two genuine white spaces where PILOT can exceed the industry.** (a) Working hours / out-of-office /
coverage is documented in NO surveyed LOS or POS — it lives only in general software (Gmail/Outlook OOO and
delegation). Group H below would make PILOT the only origination platform where an officer's vacation actually
pauses lead routing and hands off coverage. (b) In the private-lending segment specifically, per-officer
communication/draw settings are unheard of — the hard-money platforms concentrate everything at the company
level. Porting the consumer-POS ideas into RTL already puts PILOT past the segment norm.

### The comparison table

| Setting category | Industry standard (best example) | PILOT today | Catalog |
|---|---|---|---|
| Notification rules | Per-event toggles + digests (Floify, Blend, Arive) | **Ahead of industry** — full center | S27–S33 round-outs |
| Profile & identity self-service | Photo, licenses, custom title, bio (all platforms; Arive display title, Blend bio) | Admin-only; no photo exists | S1–S4 |
| Email signature | Per-user (LendingPad, Shape multi-signature) | None anywhere | S5 |
| Personal landing page / apply link | Floify, Maxwell, Blend LO Pages, Consumer Connect, SimpleNexus app links | `?lo=` branded site (no page, no photo, hand-synced roster) | S8–S10 |
| Personal email templates / slots | Per-LO templates w/ merge tags (Floify per-milestone, Encompass Personal Status Online, Arive 5-per-event, LendingWise LO merge-tag group) | One company catalog, zero personalization | S15, S24, S25, S61 |
| Pipeline saved views + personal default | Encompass custom views, Blend named views, LendingWise personal default + share-to-roles | Pipeline remembers nothing | S36–S38 |
| Follow-up cadences | Arive 1–15 day reminder windows global + per file; Maxwell task reminders; Floify deadline notices | Fixed env values company-wide | S22, S23, S29, S45, S50 |
| Milestone/status update sets | Floify 10 sets × 15 milestones; Encompass per-LO status triggers | Company-governed (deliberately — conditions/status are owner rules) | not personalized (guardrail) |
| Doc request templates / quick packs | Floify quick packs + business rules | Company checklist engine (owner-governed) | S67 (personal quick-adds only — auto-attach stays company-owned) |
| Partner / referral co-branding | SimpleNexus co-branded apps, Floify partner permissions incl. self-serve pre-approval letters | TPO portal (company-level); nothing per-officer | S59 (+ later co-branded links) |
| Pricing personalization | Saved scenarios (LoanPASS), rate alerts (Optimal Blue); margins stay admin | Per-file admin zone w/ approval; no personal layer | S43, S65, S66, S44 (your call) |
| Delegation / co-pilot / assistants | Blend loan teams, Floify co-pilot + auto-approve delegation, Maxwell sender delegation | Borrower-view impersonation exists; per-file assistants self-serve; STANDING delegation admin-only | S18, S53–S56 |
| Working hours / OOO / scheduling | **Nobody in LOS/POS**; Gmail/Outlook + CRMs only (Shape booking link) | Vacation silences own email only | S6, S7, S52–S54 — white space |
| Views following the user across devices | Standard in web SaaS (server-side prefs) | Browser-local only | S34 |
| Saved replies / snippets | HubSpot snippets, Gmail templates | None | S61 |
| Mobile/push channel | SimpleNexus, LO Connect apps | Email + in-app only | S33 |

### What the best settings systems teach (we should build to these)

1. Store personal settings as a **sparse override on company defaults** — never a copy, each level only
   holding what it changed. The draw settings already work exactly this way (their ladder is company →
   capital provider → project, and it reports which level answered); the officer tier slots in as one more
   level of the same pattern: company → officer → file.
2. **Every personal capability is permission-gated** — an admin can restrict any officer's tab (the Shape /
   Aidium model: build / customize-ours / locked per team).
3. **Some notifications are not preferences** — security/compliance events sit outside the system (PILOT
   already does this with FORCED keys).
4. **Put controls on the object, not only the settings page** — "mute this loan" on the loan beats a settings
   screen (S32); actions sync back to the visible preference.
5. **Route to one best channel instead of blasting all** — PILOT's presence-aware rule is already the Slack
   pattern; push (S33) must join that ladder, not bypass it.
6. **Ship "preference profiles"** — a new officer starts from a sane role-based bundle (HubSpot's model), not
   94 unset toggles; PILOT's learning mode is a great first-day default to bundle in.
7. **Let a good personal view be promoted** to a team default (LendingWise/Linear pattern) instead of everyone
   rebuilding it (S37).
8. **A new event type must earn a notification** — interrupt only for action-required (the discipline PILOT's
   in-app-only staff types already follow).

---

## Part 4 — THE CATALOG: every setting we can give a loan officer

Numbered so you can pick by number ("build S17 and S52"). Each entry: what the officer gets, what happens
today, and how it would work. **Size** = Small (about a day), Medium (a few days), Large (a real project).
"Override per file" means the officer's default can still be flipped on any single file/order — the pattern CC
already uses. Two entries are marked ✓ because they already exist — they were the first two settings of
exactly this vision.

Everything below obeys the same four build rules (Part 5 has the full guardrails): the default of every new
setting equals today's behavior; a setting personalizes the officer's OWN lane and never weakens a company
gate; every change is audited; and borrower-safe scrubbing/compliance wording runs the same regardless of any
setting.

---

### Group A — My profile & how I appear to borrowers

The biggest single gap vs. the industry. Every officer-facing platform we surveyed starts here: the officer
owns their identity card, and the system injects it everywhere (emails, pages, signatures). In PILOT the
officer card exists (emails already show "Your loan officer: name · title · NMLS · phone") but the officer
can't touch any of it, there's no photo anywhere, and the marketing site's officer list is a hand-maintained
copy.

- **S1 — Edit my own contact card** *(Small–Medium)*
  My title, direct line, cell, extension — I keep them current myself instead of asking an admin.
  **Today:** admin-only on the Team screen. **How:** a self-service "My profile" screen writing the existing
  `staff_users` fields; regulated fields (my NMLS number, my legal name) stay admin-approved — I can request a
  change, an admin confirms it. Everything that already shows my card picks it up automatically.

- **S2 — My photo** *(Medium)*
  My headshot on borrower emails' officer block, the borrower portal's "Your loan officer" card, my marketing
  bar, the team page, and chat. **Today:** no officer photo exists anywhere in the system — avatars are
  initials.
  **How:** one new profile field + an upload (through the normal document plumbing), then added to the
  officer block surfaces one by one.

- **S3 — My short bio** *(Small)*
  Two or three sentences about me, shown on my landing page (S10) and in the "Meet your loan officer" email.
  **Today:** doesn't exist. **How:** a profile text field; the borrower-safe scrub runs on it like on any
  free text.

- **S4 — How my name reads** *(Small)*
  "Yudi Bochner" instead of a formal legal name, everywhere borrowers see me. **Today:** one `full_name`
  field used for everything. **How:** a display-name profile field; legal name stays for internal/regulated
  surfaces.

- **S5 — My email signature block** *(Medium)*
  A proper sign-off (closing line, name, title, direct line, NMLS) appended to the emails that go out with my
  name on them — vendor orders, closing-prep to the attorney, my Email Center replies. **Today:** those
  emails end with a fixed three-line "Thank you, {name}, YS Capital Group" — nothing else exists. **How:** a
  structured signature (fields, not free HTML) stored on my profile; the two places that build those sign-offs
  read it. The company compliance footer on borrower emails stays exactly as is — the signature adds, never
  replaces.

- **S6 — My scheduling link** *(Small)*
  My Calendly/Bookings URL, shown as "Book a call with me" in my officer block and on my landing page.
  **Today:** doesn't exist. **How:** a profile field rendered as a button/link wherever the officer block
  already renders.

- **S7 — One timezone + working hours for everything** *(Medium)*
  I set my hours once and everything respects them. **Today:** timezone/quiet-hours/work-days exist TWICE
  (once per notification tab) and the digest scheduler ignores both — it runs on New York time for everyone.
  **How:** one profile-level timezone + hours that both notification tables read, and the digest scheduler
  finally consults (see S27/S28).

- **S8 — The marketing site reads the live roster** *(Small–Medium; enables A for the public site)*
  Not an officer-facing toggle — the fix that makes S1–S6 reach the marketing site. **Today:** the site's
  branding bar uses a list of 16 officers hard-coded inside `brand.js`, kept in sync by hand (the loan
  application already uses the live roster). **How:** `brand.js` loads `GET /api/roster` (with the static
  list as its offline fallback, the same pattern the loan application uses).

### Group B — My personal link & my leads

The `?lo=` link and round-robin already exist; the officer just has no controls on either.

- **S9 — My link center** *(Small–Medium)*
  One screen: copy my branded link, a QR code for open houses/events, deep links per tool (application,
  pricing calculator), and "leads that came from my link this month." **Today:** links work but officers
  hand-build them; no QR, no counter. **How:** a screen composing existing pieces (`?lo=` + the leads table
  already records `assigned_via='lo_link'`).

- **S10 — My personal landing page** *(Large)*
  A real page — photo, bio, "apply with me", "book a call" — at something like `/lo/yudi`. The
  industry-standard officer ask (every POS/CRM we surveyed sells it). **Today:** the branded marketing site
  is the closest thing. **How:** one public page template fed by the profile (A group) + the existing
  branded apply link. Worth doing after A exists.

- **S11 — Round-robin: count me in or out** *(Small)*
  Whether unclaimed website leads get dealt to me. **Today:** every active, site-selectable loan officer is
  in the deal — the only lever is an admin toggling their site visibility, which also removes them from the
  site. **How:** a settings-bag key the round-robin pool query reads. (Admins can see who's opted out.)

- **S12 — Round-robin cap** *(Small)*
  "Never deal me more than N new leads a day/week." **Today:** no caps — the wheel just turns. **How:** a
  number key + one count check in the round-robin picker.

- **S13 — My territories & deal types** *(Medium)*
  Route me leads for my states/programs first ("NJ and NY fix & flip"). **Today:** round-robin is blind.
  **How:** profile fields + a preference pass in the round-robin picker (falls back to anyone when nobody
  matches — a lead is never left unassigned).

- **S14 — New-lead alert style** *(Small — mostly exists)*
  Instant vs batched already works through the Notification Center (`new_lead` key). Worth surfacing next to
  the round-robin settings so it reads as one story; SMS alerts belong with S33/the future text channel.

- **S15 — My intro line on the new-lead auto-reply** *(Medium)*
  The instant "we got your inquiry" email to a lead from MY link opens with my personal line and my card.
  **Today:** one company template. **How:** a personal-paragraph slot in that one template (company wording
  around it stays fixed; scrub runs on the slot). This is the industry's compliance-safe pattern — officers
  personalize identity slots, never the regulated copy.

- **S16 — My lead board remembers me** *(Small)*
  Board vs list, open vs all, my usual stage filter. **Today:** resets every visit. **How:** part of the
  view-preferences move (S34).

### Group C — Emails & messages my borrowers get

The Notification Center already governs WHICH notifications go out and WHEN. These settings govern the
*content and copy* lanes it doesn't: who's copied, what cadence the recurring nudges use, and the personal
touches inside fixed company templates.

- **S17 — BCC me on everything my borrowers receive** *(Small)* — **the clearest quick win in this list**
  Every email PILOT sends a borrower of mine lands in my inbox too. **Today:** one switch for the WHOLE
  company (an environment variable an engineer flips). **How:** a settings-bag key read at the one place the
  borrower BCC is built (`notify._borrowerBcc`); the company switch becomes the company default, each officer
  overrides for themselves.

- **S18 — Also copy my assistant** *(Small)*
  Same as S17 for my assistant/processor. **How:** same chokepoint, officer picks a person.

- **S19 — ✓ CC borrower on title orders** *(already built — the first `lo_settings` key)*

- **S20 — ✓ CC borrower on insurance orders** *(already built)*

- **S21 — CC borrower on the attorney closing-prep order** *(Small; your call on whether it's wanted)*
  Extends the exact S19/S20 pattern to the third order kind. **Today:** the pattern's key map simply has no
  entry for attorney orders, so the borrower can never be defaulted in. **How:** one more key + one map
  entry. (Appraisal orders are deliberately excluded — that thread is with the AMC.) **One caution before
  saying yes:** the closing chain was deliberately built borrower-free — lender↔counsel correspondence must
  never reach the borrower — and a borrower CC'd on the opening order email can end up on the attorney's
  reply-all chain. That's why this one is a decision, not a default.

- **S22 — My borrowers' weekly "what's still needed" reminder** *(Small–Medium)*
  On/off for my book, which day it goes, and how often (the current rhythm is every ~6 days for everyone).
  **Today:** company-wide, hard-coded. **How:** settings-bag keys the digest pass reads per file-officer;
  the per-file mute that already exists stays the fine-grained control.

- **S23 — Draw-findings nudge pace for my files** *(Small)*
  How hard my borrowers get chased to accept inspection results (every 4 hours today, capped at 5 nudges —
  both global). **How:** per-officer values within admin-set bounds, read where the env values are read
  today. The owner rule that the coordinator+LO are always looped in is untouched.

- **S24 — My personal welcome paragraph** *(Medium)*
  The "Meet your loan officer" email (sent when I'm assigned) opens with my own greeting + photo + booking
  link. **Today:** fixed wording, officer contact block only. **How:** the same personal-slot pattern as
  S15, on one template.

- **S25 — Term-sheet email: my cover line + attach choice** *(Small–Medium)*
  A one-line personal note above the terms summary, and whether the PDF rides attached. **Today:** fixed
  wording; the sheet attaches unconditionally when fresh. **How:** a personal-slot + a bag key read in
  `terms-notify`.

- **S26 — Auto-invite my borrowers to the portal** *(Small)*
  Whether "Invite the borrower" starts ticked when I open a file. **Today:** pre-ticked for everyone.
  **How:** a bag key feeding the new-file form's initial state (the checkbox stays — this is just MY
  default).

### Group D — My own alerts & digests

The "For me" tab already covers channels, batching, vacation-hold, quiet hours, mute/star. What's missing is
control of the two OFFICER digests (which ignore all of it) and personal thresholds.

- **S27 — My daily pipeline email: on/off, time, size** *(Small–Medium)* — **fixes a real disconnect**
  **Today:** the daily snapshot goes to everyone in a hard-coded 7–11am New York window, up to 40 files;
  your Notification-Center digest-hour setting does NOT apply to it. **How:** the digest pass reads the
  per-officer delivery rules that already exist (`daily_digest_hour`, timezone) + an on/off and a size key.

- **S28 — My weekly book summary: on/off, day** *(Small)*
  Same fix for the Monday weekly book email (200 files, 90-day funded window — all fixed today). **How:**
  read `weekly_digest_dow` + per-officer toggles.

- **S29 — My stale-file threshold** *(Small)*
  When a quiet file should nag ME. **Today:** 10 days for the whole company (env). **How:** per-officer days
  within admin bounds; a bridge officer and a ground-up officer legitimately differ.

- **S30 — Warn me before a closing date with open conditions** *(Medium)*
  "N days before estimated closing, if required conditions are still open, alert me." **Today:** nothing
  like it. **How:** one new digest pass reading a per-officer N (off by default).

- **S31 — My "needs attention" threshold** *(Small)*
  The pipeline's stalled tile counts files idle >7 days — fixed. **How:** per-officer days; the tile and the
  digest finally agree on what "stalled" means for me (today they're two unrelated numbers).

- **S32 — Star/mute right where I'm looking** *(Small)*
  Star/mute buttons on the pipeline row and the file header. **Today:** the feature exists but lives only
  inside the Notification Center's lists. **How:** buttons calling the existing endpoints, state shown on
  the row. (In-context controls beat settings pages — the design finding every good system follows.)

- **S33 — Browser push + sounds** *(Medium–Large)*
  A third channel: desktop/phone-browser push for starred files and action-needed items, plus an in-app
  sound/badge toggle. **Today:** email + in-app only. **How:** standard web-push (new plumbing, real but
  well-trodden); the channel picker in "For me" gains one column.

### Group E — My screens

- **S34 — My view choices follow me** *(Small–Medium)* — **highest leverage in this group**
  The choices the file screen already remembers (conditions filter, audience, collapsed groups, tabs,
  rooms-vs-classic) live in the BROWSER today — a second computer or a cleared browser silently loses them.
  **How:** a small per-officer view-preferences bag on the server; the existing sticky mechanism reads/writes
  it instead of localStorage. No new UI at all.

- **S35 — Where I land after sign-in** *(Small)*
  Pipeline / My tasks / Dashboards / Leads. **Today:** everyone lands the same place. **How:** a bag key the
  router reads once.

- **S36 — My pipeline default view** *(Small)*
  Default status group, sort, and "my files only" — **today the pipeline remembers nothing at all** (the
  most-used screen has zero persistence). **How:** bag keys applied when no URL filter is present.

- **S37 — Saved pipeline views** *(Medium–Large)*
  Named filters — "Closing this week", "Waiting on borrower", "My ground-ups" — one click, and shareable
  ("promote a good one to the team" is the industry pattern). **How:** a small saved-views table (the
  personal-dashboards model already proves the shape).

- **S38 — My pipeline columns & tiles** *(Medium)*
  Which KPI tiles and table columns show, in what order (some officers don't care about ClickUp status or
  note buyer on the row). **How:** a view-preferences list the screen renders from.

- **S39 — My file-screen defaults** *(Small–Medium)*
  Which conditions filter/audience I start on, which room a file opens in, rooms vs classic as MY account
  default. **Today:** per-browser only, defaults fixed. **How:** same view-preferences bag (S34).

- **S40 — My home dashboard + my own numbers** *(Small–Medium)*
  Pick which personal dashboard is my "home" (the plumbing literally exists — dashboards are already
  per-user with sharing), and an officer-scoped version of the Insights screen (my files' findings, my
  volumes). **Today:** no home-dashboard choice; Insights is admin-only with no officer filter.

### Group F — My deal defaults

Everything here pre-fills MY starting point and never touches what a deal is ALLOWED to be — pricing rules,
approvals and gates are untouched (see guardrails).

- **S41 — New-file prefill** *(Small)*
  My usual program / loan type / property type / state / vesting pre-selected when I open a file (all blank
  today except vesting=entity). **How:** bag keys feeding the form's initial state.

- **S42 — My default team** *(Small–Medium)*
  My processor and my assistant(s) auto-proposed on every file I open. **Today:** processor starts blank on
  every file, and while anyone on a file can already add an assistant to THAT file, there's no default —
  it's a hand-step on every single deal. **How:** bag keys; the create route proposes them (the form shows
  them, I can change them; an admin still owns changing the PRIMARY afterwards, as today).

- **S43 — My studio starting points** *(Medium)*
  Which program card I start on, and my usual choices for the non-price toggles (accrual label, minimum-
  interest election, requested reserve months). **Today:** the studio starts identical for everyone, every
  time. **How:** bag keys the studio host reads when opening a FRESH scenario; every number stays governed
  by the frozen engines + the existing approval rule — these are starting values, not permissions.

- **S44 — My approved pricing defaults** *(Medium–Large — NEEDS YOUR DECISION)*
  The industry sells "per-officer pricing profiles". In PILOT, ANY move off the company default escalates to
  an admin per registration — your 2026-07-27 rule, and the right one. The version that respects it: an
  officer REQUESTS a personal default (say origination 1.5), an admin approves it ONCE, and files priced at
  exactly that approved default stop re-escalating each time; anything past it escalates as today. Nothing
  changes without your explicit sign-off on this policy — listed because officers will ask for it.

- **S45 — Unsigned term-sheet follow-up** *(Medium)*
  Auto-nudge MY borrower when a sent term sheet sits unsigned: every N days, stop after M, always visible in
  my Drafts if I'd rather review each one. **Today:** DocuSign's own fixed reminders (2 days, then every 3)
  are the only chase. **How:** a digest pass keyed on my settings; sends ride the existing notification gate
  so my quiet hours/draft mode apply.

- **S46 — My e-sign reminder schedule** *(Small)*
  The reminder/expiry pattern on envelopes I send (within company bounds). **Today:** hard-coded 2/3/30 for
  everyone. **How:** bag keys read where the envelope notification block is built.

### Group G — My vendors & orders

- **S47 — My preferred title company** *(Small–Medium)*
  My go-to title contact pre-fills every new order (changeable per file, as always). **Today:** vendors are
  picked per file from the shared directory; the system can remember a BORROWER's vendor but not mine.
  **How:** a bag key holding a directory contact id; the order screen pre-fills from it.

- **S48 — My preferred insurance agent** *(Small–Medium)* — same mechanism.

- **S49 — My preferred appraisal company** *(Small)*
  Which AMC my orders start on. **Today:** literally hard-coded to NAN for everyone (Class / Richer Values
  are the alternatives). **How:** a bag key replacing the hard-coded default; the admin list of allowed AMCs
  is the boundary.

- **S50 — My order follow-up timing** *(Small)*
  How many business days before PILOT chases title (3), insurance (2), attorney (5), appraisal (10) on my
  files. **Today:** fixed per kind, per-file override only. **How:** per-officer defaults inside admin
  bounds — the same sparse-override ladder the draw settings already model (theirs runs company → capital
  provider → project; ours adds the officer tier: company → officer → file).

- **S51 — Order follow-ups: auto vs draft** *(Medium)*
  Whether my order chases fire on their own or park in my Drafts first — the same automatic/manual choice
  the Notification Center already gives every other message. **How:** route the follow-up sender through the
  existing gate.

### Group H — Time off, coverage & my team

- **S52 — Real vacation mode** *(Medium)* — **the flagship of this group**
  One switch that: holds my own email until I'm back (exists today), **pauses round-robin dealing me leads**
  (doesn't exist), shows an away badge + return date to teammates (the status field exists, unused for
  this), and optionally routes new leads from MY link to a colleague while I'm out. **Today:** "vacation"
  only silences my own inbox — leads keep dealing, teammates can't tell, nothing is covered. **How:** the
  existing vacation dates become the one signal all four behaviors read.

- **S53 — My coverage person** *(Medium — with an admin approval step)*
  "While I'm out, Sarah can see and work my files." **Today:** the visibility mechanism exists
  (`visible_officer_ids`) but only an admin can set it, and nothing expires it. **How:** self-service
  request → admin one-click approve → auto-expires at my return date. Every action under coverage is
  already attributed (the audit trail doesn't change).

- **S54 — Send my alerts to my coverage** *(Medium)*
  While vacation mode is on, action-needed items on my files also notify my coverage person instead of only
  piling up. **How:** one check in the staff fan-out when the file's officer is away and has coverage.

- **S55 — My standing assistant list** *(Medium)*
  A durable "these are my assistants" list on my own settings, which then lands on my files automatically
  (feeding S42) — instead of adding the same person file by file forever. **Today:** per-file assistant
  adding already works (anyone on a file can do it); what doesn't exist is the standing list or anything
  automatic. **How:** a per-officer list writing the existing assignee rows at file creation; whether adding
  someone to the STANDING list needs a one-time admin sign-off is your call (see 5d).

- **S56 — My default hand-off targets** *(Small–Medium)*
  My usual closer / draw coordinator proposed when I submit a hand-off. **Today:** hand-offs route by role;
  the same person sticks per FILE once involved, but every new file starts blank. **How:** bag keys the
  workflow submit screen proposes.

### Group I — My book & repeat business

- **S57 — Maturity radar** *(Medium)*
  "Tell me 60/30 days before a funded loan of mine matures" — the refinance/next-deal call at exactly the
  right moment. **Today:** maturity dates are stored; nobody is nudged. **How:** a digest pass over my
  funded book reading per-officer lead-times (off by default).

- **S58 — Repeat-business nudges** *(Medium–Large — compliance-checked)*
  Loan-anniversary note, "past borrower gone quiet N months" — the Client-for-Life pattern every mortgage
  CRM sells. **How:** in-app/task nudges to ME first (safest), optional borrower-facing note later behind
  the outreach-compliance rules. Your call how far to take the borrower-facing half.

- **S59 — My referral partners** *(Medium)*
  A personal list of brokers/attorneys/agents who send me business; pick one on a lead; "my partners this
  quarter" counts. **Today:** lead sources are a fixed dropdown; nothing is tracked per partner. **How:** a
  small personal partners table linked from leads.

- **S60 — My skip-trace budget, visible** *(Small–Medium — admin sets, officer sees)*
  Per-officer monthly cap for the paid contact-lookup tool + a "you've used X of Y" meter. **Today:** the
  cap is company-wide (already flagged as an open question in the Elementix build docs). **How:** admin-side
  per-officer caps consulted by the existing spend gate; the meter already exists company-wide.

### Group J — Personal productivity

- **S61 — Saved replies & snippets** *(Medium)*
  My personal library of canned answers ("wire instructions reminder", "what's an interest reserve") usable
  in chat and Email Center replies, with placeholders (borrower name, address). **Today:** none exist
  anywhere. **How:** a small per-officer snippets table + an insert menu in the two composers; the
  borrower-safe scrub runs on send as always.

- **S62 — Scheduled send + undo for my messages** *(Medium)*
  "Send this tomorrow 9am" and a few seconds of undo on chat/email replies. **Today:** the Notification
  Center already has schedule/snooze/undo for notifications — my own composed messages have none. **How:**
  extend the existing draft/worker machinery to the two composers.

- **S63 — My calendar feed** *(Medium)*
  A private feed URL (closings, maturities, my tasks) I subscribe to from Outlook/Google — my deal calendar
  on my phone with zero typing. **Today:** nothing. **How:** a read-only per-officer ICS feed behind a
  revocable token.

- **S64 — My sticky notes on files** *(Small–Medium)*
  Personal working notes on a file, shown to me at the top of the file. NOT hidden from the company —
  admins can always see them and they live in the file's record (a regulated file keeps no secrets); they're
  simply not pushed at teammates. **How:** a small notes table + a card on the overview.

### Group K — Three more the industry survey surfaced

- **S65 — My saved deal scenarios** *(Medium)*
  Save a named starting scenario in the Term Sheet Studio — "my typical NJ flip", "12-mo ground-up w/ full
  reserve" — and open a new deal from it (the pricing-engine pattern: personal saved scenarios, promotable to
  shared ones). **Today:** the studio snapshots per FILE; nothing personal carries between deals. **How:** a
  small per-officer scenarios store feeding the studio's existing snapshot/restore; every number still runs
  through the frozen engines + approval rules at quote time — a scenario is a starting point, never a
  permission.

- **S66 — Tell me when company pricing changes** *(Small)*
  An alert when an admin changes the Pricing Admin Center defaults (markups, fees, program availability), so
  I never quote yesterday's numbers. **Today:** changes apply silently. **How:** one notification key (officers
  opt in/out in the existing center) fired from the pricing-settings save.

- **S67 — My quick-add condition presets** *(Small–Medium)*
  A personal shortlist of the hand-typed conditions I add again and again ("HOA statement", "GC license"),
  one click away when I'm on a file. NEVER automatic — the conditions engine and the company templates stay
  the only things that attach conditions on their own; this just saves me retyping my usual asks. **Today:**
  every hand-added condition is typed from scratch. **How:** a small per-officer presets list feeding the
  existing "add a condition" box.

---

## Part 5 — Guardrails, and the order I would build in

### 5a. What must NEVER become a personal setting

These are your own standing rules; the settings program must be built so no setting can ever cross them:

1. **Pricing and guideline numbers.** No setting changes a rate, markup, fee, cap, or sizing rule. Studio
   settings (S43) only pre-fill starting values; S44 explicitly requires your sign-off because it touches the
   approval RHYTHM (never the numbers, and never removes the approval chokepoint).
2. **What borrowers are allowed to see.** The borrower-safe scrub (note-buyer/investor names, internal
   margin) runs identically whatever any setting says — including on personal paragraphs, signatures, bios
   and snippets (S3, S5, S15, S24, S25, S61).
3. **Forced notifications** (security, account, DocuSign) stay un-mutable — the existing rule, unchanged.
4. **Condition gates, sign-off rules, CTC/funding gates, freezes, approvals** — no personal setting touches
   any of them. Settings personalize an officer's lane, never the file's requirements.
5. **The always-looped-in rules you set** (draw emails always CC the coordinator + LO; part-role
   notification scoping) are not settings.
6. **Compliance wording** — the business-purpose footer, NMLS identity, disclosures — fixed. Personal slots
   sit INSIDE fixed templates; free-form rewriting of borrower templates is deliberately not on this list.
7. **Encompass stays read-only, ClickUp write-guards stay** — no setting adds an integration write.
8. **The white paper-first look** is owner-directed; a dark theme is deliberately NOT offered.
9. **Admin bounds on every cadence/threshold** (S22, S23, S29, S50…): officers tune within a range the
   company sets, so no setting can turn off chasing entirely by accident.
10. **Everything audited, everything defaulting to today's behavior** — rolling the feature out changes
    nothing for an officer who touches nothing.

### 5b. One-time foundation (build first, ~a few days total)

- Teach the settings bag richer types (numbers, choice lists, short text) + the matching rows on "My
  settings" — today it renders on/off switches only. Every Small entry above then ships as pure config.
- Group the "My settings" screen by the catalog's groups so it stays readable as it grows.
- Adopt the **resolution ladder** pattern the draw settings already use (theirs: company → capital provider →
  project, reporting WHICH level answered; ours: company → officer → file) for every behavioral setting —
  it's how "why did this file behave differently?" stays answerable.

### 5c. Suggested build order

**Phase 1 — quick wins, all Small or Small–Medium, mostly settings-bag keys (a couple of weeks of work in
total):**
S17 (BCC me — the clearest mis-scoped switch in the system), S18, S26, S36, S35, S41, S42, S49, S29, S31,
S27/S28 (digest schedule fix), S11, S12, S16+S34 (views follow me), S46, S66, S21 (if you want it), S32.

**Phase 2 — the identity + vendors + views package (the visible "wow" release):**
S1–S7 + S8 (profile, photo, signature, scheduling link, one-timezone unification, live roster), S9, S43,
S47, S48, S50, S37, S38, S39, S40, S22, S23, S25, S45, S53, S56, S60, S64, S65, S67.

**Phase 3 — the bigger builds and the policy calls:**
S10 (landing pages), S13, S15, S24 (template slots), S30, S33 (push), S44 (pricing defaults — your
decision), S51, S52 + S54 (real vacation + alert redirect), S55, S57, S58, S59, S61, S62, S63.

### 5d. The decisions only you can make

- **S44** — personal pricing defaults (touches the every-deviation-approves rhythm; the numbers stay frozen).
- **S21** — whether borrowers should ever be CC'd on attorney closing-prep orders.
- **S53/S55** — coverage (standing access to a colleague's whole book) is admin-only today, and per-file
  assistants are already self-serve; the decision is whether a STANDING grant — a coverage delegate (S53) or
  a standing assistant list (S55) — needs a one-time admin sign-off or is fully self-serve.
- **S58** — how far borrower-facing repeat-business touches may go (marketing compliance).
- **S15/S24/S25** — whether officers may add personal paragraphs to borrower-facing emails at all (the
  industry-standard compliance answer is yes-within-slots; the wording around the slot stays company-fixed).
- **S64** — whether personal notes on files fit your "no secrets on a file" instinct (they stay
  admin-visible and in the record either way).

---

## The picture in one paragraph

Loan officers today control their notifications (deeply — better than any platform we surveyed) and two CC
switches, and that's it. Everything else about how they appear, what their screens remember, what their
borrowers' cadence feels like, who covers them, and what their deals start from is company-wide or hard-coded.
The industry-standard officer package — profile & photo, landing page, personal template slots, saved views,
follow-up cadences — is all buildable on plumbing PILOT already has (the settings bag, the notification
gates, the profile/roster, the per-file-override pattern), and Group H (real vacation & coverage) would put
PILOT ahead of every origination platform we looked at. 65 new settings + the 2 existing ones are cataloged
above; none of them touches pricing numbers, gates, or what borrowers are allowed to see. Pick numbers and we
start building.

---

## Appendix — key sources from the industry survey

Official help centers / docs, checked August 2026 (fuller link lists live in the research transcripts):

- **Encompass (ICE):** Personal Status Online + personal email templates QRG
  (help.icemortgagetechnology.com …/QRG_StatusOnline360.pdf); LO Connect pipeline columns
  (…/LOConnect/Content/Pipeline.htm); persona/pipeline-view notes (qualityexcellence.info).
- **Floify:** floify.com/blog/the-floify-customization-checklist; updated-lo-landing-pages;
  custom-loan-activity-notifications; multiple-milestone-sets; help.floify.com — Edit My Needs List Email,
  Edit My Deadline Notice Email, Configure My Loan Application, Invite a Realtor/Partner to a Loan Flow,
  Upload and Prepare My Pre-Approval Letter Template.
- **Blend:** help.blend.com — LO Pages (article 156000319561), custom pipeline views, loan teams &
  per-member notification control.
- **SimpleNexus / nCino:** mortgagehelp.ncino.com — co-branded partner apps (23621404007949), batched
  document upload email (38499404080781), notification settings; simplenexus.com/sn/co-branding.
- **Maxwell:** knowledge.himaxwell.com — Notifications; Landing Pages; SmartTasks; Spanish Loan Application.
- **Arive:** support.arive.com — User Settings (61000285361), Customize Email & SMS Templates (61000308461),
  Borrower Reminder Settings (61000315489), co-branded application links (61000302477).
- **LendingPad:** kb.lendingpad.com — system email notifications; user profiles (signature).
- **Pricing engines:** loanpass.io (custom scenarios → global scenarios); optimalblue.com + loansifter (rate
  alerts / branded rate subscriptions); polly.io; lenderprice.com.
- **Private-lending platforms:** help.lendingwise.com — save-pipeline (personal + shared views, personal
  default), customizing-email-templates (LO merge-tag group), user-permissions, draw;
  mortgageautomator.com/all-features (personal Kanban, task dashboards); liquidlogics.com; brytsoftware.com;
  themortgageoffice.com; lodasoft.com/product-features; fundcontrol.com/features; sitewire.co.
- **Mortgage CRMs:** totalexpert.com (co-marketing; signatures via help desk); topofmind.com — Surefire
  Client for Life, single property sites; ijungo.com (email marketing, co-marketing); setshape.com —
  Configuring User Profile Settings, Email Templates (the clearest per-user model surveyed);
  thinkaidium.com (no-code automations with org governance: build / customize / locked); bntouch.com
  (per-LO campaigns, landing pages, partner portals); usherpa.com (custom sales pipelines).
- **General SaaS patterns:** Gmail/Outlook (signatures, aliases, filters/rules, vacation responders,
  delegation, schedule send); Slack (notification routing, DND, keywords); Salesforce (personal email
  settings, BCC-me, list views); HubSpot (notification profiles, snippets, meeting links); Linear
  (default home view, custom views, favorites); Front (personal rules at individual scope); Superhuman
  (split inbox); Knock docs (preference-model architecture); Nielsen Norman Group (notification design).


