'use strict';
/* Borrower draw-setup + wire-form designed emails (owner-directed 2026-07-21). PURE — no DB, no
 * network. Covers the template `sections` component, the two content builders, the catalog wire-form
 * builder, and the borrower-safe scrub of `sections`. Run: node scripts/test-draw-setup-emails.js */
const assert = require('assert');
const tpl = require('../src/lib/email/template.js');
const { drawSetupNotifyOpts, wireFormEmail, _isPhysical } = require('../src/lib/email/draw-setup-email.js');
const catalog = require('../src/lib/email/catalog.js');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ---- template sections component ----
{
  const base = tpl.render({ title: 'T', intro: 'hi' });
  const withS = tpl.render({ title: 'T', intro: 'hi', sections: [{ title: 'Step one', body: ['a', 'b'], link: { label: 'Guide', url: 'https://x.y' } }, { title: 'Step two', body: 'c' }] });
  assert.ok(!/Step one/.test(base.html), 'no-sections render omits the block');
  assert.ok(/Step one/.test(withS.html) && /Step two/.test(withS.html), 'sections render');
  assert.ok(withS.html.includes('href="https://x.y"'), 'section link renders as an anchor');
  assert.ok(/STEP ONE/.test(withS.text) && withS.text.includes('Guide: https://x.y'), 'sections in plaintext');
  assert.ok(tpl.render({ title: 'T', sections: [{ title: '<b>x', body: 'a<script>' }] }).html.includes('&lt;b'), 'section content is escaped');
  ok('template: sections render in HTML + plaintext, escape safely, omit when unused');
}

// ---- method mapping ----
assert.strictEqual(_isPhysical('traditional'), true);
assert.strictEqual(_isPhysical('mobile'), false);
assert.strictEqual(_isPhysical('physical'), true);
assert.strictEqual(_isPhysical(''), false, 'unknown/blank → virtual default');
ok('method: traditional/physical → on-site; mobile/blank → virtual');

// ---- drawSetupNotifyOpts (notify shape) ----
{
  const virt = drawSetupNotifyOpts({ address: '109 Chapel St', budgetCents: 18000000, method: 'mobile' });
  const phys = drawSetupNotifyOpts({ address: '109 Chapel St', budgetCents: 18000000, method: 'traditional' });
  assert.strictEqual(virt.type, 'draw_setup', 'type is draw_setup (draws section)');
  assert.strictEqual(virt.major, true, 'major → always emails the borrower');
  assert.deepStrictEqual(virt.bccExtra, ['draws@yscapgroup.com'], 'loops the draw-coordinator desk');
  assert.ok(virt.hero && virt.hero.value === '$180,000', 'hero shows the construction budget');
  assert.ok(virt.meta.some((m) => m.label === 'Property' && m.value === '109 Chapel St'), 'meta names the property');
  assert.ok(virt.meta.some((m) => /\$180,000/.test(m.value)), 'meta carries the budget');
  assert.ok(virt.callout && /before your first wire/i.test(virt.callout.title), 'callout previews the wire-form step');
  assert.ok(/only be released once that form is signed/i.test(virt.callout.body), 'callout states wire releases only after signing');
  // method-specific instructions
  const virtBodies = JSON.stringify(virt.sections);
  const physBodies = JSON.stringify(phys.sections);
  assert.ok(/Sitewire app/i.test(virtBodies) && /camera roll/i.test(virtBodies), 'virtual: Sitewire app self-capture instructions');
  assert.ok(/on-site inspection|in person|on-site inspector|licensed inspector/i.test(physBodies) && !/camera roll/i.test(physBodies), 'physical: on-site inspector instructions, no self-capture');
  assert.ok(/Sitewire/i.test(virtBodies) && /invitation/i.test(virtBodies), 'virtual: mentions the Sitewire invite');
  // no partner leak in any field
  assert.ok(!/BlueLake|Blue Lake|Fidelis|Churchill|CorrFirst|RCN|Temple View/i.test(JSON.stringify(virt) + JSON.stringify(phys)), 'no note-buyer / capital-partner name');
  ok('drawSetupNotifyOpts: draws section, always-email, desk loop, budget+property, wire-form callout, method-branched, no partner leak');
}

// ---- wireFormEmail (render payload) + catalog builder ----
{
  const p = wireFormEmail({ borrowerName: 'Yaakov Weiss', address: '109 Chapel St', budgetCents: 18000000, signUrl: 'https://app/api/esign/sign?t=MAGIC' });
  assert.strictEqual(p.audience, 'borrower');
  assert.ok(p.cta && p.cta.url === 'https://app/api/esign/sign?t=MAGIC', 'direct signing link is the primary CTA');
  assert.ok(/Hi Yaakov,/.test(p.greeting), 'greets by first name');
  assert.ok(/cannot be reversed/i.test(p.callout.body) && /after this form is signed/i.test(p.callout.body), 'sensitivity + release-after-signing warning');
  const noLink = wireFormEmail({ borrowerName: 'X', address: 'Y', budgetCents: 0 });
  assert.strictEqual(noLink.cta, null, 'no signUrl → no CTA (never a dead button)');

  const built = catalog.drawWireReadyToSign({ firstName: 'Yaakov', propertyLabel: '109 Chapel St', loanNumber: 'YS-1042', budgetCents: 18000000, signUrl: 'https://app/api/esign/sign?t=MAGIC' });
  assert.ok(built.subject.includes('YS-1042') && built.subject.includes('109 Chapel'), 'subject carries the file tag');
  assert.ok(built.html.includes('https://app/api/esign/sign?t=MAGIC'), 'the direct DocuSign signing link is embedded');
  assert.ok(!/BlueLake|Fidelis|Churchill|CorrFirst/i.test(built.html), 'no partner leak');
  ok('wireFormEmail + drawWireReadyToSign: direct link, file tag, sensitivity warning, safe');
}

// ---- borrower scrub covers sections (defense-in-depth in notify) ----
// The template does not scrub; notify.notifyBorrower does. Simulate the section-scrub the notify
// chokepoint applies (a partner name typed into a section body must never reach the borrower).
{
  const { scrubTextExcept } = require('../src/lib/borrower-safe');
  const scrubbed = scrubTextExcept('Funded by Blue Lake Capital', ['109 Chapel St']);
  assert.ok(!/Blue Lake/i.test(scrubbed) && /Gold Standard program/.test(scrubbed), 'a partner name in free text scrubs to Gold Standard program');
  ok('scrub: a partner name in section text would be replaced (notify applies this to sections)');
}

console.log(`\nAll ${n} draw-setup / wire-form email checks passed.`);
