-- A final sent back by a client (Atelier's "send to Winnow") names the capture
-- it was edited from: `original_asset_id` on the multipart of POST /api/upload.
-- The import files the upload by its own template and the asset row only
-- appears when the indexer later walks the incoming root, so the link cannot be
-- written at upload time. This table carries it across that gap: the importer
-- records (filed path → source asset) once the file is on disk, and the indexer
-- writes `assets.original_asset_id` (edit_match 'upload') when it meets the row
-- (cf. lib/importLinks.ts).
--
-- Before this, the only writer of original_asset_id was the admin-only
-- reconcile, which matches finals ROOTS by name and capture time — an upload
-- lands in the incoming (a source root), so an edit sent by an editor or an app
-- token was never linked.
--
-- Retention: a row lives from the import to the scan that indexes its file
-- (seconds to minutes), and is deleted then, linked or not. A row whose file
-- never becomes an asset (moved or removed before the scan) is dropped after
-- 30 days by the same pass, with a logged reason. Removing the source asset for
-- good drops the pending link with it (CASCADE).

CREATE TABLE IF NOT EXISTS import_links (
  abs_path          TEXT PRIMARY KEY,
  original_asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  batch_id          BIGINT REFERENCES import_batches(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
