-- Phase 6e — broker (TPO) ↔ our-team MESSAGING (owner-approved scope: "messaging with our team").
-- The broker gets a dedicated conversation on their firm's file, reusing the existing chat v3
-- infra (conversations / messages / conversation_members). A broker IS a staff_users row
-- (is_external=true), but must be DISTINCT from our internal team in the roster and attribution,
-- so they post/join as a NEW kind 'tpo' rather than as 'staff'.
--
-- This migration only WIDENS three CHECKs to admit 'tpo' — purely additive, so every existing
-- borrower/staff/system/external row and code path is unchanged.
--
-- IDEMPOTENCY (the db/527 lesson): each widen is under the constraint's OWN name.
--   · messages_sender_kind_check is RE-ADDED unconditionally by db/113 every boot. Once a 'tpo'
--     message row exists, db/113's replay re-adds the NARROW list and fails against it — but
--     because THIS file re-defines the SAME constraint name at a higher migration number,
--     migrate-boot's superseded-constraint detection recognizes that failure and skips it quietly
--     (exactly the mechanism db/527 documents; using a NEW name would defeat it).
--   · conversations_kind_check and conversation_members_member_kind_check are inline (schema.sql /
--     db/035) and are never re-added by a later file, so there is no replay failure to absorb.
-- Each block acts only when the constraint lacks 'tpo' (no per-boot churn / re-validation).

-- messages.sender_kind: + 'tpo'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='messages_sender_kind_check' AND pg_get_constraintdef(oid) LIKE '%tpo%') THEN
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_kind_check;
    ALTER TABLE messages ADD CONSTRAINT messages_sender_kind_check
      CHECK (sender_kind IN ('borrower','staff','system','external','tpo'));
  END IF;
END $$;

-- conversation_members.member_kind: + 'tpo'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='conversation_members_member_kind_check' AND pg_get_constraintdef(oid) LIKE '%tpo%') THEN
    ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS conversation_members_member_kind_check;
    ALTER TABLE conversation_members ADD CONSTRAINT conversation_members_member_kind_check
      CHECK (member_kind IN ('borrower','staff','tpo'));
  END IF;
END $$;

-- conversations.kind: + 'tpo' (the broker↔team channel kind; never borrower_visible)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='conversations_kind_check' AND pg_get_constraintdef(oid) LIKE '%tpo%') THEN
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_kind_check;
    ALTER TABLE conversations ADD CONSTRAINT conversations_kind_check
      CHECK (kind IN ('borrower','internal','lo_processor','custom','tpo'));
  END IF;
END $$;

-- SECURITY CLEANUP (previous AND future): before Phase 6e, chat.ensureConversationsForApp seated the
-- file's loan_officer as a 'staff' member of the internal/borrower/lo_processor chats — and on a TPO
-- file the loan_officer IS the EXTERNAL broker, so the broker was seated as a 'staff' member of the
-- internal "Loan Team" chat and would be emailed our team's raw internal messages. The engine no
-- longer seats external staffers there; this removes any that were already seated. A broker's ONLY
-- chat is the 'tpo' conversation, so an external 'staff' membership on any NON-tpo conversation is
-- always wrong. Idempotent.
DELETE FROM conversation_members cm
 USING conversations c, staff_users su
 WHERE cm.conversation_id = c.id
   AND c.kind <> 'tpo'
   AND cm.member_kind = 'staff'
   AND su.id = cm.member_id
   AND su.is_external = true;
