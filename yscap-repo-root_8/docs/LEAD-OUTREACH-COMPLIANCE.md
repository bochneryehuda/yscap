# Skip trace, calling and recording — the rules to build around

Research for the officer-CRM / skip-trace / call-recording work. **This is not legal advice
and nothing here is a substitute for counsel** — it is the set of rules a careful engineer
designs around, plus the specific items to put in front of a lawyer.

Context: YS Capital makes **business-purpose** loans to real-estate investors. That helps in
places and, importantly, **does not help in the places people assume it does.**

---

## 1. The assumption that would have hurt us

> *"We're calling investors about a commercial loan, so telemarketing rules don't apply."*

That is wrong, and it is the single most expensive misconception in this area.

The business-to-business exemption is in the **FTC's Telemarketing Sales Rule**. It is
**not** a TCPA/FCC exemption and carries **no shield against a private lawsuit**. The
do-not-call rules in 47 CFR 64.1200 run on a completely separate track from the
autodialer rules, and the FCC treats a **personal wireless number as presumptively
residential**. A real-estate investor's cell phone, an LLC run from a kitchen table, a sole
proprietor — those are precisely the mixed-use cases where the B2B argument fails.

Exposure is **$500 per call, $1,500 if willful, no cap, and class-actionable.**

---

## 2. Calling a skip-traced number

**What is settled and works in our favour:** a **live, human-dialed** call with no
prerecorded or synthetic voice is generally outside TCPA §227(b). After *Facebook v. Duguid*
(2021) an autodialer means equipment using a **random or sequential number generator**, and
dialing from a curated list is not that. So the lack of consent is not by itself a §227(b)
problem for a human-dialed live call.

**What still applies regardless of consent:**

| Rule | Requirement |
|---|---|
| National DNC Registry | Scrub before calling. Safe harbour needs a scrub **no more than 31 days** old, with records of the process. |
| Internal do-not-call list | Required *independently* of the national registry: written policy on demand, staff training, requests recorded and honoured, **retained 5 years**. |
| Calling hours | **8:00 a.m. – 9:00 p.m. in the called party's local time** — not our office's. |
| Opening disclosure | Caller's name, the legal entity being called on behalf of, and a callback number. |
| Revocation | Since April 2025, a revocation made by **any reasonable means** must be honoured — so "don't call me again" typed in a free-text note has to be capturable as a structured opt-out, company-wide, across every channel. |

**Never automate, at all:** prerecorded or AI-voice outreach, ringless voicemail,
predictive/progressive dialing into a skip-traced list, or any "call everyone on this list"
button that removes a human choosing each number. Each of those converts a defensible
manual call into a §227(b) claim.

**State mini-TCPAs are the real risk, because they deliberately reject *Duguid*:**

- **Florida (FTSA)** — prior express *written* consent for an automated system for the
  selection **and** dialing; max 3 calls per 24 hours on the same subject; cut-off at 8 p.m.;
  $500–$1,500 per call.
- **Oklahoma (OTSA)** — same shape but "selection **or** dialing", which is broader.
- **Washington (CEMA / RCW 19.158)** and **Maryland** — broad "commercial solicitation"
  definitions, private rights of action, plus state consumer-protection exposure.

## 3. Recording the call

**All-party ("two-party") consent states** — treat this as the design set, not a legal
conclusion, since several have judicial nuance:

> California, Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan,
> Montana, Nevada, New Hampshire, Oregon, Pennsylvania, Vermont, Washington

**Pennsylvania is on that list, and we lend there.**

Two findings that decide the design:

1. **California Penal Code §632.7 covers cellular calls specifically, and *Smith v. LoanMe*
   (Cal. 2021) held it applies to the *parties* to a call, not just eavesdroppers.** Every
   skip-traced number is a cell phone. California allows **$5,000 per violation or 3× actual
   damages with no injury required** — that is the class-action engine.
2. **On an interstate call there is no clean choice-of-law rule**, and *Kearney v. Salomon
   Smith Barney* applied California's all-party law to an out-of-state firm. The only
   workable answer is to **apply the strictest rule to every call**.

So: a recorded announcement on **100% of recorded calls, in both directions**, played
**before any audio is written to disk** — with the recording buffer discarded if the
announcement fails to play. Log the announcement, its version, and the timestamp per call.
Give the officer a control that stops recording and lets the call continue unrecorded.

