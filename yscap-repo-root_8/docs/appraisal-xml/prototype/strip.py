import os, re, glob

SRC = glob.glob('**/*.xml', recursive=True)
OUT = 'stripped'
os.makedirs(OUT, exist_ok=True)

summary = []
for path in sorted(SRC):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        raw = f.read()
    # Strip base64 payloads inside <DOCUMENT>...</DOCUMENT> (keep tag, note length)
    def repl_doc(m):
        return f'<DOCUMENT>[BASE64 {len(m.group(1))} chars stripped]</DOCUMENT>'
    stripped = re.sub(r'<DOCUMENT>(.*?)</DOCUMENT>', repl_doc, raw, flags=re.DOTALL)
    # Also strip any other very long base64-ish text nodes
    form = re.search(r'AppraisalFormType="([^"]*)"', raw)
    formv = re.search(r'AppraisalFormVersionIdentifier="([^"]*)"', raw)
    contentname = re.search(r'AppraisalReportContentName="([^"]*)"', raw)
    purpose = re.search(r'AppraisalPurposeType="([^"]*)"', raw)
    base = os.path.basename(path)
    outp = os.path.join(OUT, base)
    with open(outp, 'w', encoding='utf-8') as f:
        f.write(stripped)
    summary.append((base, form.group(1) if form else '?', 
                    contentname.group(1) if contentname else '?',
                    purpose.group(1) if purpose else '?',
                    f'{len(raw)//1024}KB -> {len(stripped)//1024}KB'))

print(f"{'FILE':<45} {'FORM':<12} {'PURPOSE':<12} SIZE")
print('='*100)
for base, form, cname, purpose, sz in summary:
    print(f"{base:<45} {form:<12} {purpose:<12} {sz}")
print()
print("Content names:")
for base, form, cname, purpose, sz in summary:
    print(f"  {base[:40]:<40} {cname}")
