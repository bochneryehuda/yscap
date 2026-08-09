#!/bin/bash
# ============================================================================
# Repo upgrade-history audit — the ordered engine.
#
# Answers, from git alone, for every upgrade ever made to this repo:
#   Phase 1  INVENTORY  — every commit and every PR that landed on main
#   Phase 2  SURVIVAL   — for each commit, how many of the lines it wrote are
#                         still in main today (git blame tally vs numstat)
#   Phase 3  CLOBBER    — commits that erased another commit's work, and
#                         whether the erasing commit ever referenced it
#                         (the signature of a branch merged without pulling)
#   Phase 4  MERGES     — merge commits that discarded one side entirely
#
# Requires a COMPLETE clone. A shallow clone silently produces wrong answers:
#   git fetch --unshallow --tags origin
#
# Usage:  scripts/repo-history-audit/run-audit.sh [output-dir]
# ============================================================================
set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
OUT=${1:-/tmp/repo-history-audit}
REF=${REF:-origin/main}
mkdir -p "$OUT"

# Built bundles are regenerated wholesale on every build, so their line
# turnover is meaningless noise. Same for lockfiles and binaries.
SKIP_RE='assets/index-[A-Za-z0-9_-]+\.(js|css)$|\.lock$|lock\.json$|\.min\.(js|css)$|\.(png|jpe?g|gif|ico|pdf|zip|xlsx|woff2?|ttf|map)$'

if [ -f "$(git rev-parse --git-dir)/shallow" ]; then
  echo "REFUSING TO RUN: this clone is shallow — every survival number would be wrong."
  echo "Run: git fetch --unshallow --tags origin"
  exit 1
fi

# ---------------------------------------------------------------- Phase 1 ---
echo "== Phase 1: inventory =="
git log --format='%H%x09%ad%x09%an%x09%s' --date=short "$REF" > "$OUT/commits.tsv"
awk -F'\t' '{print $4}' "$OUT/commits.tsv" | grep -oE '\(#[0-9]+\)$' | tr -d '(#)' \
  | sort -n -u > "$OUT/prs_on_main.txt"
echo "   commits: $(wc -l < "$OUT/commits.tsv")   PRs landed: $(wc -l < "$OUT/prs_on_main.txt")"

# ---------------------------------------------------------------- Phase 2 ---
echo "== Phase 2: line survival =="
git ls-files -z | while IFS= read -r -d '' f; do
  printf '%s' "$f" | grep -qE "$SKIP_RE" && continue
  [ "$(stat -c%s "$f" 2>/dev/null || echo 0)" -gt 2000000 ] && continue
  printf '%s\0' "$f"
done > "$OUT/files.z"

rm -rf "$OUT/blames"; mkdir -p "$OUT/blames"
# Each worker writes its OWN file — a shared redirect interleaves at awk's
# 4KB buffer boundary and silently corrupts lines.
xargs -0 -a "$OUT/files.z" -P 8 -I{} sh -c '
  o="'"$OUT"'/blames/$(printf "%s" "{}" | md5sum | cut -c1-32).txt"
  git blame --incremental -w HEAD -- "{}" 2>/dev/null \
    | awk "/^[0-9a-f]{40} [0-9]+ [0-9]+ [0-9]+\$/ {print \$4, \$1}" > "$o"
