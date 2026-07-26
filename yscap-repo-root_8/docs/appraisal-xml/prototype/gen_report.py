import json, html
D=json.load(open('sample_data.json'))
photos=json.load(open('sample_photos.json'))
def money(n):
    try: return "$"+format(int(n),",")
    except: return "—"
# derived
arv=D['appraised']; asis=D.get('as_is') or 430000; pp=D['contract_price']
spread=arv-asis
# photo labels (heuristic: first is subject front, then rear/street/interior/comps)
labels=["Subject — Front","Subject — Rear","Subject — Street","Interior","Interior","Comparable 1","Comparable 2","Comparable 3","Comparable 4","Exhibit"]
photo_cards=""
for i,p in enumerate(photos):
    lab=labels[i] if i<len(labels) else f"Photo {i+1}"
    photo_cards+=f'<figure class="gal-item"><img src="{p}" alt="{lab}" loading="lazy"><figcaption>{lab}</figcaption></figure>\n'
hero_photo=photos[0]
# comps rows
comp_rows=""
for c in D['comps']:
    comp_rows+=f'''<tr><td class="cmp-seq">{c['seq']}</td><td class="cmp-addr">{html.escape(c['addr'] or '—')}<span>{html.escape((c.get('city') or ''))}</span></td><td class="num">{c.get('prox') or '—'}</td><td class="num">{money(c['price'])}</td><td class="num strong">{money(c['adj_price'])}</td></tr>\n'''
# unit rents
unit_rows=""
for u in D['unit_rents']:
    unit_rows+=f'''<tr><td>Unit {u['seq']}</td><td class="num">{money(u['actual'])}</td><td class="num">{money(u['market'])}</td></tr>\n'''
# value bar percentages (relative to max = cost 608700 for scale head-room)
scale=max(arv,asis,pp)*1.12
def pct(v): return round(v/scale*100,1)

TEMPLATE=open('report_template.html').read()
out=TEMPLATE
repl={
 '__HERO_PHOTO__':hero_photo,'__ADDRESS__':html.escape(D['address']),
 '__CITYLINE__':f"{html.escape(D['city'])}, {D['state']} {D['zip']} · {html.escape(D['county'])} County",
 '__ARV__':money(arv),'__ASIS__':money(asis),'__PP__':money(pp),'__SPREAD__':money(spread),
 '__ARV_PCT__':str(pct(arv)),'__ASIS_PCT__':str(pct(asis)),'__PP_PCT__':str(pct(pp)),
 '__COST__':money(D['cost_value']),'__INCOME__':money(D['income_value']),'__SALES__':money(arv),
 '__GRM__':str(D['grm']),'__SITEVAL__':money(D['site_value']),'__ECONLIFE__':str(D['econ_life']),
 '__UNITS__':str(D['units']),'__YEAR__':str(D['year_built']),'__GLA__':format(D['gla'],",")+" sf",
 '__BEDS__':str(D['beds']),'__BATHS__':str(D['baths']),'__ROOMS__':str(D['rooms']),'__STORIES__':str(D['stories']),
 '__DESIGN__':html.escape(D['design']),'__TYPE__':html.escape(D['type']),'__LOT__':html.escape(D['lot']),
 '__ZONING__':html.escape(D['zoning']),'__ZONINGDESC__':html.escape(D['zoning_desc']),'__ZONINGOK__':html.escape(D['zoning_ok']),
 '__APN__':html.escape(D['apn']),'__CENSUS__':html.escape(D['census']),'__NEIGH__':html.escape(D['neighborhood']),
 '__COND__':html.escape(D.get('condition') or 'C4'),'__QUAL__':html.escape(D.get('quality') or 'Q4'),
 '__EFFDATE__':D['effective_date'],'__SIGNED__':D['signed'],'__CONDOFAPP__':D['cond_of_appraisal'],
 '__APPRAISER__':html.escape(D['appraiser']),'__COMPANY__':html.escape(D['company']),
 '__LICENSE__':html.escape(D['license']),'__LICSTATE__':D['license_state'],'__LICEXP__':D['license_exp'],
 '__PHONE__':D['phone'],'__LENDER__':html.escape(D['lender']),
 '__GROSS_ACTUAL__':money(D['gross_actual']),'__GROSS_MARKET__':money(D['gross_market']),
 '__PHOTO_CARDS__':photo_cards,'__COMP_ROWS__':comp_rows,'__UNIT_ROWS__':unit_rows,
 '__NCOMPS__':str(len(D['comps'])),
}
for k,v in repl.items(): out=out.replace(k,v)
open('/home/user/yscap/yscap-repo-root_8/docs/appraisal-xml/pilot-property-report-mockup.html','w').write(out)
print("wrote mockup:",len(out),"bytes")
