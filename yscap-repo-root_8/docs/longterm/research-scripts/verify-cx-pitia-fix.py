import gzip, json, os, statistics
D='loans'
def num(v):
    if v in ('',None,False,True): return None
    try: return float(v)
    except Exception: return None
sf=json.load(open('standardFields.json'))
idx={str(f['id']):f for f in (sf if isinstance(sf,list) else sf.get('fields',[]))}
P=lambda fid: idx[fid]['jsonPath'].replace('$.','')
def dig(o,p):
    cur=o
    for k in p.split('.'):
        if isinstance(cur,list): cur=cur[0] if cur else None
        if not isinstance(cur,dict): return None
        cur=cur.get(k)
    return cur

# what the LABEL promises -> the Expenses Proposed block
PROPOSED = {'228':'P&I','1405':'Taxes','230':'Insurance','232':'MI','233':'HOA'}

cur_ok=fix_ok=n=0; curgap=[]; fixgap=[]
for fn in os.listdir(D):
    try: L=json.load(gzip.open(os.path.join(D,fn)))
    except Exception: continue
    if 'dscr' not in (L.get('loanProgramName') or '').lower(): continue
    cf={c.get('fieldName'):c.get('value') for c in (L.get('customFields') or [])}
    stored=num(cf.get('CX.PITIA')); t912=num(dig(L,'proposedHousingExpenseTotal'))
    if stored is None or not t912: continue
    proposed=round(sum(num(dig(L,P(f))) or 0 for f in PROPOSED),2)
    n+=1
    if abs(stored-t912)<=t912*0.02: cur_ok+=1
    if abs(proposed-t912)<=t912*0.02: fix_ok+=1
    curgap.append(abs(stored-t912)); fixgap.append(abs(proposed-t912))

print('Long-term loans compared: %d\n' % n)
print('%-58s %8s %10s' % ('','within 2%','median gap'))
print('-'*80)
print('%-58s %7d%%  %9.2f' % ('CX.PITIA as it is now   Sum(228,140,136,142,144)',
      round(cur_ok/n*100), statistics.median(curgap)))
print('%-58s %7d%%  %9.2f' % ('The label\'s own fields  Sum(228,1405,230,232,233)',
      round(fix_ok/n*100), statistics.median(fixgap)))
print()
print('Both compared against field 912, the real total monthly housing expense.')
