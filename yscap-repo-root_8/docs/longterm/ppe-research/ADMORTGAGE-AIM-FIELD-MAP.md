# AD Mortgage (AIM Quick Pricer) — the measured field map

**What this is.** Every field of AD Mortgage's Quick Pricer, across all five program groups: its id,
its type, its default, **the exact form the value takes on the wire**, and every option id. Plus the
DSCR-ratio mapping and the three distinct ways the engine says "no".

**How it was established.** Live, against `https://aim.admortgage.com`, on 2026-08-31, with a broker
login. Every table below is generated from the API's own schema responses; every rule in the prose
was confirmed by a live call that either priced or failed. Nothing here is inferred from the
frontend bundle. A browser HAR of a real pricing session was used only to settle one question —
how the DTI dropdown transmits "Not required" — and it agreed with the live probe.

**Regenerate** rather than hand-edit: `scripts/aim-dump-schemas.js` writes the JSON this is built
from. AD's option ids are stable across the capture and the HAR (four days apart) but they are the
vendor's to change.

---

## 1. Session

Four calls, cookie-based. No OAuth, no client secret, no bearer token, no refresh.

```
POST /api/user/login            {"email","password"}  -> 200 {"data":true}
                                 sets: api-session, .AspNetCore.Cookies
GET  /api/user/auth-state       -> the account, its org, its business channels
GET  /api/user/accounts         -> [{orgId, accountId}]
POST /api/user/account/{orgId}/{accountId}   {}   -> selects the org
```

Two things measured that the browser's behaviour hides:

- **Org selection is not required to price.** `calculate` returns 200 before that POST is made.
  The browser always sends it; a headless client does not have to.
- **`passwordExpired: true` does not gate the API.** The account in this capture is flagged for a
  password change and prices anyway. Do not treat that flag as a health signal.

Session cookies were reused across 12+ sequential pricing calls with no re-auth. Warm latency
median **249 ms** (min 218, max 367); cold first call ~570 ms.

---

## 2. The three call shapes

| Call | Purpose | Needed by a backend client? |
|---|---|---|
| `GET /api/qp/api/v1/extended/program-groups` | the five groups | once |
| `GET /api/qp/api/v1/extended/program-groups/{gid}` | **the entire form schema** — fields, types, defaults, every option | once per group, cacheable |
| `GET …/{gid}/restrictions?{same query}` | same shape, with `disabled` + `message` recomputed for the scenario | **optional** |
| `GET …/{gid}/calculate?{query}` | pricing | per scenario |

`restrictions` is what greys out impossible options in the UI — the browser called it **46 times**
in one session, on nearly every keystroke. A backend client can skip it entirely. It is useful for
one thing only: telling a user *in advance* which options are dead, rather than letting `calculate`
refuse afterwards.

The query string is identical for `restrictions` and `calculate`: **one parameter per field id**.

---

## 3. How a value goes on the wire — the rule that matters

This is the part that is not obvious from the schema, and the part that breaks a naive client.

A field's `type` decides the encoding, and **`list`/`boolean` behave differently from `interval`**:

| `type` | Send | Example |
|---|---|---|
| `list` | the **option id** | Occupancy Investment → `6=176` |
| `boolean` | the **option id** (they are ids, not `true`/`false`) | Interest Only "no" → `9=192` |
| `text` | the literal string | ZIP → `29=07036` |
| `interval` | **the raw number**, within `min`–`max` | FICO 740 → `16=740` |

### The interval sentinel — the DTI trap

An `interval` field may also carry a `values[]` array. On screen that array is a **dropdown entry**
— DTI shows *"Not required"*, FICO shows *"No FICO"*. It looks exactly like a `list` option, and it
has an id. **That id is not what gets sent.**

The sentinel is transmitted as the number **`0`**. Measured, every way:

```
12=0      -> 200   prices
12=256    -> 422   {"DTI":["Can not find interval value '256' in program group."]}      <- the option id
12=""     -> 422   {"DTI":["Invalid value format '' in interval property."]}
12=1      -> 400   "To get at least one available program, change: DSCR >= 1.25 or DTI 00.00% - 43.00%."
(omitted) -> 200   prices — but see below
```

The browser agrees. In the HAR, the moment a DSCR income type was chosen the DTI parameter flipped
`12=1` → `12=0`, and the 400 became a 200:

```
5=169 & 12=1  ->  400   (18 restrictions calls, no successful price)
5=169 & 12=0  ->  200   (4 successful prices)
```

Same rule for FICO: `16=0` is *"No FICO"* — it is parsed and reaches the rules engine, which then
answers `"change: No FICO or US Citizen / Permanent Resident"`. The option id `290` is a 422.

**Omitting an interval is not a substitute.** DTI happens to tolerate omission; FICO does not —
`16` omitted returns `422 {"FICO":["Required property is missing."]}`. Send `0`, always.

> **The rule to implement:** for an `interval` field, send an integer in `[min, max]`, or `0` to mean
> whatever its single `values[]` entry is labelled. Never send that entry's `id`.

### Every field must be present

All 26–27 parameters go on every call (County excepted — see §4). Build the query by starting from
the schema's own `value` defaults and overlaying the scenario. That round-trips: the baseline call
in each table below is generated from nothing but the group's defaults, and each one prices.

---

## 4. County is the one dynamic field

`County` arrives with `values: []` and no default. It is fetched per state:

```
GET /api/qp/api/v1/dictionaries/counties?filter={stateOptionId}
```

