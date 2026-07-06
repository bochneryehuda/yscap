# Chat Feature Research & Enhancement Plan

> Research deliverable — July 2026.
> Deep research across Slack, WhatsApp, Microsoft Teams, Google Chat, mortgage-industry
> platforms (Blend, SimpleNexus/nCino, Floify, Maxwell, BeSmartee), and realtime-chat
> implementation literature, mapped onto the current YS Capital portal codebase.
> Ends with a phased roadmap and **ready-to-use build prompts** (§9).

---

## 1. Executive summary

Today the portal's chat is a **section on the loan file page**: one `messages` table with a
`channel` column (`borrower` / `internal`), rendered by a shared `MessageThread` component
inside a panel on `StaffApplication.jsx` / `Application.jsx`. It already has a surprisingly
strong base — attachments, voice notes, reactions, @mentions, pins, edit/delete, a
`last_seen_at` presence heartbeat, and per-channel read receipts — but it *feels* like a
form section, not a chat, because it is missing the things that make chat feel alive:

1. **Live delivery** — no WebSocket/SSE; an open thread never updates until you send.
2. **Named, first-class conversations** — channels are two hardcoded enum values, not
   objects you can list, name, rename, or see members of.
3. **Presence you can see** — who is online *right now*, who is typing *right now*.
4. **Per-message read/delivered states** — ✓ sent / ✓✓ delivered / "Seen by Dana 2:14pm".
5. **A chat-shaped UI** — conversation list + thread layout, unread dividers, date pills,
   scroll-to-bottom pill, message grouping — instead of a boxed panel.

