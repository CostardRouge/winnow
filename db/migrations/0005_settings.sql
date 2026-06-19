-- Réglages applicatifs (clé/valeur JSONB) : pause du scan + débit horaire.
-- Lus par l'app (UI/API) et par les workers ; 0 = illimité pour les débits.
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
