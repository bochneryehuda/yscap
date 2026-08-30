# Sending an order from the person who placed it — and keeping it out of spam

**Owner's ask (2026-08-30):** *"it should not come from the no reply or from the pilot
email, it should try to come from their own email … do a lot of research how to avoid
spam filters … let me know if we can use the existing configuration."* And: *"make sure
all the orders are coming from the user that is actually ordering, from his email, from
his name."*

**The short answer to the configuration question: YES — for everybody whose email is on
the company domain, with nothing new to set up.** The rest of this page is why, what
happens to everybody else, and what else keeps these letters out of spam.

---

## 1. Why the From line is not a display choice

Three mechanisms decide whether a message is delivered at all, and every one of them
keys on the **domain** of the address in the From line.

| | What it actually asks | What it checks |
|---|---|---|
| **SPF** | Was this server allowed to send for this domain? | The **envelope** sender (Return-Path) — *not* the From a human reads |
| **DKIM** | Was this signed by a key published in that domain's DNS? | A signature whose `d=` names a domain, verified against `<selector>._domainkey.<domain>` |
| **DMARC** | Do those two **agree with the From line**? | *Alignment* — the domain that passed SPF or DKIM must match the From domain |

A message whose From says `chaya@gmail.com`, signed by our key, sent from our
provider's servers, is aligned with nothing. Since Google's and Yahoo's 2024 sender
requirements that is not a grey area: it is filtered or rejected.

**Our provider verifies a DOMAIN, not an address.** That is the whole finding. The DKIM
key published for our sending domain signs `notifications@` and `chaya@` identically —
they are the same deliverability question. `chaya@gmail.com` is a different one, and
there is no configuration that makes it work.

## 2. So the rule is

`src/lib/send-as.js` — one pure function, three answers:

| mode | When | From | Reply-To |
|---|---|---|---|
| `as_user` | Their address is on a domain we are verified to send from | `"Chaya Gruber" <chaya@yscapgroup.com>` | the order's own address |
| `on_behalf` | It is not | `"Chaya Gruber via PILOT" <notifications@yscapgroup.com>` | the order's own address (they are on the Cc) |
| `company` | Nobody usable was named, or the switch is off | the company address, under their name where we have one | the order's own address |

`on_behalf` is not a fudge. The recipient reads their name, every reply reaches them
(the recipient rule puts the loan officer on the Cc of every order), and nothing about
the message is untrue. The alternative — put their address in the From and hope — is
exactly what the sender rules exist to catch, and **a vendor who never receives the
order is worse than one who sees our domain in small print.**

**The order's own reply address always wins over the person's**, and that is
load-bearing rather than a compromise: `ltorder+<kind>.<loan>@` is what files a
vendor's returned documents onto the right condition. Redirecting replies to somebody's
personal inbox would take the documents off the file.

## 3. Configuration

| Variable | Default | What it does |
|---|---|---|
| `SEND_AS_USER` | on | `0` returns every send to the company address |
| `EMAIL_SENDING_DOMAINS` | *derived* | Comma-separated domains a From line may carry. **Unset, it derives the domain of `NOTIFY_FROM`** — the one the provider has already verified — which is what makes this work on today's live configuration |
| `NOTIFY_FROM` | `PILOT by YS Capital <notifications@yscapgroup.com>` | Unchanged. Still the company address, still never a no-reply (`config.resolveNotifyFrom` repairs one) |

**Nothing new is required.** Set `EMAIL_SENDING_DOMAINS` only when a SECOND verified
domain is added.

### The one provider-specific hazard

Under **Microsoft Graph** the send is `POST /users/{from}/sendMail`, so the From must be
a **real mailbox in the tenant** and the app must hold permission on it. A From that is
merely on the right domain but is not a mailbox does not degrade — the whole send
**fails**. A failed order is worse than one from the company address, so a send-as-user
attempt under Graph is retried **once** from the company address (and never on an
ambiguous failure, where the provider may already have taken the first message and a
retry would deliver the order twice). Under **Resend** there is no such hazard: the
domain is what is verified.

## 4. What else keeps these out of spam

Every one of these is already true of what this system sends. It is written down so a
future change does not undo one without noticing.

- **A real, monitored From and Reply-To — never a no-reply.** A `no-reply@` From is
  itself a spam signal, and it is untrue of these letters. Already enforced in
  `config.resolveNotifyFrom`.
- **A `text/plain` part beside the HTML.** `email/template.js` always produces both; an
  HTML-only message scores badly with every filter.
- **A real RFC `Message-ID` on our own domain**, plus `In-Reply-To`/`References` on a
  follow-up, so a chase threads in the vendor's inbox instead of reading as a fresh
  cold email.
- **A plain subject that names the property and the loan number.** No exclamation
  marks, no "URGENT", no all-caps, no emoji.
- **Few images, no tracking pixel on a vendor letter, no link shorteners**, and links
  only to our own domain. (Open tracking is deliberately absent from these: a pixel on
  a one-to-one business letter buys a statistic and costs reputation.)
- **One sending domain, used consistently.** Reputation is per domain and a fresh
  subdomain starts at zero — which is why a "new subdomain for orders" would make
  deliverability *worse*, not better.
- **Volume that looks like what it is.** These are one-to-one transactional letters to a
  company we are doing business with, a handful a day.

**Deliberately NOT added: a `List-Unsubscribe` header.** Offering a title company an
unsubscribe link on a title order is both wrong and a signal that the message is bulk
mail. It belongs on marketing, not on this.

### The DNS side, for whoever owns the domain

Nothing here needs changing for send-as-user to work — it is recorded so the picture is
in one place:

1. **SPF** — one record on the sending domain, including the provider's send host. One
   record only: two `v=spf1` records is a permanent fail.
2. **DKIM** — the provider's selector record. This is what "verified domain" means.
3. **DMARC** — `_dmarc.<domain>`. Start at `p=none` with `rua=` reporting, read the
   reports for a few weeks, then move to `p=quarantine` and `p=reject`. Enforcement is
   what stops somebody else spoofing our domain; it does not affect our own sends
   because ours are aligned.
4. **A Return-Path / custom MAIL FROM on the sending domain**, so SPF aligns as well as
   DKIM. DKIM alignment alone satisfies DMARC, so this is belt to that suspender.
5. **BIMI** is optional, needs DMARC at enforcement plus a verified mark certificate,
   and buys a logo in the inbox. Worth doing after step 3, never before.

## 5. Where it is switched on

The **long-term orders desk** sends this way today (`src/longterm/orders/desk.js`).

**The short-term desk is deliberately NOT changed.** Its From is a live deliverability
posture on a product with real traffic, and the standing rule is that a feature built
for one side never automatically applies to the other. The module is product-neutral and
wiring it into `src/lib/orders.js` is a small change — **it needs the owner to say so.**

## 6. Guarded by

`scripts/test-send-as-pure.js` (in `npm test`): the whole truth table, header-injection
safety, the derived domain list, the Graph fallback flag, and — the assertion that
matters most — **an address on a domain we cannot sign for is NEVER put in a From
line**, in either direction.
