-- "Marquer complet" : drapeau visuel sur une session incoming. N'altère ni le
-- traitement, ni la file, ni la classification ; sert uniquement à afficher un
-- badge "terminé" dans l'onglet Incoming (décision produit : simple drapeau).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT false;
