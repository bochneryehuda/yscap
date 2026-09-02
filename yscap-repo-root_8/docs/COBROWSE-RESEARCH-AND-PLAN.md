# Co-browsing for PILOT (RTL) — research findings and build plan

Owner ask (2026-09-02): next to the existing "See their view" button, a second button
"Co-browse": a super admin watches a teammate's or a borrower's LIVE screen, sees their
cursor, and can take control with their consent. Loan officers get it for their own
borrowers; the super admin for everyone. The existing view-as feature stays exactly as is.

## 1. What exists and is reused as-is (repo research)

- Three view-as features (borrower / TPO / staff view): impersonation token envelope,
  dual-identity re-validation on every request, 4h absolute cap + sliding refresh,
  session register tables, impersonator stamp on audit_log + request_audit_log.
  → Co-browse reuses the SAME permission rule (who may watch whom = who may "view as"),
  the same session-register shape, and the same audit stamps. No schema change for audit.
- Realtime: Server-Sent Events, in-process Map (src/lib/events.js), authenticated client
  singleton (chatEvents.js), 25s heartbeat, connId round-trip with ownership check.
  → Reused for viewer-side "session invites / consent prompts / status" notifications.
  NOT enough for the screen stream (one-way).
- currentConsolePath(), URL-addressable screen state, presence-not-faked-by-a-view rule.
- Server-side PII discipline: pii-guard.scan, borrower-safe scrubs, staff-only detail.

## 2. What is missing (repo research)

1. A two-way channel from the watched browser. SSE is one-way; no WebSocket anywhere.
2. A shared bus if >1 web instance (no pg LISTEN/NOTIFY). render.yaml says single
   instance BUT is "reference, not live wiring" → confirm instance count in the dashboard.
3. A consent record: "A allows B to watch / drive my screen", revocable mid-session.
4. A capture boundary: every PII protection is server-side; a DOM relay bypasses them.

## 3. How the industry does it (external research, sourced)

- Every serious vendor is DOM mirroring (Glance, Cobrowse.io, Fullview, Upscope,
  OpenReplay, Surfly-as-proxy). Not video. Sensitive fields are masked BEFORE leaving the
  watched browser. Fullview ships an rrweb fork.
- WebRTC screen share is rejected: permission prompt every session (spec), cannot redact,
  needs TURN servers.