`filter` takes the **State option id** (e.g. `194` = Alabama), not a FIPS code or a postal
abbreviation. Omitting `35` from the query is accepted and prices. `GET /dictionaries/states`
returns a bare count (`{"data":224}`), not a list — the usable state list is the `State` field's
own `values[]` in the group schema.

---

## 5. What actually selects a program

Three different fields do three different jobs. Conflating them is the main modelling error to avoid.

| Field | Role | Effect |
|---|---|---|
| **Income Type** (`5`) | selects the **product family** | Full-doc types → the Apex/Super/Prime tier stack; a DSCR band → the DSCR program |
| **Loan Term** (`2`) | selects the **amortisation variant** | `3`→`DSCR 30 Year Fixed`, `2`→`DSCR 40 Year Fixed`, `8`→`DSCR 5/6 ARM`, `9`→`DSCR 7/6 ARM` |
| **DSCR band** (a value of Income Type) | **price adjustment only** | never changes which program comes back |

Measured — Income Type against the returned program set (primary-residence defaults):

| Income Type | Programs returned |
|---|---|
| `160` 2Y Full Doc, `161` 1Y Full Doc, `162` 24mo Bank Stmt, `163` 12mo Bank Stmt, `166` Asset Utilization, `168` 1099 | Apex Prime, Super Prime, Prime |
| `164` 2Y P&L Only, `165` 1Y P&L Only, `167` WVOE | Super Prime, Prime *(no Apex)* |
| `169`–`173` DSCR bands | DSCR *(single program)* |
| `174` Foreign income | 400 — `"change: Foreign income"` |

Loan Term is orthogonal and applies within the family, so the full program name is
`{family} {term}` — e.g. `DSCR 7/6 ARM`.

---

## 6. The DSCR ratio → band mapping

There is **no numeric DSCR input.** The ratio is not sent. You compute it, bucket it, and send the
bucket's option id as Income Type (`5`).

| Computed DSCR | Send `5=` | Label |
|---|---|---|
| ≥ 1.25 | `169` | DSCR >= 1.25 |
| 1.10 – 1.24 | `170` | DSCR 1.10 - 1.24 |
| 1.00 – 1.09 | `171` | DSCR 1.00 - 1.09 |
| 0.75 – 0.99 | `172` | DSCR 0.75 - 0.99 |
| < 0.75 | `173` | DSCR < 0.75 |

```js
// Round to 2dp FIRST, then bucket — the bands are expressed to 2dp and are contiguous
// only after rounding. 1.247 -> 1.25 -> band 169. See the caution below.
function dscrBand(ratio) {
  const r = Math.round(Number(ratio) * 100) / 100;
  if (r >= 1.25) return 169;
  if (r >= 1.10) return 170;
  if (r >= 1.00) return 171;
  if (r >= 0.75) return 172;
  return 173;
}
// ALWAYS pair with DTI = 0 ("Not required"); any other DTI 400s on a DSCR band.
```

> **Caution — the rounding rule is mine, not AD's.** The published bands leave gaps between
> `1.24` and `1.25`, and between `0.99` and `1.00`. Rounding to 2dp closes them, but AD has not
> confirmed that is what their sheet does. A deal at 1.245 or 0.995 sits exactly on that seam.
> Worth one email to AD before this prices a live term sheet.

### Measured band pricing

Investment · 1-unit SFR · purchase · 740 FICO · 75 CLTV · $750,000 · 5Y PPP · 30-day lock · `12=0`.
Every band returned the same program — `DSCR 30 Year Fixed` — at a different price:

| Band | Par rate | Points | Payment | totalAdj | DSCR adjustment line |
|---|---|---|---|---|---|
| `169` ≥ 1.25 | 6.125 | 0.375 | $4,557.08 | 0.375 | `DSCR >= 1.25 / LTV 70.01-75.00 = 0.250` |
| `170` 1.10–1.24 | 6.250 | −0.125 | $4,617.88 | 0.125 | *(none — this is the base)* |
| `171` 1.00–1.09 | 6.250 | −0.125 | $4,617.88 | 0.125 | *(none — this is the base)* |
| `172` 0.75–0.99 | 6.490 | 0.250 | $4,735.58 | −1.375 | `DSCR 0.75 - 0.99 / LTV 70.01-75.00 = -1.500` |
| `173` < 0.75 | 6.250 | −0.125 | $4,617.88 | 0.125 | `DSCR < 0.75 / LTV 70.01-75.00 = 0.000` |

Two things to notice:

1. **`170` and `171` are priced identically** and carry no DSCR line at all — they are the sheet's
   base case. A UI that promises "better DSCR, better price" between those two is promising
   something the sheet does not deliver.
2. **`173` (< 0.75) prices *better* than `172` (0.75–0.99)** — an explicit `0.000` adjustment where
   the band above it takes a −1.500 hit. That is very likely a gap in AD's rate sheet rather than
   an intended concession. **Do not surface a sub-0.75 DSCR quote to a borrower without checking
   with AD first.** Flagged, not worked around — inventing a hit here would be inventing pricing.

---

## 7. Full field tables

**`Param`** is the query-string key. Rows are in the screen's display order, which is *not* id order.

### Non-QM — group `33001` (27 fields)