**The 2025–26 twist:** a wave of wiretap suits (e.g. *In re Otter.AI*) treats an
**AI transcription or notetaking vendor as an unconsented third-party listener** even when
both parties consented to *our* recording. If we ever transcribe, the announcement has to
say "recorded **and transcribed**", and the vendor needs a DPA with no-training and
no-secondary-use terms.

---

## 4. The architectural finding: marketing data and underwriting data must not touch

This is the one that changes the build, and it is why the two things the owner asked for —
*"skip trace for my officers"* and *"use it for track-record underwriting"* — have to be
built as **two separate systems that share nothing but a vendor login.**

- **Contact/skip-trace data is not automatically a "consumer report" — it becomes one based
  on how it is USED.** FCRA §1681a(d)(1)(C) reaches information collected or expected to be
  used for "any other purpose authorized under §1681b", and a business-purpose commercial
  loan **is** such a purpose (§1681b(a)(3)(A) and (F)). So a commercial loan does not put us
  outside FCRA.
- **Marketing is NOT a permissible purpose.** Cold-calling an owner to pitch a loan is not a
  §1681b purpose. Skip-trace products are almost always sold under a **non-FCRA
  certification** — and **§1681b(f) makes it unlawful to obtain a report without certifying
  the purpose**, while **§1681q makes obtaining it under false pretenses a federal crime.**
- **Calling it "public data" does not help.** In the *Kelly v. RealPage* line a public-records
  search vendor was itself held to be a consumer reporting agency because it furnishes
  reports.
- **DPPA** (18 U.S.C. §2721) restricts anything sourced from **motor vehicle records** —
  solicitation requires the individual's express consent, resale is restricted, and the
  civil remedy is **not less than $2,500** liquidated damages. Skip-trace waterfalls commonly
  include DMV-derived data.

**The design rule, enforced at the query layer and not by policy:**

```
  MARKETING PLANE                          UNDERWRITING PLANE
  skip-traced phone/email                  deed & mortgage history
  non-FCRA vendor product                  pulled under a certified permissible purpose
  used to cold-call                        used to corroborate a claim
  ── may NEVER be joined to ──▶  ✗  ◀── may NEVER pull from ──
```

Every ingested field gets tagged with: vendor, product SKU, the vendor's own FCRA
classification, a DPPA-source flag, the permissible purpose asserted, the timestamp, and the
id of the human who asked for it. A join from a marketing-plane field into an underwriting
decision record is **blocked in code**.

**Never automate:** promoting marketing-plane data into an underwriting decision; using a
skip-trace product to price or decline a loan; exporting enriched contact data anywhere;
using DPPA-sourced fields for solicitation.

---

## 5. Verifying a borrower's claimed experience from recorded deeds

This is a real risk area, and the mitigations map almost exactly onto machinery this repo
already has:

1. **Show the borrower the data and let them dispute or explain it BEFORE the decision.**
   (This is what the existing condition/finding flow does — a finding a human must resolve.)
2. **Log the exact records relied on**, with source and pull date.
3. **If a decline or worse terms rest on it, an adverse-action notice is required.** ECOA /
   Reg B applies to **business** credit too (statement of reasons on request), and because
   the data came from a **third-party vendor** rather than our own county-records pull, it
   should be treated as a consumer report — which adds the FCRA §615(a) notice.
4. **Never let it decide anything by itself.** Advisory, human-resolved, recorded — which is
   already the governing rule for every AI/automated finding in this system.

Also: pulling a **personal guarantor's** report creates FCRA obligations. Reg B's
adverse-action definition excludes guarantors, so the §615(a) notice is generally not
required for a *pure* guarantor — but it **is** required where that person is a co-borrower
or otherwise personally liable as an applicant.

---

## 6. Genuinely unsettled — design conservatively

- Whether "credit header" identity data (name, address, phone, SSN) is a consumer report.
  The CFPB proposed saying yes in Dec 2024 and then **withdrew the rule on 15 May 2025**, so
  the ambiguity is back and state law (CCPA/CPRA, Texas, Oregon, the Vermont/California
  data-broker registries) is filling the gap.
- Whether a personal cell used partly for business is a "residential subscriber" for DNC
  purposes — the plaintiff bar litigates this hard and often wins on the presumption.
