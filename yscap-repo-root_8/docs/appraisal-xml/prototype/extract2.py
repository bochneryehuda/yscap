import xml.etree.ElementTree as ET, glob, os, re, json

STRIP='appraisals/stripped'
def num(v):
    if v is None: return None
    s=str(v).replace(',','').replace('$','').strip()
    if s in ('','--','.'): return None
    try:
        f=float(s); return int(f) if f==int(f) else f
    except: return None
def money_in(text):
    if not text: return None
    m=re.search(r'(?i)as[\s\-]*is[^$\d]{0,40}\$?\s*([\d]{2,3},?\d{3})', text)
    return num(m.group(1)) if m else None

def extract(path):
    r=ET.parse(path).getroot(); rep=r.find('REPORT'); d={'file':os.path.basename(path)}
    d['form']=rep.get('AppraisalFormType'); d['software']=rep.get('AppraisalSoftwareProductName') or '(blank=a la mode)'
    # subject
    prop=r.find('.//PROPERTY')
    d['addr']=prop.get('_StreetAddress'); d['city']=prop.get('_City'); d['state']=prop.get('_State'); d['zip']=prop.get('_PostalCode')
    st=r.find('.//STRUCTURE')
    d['gla']=num(st.get('GrossLivingAreaSquareFeetCount')) if st is not None else None
    d['units']=num(st.get('LivingUnitCount')) if st is not None else None
    d['year_built']=st.get('PropertyStructureBuiltYear') if st is not None else None
    # values
    val=r.find('.//VALUATION'); appraised=num(val.get('PropertyAppraisedValueAmount')) if val is not None else None
    d['effective_date']=val.get('AppraisalEffectiveDate') if val is not None else None
    coa=r.find('.//_CONDITION_OF_APPRAISAL'); cond=coa.get('_Type') if coa is not None else None
    d['condition_of_appraisal']=cond
    # ARV / As-Is disambiguation
    is_arv = cond in ('SubjectToRepairs','SubjectToCompletion')
    d['arv'] = appraised if is_arv else None
    if cond=='AsIs':
        d['as_is']=appraised; d['as_is_source']='structured (condition=AsIs)'
    else:
        recon=r.find('.//_RECONCILIATION'); sc=r.find('.//SALES_COMPARISON'); vm=r.find('.//VALUATION_METHODS')
        cand=[('_ConditionsComment', recon.get('_ConditionsComment') if recon is not None else None),
              ('_CurrentSalesAgreementAnalysisComment', sc.get('_CurrentSalesAgreementAnalysisComment') if sc is not None else None),
              ('SCA _Comment', sc.get('_Comment') if sc is not None else None),
              ('_AdditionalDescription', vm.get('_AdditionalDescription') if vm is not None else None)]
        found=None; src=None
        for label,txt in cand:
            v=money_in(txt)
            if v: found,src=v,label; break
        d['as_is']=found; d['as_is_source']=src or ('PDF-only/absent' )
    d['appraised_raw']=appraised
    # comps (exclude subject seq 0)
    comps=[c for c in r.findall('.//COMPARABLE_SALE')]
    real=[c for c in comps if c.get('PropertySequenceIdentifier') not in ('0',None)]
    d['n_comps']=len(real)
    # subject C/Q from seq-0 comp
    subj0=next((c for c in comps if c.get('PropertySequenceIdentifier')=='0'), None)
    if subj0 is not None:
        cd=subj0.find('.//COMPARISON_DETAIL')
        if cd is not None:
            d['subj_quality']=cd.get('GSEQualityOfConstructionRatingType'); d['subj_condition']=cd.get('GSEOverallConditionType')
    d['comp_adj_prices']=[num(c.get('AdjustedSalesPriceAmount')) for c in real]
    # appraiser
    ap=r.find('.//APPRAISER'); d['appraiser_name']=ap.get('_Name') if ap is not None else None
    lic=r.find('.//APPRAISER_LICENSE'); d['license_id']=lic.get('_Identifier') if lic is not None else None
    # images: form-level content types (manifest)
    ftypes={}
    for fm in r.findall('.//FORM'):
        t=fm.get('AppraisalReportContentType')
        if t: ftypes[t]=ftypes.get(t,0)+1
    d['n_image_meta']=len(r.findall('.//IMAGE'))
    d['n_embedded']=len(r.findall('.//EMBEDDED_FILE'))
    return d

R=[extract(f) for f in sorted(glob.glob(f'{STRIP}/*.xml'))]
json.dump(R, open('extract2_results.json','w'), indent=1)
def g(r,k):
    v=r.get(k); return '·' if v in (None,'') else str(v)
print("=== HARDENED VALUE EXTRACTION (all 21, seq-0 excluded, As-Is disambiguated) ===")
print(f"{'file':<16}{'form':<8}{'AS-IS':<9}{'ARV':<9}{'condOfApp':<19}{'asis_source':<38}{'#cmp':<5}{'subjC/Q'}")
for r in R:
    fn=r['file'].replace('Completed_Product_(Data)_','CP_').replace('.xml','')[:15]
    cq=f"{g(r,'subj_condition')}/{g(r,'subj_quality')}"
    print(f"{fn:<16}{g(r,'form'):<8}{g(r,'as_is'):<9}{g(r,'arv'):<9}{g(r,'condition_of_appraisal'):<19}{g(r,'as_is_source')[:37]:<38}{g(r,'n_comps'):<5}{cq}")