| Param | Field | Type | Default | Send as | Options |
|-------|-------|------|---------|---------|---------|
| **`6`** | Occupancy | `list` | `175` | option id | `175`=Primary Residence, `177`=2nd Home, `176`=Investment |
| **`8`** | Property Type | `list` | `183` | option id | `183`=1 Unit SFR, `184`=SFR Rural, `185`=PUD, `528`=PUD Rural, `186`=Condo, `187`=2-4 Units, `188`=Condotel |
| **`13`** | Number of Units | `list` | `257` | option id | `257`=1 Unit, `258`=2 Units, `259`=3 Units, `260`=4 Units |
| **`29`** | ZIP | `text` | `_____` | literal text | default mask `_____` |
| **`10`** | State | `list` | `194` | option id | `194`=Alabama [AL], `195`=Alaska [AK], `196`=Arizona [AZ], … (50 total — see §8) |
| **`35`** | County | `list` | `—` | option id | _dynamic_ — see §4 |
| **`26`** | New Construction | `boolean` | `399` | option id | `399`=0, `400`=1 |
| **`44`** | Channel | `list` | `437` | option id | `437`=Wholesale, `438`=Correspondent Plus, `439`=Correspondent |
| **`4`** | Citizenship | `list` | `155` | option id | `155`=US Citizen / Permanent Resident, `156`=Non-Permanent Resident, `157`=Foreign national, `158`=ITIN |
| **`7`** | Purpose | `list` | `178` | option id | `178`=Purchase, `179`=Rate/Term Refinance, `180`=Cashout |
| **`16`** | FICO | `interval` | `720` | integer `620`–`850` | **`0`** = _No FICO_ — sentinel, **not** id `290` |
| **`2`** | Loan Term | `list` | `3` | option id | `3`=30 Year Fixed, `2`=40 Year Fixed, `8`=5/6 ARM SOFR, `9`=7/6 ARM SOFR |
| **`5`** | Income Type | `list` | `160` | option id | `160`=2Y Full Doc, `161`=1Y Full Doc, `162`=24 Months Bank Statement, `163`=12 Months Bank Statement, `164`=2Y P&L Only, `165`=1Y P&L Only, `166`=Asset Utilization, `167`=WVOE, `168`=1099, `169`=DSCR >= 1.25, `170`=DSCR 1.10 - 1.24, `171`=DSCR 1.00 - 1.09, `172`=DSCR 0.75 - 0.99, `173`=DSCR < 0.75, `174`=Foreign income |
| **`12`** | DTI | `interval` | `1` | integer `1`–`55` | **`0`** = _Not required_ — sentinel, **not** id `256` |
| **`18`** | Lock Period | `list` | `366` | option id | `366`=30 Days, `365`=15 Days, `367`=45 Days, `368`=60 Days |
| **`17`** | Loan Amount | `interval` | `500001` | integer `75000`–`5000000` | — |
| **`45`** | Compensation type | `list` | `440` | option id | `440`=Borrower Paid, `441`=Lender Paid |
| **`15`** | CLTV | `interval` | `70` | integer `1`–`90` | — |
| **`14`** | Prepayment Penalty | `list` | `265` | option id | `265`=No PPP, `266`=6m PPP, `267`=1Y PPP, `268`=2Y PPP, `269`=3Y PPP, `270`=4Y PPP, `271`=5Y PPP |
| **`25`** | Escrow Waiver | `boolean` | `397` | option id | `397`=0, `398`=1 |
| **`28`** | Admin Fee Buyout | `boolean` | `403` | option id | `403`=0, `404`=1 |
| **`22`** | FTHB | `boolean` | `391` | option id | `391`=0, `392`=1 |
| **`23`** | Mortgage History | `list` | `529` | option id | `529`=0x30x24, `393`=0x30x12, `394`=0x60x12 |
| **`9`** | Interest Only | `boolean` | `192` | option id | `192`=0, `193`=1 |
| **`21`** | Short Term Rental | `boolean` | `389` | option id | `389`=0, `390`=1 |
| **`24`** | Credit Event | `list` | `395` | option id | `395`=48+ months, `530`=36 - 48 months, `396`=< 36 months |
| **`34`** | Temporary Buydown | `list` | `427` | option id | `427`=None, `424`=3-2-1, `425`=2-1, `426`=1-0 |

Baseline — built from nothing but this group's own defaults, and it prices:

```
GET /api/qp/api/v1/extended/program-groups/33001/calculate?6=175&8=183&13=257&29=_____&10=194&26=399&44=437&4=155&7=178&16=720&2=3&5=160&12=1&18=366&17=500001&45=440&15=70&14=265&25=397&28=403&22=391&23=529&9=192&21=389&24=395&34=427
```

### Non-QM Second Lien — group `33015` (24 fields)