'
cat "$OUT"/blames/*.txt > "$OUT/blame_raw.txt"
awk 'NF==2 && $2 ~ /^[0-9a-f]{40}$/ {s[$2]+=$1} END {for (c in s) print s[c], c}' \
  "$OUT/blame_raw.txt" | sort -rn > "$OUT/surviving.txt"

git log --format='C %H' --numstat --no-renames "$REF" \
  | awk -v skip="$SKIP_RE" '
      /^C / {c=$2; next}
      NF==3 && $1 ~ /^[0-9]+$/ { if ($3 ~ skip) next; add[c]+=$1 }
      END {for (k in add) print add[k], k}' | sort -rn > "$OUT/added.txt"

awk 'NR==FNR {s[$2]=$1; next}
     {c=$2; a=$1; v=(c in s)?s[c]:0; printf "%s\t%d\t%d\t%.1f\n", c, a, v, (a?v*100/a:0)}' \
  "$OUT/surviving.txt" "$OUT/added.txt" > "$OUT/survival.tsv"
awk -F'\t' '{A+=$2;S+=$3} END {printf "   added=%d surviving=%d overall=%.1f%%\n",A,S,S*100/A}' \
  "$OUT/survival.tsv"
echo "   commits with ZERO surviving lines (>=50 added):"
awk -F'\t' '$3==0 && $2>=50 {print $1}' "$OUT/survival.tsv" | while read -r c; do
  printf '     %s  %s\n' "$(git log -1 --format='%ad' --date=short "$c")" \
                         "$(git log -1 --format='%s' "$c" | cut -c1-88)"
done

# ---------------------------------------------------------------- Phase 3 ---
# For each commit C, blame the lines C DELETED against C's parent to learn
# which commit B wrote them. If C erases a lot of B and NEVER references B,
# that is the stale-base clobber signature worth a human look.
echo "== Phase 3: clobber detection =="
: > "$OUT/clobber.tsv"
git rev-list --no-merges "$REF" | while read -r C; do
  P=$(git rev-parse "$C^" 2>/dev/null) || continue
  git diff --numstat "$P" "$C" 2>/dev/null \
    | awk '$1 ~ /^[0-9]+$/ && $2 >= 20 {print $3}' | grep -vE "$SKIP_RE" \
    | while read -r F; do
        git diff -U0 "$P" "$C" -- "$F" 2>/dev/null \
        | awk '/^@@/ {split($2,o,","); s=-o[1]; l=(o[2]==""?1:o[2]); if (l>0) print s","(s+l-1)}' \
        | while IFS= read -r R; do
            git blame -w -L "$R" --line-porcelain "$P" -- "$F" 2>/dev/null \
              | awk '/^[0-9a-f]{40} /{print $1}'
          done
      done \
    | sort | uniq -c | sort -rn | head -5 \
    | while read -r N B; do
        [ -z "${B:-}" ] && continue; [ "$N" -lt 25 ] && continue; [ "$B" = "$C" ] && continue
        printf '%s\t%s\t%s\n' "$C" "$B" "$N" >> "$OUT/clobber.tsv"
      done
done

echo "   UNREFERENCED erasures (C erased B without ever naming B):"
while IFS=$'\t' read -r C B N; do
  [ -z "${C:-}" ] && continue
  msg=$(git log -1 --format='%B' "$C" 2>/dev/null) || continue
  bs=$(git log -1 --format=%s "$B" 2>/dev/null) || continue
  bpr=$(printf '%s' "$bs" | grep -oE '\(#[0-9]+\)$' | tr -d '(#)')
  [ -n "$bpr" ] && printf '%s' "$msg" | grep -q "#${bpr}\b" && continue
  printf '%s' "$msg" | grep -q "${B:0:8}" && continue
  ct=$(git log -1 --format=%ct "$C"); bt=$(git log -1 --format=%ct "$B")
  printf '     %sh  %s lines  C:%.58s  B:%.58s\n' "$(( (ct-bt)/3600 ))" "$N" \
    "$(git log -1 --format=%s "$C")" "$bs"
done < "$OUT/clobber.tsv" | sort -k2 -rn | head -30

# ---------------------------------------------------------------- Phase 4 ---
# A merge whose tree equals its first parent's took NOTHING from side two.
# Benign when side two was already contained in side one; otherwise real loss.
echo "== Phase 4: merges that discarded a side =="
git log --merges --format='%H' "$REF" | while read -r M; do
  P1=$(git rev-parse "$M^1" 2>/dev/null); P2=$(git rev-parse "$M^2" 2>/dev/null) || continue
  [ -z "${P2:-}" ] && continue
  [ "$(git rev-parse "$M^{tree}")" = "$(git rev-parse "$P1^{tree}")" ] || continue
  git merge-base --is-ancestor "$P2" "$P1" && continue
  n=$(git diff --numstat "$P2" "$P1" | wc -l)
  if [ "$n" -eq 0 ]; then verdict="benign (side-2 already in side-1)"; else verdict="REVIEW: $n files differ"; fi
  printf '     %s  %s  -- %s\n' "$(git log -1 --format='%h %ad' --date=short "$M")" \
    "$(git log -1 --format=%s "$M" | cut -c1-62)" "$verdict"
done

echo
echo "Artifacts in $OUT: commits.tsv prs_on_main.txt survival.tsv clobber.tsv"
