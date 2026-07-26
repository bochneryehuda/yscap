-- 134_sitewire_request_fk.sql — cascade draw-request rows when their draw is removed.
-- Idempotent (guarded ADD CONSTRAINT). sitewire_draw_requests joined sitewire_draws only by
-- id, so deleting an application (which cascade-deletes its sitewire_draws) left orphan
-- request rows behind. Add the missing FK so the cascade reaches them too (audit nit #4).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sitewire_draw_requests_draw_fk') THEN
    -- clear any pre-existing orphans first so the constraint can be added cleanly
    DELETE FROM sitewire_draw_requests r WHERE NOT EXISTS (SELECT 1 FROM sitewire_draws d WHERE d.sitewire_draw_id = r.sitewire_draw_id);
    ALTER TABLE sitewire_draw_requests
      ADD CONSTRAINT sitewire_draw_requests_draw_fk
      FOREIGN KEY (sitewire_draw_id) REFERENCES sitewire_draws(sitewire_draw_id) ON DELETE CASCADE;
  END IF;
END $$;
