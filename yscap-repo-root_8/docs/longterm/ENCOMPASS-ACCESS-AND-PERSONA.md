# Encompass API access — why 68 endpoints answer 403, and how to open them

**Long-Term (LT). Investigated 2026-08-14 against the live tenant. Read-only.**
**Revised 2026-08-16 — the 2026-08-14 conclusion below was too narrow. Read this first.**

---

## CORRECTION (2026-08-16): read this before acting on anything below

The 2026-08-14 finding said: *"this is not a persona problem on the user. It is a scope
limit on the API client, fixed with ICE, not in the Encompass admin screens."* The
evidence for that (the token endpoint refusing `encompass_admin`) is real and is
reproduced below. **The conclusion drawn from it was too narrow, in two ways that
matter.**

**First — `encompass_admin` is not a documented scope on either ICE platform.** ICE's
own Developer Connect authorization page names exactly one scope, `lp`. Partner
Connect names `pc pcapi`. `encompass_admin` appears only in third-party write-ups.
So the token endpoint's *"exceeds that which the client is permitted"* is very likely
saying **there is no such scope to grant**, not *"you have not been given this one
yet."* **Asking ICE to "entitle client `z1xx73r` to `encompass_admin`" is therefore
likely to go nowhere** — it asks for something their own documentation does not
describe. That ask, as originally written below, should not be sent as-is.

**Second — the persona matrix does NOT explain it, and an earlier draft of this section
said it did. That was a misreading, corrected here rather than quietly deleted.**

*Out-of-the-Box Persona Access to Encompass Settings and Add-On Products — Encompass
Banker Edition* (rev. June 2025) says, area after area:

> "…can be added/edited/deleted **only if the persona has been granted access** to
> `<area>` on the **Personas > Settings tab**; **if no persona permissions have been
> granted, the minimum access needed is Super Administrator.**"

That sentence can be read two ways, and the wrong reading is the tempting one. It looked
as though Super Administrator were merely a *fallback* for an unconfigured persona — so
that ticking a few boxes would somehow *narrow* a super admin. **The document settles
it against that reading.** Its second column is headed **"Default Persona Access \*"**
and the footnote defines the asterisk as:

> "\* **Minimum persona access level required to interact with the functionality
> out-of-the-box**"

So "Super Administrator Persona" in that column means a super admin **has this
already**. The Settings tab EXTENDS the area to *other* personas; it does not gate the
super admin. **Ticking those boxes will not open anything for an account that already
holds Super Administrator.**

Which leaves the owner's original objection standing and correct: *they did give full
admin, and it should have been enough.* The persona is not what is refusing us.

The matrix does name one gate that is genuinely separate, and that no persona can
substitute for:

> "In order for [a] user to access Public and Company-wide **Loan Programs**, **both of
> these folders must be selected in the user's user group**."

So the live candidates are, in the order worth testing:

| # | Candidate | Who can settle it | Cost | Standing |
|---|---|---|---|---|
| 1 | **We ask for too little.** Our login names `scope=lp`; two mature clients name nothing at all, and OAuth grants a default — normally everything you are entitled to — when no scope is named | Us, in one line | Free, minutes | **Best lead. Untested.** |
| 2 | **The API user is not really the persona we think.** Cheap to confirm — the roster and persona endpoints both answer today | Us | Free | Unverified assumption |
| 3 | **User group** template folders (loan programs only) | Our Encompass admin | Free, minutes | Real, narrow |
| 4 | **Licensed add-on product** (pricing/EPPS, secondary & lock desk, tasks) | ICE — contract | Depends | Real |
| ~~5~~ | ~~Persona > Settings tab~~ | — | — | **Ruled out above** — a Super Administrator already holds these |

**Work 1 and 2 before contacting ICE.** They are free, they are reversible, and either
could end the question.

### Candidate 1 in full — the one worth testing first

