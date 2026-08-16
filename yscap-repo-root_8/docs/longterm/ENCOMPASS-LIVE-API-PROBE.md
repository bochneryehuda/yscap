# Encompass Developer Connect — LIVE API Probe

**Instance:** `BE11397907` (YS Capital Group) · **Probed:** 2026-08-14 · **Mode:** READ-ONLY
**Encompass version reported by the tenant:** `26.2.0.x` · **Loan schema version:** `26.2.0.0`

This document records the results of a live, read-only probe of the ICE Mortgage Technology /
Encompass Developer Connect API against the production instance. Every endpoint below was
actually called; every response shape is a real (trimmed, PII-redacted) sample.

> **Guardrail.** Nothing in this probe mutated the Encompass instance. The only non-GET calls
> issued were: `POST /oauth2/v1/token` (auth), `POST /oauth2/v1/token/introspection` (auth
> metadata read), `POST /encompass/v1|v3/loanPipeline` (search), and
> `POST /encompass/v3/loans/{id}/fieldReader` (field read). All four are read-shaped. See
> `docs/ENCOMPASS-READONLY-GUARDRAILS.md` and the structural gate in
> `src/longterm/encompass/client.js`.

> **Secrets.** Credentials are referenced only as env var names:
> `LT_ENCOMPASS_CLIENT_ID`, `LT_ENCOMPASS_CLIENT_SECRET`, `LT_ENCOMPASS_INSTANCE_ID`,
> `LT_ENCOMPASS_USERNAME`, `LT_ENCOMPASS_PASSWORD`. No secret values appear in this file.

> **PII.** Borrower names, SSNs and street addresses in real samples have been replaced with
> `<REDACTED>`. Staff names/emails are internal company directory data and are kept, because the
> whole point of §2 is the staff-identity mapping. Loan numbers and GUIDs are kept — they are
> opaque internal identifiers.

---

## Table of contents

