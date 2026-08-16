<!-- Captured PPE research brief (agent-generated, 2026-08-16). LT-only reference for the MEGA PPE build. Source: docs/longterm/PPE-MEGA-PLAN.md indexes these. -->

# Engineering Brief: A Generic, Multi-Tenant Mortgage Product & Pricing Engine

## Governing principle: configuration over customization

The product must obey one rule: **behavior is data, not code branches**. Nothing about "us" (the founding lender) may exist as a conditional in source. The reference model is Salesforce's **metadata-driven architecture** — a single runtime engine that "materializes" every screen, field, and business rule from **metadata** at execution time, so tenants customize by writing config rows, never by forking code. Stripe (products/prices/tax as objects), Shopify (theme + settings + apps), and enterprise **rules engines** (Drools, GoRules/ZEN, Camunda DMN **decision tables**) follow the same shape: the engine is generic; the differentiation is a **ruleset** it loads. For a PPE this means eligibility, **LLPA**/adjustment stacks, margin, rounding, price caps, and the entire **lock workflow** are *interpreted* from tenant config. The disqualifying anti-patterns are explicit: `if (tenant == "us")`, hardcoded investor names, a compiled eligibility matrix, or a lock policy expressed in Java/TypeScript rather than in a table. If a requirement can only be met by editing code, the design has failed.

## Multi-tenancy and isolation