| Param | Field | Type | Default | Send as | Options |
|-------|-------|------|---------|---------|---------|
| **`6`** | Occupancy | `list` | `175` | option id | `175`=Primary Residence, `177`=2nd Home, `176`=Investment |
| **`8`** | Property Type | `list` | `183` | option id | `183`=1 Unit SFR, `185`=PUD, `186`=Condo, `187`=2-4 Units |
| **`13`** | Number of Units | `list` | `257` | option id | `257`=1 Unit, `258`=2 Units, `259`=3 Units, `260`=4 Units |
| **`29`** | ZIP | `text` | `_____` | literal text | default mask `_____` |
| **`10`** | State | `list` | `194` | option id | `194`=Alabama [AL], `195`=Alaska [AK], `196`=Arizona [AZ], … (50 total — see §8) |
| **`35`** | County | `list` | `—` | option id | _dynamic_ — see §4 |
| **`26`** | New Construction | `boolean` | `399` | option id | `399`=0, `400`=1 |
| **`44`** | Channel | `list` | `437` | option id | `437`=Wholesale, `438`=Correspondent Plus, `439`=Correspondent |
| **`4`** | Citizenship | `list` | `155` | option id | `155`=US Citizen / Permanent Resident, `156`=Non-Permanent Resident, `157`=Foreign national |
| **`7`** | Purpose | `list` | `178` | option id | `178`=Purchase, `179`=Rate/Term Refinance, `180`=Cashout |
| **`16`** | FICO | `interval` | `720` | integer `680`–`850` | **`0`** = _No FICO_ — sentinel, **not** id `290` |
| **`2`** | Loan Term | `list` | `3` | option id | `3`=30 Year Fixed, `5`=20 Year Fixed, `6`=15 Year Fixed, `7`=10 Year Fixed |
| **`5`** | Income Type | `list` | `159` | option id | `159`=Full Doc, `162`=24 Months Bank Statement, `163`=12 Months Bank Statement, `166`=Asset Utilization, `167`=WVOE, `168`=1099, `169`=DSCR >= 1.25, `170`=DSCR 1.10 - 1.24, `171`=DSCR 1.00 - 1.09, `174`=Foreign income |
| **`12`** | DTI | `interval` | `1` | integer `1`–`50` | **`0`** = _Not required_ — sentinel, **not** id `256` |
| **`18`** | Lock Period | `list` | `366` | option id | `366`=30 Days, `365`=15 Days, `367`=45 Days, `368`=60 Days |
| **`17`** | Loan Amount | `interval` | `69501` | integer `50000`–`500000` | — |
| **`45`** | Compensation type | `list` | `440` | option id | `440`=Borrower Paid, `441`=Lender Paid |
| **`15`** | CLTV | `interval` | `70` | integer `1`–`90` | — |
| **`14`** | Prepayment Penalty | `list` | `265` | option id | `265`=No PPP, `266`=6m PPP, `267`=1Y PPP, `268`=2Y PPP, `269`=3Y PPP, `270`=4Y PPP, `271`=5Y PPP |
| **`28`** | Admin Fee Buyout | `boolean` | `403` | option id | `403`=0, `404`=1 |
| **`22`** | FTHB | `boolean` | `391` | option id | `391`=0, `392`=1 |
| **`23`** | Mortgage History | `list` | `393` | option id | `393`=0x30x12 |
| **`21`** | Short Term Rental | `boolean` | `389` | option id | `389`=0, `390`=1 |
| **`24`** | Credit Event | `list` | `395` | option id | `395`=48+ months |

Baseline — built from nothing but this group's own defaults, and it prices:

```
GET /api/qp/api/v1/extended/program-groups/33015/calculate?6=175&8=183&13=257&29=_____&10=194&26=399&44=437&4=155&7=178&16=720&2=3&5=159&12=1&18=366&17=69501&45=440&15=70&14=265&28=403&22=391&23=393&21=389&24=395
```

### Jumbo — group `33087` (23 fields)

| Param | Field | Type | Default | Send as | Options |
|-------|-------|------|---------|---------|---------|
| **`6`** | Occupancy | `list` | `175` | option id | `175`=Primary Residence, `177`=2nd Home, `176`=Investment |
| **`8`** | Property Type | `list` | `183` | option id | `183`=1 Unit SFR, `185`=PUD, `186`=Condo, `187`=2-4 Units |
| **`13`** | Number of Units | `list` | `257` | option id | `257`=1 Unit, `258`=2 Units, `259`=3 Units, `260`=4 Units |
| **`29`** | ZIP | `text` | `_____` | literal text | default mask `_____` |
| **`10`** | State | `list` | `194` | option id | `194`=Alabama [AL], `195`=Alaska [AK], `196`=Arizona [AZ], … (50 total — see §8) |
| **`35`** | County | `list` | `—` | option id | _dynamic_ — see §4 |
| **`44`** | Channel | `list` | `437` | option id | `437`=Wholesale, `438`=Correspondent Plus, `439`=Correspondent |
| **`4`** | Citizenship | `list` | `155` | option id | `155`=US Citizen / Permanent Resident, `156`=Non-Permanent Resident |
| **`7`** | Purpose | `list` | `178` | option id | `178`=Purchase, `179`=Rate/Term Refinance, `180`=Cashout |
| **`16`** | FICO | `interval` | `720` | integer `660`–`850` | — |
| **`2`** | Loan Term | `list` | `3` | option id | `3`=30 Year Fixed, `6`=15 Year Fixed, `8`=5/6 ARM SOFR, `9`=7/6 ARM SOFR, `10`=10/6 ARM SOFR |
| **`5`** | Income Type | `list` | `159` | option id | `159`=Full Doc |
| **`12`** | DTI | `interval` | `1` | integer `1`–`50` | — |
| **`18`** | Lock Period | `list` | `366` | option id | `366`=30 Days, `365`=15 Days, `367`=45 Days, `368`=60 Days |
| **`17`** | Loan Amount | `interval` | `832752` | integer `832752`–`5000000` | — |
| **`45`** | Compensation type | `list` | `440` | option id | `440`=Borrower Paid, `441`=Lender Paid |
| **`15`** | HCLTV | `interval` | `70` | integer `1`–`90` | — |
| **`14`** | Prepayment Penalty | `list` | `265` | option id | `265`=No PPP, `266`=6m PPP, `267`=1Y PPP, `268`=2Y PPP, `269`=3Y PPP, `270`=4Y PPP, `271`=5Y PPP |
| **`25`** | Escrow Waiver | `boolean` | `397` | option id | `397`=0, `398`=1 |
| **`28`** | Admin Fee Buyout | `boolean` | `403` | option id | `403`=0, `404`=1 |
| **`22`** | FTHB | `boolean` | `391` | option id | `391`=0, `392`=1 |
| **`37`** | Self Employed | `boolean` | `428` | option id | `428`=0, `429`=1 |
| **`34`** | Temporary Buydown | `list` | `427` | option id | `427`=None, `424`=3-2-1, `425`=2-1, `426`=1-0 |

