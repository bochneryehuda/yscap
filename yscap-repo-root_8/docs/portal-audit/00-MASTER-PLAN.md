# YS Capital Portal — Big Look-Back Audit

**Owner:** Yehuda
**Started:** July 2026
**Rule for this whole project:** We only *write up* problems and how to fix them.
We do **NOT** change any code yet. First we find everything, section by section.
Later, once the list is complete, we start building the fixes.

---

## Why we're doing this

We've built a lot of this portal over many chats. Every chat added a feature,
fixed a bug, or changed how something works. Nobody has ever gone back to the
beginning and asked, for **each thing we built**:

1. **What was I actually trying to do?** (the goal behind the code)
2. **Did we really get it?** (is it working the way I wanted, all the way?)
3. **What did we miss?** (the "what if" cases nobody thought about)
4. **Is anything leaking?** (is the borrower seeing things only staff should
   see — or the other way around?)

This audit answers those four questions for every part of the portal.

---

## The two big worries that run through everything

This portal has **two sides**, and most of the danger lives on the line between
them:

- **The borrower side** — the customer applying for a loan. They should see
  **only their own file**, and only the *borrower-safe* version of it.
- **The staff side** — loan officers, processors, underwriters, admins. They see
  the inside: notes, our cost, our capital partners, other people's files.

For **every** section we check both directions:

- **Is staff-only information leaking to the borrower?**
  (Example: our capital-partner names — BlueLake, Temple View, RCN, Churchill,
  Fidelis — must **never** show up on a borrower's screen, email, or PDF. The
  borrower only ever sees "the Gold Standard program.")
- **Can the borrower reach a staff feature they shouldn't?**
  (Example: could a borrower open another borrower's file, or hit a staff-only
  button, or make themselves look "approved"?)
- **Can a loan officer reach something above their pay grade?**
  (Example: can a loan officer see a file they were never assigned to, sign off
  their own conditions, or reveal a Social Security number without it being
  logged?)
- **What would a borrower *want* to do that we didn't plan for?**
  And **what would a loan officer want** that the borrower already has (or vice
  versa)? We think these through on purpose, not by accident.

---

## How each section is examined ("bringing in the AI brain")

For each section we don't just eyeball it. We send **several AI agents** at the
same code from **different angles** — one plays the attacker, one plays the
confused borrower, one plays the loan officer who wants more than they should,
one checks "does this even do what the chats asked for." Then we combine what
they find, throw out the false alarms, and keep only the real ones.

That's how we "go deeper than what I want to accomplish" — the agents surface
the *what-ifs* you'd never think to ask about until it's a problem.

---

## The format of every finding (so it's easy to read)

You're not a developer, so every single problem is written the same simple way,
in plain language. Three short parts:

> **🐞 THE BUG** — what's wrong, in one or two sentences.
>
> **🔎 TROUBLESHOOTING** — how we found it and what's actually happening
> underneath. (This is the "why," in normal words.)
>
> **🔧 THE FIX (as a command)** — what we'd tell the builder to do, written as a
> plain instruction — *not* code. Something you could hand to any developer.

Each finding also gets:

- A **number** (like `S1-03`) so we can talk about it later.
- A **severity**: 🔴 Critical / 🟠 High / 🟡 Medium / ⚪ Low.
- A one-line **"where"** (which file), so the builder knows where to look.

We do **not** fix anything now. The fix line is just the plan.

---

## The sections (our week-by-week map)

We go **one section at a time**, slowly. Each section is its own document in
this folder. Rough order (we can reorder as we learn):

| # | Section | What it covers | Status |
|---|---------|----------------|--------|
| **1** | **The Front Door — Accounts & Access** | Login, register, MFA, password reset, staff invites, roles/permissions, who-can-see-which-file, borrower-vs-staff boundary | ✅ **Done** → [read it](./01-accounts-and-access.md) |
| 2 | The Borrower's File — What the Borrower Sees | Borrower dashboard + their loan file: what data shows, what leaks, capital-partner names, status timeline | ✅ **Done** → [read it](./02-borrower-file.md) |
| 3 | The Loan Officer's Desk — Pipeline & Staff File | Staff pipeline + the staff file view, file scoping in depth, SSN/PII reveal, edit/assign/verify | ✅ **Done** → [read it](./03-loan-officer-desk.md) |
| 4 | Documents & Uploads | Uploading, downloading, who's allowed to open which document, appraisal-card reuse, OCR | ✅ **Done** → [read it](./04-documents-and-uploads.md) |
| 5 | Conditions & Checklist Engine | Condition Studio, rules, borrower-label vs internal-label, sign-off integrity, waive, internal conditions | ⬜ Planned |
| 6 | Messaging & Chat | Borrower↔staff chat, internal staff chat, mentions, PII guard, attachments, the live stream | ⬜ Planned |
| 7 | Notifications & Email | In-app + email, wrong-recipient risk, capital-partner names in emails, link correctness | ⬜ Planned |
| 8 | Entities, Track Record & Profile | LLCs, 3-year track-record window, co-borrower, experience/liquidity math, profile edits | ⬜ Planned |
| 9 | Public Site, Tools & Lead Capture | Marketing tools, loan application, the frozen pricing engines, lead capture, intake key | ⬜ Planned |
| 10 | Integrations — ClickUp / Encompass Sync | Two-way sync, what internal data flows out, webhook security, the sync queue | ⬜ Planned |
| 11 | PII, SSN & Audit — the Data-Protection Sweep | SSN encryption end to end, redaction everywhere, audit trail, full capital-partner-name sweep across every surface | ⬜ Planned |
| 12 | Deployment, Config & Resilience | Secrets, health checks, storage that survives deploys, rate limits, error handling, caching | ⬜ Planned |

---

## The running scoreboard

As we finish each section we tally the findings here so you can see the whole
picture growing:

| Section | 🔴 Critical | 🟠 High | 🟡 Medium | ⚪ Low | Total |
|---------|:-:|:-:|:-:|:-:|:-:|
| 1 — Accounts & Access | 1 | 4 | 6 | 5 | **16** |
| 2 — The Borrower's File | 0 | 3 | 6 | 4 | **13** |
| 3 — The Loan Officer's Desk | 1 | 3 | 6 | 2 | **12** |
| 4 — Documents & Uploads | 1 | 1 | 6 | 3 | **11** |
| **Running total** | **3** | **11** | **24** | **14** | **52** |

_(Filled in at the end of each section's write-up.)_

---

## How we'll run it, week by week

1. **One section per sitting.** We do not rush the whole portal at once — that's
   how things get missed.
2. Each sitting: point the AI agents at that section, gather findings, write them
   up in the simple format above, update the scoreboard.
3. You read it, tell me what you agree with, and we mark anything you want to
   drop or reprioritize.
4. **Only after the whole list exists** do we start building fixes — worst and
   most dangerous first.

Next up after this document: **Section 1 — The Front Door (Accounts & Access).**
