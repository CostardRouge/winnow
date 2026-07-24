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
//
// It also carries the finals→sources counterpart (cf. lib/reconcile.ts): on an
// edited final, its source original's name/ext (`original_*`); on a source, how
// many edits link to it (`edit_count`) plus the first one's name/ext/id
// (`first_edit_*`). These feed the viewer's before/after toggle and are
// NULL/0 when the asset has no counterpart.

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
        bu.cover_asset_id AS burst_cover_id,
        -- Live (non-deleted) size of this frame's burst/bracket pile — badged on
        -- the collapsed cover tile. NULL (no subquery) when the frame isn't
        -- stacked. Counted live, not read off bursts.member_count, so the badge
        -- shrinks as pile frames are trashed.
        CASE WHEN a.burst_id IS NULL THEN NULL ELSE (
          SELECT count(*)::int FROM assets bm
           WHERE bm.burst_id = a.burst_id AND bm.deleted_at IS NULL) END
          AS burst_count,
        (SELECT count(*)::int FROM asset_sidecars sc
          WHERE sc.asset_id = a.id) AS sidecar_count,
        -- Drone telemetry present? Drives the grid's telemetry badge (a DJI .SRT
        -- flight log, distinct from a Sony XML/THM metadata companion).
        EXISTS (SELECT 1 FROM asset_sidecars sc
                 WHERE sc.asset_id = a.id AND sc.kind = 'srt') AS has_telemetry,
        -- The sidecars themselves (id/kind/filename), for the viewer's detail
        -- row + per-file download links. Empty array when the asset has none.
        (SELECT COALESCE(
                  json_agg(json_build_object(
                    'id', sc.id, 'kind', sc.kind, 'filename', sc.filename,
                    'maxAltitude', sc.max_altitude, 'sampleCount', sc.sample_count,
                    'gimbalPitch', sc.gimbal_pitch, 'gimbalYaw', sc.gimbal_yaw,
                    'gimbalRoll', sc.gimbal_roll, 'maxSpeed', sc.max_speed,
                    'iso', sc.iso, 'shutter', sc.shutter,
                    'fnumber', sc.fnumber, 'focalLength', sc.focal_length)
                  ORDER BY sc.id), '[]'::json)
           FROM asset_sidecars sc WHERE sc.asset_id = a.id) AS sidecars,
        orig.filename   AS original_filename,
        orig.ext        AS original_ext,
        (SELECT count(*)::int FROM assets e
          WHERE e.original_asset_id = a.id AND e.deleted_at IS NULL) AS edit_count,
        ed.id           AS first_edit_id,
        ed.filename     AS first_edit_filename,
        ed.ext          AS first_edit_ext,
        (SELECT COALESCE(array_agg(t.name ORDER BY t.name), '{}')
           FROM asset_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.asset_id = a.id) AS tags`;

// FROM + joins. The LATERAL pulls the OTHER (non-deleted) member of the group;
// a group holds exactly two members, so LIMIT 1 is exact. `g` carries the group
// kind so the UI can tell a RAW+JPEG pair from a Live Photo.
export const GRID_FROM = `FROM assets a
        LEFT JOIN ratings r ON r.asset_id = a.id
        LEFT JOIN asset_groups g ON g.id = a.group_id
        LEFT JOIN bursts bu ON bu.id = a.burst_id
        LEFT JOIN LATERAL (
          SELECT c.id, c.ext, c.media_type, c.filename, c.file_size,
                 c.width, c.height
          FROM assets c
          WHERE a.group_id IS NOT NULL
            AND c.group_id = a.group_id
            AND c.id <> a.id
            AND c.deleted_at IS NULL
          LIMIT 1
        ) comp ON true
        LEFT JOIN assets orig
          ON orig.id = a.original_asset_id AND orig.deleted_at IS NULL
        LEFT JOIN LATERAL (
          SELECT e.id, e.filename, e.ext
          FROM assets e
          WHERE e.original_asset_id = a.id AND e.deleted_at IS NULL
          ORDER BY e.id
          LIMIT 1
        ) ed ON true`;