Adopt **shared-schema, single-database multi-tenancy** with a `tenant_id` on every row and **PostgreSQL Row-Level Security (RLS)** as the enforcement floor. RLS filters by a session variable (`SET app.tenant_id`) at the database engine, so a forgotten `WHERE` clause in application code still cannot leak cross-tenant data — the correct default because pricing data is commercially sensitive but not regulated to the point of demanding physical separation. Reserve **schema-per-tenant** or **database-per-tenant** for a small number of large enterprise buyers who contractually require it; keep that a *deployment* choice, not a code fork, by making the data-access layer tenant-topology-agnostic. Address **noisy neighbor** risk (one lender's bulk rate-sheet reprice starving others) with per-tenant rate limits, async job queues partitioned by tenant, and read replicas for scenario/search traffic. **Blast radius**: config changes are tenant-scoped and versioned so a bad edit harms one tenant and is instantly reversible; never let a shipped-default change silently mutate live tenant behavior. Propagate tenant context into **background jobs and cache keys** (scope every cache key by `tenant_id` + config version) — the most common isolation bug is an unkeyed cache or a job that runs without tenant context.

## Seed vs. config

The shipped product carries **industry-standard defaults** as **product-default** rows. A specific customer's setup — including ours — is **seed data**: a bundle loaded into their tenant that is *fully overridable*, never privileged. Concretely, ship **ruleset templates** (versioned, read-only, product-owned): a "Conventional Conforming" eligibility template, an "Agency LLPA 2023" adjustment template, a "Standard Best-Efforts Lock Policy" template. A tenant **clones** a template into a **tenant_ruleset** and edits the copy. This gives you **versioned defaults vs. tenant overrides**: the template can advance to v2 without touching any tenant who already forked; tenants opt into upgrades via a diff/merge flow (like Salesforce managed-package upgrades). Our go-live config is nothing more than a **seed manifest** of template clones plus a handful of overridden values — reproducible, deletable, and identical in mechanism to what any buyer receives on day one.

## "Every requirement becomes a setting with alternatives"

The core method: for each requirement, (1) name the **industry-standard** option, (2) enumerate the **other real-world options**, (3) model them as an **enum/typed setting** exposing *all* choices, (4) **pre-select** ours as the default. The owner's preference becomes seed data, never a code path. Worked examples:

- **Worst-case pricing on re-lock/renegotiation.** Options: `worse_of_original_and_current` (industry standard, prevents borrowers gaming lapses), `current_market`, `original`, `best_of`. Model as `lock.relock_pricing_basis` enum; default `worse_of`.
- **Float-down policy.** Settings: `lock.float_down.enabled` (bool), `trigger_bps` (default 25), `max_invocations` (default 1), `window` (`anytime | within_n_days_of_close`), `fee_bps`. Every lender's policy is a point in this parameter space, not a bespoke feature.
- **LLPA / adjustment rounding.** Options: `none`, `nearest_eighth` (0.125), `nearest_bps`, `up`/`down`/`half_even`. Model `pricing.adjustment_rounding.mode` + `increment`; default `nearest_eighth`, `half_up`.
- **Price cap behavior.** When par-plus pricing exceeds a cap (e.g. 103.5): `cap_and_keep_eligible`, `cap_and_flag`, or `make_ineligible`. Model `pricing.price_cap.value` + `.on_exceed` enum; default `cap_and_keep_eligible`.
- **Eligibility strictness / result semantics.** Options: `hard_fail_only` (hide ineligible), `show_with_reasons` (industry standard — surface every failed rule for LO transparency), `soft_warn`. Model `eligibility.result_mode`; default `show_with_reasons`. Rule severity itself is per-rule config (`disqualify | warn | info`).

The discipline: if a stakeholder says "we want X," the engineer's job is not to build X but to build *the axis X sits on*, expose the whole axis, and default it to X.

## White-labeling and investor masking

**Investor-name masking must be a config concern, not a code concern.** The engine prices against real investor/program identifiers; a **display-mapping layer** substitutes tenant-defined **internal program names** (Diamond/Stone/Brilliant) at render time. Model as `program_alias(tenant_id, real_investor_id, display_name, visibility_scope)` so masking is per-role (LOs see aliases, secondary-desk sees true investors) and per-tenant. Tenant **branding** (logo, palette, PDF rate-sheet templates) and **per-tenant terminology** (glossary overrides — "lock" vs "commitment") live in the same settings layer. Never embed "Diamond" in code; it is one tenant's alias row.

## Settings architecture (the "mega settings" layer)

Build a **typed settings registry**. Each setting is declared once as a **setting_definition** carrying: key, datatype, allowed values/enum, validation constraints, default, **UI metadata** (control type, group, label, help), and effective-dating support. This metadata model lets the front end **render settings generically** — no bespoke screens per feature. Resolution follows a strict **override chain**: `tenant value → org/parent-group default → product default`, with the first hit winning. Support **effective-dating** (a value can be scheduled — critical because rate-sheet and LLPA changes are time-boxed), full **audit** (who/when/old→new, immutable log), and **config versioning** so any priced scenario can be reproduced against the exact config in force at that timestamp. Validate on write against the definition; reject unknown keys and out-of-enum values.

## Governance and extensibility

Rules for staying sellable: **no per-customer code, ever.** New investors, programs, and rules are added purely as config/ruleset rows through admin UI or API. For genuinely novel logic a config axis can't express, provide a **sandboxed extension model** — named **hook points** (pre-eligibility, post-pricing, custom-adjustment) that run tenant-scoped expressions (a safe DSL / **decision tables**), not arbitrary deployed code. Gate incomplete or premium capabilities behind **feature flags** (themselves per-tenant settings). Treat any pressure to "just hardcode it for launch" as debt that violates the governing rule.

## Vetting requirements against industry standards (repeatable checklist)

For every owner requirement: **(a)** identify the **industry-standard approach** (search agency guides, competitor PPEs like ICE and Lender Price, published lender lock policies); **(b)** enumerate **alternatives** actually used in market; **(c)** model as a typed setting exposing all options with **ours pre-filled as default**; **(d)** confirm zero new `if-tenant` branches; **(e)** register definition + UI metadata + validation; **(f)** capture our choice as **seed**, not core.

## Schema sketch

```
tenant(id, name, parent_org_id, branding_json)
setting_definition(key PK, datatype, enum_values[], constraints_json,
                   product_default, ui_metadata_json, effective_dating bool)
setting_value(tenant_id, key, value_json, effective_from, effective_to,
              version, updated_by, updated_at)     -- RLS by tenant_id
  -- resolution: setting_value(tenant) → setting_value(parent_org)
  --             → setting_definition.product_default
ruleset_template(id, kind, name, version, body_json, is_product_owned)
tenant_ruleset(id, tenant_id, template_id, template_version,
               body_json, status, effective_from)  -- cloned + edited copy
program_alias(tenant_id, real_investor_id, display_name, visibility_scope)
config_audit(tenant_id, entity, key, old_json, new_json, actor, at)
```

**Preventing "us-specific" leakage:** a CI lint that fails the build on tenant-name/investor-name string literals; an architectural test asserting the engine reads only from resolved config; a "fresh-tenant" test that provisions an empty tenant from product defaults and must produce valid (if generic) pricing with zero seed.

**Pitfalls:** unkeyed caches ignoring config version; missing effective-dating (can't reproduce a lock's price); enum drift between DB and UI (single source: `setting_definition`); template upgrades silently overwriting tenant edits (require explicit merge); RLS bypass in background jobs; and "temporary" hardcoding that becomes permanent. Guard each with tests, not good intentions.

Sources: [ICE PPE](https://mortgagetech.ice.com/products/ice-product-and-pricing-engine), [Lender Price](https://lenderprice.com/), [LLPA guide](https://themortgagereports.com/6866/llpa-loan-level-pricing-adjustment-mortgage-rate), [AD Mortgage Lock Policy](https://admortgage.com/wp-content/uploads/AD-Lock-Policy-09-19-2025.pdf), [Force.com Multitenancy whitepaper](https://www.developerforce.com/media/ForcedotcomBookLibrary/Force.com_Multitenancy_WP_101508.pdf), [Salesforce metadata architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html), [Postgres RLS for tenants](https://www.crunchydata.com/blog/row-level-security-for-tenants-in-postgres).