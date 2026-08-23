"""LONG-TERM COVERAGE REPORT — spans of src/longterm/** that NO suite executed.

Reads the V8 profiles written by scripts/lt-coverage-sweep.sh and prints the
byte ranges whose innermost containing range has count 0 in EVERY run.

    python3 scripts/lt-coverage-report.py [covdir]

THE INNERMOST RANGE WINS, and that rule is the whole reporter. V8 nests its
ranges: a function nobody called still sits inside the script's own range, which
has count > 0. Subtracting the outer from the inner therefore erases exactly the
thing being looked for — the first version of this reported a clean sweep and
could not see a function planted for it to find. If you change this file, plant
an uncalled function in src/longterm/ and check the report names it BEFORE you
believe a shorter list.

Spans under 150 bytes are dropped: below that it is mostly closing braces and
one-line guards, and a list nobody can read is a list nobody uses.
"""
import json, glob, os, collections, sys
COVDIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/cov'

def uncovered_of(script):
    """Bytes whose INNERMOST containing range has count 0.

    V8 nests its ranges: a function that is never called still sits inside the
    script's own range, which has count > 0. Subtracting the outer from the inner
    therefore erases exactly the thing we are looking for — which is why the first
    version of this reported a clean sweep and could not see a function planted to
    be found. The rule is the innermost range wins."""
    ranges = []
    for fn in script.get('functions', []):
        for r in fn.get('ranges', []):
            ranges.append((r['startOffset'], r['endOffset'], r.get('count', 0)))
    if not ranges: return []
    # Sort so an enclosing range is applied before the ranges nested in it.
    ranges.sort(key=lambda x: (x[0], -(x[1] - x[0])))
    marks = []          # (start, end, count) applied in order; later wins
    for s, e, c in ranges: marks.append((s, e, c))
    # Walk the boundaries and resolve each segment by the LAST (innermost) mark.
    bounds = sorted({b for s, e, _ in marks for b in (s, e)})
    out = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        if a == b: continue
        inner = None
        for s, e, c in marks:
            if s <= a and b <= e:
                if inner is None or (e - s) <= inner[1] - inner[0]: inner = (s, e, c)
        if inner and inner[2] == 0: out.append((a, b))
    # join touching segments
    merged = []
    for s, e in out:
        if merged and s <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], e)
        else: merged.append([s, e])
    return [tuple(x) for x in merged]

per_run = collections.defaultdict(list)
for f in glob.glob(COVDIR + '/*.json'):
    try: d = json.load(open(f))
    except Exception: continue
    for s in d.get('result', []):
        url = s.get('url', '')
        if '/src/longterm/' not in url or not url.endswith('.js'): continue
        per_run[url.replace('file://', '')].append(uncovered_of(s))

def intersect(a, b):
    out = []
    for s, e in a:
        for s2, e2 in b:
            lo, hi = max(s, s2), min(e, e2)
            if lo < hi: out.append((lo, hi))
    return out

rows = []
for p, runs in per_run.items():
    if not os.path.exists(p): continue
    never = runs[0]
    for r in runs[1:]:
        never = intersect(never, r)
        if not never: break
    if not never: continue
    src = open(p, encoding='utf8').read()
    for s, e in never:
        if e - s < 150: continue
        rows.append((e - s, p.split('/src/longterm/')[-1], src[:s].count('\n') + 1,
                     ' '.join(src[s:s + 120].split())))
rows.sort(reverse=True)

# WHAT IS SHOWN, AND WHAT IS NOT. This printed the 25 largest spans and the total,
# with nothing saying the list was cut — so a span you were looking for could be
# absent because it is small rather than because it is covered. That cost a
# control run: a ~300-byte function planted for this reporter to find WAS found
# and simply not printed, which read as the reporter being blind to it.
#
#   python3 scripts/lt-coverage-report.py <covdir> [limit|all] [file-substring]
LIMIT_ARG = sys.argv[2] if len(sys.argv) > 2 else '25'
NEEDLE = sys.argv[3] if len(sys.argv) > 3 else ''
if NEEDLE:
    rows = [r for r in rows if NEEDLE in r[1]]
limit = len(rows) if LIMIT_ARG in ('all', '0') else int(LIMIT_ARG)

print(f'{"bytes":>6}  {"file":32} {"line":>5}  never executed by any long-term suite')
for n, f, l, sn in rows[:limit]:
    print(f'{n:6}  {f:32} {l:5}  {sn[:92]}')
if len(rows) > limit:
    print(f'  … {len(rows) - limit} more not shown (pass "all" as the second argument, '
          f'or a file substring as the third)')
print(f'\ntotal never-executed spans >=150 bytes: {len(rows)}'
      + (f'   [filtered by "{NEEDLE}"]' if NEEDLE else ''))