Our client asks for **`scope=lp`** on the password grant. Two independent, mature
Encompass clients — [EncompassRest](https://github.com/EncompassRest/EncompassRest)
(.NET) and [EncompassConnect](https://github.com/heythisispaul/EncompassConnect)
(TypeScript) — send **no `scope` parameter at all** on that grant; only the
client-credentials grant carries `lp`. Neither mentions `encompass_admin` anywhere.

That difference may matter. OAuth (RFC 6749 §3.3) says a server given no scope applies
its own default, which is normally *everything the caller is entitled to*. **So it is
possible we have been narrowing our own token by naming `lp`** — and the token
introspection that reported `"scope": "lp"` could never have told us, because `lp` is
exactly what we asked for. The measurement was circular.

This is free to test and it is the FIRST thing the probe does: ask for a token with no
scope and report what comes back. If the granted scope is wider than `lp`, the fix is
to delete one line from `getToken` and nothing else. **This is a hypothesis, not a
finding — it has not been tested against the live tenant.**

### The one thing still missing, and how to get it

Neither the earlier probe nor this review can say *which* gate closed *which*
endpoint, because **the 403 response bodies were never kept** — only the status codes.
ICE puts a summary in the body and the wording differs by gate, so those bodies are
the evidence that decides it.

`scripts/test-lt-encompass-access-probe.js` collects exactly that. Run it where the
credentials live; it is read-only, it groups the refusals by what ICE actually said,
and it prints which candidate to work for each. **Run it before raising anything with
ICE** — it turns "68 endpoints are blocked" into a short list of distinct problems,
each with an owner.

---

## The 2026-08-14 investigation, as recorded then

*Kept because the measurements are sound and are the input to the correction above;
the recommendation at the end of it is superseded.*

---

## What we observed

A read-only probe of 111 endpoint paths with our own credentials returned:

- **36 working**
- **68 × 403 Forbidden**
- **6 × 404 Not Found** (wrong API generation, not a permission problem)
- **1 × 400**

The 403s cluster almost entirely on `/settings/*` and on a handful of loan
sub-resources — `milestoneLogs`, `customFields`, `logs`, `trackedDocuments`,
`fieldLockSettings`, `postclosingConditions`.

## Why it is the client, not the persona

Our token is obtained with the resource-owner password grant, username
`admin@encompass:BE11397907`, **scope `lp`**. ICE documents `encompass_admin` as the
scope required for administrative and settings endpoints. We tested all three:

| Requested scope | Result |
|---|---|
| `lp` | token issued — then **403** on every `/settings/*` admin path tried |
| `lp encompass_admin` | **token refused, HTTP 400** |
| `encompass_admin` | **token refused, HTTP 400** |

The refusal text is the decisive evidence:

> `The requested scope is invalid, unknown, malformed, or exceeds that which the
> client is permitted`

That error comes from the **token endpoint**, before any loan or setting is touched.
A persona restriction cannot produce it — a persona limits what a *user* may see once
a token exists. This says the **client registration** (Client ID `z1xx73r`) is not
entitled to ask for `encompass_admin` at all.

This matters because the owner's expectation was that the `admin` persona already has
access to everything. It does — inside Encompass. The API is gated separately.

## Two things have to be true

ICE's model has two independent gates, and both must pass:

1. **The API client must be entitled to the scope.** The set of scopes a Client ID may
   request is fixed at the client/app registration in ICE Developer Connect. This is
   requested from ICE for the integration; it is not a toggle in the Encompass UI.
2. **The API user's persona must allow the underlying feature.** ICE's rule: *"the
   features and data users can access with the APIs is determined by their assigned
   Encompass persona"* — the API key grants nothing beyond it. At minimum one persona
   on the user needs LO Connect access:
   **Settings → Company/User Setup → Personas → (select persona) → Access tab →**
   tick both **Microsoft Windows Encompass Client** and **Encompass Mobile**, save.

## What to ask for — **SUPERSEDED, see the correction at the top**

> ~~Entitle Client ID `z1xx73r` on instance `BE11397907` to the `encompass_admin`
> scope…~~

**Do not send this.** `encompass_admin` is not a scope ICE documents for Developer
Connect (`lp`) or Partner Connect (`pc pcapi`), so the request names something their
own documentation does not describe. Work the three gates in the correction above
instead, and if something still refuses after gates 1 and 2, send ICE the endpoint,
**the exact refusal wording the probe captured**, the instance id and the client id,
and ask which entitlement opens it — their words, not ours.

## What opens up if you do

These are the blocked endpoints actually worth having, and what each unlocks:

| Endpoint | What it gives Long-Term |
|---|---|
| `/v3/settings/businessRules/milestoneCompletion` | **The 91 Milestone Completion rules.** We currently know 22 of them, from screen recordings. This is the single biggest gap in our knowledge. |
| `/v3/settings/loan/programs` | The real program definitions behind field `1401` — today our program taxonomy is reverse-engineered from loan data. |
| `/v1\|v3/loans/{id}/milestoneLogs` | Who moved a file to each milestone and when — the audit spine for a pipeline view. |
| `/v3/settings/loan/conditions/categories` and `.../priorTo` | The condition vocabulary, instead of inferring it from observed values. |
| `/v3/settings/users`, `/v3/settings/loanTeamTemplates` | Team and role assignment. |
| `/v3/settings/loan/folders` | The folder list (we currently derive it from the pipeline). |
| `/v3/settings/efolder/documentTemplates` | Nice-to-have — the v1 form of this already answers. |

After the change, re-run the probe and update
`src/longterm/encompass/dictionary/api-surface.json`.

---

## Not permission problems — read these differently

**404 means wrong API generation.** Conditions exist only on v3; loan associates
answer only on v1. Six of our failures were this, not access.

**200 with an empty array is the dangerous one.** The legacy condition endpoints
(`/v1/loans/{id}/conditions/underwriting`, `/preliminary`, `/postclosing`,
`/underwritingConditions`) answer **200 `[]` on all 772 loans**. That reads as "this
tenant has no conditions". It has 348 — on
**`GET /encompass/v3/loans/{loanId}/conditions`**, because the tenant uses **Enhanced
Conditions**. Scanning the whole pipeline through the legacy paths found nothing at
all. Any integration built on them would be silently, completely blind.

**Blank pipeline columns.** `Loan.CurrentMilestone` comes back empty for every loan in
the pipeline search. Read `loan.milestoneCurrentName` or field `MS.STATUS` instead.
