# Class Valuation — which guide, and which UAD version

> **"Version 2" means two different things, and that is the whole reason this file
> exists.** Read this paragraph before changing anything in `src/class/`.
>
> 1. **The guide.** Two PDFs exist. The one that governs is
>    *"Class Orders API Guide"* rev **0.17** (08-03-2026), file
>    `ClassExternalOrdersAPIGuidev1.pdf`. The other, `ClassOrdersAPIGuide_V2.pdf`,
>    describes a **different API** on `orders-external.*` hosts and **never mentions
>    UAD at all**. Nothing is built against it.
> 2. **The UAD version**, *inside* the governing guide: `POST /orders` is **UAD 2.6**
>    and `POST /v2/orders` is **UAD 3.6**, on the same hosts and credentials. When
>    the owner says "version one and version two", this is what they mean —
>    **both are built**, 2.6 is the default. See the last section.

**Owner-directed 2026-08-07.** The first cut of this integration was built against the
wrong document (#1). It was rebased onto the governing guide, and then both UAD
versions (#2) were built.

## The differences that bit — governing guide vs the `orders-external` document

| | **What we send** (governing guide) | The `orders-external` document |
|---|---|---|
| Order host (prod) | `https://api.classvaluation.com` | `https://orders-external.classvaluation.com` |
| Order host (UAT) | `https://api.uat.classvaluation.com` | `https://orders-external.uat.classvaluation.com` |
| Order host (test) | `https://api.test.classvaluation.com` | `https://orders-external.test.classvaluation.com` |
| Occupancy field | **`occupancy`** (p.30) | `ocupancy` — misspelled (p.26) |
| Property type field | `propertyTypeEnum` | `propertyTypeEnum` on create, `propertyType` on read |
| `loanInfo.loanType` list | adds `ConstructionLoan`, `K203`, `HELOC` | shorter list |

A wrong host is a DNS/404 failure — loud. **The occupancy spelling is the dangerous
one:** send V2's `ocupancy` to V1 and it is an unrecognised field, dropped on their
side with no error, so the appraiser is dispatched with no occupancy stated. The
reverse is equally true. If this integration is ever moved to V2, the spelling and the
hosts move **together** — never "fix" the spelling on its own.

Pinned by `scripts/test-class-order-build-pure.js`: the body must carry `occupancy`
and must NOT carry `ocupancy`, and all three order hosts are asserted verbatim.

## What is the same in both

Confirmed by reading both documents side by side, so none of this had to be rebuilt:

- **Auth** — OAuth2 **password grant**, four values, all `[Required]`: `client_id`,
  `client_secret`, `username`, `password`, form-encoded to
  `https://ids.<env>.classvaluation.com/connect/token`. V1 p.9 says "**All** Class
  Valuation APIs are protected by OAuth 2.0 Password Grant Security policy" — so the
  four-credential requirement is not a V2-only thing. The only other documented grant
  (`cv_user_identity`) still needs the client id and secret. A portal login alone is
  not enough.
- **The create-order body shape** — `productId`, `referenceNumber`,
  `property.{street,line2,city,state,zip,county,taxId}`, `contacts[]`, `lender{}`,
  `loanInfo{}`, `dueDate`, `purpose`, `propertyTypeEnum`, `instructions`,
  `contractPrice`, `dateOfContract`, `notificationList[]`.
- **Create-order response** — `{ success, orderId, transactionId, message }`.
- **Enum values we actually use** — every one is in both lists: purpose
  `Bridge`/`Construction`/`Purchase`/`Refinance`; propertyTypeEnum `SingleFamily`/
  `Condominium`/`TwoToFourFamily`/`MultiFamily`/`TownhouseorRowhouse`; loanType
  `NewConstruction`/`Other`; contact types `Borrower`/`Coborrower`/`PropertyAccess`/
  `LoanOfficer`; contact methods `Email`/`MobilePhone`/`WorkPhone`; notification type
  `BorrowerInfo`.
- **Endpoints** — `POST /orders`, `GET /orders`, `GET /orders/{id}`, `GET /products`,
  `GET /products/{id}`, `POST /orders/{id}/notes`, `.../request-revision`,
  `.../request-cancel`, `GET|POST|DELETE /callbacks`.

## Still unconfirmed — check these before switching anything on

1. **The UAT and production identity hosts.** Both guides only ever print the *test*
   one (`ids.test.classvaluation.com`). `ids.uat.` and `ids.` are inferred from its
   shape. `client.hosts()` reports `tokenConfirmed:false` for those two on purpose,
   and both are overridable by env (`CLASS_TOKEN_URL`).
2. **The attachments path.** V1 contradicts itself: the order-completion walkthrough
   (p.7, newest revision) says `GET /orders/{orderId}/attachments`; the older
   Attachments reference section (p.14) says `GET /{orderId}/attachments`. We follow
   the walkthrough. A 404 on the first live pull means try the other form — it is not
   a credential problem.
3. **The `occupancy` vocabulary.** On V1 it is a free-form String
   ("Self-descriptive"), with no published list. `Investment` is confirmed by their own
   vocabulary (the UAD 3.6 extension in the same guide types the field as
   `PrimaryResidence | SecondHome | Investment | Other`), and it is what essentially
   every RTL file resolves to. Our other four words are unverified wording.

## UAD 2.6 AND 3.6 — both are built; 2.6 is the default

**Owner-directed 2026-08-07:** *"we need to build the 3.6 and the 2.6 … it's going to
shift in the next few months. We want to be ready for both … default to the version
one with an option to change to version two, which is 3.6."*

Both live in the **same** guide, on the **same** hosts, with the **same** credentials:

| | UAD 2.6 | UAD 3.6 |
|---|---|---|
| Path | `POST /orders` | `POST /v2/orders` (or `/orders` + `api-version=2.0`) |
| Status | **the default** | ready for the shift |

**"Version 2" here means UAD 3.6 — NOT the `orders-external` PDF.** That document
never mentions UAD at all (checked: zero occurrences). Confusing the two is how the
wrong hosts got built the first time.

### How to change it

- **For everyone:** set `CLASS_API_VERSION=v2` in Render. It accepts `v1`/`v2`,
  `1`/`2` or `2.6`/`3.6`, and an unrecognised value falls back to the default rather
  than throwing — a typo in an env var must never take the desk down.
- **For one order:** the order screen has a "Which of their forms" row. Picking the
  newer one previews and sends *that file* on 3.6 and changes nothing for anyone
  else, which is the point of building both ahead of time.

### What actually differs — all of it silent if got wrong

Everything version-specific lives in `PROFILES` in `src/class/order-build.js`, and
nothing else in that file branches on the version. These are the traps:

| | UAD 2.6 | UAD 3.6 |
|---|---|---|
| Property-type FIELD | `propertyTypeEnum` | **`propertyType`** |
| Property-type VALUES | 19 values incl. `TownhouseorRowhouse`, `MultiFamily`, `Farm`, the land types | 10 values incl. **`PUD`**, `COOP`, `CondoHotel`, `DetachedCondo` — a different list, not a superset |
| `contacts` role key | `Type` | **`type`** |
| `notificationList` keys | `Type` / `Email` | **`type`** / **`email`** |
| `occupancy` | free-form String | closed enum: `PrimaryResidence`, `SecondHome`, `Investment`, `Other` |
| Fannie DU number | `caseFileId` | `duReferenceNumber` |
| Freddie LPA key | `lpaKey` | `lpaKeyReferenceIdentifier` |
| `purpose` | 21 values | same + `Reverse` |
| `loanInfo.loanType` | unchanged between the two | unchanged |

A renamed field or a re-cased key is an **unrecognised field, dropped with no error**
on the other version — so every one of these is asserted in BOTH directions in
`scripts/test-class-order-build-pure.js`: the right name present *and* the wrong name
absent. The body is never sent with both spellings "to be safe": the version that
does not know the other name would reject the whole order rather than ignore a field.

### Where a mapping genuinely changes meaning

- **PUD** is an assumption on 2.6 (filed as SingleFamily, declared) and a **real
  value** on 3.6 — so on 3.6 it is no longer an assumption at all.
- **A townhouse** has no 3.6 value (they dropped `TownhouseorRowhouse`), so it files
  as a PUD *as a declared assumption*.
- **A 5+ unit building** has no 3.6 value at all. It **blocks** rather than being
  squeezed into `TwoToFourFamily`.
- **Occupancy**: `vacant` has no 3.6 value, so it becomes `Other` **and says so**;
  anything 3.6 cannot express blocks rather than being guessed. On 2.6 the same file
  is fine, because the field is free text there.

## Callbacks — one registration, both versions, and where the version comes from

Class **pushes**: we register a URL once and they POST an event whenever something
happens to an order (`StatusChanged`, `NewAttachments`, `SetAppointment`,
`AssignedToVendor`, `InspectionCompleted`, `OrderPaid`, `ClientFeeChanged`,
`ClientDueDateChanged`, `PaymentLinkSentToBorrower`, `CustomFieldsSet`,
`ScannerEvents`, `DesktopEvents`, `NewNotes`, `AvmReport`, `AvmData`).

**Registration is per ORGANIZATION and carries no version.** The body is an event
name, a URL and the credentials they should use — nothing else. So **one registration
covers orders on both UAD versions**, and there is no second setup to do when the
default moves to 3.6.

### The version problem, and the rule

**Their event does not say which version its order was placed on.** Every event
carries the same envelope either way:

```
{ orderId, referenceNumber, eventName, sent, created, data }
```

That matters because a follow-up read is *not* version-neutral: `GET /orders/{id}`
and `GET /v2/orders/{id}` describe the same order in different vocabularies. Reading
a 3.6 order through the 2.6 path **does not error** — it answers in the other
vocabulary, and anything keyed on a field name quietly finds nothing.

So the rule, enforced in `src/class/callbacks.js`:

> **The version comes from OUR order row, never from the event, and never from the
> current default.**

`class_orders.api_version` and `class_orders.order_path` are written when the order
is placed (db/490) — *before* the call goes out, so an order that times out on the
wire still has a record its callback can match. When the version is genuinely unknown
(an order placed before that table existed), the event is still **recorded** and any
version-specific call is **declined**. Falling back to the configured default would be
the worst of the three options: it is right most of the time, which is exactly what
makes the wrong answer invisible.

### Receiving

`POST /api/class/callbacks` — mounted **before** the global JSON parser with its own
small one and a rate limit, like the ClickUp / DocuSign / TrustPoint webhooks.

- **HTTP Basic**, with credentials we choose and hand them at registration
  (`CLASS_CALLBACK_USER` / `CLASS_CALLBACK_PASSWORD`), compared over sha256 digests so
  the check is constant-time. Their `ApiToken` mode is supported too
  (`CLASS_CALLBACK_TOKEN` / `CLASS_CALLBACK_TOKEN_HEADER`) in case they switch.
- **Fails CLOSED**: with nothing configured, every delivery is refused. An
  unauthenticated public endpoint that writes rows is worse than a receiver that is
  switched off.
- **Stores first, thinks later.** The delivery is written verbatim and answered 200
  immediately (their contract is 200 within 30 seconds); processing happens off the
  request path. A 500 is only ever returned when we failed to *store* it — which is
  the one case where their retry is genuinely our second chance.
- **Deduped** on (event, sha256 of the payload + the UTC day), so a retry collapses
  but a byte-identical legitimate event weeks later is not swallowed.
- An event for an order we do not have is **kept**, not dropped, and marked handled
  rather than retried forever.

Setup lives at `GET|POST /api/class/callback-setup` (`platform_setup`) — deliberately
**not** under `/callbacks`, because that path is the public receiver and a staff route
hidden behind it would be answered by the webhook's own catch-all.

## Working the order: messages, revisions, and reconsiderations of value

Once an order is live, four things happen against it. Three of them share a shape at
Class but are genuinely different asks, and one of them does not exist as its own call
at all.

| What the desk does | Class endpoint | Version-specific? |
|---|---|---|
| Message back and forth | `GET|POST /orders/{id}/notes` | **No** |
| Ask for a correction | `POST /orders/{id}/request-revision` | **No** |
| Dispute the value (ROV) | *the same* `request-revision` | **No** |
| Cancel the order | `POST /orders/{id}/request-cancel` | **No** |
| Status / documents / inspection news | their callbacks (push) | **No** |

**Only order CREATE, order READ and the product catalogue have a `/v2` variant.**
Nothing else does — so `src/class/messages.js` deliberately takes no version and does
not consult the order's `api_version`. Threading one through would imply a choice that
does not exist, and the first person to "fix" it would go looking for a `/v2/notes`
Class never published.

### There is no ROV endpoint

A reconsideration of value at Class is a **revision filed with value-related reason
codes**. So:

- `src/class/revision-reasons.js` carries their full closed list (~90 codes) verbatim,
  including the two the guide itself misspells — transcribed exactly, because
  "correcting" one sends a code they reject.
- The ROV set is a **lens on that list**, never a vocabulary of ours. A made-up code
  like `ROV` or `ValueDispute` is invalid and is refused.
- Filing an ROV with no value-related reason is **refused**: it would reach the
  appraiser as an ordinary correction.
- The reverse is also handled — a *value* reason filed through the plain "ask for a
  fix" button is still **recorded as an ROV**, because "did we dispute the value on
  this file?" must not depend on which button somebody pressed.
- Their `Other` code means nothing on its own, so choosing it without an explanation
  is refused rather than sent as an empty ask.

### A message is never lost to a failed send

Notes are written to `class_notes` **before** the call goes out, in the direction that
says we wrote them. If the send fails, the message sits there with the error on it and
can be retried — the screen shows "not delivered", never a message that silently
vanished. Their replies arrive on the `NewNotes` callback (or a manual "check for
replies" pull) into the same thread, keyed on their note id so a retried delivery
cannot duplicate a message.

Asking to cancel does **not** mark the order cancelled. The order moves when their
`StatusChanged` callback says so — asking is not the same as them agreeing.