Baseline — built from nothing but this group's own defaults, and it prices:

```
GET /api/qp/api/v1/extended/program-groups/33087/calculate?6=175&8=183&13=257&29=_____&10=194&44=437&4=155&7=178&16=720&2=3&5=159&12=1&18=366&17=832752&45=440&15=70&14=265&25=397&28=403&22=391&37=428&34=427
```

### Conventional — group `33154` (27 fields)

| Param | Field | Type | Default | Send as | Options |
|-------|-------|------|---------|---------|---------|
| **`6`** | Occupancy | `list` | `175` | option id | `175`=Primary Residence, `177`=2nd Home, `176`=Investment |
| **`8`** | Property Type | `list` | `183` | option id | `183`=1 Unit SFR, `185`=PUD, `453`=Condo Attached, `454`=Condo Semi-detached, `452`=Condo Detached, `187`=2-4 Units, `455`=Manufactured Single-wide, `456`=Manufactured Multi-wide |
| **`13`** | Number of Units | `list` | `257` | option id | `257`=1 Unit, `258`=2 Units, `259`=3 Units, `260`=4 Units |
| **`29`** | ZIP | `text` | `_____` | literal text | default mask `_____` |
| **`10`** | State | `list` | `194` | option id | `194`=Alabama [AL], `195`=Alaska [AK], `196`=Arizona [AZ], … (51 total — see §8) |
| **`35`** | County | `list` | `—` | option id | _dynamic_ — see §4 |
| **`52`** | MI rate type | `list` | `446` | option id | `446`=Monthly, `447`=Single |
| **`53`** | MI coverage | `list` | `449` | option id | `449`=Standard, `450`=Custom |
| **`38`** | Multi Borrower | `boolean` | `430` | option id | `430`=0, `431`=1 |
| **`44`** | Channel | `list` | `437` | option id | `437`=Wholesale, `438`=Correspondent Plus, `439`=Correspondent |
| **`4`** | Citizenship | `list` | `155` | option id | `155`=US Citizen / Permanent Resident, `156`=Non-Permanent Resident |
| **`7`** | Purpose | `list` | `178` | option id | `178`=Purchase, `179`=Rate/Term Refinance, `180`=Cashout |
| **`19`** | Program Type | `list` | `370` | option id | `370`=Standard, `371`=Home Ready, `372`=Home Possible, `373`=Refi Now, `374`=Refi Possible |
| **`16`** | FICO | `interval` | `720` | integer `620`–`850` | — |
| **`2`** | Loan Term | `list` | `3` | option id | `3`=30 Year Fixed, `4`=25 Year Fixed, `5`=20 Year Fixed, `6`=15 Year Fixed, `7`=10 Year Fixed, `8`=5/6 ARM SOFR, `9`=7/6 ARM SOFR, `10`=10/6 ARM SOFR |
| **`12`** | DTI | `interval` | `1` | integer `1`–`65` | — |
| **`18`** | Lock Period | `list` | `366` | option id | `366`=30 Days, `365`=15 Days, `367`=45 Days, `368`=60 Days |
| **`17`** | Loan Amount | `interval` | `50000` | integer `50000`–`2402625` | — |
| **`45`** | Compensation type | `list` | `440` | option id | `440`=Borrower Paid, `441`=Lender Paid |
| **`15`** | CLTV | `interval` | `70` | integer `1`–`97` | — |
| **`25`** | Escrow Waiver | `boolean` | `397` | option id | `397`=0, `398`=1 |
| **`28`** | Admin Fee Buyout | `boolean` | `403` | option id | `403`=0, `404`=1 |
| **`22`** | FTHB | `boolean` | `391` | option id | `391`=0, `392`=1 |
| **`59`** | LLPA Waiver | `boolean` | `499` | option id | `499`=0, `500`=1 |
| **`27`** | High Balance | `boolean` | `401` | option id | `401`=0, `402`=1 |
| **`11`** | Sub Financing | `boolean` | `248` | option id | `248`=0, `249`=1 |
| **`34`** | Temporary Buydown | `list` | `427` | option id | `427`=None, `424`=3-2-1, `425`=2-1, `426`=1-0 |

Baseline — built from nothing but this group's own defaults, and it prices:

```
GET /api/qp/api/v1/extended/program-groups/33154/calculate?6=175&8=183&13=257&29=_____&10=194&52=446&53=449&38=430&44=437&4=155&7=178&19=370&16=720&2=3&12=1&18=366&17=50000&45=440&15=70&25=397&28=403&22=391&59=499&27=401&11=248&34=427
```

### Government — group `33192` (23 fields)

