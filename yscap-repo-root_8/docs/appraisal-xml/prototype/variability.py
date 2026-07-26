import xml.etree.ElementTree as ET, glob, os, re, json, html
from collections import Counter
STRIP='appraisals/stripped'
def g(el,a): return el.get(a) if el is not None else None
def F(r,p): return r.find(p)

def analyze(path):
    r=ET.parse(path).getroot(); d={'file':os.path.basename(path),'form':F(r,'REPORT').get('AppraisalFormType')}
    # APN: which source?
    src=None
    if g(F(r,'.//_IDENTIFICATION'),'AssessorsParcelIdentifier'): src='_IDENTIFICATION@AssessorsParcelIdentifier'
    elif g(F(r,'.//PARCEL_IDENTIFIER'),'GSEAssessorsParcelIdentifier'): src='PARCEL_IDENTIFIER@GSE...'
    d['apn_src']=src or 'MISSING'
    # GLA: subject-level vs missing (per-unit)
    gla=g(F(r,'.//STRUCTURE'),'GrossLivingAreaSquareFeetCount')
    d['gla_src']='STRUCTURE@GLA' if gla else 'missing (per-unit / PDF)'
    # Baths
    baths=g(F(r,'.//STRUCTURE'),'TotalBathroomCount')
    d['baths_fmt']=('full.half' if baths and '.' in str(baths) else ('int' if baths else 'missing'))
    # Subject C/Q source+format
    comps=r.findall('.//COMPARABLE_SALE'); s0=next((c for c in comps if c.get('PropertySequenceIdentifier')=='0'),None)
    cq_src='none'; cq_fmt='none'
    if s0 is not None:
        cd=s0.find('.//COMPARISON_DETAIL')
        if cd is not None and g(cd,'GSEOverallConditionType'):
            cq_src='seq0 COMPARISON_DETAIL@GSE'; v=g(cd,'GSEOverallConditionType'); cq_fmt='UAD C#' if re.fullmatch(r'C[1-6]',v or '') else 'word-text'
        else:
            for spa in s0.findall('.//SALE_PRICE_ADJUSTMENT'):
                if spa.get('_Type')=='Condition' and spa.get('_Description'):
                    cq_src='seq0 SALE_PRICE_ADJUSTMENT'; v=spa.get('_Description'); cq_fmt='UAD C#' if re.fullmatch(r'C[1-6]',v or '') else 'word-text'
    d['cq_src']=cq_src; d['cq_fmt']=cq_fmt
    # Report signed date format
    rs=F(r,'REPORT').get('AppraiserReportSignedDate') or ''
    d['signed_fmt']=('MM/DD/YYYY' if re.match(r'\d{2}/\d{2}/\d{4}',rs) else ('ISO' if re.match(r'\d{4}-\d{2}-\d{2}',rs) else ('empty' if not rs else 'other')))
    # Number format: does appraised value carry commas?
    av=g(F(r,'.//VALUATION'),'PropertyAppraisedValueAmount') or ''
    d['num_fmt']=('has-commas' if ',' in av else 'plain')
    # Lot size source
    site=F(r,'.//SITE')
    if g(site,'_AreaDescription'): d['lot_src']='SITE@_AreaDescription'
    elif g(site,'_DimensionsDescription'): d['lot_src']='SITE@_DimensionsDescription only'
    else: d['lot_src']='missing'
    # units source (1004 often blank -> implied 1)
    u=g(F(r,'.//STRUCTURE'),'LivingUnitCount'); d['units_src']='STRUCTURE@LivingUnitCount' if u else 'blank (imply 1 for 1004)'
    # AMC present?
    d['amc_src']='present' if g(F(r,'.//MANAGEMENT_COMPANY'),'GSEManagementCompanyName') else 'missing'
    return d

R=[analyze(f) for f in sorted(glob.glob(f'{STRIP}/*.xml'))]
json.dump(R,open('variability_results.json','w'),indent=1)
N=len(R)
def dist(key):
    c=Counter(r[key] for r in R); return dict(c)
print(f"VARIABILITY ACROSS {N} FILES — how many DIFFERENT ways each field appears\n")
for key,label in [('apn_src','APN location'),('gla_src','GLA'),('baths_fmt','Bathroom format'),('cq_src','Subject C/Q source'),('cq_fmt','Subject C/Q format'),('signed_fmt','Signed-date format'),('num_fmt','Number format'),('lot_src','Lot size source'),('units_src','Units source'),('amc_src','AMC')]:
    dd=dist(key); ways=len(dd)
    tag='ONE WAY ✓' if ways==1 else ('NEEDS FALLBACK ⚠' if any('missing' not in k and 'blank' not in k for k in dd) and ways>1 else 'sometimes-missing')
    print(f"{label:<22} {ways} way(s)  {dict(sorted(dd.items(),key=lambda x:-x[1]))}")
