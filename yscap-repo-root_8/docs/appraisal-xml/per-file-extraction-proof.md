# Per-File Extraction Proof — all 25 appraisal XMLs

Prototype parser (`prototype/value_engine.py` + `extract2.py`) run against **every** uploaded file — evidence field placement was verified per file, not inferred from one. 15× Form 1004 (SFR), 10× Form 1025 (2–4 unit).

## Value extraction (the critical fields)

| File | Form | ARV | As-Is | ARV source | As-Is source |
|---|---|---|---|---|---|
| CP_08108509 | FNM1025 | 575000 | 430000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_08821926 | FNM1025 | 850000 | 615000 | structured (condition=SubjectToCompletion) | narrative (as-is text) |
| CP_09282104 | FNM1025 | 520000 | 365000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_09405263 | FNM1004 | 640000 | 420000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_09432272 | FNM1004 | 355000 | 235000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_09709435 | FNM1025 | 650000 | 479104 | structured (condition=AsIs BUT hypothetical-completion language → ARV) | ESTIMATE from 3 as-is comps (confirm in PDF) |
| CP_09769678 | FNM1004 | 277000 | 170000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_09770010 | FNM1004 | 245000 | 190000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_10182152 | FNM1004 | 552000 | — | structured (condition=SubjectToRepairs) | NOT IN XML — PDF/OCR |
| CP_10209004 | FNM1025 | 530000 | 475000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_10391589 | FNM1025 | 800000 | 640000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_10394133 | FNM1025 | 190000 | — | structured (condition=SubjectToCompletion) | NOT IN XML — PDF/OCR |
| CP_10421150 | FNM1025 | 140000 | 91879 | structured (condition=SubjectToRepairs) | ESTIMATE from 4 as-is comps (confirm in PDF) |
| CP_10484851 | FNM1004 | 217500 | — | structured (condition=SubjectToRepairs) | NOT IN XML — PDF/OCR |
| CP_10636060 | FNM1025 | 2230000 | 1700000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| CP_10736314 | FNM1004 | 240000 | 156948 | structured (condition=SubjectToCompletion) | ESTIMATE from 3 as-is comps (confirm in PDF) |
| CP_10736526 | FNM1004 | 240000 | 152993 | structured (condition=SubjectToCompletion) | ESTIMATE from 3 as-is comps (confirm in PDF) |
| nan_Coto(NAN1602682113)-V1 | FNM1004 | 435000 | 410000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| nan_Kaufman(NAN1602681854)-V5 | FNM1025 | 530000 | 360000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| nan_LOEFFLER | FNM1004 | 400000 | — | structured (condition=SubjectToCompletion) | NOT IN XML — PDF/OCR |
| nan_LOWY | FNM1004 | 460000 | 342667 | structured (condition=SubjectToRepairs) | ESTIMATE from 3 as-is comps (confirm in PDF) |
| nan_Lev(NAN1602681973)-V2 | FNM1004 | 216000 | 76000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |
| nan_Morgenstern | FNM1004 | 610000 | 500000 | structured (condition=SubjectToCompletion) | narrative (as-is text) |
| nan_ROSS | FNM1004 | 140000 | 100017 | structured (condition=SubjectToRepairs) | ESTIMATE from 4 as-is comps (confirm in PDF) |
| nan_Steiner(NAN1602680642)-V6 | FNM1004 | 625000 | 430000 | structured (condition=SubjectToRepairs) | narrative (as-is text) |

## Coverage: **ARV 25/25** · As-Is **15 exact + 6 comp-estimates + 4 PDF-only**

PDF-only As-Is files: CP_10182152, CP_10394133, CP_10484851, nan_LOEFFLER.
