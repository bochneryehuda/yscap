import xml.etree.ElementTree as ET, glob, os, re, json, html
STRIP='appraisals/stripped'
def num(v):
    if v is None: return None
    s=str(v).replace(',','').replace('$','').strip()
    try: f=float(s); return int(f) if f==int(f) else f
    except: return None
MONEY=r'\$?\s*(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{2})?'
# capture an As-Is value, NOT an as-repaired one
ASIS_PAT=re.compile(r'(?i)as[\s\-]*is\b(?:\s*(?:value|market\s*value|opinion|amount))?[^$\d]{0,30}'+MONEY)
REPAIRED_PAT=re.compile(r'(?i)as[\s\-]*repaired\b(?:\s*value)?[^$\d]{0,30}'+MONEY)

def collect_text(root):
    """All human-narrative attribute values, EXCLUDING the cost-approach site decoy."""
    out=[]
    for el in root.iter():
        for k,v in el.attrib.items():
            if k=='SiteOtherImprovementsAsIsAmount':   # cost-approach site figure — NOT market as-is
                continue
            if not v or len(v)<8: continue
            if re.search(r'(?i)comment|description|text|addendum|summary|reconcil|analysis', k) or 'as' in v.lower():
                out.append((el.tag,k,html.unescape(v)))
    return out

def mine_asis(root, arv):
    texts=collect_text(root)
    cands=[]
    for tag,k,v in texts:
        for m in ASIS_PAT.finditer(v):
            val=num(m.group(1))
            if val and 5000<=val<=50_000_000:
                cands.append((val, f'{tag}/@{k}', v[max(0,m.start()-30):m.start()+40]))
    # prefer a candidate that is plausibly below ARV (as-is < arv) and not equal to arv
    good=[c for c in cands if not arv or c[0]<arv*1.02]
    pick=good[0] if good else (cands[0] if cands else None)
    return pick, len(cands)

R=[]
for f in sorted(glob.glob(f'{STRIP}/*.xml')):
    root=ET.parse(f).getroot(); rep=root.find('REPORT')
    val=root.find('.//VALUATION'); appraised=num(val.get('PropertyAppraisedValueAmount')) if val is not None else None
    coa=root.find('.//_CONDITION_OF_APPRAISAL'); cond=coa.get('_Type') if coa is not None else None
    is_arv=cond in ('SubjectToRepairs','SubjectToCompletion')
    arv=appraised if is_arv else None
    if cond=='AsIs':
        asis, src, conf = appraised, 'structured: PropertyAppraisedValueAmount (condition=AsIs)', 'high'
    else:
        pick,n=mine_asis(root, arv)
        if pick: asis, src, conf = pick[0], pick[1], ('high' if n==1 else 'medium(multi-match)')
        else: asis, src, conf = None, 'NOT IN XML — PDF/OCR needed', 'none'
    R.append({'file':os.path.basename(f),'form':rep.get('AppraisalFormType'),'cond':cond,'arv':arv,'as_is':asis,'as_is_src':src,'conf':conf})
json.dump(R,open('asis_results.json','w'),indent=1)
print(f"{'file':<16}{'form':<8}{'ARV':<10}{'AS-IS':<10}{'conf':<16}source")
for r in R:
    fn=r['file'].replace('Completed_Product_(Data)_','CP_').replace('.xml','')[:15]
    a='·' if r['as_is'] is None else str(r['as_is']); v='·' if r['arv'] is None else str(r['arv'])
    print(f"{fn:<16}{r['form']:<8}{v:<10}{a:<10}{r['conf']:<16}{r['as_is_src'][:52]}")
got=sum(1 for r in R if r['as_is'] is not None)
print(f"\nAs-Is recovered: {got}/21  |  ARV recovered: {sum(1 for r in R if r['arv'] is not None)}/21 (+1 AsIs-only file)")
