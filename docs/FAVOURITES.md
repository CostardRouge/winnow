# Favourites — the ♥ beside the cull

*Written 2026-11-06. Steps 1 (the mark everywhere) and 2 (the favourites pass)
are built in the same branch as this brief; step 3 (source ↔ edit, wider
suggestions) is open. The decisions in §3 were taken with the maintainer, not
assumed. Mockups: the "Winnow Favourites Mockups" canvas (five boards).*

---

## 1. The problem

Atelier's Recap (its `src/tools/recap/`, PR CostardRouge/atelier#435) turns a day,
a week, a month or a year of the library into Instagram slides, a carousel or a
Reel. It reads `/api/assets` over the period and ranks each slot's candidates
by **pick, then stars, then edited, then faces, then sharpness**
(`shared/sources/winnow/picture-rules.ts` there). The ranking was in place;
the signal was not.

Measured on the instance, 2026-11-06:

| | Incoming | Gallery |
| --- | --- | --- |
| Media | ~99 600 | 7 719 |
| Picks | 2 088 (76 of 471 folders) | 0 |
| Starred | 129 | 0 |
| Unrated | 93 376 (94 %) | 7 719 (100 %) |

- Folders: median 80 media, 58 over 500, 17 over 1 000.
- **The Gallery cannot be rated at all, by design** (curation off: a final is
  accepted as it is) — so the edited pictures, the ones most worth sharing,
  could never rise in a recap.
- 1 878 Gallery media are edits, **0** linked to their source on the instance
  (`edits.linked` facet): a recap over both zones can show one moment twice.

The verdict is a cull: keep or throw, for every frame. A recap needs ten to
twenty pictures per folder, not a finished cull. Asking for the cull to be
finished first is what kept the signal at 2 %.

## 2. What was considered

- **Stars as the favourite** ("5★ = favourite", stars opened in the Gallery).
  Rejected: it breaks the Gallery's curation-off rule, a star is a grade (a
  choice among five, slower than a yes), and a blurred moment among friends is
  recap-worthy without being worth four stars.
- **A per-account like** (each user their own hearts). Rejected for now by the
  maintainer: ratings are shared, and so is this; `favourited_by` keeps who set
  it if that ever changes.
- **The ♥ implying a pick.** Rejected: the two stay apart. A favourite moves no
  verdict and no folder progress; an unrated favourite stays unrated.

## 3. Decisions (2026-11-06, with the maintainer)

1. **A distinct, binary ♥** — table `favourites` (migration 0058), one row per
   favourited file, `favourited_by` / `favourited_via` like `rated_by` /
   `rated_via`. Its own colour token, `--color-fav` (raspberry): not the
   vermillion of brand and focus, not the red of a reject.
2. **Shared**, not per account.
3. **Beside the cull**: writing one touches no `ratings` row and no
   `processing_state`; nothing that culls clears it.
4. **Allowed in the Gallery**: it judges no final, it says "show this one".
   Every other curation verb stays off there.
5. **A pair or a Live Photo is one favourite** (`groupExpandCTE`); a burst pile
   is not expanded — the frame is the unit, as for a pick. Setting skips a
   trashed member; clearing takes the whole group, trashed or not.
6. A trashed media keeps its row (a restore gives it back); the live library
   never lists it meanwhile.

## 4. Step 1 — the mark everywhere (built)

- `POST /api/favourites { ids, favourite }` (editor; ≤ 5 000 ids, refused above,
  never cut) → `lib/favourites.ts`.
- Every grid row carries `favourite` (`GRID_SELECT`); `favourite=1|0` is a
  filter key (`buildFilter`, a primary-key probe, re-aliased safely by the fold).
- `/api/sessions` and `/api/sessions/:id` carry `favourite_count`, per MEDIA (a
  pair once).
- UI: the tile's ♥ in the bottom-left row beside the stars (hover on desktop,
  shown once set; on a touch screen only a set heart shows — the target is too
  small there); the viewer's ♥ and **F**; **♥ Favourite** on a selection
  (remove: ⋯); a folder's **♥** tab in its Show control; **♥ Favourites only**
  in the filter panel. Writes are optimistic, put back on a refusal, and a bulk
  count is announced only after the server answers.
- `/api/capabilities` → `curation.favourites: true`; the agent bridge v2 has
  `cull.favourite` and `assets.list favourite`.
- **Atelier's half** (its repo, not here): `PREFER_KEYS = ['fav', 'pick',
  'stars', 'edited', 'faces', 'sharp']`, `favourite` read off each row, and a
  "Favourites / Auto / Everything" source when `curation.favourites` is true.

## 5. Step 2 — the favourites pass (built)

`/sessions/:id/favourites`, reached from the folder's **♥ Pass** button: a
phone-first contact sheet of one folder's **moments**, where a tap is a ♥ and
nothing else happens to the rest — no reject, no skip, no verdict.

- **A moment** (`lib/moments.ts`, pure, tested): a burst pile; or a run of
  frames of one media type, each ≤ 10 min after the last and ≤ 8 bits of dHash
  from it — Atelier's own look-alike rule, so a moment here is one duplicate
  there; never longer than 30 min; a frame with no hash joins only through its
  pile. Pairs are folded first (one tile per media), piles are not (the sheet
  lists every frame). On the synthetic check, 47 media → 16 moments.
- **The cover** is the frame already chosen (a ♥, then a pick, then stars),
  else the sharpest, else the first — never a fixed position.
- **A tap**: no ♥ in the moment → the cover gets one; any ♥ → they are all
  cleared. **×N** opens the moment's frames (a sheet on a phone) to put the ♥
  on another frame, or on two.
- **The counter** reads "♥ N · aim 10–20 for a recap" — a guide, never a cap.
- **Suggest** outlines up to 15 moments (minus those already holding a ♥) with
  one printed reason each — Pick, ★n, Faces, Sharp (top quarter of the
  folder), N frames (you shot it several times). A hint drawn on the tile;
  only a tap writes. Rejects are never suggested.
- `GET /api/sessions/:id/moments` reads the whole folder in one statement, up
  to 10 000 media — above that it refuses and says so (the largest folder on
  the instance holds 3 886).

## 6. Step 3 — open

- **Source ↔ edit**: a ♥ on either side of a linked pair (`original_asset_id`)
  should count for both, and a recap should receive the edit, once. Needs the
  1 878 edits linked first (reconcile, `import_links`), then a lineage-aware
  read — not a copied row, so unlinking stays honest.
- **Suggestions** beyond the pass's own (known people, CLIP diversity), and an
  agent proposing favourites as `favourited_via = 'agent'` for a human to keep.
- Immich's own favourite flag, synced from this one, so the phone's browsing
  shows the same hearts.

## 7. What not to do

- Do not turn the ♥ into a verdict, a star level or a colour label, and do not
  let a cull write clear it.
- Do not open stars or verdicts in the Gallery "because favourites are there".
- Do not copy a favourite onto an edit's row to fake step 3: two rows drift.