- rrweb 2.1.1, MIT: @rrweb/record 22 KB gz on the guest, @rrweb/replay 58 KB gz on the
  viewer. Live mode: Replayer({liveMode:true}) + addEvent(); takeFullSnapshot() when a
  viewer joins. Masking happens at serialization (maskAllInputs, maskTextSelector,
  blockSelector). Caveats: hidden inputs not masked (#1609), maskInputFn ignored in full
  snapshot (#1385), adoptedStyleSheets (#1567), canvas off by default.
- Transport: `ws` (MIT, pure JS, optional native addons NOT installed) attached to the
  existing http.Server. Render supports WebSockets; no stickiness; sockets drop on deploy
  → reconnect + re-snapshot. HTTP/2 at the edge relieves the 6-connection SSE limit.
- Take control: synthesized events on the mirrored node; React controlled inputs need the
  native value setter + bubbling input event; file inputs cannot be driven (spec);
  window.open / target=_blank popup-blocked when replayed; hover cannot be synthesized.
- Consent pattern (Cobrowse.io / Glance / OpenReplay): agent REQUESTS control, guest must
  accept, persistent red border/banner while active, guest can end at any time (mouse
  move / Stop button), 30s unanswered request auto-releases.
- Compliance (FTC Safeguards): log authorized-user activity, encrypt in transit,
  redaction in the guest browser before transmission.
- Sizing (with rrweb doing serialization): view-only 1.5–3 wk, +control 2–4 wk,
  +consent/audit/redaction 2–4 wk → ~6–11 team-weeks.

## 4. Every PILOT interaction and how co-browse must treat it (inventory research)

| Interaction | What the controller sees | PILOT shows the controller |
|---|---|---|
| Upload button / file input (31 sites), drag-drop (5+ zones) | Click lands; OS dialog invisible | "Ask {name} to choose the file" |
| Download (saveBlob / a.download / chat saveIt, 22 blob sites) | Nothing; file lands on guest disk | Intercept: "Open this document in your own PILOT" |
| openBlob / ReportOpener blank-tab | Blank then gone; popup-blocked on replay | "{name} opened {report} in a new tab — not shared. Open it here" |
| In-app navigation (121 routes, 213 Links, 96 nav()) | Follows automatically | Current route in the viewer header |
| Full reload (stale-build banner, SW controllerchange, ErrorBoundary) | Freeze 1–3s, rebuilt | "Reconnecting…"; session id persisted in sessionStorage |
| View-as token swap during a co-browse | App re-renders as another actor | BLOCK view-as while co-browsing (simplest, safest) |
| Sign-out | Mirror goes to login | "Session ended — {name} signed out"; stop capture at clearToken |
| target=_blank / window.open (Sitewire, ClickUp, SharePoint, LinkedIn) | Nothing | "{name} opened {vendor} in a new tab — not shared" |
| DocuSign sign / countersign (same-tab redirect) | Mirror dies | HARD BLOCK the click under control; "E-sign is never shared"; resume on /esign/done |
| Same-origin tool iframes (SOW, Track Record, Term Sheet Studio) | Recordable (same origin) | Part of the page; their exports/imports follow the download/upload rules |
| PDF previews (canvas / blob iframes) | Placeholder | "Preview of {file} — open in your own PILOT" |
| Native select (289) / date inputs (63) | Popup invisible, value visible | Controller-side picker; set value via native setter + input/change |
| AppDialog (410 sites) | Visible | Ensure host mounted so native alert() never freezes the recorder; fix raw confirm() at AppraisalPanel.jsx:257 |
| Clipboard / print / tooltips / browser chrome | Invisible | "Printing…" toast on beforeprint |
| SSN reveal, password/MFA, Xactus password, 2FA secret | MASKED grey block | Never typed into; capture refused on /login, /tpo/login, /accept-terms, MFA phase |
| Note-buyer names on staff screens | Visible to staff viewer | A borrower/TPO is NEVER a viewer of a staff screen |

Small PILOT changes needed to be co-browse friendly: api.js saveBlob/openBlob hook;
guard location.assign in EsignFileSection/EsignBorrowerCard; pause/refuse on token swap
(auth.jsx); persist session id across the reload paths; dialog host always mounted;
mask selectors on BorrowerProfilePanel SSN row, TwoFactorPanel, StaffTpoFirms password,
all type=password and one-time-code inputs.
Side finding (unrelated): Trinity report anchors DrawsPanel.jsx:1730-1739 are plain
<a href="/api/..."> with header-only auth → likely 401 in the new tab. Fix separately.

## 5. Recommendation and phases

Build in-house on rrweb DOM mirroring over a `ws` WebSocket, single instance, rooms in
memory, consent/control/audit on the same socket, audit rows in Postgres.

Phase A — Watch-only with cursor (1.5–3 wk)
  - `ws` dependency (pinned, optional native addons excluded), attached to the http.Server
    in server.js; /ws/cobrowse with token + session auth; in-memory rooms.
  - Guest: @rrweb/record with maskAllInputs, maskTextSelector/blockSelector for the
    sensitive list, recording OFF on auth/MFA/e-sign routes; full snapshot on viewer join.
  - Viewer: @rrweb/replay liveMode in a sandboxed iframe, 500ms–1s buffer, route header.
  - Consent v1: the WATCHED person sees a request and must Accept; persistent banner
    "X is watching your screen — Stop"; ends on Stop, sign-out, cap, or viewer leaving.
  - Tables: cobrowse_sessions (viewer, watched kind+id, application_id?, started/ended,
    end_reason, consent_at, control_granted_at/revoked_at, request_count). Audit rows.
  - Permission: viewer may co-browse X iff viewer may "view as" X (reuse the three
    eligibility rules) AND X is a real logged-in person right now (presence).
  - Buttons: "Co-browse" beside "See their view" on StaffTeam (super admin only),
    BorrowerViewButton sites (file header + borrower profile; LO for own borrowers,
    super admin for all). Existing view-as untouched.
Phase B — Take control (2–4 wk)
  - Request/accept/release flow; red border on the guest; guest mouse-move or Stop
    releases; 30s unanswered request auto-cancels.
  - Replay clicks/keys/scroll/input on the guest via rrweb mirror ids; React native
    setter; drivable allowlist; hard blocks: e-sign, file inputs, view-as, sign-out, MFA.
  - Controller cursor overlay on the guest; guest-friendly notes for upload/download/new tab.
Phase C — Hardening (2–4 wk)
  - Redaction CI harness: fails if an SSN/password/OTP pattern appears in the event stream.
  - Reconnect + re-snapshot on deploy; per-session rate limits; metadata-only retention
    (no stream stored); legal copy for consent; owner sign-off on wording.

Owner decisions still needed: (1) confirm the live Render web service runs ONE instance;
(2) borrower consent wording; (3) whether a borrower's co-browse also needs the LO's
manager copied; (4) retention: store nothing but who/when/what-was-done (recommended).

## 6. Owner decisions (2026-09-02, in the owner's words where possible)

- Consent wording: plain "Malky from YS Capital wants to see your screen. Accept / Decline" — YES.
- Consent is required ONLY for co-browsing. "View as" needs no consent (unchanged).
- A loan officer's co-browse of a borrower does NOT notify their manager.
- Retention: who / whom / when / what actions — never the screen itself (recommended; owner
  raised no objection and moved on to permissions).
- PERMISSIONS ("if we are building the consent phase, then we can allow any user to do that
  for any user"):
  · The Team screen is visible to ALL staff users — everybody sees everybody on the team.
    They cannot see what the others see; they can only co-browse them WITH consent.
  · Super admin: "view as" anybody without consent (as today); co-browse anybody, still
    WITH consent.
  · Other team members: "view as" their own borrowers without consent (as today; reading
    "their battle" as "their borrowers"); co-browse their borrowers WITH consent.
  · Team members ↔ team members: NO view-as between themselves; co-browse WITH consent.
- Open: confirm the live Render web service runs one instance (instructions sent to owner).
- RENDER CONFIRMED BY OWNER (2026-09-02): web service instance count 1; autoscaling
  off / unavailable because a persistent disk is attached (Render: disk-backed services
  cannot run multiple instances); instance type Standard — 1 CPU, 2 GB RAM.
  → Single-instance design stands: in-memory rooms on the one process, no shared bus.
  Guard: refuse to start co-browse rooms and log loudly if RENDER_INSTANCE_COUNT/scaling
  ever changes (defensive check at boot reading render env if available); document the
  disk-attached invariant in CLAUDE.md so a future "remove the disk" decision re-opens it.

## 7. Built 2026-09-02 — Phases A, B and C shipped together (owner: "everything in one big ship")

- Phase A (watch): db/682, sessions.js (mayWatch, consent lifecycle), hub.js (/ws/cobrowse), routes, the
  guest recorder + consent prompt + banner, the viewer, Co-browse buttons beside every view-as button,
  the Team screen for every staffer.
- Phase B (take control): db/683 control state; a SECOND consent; the hub relays sanitised input only
  while `granted`; the guest's own browser performs it through rrweb mirror ids inside a hard allowlist
  (no blocked element, file picker, download/new-tab link, iframe/e-sign, sign-out; no-drive routes);
  a trusted move/key of the guest's own hand, Take back, Stop or the session's end release it;
  30 s request expiry; red frame + controller pointer on the guest.
- Phase C (hardening): server-side redaction guard (dashed SSN / Luhn card → frame dropped, counted,
  viewer told); Playwright harness proving the mask against the real rrweb build (SKIPs without
  Chromium); restart recovery (orphaned `active` rows closed 3 s after boot and every 30 s); terminal
  close codes stop reconnects, backoff + 5-minute give-up; per-viewer input rate cap; atomic request
  under an advisory lock (an unanswered request counts as busy); helper / guest-link tokens refused at
  every door; notices for file picker / download / new tab; `/api/health` hub stats; the co-browse
  register on the Team screen for super admins.
- Owner sign-off still wanted on WORDING: the consent prompt's retention sentence ("PILOT records who
  watched and when; it never records the screen itself") and the control prompt.

### 7.x Typing through the mirror (found by the end-to-end drive)

The viewer's replay is masked, so the viewer cannot know the real value or caret of a
box it types into. A whole-value echo from the viewer side sent `'' + key` on every
press and nothing ever accumulated. The rule now: every keystroke travels as a **key**
(a paste as its own text), and the **guest's own browser** inserts it at the real
selection through the native setter (`applyTextKey` / `insertText` in
`app-v2/src/lib/cobrowse.js`); a `<select>` is driven by option index. Proven by
`scripts/render-cobrowse-e2e.js`, which drives two real browsers through the whole
lifecycle and asserts the guest's real search box reads what the viewer typed.
