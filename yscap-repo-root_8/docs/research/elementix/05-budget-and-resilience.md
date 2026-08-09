# Elementix — the budget, the rate limit, the cache, and what happens when it breaks

**The layer underneath the discovery pipeline and the verification pipeline.** Two sibling research
passes own *what* we ask Elementix and *what we do with the answer*. This one owns the envelope both
of them have to fit inside: how many calls exist, who gets them, what is bought once and remembered,
and what happens on every way this can fail.

Nothing here decides what a bulk import searches for or how a verification scores. It decides what
the machine is **allowed to spend** doing either, and it says so in numbers.

---

## 0. Verified against the live API vs. inferred

The task was to probe limits and error shapes, not to harvest. Eight calls were made in total
(`welcome`, `get_coverage`, `get_filter_options` ×3, `get_lender_stats` ×1) plus two deliberate
error probes. What follows separates what came back on the wire from what is reasoning.

**VERIFIED (came back from the live API in this session):**

1. **The vendor's MCP error envelope is structured and already classifies retryability.**
   `get_lender_stats` with a well-formed but nonexistent uuid returned, verbatim:
   ```json
   {"code":"HTTP_404","message":"Lender not found: 00000000-0000-0000-0000-000000000000","status":404,"retryable":false}
   ```
   That is the single most useful thing found. The vendor's MCP server **surfaces the upstream HTTP
   status** and **tells us whether to retry** — and `src/elementix/client.js` currently throws both
   away (see §3).
2. **Argument-validation failures are a DIFFERENT, unstructured shape.** `get_filter_options` with
   `type:'counties'` and no state returned a bare sentence with no envelope at all:
   `a two-letter state code is required when type='counties'`. So there are two error shapes and a
   parser must handle both: an upstream failure (JSON, has `status`/`retryable`) and a local
   validation refusal (plain prose, never retryable, never cacheable, never a fact about a property).
3. **No rate-limit metadata appears in any successful payload.** No remaining count, no reset time,
   no quota block. `get_coverage(scope:'totals')` returned exactly the six aggregate fields
   (3,226 counties, 384,090,172 documents, 63.19% average entity coverage) and nothing else.
4. **`get_coverage` is cheap and answers the freshness question.** It is one call, it is free, it
   carries `latestRecordingDate` per county, and it is already wrapped (`lookups.coverage`). That is
   the input the "nothing found" TTL should be reading — see §5.
5. **`search` returns at most 20 candidates and is not paginated** (from its own tool description,
   matching `docs/ELEMENTIX-RESEARCH.md` §8). A bulk discovery run cannot page a search; it has to
   take uuids and move to a list tool. That caps how much one search buys.

**INFERRED (reasoned, not proven — treat as a design assumption, not a fact):**

1. **A 429 will arrive in the same structured form** — `{"code":"HTTP_429","status":429,"retryable":true,…}`
   — possibly carrying a `retryAfter`. The `retryable` field exists precisely to carry that
   distinction and it was already `false` on a 404. **Not verified**, and it cannot be verified
   without deliberately burning ~1,000 org-wide calls to hit the wall, which is exactly the thing
   this document exists to prevent. Design for it and detect it defensively (§3).
2. **The limit is per ORGANIZATION, not per token.** The owner quoted it from the Elementix
   dashboard as an org figure and `docs/ELEMENTIX-RESEARCH.md` §6 records it as *"per organization,
   across every connected client."* Not independently verified. **Assume org-wide** — it is the
   conservative direction and it is what the owner said. If it turned out to be per-token the design
   is merely over-cautious; if we assumed per-token and it is per-org we starve production.
3. **Whether an HTTP `Retry-After` header is sent.** Over the MCP tool interface headers are
   invisible to any caller — including me. `src/elementix/client.js post()` *does* hold `r.headers`
   and is therefore the only place in the system that could ever learn this. It currently reads only
   `mcp-session-id`. **Nobody will ever know whether Elementix sends `Retry-After` until the client
   is changed to look.** That is a one-line change and it is item 1 on the build list.

---

## 1. The two ceilings. They are different things.

This is the heart of it, and the existing code already gets it right — it just needs to keep getting
it right when a batch job is the caller.

| | **The rate limit** | **The money cap** |
|---|---|---|
| The number | **1,000 requests per HOUR** | **~1,000 contact enrichments per MONTH** |
| Whose | The whole ORGANIZATION, across every connected client | The company's purse |
| Shared with | Production traffic, every officer's Elementix session, every other tool on the account, every Claude Code session | Nothing — it is ours alone to spend |
| Refills | Continuously, by itself, every hour | Once a month |
| Cost of exceeding it | The vendor refuses us. Nobody is billed. The team is inconvenienced. | **Real money the owner has forbidden us to spend at all.** |
| Cost of a false refusal | A feature the team needs stops working over a bookkeeping hiccup | A phone number nobody looks up. Nothing. |
| Counted in | `elementix_calls` (db/503), rolling 1-hour `count(*)` | `elementix_calls WHERE paid`, calendar month |
| Guard | `overBudgetShared()` | `paidThisMonth()` |
| **Fail direction** | **OPEN** | **CLOSED** |

**Why the fail directions are opposite, and it is not an inconsistency — it is the same rule applied
to two different asymmetries.** In both cases the guard asks "can I read the count?", and in both
cases the answer when it cannot is *"do the cheap thing."* The cheap thing is just different:

- **Money fails closed** because the expensive direction is spending what we cannot count. An
  unreadable count refuses the spend (`reason:'paid_cap_unknown'`). The worst case is a staffer is
  told to try again — a phone number goes unfetched. `recordPaid()` is written **before** the call
  and is deliberately not best-effort, for the same reason: a credit spent with no row is a credit
  nobody can account for.
- **Throughput fails open** because the expensive direction is taking the feature down. An
  unreadable ledger costs at most a throughput overshoot against a limit **the vendor enforces
  anyway** — we would get a 429, which costs nothing but a retry — while refusing every lookup would
  break research for everybody over a database blip.

Both arguments are correct **for one human clicking one button**. §8 argues that the second one
stops being correct the moment the caller is a 60-property batch, and recommends splitting it.

### Two more things about the ledger that matter at bulk scale

- **The client is the SOLE writer, and that is load-bearing.** `lookups.js` recorded its own calls in
  an early cut; two writers would have double-counted the very number the guard reads and the guard
  would have throttled at half the real allowance. `scripts/test-track-record-research-db.js` greps
  for it. Do not add a second writer in the bulk layer.
