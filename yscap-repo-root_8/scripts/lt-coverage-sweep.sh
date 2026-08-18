#!/bin/bash
# LONG-TERM COVERAGE SWEEP — which long-term code no suite has ever executed.
#
# Runs every scripts/test-lt-* and check-lt-* under V8 coverage, then hands the
# raw profiles to scripts/lt-coverage-report.py. It is a DISCOVERY tool, not a
# gate: it never fails a build, because most of what it lists is legitimately
# untested (vendor paths that need a live Lender Price), and deciding which spans
# are worth covering is a judgement.
#
#   bash scripts/lt-coverage-sweep.sh [outdir]
#   python3 scripts/lt-coverage-report.py [outdir]
#
# It found, among others: two Condition Center doors that answered 500 for every
# loan since the day they shipped, and a canary endpoint that had been completely
# dead twice.
#
# ── TWO THINGS IT REFUSES TO DO QUIETLY ──────────────────────────────────────
#
# 1. RUN WITHOUT A DATABASE. The db-gated suites SKIP cleanly when Postgres is
#    away — correct for them, catastrophic here: their coverage simply vanishes
#    and the report comes back with a much LONGER "never executed" list that
#    looks exactly like a real measurement. Measured against a stopped Postgres
#    it read 229 spans; against a running one, 96. Nothing said which was which,
#    which is the same confidently-wrong shape this whole sweep exists to find.
#
# 2. COUNT A SKIP AS COVERAGE. Any suite that skips is named and the total is
#    marked as an undercount. The detector matches the two exact sentences the
#    skip paths print — an earlier version grepped for "skip" anywhere and
#    flagged three suites whose ASSERTION TEXT contains the word. A check that
#    cries wolf is one somebody deletes.
set -u
OUT=${1:-/tmp/lt-cov}
export DATABASE_URL="${DATABASE_URL:-postgres://yscap@localhost:5432/yscap}"

if ! command -v pg_isready >/dev/null 2>&1 || ! pg_isready -q 2>/dev/null; then
  echo "REFUSING: Postgres is not accepting connections."
  echo "  Every db-gated suite would skip and this report would UNDERCOUNT coverage."
  exit 1
fi
if ! psql "$DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1; then
  echo "REFUSING: cannot reach \$DATABASE_URL. Point it at a migrated database and re-run."
  exit 1
fi

cd "$(dirname "$0")/.." || exit 1
rm -rf "$OUT"; mkdir -p "$OUT"
export NODE_V8_COVERAGE="$OUT"

n=0; skipped=0
for f in $(ls scripts | grep "^test-lt-\|^check-lt-"); do
  out=$(node "scripts/$f" 2>&1)
  if echo "$out" | grep -qE "^[a-z0-9-]+: SKIPPED — no database|^SKIP [a-z0-9-]+ \(no DATABASE_URL\)"; then
    skipped=$((skipped+1)); echo "  skipped: $f"
  fi
  n=$((n+1))
done

echo "suites run: $n   skipped: $skipped   profiles: $(ls "$OUT" | wc -l)"
if [ "$skipped" -gt 0 ]; then
  echo "WARNING: $skipped suite(s) skipped — any report from this run UNDERCOUNTS coverage."
  exit 1
fi
echo "now: python3 scripts/lt-coverage-report.py $OUT"