| Param | Field | Type | Default | Send as | Options |
|-------|-------|------|---------|---------|---------|
| **`6`** | Occupancy | `list` | `175` | option id | `175`=Primary Residence |
| **`8`** | Property Type | `list` | `183` | option id | `183`=1 Unit SFR, `185`=PUD, `186`=Condo, `187`=2-4 Units, `189`=Manufactured housing, `456`=Manufactured Multi-wide |
| **`13`** | Number of Units | `list` | `257` | option id | `257`=1 Unit, `258`=2 Units, `259`=3 Units, `260`=4 Units |
| **`29`** | ZIP | `text` | `_____` | literal text | default mask `_____` |
| **`10`** | State | `list` | `194` | option id | `194`=Alabama [AL], `195`=Alaska [AK], `196`=Arizona [AZ], … (50 total — see §8) |
| **`35`** | County | `list` | `—` | option id | _dynamic_ — see §4 |
| **`52`** | MI rate type | `list` | `446` | option id | `446`=Monthly |
| **`44`** | Channel | `list` | `437` | option id | `437`=Wholesale, `438`=Correspondent Plus, `439`=Correspondent |
| **`4`** | Citizenship | `list` | `155` | option id | `155`=US Citizen / Permanent Resident |
| **`7`** | Purpose | `list` | `178` | option id | `178`=Purchase, `179`=Rate/Term Refinance, `180`=Cashout, `181`=Streamline Refinance, `182`=IRRRL |
| **`58`** | Government Program | `list` | `462` | option id | `462`=FHA, `463`=VA |
| **`19`** | Program Type | `list` | `370` | option id | `370`=Standard |
| **`16`** | FICO | `interval` | `720` | integer `580`–`850` | — |
| **`2`** | Loan Term | `list` | `3` | option id | `3`=30 Year Fixed, `5`=20 Year Fixed, `6`=15 Year Fixed |
| **`12`** | DTI | `interval` | `1` | integer `1`–`57` | — |
| **`18`** | Lock Period | `list` | `366` | option id | `366`=30 Days, `365`=15 Days, `367`=45 Days, `368`=60 Days |
| **`17`** | Loan Amount | `interval` | `110001` | integer `50000`–`2402625` | — |
| **`45`** | Compensation type | `list` | `440` | option id | `440`=Borrower Paid, `441`=Lender Paid |
| **`15`** | CLTV | `interval` | `70` | integer `1`–`110` | — |
| **`28`** | Admin Fee Buyout | `boolean` | `403` | option id | `403`=0, `404`=1 |
| **`27`** | High Balance | `boolean` | `401` | option id | `401`=0, `402`=1 |
| **`34`** | Temporary Buydown | `list` | `427` | option id | `427`=None, `424`=3-2-1, `425`=2-1, `426`=1-0 |
| **`30`** | UW Type | `list` | `405` | option id | `405`=AUS, `406`=Manual UW |

Baseline — built from nothing but this group's own defaults, and it prices:

```
GET /api/qp/api/v1/extended/program-groups/33192/calculate?6=175&8=183&13=257&29=_____&10=194&52=446&44=437&4=155&7=178&58=462&19=370&16=720&2=3&12=1&18=366&17=110001&45=440&15=70&28=403&27=401&34=427&30=405
```
---

## 8. The long option lists

**Non-QM · State** — param `10`, 50 options

`194`=Alabama [AL] · `195`=Alaska [AK] · `196`=Arizona [AZ] · `197`=Arkansas [AR] · `198`=California [CA] · `199`=Colorado [CO] · `200`=Connecticut [CT] · `201`=Delaware [DE] · `202`=District of Columbia [DC] · `203`=Florida [FL] · `204`=Georgia [GA] · `206`=Idaho [ID] · `207`=Illinois [IL] · `208`=Indiana [IN] · `209`=Iowa [IA] · `210`=Kansas [KS] · `211`=Kentucky [KY] · `212`=Louisiana [LA] · `213`=Maine [ME] · `214`=Maryland [MD] · `215`=Massachusetts [MA] · `216`=Michigan [MI] · `217`=Minnesota [MN] · `218`=Mississippi [MS] · `219`=Missouri [MO] · `220`=Montana [MT] · `221`=Nebraska [NE] · `222`=Nevada [NV] · `223`=New Hampshire [NH] · `224`=New Jersey [NJ] · `225`=New Mexico [NM] · `226`=New York [NY] · `227`=North Carolina [NC] · `228`=North Dakota [ND] · `229`=Ohio [OH] · `230`=Oklahoma [OK] · `231`=Oregon [OR] · `232`=Pennsylvania [PA] · `234`=Rhode Island [RI] · `235`=South Carolina [SC] · `236`=South Dakota [SD] · `237`=Tennessee [TN] · `238`=Texas [TX] · `239`=Utah [UT] · `240`=Vermont [VT] · `241`=Virginia [VA] · `242`=Washington [WA] · `243`=West Virginia [WV] · `244`=Wisconsin [WI] · `245`=Wyoming [WY]

**Non-QM Second Lien · State** — param `10`, 50 options

`194`=Alabama [AL] · `195`=Alaska [AK] · `196`=Arizona [AZ] · `197`=Arkansas [AR] · `198`=California [CA] · `199`=Colorado [CO] · `200`=Connecticut [CT] · `201`=Delaware [DE] · `202`=District of Columbia [DC] · `203`=Florida [FL] · `204`=Georgia [GA] · `206`=Idaho [ID] · `207`=Illinois [IL] · `208`=Indiana [IN] · `209`=Iowa [IA] · `210`=Kansas [KS] · `211`=Kentucky [KY] · `212`=Louisiana [LA] · `213`=Maine [ME] · `214`=Maryland [MD] · `215`=Massachusetts [MA] · `216`=Michigan [MI] · `217`=Minnesota [MN] · `218`=Mississippi [MS] · `219`=Missouri [MO] · `220`=Montana [MT] · `221`=Nebraska [NE] · `222`=Nevada [NV] · `223`=New Hampshire [NH] · `224`=New Jersey [NJ] · `225`=New Mexico [NM] · `226`=New York [NY] · `227`=North Carolina [NC] · `228`=North Dakota [ND] · `229`=Ohio [OH] · `230`=Oklahoma [OK] · `231`=Oregon [OR] · `232`=Pennsylvania [PA] · `234`=Rhode Island [RI] · `235`=South Carolina [SC] · `236`=South Dakota [SD] · `237`=Tennessee [TN] · `238`=Texas [TX] · `239`=Utah [UT] · `240`=Vermont [VT] · `241`=Virginia [VA] · `242`=Washington [WA] · `243`=West Virginia [WV] · `244`=Wisconsin [WI] · `245`=Wyoming [WY]