- **The ledger currently UNDERCOUNTS, in three places.** Verified by reading the client:
  1. `listTools()` makes a real `tools/list` POST and **never calls `recordCall`** — and it checks
     the local in-memory `overBudget()` rather than the shared `overBudgetShared()`.
  2. `ensureSession()` makes **two** POSTs (`initialize` + `notifications/initialized`) that are
     neither recorded nor throttled — `throttle()` runs *after* `ensureSession` inside `attempt()`.
  3. A session-gone 404 re-runs the handshake, so session churn multiplies (2).

  At interactive volume this is noise. At bulk scale across several instances it is a systematic
  gap between what we think we spent and what the org actually spent, and it will show up as
  unexplained 429s. Record and throttle the handshake and the listing.

---

## 2. Budget arithmetic — how many borrowers per hour

### The inputs

- Org ceiling: **1,000 calls/hour = 16.7 calls/minute for the entire company.** That is the whole
  number. It is small.
- PILOT's current self-cap: `ELEMENTIX_MAX_PER_HOUR` **= 400** (`src/config.js`). So PILOT already
  reserves 600/hr for the rest of the org by construction. That was a good instinct and this
  document does not propose raising it blind — see the note under the table.
- One interactive Verify click ≈ **6–9 calls** (`lookups.researchProperty`: `match_entity`,
  `get_entity_deeds`, `get_entity_mortgages`, `get_entity_associated_people`, and where the entity
  route came up empty, `match_address` + `get_address_transactions`; plus any `get_document` the
  checks pull).

### The table

Borrowers imported per hour, at a given batch allowance and a given per-borrower call cost:

| Calls per borrower | Batch = **250/hr** (recommended start) | Batch = 400/hr (PILOT's whole cap, no reserve) | Batch = 800/hr (aggressive) |
|---|---|---|---|
| **10** | **25 borrowers/hr** | 40/hr | 80/hr |
| **30** | **8 borrowers/hr** | 13/hr | 26/hr |
| **80** | **3 borrowers/hr** | 5/hr | 10/hr |

And the number the workbench design actually needs — **how long a 60-property batch takes**:

| Calls per borrower | Total calls | @250/hr | @400/hr | @800/hr |
|---|---|---|---|---|
| 10 | 600 | **2.4 hours** | 1.5 h | 45 min |
| 30 | 1,800 | **7.2 hours** | 4.5 h | 2.3 h |
| 80 | 4,800 | **19.2 hours** | 12 h | 6 h |

**Read the bottom-right of that table out loud.** A 60-property batch at 80 calls each is
4,800 calls — nearly **five hours of the entire organization's API budget**, and at any sane batch
allowance it is an overnight job. This has one architectural consequence and it is not negotiable:

> **A bulk run can never be a request-path operation.** It is a background, resumable, bounded,
> self-draining worker with a durable cursor. A staffer presses "search these sixty" and walks away;
> the answers arrive over hours and the workbench renders from cache. Anything that tries to hold an
> HTTP request open, or to fire a call per row as a screen renders, is defeated by the arithmetic
> before it is written.

**Pacing, so the batch worker has a concrete number:** 250/hr is **4.2 calls/minute — one call every
~14 seconds**. 400/hr is one every 9s. The per-second cap (`ELEMENTIX_MAX_PER_SEC = 3`) never binds
at these rates; the hourly ceiling is the only real constraint.

### The interactive reserve

**Reserve 150 calls/hour that a batch may never touch.** That guarantees ~17–25 Verify clicks per
hour go through instantly no matter what a batch is doing.

Two things about that number:

- **It is a FLOOR for interactive, not a ceiling on it.** When the batch is idle, an interactive
  caller may spend the whole 400. The reserve only ever stops the *batch* from taking the last 150.
  That is what makes it cheap: it costs throughput only when both classes want the budget at once.
- **150 is a starting value, not a finding.** Nobody can currently measure the real interactive rate,
  because it has never been recorded by class. Record it (§7), watch it for a fortnight, then tune.

**Do not raise the 400 yet, and here is the honest reason.** PILOT cannot see the rest of the
organization's usage. The ledger counts only our own calls. The only signal that the org total is
approaching 1,000 is *us starting to get 429s* — which is why "count of vendor 429s in the last
hour" is the most important single number to put on the API-health screen (§7). Raise the cap when
that number has sat at zero for a month with the batch running, and not before.

**Suggested split of the current 400:** 150 interactive-reserved / **250 batch** / background
refresh drawing only from the batch share and yielding to it.

---

## 3. What the vendor does at the limit, and how the client should answer

### What is actually known

Verified: the error envelope carries `status` and `retryable` (§0.1). Verified: validation errors do
not (§0.2). Inferred: a 429 arrives the same way (§0-inferred-1). Unknown until the client looks: a
`Retry-After` header (§0-inferred-3).

### The three defects this exposes in `src/elementix/client.js`

1. **`retryable` and `status` are discarded.** `callToolInner` maps `result.isError` to
   `{ok:false, reason:'tool_error', detail: textOf(result)}` — the whole structured envelope is
   flattened into a display string. So a **404 (definitive: there is nothing here)** and a
   **429 (transient: I did not answer)** arrive at the caller as the same undifferentiated
   `tool_error`. They mean opposite things about the cache, and §5 shows the bug that falls out.
2. **Nothing anywhere honours a 429.** The client handles 401/403 (one retry with a fresh token) and
   404-session-gone (one retry after a re-handshake). A 429 falls through to envelope parsing. If the
   vendor answers 429 with a non-JSON body, `parseRpcBody` returns null and the caller gets
   `unreadable_response` — honest, but unactionable.
3. **PILOT's own throttle and the vendor's throttle are indistinguishable.** Both would surface as
   `reason:'rate_limited'`. "We are pacing ourselves" and "the organization has blown its ceiling"
   need different responses, different screens and different alerts.

### The design, and it works whether or not 429 is distinguishable

**Parse defensively, act on what is there, degrade on what is not.**

- `post()` captures `retry-after` alongside `status` and `mcp-session-id`. One line. It is the only
  way this fact will ever be known.
- `callToolInner` attempts `JSON.parse` on the tool-error text; when it yields an object with a
  numeric `status`, lift `status`, `code` and `retryable` onto the shaped result. When it does not
  (the plain-prose validation case), leave them undefined — an absent `retryable` is *unknown*, never
  *true*.
- Add `reason:'vendor_rate_limited'`, distinct from PILOT's own `'rate_limited'`. Derive it from
  `status === 429` **or** the transport-level `res.status === 429` **or** a message matching
  `/too many requests|rate limit|quota/i` — three independent tells, because we have verified only
  the shape of a 404.
- Treat `retryable === false` as **definitive** (safe to cache as a negative) and everything else —
  including `retryable` being absent — as **not definitive** (never cacheable). Failing toward
  "not a fact" is the direction db/498 already enforces in its `cacheable` column.

### Retry: jitter, and why an in-call retry is mostly the wrong tool here

**The thundering-herd reason, stated plainly.** A 429 means *everyone hit the wall at the same
moment* — that is what a shared ceiling does. If every throttled caller then backs off on the same
deterministic schedule (1s, 2s, 4s, 8s…), all of them retry at the *same instant*, so the retry burst
is exactly as large as the burst that caused the refusal. The second wave is refused too, and now
they are synchronised even harder for the third. The limit never clears; the system converges on a
self-sustaining stampede against a wall. Randomising the wait decorrelates the callers so the same
total load arrives spread out instead of in a spike, and the queue drains.

Naked exponential backoff is not the fix — **exponential backoff with jitter** is. And "exponential
plus 250ms of jitter" (the shape in `src/clickup/client.js`, correct for a *per-minute* limit where
the waits are seconds) decorrelates nothing when the wait is minutes. For an hourly ceiling use
**decorrelated jitter**: `sleep = min(cap, random_between(base, previous × 3))`.

