# Officer / Processor Routing — current as of this session

Source: live pull of ClickUp CRM & SALES (90113224042) and Loan Pipeline (90113223301).
Encoded in `src/clickup/routing.js`. All folder IDs are real.

## Loan officers (site-selectable · dual-write PII to CRM + Pipeline)
| Officer | CRM folder | Pipeline folder |
|---|---|---|
| Joshua Freidlander | 90116357856 | 90116357907 |
| Esther Bochner | 90115283061 | 90115283054 (Workflow) |
| Solomon Katz | 90115018413 | 90115017331 |
| Yehuda Bochner | 90115018437 | 90115017377 |
| Yosef Cohen | 90115279344 | 90115279409 |
| Moshe Mermelstein | 90115913766 | 90115913843 |
| Shia Kaff | 90116152663 | 90116152676 |
| Mendel Schwimmer | 90117576712 | 90117307844 |
| Abraham Eisen | 90117589009 | 90117588937 |
| Solomon Weiss | 90117693135 | 90117693051 |
| Josef Schnitzler | 90117693155 | 90117693037 |
| Isaac Zadmehr | 90117693166 | 90117692994 |
| Pinchus Wieder | 90118110162 | 90118028635 |
| Yisroel Weinstock | 90118110163 | 90118081048 |
| Simcha Shedrowitzky | 90118110164 | 90118094956 |
| Chaim Lebowitz | — (none) | 90118110153 |
| Mendel Bochner | — (none) | 90118110154 |

## Processors / ops (Pipeline-only · never a lead target · no CRM)
Malky Katz 90117376201 · Goldy Rosenberg 90117430703 · Ezra 90117447287 ·
Lisa Katz 90117952996 · Shana (UW) 90117990325 · Yonah Rapaport 90118065743

## No-officer intake target
**Lead Capture — 90118110142** (canonical). Anything unassigned/unknown lands here.

## Excluded (retained in ClickUp, not site-selectable)
Samual Stein · Berish Mendlovic  (ignore, per instruction) · Boruch Stauber (no longer working).

## System buckets (ignore — automations)
Full Pipeline 90115750802 · ShortTerm Workload 90117191604 ·
LongTerm Workload 90117140244 · Public Submission Workflow 90117430715

## Open items
1. **Chaim Lebowitz & Mendel Bochner** — Pipeline folders exist but no CRM folder.
   If they are loan officers, create CRM folders so PII can dual-write.
2. `Josef Schnitzler CRM` has a stray leading space in ClickUp (cosmetic).
