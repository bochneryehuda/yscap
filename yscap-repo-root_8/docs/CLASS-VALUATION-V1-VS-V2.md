# Class Valuation — we are on the **V1** Orders API

**Owner-directed 2026-08-07.** The first cut of this integration was built against the
wrong document. YS Capital is on the **V1 Orders API**; the guide that governs is
*"Class Orders API Guide"*, rev **0.17**, dated **08-03-2026** (file
`ClassExternalOrdersAPIGuidev1.pdf`). A separate **V2** document exists
(`ClassOrdersAPIGuide_V2.pdf`) and describes a **different API** — different hosts,
different field spellings, different enum lists. **Do not mix them.**

This file exists because two of the differences are silent: they do not error, they
just produce a wrong request or a dropped value.

## The differences that bit

| | **V1 — what we send** | V2 — what the other guide says |
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

## UAD 2.6 vs 3.6 — we are on 2.6

The V1 guide also documents a UAD 3.6 extension reached as `POST /v2/orders`
(equivalently `POST /orders` with `api-version=2.0`) **on the same host**. Per the
owner, we stay on UAD 2.6 — plain `POST /orders`. Nothing in `src/class/` targets the
`/v2/` paths. Note for whenever that changes: UAD 3.6 types `occupancy` as an enum and
its property-type list carries a real `PUD` value, which would retire the
PUD → SingleFamily assumption `order-build.js` currently declares.
