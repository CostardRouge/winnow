-- Application settings (JSONB key/value): scan pause + hourly rate.
-- Read by the app (UI/API) and by the workers; 0 = unlimited for the rates.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES
  ('scan_paused',      'false'::jsonb),
  ('scan_per_hour',    '0'::jsonb),
  ('analyze_per_hour', '0'::jsonb)
ON CONFLICT (key) DO NOTHING;