- Whether building a shared "investor experience score" that we surface to partners or note
  buyers would make **us** a consumer reporting agency. In-house use of records we pull
  ourselves generally avoids it; furnishing to third parties likely does not.

---

## 7. For counsel

Four specific questions, not a general review:

1. Does our Elementix contract permit our actual intended uses — and is their contact
   product classified FCRA or non-FCRA?
2. The marketing→underwriting boundary: is deed-based experience verification acceptable as
   an advisory, human-resolved corroboration, and what adverse-action notice do we owe when
   terms move because of it?
3. State mini-TCPA exposure in FL / OK / WA / MD given a manual-dial-only posture.
4. Does an AI transcription step in our call stack create third-party wiretap exposure?

---

## Sources

TCPA / DNC: [OCC Comptroller's Handbook — TCPA](https://www.occ.gov/publications-and-resources/publications/comptrollers-handbook/files/telephone-consumer-protection-act/pub-ch-telephone-consumer-protection-act.pdf) ·
[47 CFR 64.1200](https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200) ·
[FTC — Complying with the TSR](https://www.ftc.gov/business-guidance/resources/complying-telemarketing-sales-rule) ·
[FTC — DNC Q&A](https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0) ·
[MarketingProfs — the B2B exemption](https://www.marketingprofs.com/articles/2018/34679/the-b2b-exemption-to-the-telemarketing-sales-rule) ·
[Manatt — state mini-TCPAs](https://www.manatt.com/insights/newsletters/tcpa-connect/state-mini-tcpa-telemarketing-laws-continue-to-p) ·
[Goodwin — mini-TCPA laws](https://www.goodwinlaw.com/en/insights/publications/2023/02/02_28-mini-tcpa-laws-you-should-know) ·
[BCLP — opt-out rules effective April 2025](https://www.bclplaw.com/en-US/events-insights-news/the-tcpas-new-opt-out-rules-take-effect-on-april-11-2025-what-does-this-mean-for-businesses.html) ·
[Nixon Peabody — FCC partially delays revocation rules](https://www.nixonpeabody.com/insights/alerts/2025/04/11/fcc-partially-delays-new-tcpa-consent-revocation-rules)

Recording: [State recording-law table](https://en.wikipedia.org/wiki/Telephone_call_recording_laws) ·
[Seyfarth — *Smith v. LoanMe*](https://www.seyfarth.com/news-insights/california-supreme-courts-holds-that-recording-cell-phone-calls-without-consent-is-unlawful-and-subjects-recorders-to-class-action-exposure.html) ·
[Recording Law — CIPA](https://www.recordinglaw.com/us-laws/federal-recording-laws/cipa-california-invasion-of-privacy-act/) ·
[Privacy Rights Clearinghouse — CIPA](https://privacyrights.org/resources-tools/law-overviews/california-invasion-privacy-act-cipa)

FCRA / DPPA: [15 U.S.C. §1681a(d)](https://www.law.cornell.edu/definitions/uscode.php?def_id=15-USC-700254050-1343175280) ·
[CFPB — FCRA exam procedures](https://files.consumerfinance.gov/f/documents/102012_cfpb_fair-credit-reporting-act-fcra_procedures.pdf) ·
[CFPB — permissible purposes advisory opinion](https://www.consumerfinance.gov/rules-policy/final-rules/fair-credit-reporting-permissible-purposes-for-furnishing-using-and-obtaining-consumer-reports/) ·
[Federal Register — data-broker rule withdrawal (May 2025)](https://www.federalregister.gov/documents/2025/05/15/2025-08644/protecting-americans-from-harmful-data-broker-practices-regulation-v-withdrawal-of-proposed-rule) ·
[Ballard Spahr — public-records vendor held a CRA](https://www.consumerfinancemonitor.com/2022/03/08/pennsylvania-federal-district-court-rules-public-records-vendor-is-consumer-reporting-agency-subject-to-fair-credit-reporting-act/) ·
[Compliance Alliance — FCRA and commercial loans](https://compliancealliance.com/news-events/newsletter/november-2022-newsletters/the-fcra-and-commercial-loans/) ·
[18 U.S.C. §2721 (DPPA)](https://www.law.cornell.edu/uscode/text/18/2721) ·
[EPIC — DPPA overview](https://epic.org/dppa/)
