import xml.etree.ElementTree as ET, glob, os, re, json, html
STRIP='appraisals/stripped'
def num(v):
    try: f=float(str(v).replace(',','').replace('$','')); return int(f) if f==int(f) else f
    except: return None
def gv(el,attr): return el.get(attr) if el is not None else None
def find(root,path): return root.find(path)

def extract(path):
    r=ET.parse(path).getroot(); rep=r.find('REPORT'); d={'file':os.path.basename(path)}
    d['form']=rep.get('AppraisalFormType')
    # ---- Identity / matching fields ----
    prop=find(r,'.//PROPERTY')
    d['address']=gv(prop,'_StreetAddress'); d['city']=gv(prop,'_City'); d['county']=gv(prop,'_County')
    d['state']=gv(prop,'_State'); d['zip']=gv(prop,'_PostalCode')
    d['occupancy']=gv(prop,'_CurrentOccupancyType'); d['rights']=gv(prop,'_RightsType')
    ident=find(r,'.//_IDENTIFICATION')
    d['apn']=gv(ident,'AssessorsParcelIdentifier'); d['census_tract']=gv(ident,'CensusTractIdentifier')
    pid=find(r,'.//PARCEL_IDENTIFIER'); d['apn2']=gv(pid,'GSEAssessorsParcelIdentifier')
    legal=find(r,'.//_LEGAL_DESCRIPTION'); d['legal']=gv(legal,'_TextDescription')
    nb=find(r,'.//NEIGHBORHOOD'); d['neighborhood']=gv(nb,'_Name')
    # ---- Parties (borrower / LLC / lender / AMC) ----
    bn=find(r,'.//BORROWER_NAME'); borrower=gv(bn,'GSEBorrowerName')
    if not borrower:
        b=find(r,'.//BORROWER'); borrower=gv(b,'_UnparsedName')
    d['borrower_raw']=borrower
    d['is_llc']=bool(borrower and re.search(r'(?i)\b(LLC|L\.L\.C|INC|CORP|LP|LLP|TRUST|COMPANY|HOLDINGS|PROPERTIES|CAPITAL|GROUP|VENTURES|ENTERPRISE)\b', borrower))
    d['has_party_name']=bool(borrower and borrower.strip())
    owner=find(r,'.//_OWNER'); d['owner_of_record']=gv(owner,'_Name')
    lender=find(r,'.//LENDER'); d['lender']=gv(lender,'_UnparsedName')
    amc=find(r,'.//MANAGEMENT_COMPANY'); d['amc']=gv(amc,'GSEManagementCompanyName')
    # ---- Physical ----
    st=find(r,'.//STRUCTURE')
    d['prop_type']=gv(st,'AttachmentType'); d['units']=num(gv(st,'LivingUnitCount'))
    d['year_built']=gv(st,'PropertyStructureBuiltYear'); d['gla']=num(gv(st,'GrossLivingAreaSquareFeetCount'))
    d['rooms']=num(gv(st,'TotalRoomCount')); d['beds']=num(gv(st,'TotalBedroomCount')); d['baths']=gv(st,'TotalBathroomCount')
    d['stories']=gv(st,'StoriesCount'); d['design']=gv(st,'_DesignDescription')
    ea=find(r,'.//STRUCTURE_ANALYSIS'); d['eff_age']=gv(ea,'EffectiveAgeYearsCount')
    site=find(r,'.//SITE')
    d['lot_area']=gv(site,'_AreaDescription'); d['lot_dims']=gv(site,'_DimensionsDescription')
    d['zoning_id']=gv(site,'_ZoningClassificationIdentifier'); d['zoning_desc']=gv(site,'_ZoningClassificationDescription')
    d['zoning_compliance']=gv(site,'_ZoningComplianceType')
    fz=find(r,'.//FLOOD_ZONE'); d['flood_zone']=gv(fz,'NFIPFloodZoneIdentifier')
    bsmt=find(r,'.//BASEMENT'); d['basement_sqft']=num(gv(bsmt,'SquareFeetCount'))
    heat=find(r,'.//HEATING'); d['heating']=gv(heat,'_Type')
    # subject C/Q from seq-0 comp
    comps=r.findall('.//COMPARABLE_SALE'); subj0=next((c for c in comps if c.get('PropertySequenceIdentifier')=='0'),None)
    if subj0 is not None:
        cd=subj0.find('.//COMPARISON_DETAIL')
        d['subj_condition']=gv(cd,'GSEOverallConditionType'); d['subj_quality']=gv(cd,'GSEQualityOfConstructionRatingType')
        if not d.get('subj_condition'):
            for spa in subj0.findall('.//SALE_PRICE_ADJUSTMENT'):
                if spa.get('_Type')=='Condition': d['subj_condition']=spa.get('_Description')
                if spa.get('_Type')=='Quality': d['subj_quality']=spa.get('_Description')
    d['n_comps']=len([c for c in comps if c.get('PropertySequenceIdentifier') not in ('0',None)])
    # validate UAD codes: only C1-C6 / Q1-Q6 count as reliable ratings; else flag non-UAD
    rawc=d.get('subj_condition'); rawq=d.get('subj_quality')
    d['subj_condition_uad']=rawc if (rawc and re.fullmatch(r'C[1-6]',rawc)) else None
    d['subj_quality_uad']=rawq if (rawq and re.fullmatch(r'Q[1-6]',rawq)) else None
    d['cq_nonuad']=bool((rawc and not d['subj_condition_uad']) or (rawq and not d['subj_quality_uad']))

    # ---- Values ----
    val=find(r,'.//VALUATION'); d['appraised_value']=num(gv(val,'PropertyAppraisedValueAmount')); d['effective_date']=gv(val,'AppraisalEffectiveDate')
    coa=find(r,'.//_CONDITION_OF_APPRAISAL'); d['condition_of_appraisal']=gv(coa,'_Type')
    sca=find(r,'.//SALES_COMPARISON'); d['value_sales']=num(gv(sca,'ValueIndicatedBySalesComparisonApproachAmount'))
    cost=find(r,'.//COST_ANALYSIS'); d['value_cost']=num(gv(cost,'ValueIndicatedByCostApproachAmount')); d['site_value']=num(gv(cost,'SiteEstimatedValueAmount'))
    inc=find(r,'.//INCOME_ANALYSIS'); d['value_income']=num(gv(inc,'ValueIndicatedByIncomeApproachAmount')); d['grm']=num(gv(inc,'GrossRentMultiplierFactor'))
    scon=find(r,'.//SALES_CONTRACT'); d['contract_price']=num(gv(scon,'_Amount')); d['contract_date']=gv(scon,'_Date')
    insp=find(r,'.//INSPECTION'); d['inspection_date']=gv(insp,'InspectionDate')
    d['report_signed']=rep.get('AppraiserReportSignedDate')
    # ---- Multifamily ----
    mrs=find(r,'.//MULTIFAMILY_RENT_SCHEDULE')
    d['mf_actual_gross_rent']=num(gv(mrs,'RentalActualGrossMonthlyRentAmount'))
    d['mf_market_gross_rent']=num(gv(mrs,'RentalEstimatedGrossMonthlyRentAmount'))
    d['n_unit_rents']=len(r.findall('.//UNIT_RENT_SCHEDULE'))
    # ---- Appraiser ----
    ap=find(r,'.//APPRAISER'); d['appraiser_name']=gv(ap,'_Name'); d['appraiser_company']=gv(ap,'_CompanyName')
    lic=find(r,'.//APPRAISER_LICENSE'); d['license_id']=gv(lic,'_Identifier'); d['license_state']=gv(lic,'_State'); d['license_exp']=gv(lic,'_ExpirationDate')
    phone=None; email=None
    for cp in r.findall('.//CONTACT_POINT'):
        if cp.get('_Type')=='Phone' and cp.get('_Value'): phone=cp.get('_Value')
        if cp.get('_Type')=='Email' and cp.get('_Value'): email=cp.get('_Value')
    d['appraiser_phone']=phone; d['appraiser_email']=email
    sup=find(r,'.//SUPERVISOR'); d['supervisor']=gv(sup,'_Name')
    # ---- Photos ----
    d['n_embedded_pdf']=len([e for e in r.findall('.//EMBEDDED_FILE') if e.get('_Type')=='PDF'])
    d['n_image_meta']=len(r.findall('.//IMAGE'))
    return d

R=[extract(f) for f in sorted(glob.glob(f'{STRIP}/*.xml'))]
json.dump(R, open('comprehensive_results.json','w'), indent=1)
N=len(R)
# reliability per field
fields=[k for k in R[0].keys() if k not in ('file','subj_condition','subj_quality')]
def present(v): return v not in (None,'','0',0) or v==0  # count 0 as present for numeric-ok? treat None/'' as missing
def is_missing(v): return v in (None,'')
rows=[]
for f in fields:
    cnt=sum(1 for r in R if not is_missing(r.get(f)))
    rows.append((f,cnt))
rows.sort(key=lambda x:-x[1])
def tier(c):
    p=c/N
    return 'ALWAYS' if c==N else ('USUALLY' if p>=.8 else ('SOMETIMES' if p>=.4 else 'RARELY'))
print(f"FIELD RELIABILITY ACROSS ALL {N} FILES")
print(f"{'field':<22}{'present':<9}{'tier'}")
for f,c in rows:
    print(f"{f:<22}{c}/{N:<6}  {tier(c)}")
