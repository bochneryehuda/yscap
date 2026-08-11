'use strict';
/**
 * Pure guard for the AMC form-name resolver + the robust form catalog (order-service).
 *
 * The owner asked to SEE the form's full name (not just "Form #56634") and to CHANGE
 * it from a dropdown. formNameFor resolves a name for a form id; formsCatalog builds
 * the dropdown list robustly — it survives the GetJobType cache being keyed under a
 * different subdomain than the live tenant, and always includes the mapped forms so a
 * mapped form is never nameless. No DB (a tiny stub), no network.
 */
const svc = require('../src/amc/order-service');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ---- formNameFor ---------------------------------------------------------------
{
  const catalog = [{ id: '6', name: 'Single-family (1004)' }, { id: '5', name: 'Bridge SFR' }];
  ok(svc.formNameFor(catalog, '6') === 'Single-family (1004)', 'name resolved from the catalog by id');
  ok(svc.formNameFor(catalog, '5', { productCode: '5', productName: 'Bridge (rule name)' }) === 'Bridge (rule name)', 'the chosen rule name wins when it matches the code');
  ok(svc.formNameFor(catalog, '6', { productCode: '5', productName: 'X' }) === 'Single-family (1004)', 'a chosen name for a DIFFERENT code is not used');
  ok(svc.formNameFor(catalog, '999') === null, 'unknown id → null');
  ok(svc.formNameFor(catalog, '') === null && svc.formNameFor(catalog, null) === null, 'blank/null id → null');
}

// ---- formsCatalog (async, tiny db stub) ----------------------------------------
const stub = (fn) => ({ query: async (sql, params) => fn(sql, params) });

(async () => {
  // 1. A live catalog under our subdomain + a mapped rule → both appear, name-carried.
  {
    const db = stub((sql, params) => {
      if (/lookup_type = \$1 AND subdomain = \$2/.test(sql)) {
        const [type, sub] = params;
        if (type === 'Get_JobTypes_By_LoanType' && sub === 'nan') {
          return { rows: [{ payload: [{ id: '6', name: 'Single-family (1004)' }], fetched_at: new Date() }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    });
    const cat = await svc.formsCatalog(db, { subdomain: 'nan' }, [{ product_code: '5', product_name: 'Bridge SFR' }]);
    ok(cat.some((f) => f.id === '6' && f.name === 'Single-family (1004)'), 'live catalog form is listed');
    ok(cat.some((f) => f.id === '5' && f.name === 'Bridge SFR'), 'the mapped rule form is listed with its name');
  }

  // 2. Nothing under our subdomain → fall back to the freshest catalog under ANY subdomain.
  {
    const db = stub((sql) => {
      if (/subdomain = \$2/.test(sql)) return { rows: [] };                 // nothing under our subdomain
      if (/ORDER BY fetched_at DESC LIMIT 1/.test(sql)) return { rows: [{ payload: [{ id: '9', name: 'Condo (1073)' }] }] };
      return { rows: [] };
    });
    const cat = await svc.formsCatalog(db, { subdomain: 'zzz' }, []);
    ok(cat.some((f) => f.id === '9' && f.name === 'Condo (1073)'), 'falls back to the freshest cached catalog');
  }

  // 3. Dedup by id (a mapped id also in the live catalog appears ONCE) + a nameless
  //    live id gets its name from the rule.
  {
    const db = stub((sql, params) => {
      if (/lookup_type = \$1 AND subdomain = \$2/.test(sql)) {
        const [type] = params;
        if (type === 'Get_JobTypes_By_LoanType') return { rows: [{ payload: [{ id: '5', name: '' }], fetched_at: new Date() }] };
        return { rows: [] };
      }
      return { rows: [] };
    });
    const cat = await svc.formsCatalog(db, { subdomain: 'nan' }, [{ product_code: '5', product_name: 'Bridge SFR' }]);
    ok(cat.filter((f) => f.id === '5').length === 1, 'an id in both the catalog and a rule is listed once');
    ok(cat.find((f) => f.id === '5').name === 'Bridge SFR', 'a nameless live id borrows the rule name');
  }

  // 4. A total miss (nothing cached, no rules) → an empty list, never a throw.
  {
    const db = stub(() => ({ rows: [] }));
    const cat = await svc.formsCatalog(db, { subdomain: 'x' }, []);
    ok(Array.isArray(cat) && cat.length === 0, 'no catalog + no rules → empty list');
  }

  // 5. A db that throws never breaks the preview (formsCatalog swallows the read).
  {
    const db = { query: async () => { throw new Error('db down'); } };
    let threw = false, cat = null;
    try { cat = await svc.formsCatalog(db, { subdomain: 'x' }, [{ product_code: '7', product_name: 'Two-to-four (1025)' }]); } catch (_) { threw = true; }
    ok(!threw && Array.isArray(cat) && cat.some((f) => f.id === '7'), 'a db failure degrades to the mapped-rule names, never a throw');
  }

  console.log(`\n[test-amc-form-contacts-pure] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
