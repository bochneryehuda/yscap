# Reply-by-email go-live (#68 file inbox + #75 chat guests) — owner setup

The code for both features is fully shipped and dormant. This is the exact,
complete configuration that switches them on. Nothing else is needed.

## What turns on

- **#68 — per-file inbox.** Every file notification email carries
  `Reply-To: file+<applicationId>@<CHAT_REPLY_DOMAIN>`. Anyone replying to any
  file email (borrower, co-borrower, title company, staff) reaches the WHOLE
  assigned team: the reply is forwarded (branded) to every active assignee,
  each assignee also gets an in-app bell notification, and the reply appears in
  the file's "Email notifications" section.
- **#75 — chat guest replies.** External chat guests already receive every
  message by email; with this config their email replies land back in the chat.

## Steps

1. **Resend dashboard → Domains**: add and verify the inbound domain
   (e.g. `reply.yscapgroup.com` — add the MX record Resend shows you).
2. **Resend dashboard → Webhooks**: add ONE webhook endpoint:

   ```
   https://www.yscapgroup.com/api/inbound/file-email
   ```

   subscribed to the `email.received` event. This single endpoint handles BOTH
   address families (`file+…` forwards to assignees; `chat+…` posts into the
   conversation). Do NOT point it at `/api/inbound/chat` — that legacy route
   reads the message text off the webhook body, and Resend's `email.received`
   events carry metadata only, so chat replies through it would arrive empty.
3. Copy the webhook's **signing secret** (`whsec_…`) from the Resend webhook page.
4. **Render dashboard → Environment**, set:

   | Variable | Value |
   |---|---|
   | `CHAT_REPLY_DOMAIN` | the inbound domain from step 1 (e.g. `reply.yscapgroup.com`) |
   | `RESEND_WEBHOOK_SECRET` | the `whsec_…` secret from step 3 |
   | `RESEND_INBOUND_API_KEY` | a **full-access** Resend API key (the Receiving API needs read access; skip if `RESEND_API_KEY` is already full-access) |

5. Deploy (or restart) the service so the env vars load.

## Verify it works

1. Open any staff file → post a chat message to a file with an external guest,
   or trigger any file notification (e.g. a reminder). The email's Reply-To
   should show `file+…@<your domain>`.
2. Reply to that email from any mailbox. Within a minute every assignee on the
   file receives the branded "Reply on <loan #>" forward, a bell notification
   appears, and the reply shows in the file's Email notifications section with
   a "Forwarded to team" pill.
3. Reply to a chat-guest email — the reply should appear in the conversation
   as that guest.

## Safety properties (for reference)

- The endpoint **refuses everything** (400) until `RESEND_WEBHOOK_SECRET` is
  set, and verifies the Svix signature of every delivery.
- Idempotent per Resend `email_id`: webhook redeliveries never double-forward.
  Transient failures (Resend API down, SMTP hiccup) answer 503 so Resend's
  bounded retry redelivers — a reply is never silently lost.
- Auto-replies / out-of-office / bounce notifications are recorded but never
  forwarded (no auto-responder ping-pong), and each file is capped at 20
  forwards per hour as a circuit breaker.
- Replies to an archived file's address are not forwarded. A reply arriving on
  a file with no active assignees alerts the admins instead of vanishing.
