-- 657 — THE VESTING CONDITION KEEPS ASKING WHILE FIELD 4008 IS BLANK.
--
-- Owner-directed 2026-08-31. Field 4008 decides whether a long-term loan is
-- asked for its company's formation documents, and on the 19 loans (of 486)
-- where Encompass has not answered, the owner chose to KEEP ASKING until it
-- positively says Individual.
--
-- WHY A MIGRATION AND NOT JUST THE LIBRARY. `library.js` ships the rule, but its
-- seed is `ON CONFLICT (code) DO NOTHING` — deliberately, so a buyer's own edit
-- to a condition survives every redeploy. The consequence is that changing a
-- SHIPPED rule reaches only a database that has never seeded that row, which in
-- practice means none of them: every deployment already carries
--
--   {"combinator":"and","rules":[{"field":"vests_in_entity","operator":"is_true"}]}
--
-- and would have gone on using it while the code said otherwise. The pure tests
-- could not see this (they read the library); the database test is what caught
-- it. WHEN YOU CHANGE A SHIPPED RULE, SHIP A MIGRATION WITH IT.
--
-- WHAT THE NEW RULE SAYS. `vests_in_entity` now reads field 4008 and answers
-- null when Encompass has not said — honestly, because nothing stated is not
-- "Individual" — and the evaluator turns a blank into false. So a single
-- `is_true` row would take this condition OFF every unanswered loan. The second
-- row says "or we have not been told", which is the owner's rule and invents no
-- fact about the title. It reads on the settings screen as:
--
--   Title is taken in an entity is yes OR Title is taken in an entity is blank
--
-- GUARDED ON THE EXACT OLD VALUE, so a buyer who has edited this rule keeps
-- their edit — the same respect the seed's DO NOTHING gives them. Idempotent:
-- the second run matches nothing.
--
-- SCOPE: one row, named by its long-term code. `checklist_templates` is the
-- shared condition table both products read (db/652, db/653); nothing here
-- touches a short-term row, and `lt_vesting_entity` exists only on this side.

UPDATE checklist_templates
   SET rule_logic = '{"combinator":"or","rules":[{"field":"vests_in_entity","operator":"is_true"},{"field":"vests_in_entity","operator":"is_empty"}]}'::jsonb
 WHERE code = 'lt_vesting_entity'
   AND rule_logic = '{"combinator":"and","rules":[{"field":"vests_in_entity","operator":"is_true"}]}'::jsonb;
