-- 133_sitewire_monitor_settings.sql — thresholds for the portfolio early-warning monitor.
-- Idempotent. Admin-tunable via PATCH /api/sitewire/settings. Defaults match the engine's
-- built-in fallbacks so behavior is identical until an admin changes them.
INSERT INTO sitewire_settings (key, value) VALUES ('stale_days', '30'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO sitewire_settings (key, value) VALUES ('no_draw_days', '45'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO sitewire_settings (key, value) VALUES ('pacing_gap_pct', '25'::jsonb) ON CONFLICT (key) DO NOTHING;
