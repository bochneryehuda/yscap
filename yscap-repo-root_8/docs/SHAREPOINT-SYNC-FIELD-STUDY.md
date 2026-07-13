# SharePoint Sync — Field Study & Enhancement Research

_Research report (owner-requested, 2026-07-13). Read-only study of the real Pipeline Drive
tree + the running integration. **No implementation in this document** — it is the input for
deciding what to build next. All statistics are aggregates; no borrower names, addresses, or
other customer identifiers appear here._

---

## 1. What the real tree actually looks like (full crawl, depth 4)

| Level | Count | Shape |
|---|---|---|
| Officer level | 25 folders | 19 person-shaped; ~6 non-person areas (firm-wide, lender apps, private, imports) |
| Borrower level | 404 folders + **108 loose files** | 248 person-shaped; ~150 non-person (stage/category folders sitting at borrower level, sub-teams) |
| "Address" level | 602 folders + **829 loose files** | only **247 look like addresses**; 51 stage-like ("Open loan", "closed"); **304 other** (categories, misc) |
| Level 4 | 3,668 entries | the firm's real taxonomy emerges (below) |

**The humans' de-facto document vocabulary** (level-4 folder-name frequency):
`closing` (121) · `title` (96) · `insurance` (95) · `llc` (95) · `appraisal` (89) · `credit` (82) ·
`application` (69) · `id` (65) · `approval` (60) · `open loan` (59) · `disclosures` (58) · `identification` (47).

**Who writes to the tree:** 1,620 of the app-created items were made by **OneDrive SyncEngine** —
i.e. staff manage these folders through **synced local folders in Windows Explorer**, not the
SharePoint web UI. (Remaining app identities: Microsoft Graph = our sync, Office, OneDrive
clients.) Design implication: the tree IS the staff's filesystem; anything we create must read
naturally in Explorer, and humans will freely rename/move things offline.

**Duplicates are rare.** Measured with our own matcher across the real names: **1** same-borrower
folder pair inside one officer, **0** same-address pairs inside one borrower, and 9 borrower names
appearing under 2+ officers (expected — shared/referred clients; per-officer scoping already
isolates them). The tree is human-messy in *hierarchy*, not in *duplication* — which validates the
conservative "create, never guess" matcher stance.

**Our footprint so far:** 15 `YS portal syncing` folders (early backfill passes + test fixtures),
1 marker-suffixed folder (the `, YS portal sync` marker shipped after those were created).

**Uploader coverage (owner question):** the mirror keys off the `documents` table, not the
uploader — borrower, loan officer, processor, back office, chat, tool exports and TPR exports all
INSERT into the same table; all 10 insert sites kick an instant pass and the 5-minute sweep
catches anything else. Verified by the audit fleet; no uploader-based filter exists anywhere in
the sync SQL.

---

## 2. How the integration behaves in situ (observations)

- The failed first-pass window (pre-hotfix) created officer/borrower/address folders for ~23
  documents **without** the marker suffix (it didn't exist yet). They are cached and will be
  reused; they simply lack the marker. Harmless; rename manually if desired (we never rename).
- Because only 247/602 level-3 folders are address-shaped, most files will NOT fuzzy-match an
  existing address folder and will get a **new marked address folder next to the human's stage
  folders** — exactly the owner-approved behavior, but staff should expect to see both layouts
  side by side inside borrower folders.
- The condition-folder names we create come from portal checklist labels (e.g. "Executed
  purchase contract"), while the humans' vocabulary is shorter ("closing", "title", "credit").
  There's an opportunity to speak their language (see idea #2).

---

## 3. Enhancement ideas (ranked; research only — nothing below is built)

### Tier 1 — high value, low risk
1. **Canonicalize addresses at the source.** The portal already runs an address
   verification/autocomplete proxy (`/api/address`). Normalizing every application's
   `property_address` to its canonical USPS-style form at intake (and storing the canonical
   string alongside the raw one) makes folder names deterministic and collapses the entire
   misspelling problem at its root — matching then rarely needs to be fuzzy at all. This is the
   single biggest lever.
2. **Condition-folder alias map onto the firm's vocabulary.** Map checklist labels onto the
   names staff already use (`closing`, `title`, `insurance`, `credit`, `appraisal`,
   `application`, `disclosures`, `id`) so the mirror reads natively in Explorer. A small
   owner-approved dictionary; label fallback for everything unmapped.
3. **Second-pass typo matcher for borrower names.** Add Jaro-Winkler similarity (threshold
   ≈0.93, built for short person names) as a tie-breaker when exact/first-last matching fails
   AND exactly one candidate clears the bar — catches `Jonh`/`John`-class misspellings.
   Phonetic equality (Double Metaphone) as a *flag for review*, never an auto-link (Jean/Gene
   sound alike but differ). Sources: fuzzy-matching literature recommends Jaro-Winkler for
   person names, phonetic algorithms as complements ([dataladder](https://dataladder.com/fuzzy-matching-101/),
   [spotintelligence](https://spotintelligence.com/2023/07/10/name-matching-algorithm/),
   [match-data.studio](https://match-data.studio/blog/fuzzy-matching-algorithms-explained/)).
4. **Street-name edit distance ≤1 (number must match exactly).** Catches `Hamiltion`/`Hamilton`
   typos while the house-number anchor keeps it safe. Complements #1 for pre-canonicalization
   history. (Approach mirrors libpostal-style expansion + fuzzy compare:
   [libpostal](https://github.com/openvenues/libpostal), [Crunchy Data](https://www.crunchydata.com/blog/quick-and-dirty-address-matching-with-libpostal).)
5. **Manual-review console.** An admin screen over `sharepoint_folder_cache` showing every
   resolution with its flags (`created`, `*-ambiguous`, `no-officer:unfiled`) and a **re-link**
   action that repoints the cache (never moves existing files). Turns the flags we already
   record into a workflow.

### Tier 2 — medium
6. **Sync visibility in the portal.** Each document row already stores its SharePoint webUrl —
   surface a "View in SharePoint" link + a per-file sync-health badge (pending/mirrored/failed)
   on the staff file view, and a backlog counter on the admin dashboard.
7. **Officer-folder pinning.** Store the resolved officer folder id on `staff_users` after
   first resolution — stable against renames, saves a listing per resolution.
8. **Failure digest.** A daily email to admins listing documents whose mirror keeps failing
   (with the recorded error) and any ambiguity flags — closes the loop the review console opens.
9. **Backfill/coverage report.** % of all documents mirrored, oldest unmirrored age — one query,
   surfaced on `/api/health` or the admin dashboard.

### Tier 3 — bigger bets
10. **Rename-healing via Graph delta queries.** Since staff work in Explorer and WILL rename
    folders, periodically walk the drive delta feed and update cached folder ids/paths when our
    cached items were renamed/moved by humans (read-only healing — we never rename back).
11. **Metadata-stamped folders.** Stamp portal ids (application/borrower) into SharePoint list-item
    metadata columns on folders we create or link. Matching then becomes id-based after first
    link — immune to any rename or spelling drift, invisible in Explorer.
12. **LLM-assisted long-tail linker.** For the ~300 "other" folders that defeat rule-based
    matching, a batch (review-gated, never auto) pass that proposes folder↔file links with
    reasons; approved links write into the cache.

---

## 4. Suggested order
#1 and #2 first (cheap, structural, prevent future mess), then #5+#6 (human oversight),
then #3/#4 (fuzzier matching — safer once canonicalization shrinks the problem), then Tier 3.