The plan: promote conversations to a real table (several chats per loan file — **Borrower**,
**Loan Team (internal)**, **Officer ↔ Processor**, plus custom ones), each with a visible,
renameable name and member list; add SSE-based realtime (zero new npm deps — fits this
repo's express+pg-only constraint); build the watermark read-receipt model that Slack /
Google Chat / Twilio all use; and layer on the full feature catalog in §5, in the phase
order of §8, using the prompts in §9.

---

## 2. Current state (codebase audit)

Stack: Express 4 + `pg` (only runtime deps, by design), hand-written SQL migrations in
`db/0NN_*.sql`, React 18 + Vite SPA served at `/portal/`, HashRouter.

| Area | Today | Key files |
|---|---|---|
| Data model | `messages` (+`channel` enum, attachments, reactions, pins, edit/delete, `entity_refs`) | `db/schema.sql:285`, `db/009_collab.sql`, `db/010_chat.sql`, `db/011_chat_reactions.sql`, `db/024_chat_v2.sql` |
| Realtime | **None.** Manual refetch after send; staff nav badge polls every 45s | `app/src/components/StaffLayout.jsx:22` |
| Presence | `last_seen_at` heartbeat (~1/min) on `borrowers` + `staff_users`, 2–3 min "online" window | `src/auth/index.js:80`, `db/021_presence.sql` |
| Read receipts | Channel-open bulk `UPDATE messages SET read_at=now()`; "✓ Sent / ✓✓ Seen" | `src/routes/staff.js`, `src/routes/borrower.js` |
| Conversations | Implicit: `(application_id, channel)` pairs, channel ∈ {borrower, internal} | — |
| UI | `MessageThread.jsx` inside a panel on the loan file page; staff chat hub at `/internal/chat` | `app/src/components/MessageThread.jsx`, `app/src/screens/StaffChat.jsx`, `StaffApplication.jsx:1017` |
| Roles | `borrower` vs staff (`super_admin > admin > loan_officer / processor / underwriter`); LO/processor scoped to assigned files (`canTouchApp`) | `src/auth/index.js:86`, `src/routes/staff.js:25` |
| Reusable infra | `notify.js` (in-app + email, `message`/`mention` types), `chat-attach.js` → `documents` table, `activity.js`, `audit_log`, notification prefs | `src/lib/` |

**Biggest structural gaps:** no `conversations` table, no membership table, no live
transport, no typing indicators, receipts are per-channel not per-person, reaction
identity approximated by `actor_kind` only (`MessageThread.jsx:50`).

---

## 3. Target conversation model — several chats per loan file

The core UX change requested: a loan file stops having "a messages section" and instead has
**a set of named chats**, like WhatsApp groups scoped to the deal.

### 3.1 Default chats auto-provisioned per loan file

| Chat (default name, renameable) | Members | Visibility |
|---|---|---|
| 💬 **Borrower — {Last name}** | Borrower, co-borrower, LO, processor | Borrower-visible |
| 🔒 **Loan Team** | LO, processor, underwriter (+admins) | Internal only |
| 🤝 **Officer ↔ Processor** | LO, processor | Internal only |
| *(custom)* | Any staff picks members; e.g. "Title & Closing", "Appraisal follow-up" | Internal only |

Design rules (synthesized from industry research):

- **Visibility is per-conversation, never per-message.** Auditors, discovery requests, and
  accidental-leak prevention are all cleaner when a whole conversation has one audience.
  This is how Blend/SimpleNexus/nCino all structure it (nCino even ships a separate
  "Loan Officer ↔ Agent chat" as its own conversation type).
- **Strong visual differentiation** of borrower-visible chats (banner: "👁 Visible to
  borrower", distinct composer tint) — cross-post leakage (a processor pasting an
  underwriting note into the borrower chat) is the #1 operational risk.
- Every chat header shows the **member list** (stacked avatars + count → click for roster
  with role labels: "Dana · Processor"), like Slack's channel-details pane.
- **Renaming** allowed for staff (audit-logged, system message in the thread: "Yehuda
  renamed this chat to …"). Borrower chat names shown to borrowers stay friendly.
- Adding/removing a member posts a system message and an audit event. New internal members
  see **full history** (the loan file is the unit of record, not the person).
- **Underwriters stay out of borrower chats** by default (independence; shouldn't be
  lobbied). Compliance/admin read access must **not** emit read receipts.
- Borrower keeps ONE chat per loan file (their world stays simple); staff see all chats
  for the file grouped under the loan.

### 3.2 New schema (migration `0NN_conversations.sql`)

```sql
CREATE TABLE conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id),
  kind            text NOT NULL CHECK (kind IN ('borrower','internal','lo_processor','custom')),
  name            text NOT NULL,                  -- renameable display name
  emoji           text,                           -- chat icon
  topic           text,                           -- short header line (Slack-style)
  borrower_visible boolean NOT NULL DEFAULT false,
  created_by_kind text, created_by_id uuid,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id uuid REFERENCES conversations(id),
  member_kind     text NOT NULL CHECK (member_kind IN ('borrower','staff')),
  member_id       uuid NOT NULL,
  role_label      text,                           -- 'Loan Officer', 'Processor', 'Borrower'…
  last_read_message_id  uuid,                     -- READ watermark
  last_delivered_message_id uuid,                 -- DELIVERED watermark
  last_read_at    timestamptz,
  unread_count    int NOT NULL DEFAULT 0,         -- denormalized; reset-from-truth on read
  muted_until     timestamptz,
  notify_pref     jsonb,
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,                    -- soft-remove
  PRIMARY KEY (conversation_id, member_kind, member_id)
);

ALTER TABLE messages ADD COLUMN conversation_id uuid REFERENCES conversations(id);
ALTER TABLE messages ADD COLUMN client_msg_id text;   -- idempotent optimistic sends
ALTER TABLE messages ADD COLUMN reply_to_message_id uuid REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'text'
  CHECK (kind IN ('text','system','milestone'));      -- system = renames/joins/leaves
CREATE UNIQUE INDEX ON messages(conversation_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;
```

Backfill: create the two default conversations per existing application, point old
messages at them via their `channel` value, keep `channel` for one release as a fallback.

**Read receipts = watermark model** (what Slack, Google Chat, Twilio Conversations use):
one row per member, `last_read_message_id` only moves forward
(`GREATEST(old, new)`), unread = messages after watermark. Per-message "Seen by" is
*computed at render time*: member has seen message M iff their watermark ≥ M. With ≤ ~8
members per chat this gives WhatsApp-style per-person receipts **without** per-message
receipt rows (which have O(members × messages) write amplification). Reset
`unread_count` from a COUNT on every read-mark — never decrement — so drift self-heals.

### 3.3 Realtime transport — SSE (zero new dependencies)

This repo deliberately ships only `express` + `pg`. **Server-Sent Events fit perfectly**:
plain HTTP (no new deps, proxy/CDN friendly, works on Render), automatic browser
reconnection with `Last-Event-ID` resume, and one-directional push is all chat needs
(sends already go over POST). WebSockets would require the `ws` dep and sticky-session
care for no material gain at this message volume.

- `GET /api/events` (staff) / `GET /api/borrower/events` — authenticated SSE stream.
- In-process `EventBus` (`src/lib/events.js`): `Map<connectionId, {res, memberKey}>`;
  publish fans out to connections whose member is in the target conversation
  (membership checked server-side — typing events must never leak across chats).
- Event vocabulary: `message:new`, `message:edited`, `message:deleted`,
  `reaction:update`, `receipt:read`, `receipt:delivered`, `typing`, `presence:diff`,
  `conversation:updated` (rename/members), `unread:update`.
- Heartbeat comment frame every 25s (keeps proxies open); client `EventSource` with
  reconnect + `since` cursor refetch on reopen (gap recovery = 90% of "reliable
  messaging").
- Single-process now; if the app ever scales to multiple dynos, swap the in-process bus
  for Postgres `LISTEN/NOTIFY` (still zero new deps).
- Keep the 45s poll as a silent fallback for clients whose SSE won't connect.

### 3.4 Presence & delivery semantics

- **Online** = has ≥1 open SSE connection (connection set union — multi-tab safe), OR
  `last_seen_at` within 2 min (fallback). **Offline after a 45s grace** so a page refresh
  doesn't strobe the dot. Broadcast `presence:diff` only to users who share a
  conversation with the person.
- **Last seen** — "last seen 2h ago" from `last_seen_at` (already maintained).
  Show for staff↔staff; for borrowers, show staff a borrower's last-seen but show
  borrowers a softer "typically replies within a few hours" for staff (Intercom pattern —
  avoids "my LO was online and ignored me" friction).
- **In this chat now** — bonus signal WhatsApp doesn't have: because SSE connections can
  declare the currently-open conversation, the header can say "Dana is viewing this chat".
- **Delivered** = client acks receipt of `message:new` (or fetches the thread) →
  `last_delivered_message_id` watermark advances → sender's ✓ becomes ✓✓.
- **Read** = message actually scrolled into viewport while tab focused (IntersectionObserver
  + `document.hasFocus()`), debounced ~1s — Teams' "only genuine engagement counts" rule.
  Never advance watermarks for compliance/admin viewers who aren't members.

---

## 4. What each platform teaches us (research digests)

### Slack (deep dive)
The unread model is the crown jewel: **bold = unread, red badge = mention/DM** (triage at
a glance); the red **"New messages" divider** you land on when opening a channel (snapshot
`last_read` at open time, don't recompute as you read); **mark-as-unread** (Alt+click) as a
poor-man's inbox; Esc/Shift+Esc mark-read shortcuts; "All Unreads" catch-up view with a
celebratory empty state. Channels: rename with stable IDs, **topic vs description**,
details pane with searchable member roster + stacked-avatar header button, add/remove with
system messages, channel managers, announcement-only mode, archive on close. Also:
threads with "also send to channel", reactions with one-click hover emoji + who-reacted
tooltip, @here/@channel with a pre-send "you're about to notify N people" interstitial,
keyword notifications, per-channel notification overrides (mute still shows mention
badges!), DND with "notify them anyway" escape hatch (once/day), custom statuses with
expiry + auto-statuses (huddle/calendar), drafts synced with a pencil icon in the sidebar,
scheduled send with recipient-morning suggestions, pins + channel bookmarks + Saved-for-
Later with due dates, `/remind`, search modifiers (`from:` `in:` `before:`) with filter
chips, Cmd+K switcher, jump-to-date via the sticky date pill, permalinks with flash-
highlight, huddles with ambient sidebar presence, profile hovercards showing **local
time**, message grouping under one avatar within a few minutes, hover action bar,
"N new messages ↓" pill instead of yanking the scroll.

### WhatsApp (deep dive)
The **✓ / ✓✓ / blue-✓✓ system**: in-bubble, bottom-right next to the timestamp, in-place
color swap, states strictly monotonic. Group semantics: aggregate tick = min across
recipients — and research consensus says show **"Read by 2 of 3"** instead of WhatsApp's
all-or-nothing. **Message Info screen** (long-press → per-recipient Delivered/Read
timestamps) = compliance gold for a lender ("borrower saw the rate-lock notice at 2:14pm").
Presence: "online" / "last seen" / **"typing…" with WHO is typing** (avatar + bouncing-dots
phantom bubble at the bottom of the stream; refresh every ~4s, client-side expiry ~6s so a
lost stop-event self-heals). Swipe-to-reply quoting with jump-to-original + flash; star
(save) messages; pin up to 3 with a header banner (pin the rate quote / closing date!);
reactions with who-reacted sheet; 15-min edit window with "edited" label (keep server-side
revisions regardless); delete = tombstone "This message was deleted" (+5s Undo snackbar);
voice notes with waveform, 1×/1.5×/2×, **played receipt separate from read**, transcripts;
per-chat media/links/docs gallery; unread divider + jump-to-first-unread; chat filters
(All/Unread/Favorites/Groups + custom lists); group subject/icon/description, member
colors, announcement-only groups, admin roles; broadcast lists (fan-out that replies as
private 1:1s — the model for milestone blasts).

### Microsoft Teams
Presence with a **priority order and honesty rule** (manual can only downgrade below the
auto-computed state; manual states auto-expire); calendar-driven "In a meeting" — for us:
LOS-calendar-driven **"In a closing"**. Status notes with **"show when people message
me"** — the note renders above the compose box *before* they send ("Out until Monday —
urgent conditions → Dana"): cheapest trust win in either product. **DND with a priority
list** (closing desk always breaks through). Read receipts: **Seen eye only on the newest
read message** (clean timeline), only counts when window focused, per-person "Read by"
list capped at ≤20 members. **Important / Urgent priority messages — Urgent re-notifies
every 2 minutes for 20 minutes until read**, role-gated: purpose-built for "docs needed
before 2pm funding cutoff". Group-chat **history controls at add time** (none / last N
days / all). Tags (@Processing), Approvals-as-cards with live state (→ condition
sign-offs, lock extensions), Loop-style live checklists, quiet hours, activity feed,
inline translation (multilingual borrowers), schedule send, forwarding with provenance
deep-link.

### Google Chat
The **avatar-stack read receipt**: each member's tiny avatar sits under the last message
they've read and visibly **slides down as they catch up**; clustered avatars collapse to
`+N`, hover for names; deliberately capped to chats ≤20 and absent in big spaces. This is
the exact right receipt UX for a ≤8-person loan chat. Threads in a side panel with
**auto-follow + a "For you" notification default** (mentions + followed threads) — the
best-scaling notification default in any product. Calendar-OOO **interstitial before you
type**. Spaces with roles, announcement mode, **Shared tab (Files/Links/Media)
auto-collected per conversation** (→ per-loan artifact memory), Tasks tab that echoes
state changes into the stream (→ conditions), pins, mark-thread-unread, search with
**filter chips** (From / Said in / Date / Has file), smart chips with **paste-time access
check** ("recipient can't view this doc — grant access?"), Smart Reply chips, Gemini
hover-summaries of unread conversations, huddles as a draggable PiP tile.

### Mortgage industry + compliance (must-follow)
- **Curated borrower channel**: Blend gates borrower-facing pings on significance —
  routine/internal noise never notifies the borrower. Milestone/system messages are
  first-class message types in the borrower thread (Floify's whole model).
- **In-platform chat is the off-channel-texting antidote** (SEC/FINRA fined $3.5B+ for
  iMessage/WhatsApp drift; SimpleNexus markets "conversations automatically logged").
  The real compliance requirement: your chat must be *more convenient than texting*.
- **Retention**: append-only store; delete = tombstone, edits keep revisions
  (`message_revisions`); audit events for created/edited/deleted/member-changes/renames/
  read-watermarks; per-loan export (PDF/JSON). Reg Z wants 3–5 yr; practical posture =
  life of loan + margin (7 yr standard).
- **PII guard**: detect SSN/account patterns server-side **before** persist/broadcast;
  for borrowers block-and-redirect ("please use the secure document upload"), for staff
  redact-with-alert; strip PII from notification/email/SMS payloads entirely.
- **Notification ladder**: in-app → push/email after ~5–15 min unread → digest. Never
  message content in SMS (TCPA: written consent, STOP honoring, quiet hours 8am–9pm).
- **Roles**: processors message borrowers under their own name/role, never masquerading
  as the LO; only licensed MLOs discuss rates/terms with borrowers — encode as a rule.

---

## 5. Full feature catalog (the "every single feature" list)

Legend: ★ = must-have (requested explicitly or core to feeling like a chat) ·
◆ = high value · ○ = later/nice. "Src" = platform that does it best.

### A. Conversations & membership
| # | Feature | Src | Pri |
|---|---|---|---|
| A1 | Multiple named chats per loan file (Borrower / Loan Team / Officer↔Processor / custom) | nCino | ★ |
| A2 | Member list on every chat (stacked avatars + count in header → roster with role labels) | Slack | ★ |
| A3 | Rename chat (staff; audit-logged; system message in thread) | Slack/WhatsApp | ★ |
| A4 | Chat emoji/icon + topic line in header | Slack | ◆ |
| A5 | Add/remove members with system messages; soft-remove keeps history | Slack | ★ |
| A6 | "Visible to borrower" banner + composer tint on borrower chats | industry | ★ |
| A7 | Create custom chat with member picker | Slack | ◆ |
| A8 | Archive chat on loan close (read-only, searchable) | Slack | ◆ |
| A9 | Announcement-only mode (only selected staff can post) | GChat/WA | ○ |
| A10 | History scope choice when adding a member (all / from-now) | Teams | ○ |

### B. Presence & availability
| # | Feature | Src | Pri |
|---|---|---|---|
| B1 | Online dot (green = live SSE connection; grace period against flapping) everywhere names appear | Slack | ★ |
| B2 | "Last seen 2h ago" for offline users | WhatsApp | ★ |
| B3 | "In this chat now" — other party currently viewing this conversation | (novel) | ◆ |
| B4 | Typing indicator with WHO is typing (avatar + bouncing dots phantom bubble; throttle 3–4s, client expiry ~6s) | WhatsApp | ★ |
| B5 | Custom status with emoji + auto-expiry ("In a closing until 4pm") | Slack/Teams | ◆ |
| B6 | Status/OOO interstitial above composer before you send | Teams/GChat | ◆ |
| B7 | DND / notification schedule (quiet hours) with priority-breakthrough list | Teams | ○ |
| B8 | Borrower-facing "typically replies within X hours" instead of staff last-seen | Intercom | ○ |

### C. Delivery, read & unread
| # | Feature | Src | Pri |
|---|---|---|---|
| C1 | Per-message ✓ sent / ✓✓ delivered / ✓✓-highlight read, in-bubble by timestamp, monotonic | WhatsApp | ★ |
| C2 | Group semantics: "Read by 2 of 3" (not all-or-nothing) | research | ★ |
| C3 | **Message Info**: per-recipient Delivered/Read timestamps (long-press/⋯) | WhatsApp | ★ |
| C4 | Avatar-stack "read up to here" markers that slide down as members catch up | GChat | ◆ |
| C5 | Unread divider ("— New messages —") landing position on open; snapshot at open | Slack/WA | ★ |
| C6 | Unread badges: per-chat counts, per-loan rollup, nav rollup; bold-vs-badge (mention) tiers | Slack | ★ |
| C7 | Mark-as-unread (rewind watermark) | Slack/WA | ◆ |
| C8 | Read-state sync across tabs/devices in seconds (watermark broadcast) | Slack | ★ |
| C9 | Scroll-to-bottom pill with "N new messages ↓" (no scroll-yanking while reading) | Slack | ★ |
| C10 | Read receipts only on genuine engagement (focused tab + message in viewport) | Teams | ★ |
| C11 | Compliance/admin reads never advance receipts | industry | ★ |

### D. Messages & composer
| # | Feature | Src | Pri |
|---|---|---|---|
| D1 | Reply/quote with jump-to-original + flash highlight (swipe on mobile) | WhatsApp | ★ |
| D2 | Optimistic send with clock→✓ (client_msg_id idempotency; failed = tap-to-retry) | WhatsApp | ★ |
| D3 | Message grouping (same sender within ~3 min under one avatar/name) + hover timestamp | Slack | ★ |
| D4 | Sticky date dividers ("Today", "Yesterday") | Slack/WA | ★ |
| D5 | Text formatting: `*bold*` `_italic_` `~strike~`, lists, links (existing subset extended) | Slack/WA | ◆ |
| D6 | Edit with "(edited)" label; revisions retained server-side (exists — add revision table) | all | ◆ |
| D7 | Delete → tombstone + 5s Undo (exists — add Undo) | WhatsApp | ◆ |
| D8 | Reactions: hover quick-row of frequent emoji + full picker; who-reacted sheet; fix per-actor identity | Slack/WA | ◆ |
| D9 | Drafts persisted per conversation ("Draft:" snippet in chat list) | Slack/WA | ◆ |
| D10 | Scheduled send ("tomorrow 9am" suggestions) | Slack/Teams | ○ |
| D11 | Forwarding across chats with provenance label (staff-only; never internal→borrower without confirm) | WA/Teams | ○ |
| D12 | Urgent messages: role-gated, red banner, re-notify every 2 min until read | Teams | ◆ |
| D13 | Voice notes: waveform + playback speed + played-receipt (exists — enhance) | WhatsApp | ○ |
| D14 | Link previews (server-side OG fetch, cached) | Slack | ○ |
| D15 | Smart reply chips for borrowers ("Sounds good", "Uploading now") | GChat | ○ |

### E. Organization & retrieval
| # | Feature | Src | Pri |
|---|---|---|---|
| E1 | Chat-hub redesign: conversation list (avatar, name, snippet, time, unread badge, presence) + thread pane — an actual chat app layout | WhatsApp/Slack | ★ |
| E2 | Chat filters: All / Unread / Borrower / Internal / Mine | WhatsApp | ◆ |
| E3 | Pinned messages banner in header (exists — add banner + jump) | WA/Slack | ◆ |
| E4 | Saved-for-later (private bookmark) list | Slack | ○ |
| E5 | In-chat search + global search with filters (from/date/has-file) | Slack | ◆ |
| E6 | Per-chat Shared tab: Files / Links / Media auto-collected | GChat | ◆ |
| E7 | Jump-to-date via sticky date pill | Slack/WA | ○ |
| E8 | Message permalinks + notification deep links landing scrolled+highlighted | Slack | ◆ |
| E9 | Mentions view / activity feed ("all my @mentions") | Slack/Teams | ○ |

### F. Notifications & escalation
| # | Feature | Src | Pri |
|---|---|---|---|
| F1 | Per-chat mute (badge still shows; @mentions still break through) | Slack | ◆ |
| F2 | Email fallback after ~10 min unread (exists via notify.js — add unread-delay gating + digest batching) | industry | ★ |
| F3 | Significance gate: borrower notified only for messages needing them; milestones as system messages | Blend | ◆ |
| F4 | @mention pings (exists) + @team role mentions (@processing) | Teams | ○ |
| F5 | PII guard: SSN/account detection → block-and-redirect (borrower) / redact-with-alert (staff) | industry | ◆ |
| F6 | Browser push notifications (Web Push) when app closed | — | ○ |
| F7 | SMS ping (no content, deep link only, TCPA consent + STOP) | industry | ○ |

### G. Compliance & audit (non-negotiable substrate)
| # | Feature | Pri |
|---|---|---|
| G1 | Append-only: tombstones not deletes, `message_revisions` on edit | ★ |
| G2 | Audit events: send/edit/delete/rename/member-change/read-watermark | ★ |
| G3 | Per-loan chat export (PDF/JSON) for exams & discovery | ◆ |
| G4 | Compliance read-only role, invisible to receipts | ◆ |
| G5 | Retention: life of loan + 7 yr; archive on close, never purge | ★ |

---

## 6. UX blueprint — "make it feel like a chat"

**Staff chat hub (`/internal/chat`)** becomes a two-pane chat app (the WhatsApp/Slack
layout): left pane = conversation list grouped by loan file (loan header row → its chats
underneath), each row showing chat emoji + name, member avatar stack, last-message
snippet ("Dana: uploaded W-2 ✓✓"), timestamp, unread badge, presence dot; filter pills
(All / Unread / Borrower / Internal); search. Right pane = the open thread. Mobile: list
→ push to thread.

**Thread anatomy** (both surfaces): header with chat name (click to rename), member
avatar stack + count (click for roster), presence line ("Dana is online" / "typing…" /
"last seen 2h ago"); pinned banner; message stream with date pills, grouping, unread
divider, avatar-stack read markers, reply quotes, reaction pills; typing bubble slot at
bottom; scroll-to-bottom pill with count; composer with attach/voice/emoji, draft
persistence, and (borrower-visible chats) the "👁 Visible to borrower" tint.

**Loan file page**: the current embedded panel becomes a compact chat launcher — the
file's chats with unread badges + last snippet, opening the hub (or a slide-over thread)
rather than an inline section. The borrower side keeps a single full-height thread but
gains all liveness features (typing, presence, receipts, divider).

---

## 7. Architecture decisions (grounded in this repo)

1. **Transport: SSE** — zero new deps, Express-native, auto-reconnect. In-process bus now;
   Postgres LISTEN/NOTIFY if multi-process later. Poll fallback stays.
2. **Own the message store; buy nothing.** Volumes are tiny (hundreds of messages per
   loan); compliance retention/ACLs are the differentiator no vendor sells. Postgres
   `bigserial`/uuid + `(conversation_id, created_at)` indexes are fine to ~10M messages.
3. **Watermarks, not receipt rows** (§3.2). Delivered + read as two watermark columns.
4. **Cursor pagination** (`WHERE conversation_id=? AND id < :cursor ORDER BY id DESC
   LIMIT 50`) replacing the newest-500 window.
5. **Ephemeral things stay ephemeral**: typing/presence never persisted; typing events
   throttled client-side, expired client-side.
6. **Idempotent sends**: `client_msg_id` unique per conversation; retries return the
   existing row.
7. **Server assigns order** (id + created_at); clients re-sort on id, never trust local
   clocks.
8. **Every structural change is a system message** (rename, add/remove member, archive) —
   doubles as the in-thread audit trail.

---

## 8. Phased roadmap

| Phase | Theme | Contents |
|---|---|---|
| **1** | Foundations | `conversations` + `conversation_members` migration + backfill; conversation CRUD APIs (list/rename/members); default 3 chats per file; system messages; audit events |
| **2** | Realtime | SSE endpoint + EventBus; live `message:new/edited/deleted`, `reaction:update`; typing indicators; presence dots from connections + last-seen |
| **3** | Read/delivered | Watermarks; ✓/✓✓/read ticks; "Read by 2 of 3"; Message Info panel; unread divider; unread badges + rollups; viewport-based read marking; cross-tab sync |
| **4** | Chat-shaped UI | Two-pane hub rebuild; thread anatomy (grouping, date pills, scroll pill, member roster, rename UI, pinned banner); loan-page launcher; borrower thread upgrade |
| **5** | Message power | Reply/quote + jump; drafts; reaction identity fix + who-reacted; edit revisions; delete undo; avatar-stack read markers |
| **6** | Retrieval & notify | In-chat + global search; Shared files/links tab; permalinks/deep links; mute; email-fallback gating + digests; significance gate |
| **7** | Advanced | Urgent messages w/ re-notify; custom statuses + interstitials; PII guard; scheduled send; @team mentions; export; smart replies; web push |

Each phase is shippable on its own; 1→3 are strict prerequisites for the rest.

---

## 9. Ready-to-use build prompts

Copy-paste these one at a time into a new session (they assume this document exists at
`docs/CHAT-FEATURE-RESEARCH.md`). Each is scoped to land as one reviewable PR.

### Prompt 1 — Conversations foundation
> Read `docs/CHAT-FEATURE-RESEARCH.md` §3. Implement Phase 1: create the
> `conversations` and `conversation_members` tables per §3.2 as a new numbered
> idempotent migration following the existing `db/0NN_*.sql` conventions, with a
> backfill that creates the default chats ("Borrower — {last name}", "Loan Team",
> "Officer ↔ Processor") for every existing application, assigns members from
> `applications.loan_officer_id`/`processor_id` and the borrower/co-borrower, and
> points existing messages at the right conversation by their `channel` value.
> Add staff + borrower APIs: list conversations for a loan file (with members,
> unread counts, last message snippet), rename a conversation (staff only,
> audit-logged, emits a `kind='system'` message "X renamed this chat to Y"),
> add/remove members (system messages + audit events), and create a custom
> internal chat with a member picker. Enforce: borrowers only ever see
> `borrower_visible` conversations on their own files; `canTouchApp` scoping for
> LO/processor; underwriters excluded from borrower chats by default. Auto-create
> the three default chats when a new application is created. Update the message
> GET/POST routes to accept `conversationId` (keeping `channel` working as a
> fallback for one release). Keep the codebase's raw-SQL, zero-new-deps style.

### Prompt 2 — Realtime via SSE
> Read `docs/CHAT-FEATURE-RESEARCH.md` §3.3–3.4. Implement Phase 2: add an
> in-process EventBus (`src/lib/events.js`) and authenticated SSE endpoints for
> staff and borrower (`/api/staff/events`, `/api/borrower/events`) with 25s
> heartbeat comments and membership-scoped fan-out. Publish `message:new`,
> `message:edited`, `message:deleted`, `reaction:update`, and
> `conversation:updated` from the existing chat routes. Add typing indicators:
> `POST .../conversations/:id/typing` throttled client-side to one call per 3s
> while composing; broadcast `typing` events to other members only; render
> "{name} is typing…" with a bouncing-dots bubble that expires client-side after
> 6s. Presence: track live SSE connections per user (multi-tab safe), broadcast
> `presence:diff` with a 45s offline grace, and expose online/last-seen in the
> conversation list and thread header ("online" / "last seen 2h ago", using the
> existing `last_seen_at`). Frontend: an `EventSource` hook with reconnect and a
> `since`-cursor refetch on reopen; open threads append new messages live with no
> scroll-yank (show a "N new messages ↓" pill when scrolled up). Keep the 45s
> poll as silent fallback. No new npm dependencies.

### Prompt 3 — Read receipts, delivered states, unread
> Read `docs/CHAT-FEATURE-RESEARCH.md` §3.2, §3.4 and catalog section C.
> Implement Phase 3: watermark columns on `conversation_members`
> (`last_read_message_id`, `last_delivered_message_id`, `unread_count`).
> Delivered: clients ack received `message:new` events (and thread fetches)
> advancing the delivered watermark. Read: advance only when the message is in
> the viewport of a focused tab (IntersectionObserver + document.hasFocus()),
> debounced 1s; watermarks only move forward; broadcast `receipt:read` /
> `receipt:delivered`; reset `unread_count` from a COUNT-from-truth on each
> read-mark. UI: per-message ✓ / ✓✓ / highlighted-✓✓ ticks in-bubble next to the
> timestamp (sender's own messages only); group chats show "Read by 2 of 3" on
> the newest message; a Message Info popover (⋯ menu) listing each member's
> Delivered/Read timestamps; a "— New messages —" divider positioned from the
> watermark snapshot taken at thread-open; unread badges per chat, per loan file,
> and in the nav (replacing the polled badge with live `unread:update` events);
> mark-as-unread action that rewinds the watermark. Compliance/admin viewers who
> are not conversation members must never advance watermarks. Log read-watermark
> changes to the audit log.

### Prompt 4 — Chat-shaped UI rebuild
> Read `docs/CHAT-FEATURE-RESEARCH.md` §6. Rebuild `/internal/chat` as a
> two-pane chat app: left conversation list grouped by loan file (chat emoji +
> name, member avatar stack, last-message snippet with sender prefix and tick
> state, timestamp, unread badge, presence dot; filter pills All / Unread /
> Borrower / Internal; search box), right pane the open thread; mobile stacks
> list→thread. Thread anatomy: header with renameable chat name, member avatar
> stack + count opening a roster panel (names, role labels, presence, add/remove
> for staff), presence/typing line; pinned-messages banner with jump; message
> stream with sticky date dividers, same-sender grouping within 3 minutes (hover
> reveals per-message time), unread divider, reaction pills; typing bubble slot;
> scroll-to-bottom pill; composer with the existing attach/voice/emoji plus a
> "👁 Visible to borrower" banner + tinted composer on borrower-visible chats
> and a confirm-on-first-send guard. Replace the loan-file page's embedded
> ChatPanel with a compact launcher (the file's chats + unread badges + last
> snippets) opening the hub or a slide-over thread. Upgrade the borrower thread
> with the same liveness (typing, presence, receipts, divider) while keeping it a
> single simple conversation. Reuse/extend `MessageThread.jsx` rather than
> forking it.

### Prompt 5 — Message power features
> Read `docs/CHAT-FEATURE-RESEARCH.md` catalog section D. Implement Phase 5:
> reply/quote (`reply_to_message_id` with a denormalized snippet snapshot;
> quote block above the bubble; click scrolls to the original with a 2s flash;
> works even if the original was edited/deleted); optimistic sends with
> `client_msg_id` idempotency (clock icon → ✓ on ack; failed sends show
> tap-to-retry, never silently drop); drafts persisted server-side per
> (user, conversation) on debounce, shown as "Draft: …" in the conversation
> list; fix reaction identity to actual actor id (not actor_kind) and add a
> who-reacted popover; `message_revisions` table capturing pre-edit bodies;
> delete with a 5-second Undo snackbar before the tombstone broadcast; and the
> Google-Chat avatar-stack read markers (member avatars under the last message
> each has read, clustered with +N overflow, animated on watermark advance).

### Prompt 6 — Retrieval & notifications
> Read `docs/CHAT-FEATURE-RESEARCH.md` catalog sections E & F. Implement
> Phase 6: in-chat search (scoped input in the thread header, prev/next match
> navigation, jump + highlight) and a global chat search on the hub (Postgres
> full-text or trigram over messages, filtered by from/date/has-attachment,
> ACL-enforced); a per-chat Shared tab auto-collecting Files / Links / Media
> from message history; message permalinks and notification deep links that land
> scrolled + flash-highlighted; per-chat mute (badge still accrues, @mentions
> still notify); email fallback gating — only email a recipient if the message
> is still undelivered/unread after 10 minutes, batching multiple messages into
> one digest email via the existing notify.js/email templates; and a borrower
> significance gate — milestone/system messages render in the borrower thread
> without triggering borrower notifications unless action is required.

### Prompt 7 — Advanced & compliance hardening
> Read `docs/CHAT-FEATURE-RESEARCH.md` catalog sections F & G and §4
> (compliance digest). Implement Phase 7 selections: urgent messages
> (staff-only, role-gated; red banner in-thread; re-notify every 2 minutes for
> 20 minutes until the recipient's read watermark passes it); custom staff
> statuses with emoji + auto-expiry shown in rosters and as an interstitial
> above the composer when messaging someone with a status/OOO; a PII guard that
> detects SSN/account-number patterns server-side before persist/broadcast —
> block-and-redirect borrowers to the secure document upload, redact-with-alert
> for staff, and always strip message content from email payloads; per-loan chat
> export (all conversations → PDF/JSON with member roster, receipts, and audit
> trail) gated to admin/compliance; and archive-on-loan-close (read-only
> conversations, still searchable/exportable).

---

## 10. Source appendix

Platform docs and engineering literature consulted (representative): Slack Help Center
(presence, unreads, threads, channels, pins, reminders, search, notifications), WhatsApp
Help/Blog (receipts, presence, typing, groups, voice, pins, filters), Microsoft Learn &
Support (Teams presence, read receipts, urgent messages, tags, quiet time, file
permissions), Google Workspace Updates (Chat read-receipt avatars, inline threading,
huddles, Shared tab, smart chips), Blend product blog (Autopilot borrower chat,
significance gating), SimpleNexus/nCino (ConnectUs chat, LO↔Agent chat), CFPB Reg Z/X
retention rules, SEC/FINRA off-channel enforcement coverage, GLBA Safeguards guidance,
ICE TCPA SMS best practices, and realtime-systems engineering write-ups (Slack, Discord,
Twilio Conversations read horizon, Phoenix Presence, PubNub receipt patterns, Stream chat
DB architecture).
