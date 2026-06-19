-- Journal des échecs de scan (indexation). Les échecs de dérivés vivent déjà sur
-- assets (derivative_status='error' + derivative_error) et les échecs d'import
-- dans import_batches.result ; seuls les échecs d'indexation par fichier
-- n'étaient nulle part persistés. On les enregistre ici pour pouvoir les LISTER
-- et les RÉESSAYER depuis l'UI. Clé = chemin absolu (upsert : un fichier qui
-- échoue à répétition met à jour la même ligne au lieu d'en accumuler).
CREATE TABLE IF NOT EXISTS scan_failures (
  abs_path    TEXT PRIMARY KEY,
  root_id     BIGINT REFERENCES roots(id) ON DELETE CASCADE,
  error       TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS scan_failures_open_idx
  ON scan_failures (updated_at DESC) WHERE resolved_at IS NULL;
