import gzip, json, os, collections, statistics
D='loans'
def num(v):
    if v in ('', None, False, True): return None
    try: return float(v)
    except Exception: return None
def dig(o, path):
    cur=o
    for p in path.split('.'):
        if isinstance(cur,list): cur = cur[0] if cur else None
        if not isinstance(cur,dict): return None
        cur = cur.get(p)
    return cur
# paths straight from Encompass's own standardFields schema
P = {'228':'proposedFirstMortgageAmount','140':'subordinateFinancingAmount',
     '136':'purchasePriceAmount','142':'cashFromToBorrowerAmount',
     '144':None,  # STRING field, resolved below
     '912':'proposedHousingExpenseTotal'}
sf=json.load(open('standardFields.json'))
sfi={str(f['id']):f for f in (sf if isinstance(sf,list) else sf.get('fields',[]))}
for k in P:
    jp=sfi.get(k,{}).get('jsonPath','')
    P[k]=jp.replace('$.','') if jp else P[k]
print('PATHS FROM ENCOMPASS OWN SCHEMA:')
for k,v in P.items(): print('  ',k.ljust(5),v)

rows=[]
for fn in os.listdir(D):
    try: L=json.load(gzip.open(os.path.join(D,fn)))
    except Exception: continue
    cf={c.get('fieldName'):c.get('value') for c in (L.get('customFields') or [])}
    if 'CX.PITIA' not in cf: continue
    rows.append(dict(
      prog=L.get('loanProgramName') or '',
      pitia=num(cf.get('CX.PITIA')),
      parts={k:num(dig(L,P[k])) for k in ['228','140','136','142','144']},
      total912=num(dig(L,P['912'])),
    ))
print('\nloans carrying CX.PITIA:', len(rows))

print('\n=== TEST 1 — does Sum(228,140,136,142,144) reproduce the stored CX.PITIA? ===')
ok=off=skip=0; ex=[]
for r in rows:
    if r['pitia'] is None: skip+=1; continue
    s=round(sum(v or 0 for v in r['parts'].values()),2)
    if abs(s-r['pitia'])<0.02: ok+=1
    else:
        off+=1
        if len(ex)<6: ex.append((s,r['pitia'],{k:v for k,v in r['parts'].items() if v}))
print('  REPRODUCES: %d    does not: %d    (no stored value: %d)' % (ok,off,skip))
for s,p,parts in ex: print('     sum=%.2f  stored=%.2f  parts=%s' % (s,p,parts))

print('\n=== TEST 2 — which parts actually carry a value? ===')
c=collections.Counter(); nz=collections.Counter()
LBL={'228':'P&I (correct)','140':'Subordinate financing','136':'Purchase price',
     '142':'Cash from borrower','144':'Other income 1 (a STRING field)'}
for r in rows:
    for k,v in r['parts'].items():
        if v is not None: c[k]+=1
        if v: nz[k]+=1
for k in ['228','140','136','142','144']:
    print('  %-5s %-34s present on %4d loans, NON-ZERO on %4d' % (k,LBL[k],c[k],nz[k]))

print('\n=== TEST 3 — is CX.PITIA just P&I with nothing added? ===')
same=diff=0
for r in rows:
    if r['pitia'] is None or r['parts']['228'] is None: continue
    if abs(r['pitia']-r['parts']['228'])<0.02: same+=1
    else: diff+=1
print('  CX.PITIA == P&I alone (no taxes, no insurance, no HOA): %d loans' % same)
print('  CX.PITIA differs from P&I (something was added):        %d loans' % diff)

print('\n=== TEST 4 — the FAIR comparison: CX.PITIA vs field 912, as a percentage ===')
print('    (they need NOT match to the cent -- 912 adds "other" and other financing,')
print('     CX.PITIA is meant to add MI. Close would mean the field is basically right.)')
d=[r for r in rows if 'dscr' in r['prog'].lower() and r['pitia'] is not None and r['total912']]
gaps=[]
for r in d:
    gaps.append((r['pitia']-r['total912'])/r['total912']*100)
gaps.sort()
within=lambda p: sum(1 for g in gaps if abs(g)<=p)
print('  long-term loans with both: %d' % len(gaps))
for p in (1,5,10,25,50):
    print('    within %2d%% of field 912: %4d  (%.1f%%)' % (p,within(p),within(p)/len(gaps)*100))
print('    median gap: %.1f%%   worst: %.1f%% / %.1f%%' % (statistics.median(gaps),gaps[0],gaps[-1]))

print('\n=== TEST 5 — how many stored values are IMPOSSIBLE for a monthly payment? ===')
vals=[r['pitia'] for r in d]
neg=sum(1 for v in vals if v<0)
huge=sum(1 for v in vals if v>50000)
tiny=sum(1 for v in vals if 0<=v<100)
print('  negative (a payment cannot be):        %d' % neg)
print('  over $50,000 a month:                  %d' % huge)
print('  under $100 a month:                    %d' % tiny)
print('  plausible ($100-$50,000):              %d of %d' % (len(vals)-neg-huge-tiny,len(vals)))

print('\n=== TEST 6 — is the SHORTFALL vs 912 the taxes+insurance the label promises? ===')
short=[]
for r in d:
    if r['pitia'] is None or not r['total912']: continue
    if r['pitia']<0 or r['pitia']>50000: continue
    short.append(r['total912']-r['pitia'])
short.sort()
print('  on the plausible ones, 912 minus CX.PITIA:')
print('    median %.2f   25th %.2f   75th %.2f' % (statistics.median(short),short[len(short)//4],short[3*len(short)//4]))
print('    (if CX.PITIA were missing taxes+insurance this gap would be POSITIVE and')
print('     look like a monthly tax+insurance bill)')