**Jumbo · State** — param `10`, 50 options

`194`=Alabama [AL] · `195`=Alaska [AK] · `196`=Arizona [AZ] · `197`=Arkansas [AR] · `198`=California [CA] · `199`=Colorado [CO] · `200`=Connecticut [CT] · `201`=Delaware [DE] · `202`=District of Columbia [DC] · `203`=Florida [FL] · `204`=Georgia [GA] · `206`=Idaho [ID] · `207`=Illinois [IL] · `208`=Indiana [IN] · `209`=Iowa [IA] · `210`=Kansas [KS] · `211`=Kentucky [KY] · `212`=Louisiana [LA] · `213`=Maine [ME] · `214`=Maryland [MD] · `215`=Massachusetts [MA] · `216`=Michigan [MI] · `217`=Minnesota [MN] · `218`=Mississippi [MS] · `219`=Missouri [MO] · `220`=Montana [MT] · `221`=Nebraska [NE] · `222`=Nevada [NV] · `223`=New Hampshire [NH] · `224`=New Jersey [NJ] · `225`=New Mexico [NM] · `226`=New York [NY] · `227`=North Carolina [NC] · `228`=North Dakota [ND] · `229`=Ohio [OH] · `230`=Oklahoma [OK] · `231`=Oregon [OR] · `232`=Pennsylvania [PA] · `234`=Rhode Island [RI] · `235`=South Carolina [SC] · `236`=South Dakota [SD] · `237`=Tennessee [TN] · `238`=Texas [TX] · `239`=Utah [UT] · `240`=Vermont [VT] · `241`=Virginia [VA] · `242`=Washington [WA] · `243`=West Virginia [WV] · `244`=Wisconsin [WI] · `245`=Wyoming [WY]

**Conventional · State** — param `10`, 51 options

`194`=Alabama [AL] · `195`=Alaska [AK] · `196`=Arizona [AZ] · `197`=Arkansas [AR] · `198`=California [CA] · `199`=Colorado [CO] · `200`=Connecticut [CT] · `201`=Delaware [DE] · `202`=District of Columbia [DC] · `203`=Florida [FL] · `204`=Georgia [GA] · `206`=Idaho [ID] · `207`=Illinois [IL] · `208`=Indiana [IN] · `209`=Iowa [IA] · `210`=Kansas [KS] · `211`=Kentucky [KY] · `212`=Louisiana [LA] · `213`=Maine [ME] · `214`=Maryland [MD] · `215`=Massachusetts [MA] · `216`=Michigan [MI] · `217`=Minnesota [MN] · `218`=Mississippi [MS] · `219`=Missouri [MO] · `220`=Montana [MT] · `221`=Nebraska [NE] · `222`=Nevada [NV] · `223`=New Hampshire [NH] · `224`=New Jersey [NJ] · `225`=New Mexico [NM] · `226`=New York [NY] · `227`=North Carolina [NC] · `228`=North Dakota [ND] · `229`=Ohio [OH] · `230`=Oklahoma [OK] · `231`=Oregon [OR] · `232`=Pennsylvania [PA] · `234`=Rhode Island [RI] · `235`=South Carolina [SC] · `236`=South Dakota [SD] · `237`=Tennessee [TN] · `238`=Texas [TX] · `239`=Utah [UT] · `240`=Vermont [VT] · `241`=Virginia [VA] · `242`=Washington [WA] · `243`=West Virginia [WV] · `244`=Wisconsin [WI] · `245`=Wyoming [WY] · `246`=US Virgin Islands [VI]

**Government · State** — param `10`, 50 options

`194`=Alabama [AL] · `195`=Alaska [AK] · `196`=Arizona [AZ] · `197`=Arkansas [AR] · `198`=California [CA] · `199`=Colorado [CO] · `200`=Connecticut [CT] · `201`=Delaware [DE] · `202`=District of Columbia [DC] · `203`=Florida [FL] · `204`=Georgia [GA] · `206`=Idaho [ID] · `207`=Illinois [IL] · `208`=Indiana [IN] · `209`=Iowa [IA] · `210`=Kansas [KS] · `211`=Kentucky [KY] · `212`=Louisiana [LA] · `213`=Maine [ME] · `214`=Maryland [MD] · `215`=Massachusetts [MA] · `216`=Michigan [MI] · `217`=Minnesota [MN] · `218`=Mississippi [MS] · `219`=Missouri [MO] · `220`=Montana [MT] · `221`=Nebraska [NE] · `222`=Nevada [NV] · `223`=New Hampshire [NH] · `224`=New Jersey [NJ] · `225`=New Mexico [NM] · `226`=New York [NY] · `227`=North Carolina [NC] · `228`=North Dakota [ND] · `229`=Ohio [OH] · `230`=Oklahoma [OK] · `231`=Oregon [OR] · `232`=Pennsylvania [PA] · `234`=Rhode Island [RI] · `235`=South Carolina [SC] · `236`=South Dakota [SD] · `237`=Tennessee [TN] · `238`=Texas [TX] · `239`=Utah [UT] · `240`=Vermont [VT] · `241`=Virginia [VA] · `242`=Washington [WA] · `243`=West Virginia [WV] · `244`=Wisconsin [WI] · `245`=Wyoming [WY]
The State list is **50 entries, and the gaps are meaningful** — ids run `194`–`245` with `205`
(Hawaii) and `233` (Puerto Rico) absent, matching AD's own overlay text *"All programs unavailable
in: HI, PR"*. Do not build a 52-state map and expect it to resolve.