1. [Auth](#1-auth)
2. [Loan officer & assigned contacts — TOP PRIORITY](#2-loan-officer--assigned-contacts--top-priority)
3. [Pipeline](#3-pipeline)
4. [Loan data model](#4-loan-data-model)
5. [URLA / 1003](#5-urla--1003)
6. [Conditions](#6-conditions)
7. [Pricing & lock](#7-pricing--lock)
8. [Milestones](#8-milestones)
9. [Webhooks](#9-webhooks)
10. [Field lookup / dictionary](#10-field-lookup--dictionary)
11. [Permission map — what 403s](#11-permission-map--what-403s)
12. [Build-plan implications](#12-build-plan-implications)

---

## 1. Auth

### Working token request (confirmed)

```
POST https://api.elliemae.com/oauth2/v1/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
&username=<LT_ENCOMPASS_USERNAME>@encompass:<LT_ENCOMPASS_INSTANCE_ID>
&password=<LT_ENCOMPASS_PASSWORD>
&client_id=<LT_ENCOMPASS_CLIENT_ID>
&client_secret=<LT_ENCOMPASS_CLIENT_SECRET>
&scope=lp
```

Notes on the exact format that works:

* Username **must** carry the `@encompass:<instanceId>` suffix. The instance id is
  case-insensitive on the wire (the token echoes it back lowercased as `be11397907`).
* Credentials go in the **form body**, not HTTP Basic. (Basic works for
  `/token/introspection`, see below, but the token grant was probed with body params.)
* `scope=lp` is required and is the only scope granted.
* This is exactly what `src/longterm/encompass/client.js :: getToken()` already sends — **no
  change needed** to the existing client's auth.

### Token response (real)

```json
{
  "access_token": "00042eq6fIjA…",   // 28 chars, opaque
  "token_type": "Bearer"
}
```

⚠️ **`expires_in` is NOT returned.** The client's fallback of assuming 1800 s is correct — see
introspection below. Do not rely on the token response to compute expiry.

### Token lifetime & scope — via introspection

```
POST https://api.elliemae.com/oauth2/v1/token/introspection
Authorization: Basic base64(<client_id>:<client_secret>)
Content-Type: application/x-www-form-urlencoded

token=<access_token>
```

Real response:

```json
{
  "active": true,
  "scope": "lp",
  "client_id": "<LT_ENCOMPASS_CLIENT_ID>",
  "username": "admin@encompass:be11397907",
  "token_type": "Bearer",
  "exp": 1786733213,
  "sub": "admin@encompass:be11397907",
  "bearer_token": "<REDACTED>",
  "encompass_user_type": "Internal",
  "encompass_instance_id": "BE11397907",
  "encompass_client_id": "3011397907",
  "user_name": "admin",
  "user_key": "admin@encompass:be11397907",
  "encompass_user": "Encompass\\BE11397907\\admin",
  "identity_type": "Enterprise",
  "encompass_instance_type": "Prod",
  "realm_name": "encompass:be11397907"
}
```

**Findings**

| Item | Value |
|---|---|
| Token lifetime | **exactly 30 minutes** (`exp` − issue time = 1800 s) |
| Scopes | `lp` — the only scope |
| User type | `Internal` / `Enterprise` |
| Instance type | **`Prod`** — this is the live production tenant, not a sandbox |
| Encompass client id (webhook realm) | `3011397907` |

**Recommendation:** keep the client's `expires_in || 1800` fallback with the 60 s safety margin.
Refresh at ~25 min.

### Rate limits (response headers on every call)

```
x-rate-limit-limit:            500000
x-rate-limit-remaining:        500000
x-rate-limit-reset:            1786752000   (epoch — daily reset)
x-concurrency-limit-limit:     30
x-concurrency-limit-remaining: 30
```

500 k requests/day, **30 concurrent**. The LT client's 350 ms in-process gap is far more
conservative than needed; the real constraint is concurrency, not volume.

---

## 2. Loan officer & assigned contacts — TOP PRIORITY

There are **four** independent surfaces that answer "who is assigned to this loan". They agree,
but they carry different information, and only two of them give you a machine-joinable key.

### 2.0 The instance's actual role table

`GET /encompass/v1/settings/roles` → **200** (12 roles). ⚠️ Note: `/encompass/v1/company/roles`
is **403**; the working path is `/settings/roles`.

| roleID | abbr | roleName | mapped persona(s) |
|---|---|---|---|
| **0** | — | **File Starter** | (pseudo-role, always present on a loan) |
| **1** | LC | **Loan Coordinator** ← *this tenant's "Loan Officer"* | 7 Loan Coordinator |
| **5** | LP | **Loan Processor** | 11 Loan Processor |
| **6** | UW | **Underwriter** | 12 Underwriter |
| **7** | CL | **Closer** | 13 Closer |
| **8** | FN | **Funder** | 15 Funder |
| **9** | PC | **Post Closer** | 35 Post Closer |
| **10** | LD | **Lock Desk** | 18 Lock Desk/Secondary |
| **14** | AC | **Accounting** | 22 Accounting |
| **19** | _P | Protect - Doc Access | 12 Underwriter |
| **21** | TL | TPO Loan Coordinator | 43 TPO Loan Coordinator, 45 TPO Manager |
| **22** | TP | TPO Processor | 44 TPO Processor, 45 TPO Manager |
| **23** | AE | TPO AE | 46 TPO Account Executive |

**CRITICAL for the build:** this tenant has **no role literally named "Loan Officer"**. The
loan-officer slot is the **`Loan Coordinator` role (roleId `1`)**. Encompass's *field* 317 is
labelled "Loan Officer" and it is populated from the Loan Coordinator role assignment. The
default Encompass roles `Loan Opener`, `Shipper`, `Insurer` **do not exist here** and always
read empty.

`GET /encompass/v1/settings/personas` → **200** (17 personas):

| id | persona | internal | external | defaultAccess |
|---|---|---|---|---|
| 0 | Super Administrator | (implicit) | | |
| 1 | Administrator | ✓ | | All |
| 7 | Loan Coordinator | ✓ | | None |
| 11 | Loan Processor | ✓ | | None |
| 12 | Underwriter | ✓ | | None |
| 13 | Closer | ✓ | | None |
| 15 | Funder | ✓ | | None |
| 18 | Lock Desk/Secondary | ✓ | | None |
| 22 | Accounting | ✓ | | None |
| 35 | Post Closer | ✓ | | None |
| 40 | Disclosure | ✓ | | None |
| 41 | Manager | ✓ | | All |
| 42 | WEBHOOK | ✓ | | All |
| 43 | TPO Loan Coordinator | | ✓ | None |
| 44 | TPO Processor | | ✓ | None |
| 45 | TPO Manager | | ✓ | None |
| 46 | TPO Account Executive | ✓ | | None |
| 48 | Evolve API | ✓ | | None |

---

### 2.1 ⭐ BEST: `LoanTeamMember.*` dynamic fields via fieldReader

**This is the authoritative, machine-joinable answer. Use this.**

```
POST /encompass/v3/loans/{loanId}/fieldReader
Content-Type: application/json

["LoanTeamMember.UserId.Loan Coordinator",
 "LoanTeamMember.Name.Loan Coordinator",
 "LoanTeamMember.Email.Loan Coordinator",
 "LoanTeamMember.Phone.Loan Coordinator",
 "LoanTeamMember.UserId.Loan Processor", …]
```

Field-id grammar: **`LoanTeamMember.{Name|UserId|Email|Phone}.{exact role name}`**.
The role name is the tenant's own `roleName` from `/settings/roles` (spaces included).
`LoanTeamMember.Id.<role>` is **invalid** — it is `UserId`, not `Id`.

Real response (loan `000c1737-1022-4d6d-bf6f-b9e0d2fb434c`):

```json
{
  "LoanTeamMember.Name.Loan Coordinator":   "Solomon Weiss",
  "LoanTeamMember.UserId.Loan Coordinator": "sweiss",
  "LoanTeamMember.Email.Loan Coordinator":  "Sol@yscapgroup.com",
  "LoanTeamMember.Phone.Loan Coordinator":  "718-635-0277",

  "LoanTeamMember.Name.Loan Processor":     "Esther Bochner",
  "LoanTeamMember.UserId.Loan Processor":   "ebochner",
  "LoanTeamMember.Email.Loan Processor":    "Esther@yscapgroup.com",
  "LoanTeamMember.Phone.Loan Processor":    "718-247-8705",

  "LoanTeamMember.Name.Underwriter":        "",
  "LoanTeamMember.UserId.Underwriter":      "",

  "LoanTeamMember.Name.Closer":             "Malky  Katz",
  "LoanTeamMember.UserId.Closer":           "mkatz",
  "LoanTeamMember.Email.Closer":            "Malky@yscapgroup.com",

  "LoanTeamMember.Name.Funder":             "Malky  Katz",
  "LoanTeamMember.UserId.Funder":           "mkatz",

  "LoanTeamMember.Name.Post Closer":        "Malky  Katz",
  "LoanTeamMember.UserId.Post Closer":      "mkatz",

  "LoanTeamMember.Name.Lock Desk":          "",
  "LoanTeamMember.UserId.Lock Desk":        "",
  "LoanTeamMember.Name.Accounting":         "",
  "LoanTeamMember.UserId.Accounting":       "",

  "LoanTeamMember.Name.File Starter":       "Solomon Weiss",
  "LoanTeamMember.UserId.File Starter":     "sweiss"
}
```

**`UserId` is the Encompass login id** — exactly the `id` from `/encompass/v1/company/users`.
This is the join key for `Encompass user → LT staff user`.

fieldReader constraints (learned the hard way):
* Body is a **bare JSON array of field-id strings** (not an object).
* Field ids must be **unique** — a duplicate returns `400 "Items in the collection should be unique."`
* An unknown field id returns `400` with `"Invalid field id: 'X'"` **and rejects the whole batch**.
  Validate your field list once, then cache it.

---

### 2.2 ⭐ ALSO GOOD: `loan.contacts[]` (structured, one GET)

```
GET /encompass/v3/loans/{loanId}?entities=contacts
```

Real response (trimmed, one loan):

```json
{
  "id": "4b18ec64-…",
  "contacts": [
    { "contactType": "LOAN_OFFICER",    "loginId": "mschwimmer", "name": "Mendel Schwimmer",
      "email": "Mendel@yscapgroup.com", "phone": "845-745-5595", "fax": "718-247-8443" },
    { "contactType": "LOAN_PROCESSOR",  "loginId": "mschwimmer", "name": "Mendel Schwimmer",
      "email": "Mendel@yscapgroup.com", "phone": "845-745-5595" },
    { "contactType": "LOAN_CLOSER",     "loginId": "mkatz",      "name": "Malky  Katz",
      "email": "Malky@yscapgroup.com",  "phone": "718-247-8702" },
    { "contactType": "BROKER_LENDER",   "name": "YS Capital Group", "companyId": "2609746",
      "contactName": "<staff>", "address": "<REDACTED>", "city": "Brooklyn", "state": "NY",
      "postalCode": "11211", "phone": "718-635-0277" },
    { "contactType": "APPRAISAL_COMPANY", "name": "Class Valuation", "email": "samg@rmsta.com" },
    { "contactType": "TITLE_COMPANY",     "email": "…@dekelabstract.com" },
    { "contactType": "ESCROW_COMPANY",    "email": "…@dekelabstract.com" },
    { "contactType": "SETTLEMENT_AGENT",  "name": "Dekel Abstract LLC" },
    { "contactType": "HAZARD_INSURANCE",  "email": "…" },
    { "contactType": "FLOOD_INSURANCE" },
    { "contactType": "SERVICING",         "name": "Selene Finance LP" },
    { "contactType": "WAREHOUSE",         "name": "Banc of CA" },
    { "contactType": "INVESTOR",          "name": "Deephaven Mortgage LLC" },
    { "contactType": "LENDER_INVESTOR",   "name": "YS Capital Group" },
    { "contactType": "MORTGAGEE",         "name": "YS Capital Group, ISAOA/ATIMA" }
  ]
}
```

**Full `contactType` vocabulary observed across 20 loans:**

`LOAN_OFFICER`, `LOAN_PROCESSOR`, `LOAN_CLOSER`, `BROKER`, `BROKER_LENDER`,
`BROKER_LENDERSsnCompany`, `BROKER_LENDERSsnCompanyAgent`, `LENDER_INVESTOR`, `INVESTOR`,
`SELLER`, `APPRAISAL_COMPANY`, `CREDIT_COMPANY`, `ESCROW_COMPANY`, `TITLE_COMPANY`,
`SETTLEMENT_AGENT`, `HAZARD_INSURANCE`, `FLOOD_INSURANCE`, `SERVICING`, `WAREHOUSE`,
`MORTGAGEE`, `CUSTOM`

Only **`LOAN_OFFICER`, `LOAN_PROCESSOR`, `LOAN_CLOSER`** carry a `loginId` (they are internal
staff). Everything else is an external company/vendor contact with `name`/`companyId`/address.

Union of keys on a contact object:
`address, appraisalMade, bizLicenseAuthStateCode, categoryName, cell, city, comments, companyId,
contactName, contactRef, contactTitle, contactType, customContactIndex, email, fax,
insuranceCertNumber, insuranceDeterminationDate, insuranceDeterminationNumber,
insuranceFloodZone, insuranceNoOfBedrooms, lenderType, license, licenseExempt, licenseType,
loginId, name, nmlsLicense, personalLicenseAuthStateCode, personalLicenseNumber, phone,
postalCode, referenceNumber, state`

**This is the best single call** for a "loan detail" screen: one GET returns the LO, the
processor, the closer AND all vendor contacts (title, escrow, appraisal, insurance, investor,
warehouse, servicer).

---

### 2.3 `/associates` — per-milestone assignment log, NOT a deduped roster

```
GET /encompass/v1/loans/{loanId}/associates      → 200
GET /encompass/v3/loans/{loanId}/associates      → 403  (persona lacks v3 associates)
```

Real v1 response (loan `000c1737-…`), **14 rows for 8 distinct assignments**:

```json
[
 {"loanAssociateType":"User","id":"sweiss","name":"Solomon Weiss","phone":"718-635-0277",
  "email":"Sol@yscapgroup.com","roleName":"File Starter","roleId":"0"},
 {"loanAssociateType":"User","id":"sweiss","name":"Solomon Weiss","fax":"718-247-8443",
  "email":"Sol@yscapgroup.com","roleName":"Loan Coordinator","roleId":"1"},
 {"loanAssociateType":"User","id":"sweiss","…","roleName":"Loan Coordinator","roleId":"1"},
 {"loanAssociateType":"User","id":"mkatz","name":"Malky  Katz","roleName":"Loan Processor","roleId":"5"},
 {"loanAssociateType":"User","id":"ebochner","name":"Esther Bochner","roleName":"Loan Processor","roleId":"5"},
 {"loanAssociateType":"User","id":"ebochner","…","roleName":"Loan Processor","roleId":"5"},
 {"loanAssociateType":"User","id":"ebochner","…","roleName":"Loan Processor","roleId":"5"},
 {"loanAssociateType":"User","id":"sweiss","…","roleName":"Loan Coordinator","roleId":"1"},
 {"loanAssociateType":"User","id":"mkatz","…","roleName":"Closer","roleId":"7"},
 {"loanAssociateType":"User","id":"mkatz","…","roleName":"Closer","roleId":"7"},
 {"loanAssociateType":"User","id":"mkatz","…","roleName":"Funder","roleId":"8"},
 {"loanAssociateType":"User","id":"mkatz","…","roleName":"Post Closer","roleId":"9"},
 {"loanAssociateType":"User","id":"mkatz","…","roleName":"Post Closer","roleId":"9"},
 {"loanAssociateType":"User","id":"mkatz","…","roleName":"Post Closer","roleId":"9"}
]
```

**Exact JSON shape:** `{ loanAssociateType, id, name, phone?, cellPhone?, fax?, email, roleName, roleId }`.
`loanAssociateType` was `"User"` on every row observed (the other legal value is `"Contact"`).

**Gotchas — read before building on this:**

1. **It is NOT deduped.** It emits one row per *milestone slot*, so a role appears as many times
   as there are milestones assigned to it. On the loan above, `Loan Processor` appears 4× with
   **two different users** (`mkatz` then `ebochner` ×3) because the processor was reassigned
   mid-pipeline. The **current** assignee is `ebochner` (confirmed against fieldReader).
2. **Name/email can be a stale snapshot that disagrees with `id`.** On loan
   `4b18ec64-…` the Submittal row reads `{"id":"mschwimmer", "name":"Malky Katz",
   "email":"malky@yscapgroup.com"}` — but `/company/users/mschwimmer` is *Mendel Schwimmer*.
   Encompass stores a point-in-time copy of the contact card on the milestone.
   **→ Always treat `id` as truth and re-resolve name/email from `/company/users`.**
3. Because of (1) and (2), do **not** use `/associates` for "who is the LO". Use §2.1 or §2.2.
   Use `/associates` only for the *history* view.

---

### 2.4 Loan FIELD IDs for each role

Confirmed live via `POST /encompass/v3/loans/{id}/fieldReader` and via pipeline
`fields:["Fields.NNN"]`.

| Field ID | Encompass description | Pipeline canonical name | Live sample |
|---|---|---|---|
| **`317`** | File Contacts Loan Officer Name | `Fields.317` | `"Solomon Weiss"` |
| **`LOID`** ⭐ | **File Contacts Loan Officer Login ID** | `Fields.LOID` | `"sweiss"` |
| **`362`** | File Contacts Loan Processor Name | `Fields.362` | `"Esther Bochner"` |
| **`1855`** | File Contacts Closer Name | `Fields.1855` | `"Malky  Katz"` |
| **`984`** | File Contacts Underwriter Contact | `Fields.984` | `"Esther Bochner"` |
| **`1410`** | File Contacts Underwriter Phone | `Fields.1410` | |
| **`REGZGFE.X8`** | File Contacts Underwriter Co Name | `Fields.REGZGFE.X8` | |
| `315` / `319` / `313` / `321` / `323` / `324` | Broker/Lender name, addr, city, state, zip, phone | | |
| `3237` | Broker Lender Company ID | | |
| `1264` | File Contacts Lender Co Name | | |
| `1196` | Lender Info Tax ID | | |
| `1822` | Referral Source Name | | |
| `VEND.X263` | **Investor Name** | `Fields.VEND.X263` | `"Deephaven Mortgage LLC"` |
| `411` / `416` / `417` / `88` | Title Co name / contact / phone / email | | |
| `610` / `611` / `615` | Escrow Co name / contact / phone | | |
| `617` / `618` / `622` | Appraisal Co name / contact / phone | | |
| `624` / `625` / `629` | Credit agency name / contact / phone | | |
| `L252` / `VEND.X162` / `VEND.X163` | Hazard ins co / agent / phone | | |
| `1500` / `VEND.X13` / `VEND.X19` | Flood ins co / contact / phone | | |
| `L248` / `707` / `711` | MI co / contact / phone | | |
| `VEND.X178` / `VEND.X184` / `VEND.X185` | Servicing co / contact / phone | | |
| `VEND.X200` | Warehouse Co Name | | |
| `395` / `VEND.X195` / `VEND.X196` | Doc prep/signing co / contact / phone | | |
| `713` / `714` / `718` | Builder co / contact / phone | | |
| `VEND.X133` / `VEND.X139` | Buyer's agent name / contact | | |
| `VEND.X144` / `VEND.X150` | Seller's agent name / contact | | |
| `VEND.X293` | Broker Name | | |
| `305` | Lender Case # | | |

**`Fields.LOID` is the single most useful field on this list** — it is the only *pipeline-queryable*
field that returns the LO's Encompass login id, so you can build an LO-scoped pipeline in one
query (see §3).

Dynamic loan-team fields (fieldReader only, not pipeline-selectable for custom role names):

| Field id pattern | Live example |
|---|---|
| `LoanTeamMember.Name.<Role>` | `LoanTeamMember.Name.Loan Coordinator` → `"Solomon Weiss"` |
| `LoanTeamMember.UserId.<Role>` | `LoanTeamMember.UserId.Loan Coordinator` → `"sweiss"` |
| `LoanTeamMember.Email.<Role>` | → `"Sol@yscapgroup.com"` |
| `LoanTeamMember.Phone.<Role>` | → `"718-635-0277"` |

Pipeline **also** exposes a fixed set of `Fields.LoanTeamMember.Name.<Role>` canonical names, but
only for Encompass's *stock* role names — `Loan Officer`, `Loan Processor`, `Closer`, `Funder`,
`Underwriter`, `Post Closer`, `Loan Opener`, `Shipper`, `Insurer`. On this tenant
`Fields.LoanTeamMember.Name.Loan Officer` is **always empty** (the role is called Loan
Coordinator) while `Fields.LoanTeamMember.Name.Loan Processor` / `.Closer` / `.Funder` /
`.Post Closer` / `.Underwriter` **do** populate. Plus `CurrentLoanAssociate.FullName`
("Current Loan Team Member" = whoever owns the active milestone).

---

### 2.5 Company user roster

```
GET /encompass/v1/company/users?limit=200&start=0        → 200  (46 users)
GET /encompass/v1/company/users/{userId}                 → 200
GET /encompass/v1/users?limit=N                          → 200  (thin variant: no personas/org)
GET /encompass/v3/company/users                          → 403
```

Real record:

```json
{
  "id": "mschwimmer",
  "lastName": "Schwimmer",
  "firstName": "Mendel",
  "fullName": "Mendel Schwimmer",
  "email": "Mendel@yscapgroup.com",
  "phone": "845-745-5595",
  "cellPhone": "…",
  "workingFolder": "Started",
  "organization": { "entityId": "82", "entityType": "Organization",
                    "entityName": "Operations", "entityUri": "/v1/organizations/82" },
  "subordinateLoanAccess": "ReadOnly",
  "peerLoanAccess": "Disabled",
  "userIndicators": ["Enabled"],
  "lastLogin": "2026-08-13T18:59:35.997Z",
  "encompassVersion": "26.2.0.3",
  "nmlsOriginatorID": "9999999",
  "personalStatusOnline": true,
  "comments": "",
  "personas": [
    { "entityId": "7",  "entityType": "Persona", "entityName": "Loan Coordinator" },
    { "entityId": "11", "entityType": "Persona", "entityName": "Loan Processor" },
    { "entityId": "40", "entityType": "Persona", "entityName": "Disclosure" }
  ],
  "ccSite": { "useParentInformation": true,
              "url": "https://yscapgroup.mymortgage-online.com", "siteId": "5722777381" }
}
```

**Roster: 46 users.** 39 real staff (`@yscapgroup.com` / partners), 7 `Z-Test Users`
(`change.me@email.com` placeholders — `accounting`, `closer`, `disclosure`, `funder`, `lockdesk`,
`manager`, `officer`, `postcloser`, `processor`, `underwriter`). Two org units are populated:
**`Operations` (id 82, 33 users)** and `Z-Test Users`; admins sit outside an org.

`userIndicators` observed: `Enabled`, `Administrator`, `SuperAdminnistrator` *(sic — Encompass's
own typo)*, `TopLevelAdministrator`, `TopLevelUser`.

⚠️ The user record does **not** carry per-loan roles — roles are a loan-level assignment. The
user-level analogue is **`personas`**, which is what gates *which roles they may be assigned to*.

Loan-Coordinator-persona (i.e. LO-capable) users on this instance:
`yzadmehr, yisroel, ycohen, ybochner, sweiss, sstein, skatz, skaff, simcha, pinchusw, officer,
mschwimmer, mmermelstein, mbochner, jschnitzler, jfried, ezra, ebochner, chaim, bstauber,
bengelman, aeisen`.

### Organizations

```
GET /encompass/v1/organizations        → 200
GET /encompass/v1/organizations/{id}   → 200
GET /encompass/v1/company/organizations → 403   ← the documented path is blocked
GET /encompass/v3/settings/organizations → 403
```

```json
{ "id": "82", "name": "Operations",
  "description": "For centralized operations - Processors, Underwriters, Closers, etc.",
  "numberOfChildOrganizations": 0, "numberOfChildUsers": 33,
  "orgInformation": { "useParentInformation": true, "name": "YS Capital Group",
                      "address": { "street1": "5 Ne…", "city": "Brooklyn", "state": "NY" } } }
```

Root org `0` = "Administration" with 3 child orgs.

---

### 2.6 ✅ RECOMMENDED MAPPING: Encompass user → LT staff user

**Join on `Encompass user id` (the login id), NOT on name and NOT on email.**

| Candidate key | Verdict |
|---|---|
| **`id` / `loginId` / `LoanTeamMember.UserId.*` / `Fields.LOID`** | ✅ **USE THIS.** Stable, unique, short (`sweiss`, `mkatz`, `ebochner`), present on every surface. |
| `email` | ⚠️ Secondary. Mostly unique and human-meaningful, but casing is inconsistent (`Moshe@` vs `moshe@`), 10 users share `change.me@email.com`, and two users legitimately share a mailbox family (`ezra`/`pgrunberger` → `Ezra@`/`ezra@`). Use only as a *fallback* / for onboarding matching. |
| `fullName` | ❌ **Never.** Double spaces (`"Malky  Katz"`, `"Moshe  Mermelstein"`), trailing spaces (`"Malky Katz "`), and demonstrably stale snapshots inside `/associates`. |

Suggested LT schema:

```sql
-- staff ↔ Encompass identity
lt_staff_user (
  id             uuid pk,
  email          citext unique,
  ...
  enc_user_id    text unique,      -- 'sweiss'  ← THE join key
  enc_personas   text[],           -- ['Loan Coordinator','Loan Processor']
  enc_org_id     text,             -- '82'
  enc_nmls_id    text,
  enc_enabled    boolean
);

-- per-loan assignment, one row per (loan, role)
lt_loan_assignment (
  loan_guid      uuid,
  role_id        text,             -- '1','5','6','7','8','9','10','14','0'
  role_name      text,             -- 'Loan Coordinator', ...
  enc_user_id    text,             -- from LoanTeamMember.UserId.<role>
  is_current     boolean,
  primary key (loan_guid, role_id)
);
```

Refresh recipe per loan (2 calls, both read-shaped):

1. `GET /encompass/v3/loans/{id}?entities=contacts` → LO / processor / closer + all vendors.
2. `POST /encompass/v3/loans/{id}/fieldReader` with the 9 `LoanTeamMember.UserId.<role>` ids →
   full team incl. underwriter, funder, post closer, lock desk, accounting.

Or, for a whole-pipeline refresh in ONE call: pipeline-select `Fields.LOID`, `Fields.317`,
`Fields.362`, `Fields.1855`, `Fields.984`, `Fields.LoanTeamMember.Name.Loan Processor`,
`Fields.LoanTeamMember.Name.Closer`, `Fields.LoanTeamMember.Name.Funder`,
`Fields.LoanTeamMember.Name.Post Closer`, `Fields.LoanTeamMember.Name.Underwriter`,
`CurrentLoanAssociate.FullName` (see §3).

---

## 3. Pipeline

### 3.1 v1 vs v3 — they are NOT the same contract

| | `POST /encompass/v1/loanPipeline` | `POST /encompass/v3/loanPipeline` |
|---|---|---|
| Row id key | **`loanGuid`** | **`loanId`** |
| `sortOrder[].order` | **`"asc"` / `"desc"`** (lowercase) | **`"Ascending"` / `"Descending"`** |
| single-term `filter.operator` | **allowed** | **rejected** — `"If only one filter term is supplied … 'Operator' does not apply."` |
| `start` (offset) paging | ❌ **silently ignored** — always returns page 0 | ✅ **works** |
| `loanFolders: [...]` body param | ❌ silently ignored | (not probed as effective; use a filter term) |
| `filter` required? | yes — `"Either Filter or LoanGuids should be supplied."` | yes — `"Either 'LoanIds' or filter properties like 'LoanFolders', 'Filter' or 'FieldFilters' must be supplied."` |
| `x-total-count` header | ✅ (with `cursorType=randomAccess`) | ✅ |

**→ Use v3 for anything paged. Use v1 when you want `loanGuid` naming or a single-term
`operator`.** The LT client already targets `/encompass/v3/loanPipeline` and already strips
`operator` for single-term filters — that is correct.

### 3.2 Exact working request (v3)

```
POST /encompass/v3/loanPipeline?limit=100&start=0
Authorization: Bearer <token>
Content-Type: application/json

{
  "fields": [
    "Loan.LoanNumber", "Loan.LoanFolder", "Loan.LoanAmount",
    "Loan.BorrowerName", "Loan.CoBorrowerName",
    "Loan.CurrentMilestoneName", "Fields.CoreMilestone",
    "Fields.317", "Fields.LOID", "Fields.362", "Fields.1855", "Fields.984",
    "Loan.LockStatus", "Fields.761", "Fields.762", "Loan.LockDays",
    "Loan.LastModified", "Loan.DateFileOpened"
  ],
  "filter": {
    "terms": [
      { "canonicalName": "Loan.LoanAmount", "matchType": "greaterThan", "value": 0 }
    ]
  },
  "sortOrder": [
    { "canonicalName": "Loan.LastModified", "order": "Descending" }
  ]
}
```

Multi-term filter (2+ terms **must** carry `operator`):

```json
"filter": {
  "operator": "and",
  "terms": [
    { "canonicalName": "Fields.LOID",       "matchType": "exact", "value": "sweiss" },
    { "canonicalName": "Loan.LoanFolder",   "matchType": "exact", "value": "Pipeline" }
  ]
}
```

`matchType` values confirmed working: `exact`, `greaterThan`. (`contains`, `startsWith`,
`greaterThanOrEquals`, `lessThan`, `lessThanOrEquals`, `isNotEmpty`, `equals`, `notEquals`,
`multiValue` are the documented set; only the two above were exercised.)

### 3.3 Real response (v1 shape, PII-redacted)

```json
[
  {
    "loanGuid": "c5778468-8247-4852-8c2b-7e8af4351044",
    "fields": {
      "Loan.LoanNumber": "YSCAP258134845",
      "Loan.LoanAmount": "594211.0000",
      "Loan.LoanFolder": "Pipeline",
      "Loan.CurrentMilestoneName": "Started",
      "Fields.CoreMilestone": "Started",
      "Fields.317": "Moshe  Mermelstein",
      "Fields.LOID": "mmermelstein",
      "Fields.362": "Yonah Rapapaort",
      "Loan.BorrowerName": "<REDACTED>, <REDACTED>",
      "Loan.LockStatus": "NotLocked",
      "Loan.LastModified": "8/14/2026 10:48:18 AM"
    }
  }
]
```

v3 is identical except the key is `"loanId"`.

⚠️ **Everything comes back as a STRING.** Amounts are `"594211.0000"`, dates are
US-locale `"8/14/2026 10:48:18 AM"` (v1) — parse accordingly. Empty fields come back as `""`,
and a field the tenant does not populate is often **omitted from the `fields` map entirely**
(e.g. `Fields.MS.STATUS` and `Alert.*.AlertCount` were dropped rather than returned empty).

### 3.4 Filtering by loan officer

**By login id (best):**
```json
{ "fields": ["Loan.LoanNumber","Fields.317","Fields.LOID","Loan.LoanFolder"],
  "filter": { "terms": [ {"canonicalName":"Fields.LOID","matchType":"exact","value":"sweiss"} ] } }
```
→ 200, returns only that LO's loans. **Confirmed working.**

**By display name:** `{"canonicalName":"Fields.317","matchType":"exact","value":"Solomon Weiss"}` —
works but is brittle (double spaces in stored names).

### 3.5 Filtering by loan folder

✅ **Use a filter term** — `{"canonicalName":"Loan.LoanFolder","matchType":"exact","value":"Pipeline"}`.
Confirmed: returned only `Loan.LoanFolder == "Pipeline"` rows.

❌ **The `loanFolders: ["Funded Loans"]` body property is silently IGNORED on v1** — it returned
rows from `Corr Post Purchase`. Do not rely on it.

Also available: `LoanFolder.Active` / `LoanFolder.Archive` / `LoanFolder.Trash` boolean canonicals.

### 3.6 Paging & totals

* `?limit=N` — works on both. `limit=500` returned 500 rows in one call.
* `?start=N` — **v3 only** (verified: `start=0/3/600/690` returned distinct, correctly-offset pages).
* `?cursorType=randomAccess` → response header `x-total-count`. On this tenant: **696 loans**.
* `x-cursor` header came back `null` on v3 and, on v1, the follow-up
  `GET /encompass/v1|v3/loanPipeline/{cursor}` was **403** (persona lacks the cursor resource).
  **→ Page with `v3 + limit + start`, not with cursors.**

### 3.7 Canonical fields available for a pipeline view

`GET /encompass/v1/loanPipeline/fieldDefinitions` → **200**, `{ pipelineLoanReportFieldDefs: [...] }`
with **3,159** entries. (`GET /encompass/v3/loanPipeline/fieldDefinitions` → **403**.)

Category breakdown:

| category | count | notes |
|---|---|---|
| Database | 2,968 | raw `Fields.NNN` loan fields |
| Alerts | 71 | `Alert.<Name>.AlertCount` |
| Loan | 62 | `Loan.*` + key `Fields.*` |
| Pipeline | 16 | `Loan.BorrowerName`, `Loan.LockStatus`, `Alerts.AlertCount`, `LockUser.UserName`, … |
| Loan Related Companies | 10 | title/escrow/appraisal/investor company names |
| Trade | 6 | `Loan.TradeNumber`, `Loan.InvestorStatus`, `Loan.NetProfit`, buy/sell price |
| ARM | 5 | margin, caps, first adjustment |
| Borrowers | 4 | `Fields.36/37/68/69` |
| Ratios | 4 | `Fields.353` LTV, `976` CLTV, `740` top, `742` bottom |
| Milestone | 3 | `NextMilestone.MilestoneName`, `Loan.NextMilestoneDate`, `Loan.NextMilestoneSorted` |
| Loan Folder | 3 | Active / Archive / Trash |
| LoanProperties | 3 | Attribute / Category / Value |
| Servicing | 3 | |
| Lender | 1 | `Fields.1264` |

The high-value non-`Fields.NNN` canonicals for an LOS pipeline screen:

```
Loan.LoanName                    Loan.LoanFolder                  Loan.LoanSource
Loan.BorrowerName                Loan.CoBorrowerName              Loan.CreditScore
Loan.CurrentMilestoneName        Loan.CurrentMilestoneDate        Loan.LastMilestoneSorted
NextMilestone.MilestoneName      Loan.NextMilestoneDate           Loan.NextMilestoneSorted
CurrentLoanAssociate.FullName    Loan.DateFileOpened              Loan.DateCreated
Loan.LastModified                Loan.DateCompleted               Loan.DateOfEstimatedCompletion
Loan.DateofFinalAction           Loan.LoanVersionNumber           Loan.Active / Loan.Adverse
Loan.LockStatus                  Loan.LockAndRequestStatus        Loan.LockCommitment
Loan.LockRequested               Loan.LockRequestPending          Loan.LockRequestDate
Loan.LockDays                    Loan.CommitmentExpirationDate    Loan.DownPayment
Loan.UnderWriterApprovalDate     Loan.UnderWriterSuspendedDate    Loan.UnderWriterDeniedDate
Loan.UnderWriterDifferentApprovedDate
Loan.InvestorStatus              Loan.InvestorStatusDate          Loan.TradeNumber
Loan.TotalBuyPrice               Loan.TotalSellPrice              Loan.NetProfit
Loan.TPOCompanyName / TPOBranchName / TPOLOName / TPOLPName / TPOLOID / TPOLPID
Loan.TPOSubmitDate / TPORegisterDate / TPOSiteID / TPOCompanyID / TPOBranchID / TPOArchived
LockUser.UserName                LockStatus.InUse                 Alerts.AlertCount
Messages.MessageCount            UserActivity.LastAccessTime      Loan.LinkGUID
Loan.ScheduledRemovalDate        Loan.OriginalPurgeDate           Loan.ISPaymentDue
Loan.ARMAdjustmentDate           Loan.ARMLifeCap
```

Plus 71 `Alert.<X>.AlertCount` canonicals — including
`Alert.UnderwritingConditionExpected.AlertCount`, `Alert.PreliminaryConditionExpected.AlertCount`,
`Alert.PostClosingConditionExpected.AlertCount`, `Alert.DocumentExpected.AlertCount`,
`Alert.RateLockExpired.AlertCount`, `Alert.MilestoneExpected.AlertCount`,
`Alert.eFolderUpdate.AlertCount`, `Alert.ComplianceReview.AlertCount`.

### 3.8 `/encompass/v1/loanFolders`

```
GET /encompass/v1/loanFolders   → 200  (22 folders)
```

```json
[{ "name": "(Archive)",
   "activityRules": [ {"action":"Originate","ruleValue":"Deny"},
                      {"action":"DuplicateFrom","ruleValue":"Permit"},
                      {"action":"DuplicateInto","ruleValue":"Deny"},
                      {"action":"Import","ruleValue":"Deny"} ],
   "folderType": "Archive", "isExternalOrganization": false, "loanGuid": null }, … ]
```

Full folder list (`folderType`: 1× `Archive`, 21× `Regular`; a `(Trash)` folder also appears in
loan data but is not listed):

`(Archive)`, `Adverse Loans`, `Broker CLOSED`, `Broker CLOSED RECONCILED`, `Completed Loans`,
`Corr Clear To Close`, `Corr Completed Loans`, `Corr Post Closing`, `Corr Post Purchase`,
`Employee Loans`, `Funded Loans`, `On Hold`, `Pipeline`, `Pre-Approval`, `Prospect`, `Started`,
`Submission`, `TPO CTC`, `TPO Pending`, `TPO Pipeline`, `Training`, `Withdrawn files`

Live distribution over a 500-loan sample:

| folder | loans |
|---|---|
| Corr Post Purchase | 132 |
| Pipeline | 102 |
| Broker CLOSED RECONCILED | 84 |
| Withdrawn files | 49 |
| (Trash) | 47 |
| Broker CLOSED | 45 |
| Corr Post Closing | 14 |
| Started | 14 |
| Corr Clear To Close | 6 |
| Prospect | 5 |
| On Hold | 1 |
| Pre-Approval | 1 |

**Note for the build:** the *active* working set is `Pipeline` + `Started` + `Corr Clear To Close`
(~122 loans). `Corr Post Purchase` / `Broker CLOSED*` are the closed archive. `Funded Loans`,
`Completed Loans`, `Employee Loans`, `Submission`, `Training`, `TPO *` are configured but empty.

---

## 4. Loan data model

```
GET /encompass/v3/loans/{loanId}                     → 200   (default view)
GET /encompass/v3/loans/{loanId}?entities=a,b,c      → 200   (selective)
```

The default (no `entities`) response on a real loan returned **167 top-level keys** and ~130 KB.
The full contract (from `GET /encompass/v3/schemas/loan`) has **534 root properties**:
430 scalars + **52 array entities** + **52 object entities**.

### 4.1 `?entities=` — 92 of 104 entity names are accepted

Error if none match: `400 "Supplied query parameter 'entities' does not contain any of the
supported entities."` Dotted paths (`applications.assets`) are **not** supported — sub-entities
are named flat.

**✅ Accepted (92)** — object entities:
`additionalRequests, atrqmCommon, closingCost, closingDocument, commitmentTerms,
constructionManagement, correspondent, customModelFields, disclosureNotices, downPayment,
loCompensation, emDocument, emDocumentInvestor, emDocumentLender, fannieMae, fhaVaLoan,
freddieMac, funding, gfe, hmda, hud1Es, hudLoanData, interimServicing, loanProductData,
loanSubmission, mcaw, miscellaneous, netTangibleBenefit, prequalification, privacyPolicy,
profitManagement, property, rateLock, regulationZ, section32, selectedHomeCounselingProvider,
servicingDisclosure, shipping, stateDisclosure, statementCreditDenial, tpo, tql, trustAccount,
tsum, uldd, underwriterSummary, usda, vaLoanData, collateralTracking, aiq, eClose`

…array entities:
`affiliatedBusinessArrangements, alertChangeCircumstances, applications, contacts, customFields,
fees, analyzers, forms, homeCounselingProviders, loanPrograms, propertyValuations,
specialFeatureCodes, milestones, nonBorrowingOwners, nonVols, investorDeliveryLogs,
encompassToEncompassLogs, freddieAimChecks, priceConcessions, disasters, purchaseCredits,
serviceProviderContacts, settlementServiceCharges`

…**URLA sub-entities (accepted at the top level!)**:
`assets, liabilities, reoProperties, employment, income, borrower, coborrower, residences,
otherIncomeSources, otherLiabilities, otherAssets, giftsGrants, vods, vols, additionalLoans,
selfEmployedIncome, ausTracking, tqlReports`
→ these hydrate **inside `applications[]`**, not at the loan root.

**❌ Rejected (400) — must use their own sub-resource endpoint instead:**
`underwritingConditions, preliminaryConditions, postClosingConditions, conditions, documents,
lockRequests, lockConfirms, lockDenials, rateLocks, registrationLogs, milestoneFreeRoles,
milestoneHistoryLogs, milestoneTasks, milestoneTemplateLogs, documentOrders, logEntryLogs,
conversationLogs, disclosureTrackingLogs, disclosureTracking2015Logs, complianceTestLogs,
downloadLogs, edmLogs, emailTriggerLogs, fundingFees, goodFaithFeeVarianceCureLogs,
loanActionLogs, printLogs, statusOnlineLogs, declarations, demographics, military`

### 4.2 Entity inventory — what each carries

| Entity | Kind | Live size on a real loan | Carries |
|---|---|---|---|
| `applications[]` | array | 1 (borrower pair) | The 1003. See §5. |
| `contacts[]` | array | 17 | LO/processor/closer + title/escrow/appraisal/insurance/investor/warehouse/servicer. **See §2.2.** |
| `milestones[]` | array | 12–17 | Per-loan milestone instances w/ assignee. See §8. |
| `customFields[]` | array | **103** | Tenant custom fields `{fieldName, stringValue\|numericValue\|dateValue}` |
| `forms[]` | array | 42 | Which input forms are enabled |
| `fees[]` | array | 7 | Itemized fees |
| `homeCounselingProviders[]` | array | 10 | HUD counseling list |
| `property` | obj (14) | | Subject property: address, type, units, appraised value |
| `closingCost` | obj (14) | | Closing cost detail |
| `closingDocument` | obj (12) | | Closing doc prep |
| `rateLock` | obj (**51**) | | **Lock request payload — see §7** |
| `regulationZ` | obj (42) | | TILA / APR / finance charge |
| `hmda` | obj (32) | | HMDA reporting (loan level) |
| `fhaVaLoan` | obj (34) | | FHA/VA |
| `privacyPolicy` | obj (38) | | GLBA |
| `loanProductData` | obj (31) | | Product/amort/ARM detail |
| `uldd` | obj (21) | | GSE ULDD delivery |
| `correspondent` | obj (17) | | Correspondent purchase data |
| `vaLoanData` | obj (16) | | |
| `prequalification` | obj (16) | | |
| `miscellaneous` | obj (14) | | |
| `gfe` | obj (13) | | Legacy GFE |
| `hud1Es` | obj (11) | | HUD-1 estimated settlement |
| `mcaw` | obj (11) | | Mortgage Credit Analysis Worksheet |
| `hudLoanData` | obj (12) | | |
| `tql` | obj (12) | | **Fraud/compliance scores**: `tqlFraudAlertsTotal{,High,Medium,Low}`, `…Unaddressed`, `driveScore`, `driveIdVerifyScore`, `driveAppVerifyScore`, `drivePropertyVerifyScore`, `lomaOrLomrIndicator` |
| `freddieMac` / `fannieMae` | obj (7/3) | | AUS keys |
| `section32`, `netTangibleBenefit`, `commitmentTerms`, `loanSubmission`, `shipping`, `stateDisclosure`, `statementCreditDenial`, `servicingDisclosure`, `interimServicing`, `downPayment`, `loCompensation`, `constructionManagement`, `tpo` | obj | small | |
| `funding`, `trustAccount`, `tsum`, `underwriterSummary`, `profitManagement`, `disclosureNotices`, `additionalRequests`, `customModelFields`, `emDocument*`, `collateralTracking`, `aiq`, `eClose`, `selectedHomeCounselingProvider` | obj | **empty `{}`** on live loans | not used by this tenant |

Notable **loan-root scalars** for an LOS list/detail view:

```
id  loanNumber  loanCreationDate  originationDate  maturityDate  loanProgramName
loanAmortizationType  loanAmortizationTermMonths  mortgageType  occupancyType  channel
lenderChannel  loanSource  baseLoanAmount  borrowerRequestedLoanAmount  purchasePriceAmount
propertyAppraisedValueAmount  ltv  combinedLtv  tltv  bltv  hcltvHtltv  ltvPropertyValue
downPaymentPercent  initialInterestRate  requestedInterestRatePercent
principalAndInterestMonthlyPaymentAmount  proposedHousingExpenseTotal
totalClosingCostsAmount  estimatedClosingCostsAmount  cashFromToBorrowerAmount
milestoneCurrentName  milestoneNextName  milestoneCurrentDate  milestoneStage
milestoneFileStartedDate  milestoneCompletedDueDate  milestoneSubmittedDueDate
interviewerName  interviewersId  interviewerEmail  interviewerPhoneNumber
originatorFirstName  originatorLastName  nmlsLoanOriginatorId  organizationCode
mersNumber  mersOrgId  mom  urlaLoanIdentifier  archived  encompassVersion
useEnhancedConditionIndicator  useNew2015FormsIndicator  borrowerPairCount  borrowerCount
uspsValidatedStreetAddress / City / State / Zip  uspsAddressValidationIndicator  msaName
```

---

## 5. URLA / 1003

### 5.1 How to fetch it

```
GET /encompass/v3/loans/{loanId}?entities=applications,borrower,coborrower,employment,income,
    assets,liabilities,reoProperties,residences,otherIncomeSources,otherLiabilities,
    otherAssets,giftsGrants,vods,vols,additionalLoans,selfEmployedIncome,ausTracking,
    tqlReports,property,hmda,uldd,nonBorrowingOwners
```

Everything hydrates under `applications[]`. **One call gets you the whole 1003.**

### 5.2 Structure

```
loan
├── property                      ← subject property (URLA §4)
├── hmda                          ← loan-level HMDA
├── nonBorrowingOwners[]          ← non-borrowing title holders
└── applications[]                ← ONE PER BORROWER PAIR  (238 props on the contract)
    ├── id, legacyId ("_borrower1"), borrowerPairId
    ├── borrower    → BorrowerContract   (592 properties)
    ├── coborrower  → BorrowerContract   (592 properties)
    ├── assets[]                  ← URLA §2a  (AssetContract, 44 props)
    ├── vods[]                    ← Verification-of-Deposit rows (asset detail)
    ├── otherAssets[]             ← URLA §2c  (EarnestMoney, ProceedsFromSale, …)
    ├── giftsGrants[]             ← URLA §4d  gifts/grants
    ├── liabilities[]             ← URLA §2c  (LiabilityContract, 72 props)
    ├── vols[]                    ← Verification-of-Loan rows (liability detail) ← MOST POPULATED
    ├── otherLiabilities[]        ← alimony/child support/job expenses
    ├── reoProperties[]           ← URLA §3   (ReoPropertyContract, 52 props)
    ├── additionalLoans[]         ← URLA §4b  other new mortgage loans
    ├── income[]                  ← URLA §1b/1e other income (IncomeContract, 7 props)
    ├── otherIncomeSources[]      ← URLA §1e
    ├── selfEmployedIncome[]      ← URLA §1b self-employment
    ├── fannieIncomeCalculators[] ← income calc worksheets
    ├── tax4506 / tax4506s[] / tax4506T / tax4506Ts[]
    ├── atrqmBorrower             ← ATR/QM per-borrower
    ├── ausTracking + ausTrackingLogs[]  ← DU/LPA runs
    ├── tqlReports[]              ← fraud/compliance report refs
    ├── repWarrantTrackers[]      ← rep & warrant relief
    ├── providedDocuments[]
    └── loanOfficer               ← EntityReferenceContract
        (+ ~212 computed scalars: totals, ratios, credit-bureau blocks)

    borrower / coborrower (BorrowerContract)
    ├── employment[]              ← URLA §1b/1c/1d  (EmploymentContract, 79 props)
    ├── residences[]              ← URLA §1a addresses (ResidenceContract, 42–46 props)
    ├── creditReports[]
    ├── urlaAlternateNames[]      ← URLA §1a alternate names
    ├── contactRef                ← EntityReferenceContract → contact record
    ├── mailingAddress            ← MailingAddressContract
    └── ~586 scalars grouped below
```

### 5.3 URLA section → API path map (build this screen from this table)

| URLA 2020 section | Path | Notes |
|---|---|---|
| **§1a Personal Information** | `applications[].borrower.{firstName, middleName, lastName, suffix, fullName, birthDate, taxIdentificationIdentifier, emailAddressText, homePhoneNumber, maritalStatusType, domesticRelationshipType, dependentCount, dependentsAgesDescription, citizenshipResidencyType, urla2020CitizenshipResidencyType, urla2020CountryOfCitizenship, applicantType, borrowerType, jointAssetLiabilityReportingIndicator1}` | `taxIdentificationIdentifier` = **SSN — redact** |
| §1a alternate names | `borrower.urlaAlternateNames[]`, `borrower.urlaAliasName` | |
| §1a current/former address | `borrower.residences[]` → `{residencyType, residencyBasisType, addressStreetLine1, addressCity, addressState, addressPostalCode, addressCounty, addressUnitDesignatorType, addressUnitIdentifier, countryCode, durationTermYears, durationTermMonths, rent, urla2020StreetAddress, foreignAddressIndicator}` | `residencyType` = Current / Prior / Mailing |
| §1a mailing address | `borrower.mailingAddress` | |
| **§1b Current Employment** | `borrower.employment[]` where `currentEmploymentIndicator = true` → `{employerName, positionDescription, addressStreetLine1/City/State/PostalCode, phoneNumber, startDate, employmentStartDate, timeOnJobTermYears/Months, timeInLineOfWorkYears, selfEmployedIndicator, businessOwnedPercent, ownershipInterestType, specialEmployerRelationshipIndicator, monthlyIncomeAmount, employmentMonthlyIncomeAmount, basePayAmount, overtimeAmount, bonusAmount, commissionsAmount, otherAmount, militaryEntitlement, badgeOrEmployeeID, owner}` | 79 props |
| §1c Additional Employment | same array, `currentEmploymentIndicator = true`, index > 0 | |
| §1d Previous Employment | same array, `currentEmploymentIndicator = false` + `endDate` | |
| §1e Income from Other Sources | `applications[].income[]` → `{incomeType, owner, amount, description, currentIndicator, otherIncomeIndex}` and `applications[].otherIncomeSources[]` | live sample: `{"incomeType":"NetRentalIncome","owner":"Borrower","amount":298.72}` |
| §1b self-employment | `applications[].selfEmployedIncome[]` | |
| **§2a Assets — Bank Accounts** | `applications[].assets[]` / `vods[]` → `{assetType, accountIdentifier, depositoryAccountName, cashOrMarketValueAmount, urla2020CashOrMarketValueAmount, holderName, holderAddress*, owner, nameInAccount, sourceOfAssetData}` | |
| **§2b Other Assets & Credits** | `applications[].otherAssets[]` → `{assetType, cashOrMarketValue}`; live: `{"assetType":"EarnestMoney","cashOrMarketValue":65000}` | |
| **§2c Liabilities** | `applications[].liabilities[]` / **`vols[]`** → `{liabilityType, accountIdentifier, holderName, holderAddress*, nameInAccount, monthlyPaymentAmount, unpaidBalanceAmount, remainingTermMonths, creditLimit, owner, toBePaidOffAmount, exclusionIndicator, payoffStatusIndicator, currentLienPosition, proposedLienPosition, mortgageType, subjectPropertyIndicator, reoProperty:{entityId,entityType}}` | **`vols[]` is where the credit-report tradelines actually live on this tenant** (7–38 rows/loan) |
| §2d Other Liabilities & Expenses | `applications[].otherLiabilities[]` | |
| **§3 Real Estate Owned** | `applications[].reoProperties[]` → `{streetAddress, urla2020StreetAddress, city, state, postalCode, countryCode, propertyUsageType, futurePropertyUsageType, numberOfUnits, marketValueAmount, lienUpbAmount, lienInstallmentAmount, maintenanceExpenseAmount, rentalIncomeNetAmount, subjectIndicator, owner, includeInAusExport, sourceOfIncomeData}` | 52 props |
| **§4a Loan & Property Information** | loan root + `loan.property` | |
| §4b Other New Mortgage Loans | `applications[].additionalLoans[]` | |
| §4c Rental Income on subject | `reoProperties[]` where `subjectIndicator = true` | |
| §4d Gifts or Grants | `applications[].giftsGrants[]` → `{assetType, owner, amtAppliedToDownPayment, importSource}`; live: `{"assetType":"GiftOfCash","amtAppliedToDownPayment":300000}` | |
| **§5a Declarations — About this Property** | `borrower.{intentToOccupyIndicator, priorPropertyUsageType, priorPropertyTitleType, specialBorrowerSellerRelationshipIndicator, undisclosedBorrowedFundsIndicator, undisclosedBorrowedFundsAmount, undisclosedMortgageApplicationIndicator, undisclosedCreditApplicationIndicator, propertyProposedCleanEnergyLienIndicator}` | |
| **§5b Declarations — About Your Finances** | `borrower.{coMakerEndorserOfNoteIndicator, undisclosedComakerOfNoteIndicator, outstandingJudgementsIndicator, presentlyDelinquentIndicator, presentlyDelinquentIndicatorUrla, partyToLawsuitIndicator, partyToLawsuitIndicatorUrla, priorPropertyDeedInLieuConveyedIndicator, priorPropertyShortSaleCompletedIndicator, priorPropertyForeclosureCompletedIndicator, propertyForeclosedPastSevenYearsIndicator, bankruptcyIndicator, bankruptcyIndicatorChapterSeven/Eleven/Twelve/Thirteen, bankruptcyDate, bankruptcyStatus, foreclosureDate, foreclosureStatus, foreclosureSatisfied, alimonyChildSupportObligationIndicator, borrowedDownPaymentIndicator, declarationsJIndicator, declarationsKIndicator}` | **40 declaration fields** |
| **§7 Military Service** | `borrower.{selfDeclaredMilitaryServiceIndicator, activeDuty, veteran, veteranIndicator, militaryServiceExpectedCompletionDate}` + entity_type `MilitaryService` `{MilitaryServiceIndex, SSN, ServiceNumber, Branch, StartDate, EndDate, Name, OfficerOrEnlisted}` | ⚠️ `entities=military` is **rejected**; the flags live on `borrower` |
| **§8 Demographic Information** | `borrower.hmda*` — **62 fields**: `hmdaEthnicityType`, `hmdaEthnicityHispanicLatinoIndicator`, `hmdaEthnicityNotHispanicLatinoIndicator`, `hmdaEthnicityDoNotWishIndicator`, `hmdaMexicanIndicator`, `hmdaPuertoRicanIndicator`, `hmdaCubanIndicator`, `hmdaHispanicLatinoOtherOriginIndicator`, `hmdaOtherHispanicLatinoOrigin`, `hmdaRaceReportedField1..5`, `hmdaAmericanIndianIndicator` + `hmdaAmericanIndianTribe`, `hmdaAsianIndicator` + `hmdaAsianIndianIndicator/hmdaChineseIndicator/hmdaFilipinoIndicator/hmdaJapaneseIndicator/hmdaKoreanIndicator/hmdaVietnameseIndicator/hmdaAsianOtherRaceIndicator/hmdaOtherAsianRace`, `hmdaAfricanAmericanIndicator`, `hmdaPacificIslanderIndicator` + `hmdaNativeHawaiianIndicator/hmdaGuamanianOrChamorroIndicator/hmdaSamoanIndicator/hmdaPacificIslanderOtherIndicator/hmdaOtherPacificIslanderRace`, `hmdaWhiteIndicator`, `hmdaGenderType` + `hmdaGendertypeMale/Female/DoNotWish/NotApplicableIndicator`, `hmdaRaceInfoNotProvided`, `hmdaSexInfoNotProvided`, `hmdaEthnicityInfoNotProvided`, `hmdaRefusalIndicator`, `hmdaAge`, `hmdaCreditScoreForDecisionMaking`, `hmdaCreditScoringModel` | ⚠️ `entities=demographics` is **rejected**; these are borrower scalars |
| **§9 Loan Originator Information** | loan root `{originatorFirstName, originatorLastName, nmlsLoanOriginatorId, organizationCode, originatorAddressLineText, originatorAddressUnitIdentifier, interviewerName, interviewersId, interviewerEmail, interviewerPhoneNumber}` + `applications[].loanOfficer` | |
| Homeownership education / counseling | `borrower.{ownershipEducationConfirmationIndicator, ownershipEducationFormatType, ownershipEducationAgencyName, ownershipEducationCompletionDate, ownershipEducationPartyRoleIdentifier, coBorrAttendedSameCounselingIndicator, counselingFormat, counselType}` (16 fields) | |
| Credit scores | `borrower.{equifaxScore, experianCreditScore, transUnionScore, middleCreditScore, middleFicoScore}` + `applications[].{equifax*, experian*, transUnion*}` bureau contact blocks + `borrower.{equifax30/60/90/120/150Days, *FactorCode1..5, *KeyFactor1..5, *DatePulled}` | |

### 5.4 Real sample rows (PII-redacted)

```jsonc
// applications[0].income[0]
{ "incomeType": "NetRentalIncome", "owner": "Borrower", "amount": 298.72 }

// applications[0].reoProperties[0]
{ "id": "e301032d-…", "altId": "3c5d9846-…",
  "streetAddress": "<REDACTED>", "urla2020StreetAddress": "<REDACTED>",
  "city": "NEWARK", "state": "NJ", "postalCode": "<REDACTED>", "countryCode": "US",
  "propertyUsageType": "Investor", "futurePropertyUsageType": "Investment",
  "numberOfUnits": 2, "subjectIndicator": true,
  "marketValueAmount": 725000, "lienUpbAmount": 393000, "lienInstallmentAmount": 4037.33,
  "maintenanceExpenseAmount": "591", "rentalIncomeNetAmount": -4628.33,
  "owner": "Borrower", "includeInAusExport": true, "sourceOfIncomeData": "Encompass",
  "requestDate": "2026-08-04" }

// applications[0].vols[0]   ← liability / tradeline
{ "id": "93503757-…", "altId": "dd287936-…",
  "accountIdentifier": "<REDACTED>", "nameInAccount": "<REDACTED>",
  "holderName": "OCEANFIR/DMI", "holderAddressStreetLine1": "1 CORPORATE DR",
  "holderAddressCity": "LAKE ZURICH", "holderAddressState": "IL",
  "holderAddressPostalCode": "60047",
  "liabilityType": "MortgageLoan", "monthlyPaymentAmount": 6529,
  "unpaidBalanceAmount": 750451, "remainingTermMonths": 339,
  "creditLimit": 0, "payoffIncludedIndicator": false, "owner": "Borrower",
  "reoProperty": { "entityId": "f77a3e50-…", "entityType": "ReoProperty" } }

// applications[0].otherAssets[0]
{ "id": "626bad04-…", "assetType": "EarnestMoney", "cashOrMarketValue": 65000 }

// applications[0].giftsGrants[0]
{ "id": "d8c30e97-…", "assetType": "GiftOfCash", "owner": "Borrower",
  "amtAppliedToDownPayment": 300000, "importSource": "Encompass" }

// applications[0].borrower.residences[0]
{ "id": "…", "residencyType": "Current", "residencyBasisType": "…",
  "addressStreetLine1": "<REDACTED>", "urla2020StreetAddress": "<REDACTED>",
  "addressCity": "…", "addressState": "…", "addressPostalCode": "<REDACTED>",
  "addressCounty": "…", "countryCode": "US", "country": "US",
  "durationTermYears": 5, "durationTermMonths": 3, "rent": 0 }
```

### 5.5 Data-shape realities on THIS tenant

* `applications[]` length is **1** on every loan sampled (single borrower pair). Build for N
  anyway — `borrowerPairCount` / `currentApplicationIndex` exist on the loan root.
* `coborrower` is present but **sparse** (7–43 populated props) — most loans have no co-borrower.
* **`vols[]` is the workhorse** for liabilities (7–38 rows/loan); the modern `liabilities[]` array
  was empty on every loan sampled. Same story for assets: `vods[]`/`otherAssets[]` over `assets[]`.
* `income[]` is usually a **single** `NetRentalIncome` row — these are DSCR / investor loans, so
  §1b employment is thin (`borrower.employment[]` populated on only 2 of 25 loans sampled).
* Empty arrays are **omitted** from the response, not returned as `[]`.

---

## 6. Conditions

### 6.1 What is reachable

| Endpoint | Status | Result |
|---|---|---|
| `GET /encompass/v1/loans/{id}/underwritingConditions` | **200** | `[]` on every loan tested |
| `GET /encompass/v1/loans/{id}/underwritingConditions?includeArchive=true` | **200** | `[]` |
| `GET /encompass/v1/loans/{id}/conditions/underwriting` | **200** | `[]` |
| `GET /encompass/v1/loans/{id}/conditions/preliminary` | **200** | `[]` |
| `GET /encompass/v1/loans/{id}/conditions/postclosing` | **200** | `[]` |
| `GET /encompass/v3/loans/{id}/conditions` | **200** | `[]` |
| `GET /encompass/v3/loans/{id}/underwritingConditions` | **403** | persona |
| `GET /encompass/v1/loans/{id}/preliminaryConditions` | **403** | persona |
| `GET /encompass/v1/loans/{id}/postClosingConditions` | **403** | persona |
| `GET /encompass/v1/loans/{id}/enhancedConditions` (+v3) | **403** | persona |
| `GET /encompass/v3/loans/{id}/conditions/underwriting` | **404** | wrong shape on v3 |
| `GET /encompass/v1/loans/{id}/conditions` | **404** | must specify a type |
| condition **templates/sets** — `/settings/conditions/templates`, `/settings/enhancedConditions/templates`, `/settings/enhancedConditions/types`, `/settings/conditionTemplates`, `/settings/templates/underwritingConditionSets`, `/settings/loan/conditionTemplates` | **403** | persona (all of them) |
| `GET /encompass/v1/loans/{id}/tasks`, `/taskGroups`, `/settings/taskGroups` | **403** | persona |

### 6.2 ⚠️ The headline finding: **this tenant does not use Encompass conditions**

* `loan.useEnhancedConditionIndicator = true` (enhanced conditions feature is ON).
* But **every** condition endpoint returns an **empty array** — tested across loans in
  `Submittal`, `Cond. Approval`, `Resubmittal`, `Docs Out`, `Funding`, `Purchasing Conditions`.
* Cross-check via pipeline alerts over **200 loans**:
  `Alert.UnderwritingConditionExpected.AlertCount` = **0 loans**,
  `Alert.PreliminaryConditionExpected.AlertCount` = **0**,
  `Alert.PostClosingConditionExpected.AlertCount` = **0**,
  `Alert.DocumentExpected.AlertCount` = **0**
  (while `Alerts.AlertCount > 0` on **57 of 200** loans — so alerts *do* fire, just never for
  conditions).

**Conclusion: condition tracking on this instance happens in the eFolder as DOCUMENTS, not as
Encompass conditions.** A mature loan carried **101 documents** with document groups
`Needs List - Initial`, `Credit`, `Income`, `Property`, `Analyzer Docs` and statuses
`received` (98), `expired!` (2), `ordered` (1).

### 6.3 eFolder documents — the de-facto conditions model

```
GET /encompass/v1/loans/{loanId}/documents      → 200
GET /encompass/v3/loans/{loanId}/documents      → 200   (richer, entity-reference style)
GET /encompass/v1/loans/{loanId}/attachments    → 200
```

v1 shape (real, trimmed):

```json
{
  "documentId": "92003e13-…",
  "title": "Appraisal", "titleWithIndex": "Appraisal", "description": "Appraisal",
  "applicationId": "All", "applicationName": "All ",
  "milestoneId": "LO Prep",
  "status": "received", "statusDate": "2026-04-03T19:05:02Z",
  "isRequested": true,  "dateRequested": "2026-03-25T19:56:56Z", "requestedBy": "mschwimmer",
  "isReceived": true,   "dateReceived":  "2026-04-03T19:05:02Z", "receivedBy": "<partnerconnect>",
  "dateCreated": "2026-03-25T19:56:56Z", "createdBy": "mschwimmer",
  "daysDue": 0, "daysTillExpire": 0,
  "requestedFrom": "Class Valuations - Appraisal",
  "webCenterAllowed": true, "tpoAllowed": true, "thirdPartyAllowed": true,
  "isProtected": false, "isSettlementServicesDocument": true,
  "docGroups": ["Analyzer Docs", "Property"],
  "comments": [],
  "attachments": [
    { "isActive": true, "entityId": "07543a9c-…", "entityType": "attachment",
      "entityName": "11174905.pdf",
      "entityUri": "/v1/loans/{loanId}/attachments/07543a9c-…" }
  ]
}
```

v3 shape (real, trimmed) — **use this one**, it gives entity refs instead of bare strings:

```json
{
  "id": "92003e13-…",
  "title": "Appraisal", "description": "Appraisal",
  "documentStatus": "Received", "statusDate": "2026-04-03T19:05:02Z",
  "isMarkedRemoved": false, "isProtected": false,
  "createdDate": "2026-03-25T19:56:56Z",
  "createdBy":   { "entityId": "mschwimmer", "entityType": "User" },
  "requestedDate": "2026-03-25T19:56:56Z",
  "requestedBy": { "entityId": "mschwimmer", "entityType": "User" },
  "receivedDate": "2026-04-03T19:05:02Z",
  "receivedBy":  { "entityId": "<partnerconnect>", "entityType": "User" },
  "updatedDate": "2026-04-23T14:14:58Z",
  "accessedDate": "2026-04-30T20:36:05Z",
  "accessedBy":  { "entityId": "mschwimmer", "entityType": "User" },
  "lastAttachmentDate": "2026-04-23T14:14:58Z",
  "application": { "entityId": "All", "entityName": "All", "entityType": "Application",
                   "legacyId": "All" },
  "milestone":   { "entityId": "40c02339-…", "entityName": "LO Prep",
                   "entityType": "Milestone" },
  "documentGroups": ["Analyzer Docs", "Property"],
  "roles": [
    { "entityId": "1", "entityName": "Loan Coordinator", "entityType": "Role", "roleAbbr": "LC" },
    { "entityId": "4", "entityType": "Role" },
    { "entityId": "5", "entityName": "Loan Processor",   "entityType": "Role", "roleAbbr": "LP" }
  ]
}
```

**Document status vocabulary observed:** `Received` / `received`, `expired!`, `ordered`.
The status/history model you asked about (`status`, `appliedDate`, `dateExpected`, `priorTo`,
`category`, `owner`, `comments`) maps here to
`documentStatus` / `statusDate` / `requestedDate` / `receivedDate` / `daysDue` /
`daysTillExpire` / `documentGroups` / `roles` / `milestone` / `comments[]`.

### 6.4 What to ask ICE / the Encompass admin for

To build a real conditions module you need **one** of:

1. Confirmation that the tenant genuinely tracks conditions as eFolder documents (then build
   against `/documents` v3 — everything needed is already readable), **or**
2. Persona access to the condition surfaces that currently 403:
   `preliminaryConditions`, `postClosingConditions`, `enhancedConditions`, `v3 underwritingConditions`,
   and the company-level `settings/*conditionTemplates*` / `settings/enhancedConditions/*` /
   `settings/taskGroups` endpoints.

---

## 7. Pricing & lock

### 7.1 Everything lock-*specific* is 403

| Endpoint | Status |
|---|---|
| `GET /encompass/v1/loans/{id}/lockRequests` | **403** |
| `GET /encompass/v3/loans/{id}/lockRequests` | **403** |
| `GET /encompass/v1/loans/{id}/rateLocks` | **403** |
| `GET /encompass/v1/loans/{id}/lockConfirms` | **403** |
| `GET /encompass/v1/loans/{id}/registrationLogs` | **403** |
| `GET /encompass/v1/loans/{id}/secondaryRegistration` | **403** |
| `GET /encompass/v1|v3/secondaryRegistration/loans/{id}/lockRequests` | **403** |
| `GET /encompass/v1/loans/{id}/productPricing` | **403** |
| `GET /encompass/v1/loanPricing/loans/{id}` | **403** |
| `GET /encompass/v1/epps/loans/{id}` | **403** |
| `GET /encompass/v1|v3/settings/lockDeskSettings`, `/settings/lockPolicy` | **403** |
| `GET /encompass/v1|v3/settings/investors`, `/settings/pricing/investors` | **403** |
| `?entities=lockRequests|rateLocks|lockConfirms|lockDenials|registrationLogs` | **400** (not a valid entities value) |

No EPPS / Encompass Product & Pricing Service endpoint responded on this instance/persona.

### 7.2 What IS readable today

**A. The `rateLock` entity on the loan** — `GET /encompass/v3/loans/{id}?entities=rateLock` → 200.
This is the *lock request payload* (51 keys), not the lock history:

```json
{
  "requestType": "…", "requestLockType": "…", "rateRequestStatus": "…", "rateStatus": "…",
  "requestPending": false, "isCancelled": false,
  "extensionRequestPending": false, "cancellationRequestPending": false,
  "reLockRequestPending": false, "daysToExtend": 0,
  "lockRequestLoanPurposeType": "Purchase",
  "loanProgram": "Fix & Flip Purchase + reno",
  "loanDocumentationType": "Fix & Flip",
  "loanAmortizationType": "Fixed", "loanAmortizationTermMonths": 12,
  "balloonLoanMaturityTermMonths": 12,
  "mortgageType": "Conventional", "lienPriorityType": "FirstLien",
  "propertyUsageType": "Investor", "gsePropertyType": "…",
  "baseLoanAmount": 594211, "borrowerRequestedLoanAmount": 594211,
  "purchasePriceAmount": 500000,
  "propertyAppraisedValueAmount": 570000, "propertyEstimatedValueAmount": …,
  "ltv": 118.842, "combinedLtv": 118.842, "hcltvHtltv": 118.842,
  "financedNumberOfUnits": 1, "helocCreditLimit": 0,
  "firstSubordinateAmount": 594211,
  "loanScheduledClosingDate": "2026-08-20",
  "subjectPropertyStreetAddress": "<REDACTED>", "subjectPropertyCity": "<REDACTED>",
  "subjectPropertyCounty": "<REDACTED>", "subjectPropertyState": "SC",
  "subjectPropertyPostalCode": "<REDACTED>",
  "requestPrepayPenalty": "N", "borrLenderPaid": "…",
  "amountDue": 594211, "amountDueTo": "Lender", "amountPaidTo": "Lender",
  "expectedAmountReceived": 594211, "expectedPrinciple": 594211,
  "diffAmountReceived": -594211, "diffPrinciple": -594211, "reconciledDiff": 594211,
  "currentAcquisition": true, "fhaSecondaryResidence": false,
  "correspondentWarehouseBankId": "…",
  "correspondentPaymentHistoryFirstBorrowerPaymentDueDate": "…",
  "correspondentRetainUserInputs": …,
  "lockRequestBorrowers": [
    { "lrbIndex": 1, "firstName": "<REDACTED>", "lastName": "<REDACTED>",
      "ssn": "<REDACTED>", "equifaxScore": "756", "experianScore": "762",
      "transUnionScore": "760" }
  ]
}
```

**B. Lock status + dates via pipeline canonicals** (all confirmed live):

| Canonical | Meaning | Live sample |
|---|---|---|
| `Loan.LockStatus` | `Locked` / `NotLocked` | `"Locked"` |
| `Loan.LockAndRequestStatus` | combined | `"Locked-NoRequest"` |
| `Loan.LockCommitment` | | `"Floating"` |
| `Loan.LockRequested` / `Loan.LockRequestPending` / `Loan.LockRequestDate` | active/pending request | |
| `Loan.LockDays` | days until lock expires | `"30"` |
| `Loan.CommitmentExpirationDate` | | |
| `Alert.RateLockExpired/Requested/Denied/Cancelled/Confirm/Voided.AlertCount` | lock alerts | |

**C. Lock FIELD IDs** (read via `fieldReader` or pipeline `Fields.NNN`):

| Field | Meaning | Live sample |
|---|---|---|
| **`761`** | **Lock date** | `"04/23/2026"` / `"8/12/2026 12:00:00 AM"` |
| **`762`** | **Lock expiration date** | `"05/22/2026"` / `"9/11/2026 12:00:00 AM"` |
| `2148` | *(lock-related; empty on every loan sampled on this tenant)* | `""` |
| `2149` | *(empty / `"//"`)* | `"//"` |
| `1959` | *(empty)* | `""` |
| `3252` | *(empty)* | `""` |
| `4788` | Rate Lock Validation Status | |
| `3` | Note rate | `"6.875"` |
| `689` / `697` / `1699` | ARM margin / first cap / floor | |
| `1401` | Loan program | `"Investor DSCR 30 YEAR FRM"` |
| `VEND.X263` | Investor name | `"Deephaven Mortgage LLC"` |
| `Loan.TotalBuyPrice` / `Loan.TotalSellPrice` / `Loan.NetProfit` / `Loan.TradeNumber` / `Loan.InvestorStatus` | **buy side / sell side** (Trade category canonicals) | |

⚠️ **Field 2148 is empty on this tenant** even on locked loans — `761`/`762` are the fields
actually populated. Do not build against 2148.

**Live locked-loan sample (pipeline):**

```json
{ "loanGuid": "e23a6f43-…",
  "fields": { "Loan.LoanNumber": "YSCAP258134741", "Loan.LockStatus": "Locked",
              "Fields.761": "8/12/2026 12:00:00 AM", "Fields.762": "9/11/2026 12:00:00 AM",
              "Loan.LockAndRequestStatus": "Locked-NoRequest",
              "Loan.LockCommitment": "Floating", "Loan.LockDays": "30" } }
```

25 of the most-recently-modified loans are `Locked`.

### 7.3 READ today vs. needs a WRITE

| Capability | Today |
|---|---|
| Show lock status, lock date, expiration, days-to-expiry | ✅ READ (pipeline canonicals + fields 761/762) |
| Show the lock *request* terms (program, amort, LTV, scores, property) | ✅ READ (`?entities=rateLock`) |
| Show buy-side / sell-side / trade / investor status | ✅ READ (Trade canonicals + `VEND.X263`) |
| Show lock **history** (confirms, denials, extensions, re-locks, registration log) | ❌ 403 — needs persona grant |
| Run pricing / get an EPPS rate sheet | ❌ 403 — needs an EPPS-entitled persona **and** would be a WRITE (`POST` a pricing request) |
| **Request / extend / cancel a lock** | ❌ **WRITE — out of scope under the read-only rule.** Would require `POST /encompass/v1/loans/{id}/lockRequests` + explicit owner sign-off. |

---

## 8. Milestones

### 8.1 Per-loan milestones

```
GET /encompass/v1/loans/{loanId}/milestones   → 200
GET /encompass/v3/loans/{loanId}/milestones   → 200   ← richer, use this
```

**v1 shape:**
```json
{ "id": "e7597e3f-…", "milestoneIdString": "1", "milestoneName": "Started",
  "startDate": "2026-08-14T04:02:03.000Z",
  "expectedDays": 1, "actualDays": 41,
  "doneIndicator": true, "reviewedIndicator": true, "roleRequired": true,
  "loanAssociate": { "loanAssociateType": "User", "id": "admin", "name": "ADMIN Admin",
                     "phone": "…", "cellPhone": "…", "email": "…",
                     "roleName": "File Starter", "roleId": "0" } }
```

**v3 shape (recommended):**
```json
{ "id": "e7597e3f-…", "name": "Started",
  "milestoneSetting": { "entityId": "1", "entityType": "MilestoneSetting" },
  "startDate": "2026-08-14T04:02:03Z", "days": 1, "duration": -1,
  "doneIndicator": true, "reviewedIndicator": true, "roleRequired": "N",
  "loanAssociate": {
    "loanAssociateType": "User",
    "user": { "entityId": "mschwimmer", "entityName": "Mendel Schwimmer", "entityType": "User" },
    "role": { "entityId": "1", "entityName": "Loan Coordinator", "entityType": "Role" },
    "email": "Mendel@yscapgroup.com", "phone": "…", "cellPhone": "…",
    "writeAccess": false } }
```

v3 splits `user.entityId` from `entityName`, which is exactly what you need for the staff join
(and it exposes the same stale-name-vs-id quirk noted in §2.3 — trust `entityId`).

Real 17-milestone trace on a funded loan (`4b18ec64-…`, PII-free):

```
Started               mschwimmer  Mendel Schwimmer   0:File Starter      done 2026-03-25
LO Prep               mschwimmer  Mendel Schwimmer   1:Loan Coordinator  done 2026-05-05
Loan Setup            mschwimmer  Mendel Schwimmer   1:Loan Coordinator  done 2026-05-05
Submittal             mschwimmer  Malky Katz  ⚠️stale  5:Loan Processor   done 2026-05-05
Cond. Approval        —           —                  5:Loan Processor    done 2026-05-05
Waiting for Docs      —           —                  5:Loan Processor    done 2026-05-05
Processing            —           —                  5:Loan Processor    done 2026-05-05
Resubmittal           mschwimmer  Malky Katz         5:Loan Processor    done 2026-05-05
Clear To Close        mschwimmer  Malky Katz         5:Loan Processor    done 2026-05-05
Schedule Closing      mschwimmer  Mendel Schwimmer   1:Loan Coordinator  done 2026-05-05
Ready for Docs        mkatz       Malky  Katz        7:Closer            done 2026-05-05
Docs Out              mkatz       Malky  Katz        7:Closer            done 2026-05-05
Funding               mkatz       Malky  Katz        8:Funder            done 2026-05-06
Investor Delivery     mkatz       Malky  Katz        9:Post Closer       done 2026-05-06
Purchasing Conditions mkatz       Malky  Katz        9:Post Closer       done 2026-06-02
Final Docs            —           —                  9:Post Closer       OPEN 2026-06-02
Completion            —           —                  9:Post Closer       OPEN 2026-07-02
```

### 8.2 `milestoneFreeRoles`

```
GET /encompass/v1/loans/{loanId}/milestoneFreeRoles   → 200
GET /encompass/v3/loans/{loanId}/milestoneFreeRoles   → 200
GET /encompass/v1/loans/{loanId}/roleFreeMilestones   → 403
```

Roles assignable to the loan that are **not** tied to a milestone:

```json
// v1
[ { "id": "f847e85f-…", "loanAssociate": { "roleName": "Lock Desk", "roleId": "10" } },
  { "id": "8f71c213-…", "loanAssociate": { "roleName": "Accounting", "roleId": "14" } },
  { "id": "4fd3b549-…", "loanAssociate": { "roleName": "TPO Loan Coordinator", "roleId": "21" } }, … ]

// v3
[ { "id": "f847e85f-…", "loanAssociate": {
      "role": { "entityId": "10", "entityName": "Lock Desk", "entityType": "Role" },
      "writeAccess": false } }, … ]
```

### 8.3 Company-level milestone settings

```
GET /encompass/v3/settings/milestones?limit=100   → 200   (19 — ⚠️ DEFAULT LIMIT IS 10, always pass limit)
GET /encompass/v3/settings/milestones/{id}        → 200   (full detail incl. role + days)
GET /encompass/v1/settings/milestones             → 403
GET /encompass/v1/company/milestones              → 403
GET /encompass/v1|v3/settings/milestoneTemplates  → 403   (templates not readable)
GET /encompass/v1/settings/loan/templates/milestoneTemplateSets → 403
```

The list endpoint returns only `{id, name, tpoStatus, consumerStatus, milestoneColor, isArchived}`.
**The per-id GET is where `role`, `assignMemberToRoleRequired` and `daysToFinish` live:**

```json
{ "id": "3", "name": "Submittal",
  "logDescriptionExpected": "Submittal", "logDescriptionFinished": "Submitted",
  "tpoStatus": "Submitted", "consumerStatus": "Submitted for Approval",
  "milestoneColor": "Color [A=255, R=255, G=128, B=64]",
  "role": { "entityId": "5", "entityName": "Loan Processor", "entityType": "Role" },
  "assignMemberToRoleRequired": true,
  "daysToFinish": 2,
  "isArchived": false }
```

### 8.4 ✅ Catalog verification vs. `db/547_lt_encompass_milestones.sql`

I fetched all 19 milestone settings and diffed them field-by-field against the seeded catalog
in `db/547_lt_encompass_milestones.sql` (and its mirror in `src/longterm/lib/encompass-milestones.js`).

> **RESULT: ALL 19 ROWS MATCH LIVE EXACTLY** — `milestone_id`, `sequence`, `milestone_name`,
> `role`, `role_id`, `assignment_required`, `expected_days`, `tpo_status`, `consumer_status`,
> `is_archived`. Zero diffs. **Our catalog is accurate.**

| seq | milestone_id | name | role (id) | assign req. | days | tpoStatus | consumerStatus |
|---|---|---|---|---|---|---|---|
| 1 | `1` | Started | — | false | 0 | Collecting Information | Collecting Information |
| 2 | `99b6eeca-…ab1c` | LO Prep | Loan Coordinator (1) | true | 1 | Application Received | Application Received |
| 3 | `2` | Loan Setup | Loan Coordinator (1) | true | 0 | Loan Setup | Processing |
| 4 | `3` | Submittal | Loan Processor (5) | true | 2 | Submitted | Submitted for Approval |
| 5 | `3c34f220-…4b18d5` | Cond. Approval | Loan Processor (5) | false | 3 | Cond. Approved | Submitted for Approval |
| 6 | `af5ebaf4-…2da7819` | Processing | Loan Processor (5) | false | 2 | Cond. Approved | Conditionally Approved |
| 7 | `c5fcb17c-…e14249` | Waiting for Docs | Loan Processor (5) | false | 2 | Cond. Approved | Conditionally Approved - Waiting for Docs |
| 8 | `80dcf250-…345f49` | Resubmittal | Loan Processor (5) | false | 2 | In Underwriting | Condition Review |
| 9 | `4` | Clear To Close | Loan Processor (5) | true | 2 | Clear To Close | Final Approval |
| 10 | `4c757816-…7dd6e021` | Schedule Closing | Loan Coordinator (1) | true | 1 | Closing Scheduled | Closing Scheduled |
| 11 | `e6896d81-…89f897` | Ready for Docs | Closer (7) | false | 2 | Closing Scheduled | Closing Preparation |
| 12 | `850dd7ea-…a9bac13` | Docs Out | Closer (7) | false | 1 | Active Closing | Active Closing |
| 13 | `1fa5ea4f-…92afb80` | Wire Order | Funder (8) | false | 0 | Active Closing | Active Closing |
| 14 | `6` | Funding | Funder (8) | true | 1 | Funded | Funded |
| 15 | `70367ac9-…0eb6cee` | Investor Delivery | Post Closer (9) | false | 1 | Funded | Funded |
| 16 | `c6cf77b0-…f0af3c3` | Purchasing Conditions | Post Closer (9) | false | 2 | Funded | Funded |
| 17 | `21a666b4-…f4e22a4c` | Final Docs | Post Closer (9) | false | 0 | Funded | Funded |
| 18 | `6115d8b8-…22170391` | Closed | Post Closer (9) | false | 1 | Funded | Funded |
| 19 | `7` | Completion | Post Closer (9) | false | 30 | Funded | Funded |

**One thing the catalog is missing** (available live, worth adding):
`logDescriptionExpected`, `logDescriptionFinished`, and `milestoneColor` (a .NET
`Color [A,R,G,B]` string — parse to hex for the UI).

### 8.5 Live milestone distribution (200 most-recently-modified loans)

`Started` 46 · `Closed` 36 · `Purchasing Conditions` 23 · `LO Prep` 22 · `Submittal` 19 ·
`Loan Setup` 17 · `Investor Delivery` 11 · `Docs Out` 8 · `Completion` 5 · `Cond. Approval` 3 ·
`Funding` 3 · `Wire Order` 2 · `Final Docs` 2 · `Schedule Closing` 1 · `Ready for Docs` 1 ·
`Resubmittal` 1

Note `Processing` and `Waiting for Docs` never appear as a *current* milestone — they are
transited through, not rested on.

---

## 9. Webhooks

```
GET /webhook/v1/resources      → 200   (23 resources)
GET /webhook/v1/subscriptions  → 200   (1 existing subscription)
GET /webhook/v1/events?limit=N → 200   (recent event log — useful for replay/debug)
```

**No subscription was created.** LIST only, per the brief.

### 9.1 Available resources & events (all 23)

| Resource | Events |
|---|---|
| **`Loan`** | `create, update, submit, move, document, attachment, condition, reportingdbupdate, **milestone**, **milestoneupdate**, change, **fieldchange**, **enhancedfieldchange**, delete, **lock**, **unlock**, alertchange, disclosuretracking` |
| `EFolder` | `created, updated, deleted, activated` *(extraPayload on all)* |
| `Document` | `created, updated, deleted, packageready` |
| `DocumentDelivery` | `packagecreated, packageupdated, fulfillmentcreated, fulfillmentupdated` |
| `DocumentOrder` | 26 events (opening/closing × audit/order/delivery/package/forms × completed/failed, addtoefolder, appenddocuments) |
| `Task` | `create, update, delete` |
| `SubTask` | `create, update, delete` |
| `TaskGroup` | `create, update, delete` |
| `TaskComment` | `update` |
| **`EnhancedConditionTemplate`** | `create, update, delete` |
| **`EnhancedConditionType`** | `create, update, delete` |
| `InternalUsers` | `create, update, delete` |
| `ExternalUsers` | `create, update, delete` |
| `UserGroup` | `create, update, delete` |
| `ExternalOrganization` | `create, update, delete` |
| `Trade` | `create, publish, loanassignmentcomplete, update` |
| `Transaction` | `update` |
| `ServiceOrder` | `placed, acknowledged, fulfilled, processfailure, eventreceived, deliveryfailed, fulfillmentfailed` |
| `ReceivedMailItem` | `completed, failed, moved, filed, autoindexed, autoextraction, indexingvalidation, extractionvalidation` |
| `AnalyzerResult` | `updated, updatedv2` |
| `AnalyzerDocumentValidationResult` | `updated` |
| `DataSource` | `dataingestion` |
| `Timer` | `created, completed, changed, cancelled` |

Resource record shape:
```json
{ "name": "EFolder", "status": "active",
  "description": "Represents the Loan/efolder and Document state throughout the life cycle…",
  "events": [ { "name": "created", "extraPayload": true }, … ] }
```

### 9.2 Existing subscription (read-only listing)

```json
{
  "subscriptionId": "ca2866ee-71e5-499a-97e4-5de2cd9aab61",
  "endpoint": "https://automations.drivekosher.com/webhook/d6865747-…",
  "signingkey": "<REDACTED>",
  "enableSubscription": true,
  "resource": "loan",
  "events": ["milestone", "milestoneupdate"],
  "filters": {},
  "objectUrn": "urn:elli:webhook:3011397907:be11397907:loan",
  "clientId": "3011397907",
  "instanceId": "be11397907"
}
```

⚠️ **There is already a live subscription** pointed at an external automation host, firing on
`loan.milestone` + `loan.milestoneupdate`. Do not disturb it. A future LT subscription should be
a **separate** subscription with its own endpoint + signing key.

### 9.3 Event log sample

```json
{ "id": "bac0949c-…", "type": "urn:elli:webhook:loan:lock:eventreceived",
  "time": "2026-08-13T18:13:34.34Z",
  "event": { "instanceId": "be11397907", "clientId": "3011397907",
             "eventId": "f167d6f0-…", "eventTime": "2026-08-13T18:13:33.526Z",
             "eventType": "lock", "resource…": … } }
```

### 9.4 Recommended LT subscription (when writes are authorized)

Creating a subscription is a `POST /webhook/v1/subscriptions` — **a WRITE, deliberately not
performed.** When authorized, the shape LT wants is:

```json
{ "endpoint": "https://<lt-host>/api/webhooks/encompass",
  "resource": "loan",
  "events": ["milestone","milestoneupdate","fieldchange","lock","unlock","document","condition","create","update"],
  "filters": { "fieldList": ["317","LOID","362","1855","761","762","2148","1109","3"] },
  "signingkey": "<generated>" }
```

---

## 10. Field lookup / dictionary

There are **two** complementary dictionaries, and you want both.

### 10.1 `GET /encompass/v1/loanPipeline/fieldDefinitions` — the FIELD-ID dictionary ⭐

**200.** `{ "pipelineLoanReportFieldDefs": [ … ] }` — **3,159 entries**, ~4 MB.
This is the one that maps **field IDs → description, format, and dropdown options.**

```json
{
  "borrowerPair": 1,
  "isLoanDataField": true,
  "category": "Database",
  "fieldID": "4189",
  "fieldDefinition": {
    "fieldID": "4189",
    "description": "Co-Borr Sex No Co Applicant",
    "format": 102,
    "category": 3,
    "allowEdit": true,
    "allowInReportingDatabase": true,
    "reportingDatabaseColumnSize": 1,
    "reportingDatabaseColumnType": 1,
    "maxLength": 1,
    "enforceMaxLengthDuringValidation": true,
    "requiresBorrowerPredicate": true,
    "fieldOptions": {
      "requireValueFromList": true,
      "options": [ { "value": "Y", "text": "No co-applicant" },
                   { "value": "N", "text": "No" } ]
    }
  },
  "dataSource": 1,
  "fieldType": 6,
  "name": "Co-Borr Race No Co Applicant",
  "description": "Co-Borr Race No Co Applicant",
  "selectable": true,
  "criterionFieldName": "Fields.4189",
  "sortTerm": { "fieldName": "Fields.4189", "useNull": false },
  "isDatabaseField": true,
  "reportingDatabaseColumnType": 1
}
```

**Counts:** 3,159 total · **790 fields carry a dropdown option list** (`fieldOptions.options[]`
with `{value, text}` — this is your enum source for every picklist in the UI).

**`format` code distribution** (the format enum you need to render/parse values):

| format | count | format | count | format | count |
|---|---|---|---|---|---|
| 101 | 652 | 108 | 7 | 204 | 29 |
| 102 | 528 | 109 | 8 | 205 | 7 |
| 103 | 5 | 110 | 9 | 208 | 2 |
| 104 | 7 | 111 | 4 | 211 | 5 |
| 105 | 9 | 201 | 107 | 301 | 143 |
| 106 | 15 | **203** | **1,598** | 304 | 8 |
| 107 | 4 | | | 998 / 999 | 11 / 1 |

(101 = text, 102 = coded/list, 203 = decimal/money, 301 = date — inferred from samples; treat
`fieldOptions.requireValueFromList` as the authoritative "is this an enum" flag.)

**Category distribution:** see §3.7.

⚠️ `GET /encompass/v3/loanPipeline/fieldDefinitions` → **403**. Use v1.

### 10.2 `GET /encompass/v1/schema/loan` — the CONTRACT dictionary ⭐

**200.** ~2 MB. This is the *typed* dictionary keyed by contract path (not field ID):

```json
{ "schema_version": "26.2.0.0",
  "entity_types": {
    "Loan": { "properties": {
        "BaseLoanAmount": { "type": "decimal", "format": "decimal_2", "read_only": true,
                            "description": "Trans Details Total Loan Amt (w/ MIP/FF)" },
        "RequestedInterestRatePercent": { "type": "decimal", "format": "decimal_3",
                                          "description": "Trans Details Interest Rate" },
        … } },
    "Application": { … }, "Borrower": { … }, … } }
```

* **244 entity types**, **12,877 total properties**.
* Key sizes: `Loan` **567**, `Borrower` **589**, `RateLock` **589**, `Application` **239**,
  `Contact` **114**, `Employment` **79**, `Liability` **72**, `ReoProperty` **52**,
  `Residence` **46**, `Asset` **44**, `Income` **7**, `MilitaryService` **9**.
* Every property carries `type`, `format`, `description`, and `read_only` — which is precisely
  the metadata a generic form renderer needs.

### 10.3 `GET /encompass/v3/schemas/loan` — the JSON-Schema dictionary

**200.** ~2 MB. Standard JSON Schema: `{title, definitions{273}, type, properties{534}}`.
Use this for codegen / TypeScript types. `?entities=` is accepted but the response is the full
schema regardless.

⚠️ `GET /encompass/v1/schemas/loan` → **403**. `GET /encompass/v1|v3/settings/loan/fieldDefinitions`
→ **403**. `GET /encompass/v1|v3/settings/customFields` → **403** (but the *values* come back on
the loan as `customFields[]`, 103 rows on a real loan).

### 10.4 How to pull the full dictionary (recommended one-time job)

```
1. GET /encompass/v1/loanPipeline/fieldDefinitions   → 3,159 field IDs + options + formats
2. GET /encompass/v1/schema/loan                     → 244 entity types / 12,877 typed properties
3. GET /encompass/v3/schemas/loan                    → JSON Schema for codegen
```

Three GETs, ~8 MB total, no paging. Cache them keyed by `schema_version` (`26.2.0.0`) and refetch
only when the tenant's Encompass version changes.

---

## 11. Permission map — what 403s

The `admin` user has the **Super Administrator** persona and still hits 403s. That means the
blocks are at the **API-product / scope** level (`scope=lp` only), not the Encompass persona
level. To lift these, the ICE admin must grant the API client additional product entitlements.

### ✅ Works today

```
POST /oauth2/v1/token                              POST /oauth2/v1/token/introspection
POST /encompass/v1/loanPipeline                    POST /encompass/v3/loanPipeline
GET  /encompass/v1/loanPipeline/fieldDefinitions
GET  /encompass/v1/loanFolders
GET  /encompass/v1/company/users        GET /encompass/v1/company/users/{id}
GET  /encompass/v1/users
GET  /encompass/v1/organizations        GET /encompass/v1/organizations/{id}
GET  /encompass/v1/settings/roles       GET /encompass/v3/settings/roles
GET  /encompass/v1/settings/personas    GET /encompass/v3/settings/personas
GET  /encompass/v3/settings/milestones  GET /encompass/v3/settings/milestones/{id}
GET  /encompass/v1/schema/loan          GET /encompass/v3/schemas/loan
GET  /encompass/v3/loans/{id}[?entities=…]
POST /encompass/v3/loans/{id}/fieldReader
GET  /encompass/v1/loans/{id}/associates
GET  /encompass/v1/loans/{id}/milestones            GET /encompass/v3/loans/{id}/milestones
GET  /encompass/v1/loans/{id}/milestoneFreeRoles    GET /encompass/v3/loans/{id}/milestoneFreeRoles
GET  /encompass/v1/loans/{id}/documents             GET /encompass/v3/loans/{id}/documents
GET  /encompass/v1/loans/{id}/attachments
GET  /encompass/v1/loans/{id}/underwritingConditions          (empty)
GET  /encompass/v1/loans/{id}/conditions/{underwriting|preliminary|postclosing}   (empty)
GET  /encompass/v3/loans/{id}/conditions                                          (empty)
GET  /encompass/v1/loans/{id}/conversationLogs                (empty)
GET  /encompass/v1/loans/{id}/disclosureTracking2015Logs      (empty)
GET  /webhook/v1/resources   GET /webhook/v1/subscriptions   GET /webhook/v1/events
```

### ❌ 403 — ask ICE for these entitlements

| Area | Blocked endpoints |
|---|---|
| **Lock / secondary / pricing** | `loans/{id}/lockRequests` (v1+v3), `rateLocks`, `lockConfirms`, `registrationLogs`, `secondaryRegistration`, `secondaryRegistration/loans/{id}/lockRequests`, `productPricing`, `loanPricing/loans/{id}`, `epps/loans/{id}`, `settings/lockDeskSettings`, `settings/lockPolicy`, `settings/investors`, `settings/pricing/investors` |
| **Conditions (enhanced) & templates** | `loans/{id}/preliminaryConditions`, `postClosingConditions`, `enhancedConditions` (v1+v3), `v3 underwritingConditions`, `settings/conditions/templates`, `settings/enhancedConditions/templates`, `settings/enhancedConditions/types`, `settings/conditionTemplates`, `settings/templates/underwritingConditionSets`, `settings/loan/conditionTemplates` |
| **Tasks** | `loans/{id}/tasks` (v1+v3), `tasks?loanId=`, `taskGroups`, `settings/taskGroups` |
| **Company settings (documented paths)** | `company/roles`, `company/organizations`, `company/personas`, `company/milestones`, `company/licenses`, `v3/company/users` — ⚠️ **all have working `/settings/` or `/organizations` equivalents, listed above** |
| **Settings — misc** | `settings/loan/milestones`, `settings/milestones` (v1), `settings/milestoneTemplates` (v1+v3), `settings/loan/templates/milestoneTemplateSets`, `settings/documents` (v1+v3), `settings/loan/documents`, `settings/customFields` (v1+v3), `settings/fieldMappings`, `settings/loan/fieldDefinitions` (v1+v3), `v1/schemas/loan`, `v3/loanPipeline/fieldDefinitions`, `v3/settings/organizations` |
| **Loan sub-resources** | `v3 loans/{id}/associates`, `loans/{id}/loanAssociates`, `loans/{id}/logEntryLogs`, `loans/{id}/roleFreeMilestones` |
| **Pipeline cursors** | `GET /encompass/v1|v3/loanPipeline/{cursor}` |

### 404 (wrong URL shape, not permissions)

`/encompass/v1/loans/{id}/conditions` (needs a type suffix) ·
`/encompass/v3/loans/{id}/conditions/{type}` (v3 has no type suffix) ·
`/encompass/v1/settings/loan/conditionSets`

---

## 12. Build-plan implications

1. **Auth is solved.** `src/longterm/encompass/client.js` sends exactly the right token request.
   Token = 30 min, scope `lp`. Refresh at 25 min. Concurrency cap 30 is the real limit — the
   350 ms serial gap can be relaxed to a small parallel pool if throughput matters.

2. **Assigned-contacts is solved, with a caveat.** Use
   `LoanTeamMember.UserId.<role>` (fieldReader) + `loan.contacts[]` (one GET). Join to LT staff on
   the **Encompass login id**. **Never** join on name; **never** trust `/associates` for "current".
   Remember: this tenant's Loan Officer = the **`Loan Coordinator` role, roleId `1`**.

3. **Pipeline is solved.** `POST /encompass/v3/loanPipeline` with `limit`+`start`, filter terms
   (drop `operator` when there's one term), `order: "Ascending"/"Descending"`, and
   `Fields.LOID` for LO scoping / `Loan.LoanFolder` for folder scoping. 696 loans total; ~122 active.

4. **URLA is fully readable in one call.** `?entities=…` with the 18 URLA sub-entity names.
   Build the 1003 screen from §5.3. Bias the data layer toward `vols[]`/`vods[]`/`otherAssets[]`
   rather than `liabilities[]`/`assets[]` — that's where this tenant's data actually lives.

5. **Conditions is the big gap.** Encompass conditions are **empty tenant-wide**; the real
   workflow lives in eFolder **documents**. Either (a) build the conditions module on
   `GET /encompass/v3/loans/{id}/documents` (fully readable today, with status/dates/roles/
   milestone/document-groups), or (b) get the 403'd condition + template endpoints unlocked
   first. **Decide this before scoping the conditions work** — it changes the data model.

6. **Lock/pricing is read-shallow.** Status/dates/terms are readable (`rateLock` entity, fields
   `761`/`762`, `Loan.Lock*` canonicals, Trade canonicals). Lock *history* and *pricing* are 403.
   Field `2148` is empty here — use `761`/`762`.

7. **The milestone catalog is verified accurate** — all 19 rows match live exactly. Consider
   adding `logDescriptionExpected`, `logDescriptionFinished`, `milestoneColor` to
   `db/547_lt_encompass_milestones.sql`. Remember `?limit=100` on `/v3/settings/milestones`
   (default page is 10).

8. **Webhooks are ready to consume** but a subscription already exists pointing elsewhere —
   LT needs its own. `loan.{milestone, milestoneupdate, fieldchange, lock, unlock, document,
   condition}` covers the sync surface. Creating one is a WRITE and needs sign-off.

9. **Field dictionary is three GETs** (§10.4), ~8 MB, cacheable by `schema_version`. 3,159 field
   IDs (790 with enums) + 12,877 typed contract properties.

10. **Ask ICE for:** lock/secondary/EPPS read entitlements, enhanced-conditions + condition
    templates read, tasks read, and `settings/customFields` + `settings/documents` read. Everything
    else needed for the build is already reachable.

---

*Probe scripts were throwaway and live only in the session scratchpad — nothing was committed.*
