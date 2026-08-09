# THE BORROWER CONFIRMATION FLOW — DESIGN RESEARCH

### Phase 8 of `TRACK-RECORD-REBUILD-BLUEPRINT.md` (§9.4). Research pass, 2026-08-09. RTL only.

The owner's ask, verbatim: *"What would be the best user-friendly for the borrowers?"* and *"Let's
enhance everything like crazy."*

This document answers the nine research questions, then proposes a concrete flow with wireframes,
every line of borrower-facing copy, and a prioritized build list. It cites real studies and real
products, and it says plainly where the evidence is thin rather than inventing a citation.

---

## 0. THE ONE SENTENCE

**A borrower's "yes" puts a property on somebody's permanent record and improves their own pricing, so
this flow is not a completion-rate problem — it is an accuracy problem with a completion-rate
constraint, and every design decision below is resolved in favour of accuracy.**

That is not the usual trade-off in form design, and it is the reason several patterns that would be
correct in a checkout are forbidden here.

---

## 1. THE SEAM — what this is, and what it must never touch

**The borrower's existing tool is not being rewritten.** §12 of the blueprint lists *"Changing the
borrower's tool"* under DELIBERATELY NOT BUILDING. That is a hard boundary and this design respects it
literally.

What exists today:

```
  app-v2/src/screens/TrackRecordScreen.jsx        React wrapper, route /track-record
        │  StaticToolFrame (iframe)
        ▼
  web/v2/tools/track-record.html + .js + .css      the builder itself  — FROZEN
  web/v2/tools/track-record-portal.js              the bridge          — FROZEN
        │  diff-sync, debounced
        ▼
  /api/borrower/track-records                      one record per borrower
        │
        ▼
  each file's experience condition (tool_key = 'track_record')
```

What this design adds, ALONGSIDE it:

```
  app-v2/src/screens/TrackRecordConfirm.jsx        NEW React screen, route /track-record/confirm
        │  pure React — NO iframe, NO tool code
        ▼
  /api/borrower/track-record-candidates            NEW borrower routes over db/493
        │  a "yes" runs the SAME import chokepoint staff use (§9.2 verb 2)
        ▼
  track_records row at `pending`  (db/485 forces it)
        │
        ▼
  the borrower's existing tool shows the new line, and they edit it THERE
```

**The seam, stated as rules:**

1. **Not one byte changes in `web/v2/tools/track-record.{html,js,css}` or
   `track-record-portal.js`.** No new query param, no new mode, no new `postMessage` type consumed by
   the tool. The confirmation flow never enters the iframe.
2. **The confirmation flow is a separate React screen** and a sibling route. `TrackRecordScreen.jsx`
   stays exactly what it is — the iframe host.
3. **One record, two doors.** The flow's only write into the track record is a `track_records` row at
   `pending`. From that instant the row belongs to the existing tool: the borrower edits it, adds the
   rehab figure, attaches a document, exactly as they do today. **Do not build a second editor.**
4. **No second condition.** This flow feeds the existing experience condition
   (`rtl_p3_reo` / `tool_key='track_record'`). §5.5 already warns that *"three parallel status machines
   for one concept is how two screens end up disagreeing"* — do not add a fourth.
5. **The flow never touches `requested_exp_flips/holds/ground`.** Those are the CLAIM of record, a
   priced input watched by the db/071 + db/072 reopen triggers, with one validated door
   (`studio-experience-claim.js`). A borrower confirming five properties must not be able to move a
   registered loan's size. Confirmations feed *verified* counts. **This is a release blocker if it is
   ever wired the other way.**
6. **The handoff for anything we did not find is the existing tool**, not a second entry form.

### 1.1 The borrower never sees a raw search result — staff release a batch

This is not a nicety, it is a data boundary.

A public-records search on a personal name returns other people's property. The blueprint documents it
directly: D5 (*"a common name never auto-matches"*), and §4.7's live finding that
`search("SUNRISE PROPERTIES LLC")` returned twenty identical-name entities in twenty states. If two of
our own borrowers share a name — and in the communities this book lends into, they do — an unreleased
batch shown straight to a borrower would show them **another borrower's data**, which the constraints
forbid outright.

So: `track_record_candidates` gains `released_to_borrower_at` / `released_by`. A candidate is invisible
to the borrower until a staffer releases it. Staff already have the "Not theirs" verb in §9.2's staging
queue; releasing is the same act, pointed outward. It also bounds the list (nobody sends a borrower 200
cards) and it lets staff strip anything odd before it is seen.

**Phase 8 needs the minimal version of this on day one**, before the Phase 9 workbench arrives: a
column, a staff button, and a route filter.

---

## 2. ONE AT A TIME VS A LIST — which converts, which is ACCURATE, and does 3 differ from 40?

### 2.1 The evidence