**But the more important point: at an hourly ceiling, the wait is minutes-to-an-hour, and holding a
request open for that is worse than failing.** So:

| Class | On a vendor 429 |
|---|---|
| **Interactive** | **Do not retry at all.** Fail immediately with a plain sentence and a real number: *"Elementix is refusing us right now — the whole company shares 1,000 lookups an hour. Try again in about N minutes."* N comes from our own ledger (oldest call in the current hour window). A human staring at a spinner for twenty minutes is not an acceptable outcome. |
| **Batch** | **Do not retry in-call either.** Put the item back with `run_after = now() + backoff`. This is exactly the `outage` retry class already in `src/sync/clickup-sync.js` — fixed long spacing (10 min), dead only after 40 attempts (~7 hours) — and a vendor 429 is precisely what that class was invented for. A batch item must never dead-letter after 8 fast attempts during a throttle. |
| **Background refresh** | Stop entirely for the rest of the hour. It is the lowest-value traffic and it is the first thing that should get out of the way. |

**And open a circuit.** Copy `src/sitewire/orchestrator.js circuitCheck` by name: on a vendor 429 the
batch stops asking at all for a cool-off window rather than trickling into a wall, and the fact is
recorded so the health screen can say *"Elementix is refusing us"* instead of the batch looking
mysteriously slow. Note the precedent's own detail — `circuitCheck` **fails closed** on an unreadable
counter and throws `retryable`, so the durable queue re-attempts once the database recovers. That is
the right shape here too.

---

## 4. The reservation design

### Do not invent a limiter. There is one, it is DB-backed, and Elementix is simply missing from it.

`src/lib/api-rate-limit.js` + `db/482_api_rate_limits.sql` already implement exactly what is needed
and already carry the hard-won lesson in their own header:

> *"a per-process limiter is not a rate limit, it is a rate limit DIVIDED BY however many processes
> happen to be running — a number nothing in the code knows."*

That is ClickUp's story (two Render processes each pacing to 70/min against one 100/min token, so the
token legitimately saw 140), and it is **Elementix's story today**: `secStamps`/`hourStamps` in
`src/elementix/client.js` are module-level arrays, per-instance, reset on every deploy. The comment
above `overBudget()` says so.

`overBudgetShared()` was the fix for that — but it is a **check-then-act** read:

```js
SELECT count(*) FROM elementix_calls WHERE created_at >= now() - interval '1 hour'
```

Two concurrent callers both read 399 and both proceed. At one-human-one-click that races nothing. At
batch concurrency across the web instances and the worker it overshoots by exactly the concurrency
factor. `api_rate_limits` has no such race: refill and consume happen in **one atomic
`UPDATE … WHERE (refilled) >= 1 RETURNING`**, so concurrent callers serialise on the row lock and no
two processes can spend the same token.

### Token bucket vs leaky bucket vs a windowed count — and why the bucket wins

| | Verdict |
|---|---|
| **Windowed count** (what `overBudgetShared` does today) | **No.** A fixed window permits 1,000 calls at :59:59 and 1,000 more at :00:01 — 2,000 inside two seconds, which is precisely the burst a provider's limiter measures. db/482's header makes this argument for the per-minute case and it is worse at an hourly one. It is also check-then-act, so it races. Keep it as the *audit and the alarm* (§7), not as the gate. |
| **Leaky bucket** | No. It smooths perfectly but permits no burst at all, so one Verify click (6–9 calls) would trickle out over a minute and a half. Interactive needs a burst. |
| **Token bucket** | **Yes.** Burst up to `capacity`, sustained at `refill_per_min`. A capacity of ~11 lets one whole Verify chain fire at once and then paces the next. It is what db/482 already is. |

**Does a per-minute bucket correctly enforce an HOURLY ceiling?** Yes, with a bounded and tiny
overshoot. Spend over any hour ≤ `capacity + 60 × refill_per_min`. At `refill_per_min = 400/60 =
6.67` and `capacity = 6.67`, the worst hour is 406.7 calls against a 400 target — 1.7% over, from the
initial burst only. That is fine, and it is far tighter than any hourly window.

### The mechanism: ONE bucket, THREE priority classes, a reserve FLOOR

Two buckets with a fixed split (`elementix` and `elementix_batch`) would work with zero code change,
but it is the wrong trade: interactive could not borrow the batch's headroom while the batch sits
idle, which is the common case and the whole point of a reserve.

**Instead: one row, and let the caller state a floor it must leave behind.** This is a ~3-line change
to `takeShared` and **needs no migration at all** — the floor is a caller-supplied parameter, not a
column.

```sql
-- src/lib/api-rate-limit.js takeShared(api, {reserve})
-- $1 = api, $2 = refill/min, $3 = the floor this class must leave behind (0 for interactive)
UPDATE api_rate_limits
   SET tokens = LEAST($2::float8,
                      tokens + (EXTRACT(EPOCH FROM (now() - last_refill_at)) / 60.0) * $2::float8) - 1,
       last_refill_at = now(),
       capacity       = $2::float8,
       refill_per_min = $2::float8,
       updated_at     = now()
 WHERE api = $1
   AND LEAST($2::float8,
             tokens + (EXTRACT(EPOCH FROM (now() - last_refill_at)) / 60.0) * $2::float8)
       >= 1 + $3::float8
 RETURNING tokens;
```