---

## 9. The response

```json
{ "data": [ {
    "id": 145,
    "label": "Apex Prime 30 Year Fixed",
    "bestRateStackRowId": 4,
    "description": "<ul>…HTML…</ul>",
    "checkPhrase": "123",
    "totalAdjustments": "0.375",
    "lockPeriod": "30 Days",
    "rateStackRows": [ { "id": 4, "rate": "6.250", "monthlyPayment": "$3,078.59",
                         "discount": "0.125", "discountAmount": "$625.00" } ],
    "adjustments": { "2Y Full Doc / LTV 65.01 - 70.00": "0.250" }
  } ], "links": [], "success": true }
```

- **`bestRateStackRowId`** points into `rateStackRows` by `id` — that is the row to highlight; it is
  not an array index (they happen to coincide today; do not rely on it).
- **`discount`** is points. Positive = borrower pays, negative = rebate. `discountAmount` is the
  dollar figure, pre-formatted with `$` and commas — every numeric in the response is a
  **formatted string**, not a number. Parse, do not coerce.
- **`adjustments`** is a flat `{description: value}` map, already itemised the way a rate sheet
  reads. This maps directly onto the LLPA itemisation the board already renders for Lender Price.
- **`description` is HTML** and is the only place the rate-sheet timestamp lives:
  `Pricing as of: 08/27/26 - 09:46 AM (EST)`. Extract with
  `/Pricing as of:\s*([^<]+)/`. It also carries the overlay bullets (gift funds, state exclusions,
  reserve minimums).

**No APR. No lender fees. No closing costs. No escrow, tax, or insurance.** The complete key
vocabulary of the response is: `id, label, bestRateStackRowId, description, checkPhrase,
totalAdjustments, lockPeriod, rateStackRows{id, rate, monthlyPayment, discount, discountAmount},
adjustments`. Verified by walking every key in a live payload. A term sheet needing PITI must get
those inputs elsewhere.

---

## 10. The three ways it says no

These are genuinely different and a client must treat them differently.

**`422` — the value is malformed or outside the declared interval.** Field-scoped and precise:

```json
{"status":422,"errors":{"FICO":["Can not find interval value '500' in program group."]}}
{"status":422,"errors":{"DTI":["Invalid value format '' in interval property."]}}
{"status":422,"errors":{"FICO":["Required property is missing."]}}
```
Entirely preventable — the schema publishes `min`/`max`/`step`, so validate before calling.

**`400` — the values are legal but a rule blocks them, and it names the culprits.**

```json
{"status":400,"title":"To get at least one available program, change: DSCR >= 1.25 or DTI 00.00% - 43.00%.","errorNumber":"7CC46"}
{"status":400,"title":"To get at least one available program, change: Loan $4,500,001-5,000,000."}
{"status":400,"title":"To get at least one available program, change: No FICO or US Citizen / Permanent Resident."}
```
This is a real, synchronous disqualify reason — surface it to the user verbatim.

**`200` with an empty `data` array — and no reason at all.**

```
FICO 620 -> 200, 0 programs      CLTV 90 -> 200, 0 programs
FICO 640 -> 200, 0 programs      CLTV 85 -> 200, 0 programs
FICO 660 -> 200, 1 program       CLTV 80 -> 200, 1 program
```

This is the trap. A scenario simply outside every program's box returns **success with nothing in
it**, silently. `status === 200` does not mean "priced" — always check `data.length`. When it is
empty there is no explanation available, and `restrictions` is the only way to work out which field
to move.

> Corrects an earlier claim of mine: AD does *not* uniformly explain a no-hit. It explains a
> rule conflict (400) and stays silent on an out-of-box scenario (200-empty).

---

## 11. Where this stands against Lender Price

| | AD Mortgage | Lender Price |
|---|---|---|
| Auth | login → cookie | OAuth2 + Basic client secret, refresh, backoff, breaker |
| Request | 26 query params from published defaults | clone live `defaultSearch` + SMO registry; hand-built body → 500 |
| Mapping code | none — the schema *is* the map | `search-model.js` 101 KB + `field-registry.js` 27 KB + `zip-county.json` 413 KB |
| Response | ~11 KB, stable keys | ~6.5 MB, 32 programs / 17 lenders / 1055 options |
| Disqualify | synchronous 400 with the field named; silent on out-of-box | full lender→program→rule tree, two-phase async poll |
| Fees / APR | **none** | full |
| Scope | AD's own products, 5 groups | 17 lenders |
| Warm latency | ~249 ms | seconds |

AD is an **additional** source for the board, not a replacement: one lender, no fees, no APR.

---

## 12. Open items

1. **The DSCR rounding seam** (§6) — 1.245 and 0.995. My rule is round-to-2dp; AD has not confirmed.
2. **`DSCR < 0.75` priced at 0.000** while `0.75–0.99` takes −1.500 (§6). Almost certainly a sheet
   gap. Confirm before quoting.
3. **Rate-sheet staleness** — the live sheet on 2026-08-31 was stamped `08/27/26 09:46 EST`, four
   days old. Ask AD their publish cadence, and treat the parsed timestamp as a freshness gate.
4. **Credentials** — this was measured on a personal broker login flagged `passwordExpired: true`.
   A production integration needs a **service account**; otherwise a password change silently kills
   the board and every call is attributed to one person.
5. **Option-id stability** — ids matched across two captures four days apart, but they are AD's to
   change. The client should re-fetch the schema and map by **label**, never by a hardcoded id.
