# 10 — How every Elementix request must look (the live connector, transcribed)

**Date:** 2026-08-09 · **Source:** the live Elementix MCP connector's own tool
schemas plus live confirmation calls, at the owner's direction: *"do a million
research in your own Elementix connector on how every request needs to look …
bring all the information you know into our system so that our systems should
know exactly how to pull the requests the same way you know how to pull the
requests."*

The machine-readable version — the one the code actually enforces — is
**`src/lib/elementix/request-contracts.json`**, read by `lookups.call()` before
anything is sent. This document is the narrative: the rules, why they exist,
and what was proven live rather than assumed.

## The one rule that broke a real search

**`match_entity` and `match_person` both REQUIRE `state`.** Entities and
persons are keyed **(name, state)** — the same name in another state is a
*different record*. This is not a theory:

- The owner's search on 2026-08-09 sent five entity matches with no state and
  got five `MCP error -32602 … path: ["state"] … received undefined` refusals —
  which reached the screen raw. The person match failed the same way but was
  silently swallowed by the fallback path (and still spent a lookup).
- Called live: `search {query:'MW Trading LLC', entityFilter:'entity'}` returns
  **"MW TRADING LLC" twice — once in NJ, once in CA** (two different UUIDs),
  plus the near-name "MW TRADING GROUP LLC" in FL. Captured verbatim in
  `scripts/fixtures/elementix-shapes.json` (`search_entity`).
- The same call with `state:'NJ'` returns exactly the one NJ company
  (`search_entity_state_filtered`).

**Consequences encoded in `lookups.js`:**

1. With a state → `match_entity` / `match_person` (deterministic,
   one-or-nothing).
2. Without one → `search` with `entityFilter:'entity'`/`'person'` (the vendor's
   own guidance), filtered to EXACT name matches. For entities the comparison
   is corporate-suffix-blind ("LLC" ≡ "L.L.C." ≡ nothing) but ORDER-PRESERVING;
   for persons it is order-blind (counties reverse names) — two different
   disciplines on purpose.
3. Several states holding the same name → `ambiguous`, with `statesFound`
   naming them, so the screen can ask the person to pick a state (the
   workbench's state drop-down exists for exactly this).

## Every tool we call, at a glance

| Tool | Required | The trap |
|---|---|---|
| `search` | `query` (≥3 chars) | Not paginated — `{results, resultLimit:20}`. `state` optional. `highlightedName` carries `<mark>` HTML. |
| `match_entity` | `name`, `state` | State REQUIRED. No `entityFilter` here. Answers a SINGULAR `{status, match:{…}}`. |
| `match_person` | `name`, `state` | State REQUIRED. Exact matcher answers `none` even for real names — the search fallback is mandatory, not optional. |
| `match_address` | `address` | Takes ONE string, any reasonable US format. |
| `get_entity_*` / `get_person_*` / `get_address_*` | `id` | The parameter is `id` — never `entityId`/`personId`/`addressId` (proven live; see `_param_names` in the fixtures). Filter params like `state`/`city`/`countyName` are **arrays**. |
| `get_document` | `type`, `id` | BOTH required — the type is the transaction row's own `type` (deed/mortgage/…); `documentId` is not a parameter. `include`: metadata/addresses/signers. |
| `get_coverage` | — | `state` is an **array**; there is **no county parameter** — pick the county out of the state's rows client-side. `scope`: data/count/totals. |
| `get_contact_status` / `get_contact_info` | `personId` | The ONE family keyed `personId` rather than `id`. |

Paging everywhere: `perPage` (1–5000, vendor default **5**), `page`,
`nextPage` in the response. `limit` is silently ignored — the trap recorded in
`_paging`. We deliberately cap `perPage` at 100 (`lookups.pageArgs`) and report
`nextPage` as truncation, never chase it silently.

Mortgage vs deed asymmetry worth knowing: on the **deed** tools `fundingType`
is a single string (`cash`/`financed`); on the **mortgage** tools it is an
**array** of loan purposes (`purchase`/`refinance`/`extension`).

## How the knowledge is enforced

- **`src/lib/elementix/request-contracts.json`** — required params, types,
  enums, array-ness, per tool. Updating it means re-reading the live
  connector's schema first.
- **`lookups.contractProblem()`** — runs inside `call()` before the wire. A
  request our own code shapes wrongly is refused with a plain sentence
  (`bad_args`, "Not sent: …") instead of the vendor's raw -32602, and spends
  nothing of the shared hourly allowance.
- **`scripts/test-elementix-request-contracts-pure.js`** — every wrapper is run
  against the contract; the known-bad shapes (no state, `documentId`, a county
  filter on coverage, a string state on a list tool) are each proven refused
  before sending.
- **`scripts/fixtures/elementix-shapes.json`** — the RESPONSE side, captured
  live, same discipline as always: no hand-written vendor rows in tests.
