import xml.etree.ElementTree as ET, glob, os, re, json, html
STRIP='appraisals/stripped'
def num(v):
    try: f=float(str(v).replace(',','').replace('$','')); return int(f) if f==int(f) else f
    except: return None
MONEY=r'\$?\s*(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{2})?'
ASIS  =re.compile(r'(?i)as[\s\-]*is\b(?:\s*(?:value|market\s*value|opinion|amount))?[^$\d]{0,30}'+MONEY)
ARVP  =re.compile(r'(?i)(?:as[\s\-]*repaired|after[\s\-]*repair|as[\s\-]*complete[d]?|subject[\s\-]*to[\s\-]*completion)\b(?:\s*value)?[^$\d]{0,30}'+MONEY)
HYPO  =re.compile(r'(?i)hypothetical condition.{0,80}(?:repair|budget|complet|renovat)|(?:repair|budget|renovat).{0,40}(?:have been |been )?complet')

def narrative(root):
    out=[]
    for el in root.iter():
        for k,v in el.attrib.items():
            if k=='SiteOtherImprovementsAsIsAmount': continue
            if v and len(v)>=8 and (re.search(r'(?i)comment|description|text|addendum|summary|reconcil|analysis',k) or 'as ' in v.lower() or 'repair' in v.lower()):
                out.append(html.unescape(v))
    return out

def mine(pat, texts, arv=None, prefer_below=True):
    hits=[]
    for t in texts:
        for m in pat.finditer(t):
            val=num(m.group(1))
            if val and 5000<=val<=50_000_000: hits.append(val)
    if not hits: return None, 0
    if arv and prefer_below:
        below=[h for h in hits if h<arv*1.02]
        if below: return below[0], len(hits)
    return hits[0], len(hits)

def comp_clusters(root):
    adj=sorted([num(c.get('AdjustedSalesPriceAmount')) for c in root.findall('.//COMPARABLE_SALE') if c.get('PropertySequenceIdentifier') not in ('0',None) and num(c.get('AdjustedSalesPriceAmount'))])
    return adj

R=[]
for f in sorted(glob.glob(f'{STRIP}/*.xml')):
    root=ET.parse(f).getroot(); rep=root.find('REPORT')
    structured=num(root.find('.//VALUATION').get('PropertyAppraisedValueAmount'))
    _c=root.find('.//_CONDITION_OF_APPRAISAL'); cond=_c.get('_Type') if _c is not None else None
    texts=narrative(root)
    has_hypo=any(HYPO.search(t) for t in texts)
    # DECIDE basis of the structured figure
    if cond in ('SubjectToRepairs','SubjectToCompletion'):
        basis='ARV'; basis_src=f'condition={cond}'
    elif cond=='AsIs' and has_hypo:
        basis='ARV'; basis_src='condition=AsIs BUT hypothetical-completion language → ARV'
    elif cond=='AsIs':
        basis='ASIS'; basis_src='condition=AsIs'
    else:
        basis='ARV' if has_hypo else 'ASIS'; basis_src='inferred'
    if basis=='ARV':
        arv, arv_src = structured, f'structured ({basis_src})'
        asis, n = mine(ASIS, texts, arv)
        if asis: asis_src=f'narrative (as-is text)'
        else:
            cl=comp_clusters(root); lo=[a for a in cl if a<arv*0.9]
            if lo: asis=round(sum(lo)/len(lo)); asis_src=f'ESTIMATE from {len(lo)} as-is comps (confirm in PDF)'
            else: asis_src='NOT IN XML — PDF/OCR'
    else:
        asis, asis_src = structured, f'structured ({basis_src})'
        arv, n = mine(ARVP, texts, None, prefer_below=False)
        if arv: arv_src='narrative (as-repaired text)'
        else:
            cl=comp_clusters(root); hi=[a for a in cl if a>asis*1.05]
            if hi: arv=round(sum(hi)/len(hi)); arv_src=f'ESTIMATE from {len(hi)} arv comps (confirm in PDF)'
            else: arv=structured; arv_src='as-is only report (no ARV in XML)'
    R.append({'file':os.path.basename(f),'form':rep.get('AppraisalFormType'),'cond':cond,'hypo':has_hypo,
              'arv':arv,'arv_src':arv_src,'as_is':asis,'as_is_src':asis_src})
json.dump(R,open('value_results.json','w'),indent=1)
print(f"{'file':<16}{'form':<8}{'ARV':<10}{'AS-IS':<10}{'arv_src':<26}{'asis_src'}")
for r in R:
    fn=r['file'].replace('Completed_Product_(Data)_','CP_').replace('.xml','')[:15]
    print(f"{fn:<16}{r['form']:<8}{str(r['arv'] or '·'):<10}{str(r['as_is'] or '·'):<10}{r['arv_src'][:25]:<26}{r['as_is_src'][:40]}")
print(f"\nARV: {sum(1 for r in R if r['arv'])}/21   As-Is (incl. est): {sum(1 for r in R if r['as_is'])}/21")
print(f"As-Is exact (non-estimate): {sum(1 for r in R if r['as_is'] and 'ESTIMATE' not in r['as_is_src'])}/21")