Everything else about the existing statement is unchanged — including `capacity`/`refill_per_min`
being re-asserted from the env on every acquire, so raising the cap needs no deploy and no hand-edit
of the row.

The seed row (an additive migration, `ON CONFLICT DO NOTHING`, matching db/482's convention):

```sql
-- 400/hr = 6.67/min. capacity == refill so one whole Verify chain (6–9 calls) bursts through
-- and the next one waits, which is exactly the behaviour interactive wants.
INSERT INTO api_rate_limits (api, capacity, refill_per_min, tokens) VALUES
  ('elementix', 6.67, 6.67, 6.67)
ON CONFLICT (api) DO NOTHING;
```

…plus `elementix: { rpm: 6.67, env: 'ELEMENTIX_MAX_PER_MIN' }` in `DEFAULTS`. **Adding that row puts
Elementix on the API-health screen's "Request limits" panel for free** — it renders `rows` from
`api-rate-limit.status()` and today Elementix is simply absent from it.

**The three classes and their floors** (floors expressed in tokens of the shared bucket; 150/hr
reserved = 2.5 tokens/min at this refill rate):

| Class | Floor left behind | Who calls it |
|---|---|---|
| `interactive` | **0** — may spend the bucket to empty | A staffer clicking Verify; a workbench search a human just pressed |
| `batch` | **2.5** (≈150/hr) | The bulk import worker, the bulk verification worker |
| `background` | **4.0** (≈240/hr) | Cache refresh, re-reading a stale "nothing found" |

### Threading it through, and how a caller states its class

`callTool(name, args, opts)` gains `opts.priority`, defaulting to `'interactive'`. `lookups.call`
passes it through. The bulk workers pass `{priority:'batch', batchId}`.

**Defaulting to `interactive` fails toward letting the human through, which is right — but it means a
batch that forgets gets the highest priority.** The repo has already solved this exact problem once:
`paidActor` demands `{staffId, personId, reason}` in one object precisely because *"you cannot
satisfy it by accident."* Apply the same discipline the same way: the bulk modules must pass
`priority:'batch'`, and a source-grep test asserts it — the identical shape as the existing
`scripts/test-track-record-research-db.js` assertion that `lookups.js` contains no
`INSERT INTO elementix_calls`.

### Across Render instances and the worker

This is the whole reason `api_rate_limits` is a table. The bucket is in the one thing every process
shares. The per-process bucket in `api-rate-limit.js` (`takeLocal`) stays as layer 2 and always
applies, so a database blip degrades to today's behaviour rather than stopping every lookup — and the
in-memory `secStamps`/`hourStamps` in the Elementix client stay as its own local smoothing, exactly
as `src/trustpoint/client.js` keeps `throttle()` *and* calls
`api-rate-limit.acquire('trustpoint')`.

### What `elementix_calls` becomes

Not the gate — **the accountant, the money cap, and the alarm.** It keeps: the monthly paid cap
(unchanged, still fails closed), the per-staffer attribution the vendor's own logs cannot give us
(Elementix sees one company account), and the rolling hourly count that drives the health screen and
the "try again in N minutes" figure. Moving the *gating* to the atomic bucket removes the race; the
ledger's hourly count stays as a **second, independent hard stop** for the batch class only (§8).

---

## 5. Caching

### What is genuinely cacheable, and for how long

| What | TTL | Why |
|---|---|---|
| **A recorded instrument** — `get_document(documentId)` | **Forever, no expiry** | A recorded deed does not change. This is the single biggest unclaimed win: it is **not cached at all today**, and the identity gate reads signers off it for every deal. |
| **`match_address` → addressId** | 180 days | The vendor's own identifier for a parcel. Effectively permanent; the TTL exists only to survive a re-keying at their end. |
| **`match_entity` → entityId** | 90 days | Stable, but a newly registered LLC can appear, and a name that was ambiguous can stop being ambiguous. |
| **An entity's deed / mortgage list** | **90 days** (`FRESH_DAYS_FOUND`, unchanged) | Changes only when a new instrument records. For verifying a *historical* deal, missing a *new* one costs nothing. The existing number is right. |
| **"Nothing found"** | **21 days** (`FRESH_DAYS_EMPTY`), **shortened by county coverage** | The existing reasoning is exactly right — counties publish late and new construction gets added. One improvement: `get_coverage` is free and carries `latestRecordingDate` per county. **A county whose latest recording is months stale should get a much shorter empty-TTL**, because there the absence is far more likely to be a publication lag than a fact. That ties a free call to the freshness policy and it is the honest version of "we found nothing." |
| **"Ambiguous"** | **No TTL — invalidated by an event** | Several equally good candidates is a *human question*, not an absence. It should be cached so the question is not re-bought, and cleared when a human answers it by confirming or rejecting a row in `elementix_address_links` (db/498). A timer is the wrong invalidation for a question only a person can close. |

### The key space — and the change that actually makes bulk affordable

Today there is **one** cache, keyed at the whole-run level:

```
trv1:<trackRecordId>:<entityName>:<address>
```

That key is scoped to **one track-record row**. So a borrower with twelve properties under one LLC
re-buys `match_entity` + `get_entity_deeds` + `get_entity_mortgages` + `get_entity_associated_people`
**twelve times** — and two different borrowers who used the same LLC buy it all over again.

> **Add a second cache tier keyed at the CALL level, not the run level:**
> `call:v1:<tool>:<sha256 of canonicalised args>`.
>
> On a twelve-property, one-LLC borrower this collapses roughly **72–108 calls to about 10**. It is
> the single highest-leverage change in this document, and it is also the answer to the blueprint's
> own open question in §9.5 — *"whether 'these forty are all under one company' can be answered once
> instead of forty times."* It can.

It needs **no migration**: `elementix_lookup_cache.query_key` is free-form `text`, the `cacheable`
GENERATED column already enforces the one rule that must never be got wrong, and the run-level cache
stays as a legitimate second tier (it saves the assembly, not just the calls).

### How a bulk run gets a high cache hit rate

1. **Group the batch by ENTITY, not by property.** Resolve the entity once, pull its deed list once,
   then attribute properties out of that one list. `researchProperty`'s entity-first sequence already
   does this for a single property, and its header already explains why (the entity is the cheap
   discriminator); batching by entity makes the second, third and fortieth property nearly free.
2. **Run ahead of the human.** The batch worker warms the cache in the background, so by the time a
   reviewer opens the workbench the answers are already stored and **rendering the screen costs zero
   calls**. That is the mechanical answer to the blueprint's *"a screen that shows forty properties
   must not fire forty paid lookups because it rendered."*
3. **Size before paging.** `scope:'count'` and aggressive `include` (the wrappers already do this —
   `get_document({include:'signers'})` is about a tenth the payload) keep one call cheap enough that
   caching it is worth the row.

### What must NEVER be cached

1. **`status='error'`.** Already enforced by db/498's GENERATED `cacheable`, and enforced in the
   column rather than in a module precisely so no reader can forget it. Do not weaken it.
2. **A PARTIAL run.** ← **A live bug.** `verify-run.cacheResult` decides:
   ```js
   const failedOutright = !research.searched && (research.errors || []).length > 0;
   ```
   `researchProperty` sets `searched = true` as soon as **any one** step succeeds. So: `get_entity_deeds`
   returns zero rows (fine, the entity has no deeds recorded under that name yet) →
   `searched = true`; `get_entity_mortgages` then 429s → pushed to `errors`; nothing else runs.
   `failedOutright` is **false**, so the run is stored as **`no_match`, `cacheable = true`, for 21
   days** — a rate limit recorded as *"the vendor answered, and there is nothing here."* That is
   exactly the class db/498's own header and `address_canon_cache` (db/124) were built to prevent,
   re-armed one level up the stack. **Fix: any errored step makes the composite non-definitive.**
   Cache it as `error` unless every step that ran returned `ok`.
3. **A DRY-RUN result.** ← **A second live bug, from the same root.** With `ELEMENTIX_DRYRUN` on,
   `callTool` returns `{ok:true, dryRun:true, data:null}`. In `researchProperty` that reads as a
   *successful* step: `d.ok` is true, `rowsOf(null)` is `[]`, `searched = true`, `errors` is empty.
   `failedOutright` is false → the run is cached as **`no_match` for 21 days**. Turning a diagnostic
   switch on therefore **poisons the cache with fabricated negatives that outlive the switch**, on
   every property touched while it was on. **Fix: if any step carried `dryRun`, write nothing to the
   cache at all** — a switch must never leave residue that survives being switched off.
4. **Anything from `get_contact_status` / `get_contact_info`.** Two independent reasons and both are
   sufficient: the unlock state changes the moment somebody spends a credit, so a cached "not
   unlocked" could later suppress a person who genuinely is; and a cached contact payload puts
   skip-traced PII into a table with no retention policy, no redaction and no access control of its
   own. Contact data is not cached. Ever.
5. **A result from a run where the master switch was off.** Currently safe by accident — every step
   returns `reason:'disabled'`, so `searched` stays false and the status is `error`. Make it safe on
   purpose with the same guard as (3).

---

## 6. Failure posture — every mode, the direction, and why

The governing principle, which this repo has already learned twice (`address_canon_cache` db/124,
then db/498's GENERATED `cacheable`):

> **A transient failure must never be recorded as a definitive negative.** The vendor failing to
> answer is not the same as the vendor answering "nothing." A cached non-answer is permanent, and a
> permanent lie about a property is worse than asking again.

| Failure | Today | Should be | Direction | Why that direction |
|---|---|---|---|---|
| **Vendor 429** | Indistinguishable from any other tool error; may be cached as `no_match` via the partial-run path | `reason:'vendor_rate_limited'`; **nothing written to the cache**; interactive fails at once with "try again in ~N minutes"; batch item requeued on the `outage` class; circuit opens for a cool-off | **Closed on writing, open on the feature** | It is the vendor saying *"I did not answer about this property."* Recording that as an answer is the one unrecoverable mistake. The screen still works — it just says try later. |
| **Vendor 5xx** | Same undifferentiated `tool_error` | As 429, shorter cool-off. Drive it off the vendor's own `retryable:true` when present | **Closed on writing** | Ambiguous outcome. Reads are idempotent so retrying is safe, but the answer is unknown, so it is not knowledge. |
| **Timeout** (30s, no retry) | `reason:'error'`, no retry, no cache write for that step | One in-call retry with decorrelated jitter (safe — every tool here is a READ and idempotent), then requeue | **Closed on writing** | 30 seconds with zero retries throws away a good call because one response was slow. |
| **Auth expiry (401/403)** | Exactly one retry with a refreshed token, then `unauthorized`. Correct, and the "more than one retry turns a revoked credential into a retry storm" comment is right | Keep it. **Add:** a 401 that survives the refresh must **pause the whole batch**, not fail 60 items individually | **Closed, and the batch pauses** | Every remaining item will fail identically. Burning 60 items' retry attempts on a dead credential is how a durable queue dead-letters good work. One credential problem should produce one alert, not sixty. |
| **Partial batch** (some steps of one property failed) | **Cached as a definitive `found`/`no_match`** | Any errored step ⇒ the composite is `error` and non-cacheable; per-step reasons surfaced to the reviewer | **CLOSED** | §5.2. This is the repo's own hard-won lesson, currently re-armed. |
| **Dry-run on** | Cached as `no_match` for 21 days | Never write the cache when any step carried `dryRun` | **CLOSED** | §5.3. A switch must not leave residue that outlives it. |
| **Worker dies mid-batch** | (no batch worker exists yet) | Durable cursor in `sync_runtime_state` (db/125) + a `sync_locks` lease so only one process runs a pass portfolio-wide; items claimed individually; the next tick resumes from the cursor | **Open — the batch resumes** | Precisely `src/lib/sharepoint-backup.js`'s shape: `acquireLease`/`renewLease`/`releaseLease`, a bounded self-draining pass, a resumable cursor. A death loses at most one in-flight item, and that item is re-derivable. |
| **Two workers race** | — | `pg_advisory_lock(hashtextextended('elx-batch:<batchId>',0))` on its own pooled connection, released in a `finally` | **Open on the lock** (proceed if it cannot be taken) | Copy `src/sitewire/orchestrator.js` and the condition engine's per-file lock: a missed lock costs one duplicate lookup a cache will absorb, while refusing to run would stall the batch. |
| **Ledger unreadable** | `overBudgetShared` fails **OPEN** for everyone | **Interactive: keep failing OPEN. Batch/background: fail CLOSED and retry next tick** | **Split by class** | §8. |
| **Money count unreadable** | `paid_cap_unknown`, refuses | Unchanged | **CLOSED** | Spending what we cannot count is the expensive direction. Do not touch this. |
| **Cache table unreadable** | `catch (_)` → treated as a miss, the lookup proceeds | Unchanged | **Open** | A cache miss is just a lookup. Correct as written. |
| **Cache WRITE fails** | `.catch(() => {})` — silently swallowed | Keep swallowing, but **count it** | **Open** | A lost cache row costs one repeat call. But a *systematically* failing cache write turns a 60-property batch into a 10× budget overrun with no signal at all, so the count belongs on the health screen. |

---

## 7. Observability — answering "why did this batch stop?" and "are we about to run out?"

### The two questions, and what each needs

**"Why did this batch stop?"** needs four facts that are currently unrecordable:

1. **Which class spent the budget.** The ledger can say "400 calls in the last hour"; it cannot say
   "and 380 of them were the batch." Only the second sentence is actionable.
2. **The upstream status.** *"We started getting 429s at 14:10"* is the answer, and there is nowhere
   to put a status code today.
3. **Which batch.** A run id, so a reviewer can ask about *their* batch.
4. **The last refusal, per class,** with its timestamp and plain-English reason.

Four additive columns on `elementix_calls` (db/503), all nullable so nothing existing breaks:

```sql
ALTER TABLE elementix_calls ADD COLUMN IF NOT EXISTS priority     text;   -- interactive | batch | background
ALTER TABLE elementix_calls ADD COLUMN IF NOT EXISTS batch_id     uuid;   -- which run
ALTER TABLE elementix_calls ADD COLUMN IF NOT EXISTS http_status  int;    -- the vendor's status when known
ALTER TABLE elementix_calls ADD COLUMN IF NOT EXISTS duration_ms  int;
CREATE INDEX IF NOT EXISTS idx_elx_calls_batch ON elementix_calls(batch_id, created_at DESC) WHERE batch_id IS NOT NULL;
```

**"Are we about to run out?"** needs two numbers, and they answer about the two different ceilings:

- **Hourly:** calls in the last 60 minutes vs the cap, split by class — plus **the count of vendor
  429s in the last hour, which is the only signal PILOT can ever get about the rest of the
  organization's usage.** That number is the reason to raise or lower `ELEMENTIX_MAX_PER_HOUR`, and
  nothing else is.
- **Monthly:** paid credits used vs 1,000. `paidThisMonth()` already computes it.

### Three things that already exist and are simply not shown

Verified by reading the screen and the routes:

1. **`client.budget()` is returned by `GET /api/admin/elementix/status` and never rendered.**
   `ElementixActions` in `app-v2/src/screens/StaffApiHealth.jsx` fetches the status and shows only
   the connection state. The per-second/per-hour figures and `platformCeilingPerHour: 1000` are
   fetched and dropped on the floor.
2. **`paidThisMonth()` is exported and rendered nowhere.** The one number the owner actually cares
   about — *"I have only 1,000 per month"* — is not on any screen.
3. **Elementix is absent from the "Request limits" panel** because it has no `api_rate_limits` row.
   `RateLimitPanel` renders every row from `api-rate-limit.status()` with allowed/min, room left and
   "held back". **Adding the row (§4) puts Elementix on that panel for free** — that is the cheapest
   observability win available.

### The alerts, and who gets them

Reuse `src/lib/notification-digests.js`'s self-gating pattern by name: an `audit_log`-stamped `_gate`
that fires at most once per period across restarts and instances, and **fails closed** on a database
error (an alert that fires twice is noise; one that fires sixty times is worse).

| Alert | Trigger | Who | Cadence |
|---|---|---|---|
| **The batch stopped on a vendor refusal** | Circuit opened, or a batch item hit the `outage` class | The staffer who started the batch **and** the admins — they are the ones who decide whether to resume | Immediately, once per batch |
| **Credentials died mid-batch** | A 401 that survived the token refresh | Admins | Immediately, once |
| **Skip-trace credits ≥ 80% of the month** | `paidThisMonth().n >= 800` | **Super-admins only** — it is the owner's money | Once per month |
| **Held-back count climbing** | `api_rate_limits.waits` rising week over week | Admins, **in the weekly digest, not as an alarm** | Weekly |

**Do not alert on ordinary throttling.** A batch waiting its turn is the system working exactly as
designed. The ClickUp precedent is the right calibration: *"a climbing count is the signal to raise a
limit BEFORE a provider phones."*

### One more thing: the ledger has no retention, despite its own header

db/503's header says *"the rows are pruned by the same pass that writes them."* **No pruning code
exists** — verified by grep; the only `DELETE FROM elementix_calls` in the repo is in a test's
cleanup. At a sustained 400/hr that is roughly 290,000 rows a month, and `overBudgetShared`'s
`count(*)` walks a growing index forever. Add a prune, and make it asymmetric:

- **Free calls: keep 90 days.** Long enough for any "why did that batch stop" question.
- **PAID calls: keep forever.** They are the money audit trail, they are a tiny minority (that is why
  `idx_elx_calls_paid` is a partial index), and *"who used up the month's credits?"* must stay
  answerable years later — which is the whole reason the staff id is on every row.

---

## 8. Is fail-OPEN still right at bulk scale?

`overBudgetShared()` fails open, and its comment argues the case well. Here is that case, and the
case against, and the recommendation.

### For keeping it open

- **The overshoot is bounded and cheap.** The vendor enforces the ceiling anyway. Over-running costs
  a 429 and a retry. Nobody is billed. Compare that with the money cap, where the overshoot *is* the
  harm — which is exactly why that one fails closed.
- **The failure being guarded against is a bookkeeping hiccup, not a real problem.** A statement
  timeout on a `count(*)` says nothing whatsoever about how many calls we have made.
- **The blast radius of failing closed is a human.** A staffer on the phone with a borrower clicks
  Verify and is told "PILOT cannot read its own bookkeeping." That is an outage of a feature the team
  needs, caused by a database blip.
- **At interactive rates the overshoot is genuinely trivial.** A 30-second blip at 6–9 calls per
  click is a handful of extra calls.

### Against, at bulk scale

- **A batch is not one human, and the arithmetic changes by two orders of magnitude.** If the ledger
  is unreadable and the guard waves everything through, a 60-property batch at 80 calls each does not
  overshoot by six — it burns the organization's **entire hourly ceiling in minutes** and then keeps
  hammering a wall.
- **The blast radius inverts.** Failing open costs *"the whole company — every officer, every other
  tool on the account — loses Elementix for the rest of the hour."* Failing closed costs *"the batch
  pauses and picks up on the next tick."* A batch is by definition resumable. The person on the phone
  is not.
- **The justification quietly assumes the overshoot is small.** *"It costs at most a throughput
  overshoot against a limit the vendor enforces anyway"* is true when the caller is a human. When the
  caller is an unattended worker running for hours, the overshoot **is** the harm, and it is
  inflicted on people who did not start the batch.
- **A partial-run cache write makes it worse than a throughput problem.** Over-running produces 429s;
  429s currently reach the cache as `no_match` (§5.2). So failing open does not merely waste calls —
  it manufactures durable false negatives about borrowers' properties. That is a data-integrity
  failure wearing a rate-limit costume.

### Recommendation

> **Split the fail direction by priority class, and say so in the comment.**
>
> - `priority:'interactive'` → **keeps failing OPEN.** Unchanged, for every reason the current
>   comment gives. One human, one click, bounded overshoot.
> - `priority:'batch'` and `'background'` → **fail CLOSED.** An unreadable ledger pauses the batch,
>   which loses nothing, because a resumable cursor is exactly what makes that free.

This is the smallest honest change that answers both arguments, and it is the *same rule* the code
already applies — "do the cheap thing when you cannot read the count" — extended along a second axis
now that the caller can be a machine instead of a person. It needs no new mechanism:
`src/sitewire/orchestrator.js circuitCheck` already fails closed on an unreadable counter and throws
`retryable` so the durable queue re-attempts once the database recovers. Copy it by name.

**And the better end state, which makes most of this moot:** once the *gating* moves to the atomic
`api_rate_limits` bucket (§4), the check-then-act race disappears and the ledger stops being the
gate at all. It becomes the accountant (per-staffer attribution the vendor cannot give us), the money
cap (unchanged, still closed), and the alarm. The fail-direction question then only concerns the
*second* hard stop — the ledger's hourly count as a belt to the bucket's suspenders — which the batch
class should treat as closed and the interactive class as open, exactly as above.

---

## 9. The kill switches

The repo's convention is a `*_ENABLED` master, a separate `*_OUTBOUND_ENABLED`, and a `*_DRYRUN`.
Elementix is read-only, so there is no outbound *write* to gate — but the bulk layer creates the
equivalent and equally important distinction: **"a human asked" vs "the machine is spending on its
own."** That is what the new master switch is for.

| Switch | Default | What OFF does |
|---|---|---|
| `ELEMENTIX_ENABLED` | off | **Exists.** No lookups at all, interactive or batch. Every call returns `reason:'disabled'` with *"Turn them on from the API Health page."* |
| `ELEMENTIX_DRYRUN` | off | **Exists.** Logs the intended call, sends nothing. **Must additionally suppress every cache write** — see §5.3, where it currently poisons the cache with fabricated negatives. |
| **`ELEMENTIX_BULK_ENABLED`** | **off** | **NEW — the `*_OUTBOUND_ENABLED` analogue.** Off = the workbench still searches when a human presses the button, but **nothing runs unattended**. This is the switch that stops the machine spending on its own without taking the feature away from the team, and it is the one to reach for first in an incident. |
| **`ELEMENTIX_BULK_DRYRUN`** | off | **NEW.** Plan the batch, resolve the cache, and report **how many calls it WOULD spend** — without spending them. This is what tells somebody a 60-property batch costs 4,800 calls *before* it costs them. |
| `ELEMENTIX_MAX_PER_HOUR` | 400 | **Exists.** PILOT's share of the org ceiling. Do not raise until the 429 counter has sat at zero for a month with the batch running (§2). |
| **`ELEMENTIX_INTERACTIVE_RESERVE`** | 150 | **NEW.** Calls/hour a batch may never take. A floor for interactive, not a ceiling on it. |
| `ELEMENTIX_MAX_PER_SEC` | 3 | **Exists.** Local smoothing. Never binds at an hourly ceiling. |
| `ELEMENTIX_PAID_PER_MONTH` | 1000 | **Exists.** The money cap. Do not touch. |
| `API_RATE_LIMIT_DISABLED` | off | **Exists, global.** Worth saying out loud once Elementix joins `api_rate_limits`: this now also disables Elementix's *shared* pacing, leaving only the per-process bucket. It is an incident escape hatch, and it never means "unlimited" — but it does mean "per-instance again." |

Add `ELEMENTIX_BULK_ENABLED` and `ELEMENTIX_BULK_DRYRUN` to `src/lib/integrations/switches.js` so
both are flippable live from the API Health page with no redeploy, alongside the two that are there
already. `ELEMENTIX_BULK_ENABLED` should be marked `dangerous: true` — not because it writes to
Elementix (nothing does) but because it is the one that spends the whole company's shared allowance
unattended.

**Not a switch, and must never become one:** the paid contact enrichment. It is a per-person human
click through `paidActor`, it is absent from `lookups.js` entirely, and there is no global "on".

---

## 10. The architecture, in one place

### Components

```
                              ┌─────────────────────────────────────────┐
  a staffer clicks Verify ───▶│  priority: 'interactive'   floor 0      │
                              ├─────────────────────────────────────────┤
  the bulk import worker ────▶│  priority: 'batch'         floor 150/hr │
                              ├─────────────────────────────────────────┤
  the cache-refresh sweep ───▶│  priority: 'background'    floor 240/hr │
                              └───────────────────┬─────────────────────┘
                                                  │
                          ┌───────────────────────▼────────────────────────┐
                          │  L1  CALL CACHE   call:v1:<tool>:<sha256 args> │  ← the big win
                          │      elementix_lookup_cache, cacheable only    │
                          └───────────────────────┬────────────────────────┘
                                       miss       │
                          ┌───────────────────────▼────────────────────────┐
                          │  L2  api_rate_limits('elementix')              │
                          │      atomic UPDATE … WHERE refilled >= 1+floor │
                          │      shared by every instance + the worker     │
                          │      FAILS OPEN (per-process bucket still on)  │
                          └───────────────────────┬────────────────────────┘
                          ┌───────────────────────▼────────────────────────┐
                          │  L3  elementix_calls hourly count (belt)       │
                          │      interactive → OPEN · batch → CLOSED       │
                          └───────────────────────┬────────────────────────┘
                          ┌───────────────────────▼────────────────────────┐
                          │  L4  PAID branch: paidThisMonth() FAILS CLOSED │
                          │      recordPaid() BEFORE the call              │
                          └───────────────────────┬────────────────────────┘
                                                  ▼
                                     src/elementix/client.js  →  MCP
                                                  │
                          ┌───────────────────────▼────────────────────────┐
                          │  parse {code,status,retryable} out of isError  │
                          │  429 → circuit opens, requeue on `outage`,     │
                          │        NOTHING written to the cache            │
                          │  recordCall() — the SOLE ledger writer         │
                          └────────────────────────────────────────────────┘
```

### The priority classes, restated as a rule

**interactive click > queued batch > background refresh.** Interactive may spend to empty; batch must
leave 150/hr behind; background must leave 240/hr. Interactive keeps failing open; the other two fail
closed. A caller that does not name its class is treated as interactive, and a source test asserts
the bulk modules always name themselves — the `paidActor` discipline, applied to time instead of
money.

### Patterns reused by name (nothing here is invented)

| Need | Existing pattern |
|---|---|
| Cross-process rate budget | `src/lib/api-rate-limit.js` + `db/482_api_rate_limits.sql` |
| Atomic consume-with-refill | db/482's `UPDATE … WHERE (refilled) >= 1 RETURNING` |
| Fail-closed counter that throws `retryable` | `src/sitewire/orchestrator.js circuitCheck` |
| Patient retry for a throttle | `src/sync/clickup-sync.js` — the `outage` class (10-min spacing, 40 attempts) |
| One process per pass, portfolio-wide | `src/lib/sharepoint-backup.js acquireLease/renewLease/releaseLease` on `sync_locks` |
| Resumable cursor | `sync_runtime_state` (db/125), as `profile-sweep.js` and `reread-sweep.js` use it |
| Bounded, self-draining pass | `sharepoint-backup.js`, `xml-sweep.js` |
| Per-file serialisation | `pg_advisory_lock(hashtextextended(key,0))` on its own connection, released in `finally` |
| Self-gating once-per-period alert | `notification-digests.js` `_gate` (audit-stamped, fails closed) |
| "Never cache a non-answer" | `address_canon_cache` (db/124) + db/498's GENERATED `cacheable` |
| A switch nobody can satisfy by accident | `paidActor {staffId, personId, reason}` |

---

## 11. Prioritized build list

**Tier 0 — bugs that are live right now, and two of them corrupt data.** Do these regardless of
whether bulk ever ships.

1. **Stop caching a partial run as a definitive answer.** Any errored step ⇒ `status='error'`,
   non-cacheable. `verify-run.cacheResult`'s `failedOutright` is too narrow. *(§5.2 — this writes
   permanent false negatives about borrowers' properties today.)*
2. **Stop caching a dry-run as `no_match`.** If any step carried `dryRun`, write nothing.
   *(§5.3 — turning on a diagnostic switch poisons the cache for 21 days.)*
3. **Read `retry-after` in `post()` and parse `{code,status,retryable}` out of the tool-error text.**
   Add `reason:'vendor_rate_limited'`, distinct from PILOT's own `'rate_limited'`. *(§3 — the vendor
   is already telling us both things and we discard them. Until this lands, nobody can even know
   whether Elementix sends `Retry-After`.)*
4. **Record and throttle the handshake and `listTools`.** `ensureSession`'s two POSTs and
   `tools/list` are real requests against the org ceiling and are counted by nothing. *(§1.)*

**Tier 1 — the envelope the bulk pipelines need before they can run at all.**

5. **Add the `elementix` row to `api_rate_limits`** + the `DEFAULTS` entry. Also puts Elementix on
   the health screen's Request-limits panel for free. *(§4, §7.)*
6. **Add the `reserve` floor parameter to `takeShared`/`acquire`** — three lines, no migration —
   and the three priority classes. *(§4.)*
7. **Thread `opts.priority` through `callTool` → `lookups.call` → the workers**, defaulting to
   `interactive`, with the source-grep test asserting the bulk modules name themselves. *(§4.)*
8. **Split the fail direction of `overBudgetShared` by class:** interactive open, batch/background
   closed, and rewrite the comment to say why the two differ. *(§8.)*
9. **429 handling:** circuit opens, batch requeues on the `outage` class, interactive fails at once
   with a real "try again in N minutes" from the ledger, decorrelated jitter everywhere a wait is
   computed. *(§3.)*

**Tier 2 — what makes bulk affordable rather than merely possible.**

10. **The CALL-level cache** (`call:v1:<tool>:<sha256 args>`). No migration. **~10× on a
    multi-property, single-entity borrower.** *(§5 — the highest-leverage item in this document.)*
11. **Cache `get_document` forever**, and `match_address`/`match_entity` on long TTLs. *(§5.)*
12. **Group the batch by entity, not by property**, and run it ahead of the reviewer so the workbench
    renders from cache at zero cost. *(§5 — and it answers the blueprint's own open question.)*
13. **The batch worker's durable shape:** `sync_locks` lease + `sync_runtime_state` cursor + bounded
    self-draining pass + per-batch advisory lock. *(§6.)*

**Tier 3 — seeing it, and switching it off.**

14. **Four columns on `elementix_calls`** (`priority`, `batch_id`, `http_status`, `duration_ms`) +
    the partial index. Without them "why did this batch stop?" has no answer. *(§7.)*
15. **Render what already exists:** `client.budget()`, `paidThisMonth()`, and a
    **vendor-429-count-this-hour** tile — the only window PILOT will ever have onto the rest of the
    organization's usage. *(§7.)*
16. **`ELEMENTIX_BULK_ENABLED` + `ELEMENTIX_BULK_DRYRUN` + `ELEMENTIX_INTERACTIVE_RESERVE`**, all in
    `switches.js` so they flip live. *(§9.)*
17. **The four alerts**, on the `notification-digests` self-gate. *(§7.)*
18. **Ledger retention:** prune free rows at 90 days, keep paid rows forever. db/503's header already
    promises a prune that does not exist. *(§7.)*

**Tier 4 — refinement, once there is data to tune against.**

19. **Coverage-aware empty-TTL:** shorten `FRESH_DAYS_EMPTY` for a county whose `latestRecordingDate`
    is stale. `get_coverage` is free and already wrapped. *(§5.)*
20. **Event-invalidate the `ambiguous` cache** when a human confirms or rejects an
    `elementix_address_links` row, instead of expiring it on a timer. *(§5.)*
21. **Revisit `ELEMENTIX_MAX_PER_HOUR`** only after the 429 counter has read zero for a month with
    the batch running. *(§2.)*

---

## 12. The one-paragraph version, for the two sibling pipelines

You have **1,000 calls an hour for the entire company**, shared with production and with every other
tool on the account, of which PILOT self-caps at 400 and a batch may use 250. That is **4 calls a
minute**, so a 60-property batch is measured in hours and must be a background worker with a durable
cursor — never a request, never a call per row as a screen renders. Budget **6–9 calls per property**
and design to reuse: **group by entity, not by property**, because one LLC's deed list answers forty
properties and a call-level cache makes the second through fortieth nearly free. **Never spend a
credit** — the enrichment tool is not reachable and must stay that way. And whatever you do, when a
lookup fails, **do not let the answer be recorded as "nothing found"**: that is the one mistake this
system cannot take back.
