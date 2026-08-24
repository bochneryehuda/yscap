# Long-Term → ClickUp: the Lender dropdown map (#41)

**What this is.** The ClickUp "*Lender" dropdown has 45 options. Encompass holds the same fact as
free-typed text in **VEND.X263** (the owner's CX.WHICHINVESTOR is blank on all 710 loans — measured
2026-08-24 — so VEND.X263 is the source). People type it 40 different ways, so the writer carries a
spelling map (`LENDER_RULES` in `src/longterm/clickup/mapper.js`) and **an unmatched spelling is
SKIPPED, never guessed** — a wrong lender on a card is worse than a blank one.

**Coverage, measured (2026-08-24), not estimated:** every one of the 40 distinct spellings on the
live book was run through the map — **401 of 402 lender-carrying loans map (100% of the real ones)**;
the single miss is the junk value `---`, which is skipped by design. The measurement lives in the
writer test (`scripts/test-lt-clickup-writer.js` section C pins the tricky ones: `Deepahven`,
`Champions Funding, LLC (CF)`, `rcn Capital (RCN)`, junk, and an unmeasured name refusing to map).

## The map (Encompass spelling family → ClickUp option)

| Encompass spellings seen (count on the book) | ClickUp option |
|---|---|
| Deephaven Mortgage 76 · Deephaven 24 (+ the misspellings Deepahven / Deephven / Deep Haven) | Deephaven |
| Champions Funding, LLC (CF) 75 | Champions |
| Oaktree Funding 48 · Oaktree 5 | Oak Tree |
| A&D Mortgage, LLC 18 · A&D Mortgage LLC 2 · A&D 2 | A&D Mortgage |
| RCN 16 · RCN Capital (RCN) 8 · rcn Capital (RCN) 5 | RCN Capital |
| American Heritage 15 (AHL) | American Heritage lending |
| ROC Capital (Roc) 11 · Roc 2 | Roc Capital |
| Acra Lending 10 · Acra 6 | Acra Lending |
| Onslow Bay 7 · Onslow 4 | Onslow Bay |
| Constructive Capital 6 · BPL 2 | BPL |
| EMCAP 6 | EMCAP Financial |
| Fidelis 5 · Fidelis Investors 3 (Fidelis Warehouse → Fidelis Warehouse) | Fidelis Investors LLC |
| NQM Funding 5 · NQM 3 · NonQM Funding (N…) 2 | NQM Funding |
| Corrfirst 4 · CorrFirst 3 | CorrFirst |
| Dominion 4 · Dominion Financial 2 | dominion financial |
| The Loan Store, 4 | The Loan Store |
| Cake Mortgage Co 3 | Cake Mortgage |
| eResi 3 | eResi |
| Foundation Mortgage 3 | Foundation |
| Bluelake 3 | Blue Lake Capital |
| PennyMac TPO (PM…) 2 | PennyMac |
| Amwest Funding C… 2 | AmWest |
| The Lender 2 | The Lender |
| 1-offs with a matching option: Logan → Logan Finance · AmeriHome → AmeriHome · Broadview → Broadview funding · Church Hill/Churchill → Church Hill · Temple View → Temple View funding · PHH → PHH · ARC → ARC · NewRez → NewRez | (as listed) |

Short tokens (RCN, BPL, ARC, PHH, ROC, NQM, A&D, AHL) match as **whole words only**, so a name that
merely contains the letters can never mis-map.

## Skipped on purpose (nothing to sign off — recorded so nobody "fixes" it)

- **Junk values**: `--`, `---`, tab-prefixed pasted numbers, a doubled paste — the map refuses
  anything with no letters. Nothing is written.
- **Encompass names with NO ClickUp option**: the research pass saw one-off spellings like `AMB`
  and `Cornerstone` on historical files; the ClickUp dropdown has no option for them, and the map
  never invents one — those cards keep whatever their Lender field already holds.

## For the owner (the open questions — nothing blocks on them)

1. **"Acra Lending" vs "Acra"** — ClickUp has BOTH options. Every Encompass spelling maps to
   **Acra Lending** (the fuller one). Say the word if some files should read the bare "Acra".
2. **"Fidelis Investors LLC" vs "Fidelis Warehouse"** — bare "Fidelis" maps to **Fidelis
   Investors LLC**; only an Encompass value actually saying "warehouse" maps to Fidelis Warehouse.
3. A brand-new lender typed into Encompass tomorrow will simply not map until a rule is added —
   the card's Lender stays as it is and the write journal records nothing was written. Adding a
   spelling is one line in `LENDER_RULES`.