**One-thing-per-page is the default, and the case for it is strong but mostly qualitative.** GDS's own
post is candid: they are *"now confident that you should start with the first approach and split all
your questions out on to separate pages"* because *"low-confidence users find them easier to use, they
work well on mobile devices, and they're better at handling things like errors, branches, loops and
saving progress"* — and in the same breath, *"I wish we had some easy-to-share quant data on this."*
([GDS Design Notes](https://designnotes.blog.gov.uk/2015/07/03/one-thing-per-page/);
[GOV.UK Service Manual — Structuring forms](https://www.gov.uk/service-manual/design/form-structure))

The best-known quantitative data point is Adam Silver's Just Eat checkout redesign, reported as **an
extra ~2 million orders a year** after splitting checkout into one-thing-per-page — with the honest
caveat that it is a single before/after on a live commercial site, extrapolated from a one-week
percentage lift, not a controlled experiment
([Smashing Magazine](https://www.smashingmagazine.com/2017/05/better-form-design-one-thing-per-page/)).

**For ACCURACY the evidence is much sharper, and it points the same way.** Our "list with tick boxes"
is literally *check-all-that-apply*; our "one at a time with two answers" is literally *forced-choice*.
Smyth, Dillman, Christian & Stern (Public Opinion Quarterly, 2006) ran 16 experimental comparisons
across two web surveys and a paper survey. In **all sixteen**, the formats did not behave alike:
respondents *"endorsed more options and took longer to answer in the forced-choice format,"* and the
authors conclude the forced-choice format *"encourages deeper processing of response options and is
preferable to the check-all format, which may encourage a weak satisficing response strategy"*
([POQ 70(1) 66–87](https://academic.oup.com/poq/article-abstract/70/1/66/1891521);
[full text PDF](https://digitalcommons.unl.edu/cgi/viewcontent.cgi?params=/context/sociologyfacpub/article/1684/&path_info=Smyth_2006_POQ_Comparing_check_all__DC_VERSION.pdf)).
A later eye-tracking follow-up confirmed the processing-depth mechanism rather than merely inferring it
from response latency.

**Honest limit on that citation:** Smyth et al. show forced-choice produces *deeper processing and more
endorsements*. They do **not** show it produces fewer FALSE endorsements — no study I found tests that,
because survey research rarely has ground truth. What it establishes is that a tick-box list is the
shallow-processing format and a per-item forced choice is the deep-processing one. That is the property
we need; the false-yes reduction is an inference, and §3 adds devices that attack false yes directly.

**Grids are worse still.** Liu & Cernat (*Social Science Computer Review*, 2018) found item nonresponse
higher for matrix than item-by-item, especially among mobile respondents; other work finds straightlining
higher in grids, and the practitioner consensus that emerges is to cap a grid at **5–7 rows** before
straightlining and dropout climb
([Liu & Cernat 2018](https://journals.sagepub.com/doi/10.1177/0894439316674459);
[Grid vs item-by-item on PC and mobile](https://dl.acm.org/doi/abs/10.1177/0894439317735307)).

**Baymard's finding tempers the "more steps = worse" fear.** Their checkout work (200,000+ hours,
54 benchmark rounds) is that *what matters is the number of form fields the user must consider, not the
number of steps* ([Baymard](https://baymard.com/blog/checkout-flow-average-form-fields)). Splitting a
fixed amount of work across more screens is close to free; adding work is not.

### 2.2 The ruling

**One property per screen is the decision surface, at every batch size. That answer does not change
between 3 and 40.** What changes is the scaffolding around it.

| Batch size | Shape |
|---|---|
| **1–3** | No list, no task page, no grouping. Three cards in sequence, then the summary. Under a minute. |
| **4–12** | One at a time. A persistent "See all 8" read-only overview, and a check-your-answers summary at the end. |
| **13+** | **Group first** (§7), then one at a time *inside* a group. A GOV.UK-style task list is the home screen; each group is a task with a status. |

**Two asymmetries that fall out of this and that I want stated as rules:**

- **Bulk NO is allowed. Bulk YES is not.** A group-level "none of these are mine" declines twelve
  candidates in one action and writes nothing — the candidates stay in staging, staff still see them,
  and the borrower's own economic incentive (more experience = better leverage) means they are unlikely
  to decline a real deal. A group-level "all of these are mine" would make the single
  highest-consequence control in the product one tap wide. **Never build it.**
- **The borrower's incentive is not neutral.** This is not ordinary survey acquiescence, where yes-saying
  is a laziness artefact. Here, a yes is worth money to the respondent. Acquiescence *plus* incentive,
  both pointing the same way. Every ordering, wording and default decision below is therefore biased
  against yes, deliberately.

**The one place a list may be a decision surface** is inside an already-settled entity group, capped at
**7 rows**, where every row still carries two explicit buttons (forced choice, never a tick box) — see
§7.4. That cap is the grid-research number, used for the reason the research gives.

---

## 3. ACQUIESCENCE — what measurably reduces a false "yes"

### 3.1 What we are up against

- **Satisficing.** Krosnick's account: when retrieving and editing an answer is costly, people select
  the first acceptable response rather than the optimal one.
- **Primacy in visual mode.** Krosnick & Alwin (POQ, 1987) — in self-administered/visual presentation,
  earlier options are over-selected: items seen first establish the comparison standard, get processed
  before competition arrives, and a satisficer stops at the first acceptable one
  ([GESIS response-bias guidelines summarising the mechanism](https://www.gesis.org/fileadmin/admin/Dateikatalog/pdf/guidelines/response_biases_standardized_surveys_bogner_landrock_2016.pdf)).
  **Concretely: put "Yes" first and you will get more yeses, for no reason connected to the truth.**
- **Agree/disagree formats carry acquiescence that item-specific formats do not.** Saris, Revilla,
  Krosnick & Shaeffer (*Survey Research Methods* 4(1), 2010) found item-specific response options give
  higher measurement quality than agree/disagree, and the reduction of acquiescence is the repeatedly
  replicated part of that literature
  ([SRM 4(1) 61–79](https://ojs.ub.uni-konstanz.de/srm/article/view/2682);
  [review of response-scale characteristics](https://pmc.ncbi.nlm.nih.gov/articles/PMC5993837/)).
- **A confirm button next to text is rubber-stamped.** Obar & Oeldorf-Hirsch (*Information,
  Communication & Society*, 2020), N=543 joining a fictitious network: **74% skipped the privacy policy
  entirely via the quick-join clickwrap; 97% agreed to the privacy policy and 93% to the terms**, with
  average reading times of 73 and 51 seconds against texts that need 29–32 and 15–17 minutes
  ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2757465);
  [Taylor & Francis](https://www.tandfonline.com/doi/full/10.1080/1369118X.2018.1486870)).
- **People over-claim familiarity with things that do not exist.** Paulhus's overclaiming technique
  seeds ~20% nonexistent "foils" into a familiarity list; any non-zero claim on a foil is pure response
  bias, and signal-detection maths separates bias from real knowledge
  ([Paulhus Lab](https://paulhuslab.psych.ubc.ca/research/overclaiming/);
  [Paulhus, Harms, Bruce & Lysy 2003, JPSP](https://www2.psych.ubc.ca/~dpaulhus/research/SDR/downloads/ARTICLES/JPSP.2003.with.Harms.Bruce.Lysy.pdf)).
  This is not just a warning — it is the **measurement instrument** we should adopt (§3.3).

### 3.2 The nine moves, in order of leverage

**1. Put the claim inside the button, not above it.**
Not `[ Yes ]` under an address. The button reads **"Yes — 62 Highland St"**. You cannot press it while
skimming without your eye passing the address. It costs nothing, it kills the "button labelled Yes out
of context" screen-reader failure at the same time, and it converts the answer from an assent into a
statement. This is the highest ratio of effect to effort in the entire design.

**2. Make both answers item-specific, so neither is "agree".**
`[ Not mine ]` and `[ Yes — 62 Highland St ]` are two descriptions of the world, not two points on an
agreement scale. Saris et al.'s result is exactly this substitution. **Never render a bare Yes/No pair,
and never the word "Confirm".**

**3. "Not mine" comes FIRST, everywhere, in a fixed position.**
This changes the blueprint's §9.4 sketch, which has Yes first, and the change is deliberate. Krosnick &
Alwin's primacy effect means the first option is over-chosen in visual mode; a satisficer who is not
reading will therefore *decline*, which is the recoverable error. **Both buttons stay identically sized
and identically weighted** (the owner's rule) — the ordering carries the debiasing, not the styling.

Position is **fixed across every screen** rather than randomised. Randomisation would debias each
individual answer slightly better, but across 40 near-identical screens it destroys muscle memory and
manufactures mis-taps, which is a bigger accuracy loss than the primacy effect it removes.

**4. Nothing is pre-selected. Ever.**
The staff staging queue in §9.2 pre-selects the system's guess — correct there, because a reviewer is
accountable and is reading the evidence. On the borrower side there is no default radio, no
pre-highlighted button, no "recommended" marker.

**5. The corroboration tap: withhold exactly one recognisable fact and ask for it back.**
Recognition is cheap and prone to familiarity misattribution; discrimination among plausible
alternatives is not. So the card shows the address, the map and the dates — and **withholds the purchase
price**. On the *yes* path only, one extra screen asks for it as a band:

```
   Roughly what did you pay for it?
   ( ) Under $300,000     ( ) $300,000 – $450,000
   ( ) $450,000 – $600,000  ( ) Over $600,000
   ( ) I don't remember
```

A property that is not yours cannot be priced. A property that is yours can be priced roughly, and
"I don't remember" is a perfectly legitimate answer that does **not** un-claim the property — it just
means staff get one fewer corroborator.

Three rules that make it rigorous rather than decorative:
- **Exactly one fact is withheld and asked back.** If you ask for a fact that is printed on the card,
  you have built theatre.
- **The bands must not put the truth in the middle every time.** Choose edges so the true band varies in
  position, and always include a band above and a band below.
- **It has a documented fallback ladder, never a fabricated question.** In the twelve non-disclosure
  states (Texas among them — §2.3) there is no public sale price at all. Ladder: purchase price → the
  purchase *month* (in which case the card shows only the year) → the unit count ("single-family or
  multi-family?"). If none of the three is available, **skip the tap and record
  `corroboration: 'unavailable'`.** Never invent a question we cannot score.

**6. A time floor on the yes button, not a confirm modal.**
Obar & Oeldorf-Hirsch is the reason: a modal is the same rubber-stamp one level down. Instead the yes
button becomes active ~600–800 ms after the card paints — imperceptible if you are reading it, fatal to
a double-tap that lands on the next card. This is the only friction on the yes path and it is invisible.

**7. Undo is a persistent strip, not a 4-second toast.**
It sits **above** the card in DOM order (so a screen reader reaches it before the next question), names
what was just answered, and stays until the next answer replaces it. Toasts are unusable on this flow:
40 of them is noise, and a 4-second window is not an undo, it is a reflex test.

**8. The summary at the end is where the yeses become visible together.**
GOV.UK's *check your answers* pattern — a summary of everything, each line changeable, returning to the
summary
([NHS service manual version](https://service-manual.nhs.uk/design-system/patterns/check-answers)).
A wrong address sitting in a list of five right ones reads wrong in a way it never does on its own card.
This is the cheapest real check in the flow.

**9. State the consequence, truthfully, on every card.**
*"Only mark the ones you actually owned. Your loan team checks each one against the county records."*
That is not a dark pattern — it is true (D1: nothing auto-verifies), and it is the only honest
deterrent available.

### 3.3 Measure the false-yes rate — with real near-misses, never fabrications

Adopt Paulhus's foil logic, operationally:

> In any released batch over ~8 candidates, include **one or two candidates staff have already marked
> "not this borrower's"** from the same search. A yes on one of those is a measured false positive.

Rules that make this safe and honest:

- **Never synthesise an address.** The foils are real search results that genuinely came back and that a
  staffer genuinely declined. The screen's premise — *"properties that look like yours"* — remains
  literally true. Fabricating a property would not be.
- **Foil results are aggregate-only.** They never land on the borrower's file, never become a finding,
  never reach underwriting, never influence a decision about that borrower. D3's doctrine —
  *"a coverage gap must never become a borrower deficiency"* — applies with equal force here: a foil trip
  is a fact about our FORM, not about the person.
- If the owner is uneasy with always-on foils, the fallback is a periodic sample (one batch in five)
  rather than dropping the measurement entirely. **Without foils there is no way to know whether any of
  §3.2 works**, and the alternative ground truth — staff overturning a borrower-claimed line — takes
  weeks per data point.

### 3.4 What does NOT reduce a false yes — with the citation

**An honesty pledge at the top of the flow.** Shu, Mazar, Gino, Ariely & Bazerman (PNAS, 2012) reported
that signing an honesty statement *before* rather than after reduced dishonesty, and it was widely
adopted by government agencies. **It did not replicate.** Kristal, Whillans and the five original
authors published six studies in PNAS in 2020 — five conceptual replications (n = 4,559) and one
high-powered preregistered direct replication (n = 1,235) — and *"observed no effect of signing first on
honest reporting"*
([PNAS](https://www.pnas.org/doi/10.1073/pnas.1911695117);
[HBS](https://www.hbs.edu/faculty/Pages/item.aspx?num=57627)). The original field experiment was
subsequently shown to contain fabricated data
([Data Colada #98](https://datacolada.org/98)).

So: **no honesty pledge at the start.** There is an attestation at the END, on the summary — and I am
not going to oversell it either. Its value is that it forces one deliberate read of the assembled list
and creates a dated record. There is no good evidence that it reduces false claims.

---

## 4. WHAT TO SHOW PER PROPERTY

### 4.1 The recognition problem is real and it is measured

An investor with 40 deals under four LLCs does not carry those addresses in working memory. The nearest
measured analogue is knowledge-based authentication, where consumers routinely fail questions about
their own financial history: Consumer Reports' credit-checkup study found consumers *"locked out of
their credit reports because of identity verification questions that they could not answer"* — one could
not remember the year she had taken a car loan and failed the quiz
([Consumer Reports](https://www.consumerreports.org/credit-scores-reports/consumers-found-errors-in-their-credit-reports-a6996937910/);
[CR advocacy release](https://advocacy.consumerreports.org/press_release/almost-half-of-participants-in-credit-checkup-study-find-errors-on-credit-reports-more-than-a-quarter-find-serious-mistakes/)).
Gartner's commonly-cited figure for legitimate customers failing KBA is **10–15%**
([Experian Insights](https://www.experian.com/blogs/insights/knowledge-based-authentication-kba-best-practices-part-3-v4/)).

**Design consequence: assume a meaningful minority of genuinely-owned properties will not be recognised
from an address alone, and that this is a normal outcome, not evasion.** Everything in §5 ("I'm not
sure") exists because of this number.

### 4.2 The card, ranked by recognition value

| Rank | Element | Notes |
|---|---|---|
| 1 | **Full street address + town + ZIP** | Never abbreviated. Unit number never dropped — unit 2 and unit 5 are different deals. |
| 2 | **A static map thumbnail with a pin** | Strongest single cue for a physical place. See constraints below. |
| 3 | **Bought / sold dates as a two-line story** | "Bought August 2025 · Sold March 2026". Months, not exact days — a rough season is what people actually hold. |
| 4 | **The entity it was held under** | Critical for an investor — but better answered ONCE at the group level (§7) than repeated on 12 cards. |
| 5 | **Property type / unit count** | "3-family" is a strong cue and cheap. Withhold it only if it is the corroboration fact. |
| 6 | **The county recording reference** | "Ocean County deed, recorded 19 March 2026", small, at the bottom. Two jobs: it answers *"how do you know about my property?"*, and it is checkable. **No outbound link to a vendor.** |

**The map, with its constraints:**
- **Static image, not an interactive map.** An interactive map steals taps, eats mobile data, and adds
  nothing — you are not exploring, you are recognising.
- **Render for the CURRENT card and prefetch exactly one ahead.** §9.5's rule — *"a screen that shows
  forty properties must not fire forty paid lookups because it rendered"* — applies here word for word.
- **Cache forever, keyed on the canonical address.** Properties do not move. Reuse the discipline in
  `address_canon_cache`, including its lesson: **only cache a definitive answer.**
- **The card must render correctly with no map at all** — blocked images, no key, offline, a rural
  address with no tile. The map is an enhancement, never a load-bearing element.
- **Street-level imagery is a tap, not a default.** Stronger for recognition, more expensive, and for a
  flip the house looks nothing like it did; for a ground-up it may not have existed. Offer it behind
  "Show the street", inside the expanded view.

### 4.3 What must never appear on the card

- **A contact phone number.** Hard rule. We do not pay for skip tracing and displaying one would imply
  we did.
- **Any capital-partner or note-buyer name.** Frozen rule across every borrower-facing surface.
- **Our internal findings, our match confidence, our score.** No "we're 92% sure this is yours" badge —
  it is an internal finding, it anchors the answer, and it is exactly the thing §3 is trying to prevent.
- **Our fee income.** Frozen rule.
- **Another borrower's data** — structurally prevented by the release gate (§1.1).
- **A private individual's name as counterparty.** The grantor/grantee names are public record, but
  "Sold to John Smith" is a person's data on a screen that does not need it, and a stranger's name is a
  weak recognition cue anyway. Show a counterparty only when it is an entity, and only inside the
  expanded view.

### 4.4 The LLC they barely remember

This is the case the owner asked about specifically, and it deserves its own handling rather than a
shrug.

1. **Lead with the entity at the group level, not property by property** (§7). Twelve chances to fail to
   recognise a company name is twelve chances to produce a wrong answer; one chance is one.
2. **"I don't recognise this company" is a first-class group answer**, and it is far more informative to
   staff than twelve property-level "not sure"s.
3. **If they don't recognise the entity, do not then walk them through twelve properties.** Show ONE
   property from the group as a probe: *"Do you know 62 Highland Street, Lakewood?"*
   - **Recognises the property, not the company** — the classic case. A title company vested the deal in
     an entity name they signed once and never used again. The right ask now is a document (the deed or
     the closing statement names the grantee), so the screen says exactly that and routes to a document
     request through `doc-request.js`, which already produces the sentence: *"We need the deed to confirm
     you owned 62 Highland Street."*
   - **Recognises neither** — decline the group, one action, one undo.
4. **Never imply a lie.** No "you told us…", no "you claimed…". The copy is
   *"That's normal — companies get set up at closing and are easy to forget."*

---

## 5. "I'M NOT SURE" — is a third option right, and what happens to those?

### 5.1 The evidence cuts both ways, and the resolution is about which question you are asking

Krosnick, Holbrook, Berent, Carson, Hanemann et al. (POQ 66(3), 2002) ran nine experiments across three
household surveys on "no opinion" options. The finding is that offering one does **not** improve data
quality — it invites satisficing. Attraction to the no-opinion option was greatest among respondents
lowest in cognitive skills, when answering privately rather than orally, and later in the questionnaire
([POQ](https://academic.oup.com/poq/article/66/3/371/1836194);
[PDF](https://gspp.berkeley.edu/archived/files/research/pdf/Krosnick_et_al..pdf)). **All three of those
moderators describe our flow**: a self-administered form, on a phone, and item 34 of 40.

But that literature is about **attitudes**, where "don't know" usually masks a real if weakly-held view.
Ours is about a **fact the person may genuinely not know**, and §4.1's KBA numbers say a meaningful
minority genuinely will not.

### 5.2 The ruling

**Yes, a third path — but never a third button of equal weight.**

- It is a **quiet text link beneath the two answers**, worded as a state of the world rather than a
  refusal: **"I'm not sure — set this one aside"**. Krosnick's finding is that a *prominent* no-opinion
  option siphons people who do have an answer; a quiet one preserves the escape without advertising it.
- **It is offered only after the cheap help has been offered.** The link sits under
  *"Show more about this one"*, so the sequence is: look harder → still not sure → set aside.

### 5.3 "I'm not sure" and "Skip for now" are two different things — do not merge them

The blueprint's §9.4 sketch has "Skip for now". Keep both, because they carry different information and
they need different staff actions:

| Answer | Means | Candidate status | Comes back? | Staff action |
|---|---|---|---|---|
| **Skip for now** | *I'll come back to it.* A scheduling state. | stays `staged`, `borrower_skipped_at` set | **Yes** — re-queued at the end of the run | none |
| **I'm not sure** | *I looked and I can't tell.* An epistemic state. | new status `unsure`, with `resolution_note` | **No** | **highest-value queue** |

Collapsing them throws away the single most useful signal the flow produces. A property the borrower has
a *partial* memory of is one where a second cue often settles it — and it is the one place a paid lookup
genuinely earns its cost.

### 5.4 What staff do with an "unsure"

In priority order, none of them automated:
1. **Show a second cue.** The map, the street image, the entity, the recording reference — the things the
   card withheld.
2. **Pull the deed image** where Elementix has one (D2: it has none at all in Los Angeles County, so
   absence is never a negative).
3. **Ask for a document** — `doc-request.js` with `pillar='ownership'`, which lands on the property AND,
   for an entity document, on the entity's own slot so one upload settles every property that entity held
   (§4.6).
4. **Ask them on the phone**, with the address in front of both people.

**An "unsure" must never silently become a decline.** That is the one failure mode here, and it loses
real experience.

### 5.5 The not-sure ceiling

If a borrower marks more than ~30% of a batch "not sure", **stop the flow and hand it to staff.** A run
that produces 25 unsures has not produced data, it has produced work, and continuing to ask is
disrespectful of their time. Copy in §11, screen S13. The threshold is a judgement call, not a
research finding — instrument it and tune it.

---

## 6. PROGRESS, SAVING, AND COMING BACK

### 6.1 The denominator, and the trick we are deliberately not using

*"3 of 8", never "3"* is already decided and it is right. The mechanism is the goal-gradient /
endowed-progress family: Nunes & Drèze's car-wash field study is the canonical demonstration —
**19% redemption on an 8-stamp card versus 34% on a 10-stamp card with two stamps pre-filled**, identical
real effort, identical reward
([The Endowed Progress Effect](https://www.researchgate.net/publication/23547282_The_Endowed_Progress_Effect_How_Artificial_Advancement_Increases_Effort)).

**We use the denominator. We refuse the endowment.** An inflated bar that says you are nearly done is
precisely the pressure that produces rubber-stamping at the tail of the run — and Krosnick's satisficing
data says the tail is already the weak point. Progress is honest: answered over total.

Two refinements:
- **Label what is LEFT, not only the fraction.** "3 of 8 · 5 left". At 40, "3 of 40" is demoralising —
  which is the real argument for grouping (§7): the visible denominator becomes "3 of 6 in MW Trading LLC".
- **The bar is never the only signal** — `role="progressbar"` with a visible text equivalent (§9).

### 6.2 Saving

- **Every answer writes immediately.** Optimistic UI, server write, queued retry on failure. The client
  never holds an unsent answer across a navigation.
- **One quiet persistent line, not 40 toasts:** *"Saved. You can close this and come back."*
- **A failed save is loud and specific** (screen S12). Silently losing an answer is the one unrecoverable
  failure in this flow.
- **Decisions are idempotent** on `(candidate_id, borrower_id)`. A double-tap, a retried request and a
  webhook-style redelivery must all land the same row.

### 6.3 Multi-session

Use GOV.UK's **complete multiple tasks** (task list) pattern for anything over ~12 candidates. It is
shipped precisely for *"longer transactions involving multiple tasks that users may need to complete over
a number of sessions"*, with per-task statuses (Not started / In progress / Completed / There is a
problem) and the standing note that *"statuses should be helpful to users — the more you add, the harder
it is for users to remember them"*
([GOV.UK Design System](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)).

- **Resume at the first UNANSWERED item**, not at the top, with a one-line orientation:
  *"Welcome back — you're on 4 of 8."*
- **Never expire the task.** Stop emailing after two reminders and hand to staff; never discard answers.

### 6.4 The re-entry link — what it may and may not contain

**Content rules (these are the ones the owner asked about):**

| MAY contain | MUST NOT contain |
|---|---|
| The loan file's subject tag, exactly as `enrichFileOpts` already produces it | **Any property address** |
| "a short set of questions about your past projects" | **Any entity / LLC name** |
| The borrower's first name in the greeting | **Any dollar figure** |
| One link | **The count of properties found** |
| The standard PILOT footer | **Any capital-partner or note-buyer name** |
| | **Any phone number** (hard rule) |
| | **Any of our findings or confidence** |

The reason is mundane and decisive: an email subject and preview line render on a lock screen, get
forwarded, and get read by an assistant. *"We found 8 properties you own"* with the addresses in the body
is a disclosure we do not need to make to send someone to a screen.

**Authentication rules:**

- **The link is NOT a bearer token that signs the borrower in.** This flow WRITES claims to their
  permanent record. The repo already draws this line: the draw-wire magic link is deliberately excluded
  from every staff BCC precisely because it *"signs the borrower IN AS THEM"*. Same reasoning, same
  answer.
- **Prefer `next=` over a token.** The link lands on the normal login-gated route with a deep-link
  parameter. An already-signed-in borrower goes straight through; a signed-out one signs in once. This
  also survives the enterprise-mail-scanner problem, where security appliances pre-click links and burn
  single-use tokens before the human sees them — a well-documented magic-link failure mode
  ([magic-link security review](https://guptadeepak.com/mastering-magic-link-security-a-deep-dive-for-developers/)).
- If a token is used anyway: short-lived, single-use, CSPRNG-generated, **consumed before any redirect**,
  and the landing page must send `Referrer-Policy: no-referrer` — otherwise the token leaks in the
  `Referer` header to the first outbound link the user clicks.

**SMS is tighter still.** No address, no company, no amount, no count:
`PILOT: a short set of questions about your past projects is waiting. <link> Reply STOP to opt out.`
Consent per the site's existing SMS terms.

---

## 7. OWNERSHIP GROUPING — one question plus twelve quick confirmations

The owner's instinct is right and the blueprint's own architecture already says so: §2.2's Check A/Check B
split means *"a borrower with ten properties across two LLCs does two Check A's and ten small Check B's,
not ten investigations."* The borrower flow should mirror that structure exactly.

### 7.1 The group question

```
   12 of them were bought or sold by
   MW TRADING LLC

   Is MW Trading LLC your company?
   You're an owner, member, or manager of it.

   [  No — none of these 12 are mine  ]  [  Yes — it's my company  ]
   I'm not sure
```

**Wording rules:**
- **Ask "is it your company", never "did you control it".** Control is a legal term with a specific
  meaning to us (Check A, proved by the operating agreement) and a loose one to them. Asking about
  control invites a confident yes to a question they cannot competently answer, and it is *our* job to
  test anyway.
- **The NO button names the count.** A group decline is a bulk action, and the button must say what it
  does. This is how the bulk-no is made safe — not by reversing the button order.
- **Ordering stays "no first", the same as everywhere else** (§3.2 move 3). Note the asymmetry actually
  *inverts* at this level — a false group-no costs the borrower experience, while a false group-yes
  claims nothing, because the twelve still go one at a time. I still keep the fixed order, because
  consistency across dozens of near-identical screens buys more accuracy than a per-screen optimisation,
  and the count-in-the-button plus a persistent group-level Undo covers the group-no risk.

### 7.2 A group YES does not claim the properties

This is the point where the design could go wrong and where it must not.

```
   Good. Now the properties themselves — one at a time.
   Some of these might not be deals you did.

   [ Start ]
```

The entity owning a property and the borrower having done that deal are **different facts** (Check A vs
Check B). An LLC may have bought with a partner, may have held something nobody worked on, may have been
used for one deal and then lent to a cousin. And a single tap claiming twelve properties is the highest-
consequence control we could build.

**What a group yes DOES buy is speed on the per-property card**, which is what the owner actually wanted:
the entity line drops off the card (it is settled), so the card shrinks to address + dates + two buttons.
That is a genuinely quick confirmation, and it survives the accuracy test because it is still forced
choice, still per item.

### 7.3 A group NO ends the group in one action

Twelve candidates → `declined`, `resolution_note = 'borrower: not my company'`, one audit row per
candidate, **one** undo strip that reverses all twelve. They stay in `track_record_candidates`; nothing
is deleted; staff still see them.

### 7.4 The compact list — the one sanctioned list-as-decision-surface

Inside a group whose entity question is settled YES, offer a compact mode:

- **Maximum 7 rows per screen.** The grid research's number, used for the reason it gives (straightlining
  and dropout climb past 5–7). Twelve properties = two screens of six.
- **Every row carries two explicit buttons. Never a tick box, never a select-all.** This is forced choice
  rendered as a list, not check-all-that-apply — the distinction Smyth et al. measured.
- **The corroboration tap is deferred, not skipped.** On submit: *"You marked 4 as yours. One quick
  question about each."* Four screens, one question apiece. The list buys speed; the corroboration is
  the price and it is not negotiable.
- Toggle: **"Show one at a time"** always available, and one-at-a-time remains the default.

### 7.5 The other groups

| Group | Group question? |
|---|---|
| **An entity we resolved** | Yes — §7.1 |
| **In your own name** | Yes — *"3 of them were bought in your own name."* Same shape, no company question needed; it confirms the personal-name identity match, which is exactly where D5's common-name risk lives. |
| **We couldn't tell who bought these** | No group question. Straight to one at a time. |

---

## 8. THE DEAL-TYPE QUESTION — when, and how not to teach the answer

### 8.1 The leak is real and it is in the product today

Flip / hold / ground-up are three separate experience universes (§2.3: *"a separate experience universe —
flips do not substitute"*), and they price differently. The borrower's incentive is to pick the bucket
the loan needs. Worse, the borrower portal **currently tells them which bucket it needs**:
`Application.jsx` renders *"still need 2 more ground-up to match your product registration."*

### 8.2 The five rules

**1. Mostly, don't ask — derive it and state it.**
This is the strongest answer to the owner's question. If the record shows a purchase and a sale seven
months later, the deal type is already known; asking is pure downside. So:

```
   The county records show you sold it in March 2026.

   [ Next ]              That's not right
```

The choice is removed from the most common case, which removes the gaming opportunity from the most
common case. A *correction* is a higher-friction, more visible, more accountable act than picking a
radio, and it lands in staff review with the disagreement recorded. **Only ask when the record is silent
or self-contradictory.**

**2. Ask AFTER the yes, per property. Never up front, never in aggregate.**
Never *"how many flips have you done?"* — that is the claim, and the claim has its own door.

**3. Never show the file's experience requirement anywhere in this flow.**
The conditions screen may say it. This flow may not. Hard separation, and it is the concrete fix for §8.1.

**4. Ask what HAPPENED, not what it WAS.**
Do not offer "Fix & Flip / Fix & Hold / Ground-up" — those are our labels and offering them teaches the
taxonomy that can be gamed. Ask the two factual questions the classifier actually needs:

```
   What happened to 62 Highland Street after you finished the work?
   ( ) I sold it
   ( ) I kept it and rented it out
   ( ) I kept it and refinanced it
   ( ) I still own it — it isn't rented yet
   ( ) Something else  [                          ]
```

and, only when we cannot tell:

```
   Was there already a house on the lot when you bought it?
   ( ) Yes — I renovated it
   ( ) No — I built it from the ground up
   ( ) Yes — I knocked it down and rebuilt
```

Together these determine flip / hold / ground-up deterministically, and **neither answer is nameable as
"the one that gets a better loan"** because neither uses our vocabulary. The first question's option set
also matches the ground-up rule the owner authorised on 2026-08-09 — a ground-up exits on *sale OR rent
OR refinance* — so a built-and-sold house is captured, which is the exact bug that rule fixed server-side.

**5. Fixed, factual option order.** Sold / rented / refinanced / still own. Never ordered by what each is
worth. Randomising here would be worse than useless — the options are not equivalent alternatives, they
are a chronology.

### 8.3 The answer is a claim, and it must survive

The borrower's deal-type answer writes into the `pending` row like everything else and staff decide. But
note **D2**, the live defect: `ingest.js:677` overwrites `deal_type` on re-ingest. A borrower's answer
here must carry `deal_type_source='borrower_confirm'` so the D2 fix — *"write `deal_type` only when the
row is `inferred` and untouched by a human"* — protects it. **Phase 8 must not ship before D2 is fixed,
or the flow's most gameable field will be silently clobbered by the next ClickUp pass.**

---

## 9. ACCESSIBILITY AND MOBILE — for this exact flow

### 9.1 Touch targets and where the thumb lands

- **WCAG 2.2 SC 2.5.8 Target Size (Minimum, AA): 24 × 24 CSS pixels**, with a spacing exception where an
  undersized target's 24px circle must not intersect another's. SC 2.5.5 (Enhanced, AAA) is 44 × 44
  ([W3C summary](https://wcag22aa.org/new-criteria/target-size/)).
- **For this flow: 48px minimum height on the two answers, and at least 16px of gap between them.** The
  gap matters more than the height — two large adjacent buttons separated by a hairline is the classic
  mis-tap, and a mis-tap here is a false claim.
- **On a phone, the two answers stack full-width, "Not mine" on top.** Side-by-side at 390px forces the
  yes label to truncate, which defeats §3.2 move 1.
- **Do not put the consequential button in the easiest-reach spot.** The bottom-centre arc is where a
  one-handed thumb rests; "Yes" should require a small deliberate movement. *Caveat, stated honestly:*
  the thumb-zone literature is practitioner-derived — Hoober's 2013 observational study of 1,333 people
  is the usual citation — not peer-reviewed experimental work. Treat it as a reasonable heuristic, not
  as proven.

### 9.2 The repo's own mobile rules, applied

- **Every form control ≥ 16px** or iOS Safari zooms the page on focus. Applies to the corroboration
  bands, the "something looks wrong" box, and the attestation label.
- **`html { overflow-x: hidden; overflow-x: clip }` is already in place and this flow can still break
  it.** One phantom horizontal overflow widens the layout viewport past 720px, silently switches off
  every `@media(max-width:720px)` rule, and drops the portal to its desktop layout. This flow adds two
  new risks: the map thumbnail and the long address. Rules: map is `max-width:100%`, the address wraps
  (`overflow-wrap:anywhere`), and **no `white-space:nowrap` anywhere on the card.**
- **Verify with `window.innerWidth === 390` on an iPhone-12 render**, not with `scrollWidth - innerWidth`
  (which reads 0 even when the viewport has blown up).

### 9.3 Screen readers

- **On advance, move focus to the new card's heading** (`tabIndex={-1}` on the address `<h2>`), and keep
  a `aria-live="polite"` region for "3 of 8". The established practice for a SPA step change is *both* —
  focus for orientation, live region for the status
  ([focus + live region guidance](https://accessible-vue.com/chapter/5/);
  [MDN aria-live](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live)).
- **Never move focus onto a button.** A screen-reader user landing on "Yes" is one space-bar from a false
  claim. Focus goes to the heading, every time.
- **The two answers are `<button>`s, not radios** — they are actions, not a selection. Each button's
  accessible name carries the full address:
  `<button>Yes — 62 Highland St<span class="sr-only">, Lakewood, NJ 08701 — I owned this property</span></button>`.
  This fixes the "button labelled Yes, out of context" failure and is the same anti-skim device as §3.2.
- **The card is a `role="group"`** with `aria-labelledby` pointing at the address heading, so the two
  buttons are always heard in the context of the property.
- **The Undo strip is `role="status"` and sits ABOVE the card in DOM order**, so it is announced before
  the next question rather than after it.
- **Progress:** `role="progressbar"` with `aria-valuenow/valuemin/valuemax` **and** a visible text
  equivalent. Never colour alone for answered/unanswered.
- **`prefers-reduced-motion`:** no card-slide transition.

### 9.4 Colour — the repo's hard rule, spelled out for this screen

White-first. Dark text on white: **`#141B22`** primary, **`#4B585C`** secondary, **`#256168`** for links
(AA on white). **Never a `--ink*` token for a text colour** — every `--ink*` in `app-v2/src/styles.css`
is a LIGHT paper colour and renders white-on-white; the dark tokens are `--ivory` / `--text`. Gold
`#AE8746` for the loud banner border and the progress fill; teal `#2F7F86` for the primary action.
Grep for `color:\s*['"]?var\(--ink` before shipping — every hit is that bug.

---

## 10. WHAT NOT TO BUILD — patterns that look friendly and produce bad data

| # | Do not build | Why |
|---|---|---|
| 1 | **Select-all / "these all look right — confirm all"** | Check-all-that-apply is the shallow-processing format (Smyth et al. 2006), and it puts the worst possible error one gesture away. |
| 2 | **A pre-checked "yes" or a pre-selected radio** | Removes the decision the whole flow exists to capture. |
| 3 | **An honesty pledge at the start** | Signing-first did not replicate (Kristal et al. 2020) and the original field data was fabricated (Data Colada #98). |
| 4 | **A confirm modal on each yes** | The same rubber-stamp one level down — Obar & Oeldorf-Hirsch: 74% skipped, 97% agreed. Adds a tap, adds no accuracy. |
| 5 | **Any tier/requirement counter inside this flow** | *"2 more and you qualify"* is an instruction to lie. |
| 6 | **Endowed or inflated progress** | Known to work (Nunes & Drèze) and wrong here — the pressure lands exactly on the tail, where satisficing is already worst. |
| 7 | **Gamification — streaks, confetti, "you're crushing it"** | Rewards speed. Speed is the failure mode. |
| 8 | **Swipe-to-answer / auto-advance on tap** | Fast, delightful, and it produces precisely the error profile we cannot afford. Also unusable with a screen reader. |
| 9 | **A confidence badge ("92% likely yours")** | An internal finding — forbidden — and it anchors the answer. |
| 10 | **A phone number, a counterparty's personal name, a note-buyer name, our fee income** | Hard rules, no exceptions. |
| 11 | **A free-text "tell us about this property" box as the main path** | Looks friendly, produces unparseable data, moves the work to staff. Structured first; free text only inside "Something else". |
| 12 | **A grid of properties × attributes** | Straightlining and item nonresponse (Liu & Cernat 2018), and unusable at 390px. |
| 13 | **Requiring a reason for "Not mine"** | Friction on the SAFE answer biases the whole flow toward yes. Reasons stay optional. |
| 14 | **Expiring or timing out the task** | Losing partial answers is the one unrecoverable failure. |
| 15 | **Auto-importing anything on a borrower's behalf** | §12, owner-directed twice. |
| 16 | **An email that lists the addresses** | §6.4. |
| 17 | **Writing anything other than `pending`** | D1, and db/485 is the backstop — do not rely on the backstop. |
| 18 | **Letting a confirmation move `requested_exp_*`** | It would reopen Products & Pricing and could re-size a registered loan. §1 rule 5. |

---

## 11. THE PROPOSED FLOW

### 11.1 The map

```
                       staff release a batch  (§1.1)
                                │
     ┌──────────────────────────┴───────────────────────────┐
     │                                                       │
  file condition                                        email / SMS
  "Conditions to close"                                 (§6.4 content rules)
     │                                                       │
     └──────────────────────────┬───────────────────────────┘
                                ▼
                        S1  Start / what this is
                                │
                 ┌──────────────┴──────────────┐
             ≤12 candidates              13+ candidates
                 │                             │
                 │                        S6  Task list  ──┐
                 │                             │           │
                 ▼                             ▼           │
        S2  Group question  ◄──────────────────┘           │
        (only when a group exists)                          │
             │        │                                     │
        no ──┘        └── yes                                │
        (bulk         │                                      │
       decline)       ▼                                      │
                 S3  Property card  ──── "show more" ──► S3b │
                 (one at a time)   ◄─────────────────────┘   │
                      │  │  │  │                             │
        not mine ─────┘  │  │  └── skip → back of the queue  │
        not sure ────────┘  │                                │
                            └── yes ──► S3c corroboration    │
                                             │               │
                                             ▼               │
                                    S4  what happened next   │
                                    (only if record silent)  │
                                             │               │
                                             └───────────────┤
                                                             ▼
                                                    S7  Check your answers
                                                        + attestation
                                                             │
                                                             ▼
                                                        S8  Done
                                                             │
                                                             ▼
                                              the existing Track Record tool
```

### 11.2 S1 — Start

```
┌──────────────────────────────────────────────────────┐
│  A few quick questions about your                    │
│  past projects                                       │
│                                                      │
│  We searched public county property records for      │
│  deals that might be yours. We found 8 that look     │
│  like a match.                                       │
│                                                      │
│  Go through them one at a time and tell us which     │
│  ones you actually owned. About 3 minutes.           │
│                                                      │
│  Nothing here changes your loan on its own. Your     │
│  loan team checks every one against the county       │
│  records before it counts toward anything.           │
│                                                      │
│      [  Start  ]        Not right now                │
│                                                      │
│  Your answers save as you go. You can close this     │
│  and come back any time.                             │
│                                                      │
│  Where did this come from?                       ▾   │
└──────────────────────────────────────────────────────┘
```

`Where did this come from?` expands to: *"Property sales are public record. We searched the county
records for your name and for the companies on your file. We didn't look up anything about you
personally."*

The time estimate is computed at ~20 seconds per candidate, rounded, and omitted above 20 candidates
(where the honest answer is "you can stop and come back").

### 11.3 S3 — The property card (the core screen)

```
┌──────────────────────────────────────────────────────┐
│  ←  Back              Your past projects        ✕    │
│  ▓▓▓▓▓▓▓░░░░░░░░░░░   3 of 8  ·  5 left              │
├──────────────────────────────────────────────────────┤
│  ↩  You marked 118 Oak Avenue as yours.      Undo    │
├──────────────────────────────────────────────────────┤
│                                                      │
│    ┌────────────────────────────────────────────┐    │
│    │                                            │    │
│    │            [ static map, pin ]             │    │
│    │                                            │    │
│    └────────────────────────────────────────────┘    │
│                                                      │
│    62 Highland Street                                │
│    Lakewood, NJ 08701                                │
│                                                      │
│    Bought      August 2025                           │
│    Sold        March 2026                            │
│    Held by     MW Trading LLC                        │
│                                                      │
│    Show more about this one                      ▾   │
│                                                      │
│    ┌────────────────────────────────────────────┐    │
│    │              Not mine                      │    │
│    └────────────────────────────────────────────┘    │
│    ┌────────────────────────────────────────────┐    │
│    │        Yes — 62 Highland St                │    │
│    └────────────────────────────────────────────┘    │
│                                                      │
│    I'm not sure — set this one aside                 │
│    Skip for now                                      │
│                                                      │
│  ──────────────────────────────────────────────────  │
│  Only mark the ones you actually owned. Your loan    │
│  team checks each one against the county records.    │
│                                                      │
│  Saved. You can close this and come back.            │
└──────────────────────────────────────────────────────┘
```

Notes on the frame:
- Two buttons, identical size and weight, **"Not mine" first**, stacked full-width on a phone.
- `Held by MW Trading LLC` **disappears** once that group's entity question is settled — it is noise
  after that.
- The consequence line and the saved line are permanent, not conditional.

**S3b — "Show more about this one" (expanded)**

```
│    Show more about this one                      ▴   │
│    ──────────────────────────────────────────────    │
│    3-family                                          │
│    Built 1926                                        │
│    Ocean County deed, recorded 19 March 2026         │
│                                                      │
│    [ Show the street ]                               │
```

### 11.4 S3c — The corroboration tap (yes path only)

```
┌──────────────────────────────────────────────────────┐
│  ▓▓▓▓▓▓▓░░░░░░░░░░░   3 of 8                         │
│                                                      │
│  One more thing about                                │
│  62 Highland Street.                                 │
│                                                      │
│  Roughly what did you pay for it?                    │
│                                                      │
│   ( )  Under $300,000                                │
│   ( )  $300,000 – $450,000                           │
│   ( )  $450,000 – $600,000                           │
│   ( )  Over $600,000                                 │
│   ( )  I don't remember                              │
│                                                      │
│      [  Next  ]                                      │
│                                                      │
│  A rough answer is fine — we're only checking we've  │
│  matched the right property.                         │
└──────────────────────────────────────────────────────┘
```

Fallback wording when there is no public price (non-disclosure states):
*"Roughly when did you buy it?"* with four bands, and the card shows only the purchase **year**.
Second fallback: *"Was it a single-family or a multi-family?"* with the unit count withheld from the card.
If none is available, the screen does not render at all.

### 11.5 S2 — Group question, and S5 — compact list

```
┌──────────────────────────────────────────────────────┐
│  ←  Back              Your past projects        ✕    │
│                                                      │
│  12 of the properties we found were bought or        │
│  sold by                                             │
│                                                      │
│      MW TRADING LLC                                  │
│      New Jersey                                      │
│                                                      │
│  Is MW Trading LLC your company?                     │
│  You're an owner, member, or manager of it.          │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │        No — none of these 12 are mine          │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │        Yes — it's my company                   │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  I'm not sure                                        │
└──────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────┐
│  MW Trading LLC — 1 to 6 of 12    Show one at a time │
│  ──────────────────────────────────────────────────  │
│  118 Oak Avenue, Lakewood NJ                         │
│  Bought 2024  ·  Sold 2025                           │
│   [   Not mine   ]   [  Yes — 118 Oak Ave  ]         │
│  ──────────────────────────────────────────────────  │
│  9 Sunset Road, Lakewood NJ                          │
│  Bought 2024  ·  Rented 2025                         │
│   [   Not mine   ]   [  Yes — 9 Sunset Rd  ]         │
│  ──────────────────────────────────────────────────  │
│  … (6 rows maximum)                                  │
│                                                      │
│      [  Next 6  ]                                    │
└──────────────────────────────────────────────────────┘
```

### 11.6 S6 — Task list (13+ candidates)

```
┌──────────────────────────────────────────────────────┐
│  Your past projects                                  │
│                                                      │
│  We found 34 properties that might be yours.         │
│  Do these in any order. Stop and come back any time. │
│  ──────────────────────────────────────────────────  │
│  MW Trading LLC                                      │
│  12 properties                        6 of 12 done   │
│  ──────────────────────────────────────────────────  │
│  Weil Holdings LLC                                   │
│  9 properties                            Not started │
│  ──────────────────────────────────────────────────  │
│  In your own name                                    │
│  5 properties                                 Done   │
│  ──────────────────────────────────────────────────  │
│  We couldn't tell who bought these                   │
│  8 properties                            Not started │
│  ──────────────────────────────────────────────────  │
│                                                      │
│  20 of 34 answered.                                  │
└──────────────────────────────────────────────────────┘
```

### 11.7 S7 — Check your answers

```
┌──────────────────────────────────────────────────────┐
│  Check what you told us                              │
│                                                      │
│  YOURS (5)                                           │
│  ──────────────────────────────────────────────────  │
│  62 Highland Street, Lakewood NJ                     │
│  Sold March 2026                            Change   │
│  ──────────────────────────────────────────────────  │
│  118 Oak Avenue, Lakewood NJ                         │
│  Rented January 2026                        Change   │
│  ── (…3 more) ─────────────────────────────────────  │
│                                                      │
│  NOT YOURS (2)                                Show   │
│  SET ASIDE — you weren't sure (1)             Show   │
│                                                      │
│  Everything above is what you told us. Your loan     │
│  team checks each one against the county records     │
│  before it counts toward anything.                   │
│                                                      │
│  [ ] I've read the list above and it's right, as     │
│      far as I know.                                  │
│                                                      │
│      [  Send this to my loan team  ]                 │
└──────────────────────────────────────────────────────┘
```

### 11.8 Every remaining screen and state, with exact copy

**S4 — What happened next — record is silent**

> **What happened to 62 Highland Street after you finished the work?**
> ( ) I sold it
> ( ) I kept it and rented it out
> ( ) I kept it and refinanced it
> ( ) I still own it — it isn't rented yet
> ( ) Something else `[                    ]`
> `[ Next ]`

**S4b — What happened next — record is not silent**

> **The county records show you sold it in March 2026.**
> `[ Next ]`  ·  *That's not right*

Tapping *That's not right* opens S4 with nothing pre-selected, and records the disagreement.

**S8 — Done**

> **Thanks — that's done.**
> You told us 5 of these are yours. They're on your track record now, marked *waiting for review*.
> Your loan team will check each one and may ask you for a document — usually the closing statement or
> the deed.
> Did we miss any? You can add them yourself.
> `[ See my track record ]`

**S9 — Empty state (the flow is on, nothing released)**

> **Nothing to check right now.**
> When we find properties that might be yours, they'll show up here and we'll let you know.
> `[ See my track record ]`

**S10 — We found nothing**

> **We didn't find anything to check.**
> Public property records don't cover every county, and they're often months behind. That doesn't mean
> anything is missing from your record — it just means we couldn't match anything automatically.
> Add your past projects yourself and we'll take it from there.
> `[ Open my track record ]`

*(This wording is D2 applied to borrower-facing copy: silence is never a negative finding, and the
borrower must never be able to read "we found nothing" as "we don't believe you.")*

**S11 — Resume**

> **Welcome back.** You're on 4 of 8 — 3 already answered.
> `[ Carry on ]`

**S12 — Save failed**

> **We couldn't save that just now.** We're trying again — please don't close this page yet.

and if it fails hard:

> **Your last answer didn't save.** `[ Try again ]`
> Nothing before it was lost.

**S13 — Too many set aside**

> **Let's stop here.**
> You've set aside 9 of these. Your loan team will go through them with you — there's nothing else for
> you to do right now.
> `[ Back to my loan ]`

**S14 — Undo strip (all states)**

> `↩` You marked 118 Oak Avenue as yours. **Undo**
> `↩` You marked 118 Oak Avenue as not yours. **Undo**
> `↩` You set 118 Oak Avenue aside. **Undo**
> `↩` You said none of the 12 MW Trading LLC properties are yours. **Undo all 12**

**Group NO confirmation line** (inline, above the buttons, no modal)

> Choosing *No* takes all 12 off your list. You can undo it straight afterwards.

**Entity not recognised — the probe**

> **Do you know this property?**
> 62 Highland Street, Lakewood, NJ 08701 — one of the 12 bought by MW Trading LLC.
> `[ No, I don't know it ]`  `[ Yes, I know that one ]`

and if they know the property but not the company:

> **That's normal.** Companies often get set up at closing and are easy to forget.
> We'll ask for the deed or the closing statement for 62 Highland Street — it names the company that
> bought it, and that settles it for all 12.
> `[ OK ]`

**Something looks wrong (yes path, after corroboration)**

> *Something here looks wrong* → `[ Tell us what's wrong ]`
> **What's not right about 62 Highland Street?**
> `[                                              ]`
> This goes to your loan team. It won't hold anything up.

### 11.9 What a "yes" writes, exactly

| Field | Value |
|---|---|
| `track_records` row | created via the **same import chokepoint staff use** (§9.2 verb 2), including the entity chokepoint (§4.2) |
| `verification_status` | `pending` — never anything else (D1; db/485 is the backstop, not the mechanism) |
| `is_verified` | `false` |
| `entered_by_kind` | **`borrower_confirm`** — a NEW value, distinct from `borrower` (typed in the tool) and `staff_import`. D4 requires it be stamped at insert. |
| `deal_type` | from S4 when asked, else derived; `deal_type_source='borrower_confirm'` when the borrower answered, so the D2 fix protects it |
| three pillars | one row each at `auto_verdict = NULL` |
| candidate row | `status='imported'`, `imported_track_record_id` set, `decided_by=NULL`, `decided_at=now()` |
| corroboration | `{ asked, kind, answer, matched }` on the candidate — staff-only, never a finding |
| audit | one row per decision — D6's gap is that the borrower create door is unaudited today |
| `requested_exp_*` | **untouched** (§1 rule 5) |

---

## 12. HOW WE WILL KNOW IT WORKED

The temptation is to measure completion. Completion is the constraint, not the goal.

| Rank | Metric | Notes |
|---|---|---|
| **1** | **Staff overturn rate on borrower-confirmed lines** | The ground truth: a line the borrower marked *yes* that staff later find is not theirs, or `contradicted` under Check B. There is no industry benchmark; baseline it before tuning anything. Takes weeks per data point, which is why #2 exists. |
| **2** | **False-yes rate on declined near-misses (foils)** | §3.3. Fast, per-batch, and the only quick read on whether §3.2 is working. |
| **3** | Completion rate, and abandon position | Where in the run people stop tells you whether grouping is doing its job. |
| **4** | Median time per card, and the distribution's left tail | A cluster under ~3 seconds is rubber-stamping, whatever the completion rate says. |
| **5** | "I'm not sure" rate, and how many staff resolve | A high unsure rate with a high staff resolution rate is a **success** — the flow surfaced exactly the properties that needed a human. |
| **6** | Undo rate, and answer-change rate on the summary | A healthy number here means the summary is doing its job. |

**The guardrail, stated so nobody can miss it: a rise in completion accompanied by a rise in overturn is
a failure, not a win.** If those two move together, the change made it easier to say yes, which is the
one thing this flow must never do.

---

## 13. BUILD LIST — prioritized

### P0 — the spine. Nothing else works without it.

1. **Fix D2 first** (`ingest.js:677` — write `deal_type` only on an `inferred` row untouched by a human).
   The flow's most gameable field is silently clobbered until this lands. It is one line and a test.
2. **The schema delta on top of what already exists.** `db/496` created
   `track_record_candidates` with `status CHECK (status IN ('staged','imported','merged','declined','snoozed'))`,
   and `db/504` has since added `decided_by_borrower`, `decided_by_kind ('staff'|'borrower')`,
   `borrower_seen_at`, the one-decider constraint and the borrower-answered index — so *who answered* is
   already modelled, and db/504's reasoning about a borrower's "no" being recoverable is the same
   conclusion §5.3 reaches from the other direction. **What is still missing for this flow:**

   | Needed | Where | Why |
   |---|---|---|
   | `released_to_borrower_at`, `released_by` | `track_record_candidates` | §1.1 — the borrower must never see an unreleased candidate. Without this there is no boundary between a raw search and a borrower's screen. |
   | `unsure` in the `status` CHECK | `track_record_candidates` | §5.3 — *"I'm not sure"* and *"skip"* are different states and need different staff actions. Widening a CHECK needs the db/493/495 `NOT VALID` + guarded-`DO` pattern db/504 already uses. |
   | `borrower_skipped_at` | `track_record_candidates` | §5.3 — a skip stays `staged`; the timestamp is what re-queues it at the end of the run instead of immediately. |
   | `corroboration jsonb` | `track_record_candidates` | §3.2 move 5 — `{ asked, kind, answer, matched }`. Staff-only, never a finding. |
   | `entered_by_kind = 'borrower_confirm'` | `track_records` | D4 — stamped at insert, distinct from `borrower` (typed in the tool) and `staff_import`. |
   | `deal_type_source` | `track_records` | §8.3 — what makes the D2 fix able to protect a borrower's answer. |
3. **The staff release gate** — a button on the staging queue, a column, and a filter on the borrower
   route. The borrower must never see an unreleased candidate (§1.1).
4. **`GET /api/borrower/track-record-candidates`** and **`POST .../:id/decision`** — decisions idempotent
   on `(candidate_id, borrower_id)`, audited, saved per answer, returning the next card.
5. **The `pending` write path** — reuse the staff import chokepoint and the entity chokepoint verbatim.
   Prove with a test that `requested_exp_*` is untouched.
6. **S3, the one-at-a-time card**, with the non-negotiables: address inside the yes button, "Not mine"
   first, honest progress with a denominator, persistent Undo, save-per-answer, resume at the first
   unanswered.

### P1 — makes it a flow rather than a screen

7. **S2 group question** + bulk decline with a single group-level Undo + the not-recognised probe.
8. **S7 check-your-answers** + the end attestation + **S8 done**.
9. **S1, S9, S10, S11, S12** — start, empty, found-nothing, resume, save-failed.
10. **The accessibility pass**: focus-to-heading on advance, `aria-live` progress, `role="group"` cards,
    sr-only address in every button name, `role="status"` Undo above the card, 48px targets, 16px gap,
    reduced motion, the `overflow-x` and 16px-control checks at `innerWidth === 390`.

### P2 — the accuracy devices

11. **S3c corroboration tap**, with the full three-rung fallback ladder and the `unavailable` outcome.
12. **Deal type**: derive-and-state first (S4b), ask only when silent (S4). Never render a requirement.
13. **The map thumbnail** — current card plus one prefetch, cached forever on the canonical address,
    hard per-borrower ceiling, degrades cleanly to no map.
14. **S5 compact list** inside a settled group, 7-row cap, deferred corroboration taps.

### P3 — scale and measurement

15. **S6 task list** for 13+ candidates, with per-group statuses.
16. **Foil measurement** — real declined near-misses only, aggregate-only, never on the file (§3.3).
17. **The not-sure ceiling** and S13.
18. **Email / SMS re-entry** under §6.4's content and authentication rules.

### P4 — instrument, then tune

19. Per-card dwell time, answer, revision, undo, abandon position; foil false-yes rate; staff overturn
    rate. Then, and only then, tune the thresholds this document guessed at: the 600–800 ms yes floor,
    the 30% unsure ceiling, the 7-row list cap, the 12-candidate grouping threshold.

---

## 14. OPEN QUESTIONS FOR THE OWNER

1. **Foils.** Are we comfortable showing a borrower one or two real near-misses that staff already
   declined, purely to measure our own false-yes rate — knowing the results are aggregate-only and never
   touch their file? If not, do we want the periodic-sample version instead, or none at all?
2. **The corroboration tap.** It adds one screen to every *yes*. On an eight-property batch that is five
   extra screens. Worth it? My recommendation is yes, and it is the single strongest anti-rubber-stamp
   device available — but it is the one place this design deliberately spends the borrower's patience.
3. **The map.** It costs a paid static-map call per candidate (cached forever). Approve, or ship without
   it and add it once the false-yes baseline says whether recognition is the bottleneck?
4. **The not-sure ceiling.** 30% is a guess. Is handing a borrower's whole batch to staff at that point
   the behaviour you want, or should it keep going and just flag it?
5. **Who releases a batch**, and does a release need a second pair of eyes on a common-name borrower
   (D5)? The release gate is the only thing standing between a shared-name search and one borrower seeing
   another's property.

---

## 15. SOURCES

**Form structure and completion**
- [GDS Design Notes — *one thing per page* (2015)](https://designnotes.blog.gov.uk/2015/07/03/one-thing-per-page/)
- [GOV.UK Service Manual — Structuring forms](https://www.gov.uk/service-manual/design/form-structure)
- [GOV.UK Design System — Complete multiple tasks (task list)](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)
- [NHS digital service manual — Check answers](https://service-manual.nhs.uk/design-system/patterns/check-answers)
- [Smashing Magazine — Better Form Design: One Thing Per Page (Just Eat case study)](https://www.smashingmagazine.com/2017/05/better-form-design-one-thing-per-page/)
- [Baymard Institute — Checkout Optimization: Minimize Form Fields](https://baymard.com/blog/checkout-flow-average-form-fields)
- [NN/g — Four principles to reduce cognitive load in forms](https://www.nngroup.com/articles/4-principles-reduce-cognitive-load/)

**Question format, acquiescence and satisficing**
- Smyth, Dillman, Christian & Stern (2006), *Comparing Check-All and Forced-Choice Question Formats in Web Surveys*, POQ 70(1) — [abstract](https://academic.oup.com/poq/article-abstract/70/1/66/1891521) · [full text](https://digitalcommons.unl.edu/cgi/viewcontent.cgi?params=/context/sociologyfacpub/article/1684/&path_info=Smyth_2006_POQ_Comparing_check_all__DC_VERSION.pdf)
- Saris, Revilla, Krosnick & Shaeffer (2010), *Comparing Questions with Agree/Disagree Response Options to Questions with Item-Specific Response Options*, Survey Research Methods 4(1) — [SRM](https://ojs.ub.uni-konstanz.de/srm/article/view/2682)
- [Response-scale characteristics that affect data quality — literature review (Quality & Quantity)](https://pmc.ncbi.nlm.nih.gov/articles/PMC5993837/)
- Krosnick, Holbrook, Berent, Carson, Hanemann et al. (2002), *The Impact of "No Opinion" Response Options on Data Quality*, POQ 66(3) — [Oxford](https://academic.oup.com/poq/article/66/3/371/1836194) · [PDF](https://gspp.berkeley.edu/archived/files/research/pdf/Krosnick_et_al..pdf)
- Krosnick & Alwin (1987), response-order effects — mechanism summarised in [GESIS Survey Guidelines: Response Biases](https://www.gesis.org/fileadmin/admin/Dateikatalog/pdf/guidelines/response_biases_standardized_surveys_bogner_landrock_2016.pdf)
- Liu & Cernat (2018), *Item-by-item Versus Matrix Questions*, Social Science Computer Review — [SAGE](https://journals.sagepub.com/doi/10.1177/0894439316674459) · [Grid vs item-by-item on PC and mobile](https://dl.acm.org/doi/abs/10.1177/0894439317735307)

**Over-claiming, rubber-stamping, and what does not work**
- [Paulhus Lab — the overclaiming technique](https://paulhuslab.psych.ubc.ca/research/overclaiming/) · [Paulhus, Harms, Bruce & Lysy (2003), JPSP](https://www2.psych.ubc.ca/~dpaulhus/research/SDR/downloads/ARTICLES/JPSP.2003.with.Harms.Bruce.Lysy.pdf)
- Obar & Oeldorf-Hirsch (2020), *The biggest lie on the internet*, Information, Communication & Society 23(1) — [SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2757465) · [T&F](https://www.tandfonline.com/doi/full/10.1080/1369118X.2018.1486870)
- Kristal, Whillans, Bazerman, Gino, Shu, Mazar & Ariely (2020), *Signing at the beginning versus at the end does not decrease dishonesty*, PNAS — [PNAS](https://www.pnas.org/doi/10.1073/pnas.1911695117) · [HBS](https://www.hbs.edu/faculty/Pages/item.aspx?num=57627) · [Data Colada #98 — evidence of fraud in the 2012 original](https://datacolada.org/98)

**Motivation and progress**
- Nunes & Drèze, *The Endowed Progress Effect: How Artificial Advancement Increases Effort* — [paper](https://www.researchgate.net/publication/23547282_The_Endowed_Progress_Effect_How_Artificial_Advancement_Increases_Effort)

**Recognition, recall and identity verification**
- [Consumer Reports — consumers locked out of their own credit reports by verification questions](https://www.consumerreports.org/credit-scores-reports/consumers-found-errors-in-their-credit-reports-a6996937910/) · [CR advocacy release](https://advocacy.consumerreports.org/press_release/almost-half-of-participants-in-credit-checkup-study-find-errors-on-credit-reports-more-than-a-quarter-find-serious-mistakes/)
- [Experian Insights — KBA best practices (Gartner 10–15% legitimate-customer failure)](https://www.experian.com/blogs/insights/knowledge-based-authentication-kba-best-practices-part-3-v4/)
- [Alloy — why knowledge-based authentication is not effective](https://www.alloy.com/blog/answering-my-own-authentication-questions-prove-that-theyre-useless)

**Accessibility, mobile and links**
- [WCAG 2.2 SC 2.5.8 Target Size (Minimum)](https://wcag22aa.org/new-criteria/target-size/)
- [MDN — aria-live](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live) · [Accessible Vue — conveying state changes to screen readers](https://accessible-vue.com/chapter/5/)
- [Magic-link security — referrer leakage, scanner pre-clicks, one-time tokens](https://guptadeepak.com/mastering-magic-link-security-a-deep-dive-for-developers/)

**Comparable products**
- [Plaid Link — account selection and the returning-user experience](https://plaid.com/docs/link/returning-user/) · [Plaid — account onboarding](https://plaid.com/use-cases/banking-and-brokerage/account-onboarding/)

### Where the evidence is thin, and I am not going to pretend otherwise

- **No study I found measures false-yes rates in a property-confirmation task, or in any "is this yours?"
  verification flow with ground truth.** The survey literature is the closest transferable body of work,
  and its outcome measures (endorsement counts, processing depth, response latency) are proxies. That is
  the whole reason §3.3 proposes measuring our own rate rather than citing someone else's.
- **The thumb-zone guidance is practitioner-derived**, not peer-reviewed. Hoober's 2013 observational
  study is the usual citation; treat it as a heuristic.
- **I could not find a usable public teardown** of a credit-bureau "is this account yours" dispute
  screen, of Rocket Money's discovered-subscription confirmation, or of a background-check address-history
  confirmation UI. The searches returned marketing material, not design detail. If those comparables
  matter to the decision, the honest way to get them is to open accounts and screenshot the flows.
- **The 600–800 ms yes floor, the 30% unsure ceiling, the 12-candidate grouping threshold and the
  ~20 s/card time estimate are engineering judgements**, not findings. They are in P4 to be tuned against
  real numbers. The **7-row list cap is the one threshold with a research basis** (the 5–7 row grid
  finding), and even that is a practitioner consensus rather than a single decisive experiment.
