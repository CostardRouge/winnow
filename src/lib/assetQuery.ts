// Shared SQL for the cull-grid rows, used by the gallery, the session grid and
// the single-asset detail route. Keeping one projection here stops the three
// routes from drifting apart.
//
// Each row carries the asset, its rating (verdict/star/color), its tags, and —
// for paired assets (cf. lib/pairing.ts) — its companion's id, extension,
// media-type and per-file stats (filename, size, dimensions), plus the group's
// kind. This lets the viewer offer the segmented toggle (describing whichever
// side is on screen, and playing the .mov when the companion is a Live Photo's
// motion) and the grid badge the pair (RAW+… or LIVE). The companion fields and
// `group_kind` are NULL when the asset is not paired.

// SELECT projection (assumes `assets a` + the joins in GRID_FROM are in scope).
export const GRID_SELECT = `a.*,
        COALESCE(r.verdict, 'unrated') AS verdict,
        COALESCE(r.star, 0)            AS star,
        r.color_label,
        comp.id         AS companion_id,
        comp.ext        AS companion_ext,
        comp.media_type AS companion_media_type,
        comp.filename   AS companion_filename,
        comp.file_size  AS companion_file_size,
        comp.width      AS companion_width,
        comp.height     AS companion_height,
        g.kind          AS group_kind,
        aa.sharpness           AS sharpness,
        aa.near_dup_cluster_id AS near_dup_cluster_id,
        aa.ml_status           AS ml_status,
        (SELECT count(*)::int FROM asset_sidecars sc
          WHERE sc.asset_id = a.id) AS sidecar_count,
        (SELECT COALESCE(array_agg(t.name ORDER BY t.name), '{}')
           FROM asset_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.asset_id = a.id) AS tags`;

// FROM + joins. The LATERAL pulls the OTHER (non-deleted) member of the group;
// a group holds exactly two members, so LIMIT 1 is exact. `g` carries the group
// kind so the UI can tell a RAW+JPEG pair from a Live Photo.
export const GRID_FROM = `FROM assets a
        LEFT JOIN ratings r ON r.asset_id = a.id
        LEFT JOIN asset_groups g ON g.id = a.group_id
        LEFT JOIN asset_analysis aa ON aa.asset_id = a.id
        LEFT JOIN LATERAL (
          SELECT c.id, c.ext, c.media_type, c.filename, c.file_size,
                 c.width, c.height
          FROM assets c
          WHERE a.group_id IS NOT NULL
            AND c.group_id = a.group_id
            AND c.id <> a.id
            AND c.deleted_at IS NULL
          LIMIT 1
        ) comp ON true`;
