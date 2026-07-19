-- 151_sitewire_partner_links.sql
-- Idempotent. Durable, human-CONFIRMED links between our free-text note-buyer label
-- (applications.lender, e.g. "Fidelis" / "Blue Lake") and a Sitewire capital-partner directory id
-- (e.g. "Fidelis Investments LLC" / "Blue Lake Capital"), so a rule for a note buyer translates to the
-- right Sitewire partner even when the names are spelled differently. The label is stored NORMALIZED
-- (lowercased, non-alphanumerics stripped) as the key; sitewire_id NULL means "explicitly no Sitewire
-- partner" (handled externally / not in the directory). Never guessed — an admin confirms each link.
-- (owner-directed 2026-07-19)
CREATE TABLE IF NOT EXISTS sitewire_partner_links (
  label_norm    text PRIMARY KEY,
  label         text NOT NULL,
  sitewire_id   bigint,
  confirmed_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  confirmed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Owner-directed seed (2026-07-19): the three note buyers the owner explicitly matched by hand to
-- Sitewire's directory (real live ids on lender 236 — Fidelis Investments LLC=19, Blue Lake Capital=41,
-- CorrFirst=27). These are CONFIRMED by the owner, not guessed. ON CONFLICT DO NOTHING so a later admin
-- re-link (or unlink) is never clobbered on reboot — a human decision always wins over the seed.
INSERT INTO sitewire_partner_links (label_norm, label, sitewire_id) VALUES
  ('fidelis',   'Fidelis',    19),
  ('bluelake',  'Blue Lake',  41),
  ('corrfirst', 'CorrFirst',  27)
ON CONFLICT (label_norm) DO NOTHING;
