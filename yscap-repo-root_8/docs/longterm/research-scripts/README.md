# The scripts behind the findings

These are the exact analyses that produced the numbers quoted in the research
documents, kept so any claim can be re-run and checked rather than taken on trust.

| Script | Settles |
|---|---|
| `verify-cx-pitia.py` | Whether `CX.PITIA` computes what its formula says, and whether the result is a monthly payment. Six tests. |
| `verify-cx-pitia-fix.py` | Whether the label's own five fields (`Sum(228,1405,230,232,233)`) reproduce the real housing expense. |

## Running them

They read two inputs that are **deliberately not committed**, because they are raw
copies of live loan files containing borrower PII:

- `loans/` — one gzipped JSON per loan from `GET /encompass/v3/loans/{id}`
- `standardFields.json` — the tenant's own field schema from
  `GET /encompass/v3/schemas/loan/standardFields`

Re-harvest both into a scratch directory, put these scripts beside them, and run with
`python3`. Nothing here writes anywhere, and nothing here talks to Encompass — they
only read files you already pulled.

**The committed research is the PII-free product of these runs**: the JSON under
`src/longterm/encompass/dictionary/`, the modules that read it, and the CSVs in
`../research-exports/`.
