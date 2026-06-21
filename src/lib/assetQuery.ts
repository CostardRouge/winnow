// Shared SQL for the cull-grid rows, used by the gallery, the session grid and
// the single-asset detail route. Keeping one projection here stops the three
// routes from drifting apart.
//
// Each row carries the asset, its rating (verdict/star/color), its tags, and —
// for RAW+JPEG pairs (cf. lib/pairing.ts) — its companion's id and extension so
// the viewer can offer the segmented "JPEG | RAW" toggle and the grid can badge
// the pair. `companion_*` is NULL when the asset is not paired.

// SELECT projection (assumes `assets a` + the joins in GRID_FROM are in scope).
export const GRID_SELECT = `a.*,
        COALESCE(r.verdict, 'unrated') AS verdict,
        COALESCE(r.star, 0)            AS star,
        r.color_label,
        comp.id  AS companion_id,
        comp.ext AS companion_ext,
        (SELECT COALESCE(array_agg(t.name ORDER BY t.name), '{}')
           FROM asset_tags at JOIN tags t ON t.id = at.tag_id
          WHERE at.asset_id = a.id) AS tags`;

// FROM + joins. The LATERAL pulls the OTHER (non-deleted) member of the group;
// a group holds exactly two members, so LIMIT 1 is exact.
export const GRID_FROM = `FROM assets a
        LEFT JOIN ratings r ON r.asset_id = a.id
        LEFT JOIN LATERAL (
          SELECT c.id, c.ext
          FROM assets c
          WHERE a.group_id IS NOT NULL
            AND c.group_id = a.group_id
            AND c.id <> a.id
            AND c.deleted_at IS NULL
          LIMIT 1
        ) comp ON true`;
